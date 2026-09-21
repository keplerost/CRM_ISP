import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { generarReciboPdf, montoEnLetras } from '../src/pagos/reciboPdf.js'

/**
 * El recibo es lo que el abonado se lleva del mostrador. Si sale mal el monto o
 * no dice de quién es, el reclamo llega semanas después sin nada con qué
 * contrastarlo.
 */

const EMISOR = {
  razon_social: 'JOSE LUIS OÑA RIERA',
  nombre_comercial: 'OR IMPORTACIONES',
  ruc: '0504056151001',
  telefono: '0981864229',
}

const PAGO = {
  id: 'p1',
  numero: 12,
  fecha_pago: '2026-07-31',
  monto: 34.5,
  comision: 0,
  forma_pago: 'efectivo',
  cuenta: 'Caja Oficina',
  n_transaccion: null,
  numero_comprobante: '001-003-000000001',
  cliente_nombre: 'JEFFERSON FABIAN OÑA RIERA',
  notas: null,
  anulado: false,
}

const CLIENTE = { nombre: 'JEFFERSON FABIAN OÑA RIERA', identificacion: '1250579925001' }

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
    lineas.push(
      (a[1].match(/<[0-9a-fA-F]*>/g) ?? [])
        .map((h) => Buffer.from(h.slice(1, -1), 'hex').toString('latin1'))
        .join(''),
    )
  }
  return lineas.join('\n')
}

// --- Monto en letras --------------------------------------------------------

test('el monto en letras es el que se escribe en un recibo', () => {
  assert.equal(montoEnLetras(34.5), 'treinta y cuatro 50/100 dólares')
  assert.equal(montoEnLetras(1), 'un 00/100 dólares')
  assert.equal(montoEnLetras(15), 'quince 00/100 dólares')
  assert.equal(montoEnLetras(21.05), 'veintiun 05/100 dólares')
  assert.equal(montoEnLetras(100), 'cien 00/100 dólares')
  assert.equal(montoEnLetras(115.99), 'ciento quince 99/100 dólares')
  assert.equal(montoEnLetras(1250.4), 'mil doscientos cincuenta 40/100 dólares')
})

test('los centavos se redondean, no se truncan', () => {
  // 0.1 + 0.2 en binario da 0.30000000000000004: truncar dejaría "29/100".
  assert.equal(montoEnLetras(0.1 + 0.2), 'cero 30/100 dólares')
})

// --- El PDF -----------------------------------------------------------------

test('el recibo lleva el número, el cliente y el monto', async () => {
  const pdf = await generarReciboPdf({ emisor: EMISOR, pago: PAGO, cliente: CLIENTE })

  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')

  const texto = textoDelPdf(pdf)
  assert.match(texto, /RECIBO DE COBRO/)
  assert.match(texto, /N. 000012/)
  assert.match(texto, /JEFFERSON FABIAN O.A RIERA/)
  assert.match(texto, /\$34\.50/)
  assert.match(texto, /1250579925001/)
  assert.match(texto, /001-003-000000001/, 'la factura que se está pagando')
})

test('salen las dos copias en la misma hoja', async () => {
  const texto = textoDelPdf(await generarReciboPdf({ emisor: EMISOR, pago: PAGO, cliente: CLIENTE }))

  assert.match(texto, /ORIGINAL . CLIENTE/)
  assert.match(texto, /COPIA . CAJA/)
})

test('un cobro sin factura asociada se imprime como abono a cuenta', async () => {
  const texto = textoDelPdf(
    await generarReciboPdf({
      emisor: EMISOR,
      pago: { ...PAGO, numero_comprobante: null },
      cliente: CLIENTE,
    }),
  )

  assert.match(texto, /Abono a cuenta/)
})

test('la comisión se explica en el recibo', async () => {
  const texto = textoDelPdf(
    await generarReciboPdf({
      emisor: EMISOR,
      pago: { ...PAGO, comision: 0.5 },
      cliente: CLIENTE,
    }),
  )

  // El abonado pagó 34.50 y a la cuenta entraron 34.00: si no se dice, la
  // diferencia parece un error de caja.
  assert.match(texto, /\$0\.50 de comisi/)
  assert.match(texto, /\$34\.00/)
})

test('un cobro anulado se imprime marcado', async () => {
  const texto = textoDelPdf(
    await generarReciboPdf({ emisor: EMISOR, pago: { ...PAGO, anulado: true }, cliente: CLIENTE }),
  )

  assert.match(texto, /ANULADO/)
})

test('sin cliente en la ficha se usa el nombre guardado en el cobro', async () => {
  const texto = textoDelPdf(await generarReciboPdf({ emisor: EMISOR, pago: PAGO, cliente: null }))

  assert.match(texto, /JEFFERSON FABIAN O.A RIERA/)
})

test('sin pago no hay recibo', () => {
  assert.throws(() => generarReciboPdf({ emisor: EMISOR, pago: null }), /pago/)
})
