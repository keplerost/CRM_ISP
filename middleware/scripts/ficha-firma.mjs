import { writeFileSync } from 'node:fs'
import PDFDocument from 'pdfkit'

import { generarContratoArcotel } from '../src/pagos/contratoArcotel.js'

/**
 * La ficha técnica para el proveedor de firma electrónica.
 *
 * ── Por qué es un script y no un PDF guardado ──
 *
 * Porque las coordenadas salen del contrato de verdad: se genera uno, se leen
 * las posiciones donde el código dibujó cada raya, y con eso se arma la ficha.
 *
 * Un PDF escrito a mano quedaría desactualizado el día que el contrato cambie de
 * largo, y nadie se enteraría hasta que el proveedor estampe una firma encima de
 * una cláusula. Acá se vuelve a correr y listo.
 *
 * Uso:
 *   node scripts/ficha-firma.mjs [salida.pdf]
 */

const SALIDA = process.argv[2] ?? 'ficha-firma-electronica.pdf'

// ── Un contrato de ejemplo, del tamaño más grande que se da en la práctica ──
const EJEMPLO = {
  prestador: {
    razon_social: 'OÑA RIERA JEFFERSON FABIAN',
    nombre_comercial: 'HOME LINK-OR',
    ruc: '1250579925001',
    direccion: 'Av. 19 de mayo y Eugenio Espejo',
    provincia: 'Cotopaxi', canton: 'La Maná', ciudad: 'La Maná', parroquia: 'La Maná',
    telefono: '0939145857', email: 'homelinknetor@gmail.com', web: 'https://cnet.net.ec/',
    modelo_inscrito_el: '2025-10-16',
    vigencia_meses: 24, permanencia_meses: 24,
    valor_instalacion: 160, plazo_instalacion: '24 horas',
  },
  cliente: {
    nombre: 'MARIA DE LOS ANGELES SANCHEZ MASAPANTA DE LA CRUZ',
    identificacion: '1206204289',
    direccion: 'Recinto San Pablo de Maldonado, Via a Selva Alegre kilometro 12 y medio',
    provincia: 'Cotopaxi', canton: 'La Maná', ciudad: 'La Maná', parroquia: 'El Carmen',
  },
  plan: {
    nombre: 'PLAN HOME 150/150', precio: 23.1,
    bajada_kbps: 150000, subida_kbps: 150000,
    comparticion: '4:1', minima_bajada_kbps: 120000, minima_subida_kbps: 120000,
    categoria: 'residencial',
  },
  contrato: { numero: '1909' },
  equipos: [['ONT', '', 'VSOL V2802RH', 'VSOL1234ABCD', 'AA:BB:CC:DD:EE:FF', 'Bueno']],
  materiales: Array.from({ length: 8 }, (_, i) => [`Material ${i + 1}`, '5 m', '', '', `SER-${i}`]),
  variables: {
    empresa: 'HOME LINK-OR', ciudad_prestador: 'La Maná',
    vigencia: '2 años', permanencia: '2 años', permanencia_ofrecida: '2 años',
    beneficio_anexo: 'INSTALACIÓN GRATIS',
    costo_no_permanencia: 'EL ABONADO PAGARÁ EL COSTO DE INSTALACIÓN',
    valor_instalacion: 160, plazo_instalacion: '24 horas', inscripcion: '16/10/2025',
    numero: '1909', precio: 23.1,
    fecha: '17/08/2026', fecha_larga: '17 de agosto del año 2026',
    fecha_instalacion: '14/08/2026', fecha_activacion: '14/08/2026',
    forma_pago: 'Transferencia vía medios electrónicos',
    red_acceso: 'Fibra óptica', tipo_cuenta: 'Residencial', equipo_modalidad: 'arrendamiento',
  },
  respuestas: {
    renovacion_automatica: true, permanencia: true, arbitraje: true,
    datos_personales: true, empaquetamiento: false,
  },
}

const contrato = await generarContratoArcotel(EJEMPLO)
const POS = contrato.posicionesDeFirma

// ── Y se comprueba que no se muevan, antes de escribirlas en una ficha ──
const otro = await generarContratoArcotel({
  ...EJEMPLO,
  cliente: { ...EJEMPLO.cliente, nombre: 'ANA MOYA', direccion: 'Av. 5' },
  materiales: [],
})

const clave = (p) => `${p.seccion}|${p.quien}`
const mapa = new Map(otro.posicionesDeFirma.map((p) => [clave(p), p]))
const inestables = POS.filter((p) => {
  const o = mapa.get(clave(p))
  return !o || o.pagina !== p.pagina || o.desde_abajo !== p.desde_abajo
})

if (inestables.length) {
  console.error('\nNO SE GENERÓ LA FICHA.\n')
  console.error('Estas firmas cambian de lugar según el contrato, así que las coordenadas')
  console.error('que dijera esta ficha serían falsas para algunos abonados:\n')
  for (const p of inestables) console.error(`  · ${p.seccion} — ${p.quien}`)
  console.error('\nHay que anclarlas en contratoArcotel.js antes de darle nada al proveedor.\n')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// La ficha
// ---------------------------------------------------------------------------

const M = 50
const ANCHO = 595.28 - M * 2
const doc = new PDFDocument({ size: 'A4', margin: M })
const trozos = []
doc.on('data', (t) => trozos.push(t))
const listo = new Promise((r) => doc.on('end', () => r(Buffer.concat(trozos))))

const titulo = (t) => {
  doc.moveDown(0.8)
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text(t, M, doc.y, { width: ANCHO })
  doc.moveDown(0.3)
}

const parrafo = (t, { negrita = false, tamano = 9 } = {}) => {
  doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(tamano).fillColor('#111')
  doc.text(t, M, doc.y, { width: ANCHO, align: 'justify', lineGap: 1.5 })
  doc.moveDown(0.4)
}

const item = (t) => {
  doc.font('Helvetica').fontSize(9).fillColor('#111')
  doc.text(`•  ${t}`, M + 10, doc.y, { width: ANCHO - 10, lineGap: 1.5 })
  doc.moveDown(0.25)
}

// --- Encabezado
doc.font('Helvetica-Bold').fontSize(16).text('Firma electrónica del contrato', M, M, {
  width: ANCHO,
})
doc.font('Helvetica').fontSize(9.5).fillColor('#555')
doc.text('Ficha técnica para el proveedor — dónde estampar cada firma', M, doc.y + 2, {
  width: ANCHO,
})
doc.moveDown(0.5)
doc.strokeColor('#999').lineWidth(0.7).moveTo(M, doc.y).lineTo(M + ANCHO, doc.y).stroke()

titulo('El documento')
parrafo(
  `Contrato de adhesión de prestación de servicios de telecomunicaciones, modelo inscrito ante `
  + `la ARCOTEL. Se genera en PDF y se manda a firmar completo, en un solo archivo.`,
)
item(`Tamaño de hoja: A4 — 595 × 842 puntos`)
item(`Cantidad de hojas: ${contrato.posicionesDeFirma.at(-1).pagina} (contrato, anexos 1f, 2 y 3, y acta de instalación)`)
item(`Firmas a estampar: ${POS.length} — ${POS.filter((p) => /prestador/i.test(p.quien)).length} del prestador y ${POS.filter((p) => !/prestador/i.test(p.quien)).length} del abonado`)
item('Verificación pedida: huella dactilar y reconocimiento facial')

titulo('Dónde va cada firma')
parrafo(
  'Coordenadas en puntos PDF, con el ORIGEN EN LA ESQUINA INFERIOR IZQUIERDA de cada hoja, que es '
  + 'el sistema del formato PDF. Se incluye también la medida desde arriba por si su sistema usa '
  + 'ese otro origen: son el mismo punto y suman 842.',
  { negrita: false },
)

// --- La tabla
const COLS = [
  ['Hoja', 34, 'center'],
  ['Firma', 186, 'left'],
  ['x', 40, 'right'],
  ['y (desde abajo)', 82, 'right'],
  ['y (desde arriba)', 82, 'right'],
  ['ancho', 46, 'right'],
  ['alto', 34, 'right'],
]

const ALTO_FILA = 16
let y = doc.y + 4

const fila = (celdas, { cabecera = false } = {}) => {
  if (cabecera) doc.rect(M, y, ANCHO, ALTO_FILA).fillAndStroke('#eeeeee', '#999999')
  else doc.rect(M, y, ANCHO, ALTO_FILA).lineWidth(0.4).strokeColor('#bbbbbb').stroke()

  let x = M
  for (const [i, [, ancho, alineado]] of COLS.entries()) {
    if (i) doc.moveTo(x, y).lineTo(x, y + ALTO_FILA).lineWidth(0.4).strokeColor('#bbbbbb').stroke()
    doc.font(cabecera ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#111')
    doc.text(String(celdas[i] ?? ''), x + 4, y + 4.5, { width: ancho - 8, align: alineado, lineBreak: false })
    x += ancho
  }
  y += ALTO_FILA
}

fila(COLS.map(([t]) => t), { cabecera: true })

for (const p of POS) {
  const quien = /prestador/i.test(p.quien) ? 'Prestador' : 'Abonado'
  fila([
    p.pagina,
    `${quien} — ${p.seccion}`,
    p.x,
    p.desde_abajo,
    p.desde_arriba,
    p.ancho,
    40,
  ])
}

doc.y = y + 10

titulo('Cómo se las mandamos')
parrafo(
  'Nuestro sistema envía las posiciones EN CADA SOLICITUD, junto al documento, en el campo '
  + '"firmas". Así, si el contrato cambia de largo, las coordenadas siguen siendo correctas sin '
  + 'que nadie tenga que reconfigurar nada.',
)
parrafo('El cuerpo del pedido tiene esta forma:', { negrita: true })

const EJEMPLO_JSON = JSON.stringify(
  {
    documento_base64: '<el PDF en base64>',
    documento_nombre: 'contrato-de-adhesion.pdf',
    firmante: {
      nombre: 'MARIA DE LOS ANGELES SANCHEZ',
      identificacion: '1206204289',
      email: 'abonado@ejemplo.ec',
      telefono: '0961137800',
    },
    verificacion: ['huella', 'rostro'],
    vigencia_horas: 72,
    firmas: POS.slice(0, 2).map((p) => ({
      pagina: p.pagina,
      x: p.x,
      y: p.desde_abajo,
      ancho: p.ancho,
      alto: 40,
      etiqueta: `${p.seccion} — ${p.quien}`,
    })),
  },
  null,
  2,
).replace(/\n\s+\]\n\s*\}$/, '\n    … (las demás)\n  ]\n}')

doc.font('Courier').fontSize(7.5).fillColor('#111')
doc.rect(M, doc.y, ANCHO, doc.heightOfString(EJEMPLO_JSON, { width: ANCHO - 12 }) + 10)
  .fillAndStroke('#f6f6f6', '#dddddd')
doc.fillColor('#111').text(EJEMPLO_JSON, M + 6, doc.y - doc.heightOfString(EJEMPLO_JSON, { width: ANCHO - 12 }) - 5, {
  width: ANCHO - 12,
})
doc.moveDown(1)

titulo('Cómo nos avisan que el abonado firmó')
parrafo(
  'Esperamos un POST a nuestro endpoint. Es lo que cierra el contrato de nuestro lado: sin ese '
  + 'aviso, el trámite queda esperando y se le termina ofreciendo la firma en papel.',
)
item('URL: https://<nuestro-servidor>/api/webhooks/firma')
item('Cabecera: X-Firma-Secreto: <secreto compartido que acordemos>')
item('Cuerpo: { "referencia": "<el id del trámite>", "estado": "firmado" | "rechazado" | "vencido", "documento_url": "<opcional>" }')
parrafo(
  'La referencia es el identificador que ustedes nos devuelven al crear el trámite. Respondemos '
  + '200 aunque el aviso se repita: si reintentan, no pasa nada.',
)

titulo('La firma del prestador')
parrafo(
  'El contrato lo firman DOS partes: el abonado y nosotros. Lo de arriba resuelve la del abonado, '
  + 'que es la que necesita verificación biométrica porque él no tiene certificado.',
)
parrafo(
  'De nuestro lado sí contamos con certificado de firma electrónica emitido por una entidad de '
  + 'certificación acreditada en Ecuador, del tipo que se usa para los comprobantes del SRI. Ese '
  + 'certificado firma XML con XAdES; para el contrato haría falta firmar el PDF con PAdES.',
)

titulo('Lo que necesitamos saber de ustedes')
item('¿Aceptan las posiciones en cada solicitud, o hay que configurarlas una sola vez?')
item('¿Qué campos exactos esperan en el pedido y cuáles devuelven? (arriba está lo que mandamos hoy)')
item('¿Cuánto tarda típicamente la respuesta al pedir el enlace? Hoy cortamos a los 30 segundos.')
item('¿Qué estados nos pueden avisar además de firmado, rechazado y vencido?')
item('¿El enlace vence por su lado? Nosotros lo damos por vencido a las 72 horas.')

/**
 * Las cuatro de la firma del prestador.
 *
 * Van juntas y al final porque la respuesta a la primera puede volver
 * innecesarias a las otras tres: si el proveedor firma también por el prestador,
 * no hace falta que este sistema aprenda a firmar PDF.
 */
item(
  '¿Su servicio firma también por el PRESTADOR, o únicamente por el abonado? '
  + 'Si lo hace, nos ahorra desarrollar la firma PAdES de nuestro lado.',
)
item(
  'Si firma por el prestador: ¿usa un certificado propio de ustedes, o podemos cargar el nuestro '
  + '(archivo .p12 con su clave)?',
)
item(
  '¿El documento que nos devuelven queda firmado por las DOS partes en un solo PDF, '
  + 'o son dos archivos?',
)
item(
  '¿La firma que aplican es PAdES sobre el PDF, y queda verificable con un lector común '
  + '(Adobe Reader) sin instalar nada?',
)

// --- Pie
doc.font('Helvetica').fontSize(7.5).fillColor('#666')
doc.text(
  `Generado el ${new Date().toLocaleDateString('es-EC')} desde el contrato real. `
  + 'Si el contrato cambia, esta ficha se vuelve a generar y las coordenadas se recalculan solas.',
  M,
  842 - M + 6,
  { width: ANCHO, align: 'center' },
)

doc.end()
writeFileSync(SALIDA, await listo)

console.log(`\nFicha generada: ${SALIDA}`)
console.log(`\n  ${POS.length} firmas, ${POS.at(-1).pagina} hojas`)
console.log('  comprobado: ninguna se mueve entre un contrato corto y uno largo\n')
