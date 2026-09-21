/**
 * Los datos que las plantillas de aviso nombran y no están en la ficha.
 *
 * ── Por qué viven acá y no dentro del servicio ──
 *
 * Porque son las que producen el error más silencioso de todo el sistema de
 * mensajería: un marcador sin dato NO rompe nada — se deja tal cual para no
 * perder el resto del mensaje— así que el abonado recibe "Su servicio será
 * suspendido el {{fecha_corte}}" y del lado del ISP todo figura como enviado.
 *
 * Estando afuera se pueden probar sin mandar correos.
 */

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

/** Dinero como lo lee el abonado. */
export const dinero = (n) => `$${(Number(n) || 0).toFixed(2)}`

/**
 * Una fecha corta, sin pasar por ninguna zona horaria.
 *
 * `new Date('2026-09-05')` es medianoche UTC, que en Ecuador es el 4 a las
 * 19:00: un aviso de corte con la fecha corrida un día es peor que ninguno.
 */
export function fechaCorta(valor) {
  if (!valor) return ''
  const m = String(valor).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return String(valor)
  return `${m[3]}/${m[2]}/${m[1]}`
}

/** Sumarle días a una fecha, en el mismo formato y sin zonas horarias. */
export function sumarDias(valor, dias) {
  if (!valor) return ''
  const m = String(valor).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return String(valor)

  // Se usa UTC a propósito: acá no hay hora, solo se cuentan días, y el UTC no
  // tiene horario de verano que corra el resultado.
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  d.setUTCDate(d.getUTCDate() + (Number(dias) || 0))
  return d.toISOString().slice(0, 10)
}

/**
 * El período que cubre la factura, como lo diría una persona.
 *
 * Se saca del concepto cuando lo trae —"Plan 30M · septiembre 2026"— y si no,
 * del mes del vencimiento. El abonado tiene que saber de qué mes le están
 * hablando: "su factura está por vencer" sin decir cuál no sirve para nada
 * cuando debe tres.
 */
export function periodoDe(concepto, vencimiento) {
  const texto = String(concepto ?? '')

  // Si el concepto ya nombra un mes y un año, se usa tal cual.
  const conMes = texto.match(
    new RegExp(`(${MESES.join('|')})\\s+(?:de\\s+)?(\\d{4})`, 'i'),
  )
  if (conMes) return `${conMes[1].toLowerCase()} ${conMes[2]}`

  const m = String(vencimiento ?? '').match(/^(\d{4})-(\d{2})/)
  if (!m) return texto || ''
  return `${MESES[Number(m[2]) - 1]} ${m[1]}`
}
