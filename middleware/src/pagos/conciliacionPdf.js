/**
 * El informe de conciliación, en papel.
 *
 * ── Para qué se imprime ──
 *
 * Para revisarlo con alguien al lado y para salir a llamar. Por eso lleva las
 * cuatro listas completas y no solo el resumen: el resumen dice cuánta plata
 * falta, y lo que hay que hacer con eso está en el detalle.
 *
 * ── Por qué los conciliados también se imprimen ──
 *
 * Porque conciliado no quiere decir correcto. El cruce empareja un número de
 * comprobante con otro igual; que ese pago sea del abonado al que se le acreditó
 * es una comprobación que hace una persona, mirando el nombre al lado del monto.
 * Un informe que solo muestre los problemas obliga a confiar a ciegas en el resto.
 */

import PDFDocument from 'pdfkit'

const MARGEN = 34
const ANCHO_PAGINA = 595.28
const ALTO_PAGINA = 841.89
const ANCHO = ANCHO_PAGINA - MARGEN * 2

const GRIS_FONDO = '#eef2f3'
const GRIS_TEXTO = '#6b7280'
const NEGRO = '#111827'
const BORDE = '#d1d5db'
const ROJO = '#b91c1c'
const AMBAR = '#b45309'
const VERDE = '#047857'

const REGULAR = 'Helvetica'
const NEGRITA = 'Helvetica-Bold'

const dinero = (n) => `$${(Number(n) || 0).toFixed(2)}`

/** dd/mm/aaaa desde una fecha en texto, sin pasar por `new Date`. */
function fecha(valor) {
  const s = String(valor ?? '').slice(0, 10)
  const [a, m, d] = s.split('-')
  return d ? `${d}/${m}/${a}` : s
}

/** Recorta lo que no entra, con puntos suspensivos. */
function recortar(doc, texto, ancho) {
  const t = String(texto ?? '')
  if (doc.widthOfString(t) <= ancho - 6) return t
  let corto = t
  while (corto.length > 1 && doc.widthOfString(`${corto}…`) > ancho - 6) corto = corto.slice(0, -1)
  return `${corto}…`
}

/**
 * Una sección con su tabla.
 *
 * Devuelve la `y` donde quedó. El salto de página se decide fila por fila y no
 * por sección: una lista de doscientos movimientos no cabe en una hoja, y
 * cortarla entera al empezar dejaría páginas casi vacías.
 */
function seccion(doc, y, { titulo, nota, color, columnas, filas, vacio }) {
  const ALTO_FILA = 13
  const anchoTotal = columnas.reduce((s, c) => s + c.ancho, 0)

  const encabezado = (yy) => {
    doc.rect(MARGEN, yy, anchoTotal, 15).fill(GRIS_FONDO)
    doc.font(NEGRITA).fontSize(6.8).fillColor(GRIS_TEXTO)
    let x = MARGEN
    for (const c of columnas) {
      doc.text(c.titulo.toUpperCase(), x + 3, yy + 4.5, {
        width: c.ancho - 6,
        align: c.derecha ? 'right' : 'left',
        lineBreak: false,
      })
      x += c.ancho
    }
    return yy + 15
  }

  // El título de la sección, con el conteo: es lo primero que se busca.
  if (y + 60 > ALTO_PAGINA - MARGEN) {
    doc.addPage()
    y = MARGEN
  }

  doc.font(NEGRITA).fontSize(10).fillColor(color ?? NEGRO)
     .text(`${titulo}  (${filas.length})`, MARGEN, y, { width: ANCHO })
  y += 13

  if (nota) {
    doc.font(REGULAR).fontSize(7.5).fillColor(GRIS_TEXTO)
       .text(nota, MARGEN, y, { width: ANCHO })
    y += 11
  }

  y += 3

  if (!filas.length) {
    doc.font(REGULAR).fontSize(8).fillColor(GRIS_TEXTO)
       .text(vacio ?? 'Ninguno.', MARGEN, y, { width: ANCHO })
    return y + 22
  }

  y = encabezado(y)

  for (const f of filas) {
    if (y + ALTO_FILA > ALTO_PAGINA - MARGEN - 10) {
      doc.addPage()
      y = encabezado(MARGEN)
    }

    let x = MARGEN
    for (const c of columnas) {
      doc.font(c.fuerte ? NEGRITA : REGULAR).fontSize(7.2).fillColor(c.color?.(f) ?? NEGRO)
      doc.text(recortar(doc, c.valor(f), c.ancho), x + 3, y + 3.5, {
        width: c.ancho - 6,
        align: c.derecha ? 'right' : 'left',
        lineBreak: false,
      })
      x += c.ancho
    }

    doc.moveTo(MARGEN, y + ALTO_FILA).lineTo(MARGEN + anchoTotal, y + ALTO_FILA)
       .lineWidth(0.3).strokeColor(BORDE).stroke()

    y += ALTO_FILA
  }

  return y + 18
}

/** El informe completo. */
export function generarConciliacionPdf({ empresa = {}, informe = {}, cuenta = null, logo = null }) {
  const doc = new PDFDocument({
    size: [ANCHO_PAGINA, ALTO_PAGINA],
    margin: MARGEN,
    bufferPages: true,
    info: { Title: 'Conciliación bancaria', Author: empresa.razon_social ?? '' },
  })

  const trozos = []
  doc.on('data', (d) => trozos.push(d))
  const listo = new Promise((res) => doc.on('end', () => res(Buffer.concat(trozos))))

  const t = informe.totales ?? {}
  let y = MARGEN

  // ── Encabezado ──
  if (logo) {
    try {
      doc.image(logo, MARGEN, y, { fit: [100, 34] })
    } catch {
      // Un logo ilegible no puede impedir el informe.
    }
  }

  doc.font(NEGRITA).fontSize(14).fillColor(NEGRO)
     .text('Conciliación bancaria', MARGEN + (logo ? 112 : 0), y, { width: 300 })
  doc.font(REGULAR).fontSize(8).fillColor(GRIS_TEXTO)
     .text(empresa.nombre_comercial || empresa.razon_social || '', MARGEN + (logo ? 112 : 0), y + 18, {
       width: 300,
     })

  const datos = [
    ['Cuenta', cuenta || 'Todas las electrónicas'],
    [
      'Período del extracto',
      informe.periodo ? `${fecha(informe.periodo.desde)} al ${fecha(informe.periodo.hasta)}` : '—',
    ],
    ['Movimientos del banco', String(informe.movimientos_banco ?? 0)],
    ['Cobros del sistema', String(informe.cobros_sistema ?? 0)],
  ]

  let yd = MARGEN
  for (const [k, v] of datos) {
    doc.font(REGULAR).fontSize(7).fillColor(GRIS_TEXTO)
       .text(`${k}:`, ANCHO_PAGINA - MARGEN - 240, yd, { width: 110, align: 'right' })
    doc.font(NEGRITA).fontSize(7).fillColor(NEGRO)
       .text(v, ANCHO_PAGINA - MARGEN - 126, yd, { width: 126, align: 'right', lineBreak: false })
    yd += 10
  }

  y = Math.max(y + 42, yd + 8)

  // ── El resumen de plata ──
  const cajas = [
    ['Entró al banco', dinero(t.banco), NEGRO],
    ['Conciliado', dinero(t.conciliado), VERDE],
    ['Sin respaldo', dinero(t.sin_respaldo), ROJO],
    ['No registrado', dinero(t.no_registrado), AMBAR],
  ]

  const anchoCaja = (ANCHO - 12) / 4
  for (const [i, [titulo, valor, color]] of cajas.entries()) {
    const x = MARGEN + i * (anchoCaja + 4)
    doc.rect(x, y, anchoCaja, 40).fill(GRIS_FONDO)
    doc.font(REGULAR).fontSize(6.8).fillColor(GRIS_TEXTO)
       .text(titulo.toUpperCase(), x + 8, y + 7, { width: anchoCaja - 16 })
    doc.font(NEGRITA).fontSize(13).fillColor(color)
       .text(valor, x + 8, y + 18, { width: anchoCaja - 16 })
  }

  y += 54

  // ── Las cuatro listas ──

  /**
   * Los conciliados van primero y con el nombre del abonado al lado.
   *
   * Es lo que permite comprobar a ojo que el pago se le acreditó a quien
   * corresponde: el cruce empareja números iguales, no garantiza que el
   * comprobante fuera de ese abonado.
   */
  y = seccion(doc, y, {
    titulo: 'Conciliados',
    nota: 'Están en el banco y en el sistema, por el mismo monto. Revisá que el abonado sea el que corresponde.',
    color: VERDE,
    columnas: [
      { titulo: 'Fecha', ancho: 52, valor: (c) => fecha(c.fecha_pago) },
      { titulo: 'Documento', ancho: 66, valor: (c) => c.n_transaccion ?? '' },
      { titulo: 'Abonado', ancho: 150, fuerte: true, valor: (c) => c.cliente ?? '' },
      { titulo: 'Factura', ancho: 56, valor: (c) => (c.numero_factura ? String(c.numero_factura) : '') },
      { titulo: 'Registró', ancho: 92, valor: (c) => c.operador ?? '(sistema)' },
      { titulo: 'Valor', ancho: 58, derecha: true, valor: (c) => dinero(c.cobrado) },
    ],
    filas: informe.conciliados ?? [],
    vacio: 'Ningún comprobante del sistema apareció en el extracto.',
  })

  y = seccion(doc, y, {
    titulo: 'A quién llamar',
    nota: 'Registrados como cobrados y sin respaldo en el extracto: la plata no entró.',
    color: ROJO,
    columnas: [
      { titulo: 'Abonado', ancho: 132, fuerte: true, valor: (c) => c.cliente ?? '' },
      { titulo: 'Teléfono', ancho: 74, valor: (c) => c.telefono ?? 'sin teléfono' },
      { titulo: 'Documento', ancho: 66, valor: (c) => c.n_transaccion ?? '—' },
      { titulo: 'Fecha', ancho: 52, valor: (c) => fecha(c.fecha_pago) },
      { titulo: 'Valor', ancho: 54, derecha: true, fuerte: true, valor: (c) => dinero(c.cobrado) },
      { titulo: 'Motivo', ancho: 96, valor: (c) => c.motivo ?? '' },
    ],
    filas: informe.sin_respaldo ?? [],
    vacio: 'Todos los cobros registrados tienen respaldo en el banco.',
  })

  y = seccion(doc, y, {
    titulo: 'Entró al banco y nadie lo registró',
    nota: 'Alguien pagó y no se le acreditó. Sin cargarlo, se lo corta habiendo pagado.',
    color: AMBAR,
    columnas: [
      { titulo: 'Fecha', ancho: 52, valor: (m) => fecha(m.fecha) },
      { titulo: 'Hora', ancho: 34, valor: (m) => String(m.hora ?? '').slice(0, 5) },
      { titulo: 'Documento', ancho: 66, valor: (m) => m.documento ?? '' },
      { titulo: 'Quién', ancho: 140, fuerte: true, valor: (m) => m.probable_nombre || '—' },
      { titulo: 'Concepto', ancho: 128, valor: (m) => m.concepto ?? '' },
      { titulo: 'Valor', ancho: 54, derecha: true, valor: (m) => dinero(m.monto) },
    ],
    filas: informe.no_registrados ?? [],
    vacio: 'Todo lo que entró al banco está registrado.',
  })

  if ((informe.monto_distinto ?? []).length) {
    y = seccion(doc, y, {
      titulo: 'Mismo documento, distinto monto',
      nota: 'El comprobante existe pero por otro valor: hay que corregir el registrado.',
      color: AMBAR,
      columnas: [
        { titulo: 'Abonado', ancho: 150, fuerte: true, valor: (c) => c.cliente ?? '' },
        { titulo: 'Documento', ancho: 70, valor: (c) => c.n_transaccion ?? '' },
        { titulo: 'En el sistema', ancho: 78, derecha: true, valor: (c) => dinero(c.cobrado) },
        { titulo: 'En el banco', ancho: 78, derecha: true, valor: (c) => dinero(c.banco?.monto) },
        {
          titulo: 'Diferencia',
          ancho: 78,
          derecha: true,
          fuerte: true,
          color: (c) => (Number(c.diferencia) > 0 ? VERDE : ROJO),
          valor: (c) => `${Number(c.diferencia) > 0 ? '+' : ''}${dinero(c.diferencia)}`,
        },
      ],
      filas: informe.monto_distinto,
    })
  }

  /**
   * Lo que no se pudo leer del archivo.
   *
   * Va al final y solo si hubo: es plata que el banco reporta y la conciliación
   * no vio. Omitirlo haría que el informe parezca completo cuando no lo está.
   */
  if ((informe.ilegibles ?? []).length) {
    if (y + 40 > ALTO_PAGINA - MARGEN) {
      doc.addPage()
      y = MARGEN
    }
    doc.font(REGULAR).fontSize(7.5).fillColor(ROJO)
       .text(
         `${informe.ilegibles.length} fila${informe.ilegibles.length === 1 ? '' : 's'} del extracto no se pudieron leer y quedaron fuera de esta comparación.`,
         MARGEN, y, { width: ANCHO },
       )
  }

  // ── Numeración y sello ──
  const paginas = doc.bufferedPageRange()
  const emitido = new Intl.DateTimeFormat('es-EC', {
    timeZone: 'America/Guayaquil',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date())

  for (let i = 0; i < paginas.count; i++) {
    doc.switchToPage(i)
    doc.font(REGULAR).fontSize(6.8).fillColor(GRIS_TEXTO)
       .text(`Emitido ${emitido}`, MARGEN, ALTO_PAGINA - MARGEN + 6, { width: ANCHO / 2 })
    doc.font(REGULAR).fontSize(6.8).fillColor(GRIS_TEXTO)
       .text(`Página ${i + 1} de ${paginas.count}`, MARGEN, ALTO_PAGINA - MARGEN + 6, {
         width: ANCHO,
         align: 'right',
       })
  }

  doc.end()
  return listo
}
