import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'

/**
 * El reporte para ARCOTEL, en Excel y en PDF.
 *
 * ── Por qué las dos columnas se declaran una sola vez ──
 *
 * Porque son el mismo reporte en dos papeles. Con dos listas de columnas, el día
 * que el regulador pida una más se agrega en una y se olvida en la otra, y nadie
 * lo nota hasta que el organismo devuelve el archivo.
 *
 * El orden es el que pidió el regulador, no el que quedaría más cómodo.
 */
export const COLUMNAS = [
  /**
   * "MES" con la fecha completa: es el nombre del campo en el formulario y el
   * dato que pidió el ISP. Cambiarle el título al que parece más correcto haría
   * que no coincida con el 1f, que es contra lo que se compara.
   */
  { titulo: 'MES', clave: 'fecha', ancho: 12, pdf: 48 },
  { titulo: 'HORA Y MINUTO', clave: 'hora', ancho: 12, pdf: 34 },
  { titulo: 'DOCUMENTO', clave: 'documento', ancho: 22, pdf: 82 },
  { titulo: 'NOMBRE DEL USUARIO', clave: 'usuario', ancho: 32, pdf: 104 },
  { titulo: 'TELEFONO', clave: 'telefono', ancho: 13, pdf: 48 },
  { titulo: 'CANTON/CIUDAD', clave: 'canton', ancho: 16, pdf: 52 },
  { titulo: 'PARROQUIA', clave: 'parroquia', ancho: 16, pdf: 52 },
  { titulo: 'NOMBRE DEL PLAN', clave: 'plan', ancho: 20, pdf: 62 },
  { titulo: 'DIRECCIÓN', clave: 'direccion', ancho: 34, pdf: 92 },
  {
    titulo: 'COSTO INCLUIDO IMPUESTOS',
    clave: 'costo_con_impuestos',
    ancho: 15,
    pdf: 46,
    numero: true,
    derecha: true,
  },
  { titulo: 'DOWN(Mbps)', clave: 'down_mbps', ancho: 11, pdf: 34, numero: true, derecha: true },
  { titulo: 'UP(Mbps)', clave: 'up_mbps', ancho: 11, pdf: 32, numero: true, derecha: true },
  /**
   * El nivel de compartición va acá, entre las velocidades y la tecnología.
   *
   * Es donde lo pide el anexo 1f: las tres describen el enlace. Ponerlo al final,
   * después de la tecnología, obligaría a quien compara el archivo contra el
   * formulario a saltar de una punta a la otra de la fila.
   *
   * NO es número aunque parezca: "4:1" es una razón, y escrita como número Excel
   * la interpreta como una hora.
   */
  { titulo: 'NIVEL DE COMPARTICION', clave: 'comparticion', ancho: 15, pdf: 40, derecha: true },
  { titulo: 'TECNOLOGIA', clave: 'tecnologia', ancho: 17, pdf: 58 },
]

/**
 * Cómo se llama cada forma de pago en el resumen.
 *
 * "sin cobrar" y "mixto" no son formas de pago sino estados, y por eso se nombran
 * distinto: una factura sin cobrar no es un error del reporte, es plata que el
 * abonado todavía debe aunque el comprobante ya se emitió.
 */
export const FORMAS = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia',
  deposito: 'Depósito',
  tarjeta: 'Tarjeta',
  otro: 'Otro',
  mixto: 'Mixto (varias formas)',
  'sin cobrar': 'Todavía sin cobrar',
}

const dinero = (n) => `$${(Number(n) || 0).toFixed(2)}`

/** El valor de una celda, ya listo para escribir. */
function valor(fila, col) {
  const v = fila[col.clave]
  if (v == null || v === '') return col.numero ? null : ''
  return col.numero ? Number(v) : String(v)
}

// =============================================================================
// Excel
// =============================================================================
/**
 * El archivo que se sube al portal del regulador.
 *
 * Los números van como NÚMEROS y no como texto: un costo escrito "17,39" no se
 * puede sumar, y el primer control del organismo es sumar la columna.
 */
export async function generarArcotelExcel({ filas = [], empresa = {}, periodo = null, resumen = [] }) {
  const wb = new ExcelJS.Workbook()
  wb.creator = empresa.razon_social || 'Sistema'
  wb.created = new Date()

  const ws = wb.addWorksheet('Reporte ARCOTEL', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  ws.columns = COLUMNAS.map((c) => ({ header: c.titulo, key: c.clave, width: c.ancho }))

  const encabezado = ws.getRow(1)
  encabezado.font = { bold: true, size: 10 }
  encabezado.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  encabezado.height = 30
  encabezado.eachCell((celda) => {
    celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDF0' } }
    celda.border = {
      top: { style: 'thin', color: { argb: 'FFB0BAC2' } },
      bottom: { style: 'thin', color: { argb: 'FFB0BAC2' } },
      left: { style: 'thin', color: { argb: 'FFB0BAC2' } },
      right: { style: 'thin', color: { argb: 'FFB0BAC2' } },
    }
  })

  for (const f of filas) {
    const fila = ws.addRow(Object.fromEntries(COLUMNAS.map((c) => [c.clave, valor(f, c)])))
    fila.font = { size: 9 }
    fila.alignment = { vertical: 'middle' }
  }

  // Dos decimales en el costo, uno en las velocidades: es como se leen.
  ws.getColumn('costo_con_impuestos').numFmt = '0.00'
  ws.getColumn('down_mbps').numFmt = '0.0'
  ws.getColumn('up_mbps').numFmt = '0.0'

  /**
   * La compartición, como texto y alineada a la derecha.
   *
   * Sin el formato de texto, Excel lee "4:1" y lo convierte a 04:01 a.m. — el
   * dato se pierde al abrir el archivo, no al escribirlo, así que revisar lo
   * generado desde el sistema no lo mostraría.
   */
  ws.getColumn('comparticion').numFmt = '@'
  ws.getColumn('comparticion').alignment = { horizontal: 'right', vertical: 'middle' }

  /**
   * El filtro automático sobre el encabezado.
   *
   * Quien revisa el archivo antes de subirlo ordena por cantón o busca un
   * abonado, y sin esto tiene que activarlo a mano cada vez.
   */
  if (filas.length) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNAS.length } }
  }

  /**
   * Una hoja aparte con quién emitió y de qué período.
   *
   * No va arriba de la tabla a propósito: cualquier fila de título por encima del
   * encabezado rompe la lectura automática del archivo, y el portal del regulador
   * espera que la primera fila sean los nombres de las columnas.
   */
  const info = wb.addWorksheet('Datos del reporte')
  info.columns = [{ width: 26 }, { width: 52 }]
  const datos = [
    ['Prestador', empresa.razon_social || ''],
    ['Nombre comercial', empresa.nombre_comercial || ''],
    ['RUC', empresa.ruc || ''],
    ['Período', periodo || 'Todos'],
    ['Registros', String(filas.length)],
    ['Emitido', new Date().toISOString().slice(0, 19).replace('T', ' ')],
  ]
  for (const [k, v] of datos) {
    const fila = info.addRow([k, v])
    fila.getCell(1).font = { bold: true, size: 10 }
    fila.getCell(2).font = { size: 10 }
  }

  /**
   * El resumen de cómo pagaron, en la misma hoja de datos.
   *
   * Va acá y no en la hoja del reporte porque el portal del regulador lee la
   * primera hoja entera: cualquier fila que no sea un abonado la interpreta como
   * un registro más y devuelve el archivo.
   */
  if (resumen.length) {
    info.addRow([])
    const titulo = info.addRow(['Cómo pagaron', ''])
    titulo.getCell(1).font = { bold: true, size: 11 }

    const encabezado = info.addRow(['Forma de pago', 'Facturas', 'Abonados', 'Monto'])
    encabezado.eachCell((c) => { c.font = { bold: true, size: 9 } })

    for (const r of resumen) {
      const fila = info.addRow([
        FORMAS[r.forma_pago] ?? r.forma_pago,
        Number(r.facturas),
        Number(r.abonados),
        Number(r.monto),
      ])
      fila.getCell(4).numFmt = '0.00'
      fila.font = { size: 10 }
    }

    const total = info.addRow([
      'Total',
      resumen.reduce((s, r) => s + Number(r.facturas), 0),
      '',
      resumen.reduce((s, r) => s + Number(r.monto), 0),
    ])
    total.font = { bold: true, size: 10 }
    total.getCell(4).numFmt = '0.00'

    info.getColumn(2).width = 12
    info.getColumn(3).width = 12
    info.getColumn(4).width = 14
  }

  return Buffer.from(await wb.xlsx.writeBuffer())
}

// =============================================================================
// PDF
// =============================================================================
const MARGEN = 24
const ANCHO_PAGINA = 841.89 // A4 apaisado: once columnas no entran de otra forma
const ALTO_PAGINA = 595.28

const GRIS_FONDO = '#eef2f3'
const GRIS_TEXTO = '#6b7280'
const NEGRO = '#111827'
const BORDE = '#d1d5db'

const ANCHO_TABLA = COLUMNAS.reduce((s, c) => s + c.pdf, 0)

function recortar(doc, texto, ancho) {
  const t = String(texto ?? '')
  if (doc.widthOfString(t) <= ancho - 4) return t
  let corto = t
  while (corto.length > 1 && doc.widthOfString(`${corto}…`) > ancho - 4) corto = corto.slice(0, -1)
  return `${corto}…`
}

function encabezadoTabla(doc, y) {
  doc.rect(MARGEN, y, ANCHO_TABLA, 22).fill(GRIS_FONDO)
  doc.font('Helvetica-Bold').fontSize(5.8).fillColor(GRIS_TEXTO)

  let x = MARGEN
  for (const c of COLUMNAS) {
    doc.text(c.titulo, x + 2, y + 6, {
      width: c.pdf - 4,
      align: c.derecha ? 'right' : 'left',
      height: 14,
    })
    x += c.pdf
  }
  return y + 22
}

/** El mismo reporte en papel, para archivar o firmar. */
export function generarArcotelPdf({
  filas = [],
  empresa = {},
  periodo = null,
  logo = null,
  resumen = [],
}) {
  const doc = new PDFDocument({
    size: [ANCHO_PAGINA, ALTO_PAGINA],
    margin: MARGEN,
    bufferPages: true,
    info: { Title: 'Reporte ARCOTEL', Author: empresa.razon_social ?? '' },
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

  doc.font('Helvetica-Bold').fontSize(13).fillColor(NEGRO)
     .text('Reporte de facturación — ARCOTEL', MARGEN + (logo ? 104 : 0), y, { width: 420 })

  doc.font('Helvetica').fontSize(8).fillColor(GRIS_TEXTO)
     .text(
       [empresa.razon_social, empresa.ruc ? `RUC ${empresa.ruc}` : null].filter(Boolean).join(' · '),
       MARGEN + (logo ? 104 : 0), y + 17,
       { width: 420 },
     )

  doc.font('Helvetica').fontSize(8).fillColor(GRIS_TEXTO)
     .text(
       `${periodo ? `Período: ${periodo}` : 'Todos los períodos'}  ·  ${filas.length} registro${filas.length === 1 ? '' : 's'}`,
       ANCHO_PAGINA - MARGEN - 300, y + 2,
       { width: 300, align: 'right' },
     )

  y = Math.max(y + 40, MARGEN + 40)

  /**
   * El resumen de cómo pagaron, arriba de todo.
   *
   * Es lo que alguien mira primero y a veces lo único que mira: cuánto de la
   * facturación electrónica entró por caja y cuánto por el banco. Dejarlo al final
   * de doscientas filas equivale a esconderlo.
   */
  if (resumen.length) {
    const ANCHO_CAJA = 118
    for (const [i, r] of resumen.entries()) {
      const x = MARGEN + i * (ANCHO_CAJA + 6)
      if (x + ANCHO_CAJA > ANCHO_PAGINA - MARGEN) break

      doc.rect(x, y, ANCHO_CAJA, 38).fill(GRIS_FONDO)
      doc.font('Helvetica').fontSize(6).fillColor(GRIS_TEXTO)
         .text((FORMAS[r.forma_pago] ?? r.forma_pago).toUpperCase(), x + 7, y + 6, {
           width: ANCHO_CAJA - 14,
           lineBreak: false,
         })
      doc.font('Helvetica-Bold').fontSize(11).fillColor(NEGRO)
         .text(dinero(r.monto), x + 7, y + 15, { width: ANCHO_CAJA - 14 })
      doc.font('Helvetica').fontSize(6.2).fillColor(GRIS_TEXTO)
         .text(
           `${r.facturas} factura${Number(r.facturas) === 1 ? '' : 's'} · ${r.abonados} abonado${Number(r.abonados) === 1 ? '' : 's'}`,
           x + 7, y + 28,
           { width: ANCHO_CAJA - 14, lineBreak: false },
         )
    }
    y += 48
  }

  y = encabezadoTabla(doc, y)

  const ALTO_FILA = 13

  for (const f of filas) {
    if (y + ALTO_FILA > ALTO_PAGINA - MARGEN - 12) {
      doc.addPage()
      y = encabezadoTabla(doc, MARGEN)
    }

    let x = MARGEN
    for (const c of COLUMNAS) {
      doc.font('Helvetica').fontSize(6.4).fillColor(NEGRO)
      const v = f[c.clave]
      const texto = c.numero
        ? (v == null ? '' : Number(v).toFixed(c.clave === 'costo_con_impuestos' ? 2 : 1))
        : String(v ?? '')

      doc.text(recortar(doc, texto, c.pdf), x + 2, y + 3.5, {
        width: c.pdf - 4,
        align: c.derecha ? 'right' : 'left',
        lineBreak: false,
      })
      x += c.pdf
    }

    doc.moveTo(MARGEN, y + ALTO_FILA).lineTo(MARGEN + ANCHO_TABLA, y + ALTO_FILA)
       .lineWidth(0.3).strokeColor(BORDE).stroke()

    y += ALTO_FILA
  }

  if (!filas.length) {
    doc.font('Helvetica').fontSize(9).fillColor(GRIS_TEXTO)
       .text('No hay facturas autorizadas por el SRI en este período.', MARGEN, y + 10)
  }

  const paginas = doc.bufferedPageRange()
  for (let i = 0; i < paginas.count; i++) {
    doc.switchToPage(i)
    doc.font('Helvetica').fontSize(6.5).fillColor(GRIS_TEXTO)
       .text(`Página ${i + 1} de ${paginas.count}`, MARGEN, ALTO_PAGINA - MARGEN + 5, {
         width: ANCHO_TABLA,
         align: 'right',
       })
  }

  doc.end()
  return listo
}
