import PDFDocument from 'pdfkit'

import { aBloques, aTextoPlano } from './textoRico.js'

/**
 * El motor de los documentos que se escriben desde el editor de plantillas.
 *
 * ── Cuáles pasan por acá y cuáles no ──
 *
 * PASAN el contrato, la hoja de instalación y la impresión de ticket. Los tres
 * son lo mismo visto de distinta manera: un texto que el ISP redacta, unos datos
 * que se le reemplazan y una firma al pie. Lo que cambia entre ellos es el texto
 * —y para eso está el editor—.
 *
 * NO PASAN la factura, el recibo y el RIDE. Ahí lo que importa es dónde va cada
 * número, el código de barras y, en el RIDE, un formato que exige el SRI.
 * Armarlos desde una plantilla sería cambiar precisión por flexibilidad en los
 * únicos documentos donde la precisión es el punto. Esos reciben del editor sus
 * textos de encabezado y de pie, y nada más.
 */

const MARGEN = 56
const ANCHO_PAGINA = 595.28
const ANCHO = ANCHO_PAGINA - MARGEN * 2

const GRIS = '#555555'

/** Cómo se dibuja cada clase de bloque. */
const ESTILOS = {
  h1: { tamano: 15, espacio: 14, negrita: true, centrado: true },
  h2: { tamano: 12, espacio: 10, negrita: true },
  h3: { tamano: 11, espacio: 8, negrita: true },
  parrafo: { tamano: 9.5, espacio: 7, interlineado: true },
  item: { tamano: 9.5, espacio: 4, sangria: 14, vinieta: true },
}

/**
 * Dibuja el texto.
 *
 * Se controla el salto de página a mano: pdfkit lo hace solo, pero corta a
 * mitad de un párrafo. En un contrato eso deja una cláusula partida entre dos
 * hojas, y quien lo firma tiene que ir y volver para leerla entera.
 */
function escribirBloques(doc, bloques) {
  for (const b of bloques) {
    if (b.tipo === 'linea') {
      doc.moveDown(0.4)
      doc.strokeColor('#cccccc').lineWidth(0.5)
        .moveTo(MARGEN, doc.y).lineTo(MARGEN + ANCHO, doc.y).stroke()
      doc.moveDown(0.6)
      continue
    }

    const e = ESTILOS[b.tipo] ?? ESTILOS.parrafo
    const texto = e.vinieta ? `•  ${b.texto}` : b.texto
    const x = MARGEN + (e.sangria ?? 0)
    const ancho = ANCHO - (e.sangria ?? 0)

    doc.font(e.negrita || b.fuerte ? 'Helvetica-Bold' : 'Helvetica').fontSize(e.tamano)

    // Cuánto va a ocupar. Si no entra en lo que queda de hoja, se pasa entero.
    const alto = doc.heightOfString(texto, { width: ancho, lineGap: 2 })
    if (doc.y + alto > doc.page.height - MARGEN - 40) doc.addPage()

    doc.fillColor('#000000').text(texto, x, doc.y, {
      width: ancho,
      align: e.centrado ? 'center' : 'justify',
      lineGap: e.interlineado ? 2 : 0,
    })
    doc.moveDown(e.espacio / 10)
  }
}

/** Decodifica una firma guardada como data URL o base64 pelado. */
function imagenDe(b64) {
  if (!b64) return null
  try {
    const limpio = String(b64).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '')
    return limpio ? Buffer.from(limpio, 'base64') : null
  } catch {
    return null
  }
}

/**
 * El bloque de firmas, al pie y sin partirse entre dos hojas.
 *
 * Cuando la firma se capturó en la tablet se dibuja SOBRE la raya. Eso es lo que
 * convierte a la hoja de instalación en un respaldo: la firma existía y no se
 * podía mostrar, y una firma que no se puede mostrar no sirve para lo único que
 * sirve una firma.
 */
function firmar(doc, firmas) {
  if (!firmas.length) return

  const ALTO = 96
  if (doc.y + ALTO > doc.page.height - MARGEN) doc.addPage()

  doc.moveDown(2)
  const y = Math.max(doc.y + 30, doc.page.height - MARGEN - ALTO + 30)
  const hueco = 40
  const ancho = (ANCHO - hueco * (firmas.length - 1)) / firmas.length

  for (const [i, quien] of firmas.entries()) {
    const x = MARGEN + i * (ancho + hueco)

    const imagen = imagenDe(quien.imagen_b64)
    if (imagen) {
      try {
        // Encima de la raya y centrada. `fit` respeta la proporción: una firma
        // ancha no se estira ni pisa a la de al lado.
        doc.image(imagen, x, y - 34, { fit: [ancho, 30], align: 'center' })
      } catch {
        // Una firma ilegible no puede impedir que salga el documento.
      }
    }

    doc.strokeColor('#000000').lineWidth(0.7).moveTo(x, y).lineTo(x + ancho, y).stroke()
    doc.font('Helvetica').fontSize(8.5).fillColor('#000000')
      .text(quien.nombre || '', x, y + 6, { width: ancho, align: 'center' })
    if (quien.pie) {
      doc.fontSize(7.5).fillColor(GRIS)
        .text(quien.pie, x, y + 18, { width: ancho, align: 'center' })
    }
  }
}

/**
 * Arma un documento a partir del texto de su plantilla.
 *
 * `plantilla` llega con sus marcadores ya reemplazados: quien llama decide de
 * dónde sale el texto y con qué datos se llena. Acá solo se dibuja.
 */
export function generarDocumento({
  plantilla,
  empresa = {},
  logo = null,
  firmas = [],
  pie = '',
}) {
  const doc = new PDFDocument({ size: 'A4', margin: MARGEN, bufferPages: true })
  const trozos = []
  doc.on('data', (d) => trozos.push(d))
  const listo = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(trozos))))

  // El membrete: quién emite este papel. Va aunque la plantilla no lo pida,
  // porque un documento sin identificar al proveedor no sirve de nada.
  if (logo) {
    try {
      doc.image(logo, MARGEN, MARGEN - 12, { height: 34 })
    } catch {
      // Un logo ilegible no puede impedir que salga el documento.
    }
  }

  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000')
    .text(empresa.nombre_comercial || empresa.razon_social || '', MARGEN + 44, MARGEN - 8, {
      width: ANCHO - 44,
    })
  doc.font('Helvetica').fontSize(8).fillColor(GRIS)
    .text([empresa.ruc && `RUC ${empresa.ruc}`, empresa.telefono].filter(Boolean).join(' · '), {
      width: ANCHO - 44,
    })

  doc.moveDown(1.5)
  doc.x = MARGEN

  escribirBloques(doc, aBloques(plantilla))
  firmar(doc, firmas)

  /**
   * El pie de cada hoja: de qué documento es y cuántas hojas son.
   *
   * Sin la referencia, dos documentos del mismo abonado son indistinguibles. Sin
   * el "hoja 1 de 3", nadie sabe si le entregaron el papel completo — y ese es
   * justamente el reclamo que aparece meses después.
   */
  const paginas = doc.bufferedPageRange()
  for (let i = 0; i < paginas.count; i++) {
    doc.switchToPage(paginas.start + i)
    doc.font('Helvetica').fontSize(7).fillColor(GRIS).text(
      [pie, `Hoja ${i + 1} de ${paginas.count}`].filter(Boolean).join('   ·   '),
      MARGEN,
      doc.page.height - MARGEN + 12,
      { width: ANCHO, align: 'center' },
    )
  }

  doc.end()
  return listo
}

/**
 * El mismo texto para una impresora térmica.
 *
 * ── Por qué no es un PDF ──
 *
 * Porque una tirilla de 58 mm no se pagina ni se justifica: la impresora recibe
 * líneas y las escupe. Mandarle un PDF obligaría al navegador a abrir un diálogo
 * de impresión con márgenes de hoja A4, que es exactamente lo que no se quiere
 * cuando alguien está cobrando en el mostrador.
 *
 * `ancho` es en caracteres, que es como se mide una térmica: 32 para 58 mm,
 * 48 para 80 mm.
 */
export function generarTirilla({ plantilla, ancho = 32 }) {
  const lineas = []

  for (const cruda of aTextoPlano(plantilla).split('\n')) {
    // Una línea de guiones se recorta al ancho real en vez de doblarse en dos.
    if (/^[-=*_]{3,}$/.test(cruda.trim())) {
      lineas.push(cruda.trim()[0].repeat(ancho))
      continue
    }

    // El resto se corta por palabras: partir "TRANSFERENCIA" a la mitad haría
    // ilegible justo el dato que el abonado busca.
    let linea = ''
    for (const palabra of cruda.split(/\s+/)) {
      if (!palabra) continue
      if (!linea) {
        linea = palabra
      } else if (linea.length + 1 + palabra.length <= ancho) {
        linea += ` ${palabra}`
      } else {
        lineas.push(linea)
        linea = palabra
      }
      // Una palabra sola más larga que la tirilla sí se parte: no hay otra.
      while (linea.length > ancho) {
        lineas.push(linea.slice(0, ancho))
        linea = linea.slice(ancho)
      }
    }
    lineas.push(linea)
  }

  return lineas.join('\n')
}
