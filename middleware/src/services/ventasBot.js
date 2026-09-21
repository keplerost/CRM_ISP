import { db } from '../lib/db.js'
import { AppError, badRequest } from '../lib/errors.js'

/**
 * El módulo de ventas que consume el bot: cobertura, planes y agenda.
 *
 * ── Lo que separa esto de vender de verdad ──
 *
 * Un bot puede contestar "sí llegamos a tu casa" y "cuesta $20". Lo que NO
 * puede es decidir que llegamos: eso lo dicen las cajas cargadas en el sistema,
 * con sus coordenadas y sus puertos ocupados. Por eso acá no hay ninguna regla
 * comercial nueva — se le pregunta a `cobertura_cercana()`, que es la misma
 * función que usa la pantalla de factibilidad desde la migración 31.
 *
 * Prometer cobertura que no existe es la forma más cara de equivocarse en un
 * ISP: se agenda una cuadrilla, sale, y vuelve sin instalar. Por eso el umbral
 * de distancia es conservador y una caja sin puertos libres cuenta como sin
 * cobertura, aunque esté a diez metros.
 */

/**
 * Hasta dónde llega el cable de acometida, en metros.
 *
 * En FTTH el drop desde la NAP rara vez pasa de 250 m sin poste intermedio: más
 * que eso ya es obra, no instalación. En inalámbrico el alcance es otro orden y
 * lo que manda es la línea de vista, que esto no puede saber — por eso el
 * número es generoso y la respuesta avisa que hay que verificar en sitio.
 */
const ALCANCE_M = { ftth: 250, wireless: 3000 }

/**
 * ¿Llegamos a estas coordenadas?
 *
 * Devuelve la caja más cercana con puertos libres. Si la más cercana está llena
 * pero hay otra dentro del alcance, gana la que tiene lugar: al cliente le da
 * lo mismo de qué caja cuelga, y al técnico no le sirve que lo manden a una sin
 * puerto.
 */
export async function validarCobertura({ latitud, longitud, tecnologia = 'ftth' } = {}) {
  const lat = Number(latitud)
  const lng = Number(longitud)

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw badRequest('Faltan las coordenadas o no son números.', { codigo: 'DATOS_INVALIDOS' })
  }
  // Un cero exacto es casi siempre "no se pudo leer el GPS", no la isla del
  // Golfo de Guinea. Sin este control, el bot promete cobertura en el Atlántico.
  if (lat === 0 && lng === 0) {
    throw badRequest('Las coordenadas llegaron vacías.', {
      codigo: 'DATOS_INVALIDOS',
      hint: 'Pedile al prospecto que comparta su ubicación desde WhatsApp.',
    })
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw badRequest('Esas coordenadas no existen.', { codigo: 'DATOS_INVALIDOS' })
  }

  const tec = tecnologia === 'wireless' ? 'wireless' : 'ftth'

  const { data, error } = await db().rpc('cobertura_cercana', {
    p_lat: lat,
    p_lng: lng,
    p_tecnologia: tec,
    p_limite: 5,
  })

  if (error) {
    throw new AppError(`No se pudo calcular la cobertura: ${error.message}`, { status: 502 })
  }

  const alcance = ALCANCE_M[tec]
  const cerca = (data ?? []).filter((p) => p.distancia_m <= alcance)

  // `disponibles` en null significa capacidad sin cargar: se cuenta como que
  // hay lugar. Tratarlo como "llena" dejaría sin cobertura a todo un padrón
  // donde nadie completó la capacidad de las cajas.
  const conLugar = cerca.filter((p) => p.disponibles == null || p.disponibles > 0)
  const elegida = conLugar[0] ?? null

  return {
    tiene_cobertura: Boolean(elegida),
    caja_nap_cercana: elegida?.nombre ?? null,
    distancia_metros: elegida?.distancia_m ?? null,
    puertos_disponibles: elegida?.disponibles ?? null,
    tecnologia: tec,

    /**
     * Por qué no, cuando no.
     *
     * Es la diferencia entre "no llegamos" —que cierra la venta— y "hay caja
     * pero está llena", que es una venta que se cierra en cuanto se amplía. El
     * bot puede decir cosas distintas, y el ISP puede ver dónde le falta puerto.
     */
    motivo: elegida
      ? null
      : cerca.length
        ? 'Hay una caja cerca pero sin puertos libres'
        : (data ?? []).length
          ? `La caja más cercana está a ${data[0].distancia_m} m, fuera del alcance de ${alcance} m`
          : 'No hay ninguna caja cargada en esa zona',

    // Las otras opciones dentro del alcance, para que la oficina decida si
    // conviene ampliar o tender.
    opciones: cerca.map((p) => ({
      nombre: p.nombre,
      tipo: p.tipo,
      distancia_metros: p.distancia_m,
      disponibles: p.disponibles,
    })),
  }
}

/**
 * Los planes que se pueden ofrecer.
 *
 * Solo los activos y solo lo que el cliente necesita oír: nombre, velocidad y
 * precio. La traffic table, el perfil PPP y el índice de la OLT no salen — son
 * configuración de red, y un catálogo que los expone le está contando a
 * cualquiera cómo está armada la red por dentro.
 */
export async function catalogoPlanes({ categoria = null } = {}) {
  let q = db()
    .from('planes_velocidad')
    .select('id, nombre, descripcion, bajada_kbps, subida_kbps, precio, categoria, tipo_impuesto, iva_porcentaje')
    .eq('activo', true)
    .order('precio')

  if (categoria) q = q.eq('categoria', categoria)

  const { data, error } = await q
  if (error) throw new AppError(`No se pudieron leer los planes: ${error.message}`, { status: 502 })

  return (data ?? []).map((p) => ({
    id: p.id,
    nombre: p.nombre,
    descripcion: p.descripcion,
    // En megas, que es como se vende y como lo entiende quien pregunta. Los
    // kbps son la unidad del equipo, no la del cliente.
    velocidad: `${Math.round(p.bajada_kbps / 1000)} Mbps`,
    bajada_mbps: Math.round(p.bajada_kbps / 1000),
    subida_mbps: Math.round(p.subida_kbps / 1000),
    precio: Number(p.precio),
    // Que el bot no tenga que adivinar si al precio hay que sumarle el IVA.
    precio_incluye_iva: p.tipo_impuesto === 'incluido',
    categoria: p.categoria,
  }))
}

/** Las franjas que entiende la agenda. La del CRM viene como "10:00 - 12:00". */
function franjaDe(texto) {
  const t = String(texto ?? '').trim()
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?/)
  if (!m) return { franja: null, hora: null }

  const h = Number(m[1])
  if (!Number.isFinite(h) || h < 0 || h > 23) return { franja: null, hora: null }

  return {
    // Antes de la una es mañana; de ahí en adelante, tarde. Es el corte con el
    // que se arman las cuadrillas, no una regla horaria estricta.
    franja: h < 13 ? 'manana' : 'tarde',
    hora: `${String(h).padStart(2, '0')}:${m[2] ?? '00'}`,
  }
}

/**
 * Agenda la instalación de un prospecto.
 *
 * ── Por qué esto crea una ORDEN y no un cliente ──
 *
 * Porque todavía no es cliente: es alguien que dijo que sí por WhatsApp. La
 * ficha de abonado se crea cuando el técnico instala, y ahí se le asignan IP,
 * ONT y plan de verdad. Crearla antes llenaría el padrón de gente que nunca se
 * instaló, y esa gente aparecería en la cartera, en las estadísticas y —lo peor—
 * en la facturación mensual.
 *
 * `instalaciones` ya soporta esto desde la migración 31: acepta una orden sin
 * `client_id` siempre que tenga nombre. Es el mismo camino que usa el alta que
 * carga la oficina por teléfono.
 *
 * ── El duplicado ──
 *
 * Un bot reintenta y una persona escribe dos veces. Si ya hay una orden abierta
 * para esa cédula, se devuelve ESA en vez de crear otra: dos órdenes para el
 * mismo domicilio son dos cuadrillas que salen al mismo lugar.
 */
export async function agendarInstalacion(datos = {}) {
  const p = datos.prospecto ?? datos
  const nombre = String(p.nombre ?? '').trim()
  const identificacion = String(p.cedula ?? p.identificacion ?? '').replace(/[^0-9A-Za-z]/g, '')

  if (!nombre) throw badRequest('Falta el nombre del prospecto.', { codigo: 'DATOS_INVALIDOS' })
  if (!identificacion) throw badRequest('Falta la cédula del prospecto.', { codigo: 'DATOS_INVALIDOS' })
  if (!String(p.direccion ?? '').trim()) {
    throw badRequest('Falta la dirección: sin eso la cuadrilla no puede salir.', {
      codigo: 'DATOS_INVALIDOS',
    })
  }

  const fecha = String(datos.fecha_programada ?? datos.fecha ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    throw badRequest('La fecha de instalación va en formato AAAA-MM-DD.', { codigo: 'DATOS_INVALIDOS' })
  }
  const hoy = new Date().toISOString().slice(0, 10)
  if (fecha < hoy) {
    throw badRequest('No se puede agendar una instalación para una fecha pasada.', {
      codigo: 'DATOS_INVALIDOS',
    })
  }

  // --- ¿Ya es abonado? -------------------------------------------------------
  //
  // Alguien que ya tiene servicio y pide "una instalación" casi siempre quiere
  // un traslado o un segundo servicio, y las dos cosas se cotizan distinto. Se
  // deriva a una persona en vez de abrir una orden de alta que después hay que
  // deshacer.
  const { data: yaCliente } = await db()
    .from('clientes')
    .select('id, nombre')
    .eq('identificacion', identificacion)
    .neq('estado', 'baja')
    .maybeSingle()

  if (yaCliente) {
    throw new AppError('Esa cédula ya tiene un servicio activo con nosotros.', {
      status: 409,
      codigo: 'YA_ES_ABONADO',
      hint: 'Si quiere un traslado o un segundo servicio, derivalo a un asesor.',
    })
  }

  // --- ¿Ya la agendamos? -----------------------------------------------------
  const { data: previa } = await db()
    .from('instalaciones')
    .select('id, numero, fecha, franja, estado')
    .eq('identificacion', identificacion)
    .in('estado', ['prospecto', 'nueva', 'revisando', 'lista_asignar', 'agendada', 'en_ruta', 'en_curso'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (previa) {
    return {
      repetido: true,
      orden_instalacion_id: `INS-${previa.numero}`,
      instalacion_id: previa.id,
      fecha: previa.fecha,
      estado: previa.estado,
      mensaje: 'Ya teníamos una instalación agendada para esa cédula. No se duplicó.',
    }
  }

  const { franja, hora } = franjaDe(datos.franja_horaria)

  const coords = String(p.coordenadas ?? '').split(',').map((n) => Number(n.trim()))
  const latitud = p.latitud ?? (Number.isFinite(coords[0]) ? coords[0] : null)
  const longitud = p.longitud ?? (Number.isFinite(coords[1]) ? coords[1] : null)

  const fila = {
    tipo: 'nueva',
    // 'agendada' y no 'prospecto': el cliente ya eligió día y franja. Dejarla en
    // prospecto la escondería de la agenda del equipo técnico, que es
    // exactamente lo que el bot vino a evitar.
    estado: 'agendada',
    nombre: nombre.slice(0, 150),
    identificacion: identificacion.slice(0, 20),
    telefono: String(p.telefono ?? '').trim().slice(0, 30) || null,
    telefono_whatsapp: String(p.telefono ?? '').trim().slice(0, 30) || null,
    email: String(p.email ?? '').trim().slice(0, 200) || null,
    direccion: String(p.direccion).trim().slice(0, 300),
    referencia: String(p.referencia ?? '').trim() || null,
    latitud,
    longitud,
    plan_id: datos.plan_id || null,
    fecha,
    hora,
    franja,
    tecnologia: datos.tecnologia === 'wireless' ? 'wireless' : 'ftth',
    notas: `Agendada desde ${datos.origen ?? 'el bot de WhatsApp'}.`,
  }

  const { data, error } = await db()
    .from('instalaciones')
    .insert(fila)
    .select('id, numero, fecha, franja')
    .single()

  if (error) {
    throw new AppError(`No se pudo agendar la instalación: ${error.message}`, { status: 502 })
  }

  return {
    repetido: false,
    orden_instalacion_id: `INS-${data.numero}`,
    instalacion_id: data.id,
    fecha: data.fecha,
    franja: data.franja,
    mensaje: 'Instalación agendada correctamente.',
  }
}
