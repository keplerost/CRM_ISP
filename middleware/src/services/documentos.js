import { db } from '../lib/db.js'
import { aplicarPlantilla } from './mensajeria.js'
import { CLAUSULAS } from '../pagos/textoArcotel.js'

/**
 * Los documentos que salen del editor de plantillas.
 *
 * ── Qué hace este archivo y qué no ──
 *
 * Junta los datos y aplica la plantilla. No dibuja: el PDF lo arma quien
 * corresponda —`contratoPdf` para el contrato, `reciboPdf` para el recibo—.
 *
 * ── Por qué el texto se busca por CLAVE y no por id ──
 *
 * Porque la plantilla la edita el ISP y la puede desactivar. Buscándola por
 * clave, el documento sigue saliendo con el texto que ese ISP escribió, sin que
 * nadie tenga que guardar un id en el código.
 */

/** Las claves de las seis plantillas de documento, tal como están en la base. */
export const DOCUMENTOS = {
  factura_sri: 'doc_factura_sri',
  recibo: 'doc_recibo',
  recibo_pos: 'doc_recibo_pos',
  hoja_instalacion: 'doc_hoja_instalacion',
  ticket: 'doc_ticket',
  contrato: 'doc_contrato',
}

const dinero = (n) => `$${(Number(n) || 0).toFixed(2)}`

/**
 * Una fecha como la lee alguien acá.
 *
 * ── Por qué hay dos caminos y no uno ──
 *
 * Porque una FECHA y un INSTANTE no se convierten igual, y usar el mismo código
 * para los dos corre el día uno en cada caso:
 *
 *  - `2026-08-12` es un día, sin hora. `new Date('2026-08-12')` lo lee como
 *    medianoche UTC, que en Ecuador (-05) es el 11 a las 19:00: imprimiría el
 *    día anterior. Por eso se parte el texto.
 *  - `2026-08-10T02:00:00Z` sí es un instante, y en Ecuador ese instante cae el
 *    día 9. Ahí partir el texto imprimiría el día siguiente, y hay que convertir.
 */
const ZONA = 'America/Guayaquil'

export function fecha(valor) {
  if (!valor) return ''
  const texto = String(valor)

  // Fecha sola: se toma tal cual, sin pasar por ninguna zona horaria.
  const soloDia = texto.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (soloDia) return `${soloDia[3]}/${soloDia[2]}/${soloDia[1]}`

  const d = new Date(texto)
  if (Number.isNaN(d.getTime())) return texto
  return d.toLocaleDateString('es-EC', {
    timeZone: ZONA,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

/**
 * El cuerpo de una plantilla de documento.
 *
 * Devuelve `null` si no está o si el ISP la desactivó. Quien llama decide qué
 * hacer con eso: para el contrato es un error —no hay nada que imprimir—, para
 * un pie de página opcional es simplemente no imprimirlo.
 */
export async function plantillaDocumento(clave) {
  const { data, error } = await db()
    .from('plantillas_mensaje')
    .select('clave, nombre, cuerpo, variables, activa')
    .eq('clave', clave)
    .maybeSingle()

  if (error) throw new Error(`No se pudo leer la plantilla ${clave}: ${error.message}`)
  if (!data || data.activa === false) return null
  return data
}

/** Los datos del emisor, que son los mismos para todos los documentos. */
export async function emisor() {
  const { data, error } = await db().from('sri_config').select('*').limit(1).maybeSingle()
  if (error) throw new Error(`No se pudo leer los datos de la empresa: ${error.message}`)
  return data ?? {}
}

/**
 * El contrato de un abonado, con su texto ya reemplazado.
 *
 * ── De dónde sale cada dato ──
 *
 * Del CONTRATO cuando existe, de la ficha cuando no. Un abonado puede tener un
 * precio pactado distinto del precio de lista del plan —promociones, acuerdos
 * viejos—, y el papel tiene que decir lo que se pactó, no la tarifa vigente.
 */
export async function armarContrato(clienteId, contratoId = null) {
  const plantilla = await plantillaDocumento(DOCUMENTOS.contrato)
  if (!plantilla) {
    throw new Error('La plantilla del contrato no existe o está desactivada')
  }

  const { data: cliente, error } = await db()
    .from('clientes')
    .select('id, nombre, identificacion, direccion, telefono, telefono_movil, email,'
      + ' plan_id, dia_facturacion, fecha_instalacion, activado_en')
    .eq('id', clienteId)
    .maybeSingle()

  if (error) throw new Error(`No se pudo leer el abonado: ${error.message}`)
  if (!cliente) return null

  /**
   * El contrato vigente, si lo hay.
   *
   * Se toma el más reciente y no se exige que esté vigente: al abonado dado de
   * baja también se le puede pedir una copia de lo que firmó, y negársela
   * porque el contrato ya terminó no ayuda a nadie.
   */
  let consulta = db()
    .from('contratos')
    .select('id, numero, plan_id, precio_mensual, dia_pago, fecha_inicio, permanencia_meses, estado')
    .eq('client_id', clienteId)

  if (contratoId) {
    // Cuando se pide UNO en concreto se imprime ese, aunque esté terminado: es
    // el caso de reimprimir lo que se firmó hace dos años, y ahí el precio que
    // vale es el de entonces, no el de ahora.
    consulta = consulta.eq('id', contratoId)
  } else {
    consulta = consulta.neq('estado', 'anulado').order('fecha_inicio', { ascending: false }).limit(1)
  }

  const { data: contratos } = await consulta

  const contrato = contratos?.[0] ?? {}

  let plan = null
  const planId = contrato.plan_id ?? cliente.plan_id
  if (planId) {
    const { data } = await db()
      .from('planes_velocidad')
      .select('nombre, precio, bajada_kbps, subida_kbps')
      .eq('id', planId)
      .maybeSingle()
    plan = data ?? null
  }

  const empresa = await emisor()

  const variables = {
    empresa: empresa.nombre_comercial || empresa.razon_social || '',
    razon_social: empresa.razon_social || '',
    ruc: empresa.ruc || '',
    telefono_empresa: empresa.telefono || '',
    // La del establecimiento antes que la de la matriz: es la oficina donde el
    // abonado va a ir a reclamar, no la dirección fiscal.
    direccion_empresa: empresa.dir_establecimiento || empresa.dir_matriz || '',

    nombre: cliente.nombre ?? '',
    identificacion: cliente.identificacion ?? '',
    direccion: cliente.direccion ?? '',
    telefono: cliente.telefono_movil || cliente.telefono || '',
    email: cliente.email ?? '',

    plan: plan?.nombre ?? '',
    // Los planes se guardan en kbps y se venden en megas: el contrato dice lo
    // que se le vendió.
    velocidad: plan?.bajada_kbps
      ? `${Math.round(plan.bajada_kbps / 1000)}/${Math.round((plan.subida_kbps ?? 0) / 1000)} Mbps`
      : '',
    // El precio pactado manda sobre el de lista, y `??` en vez de `||` para que
    // un plan gratuito de $0 no caiga al precio del plan.
    precio: dinero(contrato.precio_mensual ?? plan?.precio),
    permanencia: contrato.permanencia_meses ? `${contrato.permanencia_meses} meses` : 'sin permanencia',

    numero: contrato.numero ?? '',
    /**
     * Desde cuándo tiene servicio.
     *
     * `fecha_instalacion` la carga quien da el alta y hoy la tienen pocos; para
     * el resto, `activado_en` es el instante en que el sistema lo puso activo
     * por primera vez. Dejar la línea en blanco sería peor: un contrato sin
     * fecha de inicio no dice desde cuándo corre nada.
     */
    fecha_instalacion: fecha(
      cliente.fecha_instalacion || contrato.fecha_inicio || cliente.activado_en,
    ),
    dia_pago: String(contrato.dia_pago ?? cliente.dia_facturacion ?? ''),
    fecha: fecha(new Date().toISOString()),
  }

  return {
    plantilla: aplicarPlantilla(plantilla.cuerpo, variables),
    empresa,
    cliente,
    contrato,
    variables,
  }
}

/**
 * La hoja de instalación: qué se instaló, con qué serie y en qué estado quedó.
 *
 * ── Por qué importa que salga en papel ──
 *
 * La firma del abonado ya se capturaba en la tablet y quedaba guardada sin que
 * la viera nadie. Una firma que no se puede mostrar no sirve para lo único que
 * sirve una firma: que dos personas miren el mismo papel cuando no se ponen de
 * acuerdo sobre qué equipo se dejó instalado.
 */
export async function armarHojaInstalacion(instalacionId) {
  const plantilla = await plantillaDocumento(DOCUMENTOS.hoja_instalacion)
  if (!plantilla) throw new Error('La plantilla de la hoja de instalación no existe o está desactivada')

  const { data: inst, error } = await db()
    .from('v_instalaciones')
    .select('*')
    .eq('id', instalacionId)
    .maybeSingle()

  if (error) throw new Error(`No se pudo leer la instalación: ${error.message}`)
  if (!inst) return null

  const empresa = await emisor()

  const variables = {
    empresa: empresa.nombre_comercial || empresa.razon_social || '',
    ruc: empresa.ruc || '',

    orden: String(inst.numero ?? ''),
    fecha: fecha(inst.fecha || inst.alta_at || inst.created_at),
    hora: inst.hora ?? '',
    tipo: legible(inst.tipo),

    // El titular de la ficha antes que el nombre cargado en la orden: si el
    // abonado ya existe, el papel tiene que decir el nombre con el que está
    // dado de alta.
    nombre: inst.titular || inst.nombre || '',
    identificacion: inst.cedula || inst.identificacion || '',
    direccion: inst.direccion ?? '',
    telefono: inst.telefono_whatsapp || inst.telefono || '',

    plan: inst.plan ?? '',
    ip: inst.ip || inst.cliente_ip || '',
    usuario_ppp: inst.usuario_ppp ?? '',

    equipo: [inst.equipo_tipo, inst.equipo_modelo].filter(Boolean).join(' ') || inst.equipo || '',
    serie: inst.equipo_sn || inst.onu_serial || '',
    mac: inst.equipo_mac ?? '',
    metros_cable: inst.metros_cable == null ? '' : String(inst.metros_cable),
    nap: inst.nap ?? '',
    puerto_nap: inst.puerto_nap == null ? '' : String(inst.puerto_nap),
    // La potencia con la que quedó: es el número que se mira cuando meses
    // después el servicio anda mal y hay que saber si empeoró.
    potencia: inst.rx_power_dbm == null ? '' : `${inst.rx_power_dbm} dBm`,

    tecnico: inst.tecnico_nombre || inst.tecnico || inst.cuadrilla || '',
    observaciones: inst.observaciones ?? '',
  }

  return {
    plantilla: aplicarPlantilla(plantilla.cuerpo, variables),
    empresa,
    instalacion: inst,
    variables,
    firma: {
      nombre: inst.firmante_nombre || variables.nombre,
      pie: inst.firmante_identificacion
        ? `C.I. ${inst.firmante_identificacion}`
        : 'Recibí conforme',
      imagen_b64: inst.firma_b64 ?? null,
    },
  }
}

/**
 * La impresión de un reporte de soporte.
 *
 * Es lo que se le deja en la mano al abonado cuando el técnico se va: qué se
 * reportó, con qué número y qué se hizo. El número es lo que convierte un
 * reclamo en algo que se puede seguir.
 */
export async function armarTicket(ticketId) {
  const plantilla = await plantillaDocumento(DOCUMENTOS.ticket)
  if (!plantilla) throw new Error('La plantilla del ticket no existe o está desactivada')

  const { data: t, error } = await db()
    .from('v_tickets')
    .select('*')
    .eq('id', ticketId)
    .maybeSingle()

  if (error) throw new Error(`No se pudo leer el ticket: ${error.message}`)
  if (!t) return null

  const empresa = await emisor()

  const variables = {
    empresa: empresa.nombre_comercial || empresa.razon_social || '',
    ruc: empresa.ruc || '',

    ticket: String(t.numero ?? ''),
    codigo: t.codigo ?? '',
    fecha: fecha(t.created_at),
    fecha_visita: fecha(t.fecha_visita),
    estado: legible(t.estado),
    prioridad: legible(t.prioridad),

    nombre: t.cliente || t.nombre || '',
    identificacion: t.identificacion ?? '',
    direccion: t.direccion ?? '',
    telefono: t.telefono_whatsapp || t.telefono || '',

    motivo: legible(t.tipo_incidencia),
    descripcion: t.descripcion ?? '',
    // Lo que se hizo. Va vacío mientras el reporte esté abierto, y eso es
    // correcto: imprimir una solución que todavía no existe sería inventarla.
    solucion: t.solucion ?? '',
    material: t.material_usado ?? '',

    tecnico: t.tecnico || t.cuadrilla || '',
    ip: t.cpe_ip ?? '',
    potencia: t.potencia_dbm == null ? '' : `${t.potencia_dbm} dBm`,
  }

  return {
    plantilla: aplicarPlantilla(plantilla.cuerpo, variables),
    empresa,
    ticket: t,
    variables,
    firma: {
      nombre: t.firmante_nombre || variables.nombre,
      pie: t.firmante_cedula ? `C.I. ${t.firmante_cedula}` : 'Conforme con la atención',
      imagen_b64: t.firma_b64 ?? null,
    },
  }
}

/**
 * Un valor de catálogo, escrito como se lee.
 *
 * En la base los motivos se guardan como `sin_internet` porque así se comparan
 * y se filtran. En un papel que se le entrega al abonado eso se ve como un error
 * del sistema, no como el motivo de su reclamo.
 */
function legible(valor) {
  if (!valor) return ''
  const t = String(valor).replace(/_/g, ' ').trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/**
 * Cómo se escriben en el anexo 1f la red de acceso y el tipo de cuenta.
 *
 * Las claves son las que guarda la base; el texto es el que el formulario tiene
 * impreso, con sus tildes y su redacción. El generador marca la casilla
 * comparando por ese texto exacto.
 */
const REDES = {
  par_cobre: 'Par de Cobre',
  fibra: 'Fibra óptica',
  coaxial: 'Coaxial',
  inalambrico: 'Inalámbrico',
  otros: 'Otros',
}

const CUENTAS = {
  residencial: 'Residencial',
  corporativo: 'Corporativo',
  cibercafe: 'Cibercafé',
  otros: 'Otros tipos',
}

/**
 * La red de acceso que se declara.
 *
 * Manda lo elegido en la ficha. Si nadie eligió, se deduce: una ONT es fibra y
 * el resto inalámbrico, que es lo que este sistema atiende. La deducción acierta
 * en casi todos los casos, pero no puede distinguir coaxial de par de cobre — y
 * por eso existe el campo.
 */
export function redDeAcceso({ elegida, tecnologia, tieneOnt }) {
  if (elegida && REDES[elegida]) return REDES[elegida]
  return tecnologia === 'ftth' || tieneOnt ? REDES.fibra : REDES.inalambrico
}

/**
 * El tipo de cuenta.
 *
 * Manda lo elegido; si no, la categoría del plan. El plan no tiene cibercafé
 * entre sus categorías, así que ese caso solo sale bien si alguien lo eligió.
 */
export function tipoDeCuenta({ elegido, categoriaPlan }) {
  if (elegido && CUENTAS[elegido]) return CUENTAS[elegido]
  return categoriaPlan === 'corporativo' ? CUENTAS.corporativo : CUENTAS.residencial
}

/** Cómo se lee cada forma de pago en un papel que mira el abonado. */
const FORMAS = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia',
  deposito: 'Depósito',
  tarjeta: 'Tarjeta',
  cheque: 'Cheque',
  otro: 'Otro',
}

/**
 * El recibo de un cobro, escrito desde su plantilla.
 *
 * ── Por qué el mismo código sirve para la hoja y para la tirilla ──
 *
 * Porque los datos del cobro son los mismos; lo que cambia es dónde se imprimen.
 * `clave` decide qué plantilla se usa, y quien llama decide si eso termina en
 * una hoja A4 o en la térmica del mostrador.
 *
 * ── Y por qué esto NO reemplaza al recibo tabular ──
 *
 * El recibo de `/api/pagos/:id/recibo` sigue siendo el que se usa por defecto:
 * tiene original y copia en la misma hoja, el monto en letras, el detalle de los
 * excedentes y la marca de anulado. Este es el camino para el ISP que prefiere
 * redactar el suyo. Reemplazar uno por otro sería quitarle a alguien algo que ya
 * funciona.
 */
export async function armarRecibo(pagoId, clave = DOCUMENTOS.recibo) {
  const plantilla = await plantillaDocumento(clave)
  if (!plantilla) throw new Error(`La plantilla ${clave} no existe o está desactivada`)

  const { data: pago, error } = await db()
    .from('v_pagos')
    .select('*')
    .eq('id', pagoId)
    .maybeSingle()

  if (error) throw new Error(`No se pudo leer el pago: ${error.message}`)
  if (!pago) return null

  const empresa = await emisor()

  const variables = {
    empresa: empresa.nombre_comercial || empresa.razon_social || '',
    ruc: empresa.ruc || '',
    telefono_empresa: empresa.telefono || '',

    numero: String(pago.numero ?? ''),
    fecha: fecha(pago.fecha_pago),
    nombre: pago.cliente || pago.cliente_nombre || '',
    identificacion: pago.identificacion ?? '',

    monto: dinero(pago.monto),
    // Lo que el abonado ENTREGÓ, que puede ser más que lo imputado. Es lo que él
    // recuerda haber pagado, y si el papel dice otra cosa vuelve a preguntar.
    entregado: dinero(pago.total_cobro ?? pago.monto),
    excedente: dinero(pago.excedente),
    concepto: pago.concepto || (pago.numero_factura ? `Factura ${pago.numero_factura}` : 'Servicio de internet'),
    forma_pago: FORMAS[pago.forma_pago] ?? (pago.forma_pago ?? ''),
    transaccion: pago.n_transaccion ?? '',
    // Un recibo anulado que se reimprime tiene que decirlo, o sirve de
    // comprobante de un cobro que ya no existe.
    anulado: pago.anulado ? '*** ANULADO ***' : '',
  }

  return {
    plantilla: aplicarPlantilla(plantilla.cuerpo, variables),
    empresa,
    pago,
    variables,
  }
}

/** El mismo recibo para la impresora térmica del mostrador. */
export const armarReciboPos = (pagoId) => armarRecibo(pagoId, DOCUMENTOS.recibo_pos)


// =============================================================================
// El contrato de adhesión de la ARCOTEL
// =============================================================================

/** Los meses como los escribe el formulario: "2 años", "24 MESES". */
const enAnios = (meses) => {
  const m = Number(meses) || 0
  if (m && m % 12 === 0) return `${m / 12} ${m === 12 ? 'año' : 'años'}`
  return `${m} meses`
}

/**
 * Lo que se pactó de permanencia e instalación, y sus consecuencias en el texto.
 *
 * ── Por qué esto es una función y no cuatro campos sueltos ──
 *
 * Porque los cuatro se determinan entre sí, y separarlos es cómo se llega a un
 * contrato que se contradice: la cláusula quinta marcando SÍ a la permanencia
 * mientras el anexo declara instalación cobrada, o un "beneficio por permanencia
 * mínima: INSTALACIÓN GRATIS" en el papel de alguien que la pagó.
 *
 * La regla que las une es la del negocio: la permanencia es la contrapartida de
 * la instalación gratis. Quien paga la instalación ya puso el dinero y no se ata
 * a nada; quien no la paga se acoge a la permanencia a cambio.
 */
export function condicionesPactadas({ pactado = {}, prestador = {} }) {
  // `??` y no `||`: un cero pactado —sin permanencia, instalación gratis— es una
  // decisión, no un campo vacío que haya que reemplazar por el del prestador.
  const meses = pactado.permanencia_meses ?? prestador.permanencia_meses ?? 0
  const valor = pactado.valor_instalacion ?? prestador.valor_instalacion ?? 0

  const hayPermanencia = Number(meses) > 0

  return {
    permanencia_meses: meses,

    /**
     * Hay DOS permanencias en el contrato y no dicen lo mismo.
     *
     * La cláusula quinta PREGUNTA: "¿se acoge al periodo de permanencia mínima
     * de X?" — y ahí X es lo que el ISP ofrece, porque la pregunta existe
     * justamente para que el abonado la conteste. Poner ahí el resultado daría
     * "¿se acoge al periodo de permanencia mínima de 0 meses?", que no significa
     * nada.
     *
     * El anexo DECLARA el tiempo pactado, y ahí sí va lo que se acordó.
     */
    permanencia_ofrecida: enAnios(prestador.permanencia_meses ?? 0),
    permanencia: hayPermanencia ? enAnios(meses) : 'No aplica',

    valor_instalacion: valor,
    hay_permanencia: hayPermanencia,

    /**
     * Los tres textos del anexo que solo tienen sentido con permanencia.
     *
     * Sin ella se imprime "No aplica" y no se dejan en blanco: un renglón vacío
     * en un contrato se lee como un dato que falta, y alguien lo va a completar
     * a mano con lo que le parezca.
     */
    beneficios: hayPermanencia ? (prestador.beneficios_permanencia ?? '') : '',
    beneficio_anexo: hayPermanencia
      ? (prestador.beneficio_anexo || 'INSTALACIÓN GRATIS')
      : 'No aplica: el abonado no se acoge a permanencia mínima',
    costo_no_permanencia: hayPermanencia
      ? (prestador.costo_no_permanencia
        || 'EL ABONADO PAGARÁ EL COSTO DE INSTALACIÓN (Se detalla en "Tarifas")')
      : 'No aplica',
  }
}

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

/** "14 de agosto del año 2026", como lo escribe el cierre del contrato. */
function fechaLarga(d = new Date()) {
  return `${d.getDate()} de ${MESES[d.getMonth()]} del año ${d.getFullYear()}`
}

/**
 * Las cláusulas del contrato de este prestador.
 *
 * ── Por qué salen de la base y no del código ──
 *
 * Porque el modelo de adhesión se inscribe POR PRESTADOR: cada ISP presenta el
 * suyo ante la ARCOTEL y le aprueban ese. Comparten la estructura que exige el
 * regulador —las mismas casillas, las mismas listas— pero el texto no es
 * idéntico entre uno y otro.
 *
 * Con las cláusulas en el código, el segundo ISP que instalara el sistema
 * firmaría contratos con el texto del primero.
 *
 * ── Y por qué el código sigue teniendo una copia ──
 *
 * Como respaldo, no como fuente. Si la migración 150 no se corrió, o si alguien
 * borró todas las cláusulas de la base, el contrato tiene que salir igual: uno
 * con el texto del modelo base es infinitamente mejor que ninguno.
 */
export async function clausulasDe(prestadorId) {
  if (!prestadorId) return CLAUSULAS

  const { data, error } = await db()
    .from('v_clausulas_prestador')
    .select('*')
    .eq('prestador_id', prestadorId)
    .order('orden')

  // Un error acá es la tabla que no existe todavía: se sigue con las del código.
  if (error || !data?.length) return CLAUSULAS

  return data.map((c) => ({
    n: c.numeral,
    titulo: c.titulo,
    texto: c.texto ?? undefined,
    cierre: c.cierre ?? undefined,
    cierre2: c.cierre2 ?? undefined,
    numerales: Array.isArray(c.numerales) && c.numerales.length ? c.numerales : undefined,
    bloque: c.bloque ?? undefined,
    bloque_final: c.bloque_final ?? undefined,
    condicion: c.condicion ?? undefined,
    etiqueta_condicion: c.etiqueta_condicion ?? undefined,
    raya_firma: c.raya_firma || undefined,
    lista: c.lista_campo ? { titulo: c.lista_titulo, campo: c.lista_campo } : undefined,
  }))
}

/**
 * El prestador que le corresponde a un abonado.
 *
 * Cae al predeterminado cuando la ficha no dice cuál. Es lo correcto para el ISP
 * que tiene uno solo —que es el caso normal— y evita que el contrato salga sin
 * prestador por un campo que nadie llenó.
 */
async function prestadorDe(clienteId, prestadorId) {
  const consulta = db().from('prestadores').select('*')
  const { data, error } = prestadorId
    ? await consulta.eq('id', prestadorId).maybeSingle()
    : await consulta.eq('predeterminado', true).maybeSingle()

  if (error) throw new Error(`No se pudo leer el prestador: ${error.message}`)
  if (!data) {
    throw new Error(
      'No hay ningún prestador configurado. Cargalo en Ajustes antes de imprimir un contrato: '
      + 'el contrato de adhesión lleva su razón social, su RUC y la fecha en que inscribió el '
      + 'modelo ante la ARCOTEL.',
    )
  }
  return data
}

/**
 * El contrato de adhesión con sus cuatro anexos.
 *
 * ── Por qué no pasa por el editor de plantillas ──
 *
 * Porque el texto está inscrito ante la ARCOTEL y no lo redacta el ISP. Lo que
 * cambia entre un ISP y otro son sus datos de prestador —que salen de la tabla
 * `prestadores`— y lo que cambia entre un abonado y otro son los datos y las
 * casillas.
 */
export async function armarContratoArcotel(clienteId, contratoId = null) {
  /**
   * Se pide la ficha entera y no una lista de columnas.
   *
   * Las columnas del contrato las agrega la migración 139. Pidiéndolas por
   * nombre, el sistema al que todavía no se le corrió fallaría con "column does
   * not exist" en vez de imprimir el contrato con esos campos en blanco — que es
   * justo lo que hace falta para llevarlo y llenarlo a mano.
   */
  const { data: cliente, error } = await db()
    .from('v_clientes_ficha')
    .select('*')
    .eq('id', clienteId)
    .maybeSingle()

  if (error) throw new Error(`No se pudo leer el abonado: ${error.message}`)
  if (!cliente) return null

  const prestador = await prestadorDe(clienteId, cliente.prestador_id)

  let consulta = db()
    .from('contratos')
    .select('id, numero, plan_id, precio_mensual, dia_pago, fecha_inicio, permanencia_meses, estado')
    .eq('client_id', clienteId)

  consulta = contratoId
    ? consulta.eq('id', contratoId)
    : consulta.neq('estado', 'anulado').order('fecha_inicio', { ascending: false }).limit(1)

  const { data: contratos } = await consulta
  const contrato = contratos?.[0] ?? {}

  let plan = null
  const planId = contrato.plan_id ?? cliente.plan_id
  if (planId) {
    const { data } = await db().from('planes_velocidad').select('*').eq('id', planId).maybeSingle()
    plan = data ?? null
  }

  /**
   * La instalación, para el acta y para los equipos entregados.
   *
   * Se toma la última hecha: es la que dejó el equipo que el abonado tiene hoy.
   * Una orden pendiente todavía no entregó nada, y ponerla en el acta sería
   * levantar un acta de algo que no pasó.
   */
  const { data: instalaciones } = await db()
    .from('v_instalaciones')
    .select('*')
    .eq('client_id', clienteId)
    .eq('estado', 'hecha')
    .order('fecha', { ascending: false })
    .limit(1)

  const instalacion = instalaciones?.[0] ?? null

  // Los equipos del anexo 3, con lo que se sepa de cada uno. Las filas que
  // falten quedan vacías para llenarlas a mano el día de la firma.
  const equipos = []
  if (instalacion?.equipo_sn || instalacion?.onu_serial) {
    equipos.push([
      (instalacion.equipo_tipo || 'ONT').toUpperCase(),
      '',
      instalacion.equipo_modelo || '',
      instalacion.equipo_sn || instalacion.onu_serial || '',
      instalacion.equipo_mac || '',
      'Bueno',
    ])
  } else if (cliente.onu_serial) {
    equipos.push(['ONT', '', '', cliente.onu_serial, cliente.mac_address || '', 'Bueno'])
  }

  /**
   * Lo que se pactó, con la fila `contratos` mandando sobre la ficha.
   *
   * Si existe un contrato cargado, ahí está lo que se firmó de verdad; la ficha
   * puede haberse editado después. Reimprimir uno viejo tiene que dar el mismo
   * papel que se firmó.
   */
  const pacto = condicionesPactadas({
    pactado: {
      permanencia_meses: contrato.permanencia_meses ?? cliente.permanencia_meses,
      valor_instalacion: cliente.valor_instalacion,
    },
    prestador,
  })

  const variables = {
    empresa: prestador.nombre_comercial || prestador.razon_social || '',
    ciudad_prestador: prestador.ciudad || prestador.canton || '',
    vigencia: enAnios(prestador.vigencia_meses),
    permanencia: pacto.permanencia,
    permanencia_ofrecida: pacto.permanencia_ofrecida,
    beneficios: pacto.beneficios,
    beneficio_anexo: pacto.beneficio_anexo,
    costo_no_permanencia: pacto.costo_no_permanencia,
    valor_instalacion: pacto.valor_instalacion,
    plazo_instalacion: prestador.plazo_instalacion ?? '',
    inscripcion: prestador.modelo_inscrito_el ? fecha(prestador.modelo_inscrito_el) : '',

    numero: contrato.numero ?? cliente.codigo ?? '',
    precio: contrato.precio_mensual ?? cliente.precio_mensual ?? plan?.precio ?? 0,
    fecha: fecha(new Date().toISOString()),
    fecha_larga: fechaLarga(),
    fecha_instalacion: fecha(cliente.fecha_instalacion || instalacion?.fecha || contrato.fecha_inicio),
    fecha_activacion: fecha(instalacion?.alta_at || cliente.activado_en),

    // La forma de pago que se marca en la cláusula sexta. La que usa este
    // sistema es la transferencia; el resto queda sin marcar.
    forma_pago: 'Transferencia vía medios electrónicos',
    red_acceso: redDeAcceso({
      elegida: cliente.red_acceso,
      tecnologia: instalacion?.tecnologia,
      tieneOnt: Boolean(cliente.onu_serial),
    }),
    tipo_cuenta: tipoDeCuenta({
      elegido: cliente.tipo_cuenta,
      categoriaPlan: plan?.categoria,
    }),
    equipo_modalidad: cliente.equipo_modalidad ?? 'arrendamiento',
  }

  /**
   * Las casillas que responde el abonado.
   *
   * Las que la ficha no tiene contestadas quedan en `null` a propósito, y
   * entonces ninguna de las dos se marca. Traer un SI o un NO que el abonado no
   * dijo sería falsificar su respuesta — en el arbitraje lo comprometería a un
   * gasto, y en la autorización de datos personales daría por otorgado un
   * consentimiento que nadie pidió.
   */
  const respuestas = {
    renovacion_automatica: true,
    // La casilla de la cláusula quinta sale de lo mismo que el anexo, para que
    // no puedan decir cosas distintas en la misma hoja.
    permanencia: pacto.hay_permanencia,
    arbitraje: cliente.acepta_arbitraje ?? null,
    datos_personales: cliente.acepta_datos_personales ?? null,
    empaquetamiento: false,
  }

  return {
    prestador,
    /**
     * El logo sigue viniendo de `sri_config`: es donde está cargado hoy y es el
     * mismo negocio. Si un día un prestador necesita su propio logo, la columna
     * va en `prestadores` — pero inventarla ahora dejaría el contrato sin logo
     * hasta que alguien la llene.
     */
    empresa: await emisor(),
    cliente,
    plan,
    contrato,
    instalacion,
    equipos,
    // Lo que el técnico descontó de su almacén: el acta y el inventario tienen
    // que decir lo mismo.
    materiales: await materialesDeLaInstalacion(instalacion?.id),
    variables,
    respuestas,
    /** Lo que quedaría en blanco, para poder avisarlo antes de imprimir. */
    // Las de ESTE prestador: cada ISP inscribe su propio modelo ante la ARCOTEL.
    clausulas: await clausulasDe(prestador.id),
    faltantes: faltantesDelContrato({ prestador, cliente, plan }),
  }
}

/**
 * El contrato de alguien que TODAVÍA NO ES ABONADO.
 *
 * ── Por qué hace falta ──
 *
 * Porque el contrato se firma antes del alta, no después. El vendedor levanta
 * los datos, la oficina los carga en la orden de trabajo, y el papel tiene que
 * salir de ahí para llevarlo a firmar. Exigir que primero exista la ficha de
 * abonado invertiría el orden real: se daría de alta a alguien que todavía no
 * firmó nada.
 *
 * Los datos son los que cargó el vendedor en la orden. Lo que no preguntó queda
 * en blanco y se llena a mano el día de la firma.
 */
export async function armarContratoArcotelDeInstalacion(instalacionId) {
  const { data: inst, error } = await db()
    .from('v_instalaciones')
    .select('*')
    .eq('id', instalacionId)
    .maybeSingle()

  if (error) throw new Error(`No se pudo leer la orden: ${error.message}`)
  if (!inst) return null

  /**
   * Lo que la vista no trae, leído de la tabla.
   *
   * ── Por qué hace falta ──
   *
   * `v_instalaciones` enumera sus columnas una por una —son ciento quince— en
   * vez de usar `i.*`. Eso la hace estable, pero significa que agregar una
   * columna a `instalaciones` NO la agrega a la vista: la migración corre bien,
   * el formulario guarda bien, y el documento sigue leyendo un `undefined`.
   *
   * Pasó exactamente eso con la aceptación del anexo 2: el vendedor marcaba SÍ,
   * la orden lo guardaba, y el contrato salía con las dos casillas vacías. Sin
   * error en ningún lado.
   *
   * Se lee de la tabla en vez de rehacer la vista porque recrear ciento quince
   * columnas para agregar una es mucho más riesgoso que una consulta más. Si
   * algún día se suman otros campos, van en este mismo `select`.
   */
  const { data: extra } = await db()
    .from('instalaciones')
    .select('acepta_datos_personales')
    .eq('id', instalacionId)
    .maybeSingle()

  if (extra) Object.assign(inst, extra)

  /**
   * Si la orden ya se convirtió en abonado, manda la ficha.
   *
   * Es el caso de reimprimir el contrato de alguien que ya está dado de alta:
   * la ficha tiene los datos corregidos —y las respuestas de las casillas—,
   * mientras que la orden quedó congelada como la cargó el vendedor.
   */
  if (inst.client_id) {
    const desdeFicha = await armarContratoArcotel(inst.client_id)
    if (desdeFicha) return desdeFicha
  }

  const prestador = await prestadorDe(null, null)

  let plan = null
  if (inst.plan_id) {
    const { data } = await db().from('planes_velocidad').select('*').eq('id', inst.plan_id).maybeSingle()
    plan = data ?? null
  }

  /**
   * El "abonado" que todavía no existe, armado con lo que hay en la orden.
   *
   * La provincia no se inventa: la orden guarda sector y cantón, no provincia.
   * Dejarla vacía es lo correcto — sale en la lista de faltantes y se llena a
   * mano.
   */
  const cliente = {
    nombre: inst.nombre || inst.titular || '',
    identificacion: inst.identificacion || inst.cedula || '',
    direccion: inst.direccion ?? '',
    provincia: inst.provincia ?? null,
    canton: inst.canton ?? '',
    ciudad: inst.ciudad || inst.canton || '',
    /**
     * La parroquia, no el sector.
     *
     * Son cosas distintas: el sector es cómo el ISP agrupa su red, la parroquia
     * es una división política. En el contrato va la segunda, y usar una por la
     * otra pondría "Zona Norte" donde el formulario pide "El Carmen".
     */
    parroquia: inst.parroquia ?? '',
    telefono: inst.telefono_whatsapp || inst.telefono || '',
    email: inst.email ?? '',
    // Lo que anotó el vendedor. Lo que no preguntó queda sin marcar, no en NO.
    tarifa_preferencial: inst.tarifa_preferencial ?? null,
    acepta_arbitraje: inst.acepta_arbitraje ?? null,
    acepta_datos_personales: inst.acepta_datos_personales ?? null,
    equipo_modalidad: inst.equipo_modalidad ?? 'arrendamiento',
    onu_serial: inst.equipo_sn || inst.onu_serial || null,
    mac_address: inst.equipo_mac ?? null,
  }

  const equipos = []
  if (inst.equipo_sn || inst.onu_serial) {
    equipos.push([
      // El catálogo los guarda en minúscula ('ont', 'cpe'); en el anexo van
      // como se leen.
      (inst.equipo_tipo || 'ONT').toUpperCase(), '', inst.equipo_modelo || '',
      inst.equipo_sn || inst.onu_serial || '', inst.equipo_mac || '', 'Bueno',
    ])
  }

  // Lo que pactó el vendedor en la venta. Si no pactó nada distinto, lo del
  // prestador.
  const pacto = condicionesPactadas({
    pactado: {
      permanencia_meses: inst.permanencia_meses,
      valor_instalacion: inst.valor_instalacion,
    },
    prestador,
  })

  const variables = {
    empresa: prestador.nombre_comercial || prestador.razon_social || '',
    ciudad_prestador: prestador.ciudad || prestador.canton || '',
    vigencia: enAnios(prestador.vigencia_meses),
    permanencia: pacto.permanencia,
    permanencia_ofrecida: pacto.permanencia_ofrecida,
    beneficios: pacto.beneficios,
    beneficio_anexo: pacto.beneficio_anexo,
    costo_no_permanencia: pacto.costo_no_permanencia,
    valor_instalacion: pacto.valor_instalacion,
    plazo_instalacion: prestador.plazo_instalacion ?? '',
    inscripcion: prestador.modelo_inscrito_el ? fecha(prestador.modelo_inscrito_el) : '',

    // El número de la orden hace de número de contrato hasta que haya uno: es
    // el identificador con el que la oficina va a buscar este papel.
    numero: inst.numero ? String(inst.numero) : '',
    precio: inst.precio_mensual ?? plan?.precio ?? 0,
    fecha: fecha(new Date().toISOString()),
    fecha_larga: fechaLarga(),
    fecha_instalacion: fecha(inst.fecha),
    fecha_activacion: '',
    forma_pago: 'Transferencia vía medios electrónicos',
    red_acceso: redDeAcceso({
      elegida: inst.red_acceso,
      tecnologia: inst.tecnologia,
      tieneOnt: Boolean(inst.equipo_sn || inst.onu_serial),
    }),
    tipo_cuenta: tipoDeCuenta({ elegido: inst.tipo_cuenta, categoriaPlan: plan?.categoria }),
    equipo_modalidad: cliente.equipo_modalidad,
  }

  return {
    prestador,
    empresa: await emisor(),
    cliente,
    plan,
    contrato: {},
    instalacion: inst,
    equipos,
    materiales: await materialesDeLaInstalacion(inst.id),
    variables,
    respuestas: {
      renovacion_automatica: true,
      permanencia: pacto.hay_permanencia,
      arbitraje: cliente.acepta_arbitraje,
      /**
       * La respuesta del anexo 2, que antes estaba clavada en `null`.
       *
       * El `null` escrito a mano hacía que el contrato de una orden imprimiera
       * SIEMPRE las dos casillas vacías, aunque el vendedor hubiera preguntado.
       * Se firmaba en blanco y había que marcarlo a lapicera.
       *
       * `cliente` acá es la fila de la orden —el contrato se firma antes del
       * alta— y sus columnas se llaman igual que en la ficha.
       */
      datos_personales: cliente.acepta_datos_personales ?? null,
      empaquetamiento: false,
    },
    // Las de ESTE prestador: cada ISP inscribe su propio modelo ante la ARCOTEL.
    clausulas: await clausulasDe(prestador.id),
    faltantes: faltantesDelContrato({ prestador, cliente, plan }),
  }
}

/**
 * Los materiales que el técnico descontó de su almacén en esta instalación.
 *
 * ── Por qué salen del inventario y no se escriben aparte ──
 *
 * Porque el acta y el inventario tienen que decir lo mismo. Si el acta se
 * llenara a mano, en un mes habría actas con cinco metros de cable y un almacén
 * que descontó veinte —o al revés—, y no habría manera de saber cuál miente.
 *
 * El técnico descuenta el material desde su pantalla y el acta lo lee de ahí. Un
 * solo lugar donde escribirlo.
 */
export async function materialesDeLaInstalacion(instalacionId) {
  if (!instalacionId) return []

  const { data, error } = await db()
    .from('v_movimientos')
    .select('articulo, cantidad, unidad, serie, equipo_id')
    .eq('tipo', 'consumo')
    .eq('instalacion_id', instalacionId)
    .order('creado_en')

  if (error) throw new Error(`No se pudo leer el material usado: ${error.message}`)

  return (data ?? []).map((m) => [
    m.articulo ?? '',
    // La cantidad con su unidad: "20 m" y "20 u" no son lo mismo, y el acta la
    // firma alguien que va a contar lo que ve.
    `${Number(m.cantidad ?? 0)}${m.unidad ? ` ${m.unidad}` : ''}`,
    '',
    '',
    m.serie ?? '',
  ])
}

/**
 * Qué le falta a un abonado para que su contrato salga completo.
 *
 * ── Por qué se avisa en vez de bloquear ──
 *
 * Porque un contrato con dos campos en blanco sigue sirviendo: se imprime, se
 * llenan a mano el día de la firma y se archiva. Negarse a imprimirlo dejaría al
 * técnico sin papel en la puerta de la casa del abonado.
 *
 * Pero callarlo sería peor: el que imprime no mira las nueve hojas antes de
 * salir, y el hueco aparece cuando ya está sentado con el abonado enfrente.
 */
export function faltantesDelContrato({ prestador = {}, cliente = {}, plan = null }) {
  const falta = []

  if (!prestador.modelo_inscrito_el) {
    falta.push('La fecha en que el prestador inscribió su modelo de contrato ante la ARCOTEL')
  }
  if (!prestador.ruc) falta.push('El RUC del prestador')
  if (!prestador.web) falta.push('El sitio web del prestador, que el anexo 1f pide dos veces')

  if (!cliente.identificacion) falta.push('La cédula o RUC del abonado')
  if (!cliente.provincia || !cliente.canton || !cliente.parroquia) {
    falta.push('La provincia, el cantón y la parroquia del abonado')
  }
  if (cliente.tarifa_preferencial == null) {
    falta.push('Si el abonado es adulto mayor o tiene discapacidad (da tarifa preferencial)')
  }
  if (cliente.acepta_arbitraje == null) falta.push('Si el abonado acepta someterse a arbitraje')
  if (cliente.acepta_datos_personales == null) {
    falta.push('Si el abonado acepta el uso de sus datos personales (anexo 2)')
  }

  if (plan && !plan.comparticion) falta.push(`El nivel de compartición del plan ${plan.nombre}`)
  if (plan && plan.minima_bajada_kbps == null) {
    falta.push(`La velocidad mínima efectiva del plan ${plan.nombre}`)
  }

  return falta
}
