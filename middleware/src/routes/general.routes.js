import { Router } from 'express'
import { asyncHandler, badRequest, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { db } from '../lib/db.js'
import { aplicarZona, esZonaValida, relojDelServidor, ZONA_POR_DEFECTO } from '../lib/zonaHoraria.js'
import { rearrancar as rearrancarTareas } from '../services/tareas.js'
import { ivaGeneral, TARIFAS_GENERALES } from '../lib/iva.js'

/**
 * La marca del sistema: lo que se ve en pantalla.
 *
 * Es distinto de los datos de la empresa. Aquellos salen impresos en la factura
 * y los valida el SRI; esto es el nombre y el logo que ve el técnico al entrar,
 * y puede ser otra cosa — el nombre comercial, o el que le pusieron adentro.
 *
 * Leer NO exige sesión: el login tiene que mostrar el nombre y el logo, y ahí
 * todavía no hay usuario. No hay nada secreto en esto — es justamente lo que
 * cualquiera ve al abrir el sistema.
 */
const router = Router()

const POR_DEFECTO = {
  nombre_sistema: 'Taller SmartOLT',
  lema: 'Gestión de OLTs y MikroTik',
  logo_b64: null,
  moneda_simbolo: '$',
  moneda_codigo: 'USD',
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const { data, error } = await db().from('config_general').select('*').eq('id', 1).maybeSingle()

    // Que falte la tabla no puede dejar el login en blanco: se cae a los
    // valores por defecto, que es exactamente lo que había antes.
    if (error) {
      console.warn('[general] no se pudo leer la configuración:', error.message)
      return res.json(POR_DEFECTO)
    }

    res.json({
      nombre_sistema: data?.nombre_sistema || POR_DEFECTO.nombre_sistema,
      lema: data?.lema ?? POR_DEFECTO.lema,
      logo_b64: data?.logo_b64 ?? null,
      moneda_simbolo: data?.moneda_simbolo || POR_DEFECTO.moneda_simbolo,
      moneda_codigo: data?.moneda_codigo || POR_DEFECTO.moneda_codigo,
    })
  }),
)

/**
 * Qué hora cree el servidor que es.
 *
 * Es la pregunta que hay que poder contestar sin entrar por SSH: si la
 * facturación salió a las 20:00 en vez de a la 01:00, acá se ve por qué.
 */
router.get(
  '/reloj',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json(relojDelServidor())
  }),
)

/**
 * Cambiar la zona.
 *
 * Va aparte del PUT de la marca a propósito: la pantalla General manda el
 * formulario entero, y si la zona viajara ahí, guardar el logo sin la
 * migración 196 corrida fallaría por una columna que esa pantalla ni muestra.
 */
router.put(
  '/reloj',
  requireAuth,
  asyncHandler(async (req, res) => {
    const zona = String(req.body?.zona_horaria ?? '').trim()

    // Una zona mal escrita no da error en Node: da UTC en silencio, que es
    // justamente lo que se quiere evitar.
    if (!esZonaValida(zona)) {
      throw badRequest(`"${zona}" no es una zona horaria. Elegila de la lista: por ejemplo, ${ZONA_POR_DEFECTO}.`)
    }

    const { error } = await db()
      .from('config_general')
      .update({ zona_horaria: zona, actualizado_en: new Date().toISOString() })
      .eq('id', 1)
    if (error) {
      throw new AppError(`No se pudo guardar: ${error.message}`, {
        status: 502,
        hint: 'Si dice que no existe la columna zona_horaria, falta correr la migración 196.',
      })
    }

    /**
     * Se aplica en el acto y se rearman las tareas.
     *
     * Los temporizadores preguntan "¿ya es la hora?" cada pocos minutos, así
     * que con la zona nueva la próxima pregunta ya se contesta bien. Se rearman
     * igual para que la corrida de recuperación que hace cada tarea al armarse
     * use la hora nueva y no espere a la siguiente vuelta.
     */
    const antes = process.env.TZ
    const ahora = aplicarZona(zona)
    if (ahora !== antes) {
      console.log(`[zona horaria] ${antes} → ${ahora}`)
      await rearrancarTareas().catch((err) =>
        console.error(`[zona horaria] no se pudieron rearmar las tareas: ${err.message}`),
      )
    }

    res.json(relojDelServidor())
  }),
)

/** El IVA general, y las tarifas que se pueden elegir. */
router.get(
  '/iva',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ iva_porcentaje: await ivaGeneral(), tarifas: TARIFAS_GENERALES })
  }),
)

/**
 * Cambiar el IVA general.
 *
 * Arrastra a los planes que tenían el anterior: es lo que hace que cambiar en un
 * lugar cambie todo. Un plan con otro porcentaje —puesto a propósito— no se
 * toca. Las facturas ya hechas tampoco: llevan el impuesto con que se emitieron.
 */
router.put(
  '/iva',
  requireAuth,
  asyncHandler(async (req, res) => {
    const nuevo = Number(req.body?.iva_porcentaje)
    if (!TARIFAS_GENERALES.includes(nuevo)) {
      throw badRequest(`El IVA tiene que ser una de las tarifas del SRI: ${TARIFAS_GENERALES.join(', ')} %.`)
    }

    const anterior = await ivaGeneral()

    const { error } = await db()
      .from('config_general')
      .update({ iva_porcentaje: nuevo, actualizado_en: new Date().toISOString() })
      .eq('id', 1)
    if (error) {
      throw new AppError(`No se pudo guardar: ${error.message}`, {
        status: 502,
        hint: 'Si dice que no existe la columna iva_porcentaje, falta correr la migración 197.',
      })
    }

    let planes = 0
    if (anterior !== nuevo) {
      const { data, error: errPlanes } = await db()
        .from('planes_velocidad')
        .update({ iva_porcentaje: nuevo })
        .eq('iva_porcentaje', anterior)
        .select('id')
      if (errPlanes) {
        throw new AppError(
          `El IVA general quedó en ${nuevo} %, pero no se pudieron actualizar los planes: ${errPlanes.message}`,
          { status: 502 },
        )
      }
      planes = data?.length ?? 0
    }

    res.json({ iva_porcentaje: nuevo, anterior, planes_actualizados: planes, tarifas: TARIFAS_GENERALES })
  }),
)

const CAMPOS = ['nombre_sistema', 'lema', 'logo_b64', 'moneda_simbolo', 'moneda_codigo']

router.put(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const fila = {}
    for (const campo of CAMPOS) {
      if (campo in req.body) fila[campo] = req.body[campo] === '' ? null : req.body[campo]
    }

    // Sin símbolo, cada monto del sistema saldría pelado y nadie sabría si son
    // dólares o soles. Vacío se lee como "no lo cambies".
    if ('moneda_simbolo' in fila && !fila.moneda_simbolo) delete fila.moneda_simbolo
    if (fila.moneda_simbolo && String(fila.moneda_simbolo).length > 5) {
      throw badRequest('El símbolo de la moneda no puede tener más de 5 caracteres.')
    }

    // Un logo grande viaja en cada carga del login, y el login lo abre gente
    // desde el celular en la calle.
    if (fila.logo_b64 && fila.logo_b64.length > 550_000) {
      throw badRequest('El logo pesa demasiado. Usá una versión más chica: con 400×200 alcanza.')
    }

    if (Object.keys(fila).length) {
      fila.actualizado_en = new Date().toISOString()
      const { error } = await db().from('config_general').update(fila).eq('id', 1)
      if (error) {
        throw new AppError(`No se pudo guardar: ${error.message}`, {
          status: 502,
          hint: 'Si dice que no existe la tabla, falta correr la migración 63.',
        })
      }
    }

    const { data } = await db().from('config_general').select('*').eq('id', 1).maybeSingle()
    res.json({ ...POR_DEFECTO, ...(data ?? {}) })
  }),
)

export default router
