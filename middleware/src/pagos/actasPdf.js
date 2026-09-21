import PDFDocument from 'pdfkit'

/**
 * Las dos actas del circuito de retiro, en PDF.
 *
 * ── Por qué existen ──
 *
 * Porque las firmas se guardaban y no las veía nadie. Una firma que no se puede
 * mostrar no sirve para lo único que sirve una firma: que dos personas puedan
 * mirar el mismo papel cuando no se ponen de acuerdo.
 *
 * Son dos momentos distintos y por eso son dos actas:
 *
 *   RETIRO   El abonado entrega el equipo al técnico, en la puerta de su casa.
 *            Firma quien entrega — casi nunca el titular.
 *   ENTREGA  El técnico entrega lo recuperado a la oficina. Firma quien recibe,
 *            que no puede ser el mismo que entrega.
 *
 * ── Lo que NO son ──
 *
 * Documentos con validez fiscal ni firma electrónica certificada. Son el
 * respaldo interno de que una cosa pasó, con quién y cuándo. Para una entrega
 * entre el técnico y su oficina, eso es exactamente lo que hace falta.
 */

const GRIS = '#6b7280'
const NEGRO = '#111827'

const fecha = (f) => {
  if (!f) return '—'
  const d = new Date(f)
  if (Number.isNaN(d.getTime())) return '—'
  const dd = (n) => String(n).padStart(2, '0')
  return `${dd(d.getDate())}/${dd(d.getMonth() + 1)}/${d.getFullYear()} ${dd(d.getHours())}:${dd(d.getMinutes())}`
}

const dinero = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`)

/** El membrete, el título y el número. */
function encabezado(doc, { empresa, titulo, numero, cuando }) {
  if (empresa?.logo_b64) {
    try {
      doc.image(Buffer.from(String(empresa.logo_b64).split(',').pop(), 'base64'), 40, 36, {
        fit: [110, 44],
      })
    } catch {
      // Un logo ilegible no puede impedir que se imprima el acta.
    }
  }

  doc
    .fillColor(NEGRO)
    .fontSize(15)
    .text(empresa?.nombre_sistema ?? 'Sistema', 165, 40, { width: 390, align: 'right' })
    .fontSize(9)
    .fillColor(GRIS)
    .text(titulo.toUpperCase(), { width: 390, align: 'right' })

  if (numero != null) {
    doc.fontSize(11).fillColor(NEGRO).text(`N° ${numero}`, { width: 390, align: 'right' })
  }
  doc.fontSize(8).fillColor(GRIS).text(fecha(cuando), { width: 390, align: 'right' })

  doc.moveTo(40, 96).lineTo(555, 96).strokeColor('#d1d5db').stroke()
  doc.y = 112
}

/** Un par etiqueta/valor. */
function dato(doc, etiqueta, valor, x = 40, ancho = 250) {
  const y = doc.y
  doc.fontSize(7.5).fillColor(GRIS).text(etiqueta.toUpperCase(), x, y, { width: ancho })
  doc.fontSize(10).fillColor(NEGRO).text(valor ?? '—', x, doc.y, { width: ancho })
  return doc.y
}

function seccion(doc, titulo) {
  doc.moveDown(0.8)
  doc.fontSize(8).fillColor(GRIS).text(titulo.toUpperCase(), 40, doc.y)
  doc.moveTo(40, doc.y + 2).lineTo(555, doc.y + 2).strokeColor('#e5e7eb').stroke()
  doc.moveDown(0.5)
}

/**
 * La firma, con su línea y el nombre debajo.
 *
 * Si no hay imagen se dibuja igual la línea y se aclara que no se firmó: un
 * espacio en blanco sin explicación se lee como un error de impresión.
 */
function firma(doc, { titulo, imagen, nombre, cuando, x, ancho = 230 }) {
  const base = doc.y + 70

  if (imagen) {
    try {
      doc.image(Buffer.from(String(imagen).split(',').pop(), 'base64'), x, doc.y, {
        fit: [ancho, 62],
        align: 'center',
      })
    } catch {
      doc.fontSize(8).fillColor(GRIS).text('(firma no legible)', x, doc.y + 40, {
        width: ancho,
        align: 'center',
      })
    }
  } else {
    doc.fontSize(8).fillColor(GRIS).text('sin firma', x, doc.y + 40, {
      width: ancho,
      align: 'center',
    })
  }

  doc.moveTo(x, base).lineTo(x + ancho, base).strokeColor('#9ca3af').stroke()
  doc.fontSize(9).fillColor(NEGRO).text(nombre || '—', x, base + 4, { width: ancho, align: 'center' })
  doc.fontSize(7.5).fillColor(GRIS).text(titulo, x, doc.y, { width: ancho, align: 'center' })
  if (cuando) {
    doc.fontSize(7).fillColor(GRIS).text(fecha(cuando), x, doc.y, { width: ancho, align: 'center' })
  }
}

const pie = (doc) =>
  doc
    .fontSize(7)
    .fillColor(GRIS)
    .text(
      'Documento generado por el sistema como respaldo interno de la operación. No constituye comprobante fiscal.',
      40,
      780,
      { width: 515, align: 'center' },
    )

const aBuffer = (doc) =>
  new Promise((resolver) => {
    const partes = []
    doc.on('data', (p) => partes.push(p))
    doc.on('end', () => resolver(Buffer.concat(partes)))
    doc.end()
  })

// ---------------------------------------------------------------------------

/**
 * Acta de retiro: el abonado entregó el equipo — o no.
 *
 * Lleva las visitas porque son la historia de cómo se llegó a ese momento, y
 * porque en el caso contrario —el equipo que no volvió— son lo único que
 * respalda la decisión frente a quien la cuestione.
 */
export async function generarActaRetiro({ empresa, retiro, cliente, visitas = [] }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 })
  const recuperado = retiro.estado === 'recuperado'

  encabezado(doc, {
    empresa,
    titulo: recuperado ? 'Acta de retiro de equipo' : 'Acta de equipo no recuperado',
    numero: cliente?.codigo != null ? String(cliente.codigo).padStart(6, '0') : null,
    cuando: retiro.cerrado_en,
  })

  seccion(doc, 'Abonado')
  const y0 = doc.y
  dato(doc, 'Nombre', cliente?.nombre)
  dato(doc, 'Identificación', cliente?.identificacion)
  const yIzq = doc.y
  doc.y = y0
  dato(doc, 'Dirección', cliente?.direccion, 305, 250)
  dato(doc, 'Teléfono', cliente?.telefono_movil ?? cliente?.telefono, 305, 250)
  doc.y = Math.max(yIzq, doc.y)

  seccion(doc, 'Equipo')
  const y1 = doc.y
  dato(doc, 'Serie', retiro.serie)
  dato(doc, 'Modelo', retiro.modelo)
  const yIzq2 = doc.y
  doc.y = y1
  dato(doc, 'Valor', dinero(retiro.valor), 305, 250)
  dato(doc, 'Meses sin pagar', String(retiro.meses_sin_pago ?? '—'), 305, 250)
  doc.y = Math.max(yIzq2, doc.y)

  if (visitas.length) {
    seccion(doc, `Visitas realizadas (${visitas.length})`)
    visitas.forEach((v, i) => {
      doc
        .fontSize(8.5)
        .fillColor(NEGRO)
        .text(`${i + 1}. ${fecha(v.creado_en)} — ${v.resultado}`, 40, doc.y, { width: 515 })
      if (v.observacion) {
        doc.fontSize(8.5).fillColor(GRIS).text(`“${v.observacion}”`, 52, doc.y, { width: 503 })
      }
      doc.moveDown(0.3)
    })
  }

  seccion(doc, 'Resultado')
  doc
    .fontSize(10)
    .fillColor(NEGRO)
    .text(
      recuperado
        ? 'El equipo detallado fue ENTREGADO por el abonado y retirado por el personal de la empresa.'
        : `El equipo NO pudo ser recuperado. Motivo registrado: ${retiro.categoria_cierre ?? retiro.motivo ?? 'sin especificar'}.`,
      40,
      doc.y,
      { width: 515 },
    )

  if (retiro.observaciones) {
    doc.moveDown(0.4)
    doc.fontSize(9).fillColor(GRIS).text(retiro.observaciones, 40, doc.y, { width: 515 })
  }

  doc.moveDown(2.5)
  const yFirmas = doc.y
  firma(doc, {
    titulo: 'Entrega el equipo',
    imagen: retiro.firma_b64,
    nombre: retiro.firmante,
    cuando: retiro.firmado_en,
    x: 40,
  })
  doc.y = yFirmas
  firma(doc, {
    titulo: 'Retira — personal de la empresa',
    imagen: null,
    nombre: retiro.responsable ?? retiro.tecnico,
    cuando: retiro.cerrado_en,
    x: 315,
  })

  pie(doc)
  return aBuffer(doc)
}

// ---------------------------------------------------------------------------

/** Acta de entrega: el técnico devolvió el material a la oficina. */
export async function generarActaEntrega({ empresa, acta, items = [] }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 })

  encabezado(doc, {
    empresa,
    titulo: 'Acta de entrega de equipos',
    numero: acta.numero,
    cuando: acta.creado_en,
  })

  seccion(doc, 'Movimiento')
  const y0 = doc.y
  dato(doc, 'Entrega', acta.entrega)
  dato(doc, 'Desde', acta.almacen_origen)
  const yIzq = doc.y
  doc.y = y0
  dato(doc, 'Recibe', acta.recibe, 305, 250)
  dato(doc, 'Ingresa a', acta.almacen_destino, 305, 250)
  doc.y = Math.max(yIzq, doc.y)

  seccion(doc, `Equipos entregados (${items.length})`)

  doc.fontSize(7.5).fillColor(GRIS)
  const yEnc = doc.y
  doc.text('N°', 40, yEnc, { width: 25 })
  doc.text('SERIE', 65, yEnc, { width: 160 })
  doc.text('MODELO', 225, yEnc, { width: 200 })
  doc.text('ESTADO', 425, yEnc, { width: 130 })
  doc.moveTo(40, yEnc + 11).lineTo(555, yEnc + 11).strokeColor('#e5e7eb').stroke()
  doc.y = yEnc + 16

  items.forEach((it, i) => {
    const y = doc.y
    doc.fontSize(9).fillColor(NEGRO)
    doc.text(String(i + 1), 40, y, { width: 25 })
    doc.text(it.serie ?? '—', 65, y, { width: 160 })
    doc.text(it.modelo ?? '—', 225, y, { width: 200 })
    doc.text(it.estado_fisico ?? 'bueno', 425, y, { width: 130 })
    if (it.observacion) {
      doc.fontSize(8).fillColor(GRIS).text(it.observacion, 65, doc.y, { width: 490 })
    }
    doc.moveDown(0.3)
  })

  if (acta.notas) {
    seccion(doc, 'Observaciones')
    doc.fontSize(9).fillColor(NEGRO).text(acta.notas, 40, doc.y, { width: 515 })
  }

  doc.moveDown(2.5)
  const yFirmas = doc.y
  firma(doc, {
    titulo: 'Entrega — técnico',
    imagen: acta.firma_entrega_b64,
    nombre: acta.entrega,
    cuando: acta.firma_entrega_en ?? acta.creado_en,
    x: 40,
  })
  doc.y = yFirmas
  firma(doc, {
    titulo: 'Recibe — oficina',
    imagen: acta.firma_b64,
    nombre: acta.recibe,
    cuando: acta.firmado_en,
    x: 315,
  })

  pie(doc)
  return aBuffer(doc)
}
