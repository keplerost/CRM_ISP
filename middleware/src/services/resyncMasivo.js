import { db, cargarOlt } from '../lib/db.js'
import { badRequest } from '../lib/errors.js'
import * as olts from './oltService.js'
import { parsearDescripcion } from '../drivers/huaweiSnmp.js'

/**
 * Releer del equipo la ficha de todas las ONUs de una OLT.
 *
 * Recupera lo que el sistema anterior escribió en la descripción de cada ONT y
 * nunca se guardó de este lado: la dirección del abonado, su zona, el modelo,
 * la VLAN y los perfiles. Son datos que ya existen en el equipo desde hace
 * años; lo único que falta es traerlos.
 *
 * Tres decisiones sobre cómo corre:
 *
 * 1. DE A UNA. Estos equipos tienen pocas sesiones SSH y las comparten con
 *    cualquier otro que esté trabajando. Paralelizar terminaría con la OLT
 *    rechazando conexiones a quien esté haciendo un alta.
 *
 * 2. EN SEGUNDO PLANO. Noventa ONUs son cerca de quince minutos. Ninguna
 *    pantalla puede esperar eso, así que se arranca y se pregunta cómo va.
 *
 * 3. SOLO LEE. No se le manda un solo comando de escritura a ninguna ONT. Lo
 *    único que cambia es nuestra copia.
 */

const estado = {
  corriendo: false,
  olt: null,
  total: 0,
  hechas: 0,
  cambiadas: 0,
  sinCambios: 0,
  fallidas: [],
  arranque: null,
  fin: null,
  cancelar: false,
  ultimaSn: null,
}

export const estadoResync = () => ({
  ...estado,
  // Cuánto falta, estimado con lo que tardó hasta ahora. Es la única pregunta
  // que se hace quien lo largó y se fue a hacer otra cosa.
  restantes: Math.max(0, estado.total - estado.hechas),
  ms_por_onu:
    estado.hechas > 0 && estado.arranque
      ? Math.round((Date.now() - new Date(estado.arranque).getTime()) / estado.hechas)
      : null,
  eta_ms:
    estado.hechas > 0 && estado.arranque && estado.corriendo
      ? Math.round(
          ((Date.now() - new Date(estado.arranque).getTime()) / estado.hechas) *
            (estado.total - estado.hechas),
        )
      : null,
})

/** Pide que se detenga. Termina la ONU que esté leyendo y para ahí. */
export function detenerResync() {
  if (!estado.corriendo) return { corriendo: false, motivo: 'no hay ninguno en curso' }
  estado.cancelar = true
  return { ok: true, mensaje: 'Se detiene al terminar la ONU que está leyendo.' }
}

/**
 * Arranca el barrido y devuelve enseguida.
 *
 * Lo que ya tiene ficha leída se saltea salvo que se pida `todas`: en un
 * segundo intento después de un corte, no tiene sentido volver a leer las
 * setenta que ya salieron bien.
 */
export async function arrancarResync(oltId, { todas = false } = {}) {
  if (estado.corriendo) {
    throw badRequest('Ya hay un barrido en curso', {
      hint: `Va por ${estado.hechas} de ${estado.total}. Esperá a que termine o detenelo.`,
    })
  }

  const olt = await cargarOlt(oltId)

  let q = db()
    .from('onus')
    .select('id, sn, slot, puerto, onu_index, nombre_cliente, zona, direccion, vlan, descripcion_olt, autorizada_at')
    .eq('olt_id', oltId)
  if (!todas) q = q.is('ficha_leida_at', null)
  const { data: onus } = await q.order('puerto').order('onu_index')

  if (!onus?.length) {
    return {
      arrancado: false,
      motivo: todas
        ? 'Esta OLT no tiene ONUs cargadas.'
        : 'Todas las ONUs ya tienen su ficha leída. Repetí con todas = true para releerlas igual.',
    }
  }

  Object.assign(estado, {
    corriendo: true,
    olt: { id: olt.id, nombre: olt.nombre },
    total: onus.length,
    hechas: 0,
    cambiadas: 0,
    sinCambios: 0,
    fallidas: [],
    arranque: new Date().toISOString(),
    fin: null,
    cancelar: false,
    ultimaSn: null,
  })

  // Se lanza sin await: la respuesta sale ya y el trabajo sigue de fondo.
  correr(olt, onus).catch((err) => {
    console.error('[resync] el barrido murió:', err.message)
    estado.corriendo = false
    estado.fin = new Date().toISOString()
  })

  return {
    arrancado: true,
    olt: olt.nombre,
    total: onus.length,
    mensaje: `Leyendo ${onus.length} ONUs, de a una. Solo lectura: no se le escribe nada a ninguna ONT.`,
  }
}

/**
 * El barrido, PUERTO POR PUERTO y no ONU por ONU.
 *
 * `display ont info <puerto> all` trae las descripciones de las veintitrés ONTs
 * de un puerto en un solo comando, y `display service-port port ...` sus VLANs.
 * Preguntando de a una hacían falta cuatro comandos por abonado: cuarenta y
 * cuatro minutos contra poco más de uno, y otras tantas sesiones SSH que la OLT
 * le saca a quien esté trabajando.
 *
 * Lo que no se puede leer así es el MODELO, que sale de una consulta OMCI a cada
 * ONT. Se deja para después y solo para las que no lo tengan.
 */
async function correr(olt, onus) {
  const porPuerto = new Map()
  for (const o of onus) {
    const clave = `${o.slot}/${o.puerto}`
    if (!porPuerto.has(clave)) porPuerto.set(clave, { slot: o.slot, puerto: o.puerto, onus: [] })
    porPuerto.get(clave).onus.push(o)
  }

  for (const grupo of porPuerto.values()) {
    if (estado.cancelar) break
    estado.ultimaSn = `puerto ${grupo.slot}/${grupo.puerto}`

    let leido = null
    try {
      leido = await olts.leerPuertoCompleto(olt, { slot: grupo.slot, puerto: grupo.puerto })
    } catch (err) {
      // Se pierde el puerto entero, y se dice cuáles quedaron sin leer en vez de
      // contarlas como hechas.
      for (const o of grupo.onus) {
        estado.fallidas.push({ sn: o.sn, puerto: o.puerto, error: err.message })
        estado.hechas++
      }
      continue
    }

    const porOntId = new Map((leido.onts ?? []).map((x) => [x.ontId, x]))

    for (const onu of grupo.onus) {
      if (estado.cancelar) break
      const enEquipo = porOntId.get(onu.onu_index)

      if (!enEquipo) {
        // Está en nuestra base y el equipo no la tiene en ese lugar. No se
        // inventa nada: se informa para que alguien lo mire.
        estado.fallidas.push({
          sn: onu.sn,
          puerto: onu.puerto,
          error: `el equipo no tiene ninguna ONT ${onu.puerto}/${onu.onu_index}`,
        })
        estado.hechas++
        continue
      }

      try {
        const cambios = await guardarDelPuerto(onu, enEquipo)
        if (cambios) estado.cambiadas++
        else estado.sinCambios++
      } catch (err) {
        estado.fallidas.push({ sn: onu.sn, puerto: onu.puerto, error: err.message })
      }
      estado.hechas++
    }
  }

  // --- Segunda pasada: el modelo ---------------------------------------------
  //
  // No sale de `display ont info <puerto> all` —esa tabla trae serie, estado y
  // descripción y nada más— así que hay que preguntar ONT por ONT. Va al final
  // y SOLO para las que no lo tengan: es lo caro del barrido y casi nunca hay
  // que repetirlo, porque el modelo de un equipo no cambia.
  if (!estado.cancelar) {
    await leerModelosFaltantes(olt, onus)
  }

  estado.corriendo = false
  estado.fin = new Date().toISOString()
  estado.ultimaSn = null

  const cancelado = estado.cancelar
  estado.cancelar = false
  console.log(
    `[resync] ${cancelado ? 'detenido' : 'terminado'}: ${estado.hechas}/${estado.total} · ` +
      `${estado.cambiadas} con datos nuevos · ${estado.fallidas.length} fallaron`,
  )
}

/**
 * Le pregunta el modelo a las ONTs que todavía no lo tienen.
 *
 * El modelo es lo que enlaza cada abonado con su tipo de ONU, y con eso con la
 * foto del equipo y sus características. Sin él, la ficha del abonado no puede
 * decir de qué aparato se trata.
 *
 * Se leen solo las que faltan: preguntarle a las noventa cada vez sería pagar
 * un minuto y medio por un dato que no cambia.
 */
async function leerModelosFaltantes(olt, onus) {
  const { data: sinModelo } = await db()
    .from('onus')
    .select('id, sn, slot, puerto, onu_index')
    .eq('olt_id', olt.id)
    .is('modelo', null)
    .in('id', onus.map((o) => o.id))

  if (!sinModelo?.length) return

  estado.modelos = { total: sinModelo.length, hechos: 0, encontrados: 0 }
  estado.ultimaSn = `modelos: 0 de ${sinModelo.length}`

  let leidos = []
  try {
    leidos = await olts.leerModelosDeOnts(olt, {
      onts: sinModelo.map((o) => ({
        slot: o.slot,
        puerto: o.puerto,
        ontId: o.onu_index,
        onu_id: o.id,
        sn: o.sn,
      })),
      alAvanzar: (n) => {
        estado.modelos.hechos = n
        estado.ultimaSn = `modelos: ${n} de ${sinModelo.length}`
      },
    })
  } catch (err) {
    // Que falle la segunda pasada no invalida la primera: las descripciones y
    // las VLANs ya quedaron guardadas.
    estado.avisoModelos = `No se pudieron leer los modelos: ${err.message}`
    return
  }

  for (const l of leidos.filter((x) => x.modelo)) {
    const { error } = await db().from('onus').update({ modelo: l.modelo }).eq('id', l.onu_id)
    if (!error) estado.modelos.encontrados++
  }

  // Las que no contestaron son casi siempre las apagadas. Se dice cuántas para
  // que quede claro que no es que "no tengan modelo".
  estado.modelos.sin_respuesta = leidos.filter((x) => !x.modelo).length
}

/**
 * Guarda lo que dijo el equipo de UNA ONT, sin pisar lo que no contestó.
 *
 * La descripción se desarma en nombre, zona, dirección y fecha de alta, que es
 * donde el sistema anterior guardó todo eso. Es el dato que hace falta para
 * poder agrupar abonados por caja.
 */
async function guardarDelPuerto(onu, enEquipo) {
  const d = parsearDescripcion(enEquipo.descripcion ?? '')

  // El de gestión (VLAN 999) es igual para todos y no dice nada del abonado.
  const servicio = (enEquipo.servicePorts ?? []).find((s) => s.vlan !== 999)

  const cambios = { ficha_leida_at: new Date().toISOString() }
  const anotar = (campo, valor) => {
    if (valor != null && valor !== '' && String(onu[campo] ?? '') !== String(valor)) {
      cambios[campo] = valor
    }
  }

  anotar('descripcion_olt', enEquipo.descripcion)
  anotar('zona', d.zona)
  anotar('direccion', d.direccion)
  anotar('autorizada_at', d.alta)
  anotar('vlan', servicio?.vlan)
  if (!onu.nombre_cliente) anotar('nombre_cliente', d.nombre)

  const { error } = await db().from('onus').update(cambios).eq('id', onu.id)
  if (error) throw new Error(error.message)

  return Object.keys(cambios).length > 1
}
