import test from 'node:test'
import assert from 'node:assert/strict'

import {
  generarXmlFactura,
  calcularTotales,
  escaparXml,
  escaparAtributo,
  dec2,
  dec6,
  IVA,
  IDENTIFICACION,
} from '../src/sri/facturaXml.js'
import { generarClaveAcceso } from '../src/sri/claveAcceso.js'

const EMISOR = {
  ruc: '1790012345001',
  razon_social: 'FIBRA & REDES S.A.',
  nombre_comercial: 'CNET Fibra',
  dir_matriz: 'Av. Principal 123',
  obligado_contabilidad: true,
  ambiente: '1',
}

const claveAcceso = generarClaveAcceso({
  fechaEmision: '2026-07-31',
  tipoComprobante: '01',
  ruc: EMISOR.ruc,
  secuencial: 1,
})

const FACTURA = {
  claveAcceso,
  secuencial: 1,
  fechaEmision: '31/07/2026',
  tipoIdentificacionComprador: IDENTIFICACION.CEDULA,
  razonSocialComprador: 'PALMA ROMERO JULYANA JAZMIN',
  identificacionComprador: '1712345678',
  direccionComprador: 'Calle Falsa 456',
  emailComprador: 'cliente@ejemplo.com',
}

const UN_DETALLE = [
  {
    codigoPrincipal: 'PLAN-50',
    descripcion: 'Internet fibra 50 Mbps - Julio 2026',
    cantidad: 1,
    precioUnitario: 25,
    tarifaIva: 15,
    codigoPorcentaje: IVA.QUINCE.codigo,
  },
]

// --- Aritmética -------------------------------------------------------------

test('dec2 redondea sin el error del punto flotante', () => {
  // (1.005).toFixed(2) da "1.00" porque 1.005 no es exacto en binario.
  assert.equal(dec2(1.005), '1.01')
  assert.equal(dec2(2.675), '2.68')
  assert.equal(dec2(25), '25.00')
  assert.equal(dec2(0), '0.00')
})

test('todos los montos llevan exactamente dos decimales', () => {
  // El XSD del SRI rechaza "12.5" y "12.500".
  for (const v of [12.5, 12, 0.1, 1000]) {
    assert.match(dec2(v), /^\d+\.\d{2}$/)
  }
})

test('cantidades y precios llevan seis decimales', () => {
  assert.equal(dec6(1), '1.000000')
  assert.equal(dec6(0.333333333), '0.333333')
})

test('calcula el IVA del 15% correctamente', () => {
  const t = calcularTotales(UN_DETALLE)
  assert.equal(t.totalSinImpuestos, 25)
  assert.equal(t.totalIva, 3.75)
  assert.equal(t.importeTotal, 28.75)
})

test('descuenta antes de calcular el IVA', () => {
  const t = calcularTotales([{ cantidad: 2, precioUnitario: 10, descuento: 5, tarifaIva: 15 }])
  assert.equal(t.totalSinImpuestos, 15)
  assert.equal(t.totalDescuento, 5)
  assert.equal(t.totalIva, 2.25)
  assert.equal(t.importeTotal, 17.25)
})

test('agrupa los impuestos por código de porcentaje', () => {
  // Dos líneas al 15% tienen que producir UN solo totalImpuesto, no dos.
  const t = calcularTotales([
    { descripcion: 'A', cantidad: 1, precioUnitario: 10, tarifaIva: 15, codigoPorcentaje: '4' },
    { descripcion: 'B', cantidad: 1, precioUnitario: 20, tarifaIva: 15, codigoPorcentaje: '4' },
    { descripcion: 'C', cantidad: 1, precioUnitario: 5, tarifaIva: 0, codigoPorcentaje: '0' },
  ])

  assert.equal(t.impuestos.length, 2, 'un impuesto por tarifa distinta')

  const quince = t.impuestos.find((i) => i.codigoPorcentaje === '4')
  assert.equal(quince.baseImponible, 30, 'las bases del 15% se suman')
  assert.equal(quince.valor, 4.5)

  const cero = t.impuestos.find((i) => i.codigoPorcentaje === '0')
  assert.equal(cero.baseImponible, 5)
  assert.equal(cero.valor, 0)

  assert.equal(t.importeTotal, 39.5)
})

// --- Escapado ---------------------------------------------------------------

test('escapa los caracteres que romperían el XML', () => {
  assert.equal(escaparXml('FIBRA & REDES'), 'FIBRA &amp; REDES')
  assert.equal(escaparXml('<script>'), '&lt;script&gt;')
  assert.equal(escaparXml(null), '')
})

/**
 * Escapar de más rompe la firma: nosotros digerimos el texto tal como lo
 * escribimos y el SRI lo digiere ya canonicalizado, donde la comilla es una
 * comilla. El comprobante vuelve con "FIRMA INVALIDA" y el secuencial ya se
 * gastó.
 */
test('la comilla queda literal en el texto de un elemento', () => {
  assert.equal(escaparXml('dice "hola"'), 'dice "hola"')
  assert.equal(escaparXml("l'apostrofe"), "l'apostrofe")
})

test('en un atributo la comilla sí se escapa, pero no el >', () => {
  assert.equal(escaparAtributo('dice "hola"'), 'dice &quot;hola&quot;')
  assert.equal(escaparAtributo('a > b'), 'a > b')
  assert.equal(escaparAtributo('A & B'), 'A &amp; B')
})

test('el texto con comillas del período no se escapa al armar el XML', () => {
  const xml = generarXmlFactura({
    emisor: EMISOR,
    factura: {
      ...FACTURA,
      infoAdicional: [{ nombre: 'Descripción', valor: 'Reclamos: "ingrese al link"' }],
    },
    detalles: UN_DETALLE,
  })

  assert.ok(xml.includes('>Reclamos: "ingrese al link"<'))
  assert.ok(!xml.includes('&quot;'))
})

test('una razón social con & no invalida el XML', () => {
  const xml = generarXmlFactura({ emisor: EMISOR, factura: FACTURA, detalles: UN_DETALLE })
  assert.ok(xml.includes('FIBRA &amp; REDES S.A.'))
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'quedó un & sin escapar')
})

test('los acentos y la Ñ se conservan', () => {
  const xml = generarXmlFactura({
    emisor: EMISOR,
    factura: { ...FACTURA, razonSocialComprador: 'OÑA RIERA JOSÉ LUIS' },
    detalles: UN_DETALLE,
  })
  assert.ok(xml.includes('OÑA RIERA JOSÉ LUIS'))
})

// --- Estructura -------------------------------------------------------------

test('el XML tiene los tres bloques que exige el esquema', () => {
  const xml = generarXmlFactura({ emisor: EMISOR, factura: FACTURA, detalles: UN_DETALLE })

  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
  assert.ok(xml.includes('<factura id="comprobante" version="1.1.0">'))
  assert.ok(xml.includes('<infoTributaria>'))
  assert.ok(xml.includes('<infoFactura>'))
  assert.ok(xml.includes('<detalles>'))
  assert.ok(xml.endsWith('</factura>'))
})

test('la clave de acceso del XML es la que se generó', () => {
  const xml = generarXmlFactura({ emisor: EMISOR, factura: FACTURA, detalles: UN_DETALLE })
  assert.ok(xml.includes(`<claveAcceso>${claveAcceso}</claveAcceso>`))
  assert.ok(xml.includes('<codDoc>01</codDoc>'))
})

test('el secuencial se rellena a 9 dígitos', () => {
  const xml = generarXmlFactura({
    emisor: EMISOR,
    factura: { ...FACTURA, secuencial: 42 },
    detalles: UN_DETALLE,
  })
  assert.ok(xml.includes('<secuencial>000000042</secuencial>'))
})

test('obligadoContabilidad se emite como SI o NO', () => {
  const conta = generarXmlFactura({ emisor: EMISOR, factura: FACTURA, detalles: UN_DETALLE })
  assert.ok(conta.includes('<obligadoContabilidad>SI</obligadoContabilidad>'))

  const sinConta = generarXmlFactura({
    emisor: { ...EMISOR, obligado_contabilidad: false },
    factura: FACTURA,
    detalles: UN_DETALLE,
  })
  assert.ok(sinConta.includes('<obligadoContabilidad>NO</obligadoContabilidad>'))
})

test('los campos opcionales vacíos no se emiten', () => {
  const xml = generarXmlFactura({
    emisor: { ...EMISOR, nombre_comercial: null, contribuyente_especial: null },
    factura: { ...FACTURA, direccionComprador: null },
    detalles: UN_DETALLE,
  })
  assert.ok(!xml.includes('<nombreComercial>'))
  assert.ok(!xml.includes('<contribuyenteEspecial>'))
  assert.ok(!xml.includes('<direccionComprador>'))
})

test('el correo del comprador viaja en infoAdicional', () => {
  const xml = generarXmlFactura({ emisor: EMISOR, factura: FACTURA, detalles: UN_DETALLE })
  assert.ok(xml.includes('<campoAdicional nombre="email">cliente@ejemplo.com</campoAdicional>'))
})

test('los campos del período se agregan a los que ya van', () => {
  const xml = generarXmlFactura({
    emisor: EMISOR,
    factura: { ...FACTURA, infoAdicional: [{ nombre: 'Descripción', valor: 'Periodo del 1/Jul./2026' }] },
    detalles: UN_DETALLE,
  })

  assert.ok(
    xml.includes('<campoAdicional nombre="Descripción">Periodo del 1/Jul./2026</campoAdicional>'),
  )
  assert.ok(xml.includes('nombre="email"'), 'el correo sigue viajando')
})

test('un campo adicional de más de 300 caracteres se detecta antes de enviarlo', () => {
  // El SRI devuelve el comprobante entero por esto, y el secuencial ya se gastó.
  assert.throws(
    () =>
      generarXmlFactura({
        emisor: EMISOR,
        factura: { ...FACTURA, infoAdicional: [{ nombre: 'Descripción', valor: 'x'.repeat(301) }] },
        detalles: UN_DETALLE,
      }),
    /300/,
  )
})

test('los totales del XML coinciden con el cálculo', () => {
  const xml = generarXmlFactura({ emisor: EMISOR, factura: FACTURA, detalles: UN_DETALLE })
  assert.ok(xml.includes('<totalSinImpuestos>25.00</totalSinImpuestos>'))
  assert.ok(xml.includes('<importeTotal>28.75</importeTotal>'))
  // El total del pago tiene que ser igual al importe total.
  assert.ok(xml.includes('<pago><formaPago>01</formaPago><total>28.75</total></pago>'))
})

// --- Validaciones -----------------------------------------------------------

test('falla si falta algo que el SRI exige', () => {
  const casos = [
    [{ ...EMISOR, ruc: null }, FACTURA, /RUC del emisor/],
    [{ ...EMISOR, razon_social: null }, FACTURA, /razón social del emisor/],
    [EMISOR, { ...FACTURA, claveAcceso: null }, /clave de acceso/],
    [EMISOR, { ...FACTURA, identificacionComprador: '' }, /identificación del comprador/],
  ]

  for (const [emisor, factura, patron] of casos) {
    assert.throws(() => generarXmlFactura({ emisor, factura, detalles: UN_DETALLE }), patron)
  }
})

test('una factura sin detalles se rechaza', () => {
  assert.throws(
    () => generarXmlFactura({ emisor: EMISOR, factura: FACTURA, detalles: [] }),
    /al menos un detalle/,
  )
})
