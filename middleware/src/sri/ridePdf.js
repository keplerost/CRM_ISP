/**
 * RIDE — Representación Impresa del Documento Electrónico.
 *
 * Es lo único del comprobante que el abonado realmente mira: el XML es para el
 * SRI, el PDF es para el cliente. Por eso replica el formato al que están
 * acostumbrados —el mismo bloque de emisor arriba a la izquierda, la
 * autorización a la derecha, el detalle y los totales abajo—, y no una versión
 * "mejorada" que obligue a explicar dónde quedó cada dato.
 *
 * Dos decisiones que vale la pena conocer:
 *
 * 1. Los datos salen del comprobante guardado, no de un cálculo nuevo. Un RIDE
 *    que dijera algo distinto del XML autorizado es un problema tributario, no
 *    una diferencia de presentación.
 * 2. Un comprobante que todavía no está autorizado se imprime igual, pero con
 *    la marca de que no tiene validez. Ocultarlo sería peor: alguien lo cobra
 *    creyendo que está bien emitido.
 */

import PDFDocument from 'pdfkit'
import { dibujarCode128 } from './code128.js'

const MARGEN = 28
const ANCHO = 595.28 - MARGEN * 2

const GRIS = '#666666'
const BORDE = '#999999'
const NEGRO = '#111111'

const REGULAR = 'Helvetica'
const NEGRITA = 'Helvetica-Bold'

/** Etiquetas de las formas de pago del SRI, para no imprimir el código pelado. */
export const FORMAS_PAGO = {
  '01': 'Sin utilización del Sistema Financiero',
  '15': 'Compensación de deudas',
  '16': 'Tarjeta de débito',
  '17': 'Dinero electrónico',
  '18': 'Tarjeta prepago',
  '19': 'Tarjeta de crédito',
  '20': 'Otros con utilización del sistema financiero',
  '21': 'Endoso de títulos',
}

const dinero = (n) => `$${(Number(n) || 0).toFixed(2)}`

/** Los códigos de porcentaje del SRI, con el nombre que va en los subtotales. */
const SUBTOTALES = [
  { codigo: '4', label: 'Subtotal 15%' },
  { codigo: '5', label: 'Subtotal 5%' },
  { codigo: '0', label: 'Subtotal 0%' },
  { codigo: '6', label: 'Subtotal No Objeto IVA' },
  { codigo: '7', label: 'Subtotal Exento IVA' },
]

/** dd/mm/aaaa a partir de un DATE de Postgres o un Date. */
function fechaDdMmAaaa(valor) {
  if (!valor) return ''
  const s = String(valor)
  const iso = s.slice(0, 10)
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [a, m, d] = iso.split('-')
    return `${d}/${m}/${a}`
  }
  return s
}

/** dd/mm/aaaa hh:mm:ss para la fecha de autorización. */
function fechaHora(valor) {
  if (!valor) return ''
  const d = new Date(valor)
  if (Number.isNaN(d.getTime())) return String(valor)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const numeroComprobante = (doc) =>
  `${doc.establecimiento ?? '001'}-${doc.punto_emision ?? '001'}-${String(doc.secuencial ?? '').padStart(9, '0')}`

/**
 * Suma por código de porcentaje de IVA.
 * Se recalcula desde los ítems porque el comprobante guarda el total del IVA,
 * no su desglose por tarifa — y el RIDE lo muestra fila por fila.
 */
function desglose(items = []) {
  const bases = new Map()
  const ivas = new Map()
  for (const it of items) {
    const c = String(it.codigo_porcentaje ?? '4')
    bases.set(c, (bases.get(c) ?? 0) + Number(it.base_imponible_iva ?? 0))
    ivas.set(c, (ivas.get(c) ?? 0) + Number(it.valor_iva ?? 0))
  }
  return { bases, ivas }
}

// --- Primitivas de dibujo ---------------------------------------------------

function caja(doc, x, y, w, h) {
  doc.roundedRect(x, y, w, h, 3).lineWidth(0.7).strokeColor(BORDE).stroke()
}

/** "Etiqueta: valor" en una línea, con la etiqueta en negrita. */
function campo(doc, x, y, w, etiqueta, valor, { tam = 7.5 } = {}) {
  doc.fontSize(tam).font(NEGRITA).fillColor(NEGRO)
  const anchoEtiqueta = doc.widthOfString(`${etiqueta} `)
  doc.text(etiqueta, x, y, { width: w, lineBreak: false })
  doc.font(REGULAR).fillColor(NEGRO)
  const alto = doc.heightOfString(String(valor ?? ''), { width: w - anchoEtiqueta })
  doc.text(String(valor ?? ''), x + anchoEtiqueta, y, { width: w - anchoEtiqueta })
  return Math.max(alto, tam + 2.5)
}

/** Bloque "etiqueta arriba, valor abajo" — para la clave de acceso y la autorización. */
function bloque(doc, x, y, w, etiqueta, valor, { tam = 7.5, fuenteValor = REGULAR } = {}) {
  doc.fontSize(tam).font(NEGRITA).fillColor(NEGRO).text(etiqueta, x, y, { width: w })
  const y2 = y + tam + 2
  doc.font(fuenteValor).fillColor(NEGRO).text(String(valor ?? ''), x, y2, { width: w })
  return doc.y - y + 1
}

/** Fila de una tabla: celdas alineadas según su columna. */
function fila(doc, x, y, columnas, valores, { fuente = REGULAR, tam = 7, color = NEGRO } = {}) {
  doc.fontSize(tam).font(fuente).fillColor(color)
  let cursor = x
  let alto = 0
  columnas.forEach((col, i) => {
    const texto = String(valores[i] ?? '')
    const w = col.ancho - 6
    alto = Math.max(alto, doc.heightOfString(texto, { width: w }))
    doc.text(texto, cursor + 3, y, { width: w, align: col.align ?? 'left' })
    cursor += col.ancho
  })
  return alto
}

// --- Secciones --------------------------------------------------------------

function cabecera(doc, { emisor, documento, logo, y }) {
  const anchoIzq = 246
  const anchoDer = ANCHO - anchoIzq - 8
  const xDer = MARGEN + anchoIzq + 8
  const alto = 158

  caja(doc, MARGEN, y, anchoIzq, alto)
  caja(doc, xDer, y, anchoDer, alto)

  // --- Emisor
  let cursor = y + 8
  const xi = MARGEN + 8
  const wi = anchoIzq - 16

  if (logo) {
    try {
      doc.image(logo, xi, cursor, { fit: [wi, 46], align: 'center' })
      cursor += 52
    } catch {
      // Un logo ilegible no puede impedir que salga la factura.
    }
  }

  doc.fontSize(9).font(NEGRITA).fillColor(NEGRO)
  doc.text(emisor.razon_social ?? '', xi, cursor, { width: wi })
  cursor = doc.y + 2

  if (emisor.nombre_comercial) {
    doc.fontSize(8).font(REGULAR).fillColor(GRIS).text(emisor.nombre_comercial, xi, cursor, { width: wi })
    cursor = doc.y + 2
  }

  cursor += 2
  cursor += campo(doc, xi, cursor, wi, 'RUC:', emisor.ruc) + 1
  cursor += campo(doc, xi, cursor, wi, 'Matriz:', emisor.dir_matriz) + 1
  if (emisor.dir_establecimiento) {
    cursor += campo(doc, xi, cursor, wi, 'Sucursal:', emisor.dir_establecimiento) + 1
  }
  if (emisor.email) cursor += campo(doc, xi, cursor, wi, 'Correo:', emisor.email) + 1
  if (emisor.telefono) cursor += campo(doc, xi, cursor, wi, 'Teléfono:', emisor.telefono) + 1
  cursor += campo(
    doc,
    xi,
    cursor,
    wi,
    'Obligado a llevar contabilidad:',
    emisor.obligado_contabilidad ? 'SI' : 'NO',
  )
  if (emisor.contribuyente_especial) {
    cursor += 1
    campo(doc, xi, cursor, wi, 'Contribuyente especial Nro:', emisor.contribuyente_especial)
  }

  // --- Autorización
  let cd = y + 8
  const xd = xDer + 8
  const wd = anchoDer - 16

  doc.fontSize(13).font(NEGRITA).fillColor(NEGRO).text('FACTURA', xd, cd, { width: wd })
  cd = doc.y + 1
  doc.fontSize(9).font(NEGRITA).text(`No. ${numeroComprobante(documento)}`, xd, cd, { width: wd })
  cd = doc.y + 5

  const autorizado = documento.estado === 'AUTORIZADO'

  cd += bloque(
    doc,
    xd,
    cd,
    wd,
    'Número de Autorización:',
    autorizado ? documento.numero_autorizacion || documento.clave_acceso : 'PENDIENTE DE AUTORIZACIÓN',
    { fuenteValor: 'Courier' },
  )

  cd += bloque(
    doc,
    xd,
    cd,
    wd,
    'Fecha y hora de Autorización:',
    autorizado ? fechaHora(documento.fecha_autorizacion) : '—',
  )

  doc.fontSize(7.5).font(NEGRITA).fillColor(NEGRO)
  doc.text('Ambiente:', xd, cd, { width: wd / 2, lineBreak: false })
  doc.font(REGULAR).text(documento.ambiente === '2' ? 'PRODUCCIÓN' : 'PRUEBAS', xd + 45, cd, {
    width: wd / 2,
    lineBreak: false,
  })
  doc.font(NEGRITA).text('Emisión:', xd + wd / 2 + 10, cd, { lineBreak: false })
  doc.font(REGULAR).text('NORMAL', xd + wd / 2 + 50, cd, { lineBreak: false })
  cd += 12

  cd += bloque(doc, xd, cd, wd, 'Clave de Acceso:', documento.clave_acceso, { fuenteValor: 'Courier' })

  // El código de barras es lo que permite verificar el comprobante sin tipear
  // 49 dígitos a mano.
  const altoBarras = Math.min(28, y + alto - cd - 6)
  if (documento.clave_acceso && altoBarras > 10) {
    dibujarCode128(doc, documento.clave_acceso, { x: xd, y: cd + 2, ancho: wd, alto: altoBarras })
  }

  return y + alto + 8
}

function comprador(doc, { documento, telefono, y }) {
  const alto = 58
  caja(doc, MARGEN, y, ANCHO, alto)

  const x1 = MARGEN + 8
  const w1 = ANCHO * 0.6 - 16
  const x2 = MARGEN + ANCHO * 0.6
  const w2 = ANCHO * 0.4 - 16

  let a = y + 8
  a += campo(doc, x1, a, w1, 'Razón Social / Nombres y Apellidos:', documento.razon_social_comprador) + 2
  a += campo(doc, x1, a, w1, 'RUC / CI:', documento.identificacion_comprador) + 2
  campo(doc, x1, a, w1, 'Dirección:', documento.direccion_comprador || '—')

  let b = y + 8
  b += campo(doc, x2, b, w2, 'Fecha Emisión:', fechaDdMmAaaa(documento.fecha_emision)) + 2
  b += campo(doc, x2, b, w2, 'Teléfono:', telefono || '—') + 2
  campo(doc, x2, b, w2, 'Correo:', documento.email_comprador || '—')

  return y + alto + 8
}

const COLUMNAS_DETALLE = [
  { titulo: 'Cód.\nPrincipal', ancho: 58 },
  { titulo: 'Cantidad', ancho: 46, align: 'right' },
  { titulo: 'Descripción', ancho: 196 },
  { titulo: 'Detalle\nadicional', ancho: 84 },
  { titulo: 'Precio\nUnitario', ancho: 52, align: 'right' },
  { titulo: 'Descuento', ancho: 50, align: 'right' },
  { titulo: 'Precio Total', ancho: 53.28, align: 'right' },
]

function detalle(doc, { items, y }) {
  const altoCabecera = 20
  doc.rect(MARGEN, y, ANCHO, altoCabecera).fillColor('#eeeeee').fill()
  caja(doc, MARGEN, y, ANCHO, altoCabecera)

  fila(
    doc,
    MARGEN,
    y + 4,
    COLUMNAS_DETALLE,
    COLUMNAS_DETALLE.map((c) => c.titulo.replace('\n', ' ')),
    { fuente: NEGRITA, tam: 6.5 },
  )

  let cursor = y + altoCabecera
  for (const it of items) {
    const alto =
      fila(doc, MARGEN, cursor + 4, COLUMNAS_DETALLE, [
        it.codigo_principal ?? '',
        Number(it.cantidad ?? 0).toFixed(2),
        it.descripcion ?? '',
        it.codigo_auxiliar ?? '',
        Number(it.precio_unitario ?? 0).toFixed(2),
        dinero(it.descuento),
        dinero(it.precio_total_sin_impuesto),
      ]) + 8

    caja(doc, MARGEN, cursor, ANCHO, alto)
    // Las líneas verticales separan las columnas dentro de la fila.
    let x = MARGEN
    for (const col of COLUMNAS_DETALLE.slice(0, -1)) {
      x += col.ancho
      doc.moveTo(x, cursor).lineTo(x, cursor + alto).lineWidth(0.4).strokeColor(BORDE).stroke()
    }
    cursor += alto
  }

  return cursor + 8
}

/**
 * Campos que van en el XML pero no en la hoja impresa.
 *
 * El correo viaja en el comprobante porque es donde lo busca quien lo recibe, y
 * la dirección y el teléfono del comprador ya están arriba, en su bloque. En
 * "Información Adicional" solo corresponde el período facturado.
 */
const CAMPOS_TECNICOS = /^\s*(e-?mail|correo|direcci[oó]n|tel[eé]fono|celular)\s*\d*\s*$/i

/**
 * Reúne los campos que viajan partidos.
 *
 * El SRI no admite más de 300 caracteres por campo, así que un texto largo sale
 * del XML como "Descripción", "Descripción 2"… Eso es una limitación del
 * formato, no algo que el abonado tenga que leer: en la hoja se vuelven a unir
 * bajo una sola etiqueta y el texto queda corrido.
 */
export function unirCampos(campos = []) {
  const orden = []
  const partes = new Map()

  for (const c of campos) {
    const base = String(c.nombre ?? '').replace(/\s*\d+\s*$/, '').trim()
    if (!partes.has(base)) {
      partes.set(base, [])
      orden.push(base)
    }
    partes.get(base).push(String(c.valor ?? '').trim())
  }

  return orden
    .map((nombre) => ({ nombre, valor: partes.get(nombre).filter(Boolean).join(' ') }))
    .filter((c) => c.valor)
}

function informacionAdicional(doc, { campos: todos, formaPago, total, x, y, ancho }) {
  const campos = unirCampos(todos.filter((c) => !CAMPOS_TECNICOS.test(c.nombre)))
  let cursor = y

  if (campos.length) {
    doc.fontSize(7.5).font(NEGRITA).fillColor(NEGRO).text('Información Adicional', x + 6, cursor + 6, {
      width: ancho - 12,
    })
    let interno = doc.y + 3

    for (const c of campos) {
      doc.fontSize(6.8).font(NEGRITA).fillColor(NEGRO).text(`${c.nombre}:`, x + 6, interno, {
        width: ancho - 12,
      })
      // Sin justificar: pdfkit reparte el espacio sobrante moviendo cada
      // palabra por separado y el texto copiado del PDF sale sin espacios.
      doc.font(REGULAR).text(c.valor, x + 6, doc.y, { width: ancho - 12 })
      interno = doc.y + 3
    }

    caja(doc, x, cursor, ancho, interno - cursor + 3)
    cursor = interno + 9
  }

  // --- Formas de pago
  const columnas = [
    { titulo: 'Forma de pago', ancho: ancho - 130 },
    { titulo: 'Valor', ancho: 65, align: 'right' },
    { titulo: 'Plazo', ancho: 65, align: 'right' },
  ]

  doc.rect(x, cursor, ancho, 16).fillColor('#eeeeee').fill()
  caja(doc, x, cursor, ancho, 16)
  fila(doc, x, cursor + 4, columnas, columnas.map((c) => c.titulo), { fuente: NEGRITA, tam: 6.5 })

  const altoFila =
    fila(doc, x, cursor + 20, columnas, [
      FORMAS_PAGO[formaPago] ?? `Forma de pago ${formaPago}`,
      dinero(total),
      '0 días',
    ]) + 8

  caja(doc, x, cursor + 16, ancho, altoFila)

  return cursor + 16 + altoFila
}

function totales(doc, { documento, items, x, y, ancho }) {
  const { bases, ivas } = desglose(items)

  const filas = [['Subtotal Sin Impuestos', documento.total_sin_impuestos]]

  for (const s of SUBTOTALES) {
    const base = bases.get(s.codigo) ?? 0
    // Las tarifas vigentes salen siempre, aunque estén en cero: es lo que se
    // espera ver en una factura. Las que ya no se usan solo si tienen valor.
    if (base || ['4', '5', '0'].includes(s.codigo)) filas.push([s.label, base])
  }

  filas.push(
    ['Descuento', documento.total_descuento],
    ['ICE', 0],
    ['IVA 15%', ivas.get('4') ?? 0],
    ['IVA 5%', ivas.get('5') ?? 0],
    ['Propina', documento.propina ?? 0],
  )

  const altoFila = 12.5
  const alto = filas.length * altoFila + 20

  caja(doc, x, y, ancho, alto)

  let cursor = y + 6
  for (const [label, valor] of filas) {
    doc.fontSize(7).font(REGULAR).fillColor(NEGRO)
    doc.text(label, x + 6, cursor, { width: ancho - 90, lineBreak: false })
    doc.text(dinero(valor), x + ancho - 84, cursor, { width: 78, align: 'right' })
    cursor += altoFila
  }

  // El total va destacado: es el número que se busca primero.
  doc.rect(x, cursor - 2, ancho, 20).fillColor('#eeeeee').fill()
  caja(doc, x, cursor - 2, ancho, 20)
  doc.fontSize(8.5).font(NEGRITA).fillColor(NEGRO)
  doc.text('VALOR TOTAL', x + 6, cursor + 4, { width: ancho - 90, lineBreak: false })
  doc.text(dinero(documento.importe_total), x + ancho - 84, cursor + 4, { width: 78, align: 'right' })

  return cursor + 18 + 8
}

/** Aviso de que el comprobante todavía no vale como tal. */
function marcaSinValidez(doc, documento) {
  if (documento.estado === 'AUTORIZADO') return

  doc.save()
  doc.rotate(-30, { origin: [297, 420] })
  doc.fontSize(38).font(NEGRITA).fillColor('#dc2626').opacity(0.14)
  doc.text('SIN VALIDEZ TRIBUTARIA', 40, 400, { width: 520, align: 'center' })
  doc.restore()
  doc.opacity(1)
}

function pie(doc, documento) {
  const y = 841.89 - MARGEN - 22
  doc.fontSize(6.5).font(REGULAR).fillColor(GRIS)
  doc.text(
    documento.estado === 'AUTORIZADO'
      ? 'Documento generado electrónicamente. Su validez se verifica en el portal del SRI con la clave de acceso.'
      : `Comprobante en estado ${documento.estado}: todavía no fue autorizado por el SRI y no tiene validez tributaria.`,
    MARGEN,
    y,
    { width: ANCHO, align: 'center' },
  )
}

/**
 * Arma el RIDE completo.
 *
 * @param emisor      fila de `sri_config`
 * @param documento   fila de `electronic_documents`
 * @param items       filas de `document_items`, en orden
 * @param campos      campos adicionales del comprobante ([{nombre, valor}])
 * @param logo        Buffer con el logo del emisor (opcional)
 * @param telefono    teléfono del comprador, de su ficha (no viaja en el XML)
 * @returns {Promise<Buffer>} el PDF
 */
export function generarRidePdf({
  emisor = {},
  documento,
  items = [],
  campos = [],
  logo = null,
  telefono = null,
}) {
  if (!documento?.clave_acceso) {
    throw new Error('El comprobante no tiene clave de acceso: no se puede imprimir el RIDE')
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGEN,
      info: {
        Title: `Factura ${numeroComprobante(documento)}`,
        Author: emisor.razon_social ?? '',
        Subject: `RIDE ${documento.clave_acceso}`,
      },
    })

    const trozos = []
    doc.on('data', (t) => trozos.push(t))
    doc.on('end', () => resolve(Buffer.concat(trozos)))
    doc.on('error', reject)

    try {
      let y = MARGEN
      y = cabecera(doc, { emisor, documento, logo, y })
      y = comprador(doc, { documento, telefono, y })
      y = detalle(doc, { items, y })

      const anchoTotales = 200
      const anchoIzq = ANCHO - anchoTotales - 8

      const finIzq = informacionAdicional(doc, {
        campos,
        formaPago: documento.forma_pago ?? '01',
        total: documento.importe_total,
        x: MARGEN,
        y,
        ancho: anchoIzq,
      })

      const finDer = totales(doc, {
        documento,
        items,
        x: MARGEN + anchoIzq + 8,
        y,
        ancho: anchoTotales,
      })

      doc.y = Math.max(finIzq, finDer)

      marcaSinValidez(doc, documento)
      pie(doc, documento)
    } catch (err) {
      doc.end()
      return reject(err)
    }

    doc.end()
  })
}
