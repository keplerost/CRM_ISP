/**
 * Lo que se le escribe al abonado para coordinar el retiro.
 *
 * ── Por qué el texto vive acá y no adentro del botón ──
 *
 * Porque lo va a leer un cliente que ya está molesto: se le cortó el servicio y
 * ahora le tocan la puerta para llevarse el equipo. Un mensaje mal escrito en
 * ese momento es la diferencia entre "pasá a las 6" y un portazo.
 *
 * Y porque es el mismo texto por WhatsApp y por Telegram. Escribirlo dos veces
 * garantiza que en un mes sean distintos.
 *
 * ── El tono ──
 *
 * Se saluda, se dice quién escribe, se pregunta —no se avisa— y se ofrece
 * coordinar. No se menciona la deuda: quien va a retirar el equipo no es quien
 * cobra, y mezclar las dos cosas convierte una coordinación en una discusión.
 *
 * Sin imports a propósito: se prueba con el mismo runner que el resto.
 */

/** El primer nombre. "JEFFERSON FABIAN OÑA RIERA" se saluda como Jefferson. */
export function primerNombre(nombre) {
  const limpio = String(nombre ?? '').trim()
  if (!limpio) return ''
  const primera = limpio.split(/\s+/)[0]
  return primera.charAt(0).toUpperCase() + primera.slice(1).toLowerCase()
}

/** Buenos días / buenas tardes / buenas noches, según la hora de quien escribe. */
export function saludo(ahora = new Date()) {
  const h = ahora.getHours()
  if (h < 12) return 'Buenos días'
  if (h < 19) return 'Buenas tardes'
  return 'Buenas noches'
}

const fechaHora = (f) => {
  if (!f) return null
  const d = new Date(f)
  if (Number.isNaN(d.getTime())) return null
  const dd = (n) => String(n).padStart(2, '0')
  return `${dd(d.getDate())}/${dd(d.getMonth() + 1)} a las ${dd(d.getHours())}:${dd(d.getMinutes())}`
}

/**
 * El mensaje para coordinar la visita.
 *
 * Con cita cargada confirma esa cita; sin cita pregunta si está en el
 * domicilio. Son dos conversaciones distintas: al que ya quedó en un horario,
 * preguntarle de nuevo "¿está en su casa?" le dice que nadie anotó lo que
 * habló la vez anterior.
 */
export function mensajeCoordinacion({ cliente, empresa, agendadoPara } = {}, ahora = new Date()) {
  const nombre = primerNombre(cliente)
  const quien = empresa ? ` de ${empresa}` : ''
  const cuando = fechaHora(agendadoPara)

  const partes = [`${saludo(ahora)}${nombre ? ` ${nombre}` : ''}, le escribimos${quien}.`]

  if (cuando) {
    partes.push(
      `Quedamos en pasar por su domicilio el ${cuando} para retirar el equipo. ¿Nos confirma que va a estar?`,
    )
  } else {
    partes.push(
      '¿Se encuentra en el domicilio? Necesitamos coordinar el retiro del equipo y queremos pasar cuando le quede cómodo.',
    )
  }

  return partes.join(' ')
}

/** El de "estoy en la puerta", para el que ya llegó. */
export function mensajeLlegue({ cliente, empresa } = {}, ahora = new Date()) {
  const nombre = primerNombre(cliente)
  const quien = empresa ? ` de ${empresa}` : ''
  return `${saludo(ahora)}${nombre ? ` ${nombre}` : ''}, le escribimos${quien}. Estamos en su domicilio para el retiro del equipo. ¿Nos puede atender?`
}

/** Y el de la reprogramación, para cuando no había nadie. */
export function mensajeReprogramar({ cliente, empresa } = {}, ahora = new Date()) {
  const nombre = primerNombre(cliente)
  const quien = empresa ? ` de ${empresa}` : ''
  return `${saludo(ahora)}${nombre ? ` ${nombre}` : ''}, le escribimos${quien}. Pasamos por su domicilio y no lo encontramos. ¿Qué día y hora le queda mejor para retirar el equipo?`
}

export const PLANTILLAS = [
  { clave: 'coordinar', label: 'Coordinar la visita', arma: mensajeCoordinacion },
  { clave: 'llegue', label: 'Estoy en la puerta', arma: mensajeLlegue },
  { clave: 'reprogramar', label: 'No había nadie', arma: mensajeReprogramar },
]
