import { config } from '../config.js'

/**
 * Umbral de alerta de señal óptica del taller.
 *
 * Por debajo de esto el enlace empieza a perder paquetes. Vive acá —y no en una
 * ruta— porque lo usan las rutas, las tareas programadas y las vistas: una
 * constante duplicada es una constante que un día se cambia en un solo lado.
 */
export const UMBRAL_RX_DBM = -27

/**
 * Cuándo vale la pena guardar una lectura óptica en el historial.
 *
 * Guardar todas es inviable: mil ONTs leídas cada quince minutos son casi cien
 * mil filas por día, y en un mes ningún gráfico se puede dibujar ni consultar.
 * Pero guardar poco pierde justamente lo que se quiere ver.
 *
 * La regla que resuelve las dos cosas: se guarda cuando el valor SE MOVIÓ, o
 * cuando pasó demasiado tiempo sin registrar nada.
 *
 * Una ONT estable genera una fila cada varias horas —suficiente para probar que
 * estuvo estable— y una que se está degradando genera una fila cada vez que
 * baja, que es exactamente el detalle que hace falta para ver la pendiente.
 *
 * Es la misma idea que ya se usa en el monitoreo de nodos: guardar los cambios,
 * no las muestras.
 */

/**
 * @param anterior  última lectura registrada (dBm), o null si no hay ninguna
 * @param nueva     lectura actual (dBm)
 * @param registradaAt  cuándo se guardó la última fila, o null
 */
export function correspondeRegistrar(anterior, nueva, registradaAt, ahora = Date.now()) {
  // Sin lectura nueva no hay nada que guardar. Y NO se guarda un hueco: "la ONT
  // no reportó" es un dato de estado, no una medición de potencia, y metido en
  // la serie rompería cualquier promedio o pendiente.
  if (nueva == null || !Number.isFinite(Number(nueva))) return false

  // Primera vez: siempre se guarda, así la serie tiene su punto de partida.
  if (anterior == null || registradaAt == null) return true

  const salto = Math.abs(Number(nueva) - Number(anterior))
  if (salto >= config.optica.saltoDb) return true

  const desde = ahora - new Date(registradaAt).getTime()
  return desde >= config.optica.cadaMs
}

/**
 * Filas a insertar en el historial, a partir de una lectura masiva.
 *
 * Separado del acceso a la base para poder probarlo: acá se decide cuánto va a
 * crecer una tabla que en un año tiene millones de filas.
 */
export function filasAGuardar(lecturas, enBase, ahora = Date.now()) {
  const previo = new Map(
    (enBase ?? []).map((u) => [
      `${u.slot}/${u.puerto}/${u.onu_index}`,
      { id: u.id, rx: u.rx_power_dbm, at: u.optica_registrada_at },
    ]),
  )

  const filas = []
  for (const o of lecturas ?? []) {
    const p = previo.get(`${o.slot}/${o.puerto}/${o.ontId}`)
    if (!p) continue
    if (!correspondeRegistrar(p.rx, o.rx_dbm, p.at, ahora)) continue

    filas.push({
      onu_id: p.id,
      rx_dbm: o.rx_dbm,
      tx_dbm: o.tx_dbm ?? null,
      temperatura_c: o.temperatura_c ?? null,
    })
  }
  return filas
}
