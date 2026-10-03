import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'
import {
  nombreMes,
  resumirPorRouter,
  totalesPorMes,
} from '../../../web/src/lib/crecimientoRouters.js'

/**
 * El reporte de crecimiento por router, en Excel y en PDF.
 *
 * Las cuentas (resumen por router, totales por mes) salen de la misma librería
 * que usa la pantalla: el papel no puede decir algo distinto de lo que se vio.
 */

const pct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`)
const dinero = (v) =>
  v == null ? '—' : `$${Number(v).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const n = (v) => (v == null ? '—' : String(v))

/** Las columnas de cada tabla, una sola vez para los dos papeles. */
const COL_RESUMEN = [
  { titulo: 'Router', clave: 'router', ancho: 28, pdf: 150 },
  { titulo: 'Al inicio', clave: 'inicio', ancho: 11, pdf: 52, numero: true },
  { titulo: 'Altas', clave: 'altas', ancho: 9, pdf: 44, numero: true },
  { titulo: 'Carga inicial', clave: 'carga_inicial', ancho: 12, pdf: 56, numero: true },
  { titulo: 'Bajas', clave: 'bajas', ancho: 9, pdf: 44, numero: true },
  { titulo: 'Neto', clave: 'neto', ancho: 9, pdf: 44, numero: true },
  { titulo: 'Al cierre', clave: 'fin', ancho: 11, pdf: 52, numero: true },
  { titulo: 'Variación', clave: 'variacion', ancho: 11, pdf: 54, porcentaje: true },
  { titulo: 'Cortados', clave: 'cortados', ancho: 10, pdf: 50, numero: true, foto: true },
  { titulo: 'Pausados', clave: 'suspendidos', ancho: 10, pdf: 50, numero: true, foto: true },
  { titulo: 'Deuda vencida', clave: 'vencido', ancho: 14, pdf: 70, dinero: true, foto: true },
]

const COL_MES = [
  { titulo: 'Mes', clave: 'mes', ancho: 12, pdf: 70 },
  { titulo: 'Router', clave: 'router', ancho: 28, pdf: 150 },
  { titulo: 'Altas', clave: 'altas', ancho: 9, pdf: 44, numero: true },
  { titulo: 'Carga inicial', clave: 'carga_inicial', ancho: 12, pdf: 56, numero: true },
  { titulo: 'Bajas', clave: 'bajas', ancho: 9, pdf: 44, numero: true },
  { titulo: 'Neto', clave: 'neto', ancho: 9, pdf: 44, numero: true },
  { titulo: 'Total', clave: 'total', ancho: 9, pdf: 48, numero: true },
  { titulo: 'Activos', clave: 'activos', ancho: 9, pdf: 48, numero: true },
  { titulo: 'Cortados', clave: 'cortados', ancho: 10, pdf: 50, numero: true },
  { titulo: 'Pausados', clave: 'suspendidos', ancho: 10, pdf: 50, numero: true },
  { titulo: 'Por cobrar', clave: 'por_cobrar', ancho: 13, pdf: 64, dinero: true },
  { titulo: 'Deuda vencida', clave: 'vencido', ancho: 14, pdf: 70, dinero: true },
]

/** La fila del resumen aplanada: los datos de la foto suben al nivel de la fila. */
const filaResumen = (r) => ({
  ...r,
  cortados: r.foto?.cortados ?? null,
  suspendidos: r.foto?.suspendidos ?? null,
  vencido: r.foto?.vencido ?? null,
})

/** La fila mes a mes: sin foto, los datos de morosos van vacíos y no en cero. */
const filaMes = (f) => ({
  ...f,
  mes: nombreMes(f.mes),
  ...(f.con_foto
    ? {}
    : { activos: null, cortados: null, suspendidos: null, por_cobrar: null, vencido: null }),
})

function textoDe(col, v) {
  if (col.porcentaje) return pct(v)
  if (col.dinero) return dinero(v)
  if (col.numero) return n(v)
  return String(v ?? '')
}

const NOTAS = [
  'Altas: abonados con fecha de instalación (o de registro) en el mes.',
  'Carga inicial: importados sin fecha de instalación; su alta es el día de la importación.',
  'Bajas: abonados que hoy están de baja, en el mes en que se dieron de baja.',
  'Cortados, pausados y deuda salen de la foto mensual: los meses anteriores a la primera foto quedan vacíos.',
  'Cada abonado cuenta en el router que tiene hoy asignado.',
]

// =============================================================================
// Excel
// =============================================================================
function hoja(wb, nombre, columnas, filas) {
  const ws = wb.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = columnas.map((c) => ({ header: c.titulo, key: c.clave, width: c.ancho }))

  const enc = ws.getRow(1)
  enc.font = { bold: true, size: 10 }
  enc.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  enc.height = 26
  enc.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDF0' } }
  })

  for (const f of filas) {
    // Números como números: quien abre el Excel quiere sumar y graficar.
    const fila = ws.addRow(
      Object.fromEntries(
        columnas.map((c) => [c.clave, f[c.clave] == null ? null : c.numero || c.dinero || c.porcentaje ? Number(f[c.clave]) : f[c.clave]]),
      ),
    )
    fila.font = { size: 9 }
  }

  for (const c of columnas) {
    if (c.dinero) ws.getColumn(c.clave).numFmt = '"$"#,##0.00'
    if (c.porcentaje) ws.getColumn(c.clave).numFmt = '+0.0%;-0.0%;0.0%'
  }
  if (filas.length) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnas.length } }
  }
  return ws
}

export async function generarCrecimientoExcel({ filas = [], empresa = {}, periodo = '' }) {
  const wb = new ExcelJS.Workbook()
  wb.creator = empresa.razon_social || 'Sistema'
  wb.created = new Date()

  hoja(wb, 'Resumen por router', COL_RESUMEN, resumirPorRouter(filas).map(filaResumen))
  hoja(
    wb,
    'Totales mes a mes',
    COL_MES.filter((c) => c.clave !== 'router'),
    totalesPorMes(filas).map(filaMes),
  )
  hoja(
    wb,
    'Mes a mes por router',
    COL_MES,
    [...filas]
      .sort((a, b) => String(a.mes).localeCompare(String(b.mes)) || String(a.router).localeCompare(String(b.router)))
      .map(filaMes),
  )

  const info = wb.addWorksheet('Datos del reporte')
  info.columns = [{ width: 22 }, { width: 90 }]
  for (const [k, v] of [
    ['Empresa', empresa.razon_social || empresa.nombre_comercial || ''],
    ['Período', periodo],
    ['Emitido', new Date().toISOString().slice(0, 19).replace('T', ' ')],
  ]) {
    const f = info.addRow([k, v])
    f.getCell(1).font = { bold: true, size: 10 }
  }
  info.addRow([])
  info.addRow(['Cómo se cuenta']).getCell(1).font = { bold: true, size: 10 }
  for (const nota of NOTAS) info.addRow(['', nota]).font = { size: 9 }

  return Buffer.from(await wb.xlsx.writeBuffer())
}

// =============================================================================
// PDF
// =============================================================================
const MARGEN = 28
const ANCHO_PAGINA = 841.89 // A4 apaisado
const ALTO_PAGINA = 595.28
const GRIS_FONDO = '#eef2f3'
const GRIS_TEXTO = '#6b7280'
const NEGRO = '#111827'
const BORDE = '#d1d5db'
const ALTO_FILA = 14

function recortar(doc, texto, ancho) {
  const t = String(texto ?? '')
  if (doc.widthOfString(t) <= ancho - 4) return t
  let corto = t
  while (corto.length > 1 && doc.widthOfString(`${corto}…`) > ancho - 4) corto = corto.slice(0, -1)
  return `${corto}…`
}

function tabla(doc, y, titulo, columnas, filas, { negritaUltima = false } = {}) {
  const ancho = columnas.reduce((s, c) => s + c.pdf, 0)
  const encabezado = (yy) => {
    doc.rect(MARGEN, yy, ancho, 18).fill(GRIS_FONDO)
    doc.font('Helvetica-Bold').fontSize(7).fillColor(GRIS_TEXTO)
    let x = MARGEN
    for (const c of columnas) {
      doc.text(c.titulo, x + 3, yy + 5, { width: c.pdf - 6, align: c.clave === 'router' || c.clave === 'mes' ? 'left' : 'right', lineBreak: false })
      x += c.pdf
    }
    return yy + 18
  }

  if (y + 60 > ALTO_PAGINA - MARGEN) {
    doc.addPage()
    y = MARGEN
  }
  doc.font('Helvetica-Bold').fontSize(10).fillColor(NEGRO).text(titulo, MARGEN, y)
  y = encabezado(y + 16)

  filas.forEach((f, i) => {
    if (y + ALTO_FILA > ALTO_PAGINA - MARGEN - 12) {
      doc.addPage()
      y = encabezado(MARGEN)
    }
    const negrita = negritaUltima && i === filas.length - 1
    let x = MARGEN
    for (const c of columnas) {
      doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor(NEGRO)
      doc.text(recortar(doc, textoDe(c, f[c.clave]), c.pdf), x + 3, y + 4, {
        width: c.pdf - 6,
        align: c.clave === 'router' || c.clave === 'mes' ? 'left' : 'right',
        lineBreak: false,
      })
      x += c.pdf
    }
    doc.moveTo(MARGEN, y + ALTO_FILA).lineTo(MARGEN + ancho, y + ALTO_FILA)
       .lineWidth(0.3).strokeColor(BORDE).stroke()
    y += ALTO_FILA
  })

  if (!filas.length) {
    doc.font('Helvetica').fontSize(8).fillColor(GRIS_TEXTO).text('Sin datos en el período.', MARGEN, y + 6)
    y += 20
  }
  return y + 18
}

export function generarCrecimientoPdf({ filas = [], empresa = {}, periodo = '', logo = null }) {
  const doc = new PDFDocument({
    size: [ANCHO_PAGINA, ALTO_PAGINA],
    margin: MARGEN,
    bufferPages: true,
    info: { Title: 'Crecimiento por router', Author: empresa.razon_social ?? '' },
  })
  const trozos = []
  doc.on('data', (d) => trozos.push(d))
  const listo = new Promise((res) => doc.on('end', () => res(Buffer.concat(trozos))))

  let y = MARGEN
  if (logo) {
    try {
      doc.image(logo, MARGEN, y, { fit: [92, 32] })
    } catch {
      // Un logo ilegible no puede impedir el reporte.
    }
  }
  const xTitulo = MARGEN + (logo ? 104 : 0)
  doc.font('Helvetica-Bold').fontSize(14).fillColor(NEGRO)
     .text('Crecimiento de abonados por router', xTitulo, y, { width: 460 })
  doc.font('Helvetica').fontSize(8.5).fillColor(GRIS_TEXTO)
     .text([empresa.razon_social, `Período: ${periodo}`].filter(Boolean).join('  ·  '), xTitulo, y + 19, { width: 460 })
  doc.text(`Emitido ${new Date().toLocaleDateString('es-EC')}`, ANCHO_PAGINA - MARGEN - 200, y + 2, {
    width: 200,
    align: 'right',
  })
  y += 46

  const resumen = resumirPorRouter(filas).map(filaResumen)
  const totales = resumen.reduce(
    (t, r) => ({
      router: 'Total',
      inicio: t.inicio + r.inicio,
      altas: t.altas + r.altas,
      carga_inicial: t.carga_inicial + r.carga_inicial,
      bajas: t.bajas + r.bajas,
      neto: t.neto + r.neto,
      fin: t.fin + r.fin,
      cortados: r.cortados == null ? t.cortados : (t.cortados ?? 0) + r.cortados,
      suspendidos: r.suspendidos == null ? t.suspendidos : (t.suspendidos ?? 0) + r.suspendidos,
      vencido: r.vencido == null ? t.vencido : (t.vencido ?? 0) + r.vencido,
    }),
    { inicio: 0, altas: 0, carga_inicial: 0, bajas: 0, neto: 0, fin: 0, cortados: null, suspendidos: null, vencido: null },
  )
  totales.variacion = totales.inicio ? (totales.fin - totales.inicio) / totales.inicio : null

  y = tabla(doc, y, 'Resumen del período por router', COL_RESUMEN, resumen.length > 1 ? [...resumen, totales] : resumen, {
    negritaUltima: resumen.length > 1,
  })
  y = tabla(doc, y, 'Totales mes a mes', COL_MES.filter((c) => c.clave !== 'router'), totalesPorMes(filas).map(filaMes))

  if (y + 70 > ALTO_PAGINA - MARGEN) {
    doc.addPage()
    y = MARGEN
  }
  doc.font('Helvetica-Bold').fontSize(8).fillColor(GRIS_TEXTO).text('Cómo se cuenta', MARGEN, y)
  doc.font('Helvetica').fontSize(7.5)
  for (const nota of NOTAS) doc.text(`· ${nota}`, MARGEN, doc.y + 2, { width: ANCHO_PAGINA - 2 * MARGEN })

  const paginas = doc.bufferedPageRange()
  for (let i = 0; i < paginas.count; i++) {
    doc.switchToPage(i)
    // Sin esto pdfkit ve el pie por debajo del margen y abre una hoja en blanco.
    doc.page.margins.bottom = 0
    doc.font('Helvetica').fontSize(6.5).fillColor(GRIS_TEXTO)
       .text(`Página ${i + 1} de ${paginas.count}`, MARGEN, ALTO_PAGINA - MARGEN + 6, {
         width: ANCHO_PAGINA - 2 * MARGEN,
         align: 'right',
         lineBreak: false,
       })
  }

  doc.end()
  return listo
}
