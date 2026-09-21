import { db } from '../lib/db.js'
import { badRequest } from '../lib/errors.js'
import * as olts from './oltService.js'

/**
 * Velocidad en vivo de una ONU.
 *
 * El equipo no informa velocidad: informa BYTES ACUMULADOS desde que se creó el
 * service-port. Un número de esos no dice nada por sí solo — la velocidad sale
 * de restar dos lecturas y dividir por el tiempo que pasó entre ellas.
 *
 * Por eso la primera consulta nunca puede devolver Mbps, y lo dice en vez de
 * contestar cero: un gráfico que arranca en cero se lee como "el abonado no
 * está usando nada", que es exactamente lo contrario de "todavía no lo sé".
 */

/**
 * La lectura anterior de cada service-port, para poder restar.
 *
 * Vive en memoria y no en la base a propósito: son datos de los últimos
 * segundos, solo sirven mientras alguien está mirando la pantalla, y
 * escribirlos sería una fila por ONU cada cinco segundos para siempre.
 */
const anteriores = new Map()

/** Más viejo que esto, no sirve para restar: se descarta y se empieza de nuevo. */
const MAX_ANTIGUEDAD_MS = 120_000

/** Cuánto se recuerda qué service-ports tiene una ONU antes de volver a mirar. */
const VIGENCIA_SERVICE_PORTS_MS = 300_000

const cacheServicePorts = new Map()

/**
 * Los service-ports de servicio de una ONU, recordados un rato.
 *
 * Se descarta el de gestión (VLAN 999): mueve unos pocos bytes de telemetría y
 * sumarlo ensuciaría la medición de lo que realmente consume el abonado.
 */
async function servicePortsDe(olt, onu) {
  const clave = `${olt.id}:${onu.id}`
  const guardado = cacheServicePorts.get(clave)
  if (guardado && Date.now() - guardado.at < VIGENCIA_SERVICE_PORTS_MS) return guardado.puertos

  const config = await olts.leerConfigCompletaOnt(olt, {
    frame: onu.frame ?? 0,
    slot: onu.slot,
    puerto: onu.puerto,
    ontId: onu.onu_index,
  })

  const puertos = (config.servicePorts ?? [])
    .filter((s) => s.vlan !== 999)
    .map((s) => ({ indice: s.indice, vlan: s.vlan }))

  cacheServicePorts.set(clave, { at: Date.now(), puertos })
  return puertos
}

/**
 * Un salto hacia atrás en un contador acumulado no es tráfico negativo: es que
 * el contador se reinició —la ONT se reinició, el service-port se rehízo— o que
 * dio la vuelta. En los dos casos la resta no significa nada.
 */
const delta = (ahora, antes) => (ahora == null || antes == null || ahora < antes ? null : ahora - antes)

export async function traficoOnu(olt, onuId) {
  const { data: onu } = await db()
    .from('onus')
    .select('id, sn, olt_id, frame, slot, puerto, onu_index, vlan')
    .eq('id', onuId)
    .eq('olt_id', olt.id)
    .maybeSingle()

  if (!onu) throw badRequest('Esa ONU no existe en esta OLT')

  // Qué service-ports tiene esta ONU. Se averigua UNA vez y se recuerda un
  // rato: la consulta que lo dice devuelve diez mil caracteres y tarda varios
  // segundos, y repetirla en cada muestra hacía que el gráfico "cada 5
  // segundos" midiera intervalos de veintitrés.
  //
  // El olvido a los cinco minutos es lo que cubre el caso de que a la ONU le
  // cambien el plan o la rehagan mientras alguien mira: los índices cambian, y
  // medir contra el viejo devolvería el tráfico de otro abonado.
  const servicio = await servicePortsDe(olt, onu)
  if (!servicio.length) {
    throw badRequest('La ONU no tiene un service-port de servicio', {
      hint: 'Solo tiene el de gestión, o ninguno: no hay tráfico de abonado que medir.',
    })
  }

  const at = Date.now()
  const muestras = []

  for (const sp of servicio) {
    const c = await olts.leerEstadisticasServicePort(olt, { indice: sp.indice })
    const clave = `${olt.id}:${sp.indice}`
    const previo = anteriores.get(clave)
    anteriores.set(clave, { at, subida: c.subida_bytes, bajada: c.bajada_bytes })

    const transcurridoMs = previo ? at - previo.at : null
    const utilizable = previo && transcurridoMs > 0 && transcurridoMs < MAX_ANTIGUEDAD_MS

    const bytesSubida = utilizable ? delta(c.subida_bytes, previo.subida) : null
    const bytesBajada = utilizable ? delta(c.bajada_bytes, previo.bajada) : null
    const aMbps = (bytes) =>
      bytes == null ? null : Math.round(((bytes * 8) / (transcurridoMs / 1000) / 1e6) * 1000) / 1000

    muestras.push({
      indice: sp.indice,
      vlan: sp.vlan,
      subida_mbps: aMbps(bytesSubida),
      bajada_mbps: aMbps(bytesBajada),
      subida_bytes: c.subida_bytes,
      bajada_bytes: c.bajada_bytes,
      subida_descartados: c.subida_descartados,
      bajada_descartados: c.bajada_descartados,
      intervalo_ms: utilizable ? transcurridoMs : null,
    })
  }

  const sumar = (campo) => {
    const valores = muestras.map((m) => m[campo]).filter((v) => v != null)
    return valores.length ? Math.round(valores.reduce((a, b) => a + b, 0) * 1000) / 1000 : null
  }

  const subida = sumar('subida_mbps')

  return {
    sn: onu.sn,
    at: new Date(at).toISOString(),
    subida_mbps: subida,
    bajada_mbps: sumar('bajada_mbps'),
    // La primera lectura no tiene con qué restar. Se dice, en vez de mandar un
    // cero que el gráfico dibujaría como "no está consumiendo nada".
    primera_lectura: subida === null,
    service_ports: muestras,
  }
}

/** Se olvida lo medido de una OLT. Para cuando se cierra la pantalla. */
export function olvidarTrafico(oltId) {
  for (const mapa of [anteriores, cacheServicePorts]) {
    for (const k of mapa.keys()) {
      if (k.startsWith(`${oltId}:`)) mapa.delete(k)
    }
  }
}
