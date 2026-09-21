/**
 * El cierre de caja, en papel.
 *
 * Es lo que se firma y se archiva cuando alguien entrega la recaudación: quién
 * cobró, en qué sitio, cuántos comprobantes, cuánto entró, cuánto se lleva de
 * comisión y cuánto queda. Por eso el detalle va completo y no solo el total —
 * un total no se puede discutir ni verificar, una lista sí.
 *
 * ── Por qué los anulados aparecen ──
 *
 * Porque son la explicación de por qué la plata no coincide con los recibos
 * impresos. Un cierre que los esconde obliga a buscarlos en otra pantalla
 * justamente cuando algo no cuadra.
 */

import PDFDocument from 'pdfkit'

const MARGEN = 30
const ANCHO_PAGINA = 841.89 // A4 apaisado: la tabla tiene diez columnas
const ALTO_PAGINA = 595.28
const ANCHO = ANCHO_PAGINA - MARGEN * 2

const GRIS_FONDO = '#eef2f3'
const GRIS_TEXTO = '#6b7280'
const NEGRO = '#111827'
const BORDE = '#d1d5db'
const ROJO = '#b91c1c'

const REGULAR = 'Helvetica'
const NEGRITA = 'Helvetica-Bold'

const dinero = (n) => `$${(Number(n) || 0).toFixed(2)}`

/** La fecha y la hora como se leen en Ecuador. */
export function fechaHora(valor) {
  if (!valor) return ''
  const d = new Date(valor)
  if (Number.isNaN(d.getTime())) return String(valor)
  const f = new Intl.DateTimeFormat('es-EC', {
    timeZone: 'America/Guayaquil',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const p = Object.fromEntries(f.map((x) => [x.type, x.value]))
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`
}

/** Solo la fecha, para el encabezado del período. */
export function soloFecha(valor) {
  if (!valor) return ''
  const s = String(valor).slice(0, 10)
  const [a, m, d] = s.split('-')
  return d ? `${d}/${m}/${a}` : s
}

/**
 * Las columnas del detalle.
 *
 * El orden es el de la pantalla a propósito: quien imprime está mirando la
 * pantalla, y dos órdenes distintos obligan a leer dos veces para comparar.
 */
const COLUMNAS = [
  { titulo: 'ID', ancho: 38, valor: (t) => (t.numero == null ? '' : String(t.numero)) },
  { titulo: 'Cliente', ancho: 150, valor: (t) => t.cliente ?? '' },
  { titulo: 'Factura', ancho: 62, valor: (t) => (t.numero_factura ? String(t.numero_factura) : '') },
  { titulo: 'Legal', ancho: 62, valor: (t) => t.numero_comprobante ?? '' },
  { titulo: 'Transacción', ancho: 82, valor: (t) => t.n_transaccion ?? '' },
  { titulo: 'Tipo', ancho: 70, valor: (t) => t.tipo ?? '' },
  { titulo: 'Fecha y hora', ancho: 106, valor: (t) => fechaHora(t.registrado_en) },
  { titulo: 'Operador', ancho: 92, valor: (t) => t.operador ?? '' },
  { titulo: 'Cobrado', ancho: 62, valor: (t) => dinero(t.cobrado), derecha: true },
  { titulo: 'Comisión', ancho: 58, valor: (t) => dinero(t.comision), derecha: true },
]

const ANCHO_TABLA = COLUMNAS.reduce((s, c) => s + c.ancho, 0)

/** Recorta lo que no entra, con puntos suspensivos. */
function recortar(doc, texto, ancho) {
  const t = String(texto ?? '')
  if (doc.widthOfString(t) <= ancho - 6) return t
  let corto = t
  while (corto.length > 1 && doc.widthOfString(`${corto}…`) > ancho - 6) {
    corto = corto.slice(0, -1)
  }
  return `${corto}…`
}

function encabezadoTabla(doc, y) {
  doc.rect(MARGEN, y, ANCHO_TABLA, 18).fill(GRIS_FONDO)
  doc.font(NEGRITA).fontSize(7.5).fillColor(GRIS_TEXTO)

  let x = MARGEN
  for (const c of COLUMNAS) {
    doc.text(c.titulo.toUpperCase(), x + 3, y + 5.5, {
      width: c.ancho - 6,
      align: c.derecha ? 'right' : 'left',
      lineBreak: false,
    })
    x += c.ancho
  }
  return y + 18
}

/**
 * El cierre de caja.
 *
 * `filtros` viaja al papel tal como se eligió en la pantalla: sin eso, dos
 * cierres del mismo día se ven idénticos y no hay forma de saber cuál era el de
 * qué operador.
 */
export function generarTransaccionesPdf({
  empresa = {},
  transacciones = [],
  totales = {},
  filtros = {},
  logo = null,
}) {
  const doc = new PDFDocument({
    size: [ANCHO_PAGINA, ALTO_PAGINA],
    margin: MARGEN,
    bufferPages: true,
    info: { Title: 'Cierre de caja', Author: empresa.razon_social ?? '' },
  })

  const trozos = []
  doc.on('data', (d) => trozos.push(d))
  const listo = new Promise((res) => doc.on('end', () => res(Buffer.concat(trozos))))

  // ── Encabezado ──
  let y = MARGEN

  if (logo) {
    try {
      doc.image(logo, MARGEN, y, { fit: [110, 38] })
    } catch {
      // Un logo ilegible no puede impedir el cierre de caja.
    }
  }

  doc.font(NEGRITA).fontSize(15).fillColor(NEGRO)
     .text('Cierre de caja', MARGEN + (logo ? 124 : 0), y, { width: 300 })

  doc.font(REGULAR).fontSize(8.5).fillColor(GRIS_TEXTO)
     .text(empresa.nombre_comercial || empresa.razon_social || '', MARGEN + (logo ? 124 : 0), y + 19, {
       width: 300,
     })

  // Los filtros, arriba a la derecha: son lo que identifica a este cierre.
  const lineas = [
    ['Período', [soloFecha(filtros.desde), soloFecha(filtros.hasta)].filter(Boolean).join(' al ') || 'Todo'],
    ['Operador', filtros.operador || 'Todos'],
    ['Ubicación', filtros.ubicacion || 'Todas'],
    ['Router', filtros.router || 'Todos'],
    ['Forma de pago', filtros.forma_pago || 'Cualquiera'],
    ['Emitido', fechaHora(filtros.emitido_en ?? new Date().toISOString())],
  ].filter(([, v]) => v)

  let yf = MARGEN
  for (const [k, v] of lineas) {
    doc.font(REGULAR).fontSize(7.5).fillColor(GRIS_TEXTO)
       .text(`${k}:`, ANCHO_PAGINA - MARGEN - 250, yf, { width: 78, align: 'right' })
    doc.font(NEGRITA).fontSize(7.5).fillColor(NEGRO)
       .text(String(v), ANCHO_PAGINA - MARGEN - 168, yf, { width: 168, align: 'right', lineBreak: false })
    yf += 11
  }

  y = Math.max(y + 46, yf + 6)

  // ── Detalle ──
  y = encabezadoTabla(doc, y)

  const ALTO_FILA = 14
  const PIE = 120 // lo que hay que dejar libre para el resumen de la última página

  for (const t of transacciones) {
    if (y + ALTO_FILA > ALTO_PAGINA - MARGEN - 14) {
      doc.addPage()
      y = encabezadoTabla(doc, MARGEN)
    }

    let x = MARGEN
    for (const c of COLUMNAS) {
      /**
       * Lo anulado va en rojo y tachado.
       *
       * Un anulado que se ve igual que un cobro bueno es la forma más rápida de
       * cuadrar mal una caja: se suma con la vista y sobra plata en el papel.
       */
      doc.font(REGULAR).fontSize(7.5).fillColor(t.anulado ? ROJO : NEGRO)
      const texto = recortar(doc, c.valor(t), c.ancho)
      doc.text(texto, x + 3, y + 4, {
        width: c.ancho - 6,
        align: c.derecha ? 'right' : 'left',
        lineBreak: false,
      })
      if (t.anulado && c.derecha) {
        const ancho = doc.widthOfString(texto)
        doc.moveTo(x + c.ancho - 3 - ancho, y + 7.5)
           .lineTo(x + c.ancho - 3, y + 7.5)
           .lineWidth(0.5).strokeColor(ROJO).stroke()
      }
      x += c.ancho
    }

    doc.moveTo(MARGEN, y + ALTO_FILA)
       .lineTo(MARGEN + ANCHO_TABLA, y + ALTO_FILA)
       .lineWidth(0.3).strokeColor(BORDE).stroke()

    y += ALTO_FILA
  }

  if (!transacciones.length) {
    doc.font(REGULAR).fontSize(9).fillColor(GRIS_TEXTO)
       .text('No hubo cobros con estos filtros.', MARGEN, y + 10, { width: ANCHO })
    y += 26
  }

  // ── El resumen ──
  if (y + PIE > ALTO_PAGINA - MARGEN) {
    doc.addPage()
    y = MARGEN
  }

  y += 14
  const anchoCaja = 300
  const xCaja = MARGEN + ANCHO_TABLA - anchoCaja

  const filas = [
    ['Comprobantes', String(totales.cantidad ?? transacciones.filter((t) => !t.anulado).length)],
    ['Total cobrado', dinero(totales.cobrado)],
    ['Total comisión', dinero(totales.comision)],
  ]

  doc.rect(xCaja, y, anchoCaja, 18 + filas.length * 15 + 24).fill(GRIS_FONDO)

  doc.font(NEGRITA).fontSize(8).fillColor(GRIS_TEXTO)
     .text('RESUMEN', xCaja + 12, y + 6, { width: anchoCaja - 24 })

  let yr = y + 22
  for (const [k, v] of filas) {
    doc.font(REGULAR).fontSize(9).fillColor(NEGRO)
       .text(k, xCaja + 12, yr, { width: 160 })
    doc.font(NEGRITA).fontSize(9).fillColor(NEGRO)
       .text(v, xCaja + anchoCaja - 132, yr, { width: 120, align: 'right' })
    yr += 15
  }

  // El neto separado y más grande: es el número que se entrega.
  doc.moveTo(xCaja + 12, yr + 2).lineTo(xCaja + anchoCaja - 12, yr + 2)
     .lineWidth(0.5).strokeColor(BORDE).stroke()

  doc.font(NEGRITA).fontSize(11).fillColor(NEGRO)
     .text('TOTAL NETO', xCaja + 12, yr + 8, { width: 160 })
  doc.font(NEGRITA).fontSize(11).fillColor(NEGRO)
     .text(dinero(totales.neto), xCaja + anchoCaja - 132, yr + 8, { width: 120, align: 'right' })

  yr += 30

  /**
   * Lo anulado, debajo del neto y solo si hubo.
   *
   * No se resta del total —ya está afuera— pero tiene que estar dicho: es la
   * respuesta a "¿por qué imprimí diez recibos y entrego el valor de nueve?".
   */
  if (Number(totales.anulados) > 0) {
    doc.font(REGULAR).fontSize(8).fillColor(ROJO)
       .text(
         `${totales.anulados} anulado${Number(totales.anulados) === 1 ? '' : 's'} por ${dinero(totales.anulado_monto)}, no incluidos en el total.`,
         xCaja, yr + 4,
         { width: anchoCaja, align: 'right' },
       )
    yr += 14
  }

  // ── Firmas ──
  const yFirma = Math.max(yr + 30, ALTO_PAGINA - MARGEN - 44)
  if (yFirma < ALTO_PAGINA - MARGEN - 20) {
    for (const [i, quien] of ['Entrega', 'Recibe'].entries()) {
      const x = MARGEN + i * 240
      doc.moveTo(x, yFirma).lineTo(x + 190, yFirma)
         .lineWidth(0.5).strokeColor(BORDE).stroke()
      doc.font(REGULAR).fontSize(7.5).fillColor(GRIS_TEXTO)
         .text(quien, x, yFirma + 4, { width: 190 })
    }
  }

  // ── Numeración ──
  const paginas = doc.bufferedPageRange()
  for (let i = 0; i < paginas.count; i++) {
    doc.switchToPage(i)
    doc.font(REGULAR).fontSize(7).fillColor(GRIS_TEXTO)
       .text(`Página ${i + 1} de ${paginas.count}`, MARGEN, ALTO_PAGINA - MARGEN + 4, {
         width: ANCHO,
         align: 'right',
       })
  }

  doc.end()
  return listo
}
