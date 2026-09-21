import { db } from '../lib/db.js'
import { AppError, badRequest, notFound } from '../lib/errors.js'
import { canalesPara } from './avisosPago.js'
import { enviar, seEntrego } from './mensajeria.js'

/**
 * Cortes masivos: avisarle al sector antes de que el sector escriba.
 *
 * ── Qué problema resuelve, en una frase ──
 *
 * El monitoreo ya sabe que se cayó la torre. Los 180 abonados que cuelgan de
 * ella también lo saben —se les cortó internet— y lo único que falta es que
 * alguien se lo diga, para que no lo pregunten los 180 por el mismo canal.
 *
 * ── Las tres cosas que hacen que esto sea seguro de dejar corriendo ──
 *
 * 1. **Una incidencia nace en borrador.** Existe, tiene su lista de afectados
 *    calculada, y no salió ni un mensaje. Abrirla es un acto aparte.
 * 2. **El umbral de minutos.** El monitoreo solo abre sola una incidencia si el
 *    nodo lleva caído más que lo configurado. Un enlace de radio que parpadea
 *    con la lluvia vuelve antes del umbral y nadie se entera.
 * 3. **Un renglón por abonado y por momento**, con índice único en la base. La
 *    cola se puede reintentar, el servidor se puede reiniciar y alguien puede
 *    apretar "avisar" dos veces: nadie recibe el mismo mensaje dos veces.
 */

/**
 * Qué plantilla le toca a cada aviso. La programada tiene su propio texto.
 *
 * Los ayudantes de texto de acá abajo se exportan para poder probarlos sin base:
 * son los que deciden qué lee el abonado, y un `{{estimado}}` crudo en medio de
 * un SMS solo se descubre leyendo un mensaje ya enviado.
 */
export function plantillasDe(aviso) {
  if (aviso.momento === 'resolucion') {
    return { email: 'mail_incidencia_resuelta', corta: 'sms_incidencia_resuelta' }
  }
  if (aviso.programada) {
    return { email: 'mail_mantenimiento_programado', corta: 'sms_mantenimiento_programado' }
  }
  return { email: 'mail_incidencia_abierta', corta: 'sms_incidencia_abierta' }
}

/** La hora, como se la dice a una persona. */
const hora = (iso) =>
  iso
    ? new Date(iso).toLocaleString('es-EC', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null

/**
 * El texto del horario estimado.
 *
 * Sin estimación se manda una frase igual y no un hueco: "{{estimado}}" crudo en
 * medio de un SMS es lo que hace que el abonado desconfíe del mensaje entero.
 * Y "estamos trabajando" sin hora es mejor que una hora inventada que después
 * no se cumple.
 */
export function textoEstimado(aviso) {
  if (aviso.momento === 'resolucion') return ''
  if (!aviso.estimado_at) return 'Estamos trabajando para restablecerlo lo antes posible.'
  return `Estimamos restablecerlo alrededor de las ${hora(aviso.estimado_at)}.`
}

/** La ventana de un mantenimiento programado, en palabras. */
export function textoVentana(aviso) {
  if (!aviso.inicio_previsto) return 'en las próximas horas'
  if (!aviso.fin_previsto) return `a partir de las ${hora(aviso.inicio_previsto)}`
  return `${hora(aviso.inicio_previsto)} a ${hora(aviso.fin_previsto)}`
}

/** Cuánto duró, para el aviso de resolución. */
export function textoDuracion(aviso) {
  if (!aviso.ocurrio_at) return ''
  const minutos = Math.round((Date.now() - new Date(aviso.ocurrio_at).getTime()) / 60000)
  if (minutos < 60) return `${minutos} minutos`
  const h = Math.floor(minutos / 60)
  return `${h} ${h === 1 ? 'hora' : 'horas'}`
}

// --- Alta y consulta ---------------------------------------------------------

/**
 * Cuántos abonados alcanzaría un alcance dado, ANTES de crear nada.
 *
 * Es la pregunta que hay que poder contestar antes de escribirle a un pueblo:
 * "esta zona son 12 abonados" y "esta zona son 340" se deciden distinto. Sin
 * esto, el número recién se conoce cuando ya se creó la incidencia — y para
 * entonces la tentación es abrirla igual.
 */
export async function previsualizar(alcance = {}) {
  const fila = normalizarAlcance(alcance)

  // Se le pregunta a la MISMA función que después resuelve a quién avisarle.
  // Con dos implementaciones —una para el número que se muestra y otra para la
  // lista que se manda— el día que difieran, el que se entera es el abonado que
  // no debía recibir nada.
  const { data, error } = await db().rpc('afectados_por_alcance', {
    p_alcance: fila.alcance,
    p_zona: fila.zona,
    p_punto_id: fila.punto_id,
    p_nodo_id: fila.nodo_id,
    p_olt_id: fila.olt_id,
    p_puerto_pon: fila.puerto_pon,
    p_router_id: fila.router_id,
    p_manual: fila.clientes_manual,
  })

  if (error) throw new AppError(`No se pudo calcular el alcance: ${error.message}`, { status: 502 })

  const ids = (data ?? []).map((f) => f.client_id)

  // Una muestra de nombres, para reconocer de un vistazo que la lista es la
  // correcta. Un número solo no permite ver que se eligió la zona vecina.
  const { data: muestra } = ids.length
    ? await db().from('clientes').select('nombre, zona, estado').in('id', ids.slice(0, 8))
    : { data: [] }

  return { afectados: ids.length, muestra: muestra ?? [] }
}

const ALCANCES = ['zona', 'punto', 'nodo', 'olt', 'router', 'manual']

/** Deja el alcance en los campos que espera la base, y solo esos. */
export function normalizarAlcance(datos = {}) {
  const alcance = String(datos.alcance ?? '').trim()
  if (!ALCANCES.includes(alcance)) {
    throw badRequest(`Alcance desconocido: "${alcance}"`, {
      hint: `Los válidos son: ${ALCANCES.join(', ')}.`,
    })
  }

  const fila = {
    alcance,
    zona: null,
    punto_id: null,
    nodo_id: null,
    olt_id: null,
    puerto_pon: null,
    router_id: null,
    clientes_manual: [],
  }

  if (alcance === 'zona') {
    fila.zona = String(datos.zona ?? '').trim()
    if (!fila.zona) throw badRequest('Decí qué zona: sin eso el aviso saldría a quien no corresponde.')
  } else if (alcance === 'punto') {
    fila.punto_id = datos.punto_id || null
    if (!fila.punto_id) throw badRequest('Elegí la caja NAP, la antena o la torre afectada.')
  } else if (alcance === 'nodo') {
    fila.nodo_id = datos.nodo_id || null
    if (!fila.nodo_id) throw badRequest('Elegí el nodo del monitoreo.')
  } else if (alcance === 'olt') {
    fila.olt_id = datos.olt_id || null
    if (!fila.olt_id) throw badRequest('Elegí la OLT.')
    // El puerto es opcional pero cambia mucho el alcance: sin él va la OLT
    // entera, que pueden ser novecientos abonados por una fibra de sesenta.
    fila.puerto_pon = String(datos.puerto_pon ?? '').trim() || null
  } else if (alcance === 'router') {
    fila.router_id = datos.router_id || null
    if (!fila.router_id) throw badRequest('Elegí el router.')
  } else {
    fila.clientes_manual = Array.isArray(datos.clientes_manual) ? datos.clientes_manual : []
    if (!fila.clientes_manual.length) throw badRequest('Elegí al menos un abonado.')
  }

  return fila
}

const TIPOS = ['averia', 'fibra_rota', 'mantenimiento', 'corte_energia', 'enlace_caido', 'otro']

export async function crear(datos = {}, usuarioId = null) {
  const titulo = String(datos.titulo ?? '').trim()
  if (!titulo) {
    throw badRequest('Escribí qué pasó: ese texto es el que le va a llegar al abonado.')
  }

  const tipo = String(datos.tipo ?? 'averia')
  if (!TIPOS.includes(tipo)) throw badRequest(`Tipo desconocido: ${tipo}`)

  const programada = Boolean(datos.programada) || tipo === 'mantenimiento'

  const fila = {
    ...normalizarAlcance(datos),
    tipo,
    titulo: titulo.slice(0, 120),
    descripcion: String(datos.descripcion ?? '').trim() || null,
    programada,
    inicio_previsto: datos.inicio_previsto || null,
    fin_previsto: datos.fin_previsto || null,
    estimado_at: datos.estimado_at || null,
    // Cuándo empezó de verdad. En una avería que alguien carga a las 20:10
    // porque se enteró tarde, el corte fue a las 19:40 — y eso es lo que hay que
    // guardar: el reporte de duración se lee después para decidir dónde invertir.
    ocurrio_at: datos.ocurrio_at || new Date().toISOString(),
    avisar_apertura: datos.avisar_apertura !== false,
    avisar_resolucion: datos.avisar_resolucion !== false,
    notas: String(datos.notas ?? '').trim() || null,
    origen: 'manual',
    created_by: usuarioId,
  }

  const { data, error } = await db().from('incidencias_masivas').insert(fila).select().single()
  if (error) throw new AppError(`No se pudo crear la incidencia: ${error.message}`, { status: 502 })

  const { count } = await contar(data.id)
  return { ...data, afectados: count }
}

async function contar(id) {
  const { data } = await db().rpc('afectados_por_incidencia', { p_id: id })
  return { count: (data ?? []).length }
}

export async function listar({ estado = null, limite = 100 } = {}) {
  let q = db()
    .from('v_incidencias_masivas')
    .select('*')
    .order('ocurrio_at', { ascending: false })
    .limit(Math.min(500, limite))

  if (estado && estado !== 'todas') q = q.eq('estado', estado)

  const { data, error } = await q
  if (error) throw new AppError(`No se pudieron leer las incidencias: ${error.message}`, { status: 502 })
  return data ?? []
}

// --- Abrir, resolver, cancelar -----------------------------------------------

/**
 * Abrir es lo que manda los mensajes.
 *
 * No los manda acá: los encola. Ver el comentario de `abrir_incidencia` en la
 * migración 174 — 180 mensajes de golpe no los acepta ninguna API, y el que se
 * reintente sin registro llega dos veces.
 */
export async function abrir(id, usuarioId = null) {
  const { data, error } = await db().rpc('abrir_incidencia', { p_id: id, p_usuario: usuarioId })
  if (error) throw new AppError(error.message, { status: 400 })
  return data
}

export async function resolver(id, usuarioId = null) {
  const { data, error } = await db().rpc('resolver_incidencia', { p_id: id, p_usuario: usuarioId })
  if (error) throw new AppError(error.message, { status: 400 })
  return data
}

/**
 * Cancela: para la que se abrió sobre la zona equivocada.
 *
 * Lo que ya salió, salió — no hay forma de desenviar un WhatsApp. Lo que hace
 * es frenar en seco lo que todavía estaba en la cola, que en un padrón grande
 * es la mayor parte.
 */
export async function cancelar(id, motivo = null) {
  const { data: previa } = await db()
    .from('incidencias_masivas')
    .select('estado')
    .eq('id', id)
    .maybeSingle()

  if (!previa) throw notFound('No existe esa incidencia.')
  if (previa.estado === 'resuelta') throw badRequest('Esa incidencia ya se resolvió.')

  const { count: frenados } = await db()
    .from('incidencia_avisos')
    .update({ estado: 'omitido', motivo: 'La incidencia se canceló' }, { count: 'exact' })
    .eq('incidencia_id', id)
    .eq('estado', 'pendiente')

  const { error } = await db()
    .from('incidencias_masivas')
    .update({ estado: 'cancelada', notas: motivo })
    .eq('id', id)

  if (error) throw new AppError(`No se pudo cancelar: ${error.message}`, { status: 502 })

  return {
    ok: true,
    frenados: frenados ?? 0,
    aviso:
      'Se detuvo lo que quedaba en la cola. Los mensajes que ya salieron no se pueden retirar.',
  }
}

// --- La cola -----------------------------------------------------------------

/**
 * Manda los avisos pendientes.
 *
 * ── Por qué de a lotes ──
 *
 * Porque un corte grande son cientos de mensajes y ninguna API de mensajería
 * los toma de golpe: a la mitad se recibe un 429, y lo que se reintenta sin
 * registro llega dos veces. Se mandan `lote` por corrida y el resto espera al
 * siguiente latido — el abonado prefiere enterarse noventa segundos más tarde
 * que no enterarse.
 *
 * Un aviso que falla se reintenta dos veces más y después se cierra con el
 * motivo escrito. Un abonado sin correo ni celular no va a tener uno en la
 * próxima corrida, y su renglón quedaría reintentándose para siempre.
 */
export async function drenarIncidencias({ lote = 40 } = {}) {
  const { data, error } = await db()
    .from('v_incidencia_avisos_a_enviar')
    .select('*')
    .limit(lote)

  if (error) {
    // Sin la migración corrida esto todavía no existe. No es un fallo: es que
    // la función no está instalada.
    if (/does not exist/i.test(error.message)) return { enviados: 0, fallidos: 0 }
    throw new Error(`No se pudo leer la cola de incidencias: ${error.message}`)
  }
  if (!data?.length) return { enviados: 0, fallidos: 0 }

  // Las plantillas, una vez para todo el lote: son las mismas cuatro y leerlas
  // por abonado serían 180 consultas para mandar 180 mensajes.
  const { data: plantillas } = await db()
    .from('plantillas_mensaje')
    .select('clave, id, asunto, cuerpo')
    .eq('activa', true)
    .like('clave', '%incidencia%')

  const { data: mantenimiento } = await db()
    .from('plantillas_mensaje')
    .select('clave, id, asunto, cuerpo')
    .eq('activa', true)
    .like('clave', '%mantenimiento%')

  const porClave = new Map([...(plantillas ?? []), ...(mantenimiento ?? [])].map((p) => [p.clave, p]))

  let enviados = 0
  let fallidos = 0
  let omitidos = 0

  for (const aviso of data) {
    const r = await mandarUno(aviso, porClave)

    if (r.enviado) {
      enviados++
      await db()
        .from('incidencia_avisos')
        .update({ estado: 'enviado', canal: r.canal, enviado_en: new Date().toISOString() })
        .eq('id', aviso.aviso_id)
      continue
    }

    if (r.omitir) {
      omitidos++
      await db()
        .from('incidencia_avisos')
        .update({ estado: 'omitido', motivo: r.motivo })
        .eq('id', aviso.aviso_id)
      continue
    }

    fallidos++
    const intentos = (aviso.intentos ?? 0) + 1
    await db()
      .from('incidencia_avisos')
      .update({
        intentos,
        motivo: r.motivo,
        ...(intentos >= 3 ? { estado: 'fallido' } : {}),
      })
      .eq('id', aviso.aviso_id)
  }

  return { enviados, fallidos, omitidos }
}

/** Un aviso, por el primer canal que sirva. */
async function mandarUno(aviso, porClave) {
  // El que pidió que no lo molesten no recibe ni esto. Es su decisión, y vale
  // igual para el aviso de una avería: si eligió no recibir mensajes, mandarle
  // uno "porque este le conviene" es la razón por la que después pide la baja
  // de todos.
  if (aviso.avisos_activos === false) {
    return { enviado: false, omitir: true, motivo: 'el abonado pidió no recibir avisos' }
  }

  const claves = plantillasDe(aviso)

  const variables = {
    titulo: aviso.titulo ?? '',
    descripcion: aviso.descripcion ?? '',
    estimado: textoEstimado(aviso),
    ventana: textoVentana(aviso),
    duracion: textoDuracion(aviso),
    zona: aviso.zona ?? '',
  }

  let ultimoError = null
  let preparado = null

  for (const canal of canalesPara(aviso)) {
    // La larga para el correo, la corta para el teléfono: mismo criterio que el
    // resto de los avisos del sistema.
    const plantilla = porClave.get(canal === 'email' ? claves.email : claves.corta)
    if (!plantilla) continue

    try {
      const r = await enviar({
        client_id: aviso.cliente_id,
        canal,
        asunto: plantilla.asunto,
        cuerpo: plantilla.cuerpo,
        plantilla_id: plantilla.id,
        automatico: true,
        variables,
      })

      /**
       * WhatsApp en modo manual no entrega: deja el mensaje escrito para que
       * alguien lo mande. En un corte masivo eso NO sirve —nadie va a mandar
       * ciento ochenta a mano— así que se sigue probando el resto de los
       * canales, y solo si ninguno entregó se cuenta el preparado.
       */
      if (!seEntrego(r)) {
        preparado = preparado ?? canal
        continue
      }

      return { enviado: true, canal }
    } catch (e) {
      ultimoError = e.message
    }
  }

  if (preparado) return { enviado: true, canal: `${preparado} (pendiente)` }

  return {
    enviado: false,
    // Sin ningún canal utilizable no hay nada que reintentar: el abonado no
    // tiene correo ni celular cargado, y eso no cambia en dos minutos.
    omitir: !ultimoError,
    motivo: ultimoError ?? 'no tiene ningún canal de contacto cargado',
  }
}

// --- Lo que ve el bot --------------------------------------------------------

/**
 * ¿Este abonado está adentro de una avería que ya conocemos?
 *
 * Es la consulta que descarga el canal de soporte. Se contesta con lo que se le
 * puede leer en voz alta y sin nombres internos: el abonado no tiene por qué
 * saber que el nodo se llama "PTP-CERRO-AZUL-SECTOR3".
 */
export async function incidenciaActivaDe(clienteId) {
  const { data, error } = await db().rpc('incidencia_activa_de', { p_cliente: clienteId })
  if (error || !data) return null

  // La RPC devuelve la fila del tipo compuesto; con `.rpc` de PostgREST puede
  // llegar como objeto o como arreglo de uno.
  const i = Array.isArray(data) ? data[0] : data
  if (!i?.id) return null

  return {
    id: i.id,
    tipo: i.tipo,
    titulo: i.titulo,
    descripcion: i.descripcion,
    programada: i.programada,
    desde: i.ocurrio_at,
    estimado: i.estimado_at,
    // El texto ya armado, para que el bot no tenga que decidir cómo decirlo.
    mensaje: i.programada
      ? `Hay un mantenimiento programado en tu sector: ${i.titulo}. ${textoVentana(i)}.`
      : `Tenemos una avería en tu sector: ${i.titulo}. ${textoEstimado({ ...i, momento: 'apertura' })}`,
  }
}

// --- La detección automática -------------------------------------------------

/**
 * El monitoreo encontró un nodo caído.
 *
 * ── Por qué esto no manda nada por sí solo ──
 *
 * Porque la caída de un nodo y "180 abonados sin servicio" no son lo mismo
 * hasta que pasa el tiempo. Un enlace de radio pierde el haz treinta segundos
 * con una ráfaga; una fibra cortada no vuelve sola. El umbral en minutos es lo
 * único que distingue las dos cosas sin mirar el equipo.
 *
 * Entonces: se crea SIEMPRE la incidencia en borrador —así queda el registro y
 * el ISP puede ver durante un mes qué habría mandado— y se abre solo si el ISP
 * encendió la apertura automática Y el nodo lleva caído más que el umbral.
 *
 * El índice único de `nodo_id` con estado en (borrador, abierta) es lo que hace
 * que llamar a esto en cada sondeo no cree una incidencia nueva cada dos
 * minutos.
 *
 * @returns  null si no había nada que hacer, o el resumen de lo que hizo.
 */
export async function detectarCaida(nodo, { minutos = 15, automatico = false } = {}) {
  if (!nodo?.id) return null

  const { data: previa } = await db()
    .from('incidencias_masivas')
    .select('id, estado, ocurrio_at')
    .eq('nodo_id', nodo.id)
    .in('estado', ['borrador', 'abierta'])
    .maybeSingle()

  let incidencia = previa

  if (!incidencia) {
    const { data, error } = await db()
      .from('incidencias_masivas')
      .insert({
        tipo: nodo.tipo === 'olt' ? 'fibra_rota' : 'enlace_caido',
        // El título se lee tal cual en el mensaje del abonado, así que no lleva
        // el nombre interno del nodo: "PTP-CERRO-AZUL-SECTOR3" no le dice nada
        // a nadie y suena a que se filtró algo del sistema.
        titulo: nodo.punto
          ? `Corte de servicio en ${nodo.punto}`
          : 'Corte de servicio en su sector',
        descripcion: 'Nuestro monitoreo detectó la interrupción y el equipo técnico ya está trabajando.',
        alcance: 'nodo',
        nodo_id: nodo.id,
        // La hora en que el nodo se cayó, no la de ahora: el abonado ya estaba
        // sin servicio y el reporte de duración tiene que decir la verdad.
        ocurrio_at: nodo.desde ?? new Date().toISOString(),
        origen: 'nms',
      })
      .select('id, estado, ocurrio_at')
      .single()

    if (error) {
      // 23505 = otra corrida la creó primero. No es un error: es el índice único
      // haciendo exactamente lo que tiene que hacer, y la próxima pasada del
      // sondeo va a encontrarla con el `maybeSingle` de arriba.
      if (error.code === '23505') return null
      // Cualquier otra cosa sí importa: sin la incidencia, los abonados de ese
      // nodo no se van a enterar de nada. Se avisa y se sigue —el técnico ya
      // recibió su alerta— pero no en silencio.
      console.error(`[incidencias] no se pudo crear la de ${nodo.nombre}: ${error.message}`)
      return null
    }
    incidencia = data
  }

  if (incidencia.estado === 'abierta') return { incidencia_id: incidencia.id, ya_abierta: true }

  const caidaMinutos = (Date.now() - new Date(incidencia.ocurrio_at).getTime()) / 60000

  if (!automatico) {
    return { incidencia_id: incidencia.id, en_borrador: true, motivo: 'la apertura automática está apagada' }
  }
  if (caidaMinutos < minutos) {
    return {
      incidencia_id: incidencia.id,
      en_borrador: true,
      motivo: `lleva ${Math.round(caidaMinutos)} min caído; el umbral es ${minutos}`,
    }
  }

  const r = await abrir(incidencia.id)
  return { incidencia_id: incidencia.id, abierta: true, ...r }
}

/**
 * El nodo volvió. Se cierra su incidencia y sale el "ya está".
 *
 * Solo se resuelven las que abrió el monitoreo para ESE nodo: una avería que
 * cargó una persona a mano la cierra una persona, aunque el nodo se haya
 * recuperado — puede haber quedado un tramo afectado que el ping no ve.
 */
export async function detectarRecuperacion(nodo) {
  if (!nodo?.id) return null

  const { data: abierta } = await db()
    .from('incidencias_masivas')
    .select('id, estado')
    .eq('nodo_id', nodo.id)
    .eq('origen', 'nms')
    .in('estado', ['borrador', 'abierta'])
    .maybeSingle()

  if (!abierta) return null

  // La que nunca se abrió no se "resuelve": se cancela en silencio. Resolverla
  // dejaría en el historial una avería comunicada que nadie comunicó.
  if (abierta.estado === 'borrador') {
    await db()
      .from('incidencias_masivas')
      .update({ estado: 'cancelada', notas: 'El nodo se recuperó antes del umbral de aviso' })
      .eq('id', abierta.id)
    return { incidencia_id: abierta.id, cancelada: true }
  }

  const r = await resolver(abierta.id)
  return { incidencia_id: abierta.id, resuelta: true, ...r }
}
