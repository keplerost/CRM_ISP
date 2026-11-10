/**
 * La llamada de la oficina antes de la visita (migración 227).
 *
 * La oficina llama mientras la cuadrilla trabaja en otra casa: si el cliente
 * está, la parada queda "confirmada"; si no, el ticket sale de la ruta de hoy
 * sin cerrarse y el técnico no hace el viaje ni espera los diez minutos.
 */

export const RESULTADOS_LLAMADA = [
  { valor: 'esta', label: 'Está en casa', posterga: false },
  { valor: 'no_contesta', label: 'No contesta', posterga: true },
  { valor: 'no_esta', label: 'No está en casa', posterga: true },
  { valor: 'otro_dia', label: 'Pide otro día', posterga: true },
]

export const etiquetaLlamada = (v) => RESULTADOS_LLAMADA.find((r) => r.valor === v)?.label ?? v

const diaLocal = (f) => new Date(f).toLocaleDateString('en-CA')

/**
 * La última llamada de HOY de cada ticket, por id.
 *
 * Solo la de hoy: que el cliente estuviera en casa ayer no dice nada de hoy.
 */
export function llamadasDeHoy(filas = [], hoy = new Date().toLocaleDateString('en-CA')) {
  const m = new Map()
  for (const f of filas) {
    if (diaLocal(f.creado_at) !== hoy) continue
    const previa = m.get(f.ticket_id)
    if (!previa || new Date(f.creado_at) > new Date(previa.creado_at)) m.set(f.ticket_id, f)
  }
  return m
}

/**
 * La última llamada de cada ticket hecha desde un día (incluido) en adelante.
 *
 * Para la ruta de mañana sirve la llamada de hoy: Jessica llama la tarde
 * anterior para confirmar. Para la de hoy, la de ayer o la de hoy.
 */
export function llamadasDesde(filas = [], desde) {
  const m = new Map()
  for (const f of filas) {
    if (diaLocal(f.creado_at) < desde) continue
    const previa = m.get(f.ticket_id)
    if (!previa || new Date(f.creado_at) > new Date(previa.creado_at)) m.set(f.ticket_id, f)
  }
  return m
}

/** El día anterior a una fecha "AAAA-MM-DD", en el mismo formato. */
export function diaAnterior(fecha) {
  const d = new Date(`${fecha}T12:00:00`)
  d.setDate(d.getDate() - 1)
  return d.toLocaleDateString('en-CA')
}

/** Orden para llamar: las citas por hora, después mañana, sin franja y tarde. */
export function ordenParaLlamar(a, b) {
  const clave = (t) =>
    t.hora ? `0${String(t.hora).slice(0, 5)}` : t.franja === 'manana' ? '1' : t.franja === 'tarde' ? '3' : '2'
  return clave(a).localeCompare(clave(b))
}

export const horaCorta = (f) =>
  new Date(f).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })
