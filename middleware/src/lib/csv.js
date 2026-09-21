import { badRequest } from './errors.js'

/**
 * Leer el archivo que exporta el sistema anterior.
 *
 * Un CSV parece trivial hasta que llega uno de verdad. Los de un ISP traen
 * comas dentro de la dirección, comillas en los nombres, punto y coma como
 * separador —Excel en español—, saltos de línea de Windows y un BOM al
 * principio que hace que la primera columna se llame "﻿id" y no "id".
 *
 * Partir por comas con `split` falla en el primer abonado que viva en "Av.
 * Quito, casa 3". Y falla en silencio: corre todas las columnas una posición y
 * el teléfono termina en la dirección.
 */

/** Con qué separa este archivo. */
function detectarSeparador(primeraLinea) {
  // Se cuenta FUERA de las comillas: una dirección con comas adentro no puede
  // hacer creer que el archivo separa por comas cuando separa por punto y coma.
  const fuera = { ',': 0, ';': 0, '\t': 0, '|': 0 }
  let enComillas = false
  for (const c of primeraLinea) {
    if (c === '"') enComillas = !enComillas
    else if (!enComillas && c in fuera) fuera[c]++
  }

  const [mejor] = Object.entries(fuera).sort((a, b) => b[1] - a[1])
  return mejor[1] > 0 ? mejor[0] : ','
}

/**
 * Divide una línea respetando las comillas.
 *
 * Dentro de comillas, el separador es texto. Y `""` es una comilla literal, que
 * es como todo el mundo escribe 'Casa "La Esperanza"'.
 */
function partirLinea(linea, sep) {
  const campos = []
  let actual = ''
  let enComillas = false

  for (let i = 0; i < linea.length; i++) {
    const c = linea[i]

    if (c === '"') {
      if (enComillas && linea[i + 1] === '"') {
        actual += '"'
        i++
      } else {
        enComillas = !enComillas
      }
      continue
    }

    if (c === sep && !enComillas) {
      campos.push(actual)
      actual = ''
      continue
    }

    actual += c
  }

  campos.push(actual)
  return campos.map((c) => c.trim())
}

/**
 * Separa en líneas, sin cortar las que traen un salto adentro de comillas.
 *
 * Una nota de varias líneas es un solo abonado, y partirla por `\n` lo
 * convertiría en tres filas rotas.
 */
function partirLineas(texto) {
  const lineas = []
  let actual = ''
  let enComillas = false

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]
    if (c === '"') enComillas = !enComillas

    if (c === '\n' && !enComillas) {
      lineas.push(actual.replace(/\r$/, ''))
      actual = ''
      continue
    }
    actual += c
  }
  if (actual.trim()) lineas.push(actual.replace(/\r$/, ''))

  return lineas.filter((l) => l.trim())
}

/**
 * El archivo, como una lista de objetos con los encabezados de clave.
 *
 * Las filas con menos columnas que el encabezado NO se descartan: se completan
 * con vacío. Un exportador que omite las últimas columnas cuando están vacías
 * es común, y perder esos abonados por eso sería perderlos por nada.
 */
export function leerCsv(texto) {
  // El BOM de Excel. Sin sacarlo, la primera columna se llama "﻿id" y no
  // coincide con ningún nombre conocido — el archivo entero parece no tener
  // identificador.
  const limpio = String(texto ?? '').replace(/^﻿/, '')
  const lineas = partirLineas(limpio)

  if (!lineas.length) throw badRequest('El archivo está vacío')

  const sep = detectarSeparador(lineas[0])
  const encabezados = partirLinea(lineas[0], sep)

  if (encabezados.filter(Boolean).length < 2) {
    throw badRequest('La primera línea no parece un encabezado de columnas', {
      hint: `Se leyó: ${lineas[0].slice(0, 120)}`,
    })
  }

  const filas = []
  for (const linea of lineas.slice(1)) {
    const valores = partirLinea(linea, sep)
    const fila = {}
    encabezados.forEach((h, i) => {
      if (h) fila[h] = valores[i] ?? ''
    })
    // Una línea entera vacía —las hay al final de casi todo export— no es un
    // abonado.
    if (Object.values(fila).some((v) => String(v).trim())) filas.push(fila)
  }

  return { separador: sep, encabezados: encabezados.filter(Boolean), filas }
}
