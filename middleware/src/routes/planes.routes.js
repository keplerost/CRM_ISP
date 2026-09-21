import { Router } from 'express'
import { asyncHandler, notFound, badRequest, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { db, cargarRouter } from '../lib/db.js'
import { enMbps, camposDeCola, perfilDePlan, revisarPerfilDePlan } from '../lib/velocidad.js'
import * as mk from '../services/mikrotikService.js'

/**
 * Cambiar un plan y que el cambio llegue a los abonados.
 *
 * Subir un plan de 100 a 300 megas en la base no le cambia la velocidad a
 * nadie: eso vive en los equipos. Y llega distinto según cómo se conecte cada
 * uno, que es la razón de ser de este archivo:
 *
 *   PPPoE      el límite lo pone el perfil PPP, que es UNO solo y lo comparten
 *              todos los abonados del plan. Se corrige en el router una vez y
 *              vale para los cien. Acá solo se verifica que el perfil diga lo
 *              mismo que el plan.
 *
 *   IP fija    cada abonado tiene su propia Simple Queue con su propio
 *              max-limit. No hay nada compartido: hay que reescribirlas de a
 *              una, y eso es lo que hace `sincronizar`.
 *
 * Por eso no alcanza con "aplicar el plan": hay que saber a quién le toca qué.
 */

const router = Router()
router.use(requireAuth)

/** El plan, o el motivo por el que no se puede trabajar con él. */
async function cargarPlan(id) {
  const { data, error } = await db().from('planes_velocidad').select('*').eq('id', id).maybeSingle()
  if (error) throw new AppError(`No se pudo leer el plan: ${error.message}`, { status: 502 })
  if (!data) throw notFound('No existe ese plan')
  return data
}

/**
 * Los abonados del plan, repartidos según cómo se les aplica la velocidad.
 *
 * Se excluye a los de baja: reescribirle la cola a alguien que ya no es cliente
 * es tocar un equipo sin motivo, y en un router con miles de colas cada
 * operación de más es tiempo de bloqueo del equipo.
 */
async function repartirAbonados(planId) {
  const { data, error } = await db()
    .from('clientes')
    .select('id, nombre, ip, ipv6_prefijo, router_id, tipo_conexion, estado')
    .eq('plan_id', planId)
    .neq('estado', 'baja')

  if (error) throw new AppError(`No se pudieron leer los abonados: ${error.message}`, { status: 502 })

  const abonados = data ?? []
  return {
    total: abonados.length,
    pppoe: abonados.filter((c) => c.tipo_conexion === 'pppoe'),
    // Los que necesitan cola: los que no son PPPoE y tienen IP y router. Sin
    // una de las dos cosas no hay a qué apuntarla.
    conCola: abonados.filter((c) => c.tipo_conexion !== 'pppoe' && c.ip && c.router_id),
    sinDatos: abonados.filter((c) => c.tipo_conexion !== 'pppoe' && (!c.ip || !c.router_id)),
  }
}

/** Agrupa por router para abrir una sola sesión por equipo. */
function porRouter(clientes) {
  const mapa = new Map()
  for (const c of clientes) {
    if (!mapa.has(c.router_id)) mapa.set(c.router_id, [])
    mapa.get(c.router_id).push(c)
  }
  return mapa
}

/**
 * Revisa que el perfil PPP de cada router cumpla la regla de FTTH.
 *
 * La regla: en fibra el caudal lo controla la traffic table de la OLT, así que
 * el perfil del MikroTik va **sin** rate-limit. Un perfil con límite cargado no
 * es "más seguro": es un segundo tope compitiendo con el de la OLT, y el
 * abonado se queda con el menor de los dos sin que ese número aparezca en
 * ninguna pantalla.
 *
 * Por eso acá no se compara el perfil contra la velocidad del plan —eso sería
 * dar por buena la configuración equivocada— sino contra la regla.
 */
async function revisarPerfiles(plan, clientesPppoe) {
  const { nombre: nombrePerfil } = perfilDePlan(plan)
  const revisiones = []

  for (const [routerId, clientes] of porRouter(clientesPppoe)) {
    if (!routerId) continue

    let equipo = null
    try {
      equipo = await cargarRouter(routerId)
      const perfiles = await mk.listarPppProfiles(equipo)
      const perfil = (Array.isArray(perfiles) ? perfiles : []).find((p) => p.name === nombrePerfil)

      const revision = revisarPerfilDePlan(perfil, plan)
      const base = { router: equipo.nombre, abonados: clientes.length, perfil: nombrePerfil }
      const enElRouter = plan.control_pppoe === 'mikrotik'
      const legible = revision.aplica
        ? `${enMbps(revision.aplica.bajada_kbps)} de bajada / ${enMbps(revision.aplica.subida_kbps)} de subida`
        : revision.limite

      if (revision.ok) {
        revisiones.push({
          ...base,
          estado: 'ok',
          aplica: enElRouter ? legible : null,
          mensaje: enElRouter
            ? `El perfil limita a ${legible}, que es lo que dice el plan.`
            : 'El perfil existe y sin límite propio, como corresponde: el caudal lo pone la OLT.',
        })
      } else if (revision.motivo === 'no_existe') {
        revisiones.push({
          ...base,
          estado: 'no_existe',
          mensaje: `El router no tiene un perfil llamado "${nombrePerfil}": esos ${clientes.length} abonados están conectando con el de por defecto. Aprovisionalo desde Servicios → Planes.`,
        })
      } else if (revision.motivo === 'no_deberia_limitar') {
        revisiones.push({
          ...base,
          estado: 'no_deberia_limitar',
          aplica: legible,
          mensaje: `El perfil "${nombrePerfil}" tiene un rate-limit propio (${revision.limite}) pero este plan lo controla la OLT. Los dos límites compiten y gana el menor: revisalo.`,
        })
      } else if (revision.motivo === 'sin_limite') {
        revisiones.push({
          ...base,
          estado: 'sin_limite',
          mensaje: `Este plan se controla en el router pero el perfil "${nombrePerfil}" no tiene rate-limit: esos ${clientes.length} abonados navegan sin tope. Volvé a aprovisionar.`,
        })
      } else {
        revisiones.push({
          ...base,
          estado: 'difiere',
          aplica: legible,
          deberia: `${enMbps(plan.bajada_kbps)} de bajada / ${enMbps(plan.subida_kbps)} de subida`,
          mensaje: `El perfil limita a ${legible} y el plan dice ${enMbps(plan.bajada_kbps)}. Lo comparten los ${clientes.length} abonados: volvé a aprovisionar.`,
        })
      }
    } catch (err) {
      revisiones.push({
        router: equipo?.nombre ?? routerId,
        abonados: clientes.length,
        perfil: nombrePerfil,
        estado: 'error',
        mensaje: `No se pudo consultar el router: ${err.message}`,
      })
    }
  }

  return revisiones
}

/**
 * Qué pasaría si se aplicara el plan. No toca nada.
 *
 * Existe porque "aplicar a todos" sobre un plan grande es una operación que se
 * aprieta una vez y afecta a cientos de abonados. Ver de antemano a cuántos y
 * en qué equipos es lo que permite darse cuenta de que se eligió el plan
 * equivocado ANTES y no después.
 */
router.get(
  '/:id/impacto',
  asyncHandler(async (req, res) => {
    const plan = await cargarPlan(req.params.id)
    const reparto = await repartirAbonados(plan.id)
    // Se calcula también acá para que lo mal configurado se vea ANTES de tocar
    // doscientos equipos, que es para lo que existe esta vista.
    const { campos, avisos } = camposDeCola(plan)

    res.json({
      plan: {
        nombre: plan.nombre,
        bajada: enMbps(plan.bajada_kbps),
        subida: enMbps(plan.subida_kbps),
        perfil_ppp: plan.perfil_ppp ?? null,
      },
      avisos,
      aplicaria: campos,
      total: reparto.total,
      colas: {
        cantidad: reparto.conCola.length,
        routers: [...porRouter(reparto.conCola).keys()].length,
        detalle: 'Se les reescribe la Simple Queue, una por abonado.',
      },
      pppoe: {
        cantidad: reparto.pppoe.length,
        detalle: 'No se les toca nada: el límite lo pone el perfil, que es compartido.',
        revisiones: await revisarPerfiles(plan, reparto.pppoe),
      },
      sin_datos: reparto.sinDatos.map((c) => ({
        nombre: c.nombre,
        falta: !c.ip ? 'IP' : 'router',
      })),
    })
  }),
)

/**
 * Aplica la velocidad del plan a todos sus abonados con cola.
 *
 * Se abre una sesión por equipo y se recorren sus abonados adentro: una
 * conexión por cliente agotaría el límite de sesiones del router a los pocos
 * segundos.
 *
 * Un fallo puntual no corta la corrida. Con doscientos abonados, que uno tenga
 * la IP mal cargada no puede dejar a los otros ciento noventa y nueve sin el
 * cambio; se listan al final para resolverlos a mano.
 */
router.post(
  '/:id/sincronizar',
  asyncHandler(async (req, res) => {
    const plan = await cargarPlan(req.params.id)
    const reparto = await repartirAbonados(plan.id)

    const actualizados = []
    const creados = []
    const fallidos = []
    const duplicados = []

    // La traducción del plan a campos del router se hace una sola vez: es la
    // misma para todos sus abonados y no tiene sentido recalcularla doscientas.
    const { campos, avisos } = camposDeCola(plan)

    for (const [routerId, clientes] of porRouter(reparto.conCola)) {
      let equipo
      try {
        equipo = await cargarRouter(routerId)
      } catch (err) {
        for (const c of clientes) fallidos.push({ nombre: c.nombre, error: err.message })
        continue
      }

      for (const c of clientes) {
        try {
          const r = await mk.asegurarSimpleQueue(equipo, {
            nombre: c.nombre,
            ip: c.ip,
            // El prefijo v6 entra en la MISMA cola, no en una aparte: dos colas
            // de 150 Mbps se suman a 300 según por dónde baje el abonado. Solo
            // si este router entrega IPv6.
            ipv6: equipo.ipv6_activo ? c.ipv6_prefijo || null : null,
            comentario: plan.nombre,
            campos,
          })

          if (r.creada) creados.push({ nombre: c.nombre, router: equipo.nombre })
          else actualizados.push({ nombre: c.nombre, router: equipo.nombre })

          // Dos colas apuntando al mismo abonado: la que manda es la primera y
          // la otra puede estar limitando de más. Hay que mirarla a mano.
          if (r.duplicadas > 0) {
            duplicados.push({ nombre: c.nombre, ip: c.ip, extra: r.duplicadas })
          }
        } catch (err) {
          fallidos.push({ nombre: c.nombre, router: equipo.nombre, error: err.message })
        }
      }
    }

    res.json({
      ok: fallidos.length === 0,
      plan: plan.nombre,
      velocidad: `${enMbps(plan.bajada_kbps)} de bajada / ${enMbps(plan.subida_kbps)} de subida`,
      actualizados: actualizados.length,
      creados: creados.length,
      fallidos,
      duplicados,
      // Lo que quedó sin aplicar por estar a medio configurar. No es un error:
      // la velocidad se aplicó igual.
      avisos,
      aplicado: campos,
      pppoe: {
        cantidad: reparto.pppoe.length,
        revisiones: await revisarPerfiles(plan, reparto.pppoe),
      },
      sin_datos: reparto.sinDatos.map((c) => ({ nombre: c.nombre, falta: !c.ip ? 'IP' : 'router' })),
      mensaje:
        reparto.conCola.length === 0
          ? 'Ningún abonado de este plan usa Simple Queue: no había colas que reescribir.'
          : `${actualizados.length + creados.length} de ${reparto.conCola.length} colas quedaron con la velocidad del plan.`,
    })
  }),
)

// --- Perfiles PPP en los routers --------------------------------------------

/**
 * Crea o corrige el perfil del plan en los routers donde está asignado.
 *
 * Es lo que convierte "el plan existe en el sistema" en "un abonado PPPoE puede
 * tenerlo": sin el perfil en el equipo, el secret se crea con el de por defecto
 * y el cliente queda fuera de toda la configuración del plan.
 *
 * Se aprovisiona equipo por equipo y un fallo no corta la corrida: con cinco
 * CCR, que uno esté inalcanzable no puede impedir que el plan quede disponible
 * en los otros cuatro. El estado se guarda por router, así que después se ve
 * exactamente cuál quedó pendiente.
 */
router.post(
  '/:id/aprovisionar',
  asyncHandler(async (req, res) => {
    const plan = await cargarPlan(req.params.id)
    const perfil = perfilDePlan(plan)

    const { data: asignados, error } = await db()
      .from('plan_routers')
      .select('router_id')
      .eq('plan_id', plan.id)

    if (error) {
      throw new AppError(`No se pudieron leer los routers del plan: ${error.message}`, { status: 502 })
    }
    if (!asignados?.length) {
      throw badRequest(`El plan ${plan.nombre} no está asignado a ningún router`, {
        hint: 'Elegí en qué equipos se vende antes de aprovisionar su perfil.',
      })
    }

    const aplicados = []
    const fallidos = []

    for (const { router_id } of asignados) {
      let equipo = null
      try {
        equipo = await cargarRouter(router_id)
        const r = await mk.asegurarPppProfile(equipo, perfil)

        await db()
          .from('plan_routers')
          .update({
            estado: 'aplicado',
            perfil_aplicado: perfil.nombre,
            rate_limit: r.rate_limit,
            aprovisionado_at: new Date().toISOString(),
            error: null,
          })
          .eq('plan_id', plan.id)
          .eq('router_id', router_id)

        aplicados.push({ router: equipo.nombre, ...r })
      } catch (err) {
        await db()
          .from('plan_routers')
          .update({ estado: 'error', error: err.message })
          .eq('plan_id', plan.id)
          .eq('router_id', router_id)

        fallidos.push({ router: equipo?.nombre ?? router_id, error: err.message })
      }
    }

    res.json({
      ok: fallidos.length === 0,
      plan: plan.nombre,
      perfil: perfil.nombre,
      rate_limit: perfil.rateLimit,
      creados: aplicados.filter((a) => a.creado).length,
      actualizados: aplicados.filter((a) => a.actualizado).length,
      aplicados,
      fallidos,
      // Lo que quedó sin aplicar por estar a medio configurar. La velocidad se
      // aplica igual.
      avisos: perfil.avisos ?? [],
      regla:
        plan.control_pppoe === 'mikrotik'
          ? 'Este plan controla el caudal en el router: el perfil lleva el rate-limit con la velocidad del plan.'
          : 'El perfil queda sin rate-limit a propósito: el caudal lo controla la traffic table de la OLT, y un límite acá competiría con ella.',
      mensaje: `Perfil "${perfil.nombre}" en ${aplicados.length} de ${asignados.length} routers.`,
    })
  }),
)

/** Dónde está disponible el plan y cómo quedó su perfil en cada equipo. */
router.get(
  '/:id/routers',
  asyncHandler(async (req, res) => {
    const plan = await cargarPlan(req.params.id)

    const [{ data: asignados }, { data: routers }] = await Promise.all([
      db().from('v_plan_routers').select('*').eq('plan_id', plan.id),
      db().from('routers_mikrotik').select('id, nombre, ip_host, activo').order('nombre'),
    ])

    const porId = new Map((asignados ?? []).map((a) => [a.router_id, a]))

    res.json({
      plan: plan.nombre,
      perfil: perfilDePlan(plan).nombre,
      // Se devuelven TODOS los routers y no solo los asignados: la pantalla
      // necesita ofrecer los que faltan, y pedirlos aparte dejaría la lista
      // desincronizada con el estado.
      routers: (routers ?? []).map((r) => ({
        id: r.id,
        nombre: r.nombre,
        ip_host: r.ip_host,
        activo: r.activo,
        asignado: porId.has(r.id),
        ...(porId.get(r.id)
          ? {
              estado: porId.get(r.id).estado,
              rate_limit: porId.get(r.id).rate_limit,
              aprovisionado_at: porId.get(r.id).aprovisionado_at,
              error: porId.get(r.id).error,
            }
          : {}),
      })),
    })
  }),
)

export default router
