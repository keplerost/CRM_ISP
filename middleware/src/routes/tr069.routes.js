import { Router } from 'express'
import { asyncHandler, badRequest } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { porMetodo } from '../lib/permisos.js'
import { cargarOlt, db } from '../lib/db.js'
import * as olts from '../services/oltService.js'
import { alcanzable } from '../services/tr069Global.js'
import { estado as estadoAcs } from '../drivers/genieacs.js'

/**
 * TR-069 de TODAS las OLTs, no de una.
 *
 * ── Por qué esto vive afuera de la ficha de cada equipo ──
 *
 * Un ACS sirve a todo el padrón, no a una OLT. Definir el mismo perfil equipo
 * por equipo es cómo se llega a que la OLT de La Maná apunte a una dirección y
 * la del Progreso a otra que quedó vieja, sin que nadie lo note hasta que media
 * zona deja de verse en el ACS.
 *
 * Acá el perfil se define una vez —nombre y URL— y se aplica a las OLTs que uno
 * elija. Sigue viviendo DENTRO de cada equipo: esto no guarda una copia, las
 * junta al leerlas. El número de perfil puede ser distinto en cada OLT y no
 * importa; lo que las identifica como "el mismo perfil" es a qué ACS apuntan.
 */
const router = Router()

router.use(
  requireAuth,
  porMetodo({
    lectura: ['red.olts_ver'],
    escritura: ['red.olts_gestionar'],
  }),
)

/** Las OLTs activas, con lo mínimo para mostrarlas. */
async function oltsActivas() {
  const { data, error } = await db()
    .from('olts')
    .select('id, nombre, marca, ip_host, activo')
    .eq('activo', true)
    .order('numero')
  if (error) throw error
  return data ?? []
}

/**
 * Le pregunta a cada OLT y junta las respuestas.
 *
 * En paralelo a propósito: cada consulta es una sesión SSH de medio minuto y en
 * serie tres equipos serían minuto y medio de pantalla en blanco.
 *
 * Una OLT que falla —apagada, sin ruta, de una marca que todavía no se relevó—
 * NO tumba la respuesta: se devuelve su error junto a las que sí contestaron.
 * Que un equipo caído esconda el estado de los otros dos es exactamente lo que
 * no puede pasar en una pantalla de supervisión.
 */
async function preguntarATodas(fn) {
  const equipos = await oltsActivas()

  return Promise.all(
    equipos.map(async (fila) => {
      try {
        const olt = await cargarOlt(fila.id)
        return { olt: fila, datos: await fn(olt), error: null }
      } catch (err) {
        return { olt: fila, datos: null, error: err.message }
      }
    }),
  )
}

/**
 * Los perfiles de todo el padrón, agrupados por el ACS al que apuntan.
 *
 * La URL es la identidad. Dos perfiles llamados igual que apuntan a lugares
 * distintos son dos perfiles distintos, y mostrarlos como uno solo escondería
 * justamente el problema que esta pantalla tiene que hacer visible.
 */
router.get(
  '/perfiles',
  asyncHandler(async (_req, res) => {
    const respuestas = await preguntarATodas((olt) => olts.listarPerfilesTr069(olt))

    const porUrl = new Map()
    for (const r of respuestas) {
      for (const p of r.datos ?? []) {
        if (!porUrl.has(p.url)) {
          porUrl.set(p.url, {
            url: p.url,
            nombre: p.nombre,
            usuario: p.usuario,
            conClave: p.conClave,
            enOlts: [],
            ontsTotal: 0,
          })
        }
        const g = porUrl.get(p.url)
        g.enOlts.push({
          oltId: r.olt.id,
          olt: r.olt.nombre,
          profileId: p.id,
          nombre: p.nombre,
          onts: p.onts,
        })
        g.ontsTotal += p.onts
        // Si el mismo ACS quedó con nombres distintos en cada equipo, se avisa:
        // es un desprolijo que confunde a quien mire la OLT por consola.
        if (g.nombre !== p.nombre) g.nombresDistintos = true
      }
    }

    // El alcance del ACS se prueba una vez por URL, no una por OLT: es la misma
    // dirección y probarla tres veces solo hace la pantalla más lenta.
    const perfiles = await Promise.all(
      [...porUrl.values()].map(async (g) => ({ ...g, acs: await alcanzable(g.url) })),
    )

    res.json({
      perfiles,
      olts: respuestas.map((r) => ({ ...r.olt, error: r.error })),
      // El ACS propio del sistema, para poder comparar contra lo que está
      // escrito en los equipos.
      nuestroAcs: await estadoAcs(),
    })
  }),
)

/**
 * Crea un perfil en varias OLTs de una sola vez.
 *
 * Cada equipo puede aceptar o rechazar por su cuenta —el número de perfil puede
 * estar ocupado en uno y libre en otro— así que se devuelve el resultado equipo
 * por equipo en vez de un "listo" que taparía la mitad.
 */
router.post(
  '/perfiles',
  asyncHandler(async (req, res) => {
    const { nombre, url, usuario, clave, olts: pedidas } = req.body ?? {}
    if (!Array.isArray(pedidas) || pedidas.length === 0) {
      throw badRequest('Elegí al menos una OLT donde crear el perfil')
    }

    const resultados = await Promise.all(
      pedidas.map(async ({ oltId, profileId }) => {
        try {
          const olt = await cargarOlt(oltId)
          const creado = await olts.crearPerfilTr069(olt, {
            profileId,
            nombre,
            url,
            usuario,
            clave,
          })
          return { oltId, olt: olt.nombre, ok: true, perfil: creado }
        } catch (err) {
          return { oltId, ok: false, error: err.message }
        }
      }),
    )

    const fallaron = resultados.filter((r) => !r.ok).length
    res.status(fallaron === resultados.length ? 502 : 201).json({ resultados, fallaron })
  }),
)

/** El estado del TR-069 en cada OLT: perfiles, ONT apuntadas, ONT con IP. */
router.get(
  '/estado',
  asyncHandler(async (_req, res) => {
    const respuestas = await preguntarATodas((olt) => olts.resumenTr069(olt))
    res.json({
      olts: respuestas.map((r) => ({ ...r.olt, ...(r.datos ?? {}), error: r.error })),
      nuestroAcs: await estadoAcs(),
    })
  }),
)

/** El estado TR-069 de una ONT puntual, en la OLT que se indique. */
router.get(
  '/ont',
  asyncHandler(async (req, res) => {
    const { oltId, frame = 0, slot, puerto, onuId } = req.query
    if (!oltId) throw badRequest('Falta la OLT')
    if (slot == null || puerto == null || onuId == null) {
      throw badRequest('Hacen falta el slot, el puerto y el ONT-ID')
    }
    const olt = await cargarOlt(oltId)
    res.json(
      await olts.leerTr069DeOnt(olt, {
        frame: Number(frame),
        slot: Number(slot),
        puerto: Number(puerto),
        ontId: Number(onuId),
      }),
    )
  }),
)

/** Apunta una ONT a otro perfil. Devuelve de dónde venía, para poder volver. */
router.post(
  '/ont',
  asyncHandler(async (req, res) => {
    const { oltId, frame = 0, slot, puerto, onuId, profileId } = req.body ?? {}
    if (!oltId) throw badRequest('Falta la OLT')
    if (slot == null || puerto == null || onuId == null) {
      throw badRequest('Hacen falta el slot, el puerto y el ONT-ID')
    }
    const olt = await cargarOlt(oltId)
    res.json(
      await olts.asignarPerfilTr069(olt, {
        frame: Number(frame),
        slot: Number(slot),
        puerto: Number(puerto),
        ontId: Number(onuId),
        profileId,
      }),
    )
  }),
)

export default router
