/**
 * Código de barras Code 128 — el que lleva la clave de acceso en el RIDE.
 *
 * Se codifica acá en vez de traer una librería porque lo único que hace falta
 * son los anchos de las barras: el dibujo lo resuelve pdfkit con rectángulos.
 *
 * La clave de acceso son 49 dígitos. En Code B cada carácter ocupa 11 módulos
 * (539 en total) y el código sale tan angosto que un lector de mostrador falla.
 * El juego C codifica dos dígitos por símbolo, así que se arranca en B con el
 * primer dígito —49 es impar— y se cambia a C para los 48 restantes: 27
 * símbolos en vez de 51.
 */

/** Patrones de barras y espacios de los 107 símbolos, en módulos. */
const PATRONES = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]

const INICIO_B = 104
const INICIO_C = 105
const CAMBIO_A_C = 99
const FIN = 106

/**
 * Valores de los símbolos del código, sin el checksum ni el fin.
 * Solo se optimiza el caso de los dígitos, que es el del RIDE; cualquier otro
 * texto se codifica entero en el juego B.
 */
function simbolos(texto) {
  const soloDigitos = /^\d+$/.test(texto)

  if (!soloDigitos) {
    // Code B: el valor es el código ASCII menos 32.
    return { inicio: INICIO_B, valores: [...texto].map((c) => c.charCodeAt(0) - 32) }
  }

  const valores = []
  let inicio
  let resto = texto

  if (texto.length % 2 === 0) {
    inicio = INICIO_C
  } else {
    // Cantidad impar: el primer dígito va en B y ahí se cambia a C.
    inicio = INICIO_B
    valores.push(texto.charCodeAt(0) - 32, CAMBIO_A_C)
    resto = texto.slice(1)
  }

  for (let i = 0; i < resto.length; i += 2) valores.push(Number(resto.slice(i, i + 2)))

  return { inicio, valores }
}

/**
 * Anchos de las barras de un Code 128.
 *
 * @returns {{ barras: number[], modulos: number }} anchos alternados
 *   empezando por barra (negro), y el total de módulos para escalar el dibujo.
 */
export function code128(texto) {
  const limpio = String(texto ?? '').trim()
  if (!limpio) throw new Error('No hay nada que codificar en el código de barras')

  const { inicio, valores } = simbolos(limpio)

  // El checksum pesa cada símbolo por su posición: es lo que detecta una
  // lectura corrida de un dígito.
  let suma = inicio
  valores.forEach((v, i) => {
    suma += v * (i + 1)
  })
  const checksum = suma % 103

  const secuencia = [inicio, ...valores, checksum, FIN]
  const barras = secuencia.flatMap((v) => [...PATRONES[v]].map(Number))

  return { barras, modulos: barras.reduce((s, n) => s + n, 0) }
}

/**
 * Dibuja el código en un documento de pdfkit.
 *
 * Los rectángulos se calculan sobre el ancho pedido: el PDF es vectorial, así
 * que el código queda nítido en pantalla y al imprimirlo.
 */
export function dibujarCode128(doc, texto, { x, y, ancho, alto = 30, color = '#000' }) {
  const { barras, modulos } = code128(texto)
  const modulo = ancho / modulos

  let cursor = x
  let negro = true
  for (const n of barras) {
    const w = n * modulo
    if (negro) doc.rect(cursor, y, w, alto).fill(color)
    cursor += w
    negro = !negro
  }
}
