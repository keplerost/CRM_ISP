/**
 * Los teléfonos, en un solo lugar.
 *
 * ── Por qué esto es un archivo ──
 *
 * La misma conversión estaba escrita cuatro veces —cobranza, soporte, el
 * tablero comercial y el cotizador— y no eran iguales. Tres hacían:
 *
 *     tel.startsWith('0') ? '593' + tel.slice(1) : tel
 *
 * O sea: si el número venía sin el 0 adelante —`990032123`, que es como lo
 * escribe media Ecuador— lo dejaban tal cual y WhatsApp abría un chat con un
 * número de nueve dígitos que no existe. El vendedor veía "este contacto no
 * está en WhatsApp" y culpaba al cliente por darle mal el número.
 *
 * No se arregla en cuatro lugares: se arregla acá y los cuatro importan.
 */

// Ecuador. Es lo único de este archivo que asume un país, y está acá suelto
// para que el día que el sistema se venda afuera haya un solo lugar donde
// buscarlo. No se saca a configuración todavía porque no existe esa
// configuración, e inventarla vacía es peor que dejarlo a la vista.
const PAIS = '593'

/**
 * Un teléfono como lo quiere WhatsApp: código de país y sin el 0 inicial.
 *
 * Acepta las formas en las que la gente realmente lo escribe: `0990032123`,
 * `990032123`, `+593 99 003 2123`, `09-9003-2123`. Devuelve `null` si no hay
 * nada utilizable, y quien llama tiene que tratar ese `null` como "no se le
 * puede escribir" — no como cadena vacía.
 */
export function aWhatsApp(telefono) {
  const limpio = String(telefono ?? '').replace(/\D/g, '')
  if (!limpio) return null
  if (limpio.startsWith(PAIS)) return limpio
  return `${PAIS}${limpio.replace(/^0+/, '')}`
}

/** El enlace que abre el chat. Sin texto, abre la conversación en blanco. */
export function enlaceWhatsApp(telefono, texto = '') {
  const n = aWhatsApp(telefono)
  if (!n) return null
  return `https://wa.me/${n}${texto ? `?text=${encodeURIComponent(texto)}` : ''}`
}
