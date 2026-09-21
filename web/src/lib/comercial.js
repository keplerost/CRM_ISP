import { supabase } from './supabaseClient'
import { ESTADOS_ABIERTOS } from './ventas'
import { loQueFalta as loQueFaltaEnExpediente } from './expedientes'

/**
 * El dashboard comercial: los datos que responden "qué hago hoy".
 *
 * ── Todo sale de lo que ya está cargado ──
 *
 * No hay ninguna métrica estimada ni ningún número de ejemplo. El puntaje de
 * conversión lo calcula la vista `v_prospectos` con cinco señales observables, y
 * llega con sus motivos: si la pantalla dice que hay que llamar a alguien, se
 * puede ver por qué. Un tablero que no explica sus números no se usa dos veces.
 *
 * ── Por qué el vendedor ve solo lo suyo ──
 *
 * `alcance` recorta por vendedor salvo que quien mira tenga `ventas.equipo`.
 * Esto es comodidad, no seguridad: lo que impide de verdad que un vendedor lea
 * la cartera de otro es RLS. Acá es para que el tablero le hable a él.
 */

/**
 * Las paletas del tablero, una por tema.
 *
 * Las dos están validadas contra la superficie sobre la que se dibujan —#0f172a
 * en oscuro, #f1f5f9 en claro— y pasan banda de luminosidad, piso de croma,
 * separación para daltonismo y contraste.
 *
 * La versión clara arrastra un aviso de contraste en cuatro tonos: sobre fondo
 * claro no llegan a 3:1. Es aceptable acá y solo acá porque ninguna marca de
 * color va sola: cada etapa del embudo lleva su nombre y su número escritos, así
 * que el color acompaña la lectura, nunca la carga. Si alguna vez se usa uno de
 * estos tonos sin etiqueta al lado, hay que volver a elegirlo.
 */
const PALETA = {
  oscuro: {
    serie: '#3987e5',
    // Fijo y en este orden. No se cicla ni se genera: una etapa nueva toma el
    // siguiente slot, no un color inventado.
    etapas: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'],
    embudo: ['#b7d3f6', '#6da7ec', '#2a78d6', '#184f95'],
    eje: '#64748b',
    grilla: '#1e293b',
  },
  claro: {
    serie: '#2a78d6',
    etapas: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#4a3aa7'],
    embudo: ['#b7d3f6', '#6da7ec', '#2a78d6', '#184f95'],
    eje: '#64748b',
    grilla: '#e2e8f0',
  },
}

/** Los colores de estado NO cambian con el tema: significan lo mismo siempre. */
const ESTADO = {
  bien: '#0ca30c',
  alerta: '#fab219',
  critico: '#d03b3b',
  caliente: '#ea580c',
}

export const paleta = (tema) => ({ ...PALETA[tema === 'claro' ? 'claro' : 'oscuro'], ...ESTADO })

/** Compatibilidad con lo que ya usaba `COLORES` directo. */
export const COLORES = { ...PALETA.oscuro, ...ESTADO }

/**
 * Iniciales y un color estable para el avatar.
 *
 * El sistema no guarda fotos, así que la alternativa era un ícono gris igual
 * para todos —que no ayuda a distinguir— o inventar imágenes. Las iniciales con
 * un color derivado del nombre se reconocen de reojo en una lista, que es para
 * lo que sirve un avatar acá.
 *
 * El color sale de una suma de códigos de carácter: la misma persona tiene
 * siempre el mismo, sin guardar nada.
 */
export function avatar(nombre, tema = 'oscuro') {
  const limpio = String(nombre ?? '?').trim()
  const partes = limpio.split(/\s+/).filter(Boolean)
  const iniciales = (partes[0]?.[0] ?? '?') + (partes[1]?.[0] ?? '')

  let suma = 0
  for (let i = 0; i < limpio.length; i++) suma += limpio.charCodeAt(i)
  const colores = PALETA[tema === 'claro' ? 'claro' : 'oscuro'].etapas

  return { iniciales: iniciales.toUpperCase(), color: colores[suma % colores.length] }
}

/**
 * A dónde llega el mes si sigue este ritmo.
 *
 * Es una regla de tres sobre los días hábiles transcurridos, no un pronóstico:
 * dice "si seguís así, terminás en N". Presentarlo como predicción sería
 * prometer algo que ningún dato sostiene — dos ventas el día 2 no significan
 * treinta en el mes.
 */
export function proyeccionDelMes(altas) {
  const hoy = new Date()
  const diasTranscurridos = hoy.getDate()
  const diasDelMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate()
  const restantes = diasDelMes - diasTranscurridos

  const ritmo = diasTranscurridos > 0 ? altas / diasTranscurridos : 0
  return {
    ritmo,
    restantes,
    // Se redondea hacia abajo: prometer de más en un tablero de metas es peor
    // que quedarse corto.
    proyectado: Math.floor(altas + ritmo * restantes),
  }
}

/**
 * Los logros, calculados de datos reales.
 *
 * Nada de esto se guarda: se deduce de las ventas y los prospectos que ya
 * existen. Guardar medallas obligaría a un proceso que las otorgue y a
 * mantenerlo sincronizado; calculadas no pueden quedar mal.
 *
 * Son cuatro y no veinte a propósito. Una vitrina llena de logros imposibles
 * deja de motivar y pasa a ser decoración.
 */
export function logros({ altas, meta, racha, prospectosDelMes }) {
  return [
    {
      clave: 'primera',
      nombre: 'Primera venta',
      logrado: altas >= 1,
      ayuda: altas >= 1 ? 'Ya cerraste tu primera del mes' : 'Cerrá tu primera venta del mes',
      color: '#3987e5',
    },
    {
      clave: 'racha',
      nombre: racha >= 3 ? `${racha} en racha` : '3 en racha',
      logrado: racha >= 3,
      ayuda:
        racha >= 3
          ? `${racha} días seguidos vendiendo`
          : `Llevás ${racha} ${racha === 1 ? 'día' : 'días'} — hacen falta 3`,
      color: '#c98500',
    },
    {
      clave: 'cazador',
      nombre: 'Cazador',
      logrado: prospectosDelMes >= 10,
      ayuda:
        prospectosDelMes >= 10
          ? `${prospectosDelMes} prospectos cargados este mes`
          : `${prospectosDelMes} de 10 prospectos cargados`,
      color: '#d55181',
    },
    {
      clave: 'meta',
      nombre: meta > 0 && altas >= meta ? 'Meta cumplida' : 'Meta 50%',
      logrado: meta > 0 && altas >= meta / 2,
      ayuda:
        meta > 0
          ? `${Math.round((altas / meta) * 100)}% de la meta`
          : 'Sin meta fijada este mes',
      color: '#199e70',
    },
  ]
}

/** El saludo, según la hora. Es lo primero que se lee y ubica el turno. */
export function saludo(nombre) {
  const h = new Date().getHours()
  const momento = h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches'
  return `¡${momento}, ${String(nombre ?? '').split(' ')[0] || 'equipo'}!`
}

const mesActual = () => {
  const hoy = new Date()
  return { anio: hoy.getFullYear(), mes: hoy.getMonth() + 1 }
}

export const comercialApi = {
  /**
   * Todo el tablero en una carga.
   *
   * Va junto y no en cinco llamadas separadas porque las cinco tarjetas se leen
   * de un vistazo: mostrarlas apareciendo de a una hace que el número que ya
   * estabas mirando salte de lugar.
   */
  async tablero({ vendedorId } = {}) {
    let q = supabase.from('v_prospectos').select('*').limit(1000)
    if (vendedorId) q = q.eq('vendedor_id', vendedorId)

    let qs = supabase
      .from('v_seguimientos')
      .select('*')
      .neq('estado', 'cancelado')
      .not('programado_para', 'is', null)
      .order('programado_para')
      .limit(300)
    if (vendedorId) qs = qs.eq('vendedor_id', vendedorId)

    const [prospectos, seguimientos, equipo, cobros, expedientes] = await Promise.all([
      q,
      qs,
      supabase.from('v_comercial_vendedor').select('*'),
      // La bandeja ya viene filtrada por vendedor desde la propia vista, así que
      // acá no hace falta volver a acotarla — ni se puede: la vista corre con
      // privilegio y decide adentro.
      supabase.from('v_cobros_por_gestionar').select('*'),
      supabase.from('v_expedientes').select('*').eq('estado', 'abierto'),
    ])

    if (prospectos.error) throw prospectos.error

    // La racha se calcula en la base: contarla acá exigiría traer todas las
    // ventas del año para mirar hacia atrás día por día.
    let racha = 0
    if (vendedorId) {
      const { data } = await supabase.rpc('racha_de_ventas', { p_vendedor: vendedorId })
      racha = data ?? 0
    }

    return {
      prospectos: prospectos.data ?? [],
      seguimientos: (seguimientos.data ?? []).filter((s) => s.estado === 'pendiente'),
      equipo: equipo.data ?? [],
      cobros: cobros.data ?? [],
      expedientes: expedientes.data ?? [],
      racha,
    }
  },

  /**
   * Fija la meta del mes en curso. `vendedorId` null = la del equipo.
   *
   * Busca primero y después inserta o actualiza, en vez de un upsert: el índice
   * que hace única la meta está sobre `COALESCE(vendedor_id, ...)` —porque en
   * SQL un NULL nunca choca con otro NULL— y un upsert no puede apuntar a un
   * índice sobre una expresión.
   */
  async guardarMeta({ vendedorId, meta_altas, meta_monto }) {
    const { anio, mes } = mesActual()

    let busca = supabase.from('metas_venta').select('id').eq('anio', anio).eq('mes', mes)
    busca = vendedorId ? busca.eq('vendedor_id', vendedorId) : busca.is('vendedor_id', null)
    const { data: existente } = await busca.maybeSingle()

    const fila = {
      vendedor_id: vendedorId ?? null,
      anio,
      mes,
      meta_altas: Number(meta_altas) || 0,
      meta_monto: Number(meta_monto) || 0,
    }
    const { error } = existente
      ? await supabase.from('metas_venta').update(fila).eq('id', existente.id)
      : await supabase.from('metas_venta').insert(fila)
    if (error) throw error
  },

  /**
   * Verifica la cobertura de un punto.
   *
   * Le pregunta a `cobertura_cercana`, que existe desde la migración 31 y ya
   * descuenta los puertos que reservaron instalaciones agendadas. Sin ese
   * descuento, dos ventas del mismo día se prometen sobre la misma caja llena.
   */
  async verificar({ lat, lng, tecnologia = 'ftth' }) {
    const { data, error } = await supabase.rpc('cobertura_cercana', {
      p_lat: lat,
      p_lng: lng,
      p_tecnologia: tecnologia,
      p_limite: 5,
    })
    if (error) throw error

    const cercanas = data ?? []
    const mejor = cercanas[0] ?? null

    // La regla de decisión, escrita una sola vez:
    //
    //   Sin nada cerca o a más de 300 m → no llega.
    //   Caja con puertos libres         → se vende hoy.
    //   Caja llena, o sin capacidad cargada, o entre 300 y 300 m con obra
    //                                   → que lo confirme alguien de red.
    //
    // El umbral de 300 m es el largo razonable de una bajada de fibra desde la
    // caja. Más que eso no es "sin cobertura": es una obra, y quien la aprueba
    // no es el vendedor.
    let resultado = 'sin_cobertura'
    if (mejor) {
      if (mejor.distancia_m <= 300 && mejor.disponibles > 0) resultado = 'disponible'
      else if (mejor.distancia_m <= 300) resultado = 'requiere_verificacion'
      else if (mejor.distancia_m <= 800) resultado = 'con_obra'
    }

    return { resultado, cercanas, mejor }
  },

  async guardarVerificacion(v) {
    const { data, error } = await supabase
      .from('verificaciones_cobertura')
      .insert(v)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async verificaciones(limite = 100) {
    const { data, error } = await supabase
      .from('verificaciones_cobertura')
      .select('*')
      .order('creado_en', { ascending: false })
      .limit(limite)
    if (error) throw error
    return data ?? []
  },

  /** Las capas del mapa comercial. Cada una se pide entera y se filtra en pantalla. */
  async mapa() {
    const [prospectos, clientes, cajas, zonas, instalaciones] = await Promise.all([
      supabase
        .from('v_prospectos')
        .select('id, nombre, sector, estado, puntaje, latitud, longitud, vendedor, vendedor_id, telefono, plan, valor_mensual')
        .not('latitud', 'is', null),
      supabase
        .from('v_clientes_ficha')
        .select('id, nombre, estado, latitud, longitud, plan')
        .not('latitud', 'is', null),
      supabase
        .from('v_cajas_nap')
        .select('id, nombre, latitud, longitud, capacidad, libres, llena, activo')
        .not('latitud', 'is', null),
      supabase.from('zonas_cobertura').select('*').eq('activa', true),
      supabase
        .from('v_instalaciones')
        .select('id, titular, estado, latitud, longitud, fecha')
        .in('estado', ['prospecto', 'agendada', 'en_curso'])
        .not('latitud', 'is', null),
    ])

    // Cada capa se degrada sola: que falte la vista de instalaciones en una
    // instalación vieja no puede dejar el mapa entero en blanco.
    return {
      prospectos: prospectos.data ?? [],
      clientes: clientes.data ?? [],
      cajas: cajas.data ?? [],
      zonas: zonas.data ?? [],
      instalaciones: instalaciones.data ?? [],
    }
  },
}

/**
 * Arma la lista de "qué hacer hoy", en orden de urgencia.
 *
 * El orden no es cronológico ni por puntaje: es por costo de no hacerlo. Un
 * seguimiento vencido ya está fallando; uno de hoy todavía se puede cumplir; un
 * prospecto caliente sin nada agendado es plata sobre la mesa que nadie tocó.
 */
export function loQueHayQueHacer(prospectos, seguimientos, cobros = [], expedientes = []) {
  const ahora = Date.now()
  const hoy = new Date().toISOString().slice(0, 10)
  const acciones = []

  // ── Cobros vencidos ──
  // Primero de todo, antes incluso que los seguimientos: un cliente con 20 días
  // de atraso está por cortarse, y un corte cuesta la reconexión, la llamada de
  // queja y a veces al cliente entero.
  cobros
    .filter((c) => (c.dias_atraso ?? 0) >= 15)
    .forEach((c) =>
      acciones.push({
        clave: `cob-${c.asignacion_id}`,
        urgencia: 0,
        tipo: 'Cobro vencido',
        titulo: c.cliente,
        detalle: `Debe ${(Number(c.saldo_pendiente) || 0).toFixed(2)} · ${c.dias_atraso} días`,
        telefono: c.telefono,
        a: '/ventas/cobranza',
      }),
    )

  // ── Promesas que vencen hoy ──
  // El día que prometió pagar es el único día en que llamar sirve. Mañana ya es
  // un incumplimiento y la conversación es otra.
  cobros
    .filter((c) => c.promesa_fecha === hoy)
    .forEach((c) =>
      acciones.push({
        clave: `pro-hoy-${c.asignacion_id}`,
        urgencia: 0,
        tipo: 'Promesa vence hoy',
        titulo: c.cliente,
        detalle: `Prometió pagar ${(Number(c.promesa_monto ?? c.saldo_pendiente) || 0).toFixed(2)}`,
        telefono: c.telefono,
        a: '/ventas/cobranza',
      }),
    )

  // ── Expedientes a medio hacer ──
  // Una venta ganada que no se documenta no es una venta: no llega a
  // instalaciones y el cliente sigue esperando sin que nadie se entere.
  expedientes
    .filter((e) => e.estado === 'abierto')
    .forEach((e) =>
      acciones.push({
        clave: `exp-${e.id}`,
        urgencia: e.completo ? 1 : 1,
        tipo: e.completo ? 'Listo para enviar' : e.ok_contrato ? 'Falta la firma' : 'Expediente incompleto',
        titulo: e.cliente,
        detalle: e.completo
          ? 'Todo cargado — envialo a instalaciones'
          : `Falta: ${loQueFaltaEnExpediente(e).slice(0, 2).join(', ')}`,
        a: `/ventas/expediente/${e.id}`,
      }),
    )

  seguimientos.forEach((s) => {
    // Sin fecha no es un seguimiento agendado, es una nota. Saltearlo importa
    // porque `new Date(null)` da el epoch, que siempre es menor que ahora: sin
    // esta línea, cada nota suelta aparecería como vencida y en lo más urgente
    // de la lista. La consulta del tablero ya las filtra, pero esta función se
    // exporta y no puede depender de que quien la llame lo haya hecho.
    if (!s.programado_para) return

    const cuando = new Date(s.programado_para).getTime()
    const vencido = cuando < ahora
    const hoy = new Date(s.programado_para).toDateString() === new Date().toDateString()
    if (!vencido && !hoy) return
    acciones.push({
      clave: `seg-${s.id}`,
      urgencia: vencido ? 0 : 1,
      tipo: vencido ? 'Vencido' : 'Hoy',
      titulo: s.prospecto,
      detalle: s.proxima_accion || s.detalle || `${s.tipo} pendiente`,
      telefono: s.telefono || s.telefono_whatsapp,
      prospectoId: s.prospecto_id,
      cuando: s.programado_para,
    })
  })

  // Los calientes sin nada agendado. Se corta en 60 porque debajo de ahí el
  // "urgente" deja de serlo y la lista se vuelve un segundo listado completo,
  // que es justo lo que este panel viene a evitar.
  //
  // Acá NO se recorta la cantidad. Antes cortaba en los ocho primeros, y esa
  // decisión estaba en el lugar equivocado: si había treinta prospectos
  // calientes desatendidos, veintidós desaparecían sin que nada lo dijera, y la
  // pantalla se leía como "esto es todo lo que hay". Cuántos mostrar es una
  // decisión de la pantalla, y tiene que ser visible; acá se devuelven todos.
  const conSeguimiento = new Set(seguimientos.map((s) => s.prospecto_id))
  prospectos
    .filter(
      (p) =>
        ESTADOS_ABIERTOS.includes(p.estado) && p.puntaje >= 60 && !conSeguimiento.has(p.id),
    )
    .sort((a, b) => b.puntaje - a.puntaje)
    .forEach((p) => {
      acciones.push({
        clave: `pro-${p.id}`,
        urgencia: 2,
        tipo: 'Sin agendar',
        titulo: p.nombre,
        detalle: (p.motivos_puntaje ?? []).slice(0, 2).join(' · ') || 'Prospecto con alta chance',
        telefono: p.telefono,
        prospectoId: p.id,
        puntaje: p.puntaje,
      })
    })

  return acciones.sort((a, b) => a.urgencia - b.urgencia || (b.puntaje ?? 0) - (a.puntaje ?? 0))
}
