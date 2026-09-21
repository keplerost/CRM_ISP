import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { generarFacturaPdf } from '../src/pagos/facturaPdf.js'

/**
 * El estado de cuenta es lo que se le muestra al abonado que reclama un pago.
 * Si no dice lo que entregó —y no solo lo que se imputó— la discusión no se
 * resuelve con el papel en la mano.
 */

const EMISOR = {
  razon_social: 'JOSE LUIS OÑA RIERA',
  nombre_comercial: 'OR IMPORTACIONES',
  ruc: '0504056151001',
  telefono: '0981864229',
}

const FACTURA = {
  id: 'f1',
  numero: 6,
  cliente: 'JEFFERSON FABIAN OÑA RIERA',
  concepto: 'PLAN_30M',
  periodo_desde: '2026-08-01',
  periodo_hasta: '2026-08-31',
  fecha_emision: '2026-08-01',
  fecha_vencimiento: '2026-08-05',
  subtotal: 30,
  impuesto: 4.5,
  total: 34.5,
  pagado: 34.5,
  saldo: 0,
  estado: 'pagada',
  numero_fiscal: null,
}

const PAGOS = [
  {
    id: 'p1',
    numero: 17,
    fecha_pago: '2026-08-01',
    forma_pago: 'transferencia',
    n_transaccion: '884471203',
    monto: 34.5,
    total_cobro: 50,
    excedente: 15.5,
    anulado: false,
  },
]

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

test('la factura sale aunque no tenga comprobante del SRI', async () => {
  // Es el caso del abonado que no quiere factura electrónica: igual necesita un
  // papel que diga qué debe y qué pagó.
  const pdf = await generarFacturaPdf({ emisor: EMISOR, factura: FACTURA, pagos: PAGOS })

  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')

  const texto = textoDelPdf(pdf)
  assert.match(texto, /FACTURA # 00000006/)
  assert.match(texto, /PAGADO/, 'la banda de estado')
  assert.match(texto, /PLAN_30M/)
  assert.match(texto, /JEFFERSON/)
  assert.match(texto, /SON: TREINTA Y CUATRO D.LARES CON CINCUENTA CENTAVOS/)
  assert.match(texto, /No es un comprobante tributario/)
})

test('las transacciones muestran lo que el abonado entregó', async () => {
  // Entregó $50 por una factura de $34.50: eso es lo que él recuerda haber
  // pagado, y es lo que tiene que leer en el papel.
  const texto = textoDelPdf(
    await generarFacturaPdf({ emisor: EMISOR, factura: FACTURA, pagos: PAGOS }),
  )

  assert.match(texto, /\$ 50\.00/)
  assert.match(texto, /884471203/)
  assert.match(texto, /Transferencia bancaria/)
})

test('el balance negativo es la plata que le queda a favor', async () => {
  const texto = textoDelPdf(
    await generarFacturaPdf({ emisor: EMISOR, factura: FACTURA, pagos: PAGOS }),
  )

  // 34.50 facturados − 50 entregados = −15.50
  assert.match(texto, /Balance/)
  assert.match(texto, /\$ -15\.50/)
  assert.match(texto, /a favor del cliente/)
})

test('una factura impaga muestra el balance en positivo y la banda de vencida', async () => {
  const texto = textoDelPdf(
    await generarFacturaPdf({
      emisor: EMISOR,
      factura: { ...FACTURA, pagado: 10, saldo: 24.5, estado: 'vencida' },
      pagos: [{ ...PAGOS[0], monto: 10, total_cobro: 10, excedente: 0 }],
    }),
  )

  assert.match(texto, /VENCIDO/)
  assert.match(texto, /\$ 24\.50/)
})

test('sin pagos lo dice, en vez de mostrar una tabla vacía', async () => {
  const texto = textoDelPdf(
    await generarFacturaPdf({
      emisor: EMISOR,
      factura: { ...FACTURA, pagado: 0, saldo: 34.5, estado: 'pendiente' },
      pagos: [],
    }),
  )

  assert.match(texto, /Sin pagos registrados/)
  assert.match(texto, /PENDIENTE/)
})

test('con comprobante fiscal lo referencia y aclara que el RIDE va aparte', async () => {
  const texto = textoDelPdf(
    await generarFacturaPdf({
      emisor: EMISOR,
      factura: { ...FACTURA, numero_fiscal: '001-003-000000001' },
      pagos: PAGOS,
    }),
  )

  assert.match(texto, /001-003-000000001/)
  assert.match(texto, /RIDE se entrega aparte/)
})

test('la deuda de meses anteriores se arrastra al total a pagar', async () => {
  // El abonado que recibe la factura de noviembre sin ver que octubre sigue
  // impago paga el mes y se va convencido de estar al día.
  const texto = textoDelPdf(
    await generarFacturaPdf({
      emisor: EMISOR,
      factura: { ...FACTURA, numero: 11, pagado: 0, saldo: 34.5, estado: 'pendiente' },
      pagos: [],
      deudaAnterior: [{ numero: 10, periodo_desde: '2026-10-01', saldo: 22.5 }],
    }),
  )

  assert.match(texto, /TOTAL DEL MES/)
  assert.match(texto, /SALDO ANTERIOR/)
  assert.match(texto, /TOTAL A PAGAR/)
  assert.match(texto, /\$ 57\.00/, '34.50 del mes + 22.50 de octubre')
  assert.match(texto, /N. 00000010 \(oct 2026\)/, 'de qué factura viene la deuda')
})

test('sin deuda vieja el total va solo, sin la línea de arrastre', async () => {
  const texto = textoDelPdf(
    await generarFacturaPdf({ emisor: EMISOR, factura: FACTURA, pagos: PAGOS }),
  )

  assert.doesNotMatch(texto, /SALDO ANTERIOR/)
  assert.doesNotMatch(texto, /TOTAL A PAGAR/)
})

test('distingue el cobro repartido del saldo a favor aplicado después', async () => {
  // Las dos filas se ven igual en la base —sin número de banco, colgando de otro
  // cobro— pero para el abonado son cosas distintas.
  const base = { ...PAGOS[0], n_transaccion: null, pago_origen_id: 'p0', total_cobro: 34.5, excedente: 0 }

  const repartido = textoDelPdf(
    await generarFacturaPdf({
      emisor: EMISOR,
      factura: FACTURA,
      pagos: [{ ...base, es_reparto: true }],
      origenes: { p0: 32 },
    }),
  )
  assert.match(repartido, /parte del recibo N. 000032/)

  const aFavor = textoDelPdf(
    await generarFacturaPdf({
      emisor: EMISOR,
      factura: FACTURA,
      pagos: [{ ...base, es_reparto: false }],
      origenes: { p0: 30 },
    }),
  )
  assert.match(aFavor, /saldo a favor del recibo N. 000030/)
})

test('el descuento se ve en el papel, con su motivo', async () => {
  // Al abonado con derecho no le sirve un importe ya rebajado: necesita poder
  // mostrar que se lo aplicaron, y el motivo es lo que lo justifica.
  const texto = textoDelPdf(
    await generarFacturaPdf({
      emisor: EMISOR,
      factura: {
        ...FACTURA,
        subtotal: 30,
        descuento: 15,
        impuesto: 2.25,
        total: 17.25,
        descuento_motivo: 'Descuento tercera edad 50%',
        pagado: 17.25,
        saldo: 0,
      },
      pagos: [],
    }),
  )

  assert.match(texto, /DESCUENTO/)
  assert.match(texto, /\$ 15\.00/)
  assert.match(texto, /Descuento tercera edad 50%/)
  assert.match(texto, /SON: DIECISIETE D.LARES CON VEINTICINCO CENTAVOS/)
})

test('sin factura no hay nada que imprimir', () => {
  assert.throws(() => generarFacturaPdf({ emisor: EMISOR, factura: null }), /factura/)
})
