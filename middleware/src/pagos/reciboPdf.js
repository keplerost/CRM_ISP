/**
 * Recibo de cobro.
 *
 * No es un comprobante tributario —eso es la factura, que la autoriza el SRI—:
 * es la constancia de que el abonado entregó la plata. Se imprime en el
 * momento, muchas veces antes de que la factura del mes exista, así que no
 * depende de que haya comprobante asociado.
 *
 * Va en media hoja A4: entra en una impresora común, se corta al medio y queda
 * una copia para el cliente y otra para la caja.
 */

import PDFDocument from 'pdfkit'

const MARGEN = 32
const ANCHO_PAGINA = 595.28
const ANCHO = ANCHO_PAGINA - MARGEN * 2
/** Media A4: la hoja se corta por la mitad y salen las dos copias. */
const ALTO_RECIBO = 841.89 / 2

const GRIS = '#666666'
const BORDE = '#999999'
const NEGRO = '#111111'

const REGULAR = 'Helvetica'
const NEGRITA = 'Helvetica-Bold'

export const FORMAS_PAGO = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia',
  deposito: 'Depósito',
  tarjeta: 'Tarjeta',
  otro: 'Otro',
}

const dinero = (n) => `$${(Number(n) || 0).toFixed(2)}`

function fechaLegible(valor) {
  const iso = String(valor ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return String(valor ?? '')
  const [a, m, d] = iso.split('-')
  return `${d}/${m}/${a}`
}

const UNIDADES = [
  '', 'un', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
  'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve',
]
const DECENAS = ['', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa']
const CENTENAS = [
  '', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos',
  'seiscientos', 'setecientos', 'ochocientos', 'novecientos',
]

/** Los centavos van en números: "veinte 50/100" es lo que se usa en un recibo. */
export function enLetras(n) {
  const entero = Math.floor(Math.abs(Number(n) || 0))
  if (entero === 0) return 'cero'
  if (entero === 100) return 'cien'
  if (entero < 20) return UNIDADES[entero]

  if (entero < 100) {
    const d = Math.floor(entero / 10)
    const u = entero % 10
    if (d === 2 && u) return `veinti${UNIDADES[u]}`
    return u ? `${DECENAS[d]} y ${UNIDADES[u]}` : DECENAS[d]
  }

  if (entero < 1000) {
    const c = Math.floor(entero / 100)
    const resto = entero % 100
    return resto ? `${CENTENAS[c]} ${enLetras(resto)}` : CENTENAS[c]
  }

  const miles = Math.floor(entero / 1000)
  const resto = entero % 1000
  const prefijo = miles === 1 ? 'mil' : `${enLetras(miles)} mil`
  return resto ? `${prefijo} ${enLetras(resto)}` : prefijo
}

/** "VEINTE DÓLARES CON CINCUENTA CENTAVOS", como se escribe en una factura. */
export function montoEnPalabras(monto) {
  const n = Number(monto) || 0
  const entero = Math.floor(n)
  const centavos = Math.round((n - entero) * 100)

  const dolares = `${enLetras(entero)} ${entero === 1 ? 'DÓLAR' : 'DÓLARES'}`
  const resto = centavos
    ? ` CON ${enLetras(centavos)} ${centavos === 1 ? 'CENTAVO' : 'CENTAVOS'}`
    : ''

  return `${dolares}${resto}`.toUpperCase()
}

/** "veinte 50/100 dólares" */
export function montoEnLetras(monto) {
  const n = Number(monto) || 0
  const centavos = Math.round((n - Math.floor(n)) * 100)
  return `${enLetras(n)} ${String(centavos).padStart(2, '0')}/100 dólares`
}

// --- Dibujo -----------------------------------------------------------------

function caja(doc, x, y, w, h) {
  doc.roundedRect(x, y, w, h, 3).lineWidth(0.7).strokeColor(BORDE).stroke()
}

function campo(doc, x, y, w, etiqueta, valor, { tam = 8 } = {}) {
  doc.fontSize(tam).font(NEGRITA).fillColor(NEGRO)
  const ancho = doc.widthOfString(`${etiqueta} `)
  doc.text(etiqueta, x, y, { width: w, lineBreak: false })
  doc.font(REGULAR).text(String(valor ?? '—'), x + ancho, y, { width: w - ancho })
}

/**
 * Dibuja un recibo completo en la posición indicada.
 * Se llama dos veces —original y copia— sobre la misma hoja.
 */
function recibo(doc, { emisor, pago, cliente, logo, copia, destinos = [], y }) {
  const x = MARGEN
  const alto = ALTO_RECIBO - MARGEN * 1.5

  caja(doc, x, y, ANCHO, alto)

  // --- Encabezado
  let cursor = y + 12
  const xi = x + 14

  if (logo) {
    try {
      doc.image(logo, xi, cursor, { fit: [110, 38] })
    } catch {
      // Un logo ilegible no puede impedir que se entregue el recibo.
    }
  }

  const xTexto = logo ? xi + 122 : xi
  doc.fontSize(11).font(NEGRITA).fillColor(NEGRO)
  doc.text(emisor.razon_social ?? '', xTexto, cursor, { width: 260 })
  doc.fontSize(7.5).font(REGULAR).fillColor(GRIS)
  if (emisor.nombre_comercial) doc.text(emisor.nombre_comercial, xTexto, doc.y, { width: 260 })
  if (emisor.ruc) doc.text(`RUC: ${emisor.ruc}`, xTexto, doc.y, { width: 260 })
  if (emisor.telefono) doc.text(`Teléfono: ${emisor.telefono}`, xTexto, doc.y, { width: 260 })

  // Número y fecha, a la derecha.
  const xd = x + ANCHO - 170
  doc.fontSize(13).font(NEGRITA).fillColor(NEGRO)
  doc.text('RECIBO DE COBRO', xd, cursor, { width: 156, align: 'right' })
  doc.fontSize(10).font(NEGRITA).fillColor('#0369a1')
  doc.text(`N° ${String(pago.numero ?? 0).padStart(6, '0')}`, xd, doc.y + 2, {
    width: 156,
    align: 'right',
  })
  doc.fontSize(8).font(REGULAR).fillColor(NEGRO)
  doc.text(fechaLegible(pago.fecha_pago), xd, doc.y + 2, { width: 156, align: 'right' })
  doc.fontSize(7).fillColor(GRIS)
  doc.text(copia ? 'COPIA — CAJA' : 'ORIGINAL — CLIENTE', xd, doc.y + 1, {
    width: 156,
    align: 'right',
  })

  cursor = Math.max(doc.y, cursor + 52) + 8
  doc.moveTo(x + 10, cursor).lineTo(x + ANCHO - 10, cursor).lineWidth(0.5).strokeColor(BORDE).stroke()
  cursor += 10

  // --- Cuerpo
  const w = ANCHO - 28
  campo(doc, xi, cursor, w, 'Recibí de:', cliente?.nombre ?? pago.cliente_nombre)
  cursor += 14
  campo(doc, xi, cursor, w / 2 - 10, 'RUC / CI:', cliente?.identificacion ?? '—')
  campo(doc, xi + w / 2, cursor, w / 2, 'Forma de pago:', FORMAS_PAGO[pago.forma_pago] ?? pago.forma_pago)
  cursor += 14
  campo(doc, xi, cursor, w / 2 - 10, 'Cuenta:', pago.cuenta ?? '—')
  campo(doc, xi + w / 2, cursor, w / 2, 'N° transacción:', pago.n_transaccion ?? '—')
  cursor += 14
  campo(
    doc,
    xi,
    cursor,
    w,
    'Por concepto de:',
    pago.numero_comprobante
      ? `Pago de la factura N° ${pago.numero_comprobante}`
      : 'Abono a cuenta del servicio de internet',
  )
  cursor += 18

  // --- Monto
  //
  // Se imprime lo que el abonado entregó, no lo que se imputó a la factura. Si
  // trajo $50 por una deuda de $34.50, el recibo tiene que decir $50: es la
  // constancia de lo que salió de su bolsillo.
  const recibido = Number(pago.total_cobro ?? pago.monto)
  const excedente = Number(pago.excedente ?? 0)

  doc.rect(xi, cursor, w, 30).fillColor('#f1f5f9').fill()
  caja(doc, xi, cursor, w, 30)
  doc.fontSize(9).font(NEGRITA).fillColor(NEGRO).text('TOTAL RECIBIDO', xi + 10, cursor + 11, {
    width: w - 130,
    lineBreak: false,
  })
  doc.fontSize(14).font(NEGRITA).fillColor('#047857')
  doc.text(dinero(recibido), xi + w - 130, cursor + 8, { width: 120, align: 'right' })
  cursor += 36

  doc.fontSize(7.5).font(REGULAR).fillColor(GRIS)
  doc.text(`Son: ${montoEnLetras(recibido)}.`, xi, cursor, { width: w })
  cursor = doc.y + 2

  // El desglose explica por qué la factura queda saldada y a dónde fue el resto.
  //
  // El recibo se imprime cuando alguien lo pide, no en el momento del cobro: el
  // sobrante puede haberse aplicado ya a otra factura. Decir "a favor" en ese
  // caso hace que el abonado venga a reclamar plata que no tiene.
  if (excedente > 0.005) {
    const aplicados = destinos.filter((d) => d.numero_factura)
    const disponible =
      Math.round(destinos.filter((d) => !d.numero_factura).reduce((t, d) => t + Number(d.monto), 0) * 100) / 100

    const partes = [`Aplicado a la deuda: ${dinero(pago.monto)}`]
    for (const d of aplicados) {
      partes.push(`${dinero(d.monto)} aplicados a la factura N° ${d.numero_factura}`)
    }
    if (disponible > 0.005) {
      partes.push(`A favor del cliente: ${dinero(disponible)} (se descuenta de su próxima factura)`)
    }
    if (!aplicados.length && disponible <= 0.005) {
      partes.push(`A favor del cliente: ${dinero(excedente)} (se descuenta de su próxima factura)`)
    }

    doc.fillColor(NEGRO)
    doc.text(`${partes.join(' · ')}.`, xi, cursor, { width: w })
    cursor = doc.y + 2
  }

  if (Number(pago.comision) > 0) {
    doc.text(
      `Incluye ${dinero(pago.comision)} de comisión del medio de pago; neto acreditado ${dinero(pago.monto - pago.comision)}.`,
      xi,
      cursor,
      { width: w },
    )
    cursor = doc.y + 2
  }

  if (pago.notas) {
    doc.fillColor(NEGRO).text(`Nota: ${pago.notas}`, xi, cursor + 2, { width: w })
    cursor = doc.y
  }

  // --- Firma
  const yFirma = y + alto - 40
  doc.moveTo(xi + w - 180, yFirma).lineTo(xi + w, yFirma).lineWidth(0.5).strokeColor(BORDE).stroke()
  doc.fontSize(7).fillColor(GRIS).text('Recibí conforme', xi + w - 180, yFirma + 3, {
    width: 180,
    align: 'center',
  })

  doc.fontSize(6.5).fillColor(GRIS)
  doc.text(
    'Este documento acredita el cobro. No reemplaza a la factura electrónica autorizada por el SRI.',
    xi,
    yFirma + 16,
    { width: w - 190 },
  )

  if (pago.anulado) marcaAnulado(doc, y, alto)
}

/** Un recibo anulado se imprime igual, pero no puede pasar por válido. */
function marcaAnulado(doc, y, alto) {
  doc.save()
  doc.rotate(-20, { origin: [ANCHO_PAGINA / 2, y + alto / 2] })
  doc.fontSize(46).font(NEGRITA).fillColor('#dc2626').opacity(0.16)
  doc.text('ANULADO', MARGEN, y + alto / 2 - 30, { width: ANCHO, align: 'center' })
  doc.restore()
  doc.opacity(1)
}

/**
 * Arma el recibo: original y copia en la misma hoja.
 *
 * @param emisor   fila de `sri_config` (razón social, RUC, teléfono, logo)
 * @param pago     fila de `v_pagos`
 * @param cliente  ficha del abonado (nombre e identificación)
 * @param logo     Buffer con el logo, opcional
 * @returns {Promise<Buffer>}
 */
export function generarReciboPdf({ emisor = {}, pago, cliente = null, destinos = [], logo = null }) {
  if (!pago) throw new Error('No hay pago que imprimir')

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGEN,
      info: {
        Title: `Recibo ${String(pago.numero ?? '').padStart(6, '0')}`,
        Author: emisor.razon_social ?? '',
      },
    })

    const trozos = []
    doc.on('data', (t) => trozos.push(t))
    doc.on('end', () => resolve(Buffer.concat(trozos)))
    doc.on('error', reject)

    try {
      recibo(doc, { emisor, pago, cliente, logo, destinos, copia: false, y: MARGEN })

      // Línea de corte entre las dos mitades.
      doc
        .moveTo(MARGEN, ALTO_RECIBO)
        .lineTo(ANCHO_PAGINA - MARGEN, ALTO_RECIBO)
        .dash(3, { space: 3 })
        .lineWidth(0.5)
        .strokeColor(BORDE)
        .stroke()
        .undash()

      recibo(doc, { emisor, pago, cliente, logo, destinos, copia: true, y: ALTO_RECIBO + 12 })
    } catch (err) {
      doc.end()
      return reject(err)
    }

    doc.end()
  })
}
