/**
 * Cuánto le falta a un vehículo para su próximo servicio.
 *
 * ── Por qué vive acá y no en el componente ──
 *
 * Porque es la regla del negocio, y decide si alguien lleva una camioneta al
 * taller. Adentro de un .jsx solo se puede probar montando React; acá se prueba
 * con el runner de node, igual que `abonados.js` — que es el mismo motivo por
 * el que ese archivo tampoco importa nada.
 *
 * ── Los dos criterios ──
 *
 * El aceite va por kilómetros, la matrícula por fecha, y algunos por los dos.
 * Con los dos, vence el que llegue primero: el aceite se degrada con el tiempo
 * aunque el vehículo esté parado.
 */

/** Cuán urgente es, mirando los dos criterios: gana el que esté peor. */
export function urgencia(m) {
  if (m.sin_registro) return 'sin_registro'

  const porKm =
    m.km_restantes == null ? null : m.km_restantes <= 0 ? 'vencido' : m.km_restantes <= 500 ? 'pronto' : 'ok'
  const porFecha =
    m.dias_restantes == null ? null : m.dias_restantes <= 0 ? 'vencido' : m.dias_restantes <= 15 ? 'pronto' : 'ok'

  const peor = [porKm, porFecha].filter(Boolean)
  if (peor.includes('vencido')) return 'vencido'
  if (peor.includes('pronto')) return 'pronto'
  if (peor.includes('ok')) return 'ok'
  // Con intervalo pero sin nada medible todavía: el tipo va por km y el último
  // servicio se anotó sin odómetro.
  return 'sin_dato'
}

/** Lo que falta, dicho en el criterio que esté más cerca de vencer. */
export function cuantoFalta(m) {
  if (m.sin_registro) return 'Nunca se registró'

  const partes = []
  if (m.km_restantes != null) {
    partes.push(
      m.km_restantes <= 0
        ? `${Math.abs(m.km_restantes).toLocaleString('es-EC')} km pasado`
        : `faltan ${m.km_restantes.toLocaleString('es-EC')} km`,
    )
  }
  if (m.dias_restantes != null) {
    partes.push(
      m.dias_restantes <= 0
        ? `${Math.abs(m.dias_restantes)} días vencido`
        : `faltan ${m.dias_restantes} días`,
    )
  }
  return partes.join(' · ') || 'Sin datos para calcular'
}
