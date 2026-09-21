import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { generarContrato } from '../src/pagos/contratoPdf.js'

/**
 * El contrato es el único de los seis documentos que se arma entero desde la
 * plantilla. Eso lo hace flexible y también frágil: cualquier cosa que el ISP
 * escriba tiene que salir impresa, y lo que se imprime tiene que poder firmarse.
 *
 * Estas pruebas cuidan justamente eso: que no se pierda texto, que el que firma
 * sepa si le entregaron todas las hojas, y que un dato faltante no impida sacar
 * el papel.
 */

const EMPRESA = {
  razon_social: 'JOSE LUIS OÑA RIERA',
  nombre_comercial: 'OR IMPORTACIONES',
  ruc: '0504056151001',
  telefono: '0981864229',
}

const CLIENTE = { nombre: 'Edison Raul Delgado Loor', identificacion: '1234569870' }

/** Lo que el PDF dice de verdad, sacado de sus flujos de texto. */
function textoDelPdf(pdf) {
  const s = pdf.toString('latin1')
  const partes = []
  const re = /stream\r?\n/g
  let m
  while ((m = re.exec(s))) {
    const i = m.index + m[0].length
    const f = s.indexOf('endstream', i)
    if (f < 0) break
    try {
      partes.push(zlib.inflateSync(pdf.subarray(i, f)).toString('latin1'))
    } catch {
      partes.push(s.slice(i, f))
    }
  }

  const contenido = partes.join('\n')
  const lineas = []
  const rx = /\[((?:[^\]\\]|\\.)*)\]\s*TJ/g
  let a
  while ((a = rx.exec(contenido))) {
    /**
     * En una línea justificada el espacio no es un carácter: es un corrimiento
     * entre dos trozos de texto. Si solo se pegaran los trozos, "CLAUSULA 1"
     * saldría "CLAUSULA1" y la prueba diría que falta algo que sí está impreso.
     *
     * Por eso se recorren también los números del arreglo. Solo los NEGATIVOS
     * grandes: en PDF un número negativo separa y uno positivo junta, así que
     * los positivos son el kerning entre letras —el que acerca la T a la A— y
     * tomarlos por espacios partiría "CONTRATO" en "CONTRA TO".
     */
    let linea = ''
    const tokens = a[1].match(/<[0-9a-fA-F]*>|-?\d+(?:\.\d+)?/g) ?? []
    for (const t of tokens) {
      if (t.startsWith('<')) linea += Buffer.from(t.slice(1, -1), 'hex').toString('latin1')
      else if (Number(t) < -100 && !linea.endsWith(' ')) linea += ' '
    }
    lineas.push(linea)
  }
  return lineas.join('\n')
}

const PLANTILLA = [
  '<h1>CONTRATO DE SERVICIO DE INTERNET</h1>',
  '<p>Entre OR IMPORTACIONES, RUC 0504056151001, y Edison Raul Delgado Loor.</p>',
  '<p>Plan contratado: PLAN_HOME por $20.09 mensuales.</p>',
].join('\n')

test('el contrato imprime lo que dice la plantilla', async () => {
  const pdf = await generarContrato({
    plantilla: PLANTILLA,
    empresa: EMPRESA,
    cliente: CLIENTE,
    contrato: { numero: 'C-0012' },
  })

  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')

  const texto = textoDelPdf(pdf)
  assert.match(texto, /CONTRATO DE SERVICIO DE INTERNET/)
  assert.match(texto, /RUC 0504056151001/)
  assert.match(texto, /PLAN_HOME/)
})

test('quien firma sabe quién es cada parte', async () => {
  // Un contrato con dos rayas sin nombre debajo no dice quién se obliga a qué.
  const texto = textoDelPdf(
    await generarContrato({ plantilla: PLANTILLA, empresa: EMPRESA, cliente: CLIENTE }),
  )

  assert.match(texto, /JOSE LUIS O.A RIERA/, 'la razón social firma, no el nombre comercial')
  assert.match(texto, /El proveedor/)
  assert.match(texto, /Edison Raul Delgado Loor/)
  assert.match(texto, /C\.I\.\/RUC 1234569870/)
})

test('cada hoja dice cuántas son y de qué contrato es', async () => {
  const texto = textoDelPdf(
    await generarContrato({
      plantilla: PLANTILLA,
      empresa: EMPRESA,
      cliente: CLIENTE,
      contrato: { numero: 'C-0012' },
    }),
  )

  assert.match(texto, /Contrato C-0012/)
  assert.match(texto, /Hoja 1 de 1/)
})

test('un contrato largo se reparte en hojas y todas se numeran', async () => {
  // El caso real: el ISP pega sus veinte cláusulas en el editor. Si la
  // numeración solo saliera en la primera, nadie podría reclamar una hoja que
  // no le entregaron.
  const clausulas = Array.from(
    { length: 45 },
    (_, i) => `<p>CLAUSULA ${i + 1}: el abonado se compromete a mantener el equipo instalado `
      + 'en el domicilio declarado y a permitir el acceso del personal tecnico para '
      + 'las revisiones que el servicio requiera.</p>',
  ).join('\n')

  const pdf = await generarContrato({
    plantilla: `<h1>CONTRATO</h1>\n${clausulas}`,
    empresa: EMPRESA,
    cliente: CLIENTE,
  })
  const texto = textoDelPdf(pdf)

  const hojas = [...texto.matchAll(/Hoja (\d+) de (\d+)/g)]
  assert.ok(hojas.length > 1, `deberia ocupar mas de una hoja, ocupo ${hojas.length}`)

  const total = hojas[0][2]
  assert.equal(Number(total), hojas.length, 'el total tiene que ser el número real de hojas')
  for (const [i, h] of hojas.entries()) {
    assert.equal(Number(h[1]), i + 1, 'las hojas van en orden')
    assert.equal(h[2], total, 'todas dicen el mismo total')
  }

  // Y ninguna cláusula se perdió en el camino.
  assert.match(texto, /CLAUSULA 1:/)
  assert.match(texto, /CLAUSULA 45:/)
})

test('una plantilla sin etiquetas también se imprime', async () => {
  // El ISP que escribe su contrato como texto plano no tiene por qué recibir
  // una hoja en blanco.
  const texto = textoDelPdf(
    await generarContrato({
      plantilla: 'CONTRATO DE SERVICIO\nEl abonado acepta las condiciones publicadas.',
      empresa: EMPRESA,
      cliente: CLIENTE,
    }),
  )

  assert.match(texto, /CONTRATO DE SERVICIO/)
  assert.match(texto, /El abonado acepta las condiciones publicadas/)
})

test('un logo ilegible no impide sacar el contrato', async () => {
  // El logo se guarda desde una pantalla de ajustes: puede quedar cortado. Que
  // eso deje sin contrato a un abonado sería absurdo.
  const pdf = await generarContrato({
    plantilla: PLANTILLA,
    empresa: EMPRESA,
    cliente: CLIENTE,
    logo: Buffer.from('esto no es una imagen'),
  })

  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  assert.match(textoDelPdf(pdf), /CONTRATO DE SERVICIO DE INTERNET/)
})

test('sin datos del abonado sigue saliendo el papel para llenar a mano', async () => {
  // Sirve para imprimir contratos en blanco, que es lo que el técnico lleva
  // cuando va a dar de alta a alguien que todavía no está cargado.
  const pdf = await generarContrato({ plantilla: PLANTILLA })

  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  assert.match(textoDelPdf(pdf), /El abonado/, 'la raya del abonado va igual')
})
