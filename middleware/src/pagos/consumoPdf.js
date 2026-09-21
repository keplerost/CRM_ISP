/**
 * Reporte de consumo de un abonado, en PDF.
 *
 * Es el papel que se le entrega a quien reclama: "yo no bajé tanto" o "me
 * cortaron un día que yo había pagado". Por eso el reporte muestra el día a día
 * y no solo el total — el total no se puede discutir ni verificar, el detalle
 * sí.
 */

import PDFDocument from 'pdfkit'

const MARGEN = 36
const ANCHO_PAGINA = 595.28
const ANCHO = ANCHO_PAGINA - MARGEN * 2

const GRIS_FONDO = '#eef2f3'
const GRIS_TEXTO = '#6b7280'
const NEGRO = '#111827'
const BORDE = '#d1d5db'

const REGULAR = 'Helvetica'
const NEGRITA = 'Helvetica-Bold'

// Los mismos colores de la pantalla: si el papel pinta distinto, el abonado
// cree que son dos datos diferentes.
const COLOR_ESTADO = {
  activo: '#3987e5',
  promesa: '#047857',
  cortado: '#dc2626',
  suspendido: '#9ca3af',
}

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

/** Bytes en la unidad en que se habla del consumo. */
export function enGigas(bytes) {
  const gb = Number(bytes || 0) / 1024 ** 3
  if (gb >= 100) return `${gb.toFixed(0)} GB`
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  const mb = Number(bytes || 0) / 1024 ** 2
  return `${mb.toFixed(1)} MB`
}

function encabezado(doc, x, y, ancho, alto = 20) {
  doc.rect(x, y, ancho, alto).fillColor(GRIS_FONDO).fill()
  doc.rect(x, y, ancho, alto).lineWidth(0.5).strokeColor(BORDE).stroke()
}

export function generarConsumoPdf({ emisor = {}, cliente = {}, mes, dias = [], resumen = {} }) {
  if (!mes) throw new Error('Falta el mes del reporte')

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGEN,
      info: { Title: `Consumo ${mes} — ${cliente.nombre ?? ''}`, Author: emisor.razon_social ?? '' },
    })

    const trozos = []
    doc.on('data', (d) => trozos.push(d))
    doc.on('end', () => resolve(Buffer.concat(trozos)))
    doc.on('error', reject)

    try {
      const [anio, m] = String(mes).split('-').map(Number)
      let y = MARGEN

      // --- Encabezado
      doc.fontSize(14).font(NEGRITA).fillColor(NEGRO)
      doc.text(emisor.nombre_comercial || emisor.razon_social || 'Reporte de consumo', MARGEN, y)
      doc.fontSize(8).font(REGULAR).fillColor(GRIS_TEXTO)
      doc.text(emisor.ruc ? `RUC: ${emisor.ruc}` : '', MARGEN, doc.y + 2)

      doc.fontSize(12).font(NEGRITA).fillColor(NEGRO)
      doc.text('REPORTE DE CONSUMO', MARGEN, y, { width: ANCHO, align: 'right' })
      doc.fontSize(9).font(REGULAR).fillColor(GRIS_TEXTO)
      doc.text(`${MESES[m - 1]} de ${anio}`, MARGEN, doc.y + 2, { width: ANCHO, align: 'right' })

      y = Math.max(doc.y, y + 44) + 10
      doc.moveTo(MARGEN, y).lineTo(MARGEN + ANCHO, y).lineWidth(0.5).strokeColor(BORDE).stroke()
      y += 12

      // --- Abonado
      doc.fontSize(9).font(NEGRITA).fillColor(NEGRO).text('ABONADO', MARGEN, y)
      doc.fontSize(9).font(REGULAR)
      doc.text(cliente.nombre ?? '—', MARGEN, doc.y + 2)
      doc.fontSize(8).fillColor(GRIS_TEXTO)
      doc.text(
        [cliente.identificacion, cliente.ip, cliente.direccion].filter(Boolean).join(' · '),
        MARGEN,
        doc.y + 1,
        { width: ANCHO * 0.6 },
      )

      y = doc.y + 14

      // --- Totales
      const tarjetas = [
        ['DESCARGA', enGigas(resumen.bajada_bytes), '#3987e5'],
        ['SUBIDA', enGigas(resumen.subida_bytes), '#d95926'],
        ['TOTAL', enGigas(Number(resumen.bajada_bytes || 0) + Number(resumen.subida_bytes || 0)), NEGRO],
      ]
      const anchoT = (ANCHO - 16) / 3

      tarjetas.forEach(([etiqueta, valor, color], i) => {
        const x = MARGEN + i * (anchoT + 8)
        doc.rect(x, y, anchoT, 44).fillColor(GRIS_FONDO).fill()
        doc.rect(x, y, anchoT, 44).lineWidth(0.5).strokeColor(BORDE).stroke()
        doc.fontSize(7).font(REGULAR).fillColor(GRIS_TEXTO)
        doc.text(etiqueta, x, y + 8, { width: anchoT, align: 'center' })
        doc.fontSize(14).font(NEGRITA).fillColor(color)
        doc.text(valor, x, y + 20, { width: anchoT, align: 'center' })
      })

      y += 56

      // --- Días con novedad
      const cortados = dias.filter((d) => d.estado_servicio === 'cortado').length
      const conPromesa = dias.filter((d) => d.estado_servicio === 'promesa').length

      if (cortados || conPromesa) {
        doc.fontSize(8).font(REGULAR).fillColor(GRIS_TEXTO)
        doc.text(
          [
            cortados ? `${cortados} ${cortados === 1 ? 'día' : 'días'} con el servicio suspendido` : null,
            conPromesa ? `${conPromesa} ${conPromesa === 1 ? 'día' : 'días'} conectado por compromiso de pago` : null,
          ]
            .filter(Boolean)
            .join(' · '),
          MARGEN,
          y,
          { width: ANCHO },
        )
        y = doc.y + 8
      }

      // --- Gráfica de barras
      //
      // Barras finas y una sola escala. El color dice cómo estuvo el servicio
      // ese día, que es la pregunta que trae el abonado cuando reclama.
      const altoG = 110
      const maxima = Math.max(...dias.map((d) => Number(d.bajada_bytes) + Number(d.subida_bytes)), 1)
      const diasDelMes = new Date(anio, m, 0).getDate()
      const anchoBarra = Math.min(12, (ANCHO - 20) / diasDelMes - 2)
      const paso = (ANCHO - 20) / diasDelMes

      doc.fontSize(9).font(NEGRITA).fillColor(NEGRO).text('Consumo diario', MARGEN, y)
      y = doc.y + 6

      // Piso y techo de la gráfica, para que la barra no flote sin referencia.
      doc.moveTo(MARGEN, y + altoG).lineTo(MARGEN + ANCHO, y + altoG).lineWidth(0.5).strokeColor(BORDE).stroke()

      const porDia = Object.fromEntries(dias.map((d) => [Number(String(d.fecha).slice(8, 10)), d]))

      for (let i = 1; i <= diasDelMes; i++) {
        const d = porDia[i]
        const x = MARGEN + 10 + (i - 1) * paso

        if (!d) continue

        const total = Number(d.bajada_bytes) + Number(d.subida_bytes)
        const alto = Math.max(1, (total / maxima) * altoG)

        doc
          .rect(x, y + altoG - alto, anchoBarra, alto)
          .fillColor(COLOR_ESTADO[d.estado_servicio] ?? COLOR_ESTADO.activo)
          .fill()

        // Solo se rotulan los días 1, 5, 10… El número en cada barra no lo
        // lee nadie y ensucia el eje.
        if (i === 1 || i % 5 === 0) {
          doc.fontSize(6).font(REGULAR).fillColor(GRIS_TEXTO)
          doc.text(String(i), x - 2, y + altoG + 3, { width: anchoBarra + 4, align: 'center' })
        }
      }

      y += altoG + 18

      // --- Referencia de colores
      doc.fontSize(7).font(REGULAR)
      let xr = MARGEN
      for (const [estado, etiqueta] of [
        ['activo', 'Servicio activo'],
        ['promesa', 'Con compromiso de pago'],
        ['cortado', 'Suspendido'],
      ]) {
        doc.rect(xr, y, 7, 7).fillColor(COLOR_ESTADO[estado]).fill()
        doc.fillColor(GRIS_TEXTO).text(etiqueta, xr + 11, y, { lineBreak: false })
        xr += doc.widthOfString(etiqueta) + 28
      }

      y += 20

      // --- Detalle
      doc.fontSize(9).font(NEGRITA).fillColor(NEGRO).text('Detalle por día', MARGEN, y)
      y = doc.y + 6

      encabezado(doc, MARGEN, y, ANCHO, 18)
      doc.fontSize(8).font(NEGRITA).fillColor(NEGRO)
      doc.text('Día', MARGEN + 8, y + 5, { lineBreak: false })
      doc.text('Estado', MARGEN + 70, y + 5, { lineBreak: false })
      doc.text('Descarga', MARGEN + 210, y + 5, { lineBreak: false })
      doc.text('Subida', MARGEN + 320, y + 5, { lineBreak: false })
      doc.text('Total', MARGEN + ANCHO - 90, y + 5, { width: 82, align: 'right' })
      y += 22

      const ETIQUETA = {
        activo: 'Activo',
        promesa: 'Compromiso de pago',
        cortado: 'Suspendido',
        suspendido: 'Suspendido',
      }

      for (const d of dias) {
        if (y > 760) {
          doc.addPage()
          y = MARGEN
        }

        const total = Number(d.bajada_bytes) + Number(d.subida_bytes)
        doc.fontSize(8).font(REGULAR).fillColor(NEGRO)
        doc.text(String(d.fecha).slice(8, 10), MARGEN + 8, y, { lineBreak: false })

        doc.fillColor(COLOR_ESTADO[d.estado_servicio] ?? GRIS_TEXTO)
        doc.text(ETIQUETA[d.estado_servicio] ?? d.estado_servicio, MARGEN + 70, y, { lineBreak: false })

        doc.fillColor(NEGRO)
        doc.text(enGigas(d.bajada_bytes), MARGEN + 210, y, { lineBreak: false })
        doc.text(enGigas(d.subida_bytes), MARGEN + 320, y, { lineBreak: false })
        doc.font(NEGRITA).text(enGigas(total), MARGEN + ANCHO - 90, y, { width: 82, align: 'right' })
        y += 14
      }

      if (!dias.length) {
        doc.fontSize(8).font(REGULAR).fillColor(GRIS_TEXTO)
        doc.text('No hay mediciones registradas para este mes.', MARGEN + 8, y)
        y = doc.y
      }

      // --- Pie
      doc.fontSize(7).font(REGULAR).fillColor(GRIS_TEXTO)
      doc.text(
        'Medición tomada de los contadores del equipo de red. Puede diferir de la que reporte el equipo del abonado, ' +
          'que también cuenta el tráfico de su red interna.',
        MARGEN,
        Math.min(y + 16, 790),
        { width: ANCHO, align: 'center' },
      )

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}
