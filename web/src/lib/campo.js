import { supabase } from './supabaseClient'
import { semaforoDe } from './instalaciones'
import { conCache } from './cacheLocal'

/**
 * Los datos del día del técnico.
 *
 * ── Qué decide esta pantalla ──
 *
 * Un técnico en la calle no navega: mira el teléfono entre dos trabajos, con
 * una mano, y necesita responder tres preguntas en ese orden:
 *
 *   1. ¿La red está bien? — porque si el nodo de la zona está caído, el ticket
 *      que tiene asignado no es un problema del domicilio y no tiene que ir.
 *   2. ¿Qué me falta hoy?
 *   3. ¿A dónde voy ahora?
 *
 * Todo lo que no responda una de esas tres no va en el inicio.
 *
 * ── Por qué una sola función y no cinco hooks ──
 *
 * Son cinco consultas que se piden juntas y se muestran juntas. Con hooks
 * separados la pantalla se dibuja cinco veces y el técnico ve los bloques
 * apareciendo de a uno, que en una pantalla chica se lee como que algo falla.
 */

/**
 * La fecha de HOY según el reloj del técnico, no según Greenwich.
 *
 * ── El error que esto arregla ──
 *
 * Antes era `new Date().toISOString().slice(0, 10)`, que devuelve la fecha en
 * UTC. Ecuador está en UTC-5, así que **todas las noches a partir de las 19:00
 * el sistema pasaba al día siguiente**: el técnico terminaba su última visita a
 * las 20:00 y el tablero le mostraba la agenda de mañana, con su jornada del
 * día en cero y sus trabajos recién hechos contados como "atrasados".
 *
 * Se detectó probando el resumen del día a las 22:46 hora local: `hoyISO()`
 * decía 11 de agosto cuando eran las diez de la noche del 10.
 *
 * `instalaciones.fecha` es un DATE —una fecha de calendario, sin hora ni zona—
 * cargada por la oficina pensando en el día laboral. Compararla contra una
 * fecha derivada de UTC es comparar dos cosas distintas.
 */
export const hoyISO = () => {
  const d = new Date()
  const dosDigitos = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${dosDigitos(d.getMonth() + 1)}-${dosDigitos(d.getDate())}`
}

/** La fecha local de un instante cualquiera. Mismo motivo que arriba. */
const fechaLocalDe = (valor) => {
  if (!valor) return null
  const d = new Date(valor)
  if (Number.isNaN(d.getTime())) return null
  const dosDigitos = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${dosDigitos(d.getMonth() + 1)}-${dosDigitos(d.getDate())}`
}

/**
 * Todo lo del inicio, en un viaje.
 *
 * Cada bloque falla por separado a propósito: que el estado de la red no
 * responda no puede dejar al técnico sin ver su ruta. Lo que falla queda en
 * `null` y la pantalla lo dice, en vez de mostrar un error que tapa todo.
 */
async function leerTablero(perfil) {
  const tecnicoId = perfil?.tecnico_id ?? null
  const hoy = hoyISO()

  const [ordenes, tickets, red, notificaciones, novedades, retiros, material] = await Promise.all([
    // Las instalaciones ya vienen filtradas por RLS: `instalaciones_lectura`
    // solo devuelve las de su `tecnico_id`. El filtro de acá abajo es para el
    // día, no para la seguridad — si fuera para la seguridad estaría en el
    // lugar equivocado.
    supabase
      .from('v_instalaciones')
      .select('*')
      .in('estado', ['agendada', 'en_ruta', 'en_curso', 'reprogramada'])
      .order('fecha')
      .order('hora', { nullsFirst: false })
      .limit(40)
      .then(({ data, error }) => {
        if (error) throw error
        return data ?? []
      }),

    /**
     * Los tickets abiertos del técnico.
     *
     * ── Las columnas son las reales, y eso costó un bug ──
     *
     * La primera versión pedía `titulo`, `cliente_nombre` y `creado_en`. Ninguna
     * de las tres existe: la tabla tiene `tipo_incidencia`, `nombre` y
     * `created_at`. La consulta fallaba entera y —como el error se descartaba—
     * la pantalla decía "no tenés tickets asignados" con el ticket ahí,
     * correctamente asignado.
     *
     * Esa es la peor forma de fallar: no parece un error, parece un hecho.
     */
    supabase
      .from('tickets')
      .select(
        'id, numero, nombre, tipo_incidencia, descripcion, estado, prioridad, direccion, fecha_visita, franja, created_at, salida_at, llegada_at, cerrado_at',
      )
      .order('created_at', { ascending: false })
      .limit(30)
      .then(({ data, error }) => {
        // El error se propaga en vez de convertirse en una lista vacía. Una
        // lista vacía es una afirmación —"no hay nada"— y esta pantalla no
        // puede afirmar eso cuando lo que pasó es que no pudo preguntar.
        if (error) throw error
        return data ?? []
      }),

    // Va por la vista y no por el middleware: son datos que ya están en la base
    // y una llamada HTTP más es una espera más en una conexión de celular.
    supabase
      .from('v_estado_red')
      .select('*')
      .eq('monitorear', true)
      // Esta sí puede fallar sin romper nada: la 85 puede no estar corrida
      // todavía, y sin estado de red el técnico igual tiene que ver su día.
      // Devuelve `null`, que la pantalla lee como "no se sabe" y oculta la
      // tarjeta — distinto de `[]`, que diría "no hay nodos".
      .then(({ data, error }) => (error ? null : (data ?? []))),

    supabase
      .from('v_notificaciones')
      .select('*')
      .is('leida_en', null)
      .order('creado_en', { ascending: false })
      .limit(10)
      .then(({ data, error }) => (error ? [] : (data ?? []))),

    /**
     * Qué pasó en la red mientras no estaba.
     *
     * ── Por qué NO se filtra por el último ingreso ──
     *
     * El pedido decía "desde su último ingreso". Hacerlo literal deja la
     * sección vacía casi siempre: `ultimo_acceso` se sella en CADA carga de la
     * app, así que a los diez segundos de abrir, "desde tu último ingreso" son
     * diez segundos y no pasó nada.
     *
     * Se resuelve como una bandeja de entrada: se trae el historial y se MARCA
     * lo nuevo. El técnico ve qué pasó anoche y, arriba, cuántas de esas cosas
     * no había visto. Esconder el resto para cumplir la letra habría cumplido
     * peor la intención.
     */
    supabase
      .from('v_novedades_red')
      .select('*')
      .order('momento', { ascending: false })
      .limit(12)
      .then(({ data, error }) => (error ? [] : (data ?? []))),

    /**
     * Los equipos que tiene que ir a buscar.
     *
     * Igual que las instalaciones: ya vienen filtradas por RLS, que devuelve
     * solo las del técnico asignado o las de quien figura como responsable. El
     * orden es el del día de trabajo — primero lo que tiene hora.
     *
     * Falla en silencio a `[]` a propósito: que la cartera no responda no puede
     * dejar al técnico sin ver su ruta de instalaciones.
     */
    supabase
      .from('v_retiros_equipo')
      .select('id, cliente, telefono, direccion, zona, serie, modelo, estado, agendado_para, agenda_nota, meses_sin_pago, intentos')
      .in('estado', ['pendiente', 'asignado'])
      .order('agendado_para', { ascending: true, nullsFirst: false })
      .limit(20)
      .then(({ data, error }) => (error ? [] : (data ?? []))),

    /**
     * El material que se le está acabando.
     *
     * Va en el tablero y no solo en una notificación porque el aviso sirve en un
     * momento muy preciso: cuando todavía está por pasar por la bodega. Una
     * notificación se lee y se cierra; esto sigue estando arriba mientras el
     * problema exista, que es hasta que alguien le cargue el material.
     *
     * RLS no filtra esta vista por técnico —es un cruce de almacenes y
     * artículos—, así que el filtro va acá. Sin él, el técnico vería lo que le
     * falta a la bodega central, que no es asunto suyo y le taparía lo propio.
     *
     * Falla en silencio a `[]`: que la 123 no esté corrida no puede dejarlo sin
     * ver su ruta.
     */
    tecnicoId
      ? supabase
          .from('v_stock_bajo')
          .select('articulo, cantidad, unidad, minimo, sugerido, agotado')
          .eq('tecnico_id', tecnicoId)
          .order('agotado', { ascending: false })
          .limit(15)
          .then(({ data, error }) => (error ? [] : (data ?? [])))
      : Promise.resolve([]),
  ])

  const delDia = (ordenes ?? []).filter((o) => o.fecha === hoy)
  const atrasadas = (ordenes ?? []).filter((o) => o.fecha && o.fecha < hoy)
  // Los tickets abiertos son los que cuentan como trabajo pendiente; los
  // cerrados vienen igual porque alimentan "recientes" y el resumen del día.
  const ticketsAbiertos = (tickets ?? []).filter(
    (t) => !['resuelto', 'cancelado'].includes(t.estado),
  )

  /**
   * Cuáles no había visto.
   *
   * `perfil.ultimo_acceso` vale porque el legajo se lee ANTES de sellar el
   * acceso nuevo: durante toda la sesión guarda el ingreso ANTERIOR, que es
   * justamente el corte que se busca.
   */
  const desde = perfil?.ultimo_acceso ? new Date(perfil.ultimo_acceso).getTime() : null
  const novedadesMarcadas = (novedades ?? []).map((e) => ({
    ...e,
    nueva: desde ? new Date(e.momento).getTime() > desde : false,
  }))

  return {
    tecnicoId,
    ordenes: ordenes ?? [],
    tickets: ticketsAbiertos,
    todosLosTickets: tickets ?? [],
    notificaciones: notificaciones ?? [],
    novedades: novedadesMarcadas,
    novedadesNuevas: novedadesMarcadas.filter((e) => e.nueva).length,
    desdeUltimoIngreso: perfil?.ultimo_acceso ?? null,
    red: red === null ? null : resumirRed(red, novedades ?? []),
    jornada: jornadaDe(delDia, atrasadas, ticketsAbiertos),
    resumen: resumenDelDia(delDia, tickets ?? []),
    recientes: recientesDe(ordenes ?? [], tickets ?? []),
    retiros: retiros ?? [],
    material: material ?? [],
    materialAgotado: (material ?? []).filter((m) => m.agotado).length,
    // Los que tienen cita y ya se pasó la hora: es lo único de este bloque que
    // el técnico tiene que ver sin buscarlo.
    retirosVencidos: (retiros ?? []).filter(
      (r) => r.agendado_para && new Date(r.agendado_para) < new Date(),
    ).length,
    ruta: rutaDe(delDia),
    // La próxima es la primera de la ruta que todavía no se hizo. Sale aparte
    // porque es lo único que el técnico necesita mirar sin pensar.
    proxima: rutaDe(delDia).find((o) => o.estado !== 'hecha') ?? null,
    atrasadas,
  }
}

/**
 * El tablero, con red de seguridad.
 *
 * Si la lectura falla —sin señal, casi siempre— devuelve lo último que se pudo
 * leer, marcado con la hora. La pantalla TIENE que mostrar esa hora: un técnico
 * mirando la ruta de ayer creyendo que es la de hoy maneja hasta la casa
 * equivocada.
 *
 * La caché es por técnico. Sin eso, en un teléfono que se presta, el segundo
 * vería la jornada del primero.
 */
export async function tableroDelDia(perfil) {
  const clave = `tablero:${perfil?.id ?? 'anonimo'}`
  const { datos, deCache, minutos } = await conCache(clave, () => leerTablero(perfil))
  return { ...datos, deCache, minutosDeCache: minutos }
}

/**
 * El resumen del día.
 *
 * ── Qué NO trae, y por qué ──
 *
 * La distancia recorrida. Para saberla habría que seguir al técnico por GPS
 * durante toda la jornada, y este sistema solo toma una coordenada puntual: la
 * de llegada a cada trabajo. Sumar las distancias entre esas coordenadas daría
 * un número que parece kilómetros recorridos y no lo es —ignora el camino real,
 * las vueltas y el regreso—. Un dato inventado que se ve exacto es peor que un
 * dato ausente.
 */
function resumenDelDia(delDia, tickets) {
  const hoy = hoyISO()
  // Por fecha LOCAL: `salida_at` y `cerrado_at` son instantes con zona, y
  // cortarlos con `slice(0,10)` los agrupaba por día UTC.
  const deHoy = (f) => fechaLocalDe(f) === hoy

  // El inicio de jornada sale de la primera marca real: salir hacia un trabajo
  // o llegar a uno. No se usa el último acceso al sistema porque abrir la app
  // desde la cama no es empezar a trabajar.
  const marcas = tickets
    .flatMap((t) => [t.salida_at, t.llegada_at])
    .filter((m) => deHoy(m))
    .sort()

  const inicio = marcas[0] ?? null
  const cerradosHoy = tickets.filter((t) => t.estado === 'resuelto' && deHoy(t.cerrado_at)).length

  return {
    inicio,
    // Desde la primera marca hasta ahora. No es "tiempo facturable": es cuánto
    // hace que arrancó, que es lo que el técnico quiere ver de un vistazo.
    minutosDesdeInicio: inicio ? Math.round((Date.now() - new Date(inicio)) / 60000) : null,
    instalacionesHechas: delDia.filter((o) => o.estado === 'hecha').length,
    ticketsCerrados: cerradosHoy,
  }
}

/**
 * Los últimos trabajos, instalaciones y tickets mezclados.
 *
 * Van juntos porque para el técnico son lo mismo —una salida a un domicilio— y
 * separarlos en dos listas obliga a mirar dos lugares para responder "¿qué hice
 * hoy?".
 */
function recientesDe(ordenes, tickets) {
  const deInstalacion = ordenes.map((o) => ({
    id: o.id,
    numero: o.numero,
    tipo: o.tipo === 'nueva' ? 'Instalación' : 'Visita',
    cliente: o.cliente ?? o.nombre,
    cuando: o.fecha ? `${o.fecha}T${o.hora ?? '00:00:00'}` : o.created_at,
    hora: o.hora,
    estado: o.estado,
    a: `/instalaciones/${o.id}/alta`,
  }))
  const deTicket = tickets.map((t) => ({
    id: t.id,
    numero: t.numero,
    tipo: 'Soporte',
    cliente: t.nombre,
    cuando: t.created_at,
    hora: null,
    estado: t.estado,
    a: `/campo/soporte/${t.id}`,
  }))
  return [...deInstalacion, ...deTicket]
    .sort((a, b) => String(b.cuando).localeCompare(String(a.cuando)))
    .slice(0, 6)
}

/**
 * El estado de la red, resumido en algo accionable.
 *
 * ── Por qué los nodos "por el padre" se cuentan aparte ──
 *
 * Un corte de fibra en cabecera tira veinte nodos. Contarlos como veinte
 * incidencias hace que la pantalla grite lo mismo por un problema que por
 * veinte, y el técnico aprende a ignorar el rojo. Lo que hay que mostrar es la
 * causa, no las consecuencias.
 */
function resumirRed(nodos, novedades = []) {
  const hoy = hoyISO()
  // "Recuperados hoy" no sale del estado actual —un nodo que volvió está `up`,
  // igual que uno que nunca se cayó— sino del historial. Es la cuarta tarjeta
  // del tablero y la única que mira hacia atrás.
  const recuperadosHoy = novedades.filter(
    (e) => e.clase === 'recuperado' && fechaLocalDe(e.momento) === hoy,
  ).length
  return { ...resumirEstado(nodos), recuperadosHoy }
}

function resumirEstado(nodos) {
  const caidos = nodos.filter((n) => n.estado === 'down')
  const raiz = caidos.filter((n) => !n.por_el_padre)
  const arrastrados = caidos.filter((n) => n.por_el_padre)
  const alerta = nodos.filter((n) => n.estado === 'warning')

  return {
    total: nodos.length,
    up: nodos.filter((n) => n.estado === 'up').length,
    warning: alerta.length,
    down: caidos.length,
    // Lo que de verdad hay que mirar: las caídas que no son consecuencia de
    // otra.
    //
    // Primero por gravedad y después por antigüedad, en ese orden y no al
    // revés. Ordenando solo por antigüedad, un enlace degradado desde hace seis
    // horas —que ya es paisaje— quedaba arriba de una OLT que se acababa de
    // caer. La antigüedad no es la urgencia: lo que recién se rompió es lo que
    // explica por qué el trabajo de hoy no se puede hacer.
    incidencias: [...raiz, ...alerta].sort(
      (a, b) =>
        (a.estado === 'down' ? 0 : 1) - (b.estado === 'down' ? 0 : 1) ||
        (b.minutos_asi ?? 0) - (a.minutos_asi ?? 0),
    ),
    arrastrados: arrastrados.length,
    estado: raiz.length ? 'critico' : alerta.length ? 'alerta' : 'ok',
  }
}

/**
 * Cómo viene el día, en las cuatro cifras que pediste.
 *
 * ── Por qué "pendientes" excluye lo que ya arrancó ──
 *
 * La cuenta obvia es "todo lo que no está hecho". Pero entonces el trabajo que
 * el técnico tiene abierto en ese momento aparece en dos tarjetas a la vez, y
 * la suma de las cuatro da más que el total del día. Es el mismo problema que
 * las pestañas de Soporte: los grupos tienen que cortar, no superponerse.
 *
 * Acá: pendiente = agendada y sin arrancar. En proceso = ya salió o está en el
 * domicilio. Las cuatro suman exactamente el día.
 */
function jornadaDe(delDia, atrasadas, tickets) {
  const cuenta = (...estados) => delDia.filter((o) => estados.includes(o.estado)).length

  const hechas = cuenta('hecha')
  const enProceso = cuenta('en_ruta', 'en_curso')
  const reagendadas = cuenta('reprogramada')
  const pendientes = cuenta('agendada')

  return {
    total: delDia.length,
    pendientes,
    enProceso,
    hechas,
    reagendadas,
    atrasadas: atrasadas.length,
    tickets: tickets.length,
    // Sin trabajos no es 0%: es "no hay nada", que se muestra distinto. Un 0%
    // en un día sin órdenes se lee como que se está atrasado.
    avance: delDia.length ? Math.round((hechas / delDia.length) * 100) : null,
  }
}

/**
 * La ruta del día, en el orden en que se recorre.
 *
 * Por hora, y las sin hora al final: una orden sin horario acordado es la que
 * se hace cuando se puede, no la primera.
 */
function rutaDe(delDia) {
  return [...delDia].sort((a, b) => {
    if (!a.hora && !b.hora) return 0
    if (!a.hora) return 1
    if (!b.hora) return -1
    return a.hora.localeCompare(b.hora)
  })
}

/** El color de una orden según cómo quedó la señal. Reutiliza el semáforo. */
export const semaforoOrden = (o) => semaforoDe(o)

/**
 * Qué le falta a esta orden para poder cerrarse.
 *
 * Se muestra en la tarjeta para que el técnico lo sepa ANTES de manejar hasta
 * el domicilio, no cuando ya está ahí y le falta el material.
 */
export function faltaPara(o) {
  const falta = []
  if (!o.tiene_equipo) falta.push('leer el equipo')
  if (!o.tiene_lectura) falta.push('medir la señal')
  if (!o.tiene_red) falta.push('parámetros de red')
  if (!o.tiene_pruebas) falta.push('test de salida')
  if (!o.tiene_firma) falta.push('firma del cliente')
  return falta
}

export const HORA = (h) => (h ? String(h).slice(0, 5) : null)

/** Saludo por hora del día. El técnico arranca a las 7 y cierra a las 18. */
export function saludo(nombre) {
  const h = new Date().getHours()
  const momento = h < 12 ? 'Buen día' : h < 19 ? 'Buenas tardes' : 'Buenas noches'
  return nombre ? `${momento}, ${String(nombre).split(' ')[0]}` : momento
}
