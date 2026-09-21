import { db, cargarOlt } from '../lib/db.js'
import { filasAGuardar, UMBRAL_RX_DBM } from '../lib/optica.js'
import * as ficha from './oltFicha.js'

/**
 * Lectura óptica periódica.
 *
 * Es lo que convierte el historial en algo útil: sin una lectura automática,
 * la serie depende de que alguien se acuerde de apretar el botón — y justo los
 * días complicados nadie se acuerda.
 *
 * Solo lee la potencia RX. Leer todo son cinco recorridos en vez de uno, y a
 * este ritmo eso multiplica por cinco la carga sobre los equipos para guardar
 * datos que casi nunca se miran. La lectura completa sigue disponible a pedido
 * desde la pantalla.
 */

const estado = {
  automatico: false,
  cada_minutos: null,
  corriendo: false,
  ultimaCorrida: null,
  ultimoResultado: null,
}

export const estadoOptica = () => ({ ...estado })

/**
 * Lee una OLT y guarda: valor actual en la ficha de cada ONU, y una fila de
 * historial solo cuando corresponde.
 *
 * Vive acá y no en la ruta porque lo usan los dos —el botón de la pantalla y la
 * tarea automática— y tenerlo duplicado sería garantizar que un día diverjan.
 */
export async function leerYGuardar(olt, { completo = false } = {}) {
  const lectura = await ficha.leerPotencias(olt, { completo })

  const { data: enBase } = await db()
    .from('onus')
    .select('id, slot, puerto, onu_index, rx_power_dbm, optica_registrada_at')
    .eq('olt_id', olt.id)

  const indice = new Map((enBase ?? []).map((u) => [`${u.slot}/${u.puerto}/${u.onu_index}`, u.id]))
  const ahora = new Date().toISOString()

  // El historial se decide ANTES de pisar el valor actual: la regla compara la
  // lectura nueva contra la anterior, y una vez actualizada la fila esa
  // comparación ya no se puede hacer.
  const historial = filasAGuardar(lectura.onts, enBase)
  let registradas = 0

  if (historial.length) {
    const { error } = await db().from('onu_optica_historial').insert(historial)
    if (!error) {
      await db()
        .from('onus')
        .update({ optica_registrada_at: ahora })
        .in(
          'id',
          historial.map((h) => h.onu_id),
        )
      registradas = historial.length
    }
  }

  let guardadas = 0
  let sinRegistrar = 0

  for (const o of lectura.onts) {
    const id = indice.get(`${o.slot}/${o.puerto}/${o.ontId}`)
    if (!id) {
      sinRegistrar++
      continue
    }
    // Solo se escribe lo que se midió. Una ONT sin lectura no debe borrar la
    // última que sí se tuvo: "ahora no reporta" y "está en cero" son cosas
    // distintas, y la segunda dispararía alertas falsas.
    if (o.rx_dbm == null) continue

    const cambios = { rx_power_dbm: o.rx_dbm, estado: 'online', ultima_lectura: ahora }
    if (o.tx_dbm != null) cambios.tx_power_dbm = o.tx_dbm
    if (o.distancia_m != null) cambios.distancia_m = o.distancia_m

    await db().from('onus').update(cambios).eq('id', id)
    guardadas++
  }

  const conAlerta = lectura.onts.filter((o) => o.rx_dbm != null && o.rx_dbm < UMBRAL_RX_DBM)

  return {
    ...lectura,
    umbral_dbm: UMBRAL_RX_DBM,
    con_alerta: conAlerta.length,
    alertas: conAlerta.map((o) => ({
      slot: o.slot,
      puerto: o.puerto,
      ont: o.ontId,
      rx_dbm: o.rx_dbm,
    })),
    guardadas,
    sin_registrar_en_base: sinRegistrar,
    historial: registradas,
  }
}

/**
 * Una pasada por todas las OLTs que se puedan leer.
 *
 * Las que no tengan comunidad SNMP cargada se saltean sin ruido: no es un
 * error, es que todavía no se configuraron. Las que fallen se anotan aparte —
 * un equipo inalcanzable no puede impedir que se lean los demás.
 */
export async function leerTodas() {
  if (estado.corriendo) return { salteada: true, motivo: 'ya hay una lectura en curso' }
  estado.corriendo = true

  try {
    const { data, error } = await db()
      .from('olts')
      .select('id, nombre, snmp_ro_encrypted, activo')
      .order('numero')

    if (error) throw new Error(`No se pudieron leer las OLTs: ${error.message}`)

    const leidas = []
    const fallidas = []
    const sinSnmp = []

    for (const fila of (data ?? []).filter((o) => o.activo !== false)) {
      if (!fila.snmp_ro_encrypted) {
        sinSnmp.push(fila.nombre)
        continue
      }
      try {
        const olt = await cargarOlt(fila.id)
        const r = await leerYGuardar(olt)
        leidas.push({
          olt: fila.nombre,
          onts: r.onts.length,
          con_lectura: r.con_lectura,
          historial: r.historial,
          con_alerta: r.con_alerta,
          ms: r.ms,
        })
      } catch (err) {
        fallidas.push({ olt: fila.nombre, error: err.message })
      }
    }

    const resumen = {
      leidas,
      fallidas,
      sin_snmp: sinSnmp,
      filas_historial: leidas.reduce((a, l) => a + l.historial, 0),
      corrida: new Date().toISOString(),
    }

    estado.ultimaCorrida = resumen.corrida
    estado.ultimoResultado = resumen
    return resumen
  } finally {
    estado.corriendo = false
  }
}

/**
 * Deja la lectura corriendo cada N minutos.
 *
 * No lee al arrancar, por la misma razón que el watchdog de nodos: si el
 * middleware se reinicia varias veces seguidas —un deploy, un crash— cada
 * arranque dispararía una pasada completa contra todos los equipos.
 */
export function programarOptica({ cada_minutos = 15 } = {}) {
  estado.automatico = true
  estado.cada_minutos = cada_minutos

  const tarea = setInterval(
    async () => {
      try {
        const r = await leerTodas()
        if (r.salteada) return
        if (r.filas_historial) {
          console.log(
            `[optica] ${r.filas_historial} lecturas al historial · ${r.leidas.map((l) => `${l.olt}: ${l.con_lectura}/${l.onts}`).join(' · ')}`,
          )
        }
        for (const f of r.fallidas) console.error(`[optica] ${f.olt}: ${f.error}`)
      } catch (err) {
        console.error('[optica] falló la lectura:', err.message)
      }
    },
    cada_minutos * 60_000,
  )

  tarea.unref?.()
  return tarea
}
