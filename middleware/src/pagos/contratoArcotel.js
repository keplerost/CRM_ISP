import PDFDocument from 'pdfkit'

import {
  ANEXO_2,
  ANEXO_3_TERMINOS,
  CANALES_ARCOTEL,
  CAUSALES,
  CIERRE,
  CLAUSULAS,
  FORMAS_PAGO,
  PIE_INSCRIPCION,
  REDES_ACCESO,
  SERVICIOS,
  SERVICIO_CONTRATADO,
  TIPOS_CUENTA,
  llenar,
} from './textoArcotel.js'

/**
 * El contrato de adhesión, con sus cuatro anexos.
 *
 * ── Por qué no pasa por el editor de plantillas ──
 *
 * Porque no es prosa que el ISP redacta: es un formulario. Tiene casillas que se
 * marcan, tablas que se llenan y un texto que está inscrito ante la ARCOTEL. Lo
 * que cambia entre un abonado y otro son los datos; lo que cambia entre un ISP y
 * otro son sus datos de prestador, que vienen de la tabla `prestadores`.
 *
 * ── Por qué es un solo PDF y no cinco ──
 *
 * Porque el abonado los firma todos en la misma visita, y entregarle cinco
 * archivos sueltos garantiza que alguno se imprima de menos. Van numerados de
 * corrido: "hoja 4 de 9" es lo que permite reclamar la que falta.
 *
 * ── Lo que este PDF NO es ──
 *
 * El contrato firmado. Esto es el papel para imprimir y llevar; el escaneo de lo
 * firmado se sube a `contratos.documento_url`.
 */

const MARGEN = 40
const ANCHO_PAGINA = 595.28
const ALTO_PAGINA = 841.89
const ANCHO = ANCHO_PAGINA - MARGEN * 2

const NEGRO = '#000000'
const GRIS = '#555555'
const BORDE = '#999999'

const T = { chico: 6.5, normal: 7.5, medio: 8.5, titulo: 11 }

/** Lo que queda de hoja antes del pie. */
const fondo = () => ALTO_PAGINA - MARGEN - 22

/** Si lo que viene no entra, se pasa de hoja entero. */
function siNoEntra(doc, alto) {
  if (doc.y + alto > fondo()) {
    doc.addPage()
    doc.x = MARGEN
  }
}

function parrafo(doc, texto, { tamano = T.normal, negrita = false, sangria = 0 } = {}) {
  if (!texto) return
  doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(tamano).fillColor(NEGRO)
  const ancho = ANCHO - sangria
  siNoEntra(doc, doc.heightOfString(texto, { width: ancho, align: 'justify' }))
  doc.text(texto, MARGEN + sangria, doc.y, { width: ancho, align: 'justify', lineGap: 1 })
  doc.moveDown(0.35)
}

/** El encabezado de una cláusula: el número en negrita y el título seguido. */
function tituloClausula(doc, n, titulo) {
  siNoEntra(doc, 30)
  doc.font('Helvetica-Bold').fontSize(T.medio).fillColor(NEGRO)
  doc.text(`${n}. - ${titulo}:`, MARGEN, doc.y, { width: ANCHO })
  doc.moveDown(0.2)
}

/**
 * Una casilla de formulario.
 *
 * `marcada` en `null` deja el cuadro vacío a propósito: es lo que corresponde
 * cuando al abonado todavía no se le preguntó. Marcar un "NO" que nadie dijo
 * sería peor que dejarlo en blanco — en la cláusula de arbitraje comprometería
 * al abonado a un gasto, y en la de tarifa preferencial le quitaría un derecho.
 */
function casilla(doc, x, y, marcada) {
  const L = 7.5
  doc.rect(x, y, L, L).lineWidth(0.6).strokeColor(NEGRO).stroke()
  if (marcada) {
    doc.font('Helvetica-Bold').fontSize(7).fillColor(NEGRO).text('X', x + 1.4, y + 0.9, {
      lineBreak: false,
    })
  }
}

/** El par SI / NO de las cláusulas que se responden. */
function siNo(doc, valor, { etiqueta = '', x = MARGEN } = {}) {
  siNoEntra(doc, 18)
  const y = doc.y
  let cursor = x

  if (etiqueta) {
    doc.font('Helvetica').fontSize(T.normal).fillColor(NEGRO)
    doc.text(etiqueta, cursor, y + 0.5, { lineBreak: false })
    cursor += doc.widthOfString(etiqueta) + 10
  }

  for (const [texto, esperado] of [['SI', true], ['NO', false]]) {
    doc.font('Helvetica').fontSize(T.normal).fillColor(NEGRO)
    doc.text(texto, cursor, y + 0.5, { lineBreak: false })
    cursor += doc.widthOfString(texto) + 4
    // `=== esperado` y no una comparación laxa: con `valor` en null ninguna de
    // las dos queda marcada, que es la manera de que se vea que falta responder.
    casilla(doc, cursor, y, valor === esperado)
    cursor += 22
  }

  doc.x = MARGEN
  doc.y = y + 14
}

/**
 * Una lista de opciones donde se marca la que aplica.
 *
 * Va en dos columnas: la cláusula segunda tiene diez servicios y la sexta seis
 * formas de pago; en una sola columna ocuparían media hoja para decir que se
 * contrató una.
 */
function opciones(doc, lista, marcada, columnas = 2) {
  const ancho = ANCHO / columnas
  const filas = Math.ceil(lista.length / columnas)
  siNoEntra(doc, filas * 12 + 6)

  const y0 = doc.y
  for (const [i, texto] of lista.entries()) {
    const col = Math.floor(i / filas)
    const fila = i % filas
    const x = MARGEN + col * ancho
    const y = y0 + fila * 12

    casilla(doc, x, y, texto === marcada)
    doc.font('Helvetica').fontSize(T.chico).fillColor(NEGRO)
    doc.text(texto, x + 11, y + 0.5, { width: ancho - 16, lineBreak: false })
  }

  doc.x = MARGEN
  doc.y = y0 + filas * 12 + 4
}

/**
 * Una caja de datos con etiqueta y valor.
 *
 * Cada fila es un arreglo de celdas `[etiqueta, valor]`. Los valores vacíos
 * dejan la raya para llenar a mano, que es lo que hace falta cuando se imprime
 * un contrato en blanco. Una fila puede venir
 * como `{ celdas, destacada: true, alto }` para salir más alta, con el borde
 * más grueso y —esto es lo que importa— con el texto ENVUELTO en vez de cortado.
 *
 * ── Por qué hizo falta ──
 *
 * Las filas normales van con `lineBreak: false` y 13 puntos de alto, que es lo
 * correcto para un dato corto: mantiene la grilla pareja y evita que un valor
 * largo empuje toda la página. Pero la cláusula de renovación automática es una
 * frase de dos renglones metida en un valor, y con el salto de línea apagado
 * PDFKit la cortaba a mitad de palabra. El contrato salía diciendo media
 * condición.
 */
function caja(doc, filas, { titulo = null } = {}) {
  const ALTO_FILA = 13
  const ALTO_DESTACADA = 30

  // Una fila puede ser el arreglo de siempre o el objeto con opciones.
  const norma = filas.map((f) => (Array.isArray(f) ? { celdas: f } : f))
  const altoDe = (f) => (f.destacada ? (f.alto ?? ALTO_DESTACADA) : ALTO_FILA)
  const total = norma.reduce((suma, f) => suma + altoDe(f), 0)

  siNoEntra(doc, total + (titulo ? 14 : 0) + 6)

  if (titulo) {
    doc.font('Helvetica-Bold').fontSize(T.normal).fillColor(NEGRO)
    doc.text(titulo, MARGEN, doc.y, { width: ANCHO })
    doc.moveDown(0.15)
  }

  const y0 = doc.y
  let y = y0

  for (const fila of norma) {
    const alto = altoDe(fila)
    const ancho = ANCHO / fila.celdas.length

    for (const [j, [etiqueta, valor]] of fila.celdas.entries()) {
      const x = MARGEN + j * ancho + 3
      doc.font('Helvetica-Bold').fontSize(T.chico).fillColor(NEGRO)
      doc.text(etiqueta, x, y + 3.5, { lineBreak: false })
      const salto = doc.widthOfString(etiqueta) + 4

      doc.font('Helvetica').fontSize(T.chico).fillColor(NEGRO)
      doc.text(valor || '', x + salto, y + 3.5, {
        width: ancho - salto - 6,
        lineBreak: Boolean(fila.destacada),
        ...(fila.destacada ? { height: alto - 6 } : {}),
      })
    }

    doc
      .rect(MARGEN, y, ANCHO, alto)
      .lineWidth(fila.destacada ? 1.3 : 0.4)
      .strokeColor(fila.destacada ? NEGRO : BORDE)
      .stroke()

    y += alto
  }

  doc.x = MARGEN
  doc.y = y + 5
}

/** Una tabla con cabecera. Las filas vacías quedan para llenar a mano. */
function tabla(doc, cabeceras, filas, { minimo = 3 } = {}) {
  const ALTO = 13
  const total = Math.max(filas.length, minimo)
  siNoEntra(doc, (total + 1) * ALTO + 6)

  const ancho = ANCHO / cabeceras.length
  const y0 = doc.y

  doc.rect(MARGEN, y0, ANCHO, ALTO).fillAndStroke('#eeeeee', BORDE)
  for (const [j, c] of cabeceras.entries()) {
    doc.font('Helvetica-Bold').fontSize(T.chico).fillColor(NEGRO)
    doc.text(c, MARGEN + j * ancho + 3, y0 + 3.5, { width: ancho - 6, lineBreak: false })
  }

  for (let i = 0; i < total; i++) {
    const y = y0 + (i + 1) * ALTO
    doc.rect(MARGEN, y, ANCHO, ALTO).lineWidth(0.4).strokeColor(BORDE).stroke()
    for (let j = 0; j < cabeceras.length; j++) {
      if (j) doc.moveTo(MARGEN + j * ancho, y).lineTo(MARGEN + j * ancho, y + ALTO).stroke()
      const v = filas[i]?.[j]
      if (v != null && v !== '') {
        doc.font('Helvetica').fontSize(T.chico).fillColor(NEGRO)
        doc.text(String(v), MARGEN + j * ancho + 3, y + 3.5, { width: ancho - 6, lineBreak: false })
      }
    }
  }

  doc.x = MARGEN
  doc.y = y0 + (total + 1) * ALTO + 6
}

/**
 * Las rayas de firma, con el nombre y el documento debajo.
 *
 * ── Por qué apunta dónde dibujó cada una ──
 *
 * Porque un proveedor de firma electrónica necesita saber en qué página y en qué
 * coordenadas estampar cada firma. Sacar esos números midiendo el PDF impreso
 * con una regla es adivinar; acá se saben con exactitud porque es este código el
 * que las dibuja.
 *
 * Se guardan en `doc._posicionesDeFirma`, que quien genera el PDF puede leer
 * después. No cambia nada de lo que se imprime.
 */
function firmas(doc, quienes, seccion = '', { alPie = false } = {}) {
  const ALTO = 52
  siNoEntra(doc, ALTO + 14)
  doc.moveDown(1.2)

  /**
   * `alPie` clava la raya a una altura fija de la hoja.
   *
   * Se usa donde lo de arriba es de largo variable. El acta lista los materiales
   * que gastó el técnico —dos en una instalación simple, doce en una difícil— y
   * sin esto la firma sube o baja con esa tabla: medido, se movía 26 puntos
   * entre un acta con dos materiales y una con ocho.
   *
   * Eso importa porque el proveedor de firma electrónica estampa en las
   * coordenadas que se le dan. Una firma que se mueve obliga a recalcularlas en
   * cada contrato, y si alguna vez no se recalculan, la firma cae encima del
   * texto.
   */
  const y = alPie ? ALTO_PAGINA - MARGEN - 60 : doc.y + 22
  const hueco = 40
  const ancho = (ANCHO - hueco * (quienes.length - 1)) / quienes.length

  for (const [i, quien] of quienes.entries()) {
    const x = MARGEN + i * (ancho + hueco)

    doc._posicionesDeFirma?.push({
      seccion,
      quien: quien.rol ?? '',
      // La hoja tal como la cuenta una persona: la primera es la 1.
      pagina: doc.bufferedPageRange().count,
      /**
       * Dos sistemas de coordenadas, porque los proveedores piden uno u otro.
       *
       * `desde_arriba` es como dibuja pdfkit: el origen arriba a la izquierda.
       * `desde_abajo` es el sistema del formato PDF: origen abajo a la
       * izquierda. Mandar uno por el otro pone la firma reflejada de arriba
       * abajo, y no se nota hasta que llega el primer contrato firmado.
       */
      x: Math.round(x),
      ancho: Math.round(ancho),
      desde_arriba: Math.round(y),
      desde_abajo: Math.round(ALTO_PAGINA - y),
    })

    doc.moveTo(x, y).lineTo(x + ancho, y).lineWidth(0.7).strokeColor(NEGRO).stroke()

    doc.font('Helvetica-Bold').fontSize(T.chico).fillColor(NEGRO)
    doc.text(quien.rol ?? '', x, y + 4, { width: ancho, align: 'center' })
    doc.font('Helvetica').fontSize(T.chico).fillColor(NEGRO)
    doc.text(quien.nombre ?? '', x, y + 13, { width: ancho, align: 'center' })
    doc.fontSize(T.chico).fillColor(GRIS)
      .text(quien.documento ? `C.C./RUC ${quien.documento}` : 'C.C. ______________________',
        x, y + 22, { width: ancho, align: 'center' })
  }

  doc.x = MARGEN
  doc.y = y + 38
}

/** El título de una hoja de anexo, que siempre empieza en hoja nueva. */
function encabezadoAnexo(doc, titulo, subtitulo = null) {
  doc.addPage()
  doc.x = MARGEN
  doc.font('Helvetica-Bold').fontSize(T.titulo).fillColor(NEGRO)
  doc.text(titulo, MARGEN, MARGEN, { width: ANCHO, align: 'center' })
  if (subtitulo) {
    doc.font('Helvetica-Bold').fontSize(T.medio)
      .text(subtitulo, MARGEN, doc.y + 2, { width: ANCHO, align: 'center' })
  }
  doc.moveDown(0.8)
}

const dinero = (n) => `${(Number(n) || 0).toFixed(2)} USD`
const megas = (kbps) => (kbps ? String(Math.round(kbps / 1000)) : '')

// ---------------------------------------------------------------------------
// Las cinco piezas
// ---------------------------------------------------------------------------

/** El contrato: comparecientes y las quince cláusulas. */
function hojaContrato(doc, d) {
  doc.font('Helvetica-Bold').fontSize(T.titulo).fillColor(NEGRO)
  doc.text('CONTRATO DE ADHESIÓN DE PRESTACION DE SERVICIOS', MARGEN, MARGEN, {
    width: ANCHO,
    align: 'center',
  })
  doc.moveDown(0.7)

  const p = d.prestador
  const c = d.cliente

  tituloClausula(doc, 'CLÁUSULA PRIMERA', 'Lugar y fecha.- Datos de los Comparecientes')

  caja(doc, [
    [['Nombre/Razón Social: ', p.razon_social], ['Nombre Comercial: ', p.nombre_comercial]],
    [['Dirección: ', p.direccion], ['RUC: ', p.ruc]],
    [['Provincia: ', p.provincia], ['Cantón: ', p.canton], ['Ciudad: ', p.ciudad],
      ['Parroquia: ', p.parroquia]],
    [['FONO: ', p.telefono], ['Mail: ', p.email], ['Web: ', p.web]],
  ], { titulo: 'Datos del Prestador:' })

  caja(doc, [
    [['Nombre/Razón Social: ', c.nombre], ['CEDULA/RUC: ', c.identificacion]],
    [['Dirección: ', c.direccion]],
    [['Provincia: ', c.provincia], ['Cantón: ', c.canton], ['Ciudad: ', c.ciudad],
      ['Parroquia: ', c.parroquia]],
    [['Fono/Celular: ', c.telefono], ['Mail: ', c.email]],
  ], { titulo: 'Datos del Abonado:' })

  siNo(doc, c.tarifa_preferencial, { etiqueta: '¿El Abonado es adulto mayor o discapacitado?' })
  doc.font('Helvetica').fontSize(T.chico).fillColor(GRIS)
  doc.text('(En caso afirmativo, aplica tarifa preferencial de acuerdo al plan del Prestador)',
    MARGEN, doc.y, { width: ANCHO })
  doc.moveDown(0.5)

  /**
   * Las cláusulas llegan de afuera; las del código son el respaldo.
   *
   * Cada prestador inscribe su propio modelo ante la ARCOTEL, así que el texto
   * vive en la base. Si no llegó ninguna —la migración sin correr, o alguien que
   * las borró— se imprime el modelo base: un contrato con el texto de fábrica es
   * infinitamente mejor que ninguno.
   */
  for (const cl of (d.clausulas?.length ? d.clausulas : CLAUSULAS)) {
    tituloClausula(doc, cl.n, cl.titulo)
    parrafo(doc, llenar(cl.texto, d.variables))

    if (cl.bloque === 'servicios') opciones(doc, SERVICIOS, SERVICIO_CONTRATADO)
    if (cl.bloque === 'formas_pago') opciones(doc, FORMAS_PAGO, d.variables.forma_pago)

    if (cl.condicion) {
      siNo(doc, d.respuestas[cl.condicion], { etiqueta: cl.etiqueta_condicion ?? '' })
    }

    if (cl.lista) {
      const items = String(d.variables[cl.lista.campo] ?? '').split('\n').filter(Boolean)
      if (items.length) {
        parrafo(doc, cl.lista.titulo, { negrita: true })
        for (const [i, t] of items.entries()) {
          parrafo(doc, `5.${i + 1} ${t}`, { sangria: 10 })
        }
      }
    }

    for (const n of cl.numerales ?? []) parrafo(doc, n, { sangria: 10 })

    if (cl.bloque === 'reclamos') {
      caja(doc, [
        [['Medio electrónico: ', p.reclamos_email || p.email],
          ['Horarios de atención: ', p.reclamos_horario]],
        [['Oficinas: ', p.reclamos_oficinas || p.direccion],
          ['Teléfono: ', p.reclamos_telefono || p.telefono]],
      ])
    }

    if (cl.bloque === 'causales') {
      parrafo(doc, 'POR PARTE DE LOS Prestadores:', { negrita: true })
      for (const t of CAUSALES.prestador) parrafo(doc, t, { sangria: 10 })
      parrafo(doc, 'POR PARTE DEL Abonado:', { negrita: true })
      for (const t of CAUSALES.abonado) parrafo(doc, t, { sangria: 10 })
    }

    if (cl.bloque === 'paquetes') {
      parrafo(doc, 'Los paquetes de servicios y los beneficios de estos, así como sus tarifas son:')
      tabla(doc, ['Paquete', 'Beneficios', 'Tarifa'], [], { minimo: 2 })
    }

    parrafo(doc, llenar(cl.cierre, d.variables))
    if (cl.bloque_final === 'canales_arcotel') {
      for (const t of CANALES_ARCOTEL) parrafo(doc, t, { sangria: 10 })
    }
    parrafo(doc, llenar(cl.cierre2, d.variables))

    // La raya de la cláusula de arbitraje: es una firma aparte de las del pie,
    // porque el abonado la deja solo si acepta someterse.
    if (cl.raya_firma) {
      siNoEntra(doc, 26)
      doc.moveDown(0.6)
      doc.moveTo(MARGEN, doc.y + 10).lineTo(MARGEN + 200, doc.y + 10)
        .lineWidth(0.6).strokeColor(NEGRO).stroke()
      doc.y += 16
    }
  }

  parrafo(doc, llenar(CIERRE, d.variables))
  doc.moveDown(0.5)
  parrafo(doc, 'Firman las partes:', { negrita: true })

  firmas(doc, [
    { rol: 'Prestador', nombre: p.razon_social, documento: p.ruc },
    { rol: 'Abonado', nombre: c.nombre, documento: c.identificacion },
  /**
   * Al pie, como el acta y por lo mismo.
   *
   * El contrato termina donde termina: la cláusula quinta enumera los beneficios
   * de la permanencia, y el que no se acoge no tiene ninguno. Medido, eso movía
   * las dos firmas 44 puntos entre un abonado que paga la instalación y uno que
   * no — con las coordenadas fijas del proveedor, en unos contratos la firma
   * caería sobre el texto.
   */
  ], 'CONTRATO', { alPie: true })
}

/** El anexo 1f: las condiciones del servicio contratado. */
function hojaAnexo1(doc, d) {
  encabezadoAnexo(doc, 'Anexo 1f', 'SERVICIO DE ACCESO A INTERNET')

  // `?? {}` y no un valor por defecto al desestructurar: el abonado sin plan
  // llega con `plan: null`, y un default solo cubre `undefined`.
  const plan = d.plan ?? {}
  const v = d.variables ?? {}

  caja(doc, [
    [['Fecha de suscripción del Anexo: ', v.fecha]],
    [['Nombre del Plan: ', plan.nombre]],
  ])

  parrafo(doc, 'Red de Acceso:', { negrita: true })
  opciones(doc, REDES_ACCESO, v.red_acceso, 3)

  parrafo(doc, 'Tipo de cuenta:', { negrita: true })
  opciones(doc, TIPOS_CUENTA, v.tipo_cuenta, 4)

  parrafo(doc,
    'Velocidad (kbps) (Si existe velocidad máxima para acceso a internet en servidores '
    + 'internacionales y a través del NAP local, se debe especificar):', { negrita: true })

  caja(doc, [
    [['Comercial de bajada: ', plan.bajada_kbps ? String(plan.bajada_kbps) : ''],
      ['Comercial de subida: ', plan.subida_kbps ? String(plan.subida_kbps) : '']],
    [['Mínima efectiva de bajada: ', plan.minima_bajada_kbps ? String(plan.minima_bajada_kbps) : ''],
      ['Mínima efectiva subida: ', plan.minima_subida_kbps ? String(plan.minima_subida_kbps) : '']],
    [['Nivel de Compartición (1:1, 2:1, 4:1, 8:4): ', plan.comparticion]],
  ])

  siNo(doc, d.respuestas.permanencia, { etiqueta: 'El contrato incluye permanencia mínima:' })
  caja(doc, [
    [['TIEMPO: ', v.permanencia]],
    [['Beneficios por permanencia mínima: ', v.beneficio_anexo]],
    [['No acepta la permanencia mínima, o no completa el tiempo de permanencia mínima: ',
      v.costo_no_permanencia]],
    {
      // Destacada porque es la condición que más se reclama —"me dijeron que no
      // pagaba nada"— y porque el texto no entra en un renglón normal.
      destacada: true,
      celdas: [['Renovación Automática del Contrato: ',
        'En caso de que haya renovación automática por cumplimiento de permanencia mínima El '
        + 'Abonado no cancelará valor alguno en caso de retiro posterior.']],
    },
  ])

  parrafo(doc, 'Servicios adicionales que se ofrece:', { negrita: true })
  tabla(doc, ['Servicio', 'SI', 'NO', 'Descripción'], [
    ['Cuentas de Correo Electrónico', '', 'X', 'NO SE OFRECE OTROS SERVICIOS'],
    ['Otros Servicios', '', 'X', 'NO SE OFRECE OTROS SERVICIOS'],
  ], { minimo: 2 })

  /**
   * Las tarifas, con la estructura del formulario.
   *
   * Se respeta el desglose del modelo —lo que se paga una sola vez separado de
   * lo mensual, y lo mensual separado de "otros valores"— aunque este sistema
   * hoy solo llene dos casilleros. Simplificarlo sería cambiar un formulario
   * inscrito por uno más cómodo, que es exactamente lo que no se puede hacer.
   */
  parrafo(doc, 'Tarifas (*):', { negrita: true })
  parrafo(doc, 'Valores a pagar por una sola vez:', { negrita: true })
  caja(doc, [
    [['Valor instalación/configuración: ', dinero(v.valor_instalacion)]],
    [['Plazo para instalar/activar el servicio (horas, días): ', v.plazo_instalacion]],
  ])

  parrafo(doc, 'Valores pago mensual:', { negrita: true })
  tabla(doc, ['Ítem', 'Valor (USD)', 'Detalle otros valores', 'Valor (USD)'], [
    ['Valor mensual', Number(v.precio ?? 0).toFixed(2), 'Otros servicios', ''],
    ['Valores Otros servicios', '', 'Otros Servicios', ''],
    ['Valor total', Number(v.precio ?? 0).toFixed(2), 'Total Otros Valores', ''],
  ], { minimo: 3 })

  caja(doc, [
    [['Sitio web para consulta de tarifas: ', d.prestador.web]],
    [['Sitio web consulta calidad del servicio: ', d.prestador.web]],
  ])

  doc.font('Helvetica').fontSize(T.chico).fillColor(GRIS)
  doc.text('Notas: * Las tarifas no incluyen impuestos de ley', MARGEN, doc.y, { width: ANCHO })
  doc.moveDown(0.4)

  firmas(doc, [
    { rol: '(Prestador)', nombre: d.prestador.razon_social, documento: d.prestador.ruc },
    { rol: '(Abonado/suscriptor)', nombre: d.cliente.nombre, documento: d.cliente.identificacion },
  ], 'ANEXO 1f', { alPie: true })
}

/** El anexo 2: la autorización de uso de datos personales. */
function hojaAnexo2(doc, d) {
  encabezadoAnexo(doc, 'ANEXO 2', 'ACEPTACIÓN DE USO DE DATOS PERSONALES')

  caja(doc, [[['Fecha de Suscripción del Anexo: ', d.variables.fecha]]])
  doc.moveDown(0.3)

  parrafo(doc, llenar(ANEXO_2, { prestador: d.prestador.razon_social }))
  doc.moveDown(0.5)

  /**
   * La aceptación queda en blanco si nadie la respondió.
   *
   * Es una autorización para usar los datos del abonado con fines comerciales y
   * para consultar su información crediticia. Traerla marcada en SI sería
   * obtener un consentimiento que el abonado no dio.
   */
  siNo(doc, d.respuestas.datos_personales, { etiqueta: 'Aceptación' })

  firmas(doc, [
    { rol: 'ABONADO/SUSCRIPTOR', nombre: d.cliente.nombre, documento: d.cliente.identificacion },
  ], 'ANEXO 2', { alPie: true })
}

/** El anexo 3: compra o arrendamiento de equipos. */
function hojaAnexo3(doc, d) {
  encabezadoAnexo(doc, 'ANEXO 3. COMPRA/ARRENDAMIENTO DE EQUIPOS')

  const v = d.variables
  caja(doc, [
    [['PRESTADOR: ', d.prestador.razon_social]],
    [['ABONADO/SUSCRIPTOR: ', d.cliente.nombre]],
    [['SERVICIO CONTRATADO: ', 'SERVICIO DE ACCESO DE INTERNET']],
    [['CONTRATO Nro. ', v.numero], ['PLAN CONTRATADO: ', d.plan?.nombre ?? '']],
  ])

  siNoEntra(doc, 30)
  const y = doc.y
  for (const [i, [texto, clave]] of [['COMPRA:', 'compra'], ['ARRENDAMIENTO:', 'arrendamiento']].entries()) {
    doc.font('Helvetica-Bold').fontSize(T.normal).fillColor(NEGRO)
    doc.text(texto, MARGEN, y + i * 13, { lineBreak: false })
    casilla(doc, MARGEN + 110, y + i * 13, v.equipo_modalidad === clave)
  }
  doc.x = MARGEN
  doc.y = y + 30

  parrafo(doc, 'Equipos Entregados:', { negrita: true })
  tabla(doc, ['Tipo', 'Precio', 'Marca/Modelo', 'Serie', 'Mac', 'Estado'], d.equipos ?? [])

  parrafo(doc, 'FORMA DE PAGO:', { negrita: true })
  tabla(doc, ['Detalle', 'Valor'], [], { minimo: 2 })

  parrafo(doc, 'TERMINOS Y CONDICIONES:', { negrita: true })
  for (const t of ANEXO_3_TERMINOS) parrafo(doc, t, { sangria: 10 })

  parrafo(doc, 'OBSERVACIONES:', { negrita: true })
  tabla(doc, [''], [], { minimo: 2 })

  firmas(doc, [
    {
      rol: 'FIRMA ACEPTACION ABONADO / SUSCRIPTOR',
      nombre: d.cliente.nombre,
      documento: d.cliente.identificacion,
    },
  ], 'ANEXO 3', { alPie: true })
}

/** El acta de entrega e instalación. */
function hojaActa(doc, d) {
  encabezadoAnexo(doc, 'ACTA DE ENTREGA / INSTALACION')

  const v = d.variables
  const inst = d.instalacion ?? {}

  caja(doc, [
    [['PRESTADOR: ', d.prestador.razon_social]],
    [['ABONADO/SUSCRIPTOR: ', d.cliente.nombre]],
    [['SERVICIO CONTRATADO: ', 'SERVICIO DE ACCESO DE INTERNET']],
    [['CONTRATO Nro. ', v.numero], ['PLAN CONTRATADO: ', d.plan?.nombre ?? '']],
    [['FECHA DE INSTALACIÓN: ', v.fecha_instalacion],
      ['TECNICO INSTALADOR: ', inst.tecnico ?? '']],
    [['DIRECCION INSTALACIÓN: ', d.cliente.direccion]],
    [['FECHA DE ACTIVACIÓN: ', v.fecha_activacion], ['HORA DE ACTIVACIÓN: ', inst.hora ?? '']],
  ])

  parrafo(doc, 'ELEMENTOS UTILIZADOS', { negrita: true })
  tabla(doc, ['Nro.', 'EQUIPO / MATERIAL', 'CANTIDAD', 'MARCA', 'MODELO', 'SERIAL'],
    (d.materiales ?? []).map((m, i) => [i + 1, ...m]), { minimo: 6 })

  parrafo(doc, 'OBSERVACIONES', { negrita: true })
  tabla(doc, [''], [], { minimo: 3 })

  firmas(doc, [
    { rol: 'ABONADO / SUSCRIPTOR', nombre: d.cliente.nombre, documento: d.cliente.identificacion },
  ], 'ACTA DE INSTALACION', { alPie: true })
}

/**
 * Arma el contrato completo con sus cuatro anexos.
 *
 * Todo lo que es propio del ISP llega en `prestador`; todo lo del abonado, en
 * `cliente`. El texto de las cláusulas no se recibe: es el del modelo inscrito.
 */
export function generarContratoArcotel({
  prestador = {},
  cliente = {},
  plan = null,
  contrato = {},
  instalacion = null,
  equipos = [],
  materiales = [],
  variables = {},
  respuestas = {},
  logo = null,
  /** Las del prestador. Vacío = el modelo base del código. */
  clausulas = null,
}) {
  const doc = new PDFDocument({ size: 'A4', margin: MARGEN, bufferPages: true })
  const trozos = []
  doc.on('data', (t) => trozos.push(t))

  /**
   * Dónde queda cada raya de firma.
   *
   * Lo pide el proveedor de firma electrónica para saber dónde estampar. Se
   * llena mientras se dibuja y se devuelve junto al PDF: medirlo después con una
   * regla sobre el papel impreso sería adivinar.
   */
  doc._posicionesDeFirma = []

  const listo = new Promise((r) =>
    doc.on('end', () => {
      const pdf = Buffer.concat(trozos)
      // El Buffer se devuelve como siempre; las posiciones viajan colgadas de
      // él para no cambiarle la forma al valor de retorno a todos los que ya lo
      // usan.
      pdf.posicionesDeFirma = doc._posicionesDeFirma
      r(pdf)
    }),
  )

  if (logo) {
    try {
      doc.image(logo, MARGEN, MARGEN - 18, { height: 26 })
    } catch {
      // Un logo ilegible no puede impedir que salga el contrato.
    }
  }

  const d = {
    prestador, cliente, plan, contrato, instalacion,
    equipos, materiales, variables, respuestas, clausulas,
  }

  hojaContrato(doc, d)
  hojaAnexo1(doc, d)
  hojaAnexo2(doc, d)
  hojaAnexo3(doc, d)
  hojaActa(doc, d)

  /**
   * El pie de cada hoja.
   *
   * La fecha de inscripción del modelo va en TODAS y no solo en la última: es lo
   * que permite verificar que cada hoja pertenece al modelo aprobado, y las
   * hojas se separan —se firman de a una, se archivan, se fotocopian—.
   */
  const paginas = doc.bufferedPageRange()
  const inscripcion = variables.inscripcion
    ? llenar(PIE_INSCRIPCION, variables)
    : 'Modelo de contrato de adhesión: falta registrar su fecha de inscripción'

  for (let i = 0; i < paginas.count; i++) {
    doc.switchToPage(paginas.start + i)

    /**
     * Bajar el margen inferior a cero mientras se escribe el pie.
     *
     * ── La hoja en blanco que aparecía detrás de cada hoja ──
     *
     * El pie va a `ALTO_PAGINA - MARGEN + 8` = 809.9, y el área de texto de la
     * hoja termina en 801.9. PDFKit, cuando `text()` cae por debajo del margen
     * inferior, NO recorta ni protesta: agrega una página y escribe ahí.
     *
     * Como esto corre una vez por hoja, el contrato salía con el doble de
     * hojas: siete útiles y siete en blanco intercaladas. Y el "Hoja X de Y"
     * quedaba mal, porque el conteo se hacía antes de que se crearan las de más.
     *
     * Con el margen en cero el pie entra donde tiene que entrar. Se restaura
     * enseguida para no dejar la página con una geometría distinta de la que
     * tenía.
     */
    const margenAbajo = doc.page.margins.bottom
    doc.page.margins.bottom = 0

    doc.font('Helvetica').fontSize(6).fillColor(GRIS).text(
      `${inscripcion}   ·   Hoja ${i + 1} de ${paginas.count}`,
      MARGEN,
      ALTO_PAGINA - MARGEN + 8,
      { width: ANCHO, align: 'center', lineBreak: false },
    )

    doc.page.margins.bottom = margenAbajo
  }

  doc.end()
  return listo
}

export { megas }
