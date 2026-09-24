/**
 * A qué hora se le puede escribir a un abonado.
 *
 * ── Por qué existe ──
 *
 * La facturación corre a la 01:30 y el corte por mora a las 05:00, porque son
 * las horas en que la red está tranquila. Pero los avisos salían en ese mismo
 * momento, así que al abonado le llegaba un mensaje a la una y media de la
 * madrugada.
 *
 * Una abonada pidió el retiro del servicio por eso. No por la deuda: por el
 * susto. Un mensaje a esa hora se lee como una emergencia familiar, y para
 * cuando lo abre ya se llevó el sobresalto.
 *
 * ── Qué respeta la franja y qué no ──
 *
 * La franja es para lo que el sistema decide por su cuenta: la factura nueva,
 * el corte, los recordatorios de pago.
 *
 * NO la respeta lo que responde a algo que la persona acaba de hacer —el
 * comprobante de un pago, la respuesta a su ticket—. Quien paga a las once de
 * la noche quiere su confirmación en el momento: está esperando con el teléfono
 * en la mano.
 */

/** Los que esperan a la franja. El resto sale cuando se genera. */
export const ESPERAN_LA_FRANJA = new Set([
  'factura_nueva',
  'corte_servicio',
  'aviso_pago_1',
  'aviso_pago_2',
  'aviso_pago_3',
  'aviso_pago_4',
])

/** "08:00" → 480. Devuelve null si no se entiende, para poder caer al valor por defecto. */
export function aMinutos(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * ¿Se puede mandar esto ahora?
 *
 * Una franja con el inicio DESPUÉS del fin —de 20:00 a 08:00— se entiende como
 * que cruza la medianoche. No es el uso previsto, pero alguien la va a cargar
 * así alguna vez y tratarla como vacía dejaría todos los avisos detenidos para
 * siempre sin que nada lo explique.
 */
export function dentroDeLaFranja(ahora, { desde = '08:00', hasta = '20:00' } = {}) {
  const d = aMinutos(desde) ?? 8 * 60
  const h = aMinutos(hasta) ?? 20 * 60
  const m = ahora.getHours() * 60 + ahora.getMinutes()

  // Franja vacía o de un día entero: siempre se puede.
  if (d === h) return true
  if (d < h) return m >= d && m < h
  return m >= d || m < h
}

/**
 * Cuándo se va a poder mandar.
 *
 * Devuelve `null` si ya se puede —para no escribir una fecha que solo diría
 * "ahora"— y si no, la próxima apertura de la franja.
 */
export function cuandoSePuede(ahora, { desde = '08:00', hasta = '20:00' } = {}) {
  if (dentroDeLaFranja(ahora, { desde, hasta })) return null

  const d = aMinutos(desde) ?? 8 * 60
  const objetivo = new Date(ahora)
  objetivo.setHours(Math.floor(d / 60), d % 60, 0, 0)

  // Si la apertura de hoy ya pasó, es la de mañana.
  if (objetivo <= ahora) objetivo.setDate(objetivo.getDate() + 1)
  return objetivo
}

/** ¿Este tipo de aviso tiene que esperar a la franja? */
export const esperaLaFranja = (tipo) => ESPERAN_LA_FRANJA.has(String(tipo ?? '').trim())
