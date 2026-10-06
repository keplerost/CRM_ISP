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
 * Los números que hay en un campo de teléfono.
 *
 * ── El error que esto arregla ──
 *
 * Muchos abonados tienen dos números en el mismo campo: `0991234567 /
 * 0987654321`, `0991234567 - 052345678`, `0991234567 0987654321`. Se limpiaban
 * todos los dígitos juntos y salía un número de veinte cifras: WhatsApp abría
 * un chat con un número que no existe y no dejaba escribir, y "Llamar" marcaba
 * cualquier cosa.
 *
 * Se separa primero por lo que la gente usa para separar (`/ , ; |`, "y", "o",
 * salto de línea). Si un pedazo sigue teniendo más dígitos de los que entran
 * en un número —dos números separados por un espacio o un guion—, se cortan
 * los números ecuatorianos que se reconocen adentro: celular `09XXXXXXXX` y
 * fijo `0[2-7]XXXXXXX`.
 *
 * Devuelve `[{ local, internacional, movil }]`, sin repetidos y en el orden en
 * que estaban escritos.
 */
export function separarTelefonos(texto) {
  const pedazos = String(texto ?? '')
    .split(/[/,;|\n]+|\s+(?:y|o)\s+/i)
    .map((p) => p.replace(/\D/g, ''))
    .filter(Boolean)

  const numeros = []
  for (const d of pedazos) {
    // Hasta 12 dígitos es un solo número (con o sin el 593 adelante).
    if (d.length <= 12) {
      numeros.push(d)
      continue
    }
    const sueltos = d.match(/(?:593)?0?9\d{8}|0[2-7]\d{7}/g)
    if (sueltos) numeros.push(...sueltos)
  }

  const vistos = new Set()
  return numeros
    .map((d) => {
      const nacional = d.startsWith(PAIS) && d.length > 10 ? d.slice(PAIS.length) : d.replace(/^0+/, '')
      return {
        local: `0${nacional}`,
        internacional: `${PAIS}${nacional}`,
        // En Ecuador el celular empieza con 9; el fijo, con 2 a 7. WhatsApp
        // está en el celular.
        movil: nacional.startsWith('9'),
      }
    })
    .filter((n) => n.local.length >= 8 && !vistos.has(n.internacional) && vistos.add(n.internacional))
}

/**
 * Un teléfono como lo quiere WhatsApp: código de país y sin el 0 inicial.
 *
 * Acepta las formas en las que la gente realmente lo escribe: `0990032123`,
 * `990032123`, `+593 99 003 2123`, `09-9003-2123`. Si hay más de un número en
 * el campo, usa el primer CELULAR: un fijo no tiene WhatsApp. Devuelve `null`
 * si no hay nada utilizable, y quien llama tiene que tratar ese `null` como
 * "no se le puede escribir" — no como cadena vacía.
 */
export function aWhatsApp(telefono) {
  const numeros = separarTelefonos(telefono)
  if (!numeros.length) return null
  return (numeros.find((n) => n.movil) ?? numeros[0]).internacional
}

/** El enlace que abre el chat. Sin texto, abre la conversación en blanco. */
export function enlaceWhatsApp(telefono, texto = '') {
  const n = aWhatsApp(telefono)
  if (!n) return null
  return `https://wa.me/${n}${texto ? `?text=${encodeURIComponent(texto)}` : ''}`
}

/** El enlace para llamar: el primer número del campo, como se marca en el país. */
export function enlaceLlamada(telefono) {
  const n = separarTelefonos(telefono)[0]
  return n ? `tel:${n.local}` : null
}
