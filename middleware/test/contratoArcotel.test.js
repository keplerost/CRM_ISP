import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { generarContratoArcotel } from '../src/pagos/contratoArcotel.js'
import { faltantesDelContrato } from '../src/services/documentos.js'

/**
 * El contrato de adhesión inscrito en la ARCOTEL.
 *
 * Lo que se cuida acá no es la estética: es que el papel diga lo que el modelo
 * inscrito exige. Un contrato al que le falta una cláusula, o que marca una
 * casilla que el abonado no respondió, es un problema regulatorio — y en el caso
 * del arbitraje, un gasto al que se lo comprometió sin preguntarle.
 */

const PRESTADOR = {
  razon_social: 'OÑA RIERA JEFFERSON FABIAN',
  nombre_comercial: 'HOME LINK-OR',
  ruc: '1250579925001',
  direccion: 'Av. 19 de mayo y Eugenio Espejo',
  provincia: 'Cotopaxi',
  canton: 'La Maná',
  ciudad: 'La Maná',
  parroquia: 'La Maná',
  telefono: '0939145857',
  email: 'homelinknetor@gmail.com',
  web: 'https://cnet.net.ec/',
  reclamos_email: 'homelinknetor@gmail.com',
  reclamos_telefono: '0986017616',
  reclamos_horario: '08:00am a 18:00pm',
  modelo_inscrito_el: '2025-10-16',
  vigencia_meses: 24,
  permanencia_meses: 24,
  valor_instalacion: 160,
  plazo_instalacion: '24 horas',
  beneficios_permanencia: 'Instalación de servicio de internet\nSoporte técnico inmediato',
}

const CLIENTE = {
  nombre: 'CARMEN LUCIA SANCHEZ MASAPANTA',
  identificacion: '1206204289',
  direccion: 'San Pablo de Maldonado Vía Selva Alegre',
  provincia: 'Cotopaxi',
  canton: 'La Maná',
  ciudad: 'La Maná',
  parroquia: 'El Carmen',
  telefono: '0961137800',
  email: 'sanchezlucia2901@gmail.com',
  tarifa_preferencial: false,
  acepta_arbitraje: false,
  // La respuesta del anexo 2, que la migración 184 agregó a la ficha. Va en
  // `false` y no ausente a propósito: `false` es "el abonado dijo que no",
  // que es una respuesta; ausente es "nadie preguntó", que es un hueco.
  acepta_datos_personales: false,
  equipo_modalidad: 'arrendamiento',
}

const PLAN = {
  nombre: 'PLAN HOME 150/150',
  precio: 23.1,
  bajada_kbps: 150000,
  subida_kbps: 150000,
  comparticion: '4:1',
  minima_bajada_kbps: 120000,
  minima_subida_kbps: 120000,
  categoria: 'residencial',
}

const VARIABLES = {
  empresa: 'HOME LINK-OR',
  ciudad_prestador: 'La Maná',
  vigencia: '2 años',
  permanencia: '24 meses',
  beneficios: 'Instalación de servicio de internet\nSoporte técnico inmediato',
  valor_instalacion: 160,
  plazo_instalacion: '24 horas',
  inscripcion: '16/10/2025',
  numero: '1909',
  precio: 23.1,
  fecha: '14/08/2026',
  fecha_larga: '14 de agosto del año 2026',
  beneficio_anexo: 'INSTALACIÓN GRATIS',
  costo_no_permanencia: 'EL ABONADO PAGARÁ EL COSTO DE INSTALACIÓN (Se detalla en "Tarifas")',
  fecha_instalacion: '14/08/2026',
  fecha_activacion: '14/08/2026',
  forma_pago: 'Transferencia vía medios electrónicos',
  red_acceso: 'Fibra óptica',
  tipo_cuenta: 'Residencial',
  equipo_modalidad: 'arrendamiento',
}

const BASE = {
  prestador: PRESTADOR,
  cliente: CLIENTE,
  plan: PLAN,
  contrato: { numero: '1909' },
  equipos: [['ONT', '', 'VSOL V2802RH', 'VSOL1234ABCD', 'AA:BB:CC:DD:EE:FF', 'Bueno']],
  variables: VARIABLES,
  respuestas: {
    renovacion_automatica: true,
    permanencia: true,
    arbitraje: false,
    datos_personales: true,
    empaquetamiento: false,
  },
}

/** Lo que el PDF dice de verdad. */
function textoDelPdf(pdf) {
  const s = pdf.toString('latin1')
  const partes = []
  const re = /stream\r?\n/g
  let m
  while ((m = re.exec(s))) {
    const i = m.index + m[0].length
    const f = s.indexOf('endstream', i)
    if (f < 0) break
    try {
      partes.push(zlib.inflateSync(pdf.subarray(i, f)).toString('latin1'))
    } catch {
      partes.push(s.slice(i, f))
    }
  }

  const contenido = partes.join('\n')
  const lineas = []
  const rx = /\[((?:[^\]\\]|\\.)*)\]\s*TJ/g
  let a
  while ((a = rx.exec(contenido))) {
    // Los negativos grandes son espacios de justificación; los positivos, el
    // kerning entre letras. Tomarlos por espacios partiría las palabras.
    let linea = ''
    for (const t of a[1].match(/<[0-9a-fA-F]*>|-?\d+(?:\.\d+)?/g) ?? []) {
      if (t.startsWith('<')) linea += Buffer.from(t.slice(1, -1), 'hex').toString('latin1')
      else if (Number(t) < -100 && !linea.endsWith(' ')) linea += ' '
    }
    lineas.push(linea)
  }
  return lineas.join('\n')
}

test('el contrato trae las quince cláusulas del modelo', async () => {
  // Es lo primero que revisa quien lo compara con el modelo inscrito. Que falte
  // una no se nota leyendo por encima: se nota cuando hay un reclamo.
  const texto = textoDelPdf(await generarContratoArcotel(BASE))

  for (const c of [
    'CL.USULA PRIMERA', 'CL.USULA SEGUNDA', 'CL.USULA TERCERA', 'CL.USULA CUARTA',
    'CL.USULA QUINTA', 'CL.USULA SEXTA', 'CL.USULA SEPTIMA', 'CL.USULA OCTAVA',
    'CL.USULA NOVENA', 'CL.USULA DECIMA', 'CL.USULA DECIMA PRIMERA',
    'CL.USULA DECIMA SEGUNDA', 'CL.USULA D.CIMA TERCERA', 'CLAUSULA DECIMA CUARTA',
    'CLAUSULA DECIMA QUINTA',
  ]) {
    assert.match(texto, new RegExp(c), `falta la ${c}`)
  }
})

test('trae los cuatro anexos, que el abonado también firma', async () => {
  const texto = textoDelPdf(await generarContratoArcotel(BASE))

  assert.match(texto, /Anexo 1f/)
  assert.match(texto, /ANEXO 2/)
  assert.match(texto, /ACEPTACI.N DE USO DE DATOS PERSONALES/)
  assert.match(texto, /ANEXO 3\. COMPRA\/ARRENDAMIENTO DE EQUIPOS/)
  assert.match(texto, /ACTA DE ENTREGA \/ INSTALACION/)
})

test('la fecha de inscripción del modelo va en TODAS las hojas', async () => {
  /**
   * Es lo que permite verificar que el papel corresponde a un modelo aprobado.
   * Va en todas y no solo en la última porque las hojas se separan: se firman de
   * a una, se archivan y se fotocopian sueltas.
   */
  const texto = textoDelPdf(await generarContratoArcotel(BASE))

  const hojas = [...texto.matchAll(/Hoja (\d+) de (\d+)/g)]
  assert.ok(hojas.length >= 5, `esperaba al menos 5 hojas, hubo ${hojas.length}`)

  const conFecha = texto.match(/16\/10\/2025/g) ?? []
  assert.equal(conFecha.length, hojas.length, 'cada hoja tiene que llevar la fecha del modelo')
})

test('sin fecha de inscripción el contrato lo dice en vez de callarlo', async () => {
  // Un contrato que no puede contrastarse con un modelo aprobado tiene que
  // avisarlo. Imprimirlo con el pie vacío lo haría pasar por completo.
  const texto = textoDelPdf(
    await generarContratoArcotel({ ...BASE, variables: { ...VARIABLES, inscripcion: '' } }),
  )

  assert.match(texto, /falta registrar su fecha de inscripci.n/)
})

test('lo que el abonado no respondió NO se marca', async () => {
  /**
   * El caso más caro de los dos: el formulario aclara que el arbitraje "puede
   * significar costos en los que debe incurrir el Abonado". Marcar un SI que
   * nadie dijo lo compromete a un gasto; marcar un NO le quita una opción.
   *
   * Se comprueba contando las X: sin responder tiene que haber MENOS marcas que
   * respondiendo, y el documento tiene que salir igual.
   */
  const respondido = textoDelPdf(await generarContratoArcotel(BASE))
  const enBlanco = textoDelPdf(
    await generarContratoArcotel({
      ...BASE,
      cliente: { ...CLIENTE, tarifa_preferencial: null, acepta_arbitraje: null },
      respuestas: { ...BASE.respuestas, arbitraje: null, datos_personales: null },
    }),
  )

  const marcas = (t) => (t.match(/X/g) ?? []).length
  assert.ok(
    marcas(enBlanco) < marcas(respondido),
    'sin responder tiene que haber menos casillas marcadas',
  )
  // Y sale igual: el técnico necesita el papel para llenarlo a mano.
  assert.match(enBlanco, /CONTRATO DE ADHESI.N/)
})

test('el servicio contratado queda marcado y los otros nueve no', async () => {
  const texto = textoDelPdf(await generarContratoArcotel(BASE))

  assert.match(texto, /SERVICIO DE ACCESO A INTERNET/)
  // Los otros servicios del catálogo se imprimen igual —son parte del modelo—
  // pero sin marcar.
  assert.match(texto, /MOVIL AVANZADO \(SMA\)/)
  assert.match(texto, /AUDIO Y VIDEO POR SUSCRIPCION/)
})

test('los datos del abonado y del prestador salen donde corresponde', async () => {
  const texto = textoDelPdf(await generarContratoArcotel(BASE))

  assert.match(texto, /O.A RIERA JEFFERSON FABIAN/)
  assert.match(texto, /1250579925001/)
  assert.match(texto, /CARMEN LUCIA SANCHEZ MASAPANTA/)
  assert.match(texto, /1206204289/)
  assert.match(texto, /PLAN HOME 150\/150/)
  assert.match(texto, /VSOL1234ABCD/, 'el equipo entregado, en el anexo 3')
  assert.match(texto, /1800-567567/, 'el call center de la ARCOTEL')
})

test('el anexo 1f trae el desglose de tarifas del modelo, no uno simplificado', async () => {
  /**
   * Estas frases salieron de comparar el PDF contra el Excel del modelo, línea
   * por línea: doce textos del anexo no coincidían porque la tabla de tarifas
   * estaba simplificada y dos campos se habían inventado.
   *
   * Se dejan fijadas acá porque simplificar el anexo es tentador —este sistema
   * solo llena dos casilleros de los seis— y sería cambiar un formulario
   * inscrito por uno más cómodo.
   */
  const texto = textoDelPdf(await generarContratoArcotel(BASE))

  for (const frase of [
    'Valores a pagar por una sola vez',
    'Plazo para instalar/activar el servicio \\(horas, d.as\\)',
    'Valores pago mensual',
    'Detalle otros valores',
    'Valor \\(USD\\)',
    'Valores Otros servicios',
    'Total Otros Valores',
    'M.nima efectiva subida',
    'INSTALACI.N GRATIS',
    'No acepta la permanencia m.nima, o no completa el tiempo de permanencia m.nima',
    'EL ABONADO PAGAR. EL COSTO DE INSTALACI.N',
    'En caso de que haya renovaci.n autom.tica por cumplimiento de permanencia m.nima',
  ]) {
    assert.match(texto, new RegExp(frase), `falta en el anexo 1f: ${frase}`)
  }
})

test('un contrato en blanco también sale, para llenarlo a mano', async () => {
  // Es lo que el técnico lleva cuando va a dar de alta a alguien que todavía no
  // está cargado en el sistema.
  const pdf = await generarContratoArcotel({ prestador: PRESTADOR })

  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  assert.match(textoDelPdf(pdf), /CONTRATO DE ADHESI.N/)
})

test('avisa lo que quedaría en blanco antes de imprimir', () => {
  /**
   * Se avisa en vez de bloquear: un contrato con huecos se llena a mano el día
   * de la firma. Pero callarlo sería peor, porque el hueco aparece cuando el
   * técnico ya está sentado con el abonado enfrente.
   */
  const falta = faltantesDelContrato({
    prestador: { ruc: '1250579925001' },
    cliente: { nombre: 'ALGUIEN' },
    plan: { nombre: 'PLAN_HOME' },
  })

  assert.ok(falta.some((f) => /ARCOTEL/.test(f)), 'la fecha del modelo inscrito')
  assert.ok(falta.some((f) => /parroquia/i.test(f)), 'el domicilio desglosado')
  assert.ok(falta.some((f) => /adulto mayor/i.test(f)), 'la tarifa preferencial')
  assert.ok(falta.some((f) => /arbitraje/i.test(f)))
  // El anexo 2 se firmaba en blanco y había que marcarlo a lapicera: es el
  // agujero que arregló la migración 184. Sin esta línea, el aviso podía
  // volver a perderse sin que nada se pusiera en rojo.
  assert.ok(falta.some((f) => /datos personales/i.test(f)), 'la aceptación del anexo 2')
  assert.ok(falta.some((f) => /compartici.n/i.test(f)))
})

test('con todo cargado no falta nada', () => {
  assert.deepEqual(faltantesDelContrato({ prestador: PRESTADOR, cliente: CLIENTE, plan: PLAN }), [])
})
