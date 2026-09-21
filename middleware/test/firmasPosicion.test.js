import test from 'node:test'
import assert from 'node:assert/strict'

import { generarContratoArcotel } from '../src/pagos/contratoArcotel.js'

/**
 * Dónde va cada firma en el PDF.
 *
 * ── Por qué esto merece pruebas propias ──
 *
 * Porque el proveedor de firma electrónica estampa en las coordenadas que se le
 * dan, y no mira lo que hay debajo. Si una firma se mueve de un contrato a otro,
 * hay que recalcular las coordenadas en cada venta — y el día que no se
 * recalculen, la firma cae encima de una cláusula.
 *
 * El error existía: la firma del acta subía o bajaba con la tabla de materiales,
 * veintiséis puntos entre un acta con dos materiales y una con ocho. Lo encontró
 * una medición, no una lectura del código.
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
  modelo_inscrito_el: '2025-10-16',
  vigencia_meses: 24,
  permanencia_meses: 24,
  valor_instalacion: 160,
  plazo_instalacion: '24 horas',
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
  permanencia: '2 años',
  permanencia_ofrecida: '2 años',
  beneficio_anexo: 'INSTALACIÓN GRATIS',
  costo_no_permanencia: 'EL ABONADO PAGARÁ EL COSTO DE INSTALACIÓN',
  valor_instalacion: 160,
  plazo_instalacion: '24 horas',
  inscripcion: '16/10/2025',
  numero: '1909',
  precio: 23.1,
  fecha: '17/08/2026',
  fecha_larga: '17 de agosto del año 2026',
  fecha_instalacion: '14/08/2026',
  fecha_activacion: '14/08/2026',
  forma_pago: 'Transferencia vía medios electrónicos',
  red_acceso: 'Fibra óptica',
  tipo_cuenta: 'Residencial',
  equipo_modalidad: 'arrendamiento',
}

const BASE = {
  prestador: PRESTADOR,
  plan: PLAN,
  contrato: { numero: '1909' },
  variables: VARIABLES,
  respuestas: {
    renovacion_automatica: true,
    permanencia: true,
    arbitraje: false,
    datos_personales: true,
    empaquetamiento: false,
  },
  cliente: {
    nombre: 'CARMEN LUCIA SANCHEZ MASAPANTA',
    identificacion: '1206204289',
    direccion: 'San Pablo de Maldonado Vía Selva Alegre',
    provincia: 'Cotopaxi',
    canton: 'La Maná',
    ciudad: 'La Maná',
    parroquia: 'El Carmen',
  },
  equipos: [['ONT', '', 'VSOL V2802RH', 'VSOL1234ABCD', 'AA:BB:CC:DD:EE:FF', 'Bueno']],
  materiales: [],
}

const ALTO_A4 = 842
const ANCHO_A4 = 596

test('el PDF dice dónde va cada firma', async () => {
  const pdf = await generarContratoArcotel(BASE)
  const p = pdf.posicionesDeFirma

  assert.equal(
    p.length,
    7,
    'dos en el contrato, dos en el anexo 1f, y una en cada uno de los otros tres',
  )

  const secciones = p.map((x) => x.seccion)
  for (const s of ['CONTRATO', 'ANEXO 1f', 'ANEXO 2', 'ANEXO 3', 'ACTA DE INSTALACION']) {
    assert.ok(secciones.includes(s), `falta la firma de ${s}`)
  }

  for (const x of p) {
    assert.ok(x.pagina >= 1, 'la hoja se cuenta desde 1, como la cuenta una persona')
    assert.ok(x.desde_abajo > 0 && x.desde_abajo < ALTO_A4, `${x.seccion} cae fuera de la hoja`)
    assert.ok(x.x >= 0 && x.x + x.ancho <= ANCHO_A4, `${x.seccion} se pasa del ancho`)
  }
})

test('las dos alturas son el mismo punto visto al revés', async () => {
  /**
   * pdfkit dibuja con el origen ARRIBA a la izquierda; el formato PDF lo pone
   * ABAJO. Mandar uno por el otro estampa cada firma reflejada de arriba abajo,
   * y no se nota hasta que llega el primer contrato firmado.
   */
  const p = (await generarContratoArcotel(BASE)).posicionesDeFirma

  for (const x of p) {
    assert.equal(
      x.desde_arriba + x.desde_abajo,
      ALTO_A4,
      `${x.seccion}: las dos alturas tienen que sumar el alto de la hoja`,
    )
  }
})

test('ninguna firma se mueve aunque cambie el largo del contrato', async () => {
  /**
   * Los dos extremos: un abonado con nombre corto y sin materiales, contra uno
   * con nombre y dirección largos y ocho materiales en el acta. Entre esos dos
   * contratos, las siete firmas tienen que caer en la misma hoja y en el mismo
   * lugar.
   */
  const corto = await generarContratoArcotel({
    ...BASE,
    cliente: { ...BASE.cliente, nombre: 'ANA MOYA', direccion: 'Av. 5' },
    materiales: [],
  })

  const largo = await generarContratoArcotel({
    ...BASE,
    cliente: {
      ...BASE.cliente,
      nombre: 'MARIA DE LOS ANGELES SANCHEZ MASAPANTA DE LA CRUZ',
      direccion:
        'Recinto San Pablo de Maldonado, Via a Selva Alegre kilometro 12 y medio, '
        + 'casa de dos pisos color celeste junto a la tienda',
    },
    materiales: Array.from({ length: 8 }, (_, i) => [`Material ${i}`, '5 m', '', '', `SER-${i}`]),
  })

  const clave = (x) => `${x.seccion} · ${x.quien}`
  const mapa = new Map(corto.posicionesDeFirma.map((x) => [clave(x), x]))

  assert.equal(
    largo.posicionesDeFirma.length,
    corto.posicionesDeFirma.length,
    'los dos contratos tienen las mismas firmas',
  )

  for (const x of largo.posicionesDeFirma) {
    const otra = mapa.get(clave(x))
    assert.ok(otra, `falta ${clave(x)} en el contrato corto`)
    assert.equal(x.pagina, otra.pagina, `${clave(x)} cambió de hoja`)
    assert.equal(x.desde_abajo, otra.desde_abajo, `${clave(x)} se movió de altura`)
    assert.equal(x.x, otra.x, `${clave(x)} se movió de lado`)
  }
})

test('la firma del acta va clavada al pie, no debajo de los materiales', async () => {
  // Es la que se movía. Con el acta llena de materiales tiene que seguir abajo.
  const llena = await generarContratoArcotel({
    ...BASE,
    materiales: Array.from({ length: 12 }, (_, i) => [`Material ${i}`, '3 m', '', '', '']),
  })

  const acta = llena.posicionesDeFirma.find((x) => x.seccion === 'ACTA DE INSTALACION')
  assert.ok(acta, 'el acta tiene que tener su firma')
  assert.ok(
    acta.desde_abajo < 150,
    `la firma del acta tiene que quedar cerca del pie, quedó a ${acta.desde_abajo} puntos`,
  )
})
