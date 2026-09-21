import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { code128 } from '../src/sri/code128.js'
import { generarRidePdf, unirCampos } from '../src/sri/ridePdf.js'
import { leerCamposAdicionales, generarXmlFactura } from '../src/sri/facturaXml.js'

/**
 * El RIDE es lo único del comprobante que ve el abonado. Un PDF que no abre, o
 * que dice un total distinto del XML, se descubre cuando el cliente reclama —
 * y para entonces ya se emitió el mes entero.
 */

// --- Código de barras -------------------------------------------------------

test('el checksum del Code 128 pesa cada símbolo por su posición', () => {
  // "ABC" en el juego B: inicio 104, valores 33, 34 y 35.
  // (104 + 33*1 + 34*2 + 35*3) mod 103 = 1  →  patrón '222122'.
  const { barras } = code128('ABC')
  const patrones = []
  for (let i = 0; i < barras.length; i += 6) patrones.push(barras.slice(i, i + 6).join(''))

  assert.equal(patrones[0], '211214', 'arranca con el símbolo de inicio B')
  assert.equal(patrones[4], '222122', 'el checksum es el símbolo 1')
})

test('los 49 dígitos de la clave se codifican en el juego C', () => {
  const clave = '2607202601125057992500120010020000008271619987719'
  assert.equal(clave.length, 49)

  const { barras, modulos } = code128(clave)

  // 28 símbolos: inicio + 1 dígito suelto + cambio a C + 24 pares + checksum,
  // más los 13 módulos del terminador.
  assert.equal(modulos, 28 * 11 + 13)

  // En el juego B harían falta 51 símbolos: el código sale casi el doble de
  // ancho y a esa densidad los lectores empiezan a fallar.
  assert.ok(modulos < 51 * 11)
  assert.ok(barras.every((n) => n >= 1 && n <= 4))
})

test('un código sin contenido es un error, no un dibujo vacío', () => {
  assert.throws(() => code128(''), /código de barras/)
})

// --- Campos adicionales -----------------------------------------------------

test('los campos adicionales se releen tal como se emitieron', () => {
  const xml = generarXmlFactura({
    emisor: { ruc: '1250579925001', razon_social: 'OÑA RIERA & HIJOS', dir_matriz: 'LA MANÁ' },
    factura: {
      claveAcceso: '1'.repeat(49),
      secuencial: 827,
      fechaEmision: '26/07/2026',
      tipoIdentificacionComprador: '05',
      razonSocialComprador: 'ANIBAL SHIGUI',
      identificacionComprador: '1250717665',
      infoAdicional: [{ nombre: 'Descripción', valor: 'Periodo del 1/Jul./2026 al 31/Jul./2026' }],
    },
    detalles: [{ descripcion: 'PLAN HOME 150 Mbps', cantidad: 1, precioUnitario: 20.09, tarifaIva: 15 }],
  })

  const campos = leerCamposAdicionales(xml)
  const descripcion = campos.find((c) => c.nombre === 'Descripción')

  assert.equal(descripcion.valor, 'Periodo del 1/Jul./2026 al 31/Jul./2026')
})

test('un XML sin campos adicionales devuelve una lista vacía, no explota', () => {
  assert.deepEqual(leerCamposAdicionales(null), [])
  assert.deepEqual(leerCamposAdicionales('<factura></factura>'), [])
})

// --- El PDF -----------------------------------------------------------------

const EMISOR = {
  ruc: '1250579925001',
  razon_social: 'OÑA RIERA JEFFERSON FABIAN',
  nombre_comercial: 'HOMELINK NET',
  dir_matriz: 'COTOPAXI / LA MANA / AV. 19 DE MAYO S/N Y EUGENIO ESPEJO',
  telefono: '0986017616',
  obligado_contabilidad: false,
}

const DOCUMENTO = {
  id: 'x',
  establecimiento: '001',
  punto_emision: '002',
  secuencial: '000000827',
  clave_acceso: '2607202601125057992500120010020000008271619987719',
  numero_autorizacion: '2607202601125057992500120010020000008271619987719',
  fecha_autorizacion: '2026-07-26T11:57:59-05:00',
  fecha_emision: '2026-07-26',
  ambiente: '2',
  estado: 'AUTORIZADO',
  razon_social_comprador: 'ANIBAL PATRICIO SHIGUI UNSUÑO',
  identificacion_comprador: '1250717665',
  direccion_comprador: 'PUCAYACU CHICO',
  email_comprador: 'homelinknetor@gmail.com',
  total_sin_impuestos: 19.3,
  total_descuento: 0.79,
  total_iva: 2.9,
  importe_total: 22.2,
  forma_pago: '01',
}

const ITEMS = [
  {
    orden: 1,
    codigo_principal: '1016',
    descripcion: 'PLAN HOME 150 Mbps',
    cantidad: 1,
    precio_unitario: 20.09,
    descuento: 0.79,
    precio_total_sin_impuesto: 19.3,
    codigo_porcentaje: '4',
    tarifa_iva: 15,
    base_imponible_iva: 19.3,
    valor_iva: 2.9,
  },
]

/**
 * Texto de los streams del PDF, para poder afirmar sobre lo que se imprimió.
 * pdfkit escribe las cadenas en hexadecimal —`[<46414354555241>] TJ`—, así que
 * hay que decodificarlas para poder buscar palabras.
 */
function textoDelPdf(pdf) {
  const s = pdf.toString('latin1')
  const partes = []
  const re = /stream\r?\n/g
  let m
  while ((m = re.exec(s))) {
    const inicio = m.index + m[0].length
    const fin = s.indexOf('endstream', inicio)
    if (fin < 0) break
    try {
      partes.push(zlib.inflateSync(pdf.subarray(inicio, fin)).toString('latin1'))
    } catch {
      partes.push(s.slice(inicio, fin))
    }
  }

  // Cada `[<...> 80 <...>] TJ` es una línea: los números son el kerning entre
  // trozos y hay que descartarlos para volver a tener la palabra entera.
  const lineas = []
  const arreglos = /\[((?:[^\]\\]|\\.)*)\]\s*TJ/g
  let a
  const contenido = partes.join('\n')
  while ((a = arreglos.exec(contenido))) {
    const trozos = a[1].match(/<[0-9a-fA-F]*>/g) ?? []
    lineas.push(trozos.map((h) => Buffer.from(h.slice(1, -1), 'hex').toString('latin1')).join(''))
  }
  return lineas.join('\n')
}

test('el RIDE es un PDF válido y lleva los datos del comprobante', async () => {
  const pdf = await generarRidePdf({ emisor: EMISOR, documento: DOCUMENTO, items: ITEMS })

  assert.ok(Buffer.isBuffer(pdf))
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  assert.ok(pdf.includes(Buffer.from('%%EOF')), 'el PDF está completo')

  const texto = textoDelPdf(pdf)
  assert.match(texto, /FACTURA/)
  assert.match(texto, /001-002-000000827/)
  assert.match(texto, /1250579925001/)
  assert.match(texto, /PLAN HOME 150 Mbps/)
  assert.match(texto, /22\.20/, 'el valor total')
  assert.match(texto, /2607202601125057992500120010020000008271619987719/)
})

test('un comprobante sin autorizar sale marcado', async () => {
  const borrador = { ...DOCUMENTO, estado: 'BORRADOR', numero_autorizacion: null, fecha_autorizacion: null }
  const texto = textoDelPdf(await generarRidePdf({ emisor: EMISOR, documento: borrador, items: ITEMS }))

  assert.match(texto, /SIN VALIDEZ TRIBUTARIA/)
  assert.match(texto, /PENDIENTE DE AUTORIZACI/)
})

test('el texto partido se imprime como uno solo, sin la numeración del XML', async () => {
  // El SRI obliga a partir en campos de 300 caracteres; el abonado no tiene por
  // qué ver "Descripción 2" ni un corte en medio del párrafo.
  const campos = [
    { nombre: 'Descripción', valor: 'Periodo del 1/Jul./2026 al 31/Jul./2026.' },
    { nombre: 'Descripción 2', valor: 'Fecha maxima de pago: 5 de Julio de 2026.' },
  ]

  assert.deepEqual(unirCampos(campos), [
    {
      nombre: 'Descripción',
      valor: 'Periodo del 1/Jul./2026 al 31/Jul./2026. Fecha maxima de pago: 5 de Julio de 2026.',
    },
  ])

  const texto = textoDelPdf(
    await generarRidePdf({ emisor: EMISOR, documento: DOCUMENTO, items: ITEMS, campos }),
  )

  assert.match(texto, /Fecha maxima de pago/)
  assert.doesNotMatch(texto, /Descripción 2/)
})

test('el correo y la dirección van en el XML pero no en la hoja', async () => {
  const texto = textoDelPdf(
    await generarRidePdf({
      emisor: EMISOR,
      documento: DOCUMENTO,
      items: ITEMS,
      campos: [
        { nombre: 'email', valor: 'cliente@ejemplo.com' },
        { nombre: 'Descripción', valor: 'Periodo del 1/Jul./2026' },
      ],
    }),
  )

  // El correo se imprime en el bloque del comprador, no en Información Adicional.
  assert.doesNotMatch(texto, /^email/m)
  assert.match(texto, /Periodo del 1\/Jul\.\/2026/)
})

test('el bloque del comprador dice RUC / CI y trae el teléfono', async () => {
  const texto = textoDelPdf(
    await generarRidePdf({
      emisor: EMISOR,
      documento: DOCUMENTO,
      items: ITEMS,
      telefono: '0968686247',
    }),
  )

  assert.match(texto, /RUC \/ CI:/)
  assert.match(texto, /0968686247/)
  assert.doesNotMatch(texto, /Gu.a de Remisi/, 'la guía de remisión no va en una factura de servicio')
})

test('el RIDE imprime los campos adicionales del comprobante', async () => {
  const pdf = await generarRidePdf({
    emisor: EMISOR,
    documento: DOCUMENTO,
    items: ITEMS,
    campos: [{ nombre: 'Descripción', valor: 'Periodo del 1/Jul./2026 al 31/Jul./2026.' }],
  })

  assert.match(textoDelPdf(pdf), /Periodo del 1\/Jul\.\/2026/)
})

test('un logo ilegible no impide emitir el RIDE', async () => {
  const pdf = await generarRidePdf({
    emisor: EMISOR,
    documento: DOCUMENTO,
    items: ITEMS,
    logo: Buffer.from('esto no es una imagen'),
  })

  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
})

test('sin clave de acceso no hay RIDE que imprimir', () => {
  assert.throws(
    () => generarRidePdf({ emisor: EMISOR, documento: { ...DOCUMENTO, clave_acceso: null }, items: ITEMS }),
    /clave de acceso/,
  )
})
