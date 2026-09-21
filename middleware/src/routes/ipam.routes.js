import { Router } from 'express'
import * as poolsOnu from '../services/poolsOnu.js'
import { asyncHandler, notFound, badRequest, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { exigePermiso } from '../lib/permisos.js'
import { db, cargarRouter } from '../lib/db.js'
import { aEntero, aIp, rangoDeCidr } from '../lib/ip.js'
import * as mk from '../services/mikrotikService.js'
import { conciliar } from '../services/conciliacionIps.js'
import * as adopcion from '../services/adopcionCorte.js'

/**
 * IPAM: qué direcciones existen y quién ocupa cada una.
 *
 * El sistema no es la fuente de la verdad —la red lo es—, así que estas rutas
 * hacen dos cosas distintas que conviene no mezclar:
 *
 *   sincronizar  Lee lo que el router tiene CONFIGURADO —direcciones, leases,
 *                secrets, sesiones— y lo vuelca. Es lo declarado.
 *
 *   escanear     Averigua qué hay CONECTADO de verdad. Lo que aparece acá y no
 *                está declarado es el hallazgo: un equipo que nadie registró o
 *                alguien que se puso una IP que no le tocaba.
 *
 * La diferencia entre las dos listas es para lo que existe la auditoría.
 */

const router = Router()
// El direccionamiento entero, incluso leerlo: saber qué rangos usa el ISP y
// cuáles están libres es información de arquitectura, no de campo.
router.use(requireAuth, exigePermiso('red.ipam'))

/** Cuántas direcciones se permite recorrer de una vez. */
const MAXIMO_HOSTS = 4096

async function cargarSubred(id) {
  const { data, error } = await db().from('v_subredes').select('*').eq('id', id).maybeSingle()
  if (error) throw new AppError(`No se pudo leer la subred: ${error.message}`, { status: 502 })
  if (!data) throw notFound('No existe esa subred')
  return data
}

/** El router de la subred, o el motivo por el que no se puede consultar. */
async function routerDe(subred) {
  if (!subred.router_id) {
    throw badRequest(`La subred ${subred.nombre} no tiene router asignado`, {
      hint: 'Elegí de qué MikroTik sale este bloque para poder consultarlo.',
    })
  }
  return cargarRouter(subred.router_id)
}

/** ¿Esta IP cae dentro del bloque? */
function dentroDe(cidr, ip) {
  const n = aEntero(String(ip ?? '').split('/')[0])
  if (n == null) return false
  const { desde, hasta } = rangoDeCidr(cidr)
  return n >= desde && n <= hasta
}

/**
 * Guarda lo encontrado sin pisar lo decidido.
 *
 * Una dirección que alguien asignó a mano no puede quedar degradada a "vista
 * por ARP" porque el escáner la encontró: eso perdería el vínculo con el
 * abonado. Se actualiza la última vez que se la vio y poco más.
 */
async function registrar(subred, direcciones) {
  if (!direcciones.length) return { nuevas: 0, actualizadas: 0 }

  const { data: previas } = await db()
    .from('ip_addresses')
    .select('id, ip_address, origen, client_id, estado')
    .eq('subred_id', subred.id)

  const porIp = new Map((previas ?? []).map((d) => [d.ip_address, d]))
  const nuevas = []
  let actualizadas = 0

  for (const d of direcciones) {
    const previa = porIp.get(d.ip_address)

    if (!previa) {
      nuevas.push({ ...d, subred_id: subred.id, router_id: subred.router_id })
      continue
    }

    // Lo decidido manda sobre lo descubierto.
    const cambios = { visto_at: new Date().toISOString() }
    if (previa.origen === 'arp' && d.origen !== 'arp') {
      // Se la conocía solo por haberla visto y ahora aparece declarada: el dato
      // nuevo es mejor.
      cambios.origen = d.origen
      cambios.estado = d.estado
      if (d.client_id) cambios.client_id = d.client_id
      if (d.descripcion) cambios.descripcion = d.descripcion
    }
    if (!previa.client_id && d.client_id) cambios.client_id = d.client_id
    if (d.mac_address) cambios.mac_address = d.mac_address

    await db().from('ip_addresses').update(cambios).eq('id', previa.id)
    actualizadas++
  }

  if (nuevas.length) {
    const { error } = await db().from('ip_addresses').insert(nuevas)
    if (error) throw new AppError(`No se pudieron guardar las direcciones: ${error.message}`, { status: 502 })
  }

  return { nuevas: nuevas.length, actualizadas }
}

// --- Sincronizar lo declarado -----------------------------------------------

/**
 * Vuelca del router lo que está configurado dentro de esta subred.
 *
 * Se cruzan cuatro fuentes porque cada una sabe algo distinto: las direcciones
 * del equipo dicen cuál es el gateway, las leases atan IP con MAC, los secrets
 * dicen qué IP fija tiene cada usuario PPPoE y las sesiones activas, quién está
 * conectado ahora. Con una sola quedarían huecos que después se asignan a
 * alguien y chocan.
 */
router.post(
  '/subredes/:id/sincronizar',
  asyncHandler(async (req, res) => {
    const subred = await cargarSubred(req.params.id)
    const equipo = await routerDe(subred)

    const [direcciones, leases, secrets, activas, clientes] = await Promise.all([
      mk.listarDirecciones(equipo).catch(() => []),
      mk.listarDhcpLeases(equipo).catch(() => []),
      mk.listarPppSecrets(equipo).catch(() => []),
      mk.listarPppActive(equipo).catch(() => []),
      db().from('clientes').select('id, nombre, ip, usuario_ppp').not('ip', 'is', null),
    ])

    const porIpCliente = new Map((clientes.data ?? []).map((c) => [c.ip, c]))
    const porUsuario = new Map(
      (clientes.data ?? []).filter((c) => c.usuario_ppp).map((c) => [c.usuario_ppp, c]),
    )

    const encontradas = new Map()
    const anotar = (ip, datos) => {
      const limpia = String(ip ?? '').split('/')[0]
      if (!limpia || !dentroDe(subred.cidr, limpia)) return
      // La primera fuente que la nombra gana: están ordenadas de más específica
      // a menos.
      if (!encontradas.has(limpia)) encontradas.set(limpia, { ip_address: limpia, ...datos })
    }

    // 1. Las direcciones del propio equipo: gateways y enlaces. Reservadas, no
    //    asignables a un abonado.
    for (const d of direcciones ?? []) {
      anotar(d.address, {
        estado: 'reservada',
        origen: 'address',
        interfaz: d.interface ?? null,
        descripcion: d.comment || 'Dirección del router',
      })
    }

    // 2. Reservas DHCP: atan IP con MAC.
    for (const l of leases ?? []) {
      const cliente = porIpCliente.get(String(l.address))
      anotar(l.address, {
        estado: 'asignada',
        origen: 'dhcp',
        mac_address: l['mac-address'] ?? null,
        client_id: cliente?.id ?? null,
        descripcion: l.comment || cliente?.nombre || null,
      })
    }

    // 3. Secrets PPPoE con IP fija.
    for (const s of secrets ?? []) {
      const cliente = porUsuario.get(s.name) ?? porIpCliente.get(String(s['remote-address']))
      anotar(s['remote-address'], {
        estado: 'asignada',
        origen: 'ppp',
        client_id: cliente?.id ?? null,
        descripcion: s.comment || s.name,
      })
    }

    // 4. Sesiones activas: lo que el router está repartiendo ahora.
    for (const a of activas ?? []) {
      const cliente = porUsuario.get(a.name)
      anotar(a.address, {
        estado: 'asignada',
        origen: 'ppp',
        client_id: cliente?.id ?? null,
        descripcion: a.name,
      })
    }

    const resultado = await registrar(subred, [...encontradas.values()])

    res.json({
      subred: subred.nombre,
      router: equipo.nombre,
      encontradas: encontradas.size,
      ...resultado,
      fuentes: {
        direcciones: (direcciones ?? []).length,
        leases: (leases ?? []).length,
        secrets: (secrets ?? []).length,
        sesiones: (activas ?? []).length,
      },
      mensaje: `${encontradas.size} direcciones configuradas dentro de ${subred.cidr}.`,
    })
  }),
)

// --- Auditoría: qué hay conectado de verdad ---------------------------------

/**
 * Barrido de la subred para encontrar lo que nadie declaró.
 *
 * Dos modos, y el pasivo es el que viene por defecto a propósito:
 *
 *   arp   Lee la tabla ARP del router. Instantáneo y no genera un solo paquete
 *         hacia los abonados. Ve lo que habló hace poco.
 *
 *   scan  `/tool/ip-scan`: recorre el rango dirección por dirección. Encuentra
 *         también lo que está callado, pero es tráfico real contra la red de
 *         producción y tarda. Se pide explícitamente.
 */
router.post(
  '/subredes/:id/escanear',
  asyncHandler(async (req, res) => {
    const subred = await cargarSubred(req.params.id)
    const equipo = await routerDe(subred)
    const modo = req.body?.modo === 'scan' ? 'scan' : 'arp'

    const { desde, hasta } = rangoDeCidr(subred.cidr)
    if (hasta - desde + 1 > MAXIMO_HOSTS) {
      throw badRequest(
        `${subred.cidr} tiene más de ${MAXIMO_HOSTS} direcciones: es demasiado para barrer de una vez`,
        { hint: 'Dividí el bloque en subredes más chicas para poder auditarlo.' },
      )
    }

    let vistos = []
    if (modo === 'scan') {
      const salida = await mk.escanearRango(equipo, {
        rango: subred.cidr,
        duracion: req.body?.duracion ?? 15,
      })
      vistos = (salida ?? [])
        .filter((e) => e.address)
        .map((e) => ({ ip: e.address, mac: e['mac-address'] ?? null }))
    } else {
      const arp = await mk.listarArp(equipo, {})
      vistos = (arp ?? [])
        .filter((a) => a.address && dentroDe(subred.cidr, a.address))
        .map((a) => ({ ip: a.address, mac: a['mac-address'] ?? null }))
    }

    // Lo que el sistema ya sabe de esta subred.
    const { data: conocidas } = await db()
      .from('ip_addresses')
      .select('ip_address, client_id, estado, origen, descripcion')
      .eq('subred_id', subred.id)

    const porIp = new Map((conocidas ?? []).map((d) => [d.ip_address, d]))

    const autorizadas = []
    const sinAutorizar = []

    for (const v of vistos) {
      const conocida = porIp.get(v.ip)
      // Autorizada es la que alguien asignó: con dueño o reservada a propósito.
      if (conocida && (conocida.client_id || conocida.estado === 'reservada')) {
        autorizadas.push({ ...v, descripcion: conocida.descripcion })
      } else {
        sinAutorizar.push(v)
      }
    }

    // Las no autorizadas se guardan como vistas: sin dueño y marcadas, para que
    // queden en el mapa y en el contador de la subred hasta que alguien las
    // resuelva. Guardarlas es lo que convierte el hallazgo en trabajo pendiente
    // en vez de una pantalla que se cierra y se olvida.
    const guardado = await registrar(
      subred,
      sinAutorizar.map((v) => ({
        ip_address: v.ip,
        estado: 'asignada',
        origen: 'arp',
        mac_address: v.mac,
        visto_at: new Date().toISOString(),
        descripcion: 'Detectada en la red, sin registrar',
      })),
    )

    // Y las declaradas que NO contestaron: pueden ser bajas que nadie liberó.
    const declaradasSinRespuesta = (conocidas ?? [])
      .filter((d) => d.client_id && !vistos.some((v) => v.ip === d.ip_address))
      .map((d) => d.ip_address)

    res.json({
      subred: subred.nombre,
      cidr: subred.cidr,
      modo,
      router: equipo.nombre,
      vistos: vistos.length,
      autorizadas: autorizadas.length,
      sin_autorizar: sinAutorizar,
      declaradas_sin_respuesta: declaradasSinRespuesta,
      ...guardado,
      mensaje: sinAutorizar.length
        ? `${sinAutorizar.length} direcciones conectadas que nadie registró.`
        : 'Todo lo que está conectado está registrado.',
      aviso:
        modo === 'arp'
          ? 'Barrido pasivo: solo ve lo que habló hace poco. Un equipo prendido pero callado no aparece.'
          : null,
    })
  }),
)

// --- Salud de los routers ---------------------------------------------------

/** Tope propio de la pantalla de salud, por si el driver se queda esperando. */
const ESPERA_SALUD_MS = 20000

const conTope = (promesa, ms, mensaje) =>
  Promise.race([
    promesa,
    new Promise((_, rechazar) => {
      const t = setTimeout(() => rechazar(new AppError(mensaje, { status: 504 })), ms)
      t.unref?.()
    }),
  ])

/**
 * Estado de cada CCR: si contesta, con cuánta CPU y cuánta memoria libre.
 *
 * Se consultan todos en paralelo porque son equipos distintos —la cola del
 * driver serializa por equipo, no entre equipos—, y cada uno tiene su propio
 * tope: un router inalcanzable dejaba la pantalla entera colgada varios minutos
 * mientras el sistema operativo esperaba a un puerto que descarta los paquetes
 * en silencio. El resto de los equipos no tiene por qué pagar eso.
 */
router.get(
  '/routers/salud',
  asyncHandler(async (_req, res) => {
    const { data: routers, error } = await db()
      .from('routers_mikrotik')
      .select('id, nombre, ip_host, puerto_api, modo_api, activo')
      .order('nombre')

    if (error) throw new AppError(`No se pudieron leer los routers: ${error.message}`, { status: 502 })

    const salud = await Promise.all(
      (routers ?? []).map(async (r) => {
        const base = {
          id: r.id,
          nombre: r.nombre,
          ip_host: r.ip_host,
          puerto_api: r.puerto_api,
          modo_api: r.modo_api,
          activo: r.activo,
        }

        if (!r.activo) return { ...base, estado: 'inactivo' }

        try {
          const equipo = await cargarRouter(r.id)
          const recurso = await conTope(
            mk.leerRecursos(equipo),
            ESPERA_SALUD_MS,
            `${r.nombre} no contestó en ${ESPERA_SALUD_MS / 1000}s`,
          )

          const totalMem = Number(recurso?.['total-memory']) || 0
          const libreMem = Number(recurso?.['free-memory']) || 0
          const totalHdd = Number(recurso?.['total-hdd-space']) || 0
          const libreHdd = Number(recurso?.['free-hdd-space']) || 0
          const cpu = Number(recurso?.['cpu-load'])

          return {
            ...base,
            estado: 'online',
            modelo: recurso?.['board-name'] ?? null,
            version: recurso?.version ?? null,
            uptime: recurso?.uptime ?? null,
            cpu_pct: Number.isFinite(cpu) ? cpu : null,
            cpu_nucleos: Number(recurso?.['cpu-count']) || null,
            memoria_pct: totalMem ? Math.round(((totalMem - libreMem) / totalMem) * 100) : null,
            memoria_libre_mb: totalMem ? Math.round(libreMem / 1048576) : null,
            memoria_total_mb: totalMem ? Math.round(totalMem / 1048576) : null,
            disco_pct: totalHdd ? Math.round(((totalHdd - libreHdd) / totalHdd) * 100) : null,
          }
        } catch (err) {
          return { ...base, estado: 'offline', error: err.message, hint: err.hint ?? null }
        }
      }),
    )

    res.json(salud)
  }),
)

// --- Utilidades del mapa ----------------------------------------------------

/**
 * La primera dirección libre de la subred.
 *
 * ── Por qué la cuenta la hace la base ──
 *
 * Porque una dirección está ocupada por dos motivos distintos y hasta la 122 acá
 * solo se miraba uno: lo registrado en `ip_addresses`. La IP que usa un abonado
 * vive en `clientes.ip`, y esa tabla en una instalación real está vacía — así
 * que al importar un padrón entero esta cuenta seguía proponiendo la primera
 * dirección del bloque, que ya está en la casa de alguien.
 *
 * Dos equipos con la misma IP no fallan con un cartel: se cortan el servicio
 * entre ellos de a ratos, y eso se persigue durante días. `primera_ip_libre`
 * mira las dos tablas, respeta el rango declarado y saltea el gateway.
 */
router.get(
  '/subredes/:id/libre',
  asyncHandler(async (req, res) => {
    const subred = await cargarSubred(req.params.id)

    const { data: ip, error } = await db().rpc('primera_ip_libre', { p_subred: subred.id })
    if (error) {
      throw new AppError(`No se pudo calcular la primera libre: ${error.message}`, {
        status: 502,
        hint: 'Si dice que no existe la función, corré supabase/migracion-122-la-ip-que-ya-esta-en-uso.sql',
      })
    }

    if (!ip) {
      throw new AppError(`No queda ninguna dirección libre en ${subred.cidr}`, {
        status: 409,
        hint: 'Liberá las direcciones de los abonados dados de baja o agregá otro bloque.',
      })
    }

    res.json({ ip, subred: subred.nombre })
  }),
)

/**
 * ¿Está libre esta dirección?
 *
 * Se contesta con el NOMBRE de quien la tiene y no con un sí o un no: "está
 * ocupada" obliga a ir a buscar por quién, y el que está dando de alta a un
 * abonado con el técnico esperando en el poste no va a ir a buscar nada.
 */
router.get(
  '/ips/:ip',
  asyncHandler(async (req, res) => {
    const { data: quien, error } = await db().rpc('quien_tiene_la_ip', {
      p_ip: req.params.ip,
      p_router: req.query.router || null,
      p_excluir: req.query.excluir || null,
    })
    if (error) throw new AppError(`No se pudo consultar la IP: ${error.message}`, { status: 502 })

    res.json({ ip: req.params.ip, libre: !quien, quien: quien ?? null })
  }),
)

/**
 * Comparar las IPs del sistema con las del router.
 *
 * Es lo que hay que correr después de migrar un padrón. El sistema cree saber
 * qué IP tiene cada abonado —la que decía el archivo— y el router sabe otra
 * cosa: la que de verdad está configurada.
 *
 * Solo informa. Tocar el router para "arreglar" esto es cambiarle la IP a una
 * casa que hoy está andando, y esa decisión es del ISP.
 */
router.get(
  '/routers/:id/conciliar-ips',
  asyncHandler(async (req, res) => {
    const equipo = await cargarRouter(req.params.id)

    const { data: abonados, error } = await db()
      .from('clientes')
      .select('id, codigo, nombre, ip, estado, usuario_ppp')
      .eq('router_id', equipo.id)
      .not('ip', 'is', null)

    if (error) {
      throw new AppError(`No se pudieron leer los abonados: ${error.message}`, { status: 502 })
    }

    /**
     * También se leen las reglas de firewall, y no solo las direcciones.
     *
     * Porque el nombre de la lista de cortes lo escribió alguien a mano en la
     * ficha del router, y si no coincide con la realidad este informe miente
     * hacia el "está todo bien": no encuentra un solo abonado cortado.
     *
     * Ya pasó acá — el sistema decía `CORTE_MOROSOS` y el router cortaba con
     * `Moroso`. Leyendo las reglas se sabe cuál corta de verdad.
     *
     * Las reglas fallan a `null` y no a `[]`: `null` es "no se pudo mirar" y el
     * informe se calla, `[]` sería afirmar que el router no tiene reglas.
     */
    const [escaneo, reglasFilter, reglasNat] = await Promise.all([
      mk.escanear(equipo),
      mk.listarReglasFilter(equipo).catch(() => null),
      mk.listarReglasNat(equipo).catch(() => null),
    ])

    const informe = conciliar(abonados ?? [], escaneo, {
      listaMorosos: equipo.lista_morosos || mk.LISTA_MOROSOS,
      reglasFilter,
      reglasNat,
    })

    res.json({ router: equipo.nombre, lista_morosos: equipo.lista_morosos, ...informe })
  }),
)

/**
 * Hacerse cargo del corte que ya existe en el router.
 *
 * Dos rutas y no una: primero se mira qué pasaría, después se aplica. Es lo
 * mismo que hace la importación del padrón y por la misma razón — acá lo que
 * está del otro lado es el firewall de un router con abonados conectados.
 */
async function leerParaAdoptar(routerId) {
  const { data: fila, error } = await db()
    .from('routers_mikrotik')
    .select('id, nombre, lista_morosos')
    .eq('id', routerId)
    .maybeSingle()

  if (error) throw new AppError(`No se pudo leer el router: ${error.message}`, { status: 502 })
  if (!fila) throw notFound('No existe ese router')

  const equipo = await cargarRouter(routerId)
  const [reglasFilter, reglasNat, addressList] = await Promise.all([
    mk.listarReglasFilter(equipo),
    mk.listarReglasNat(equipo),
    mk.listarTodasLasEntradas(equipo),
  ])

  return {
    equipo,
    plan: adopcion.planear({
      router: { ...fila, lista_morosos: fila.lista_morosos || mk.LISTA_MOROSOS },
      reglasFilter,
      reglasNat,
      addressList,
    }),
  }
}

router.get(
  '/routers/:id/corte',
  asyncHandler(async (req, res) => {
    const { plan } = await leerParaAdoptar(req.params.id)
    res.json(plan)
  }),
)

router.post(
  '/routers/:id/corte',
  asyncHandler(async (req, res) => {
    const { modo, confirmar } = req.body ?? {}

    /**
     * Migrar exige confirmar aparte.
     *
     * No es una formalidad: clona y apaga reglas del firewall de un equipo con
     * gente conectada. Que el mismo botón que consulta pueda ejecutarlo por un
     * clic de más es justamente lo que no puede pasar acá.
     */
    if (modo === 'migrar' && confirmar !== true) {
      throw badRequest('Para migrar el corte hay que confirmar', {
        hint: 'Esta operación toca el firewall del router. Mandá confirmar: true cuando estés seguro y con el respaldo hecho.',
      })
    }

    const { equipo, plan } = await leerParaAdoptar(req.params.id)

    if (plan.coincide) {
      return res.json({ sinCambios: true, hecho: 'La lista configurada ya es la que corta.' })
    }
    if (!plan.principal) {
      throw badRequest('Este router no tiene ninguna regla que corte por address-list')
    }

    const resultado = await adopcion.aplicar(plan, modo, {
      fijarLista: async (lista) => {
        const { error } = await db()
          .from('routers_mikrotik')
          .update({ lista_morosos: lista })
          .eq('id', equipo.id)
        if (error) throw new Error(`No se pudo guardar la lista: ${error.message}`)
      },
      copiar: (origen, destino) => mk.copiarLista(equipo, { origen, destino }),
      clonar: ({ tipo, id, lista }) =>
        mk.clonarReglaCorte(equipo, { tipo, id, lista, marca: 'Corte del sistema' }),
      apagar: ({ tipo, id }) => mk.cambiarReglaHabilitada(equipo, { tipo, id, apagar: true }),
    })

    res.json({ router: equipo.nombre, ...resultado })
  }),
)

/**
 * Deja el pool del MikroTik igual al rango declarado en el bloque.
 *
 * El rango vive acá como inventario y en el router como lo que de verdad
 * entrega. Cambiar uno solo deja al sistema diciendo una cosa y al router
 * haciendo otra — y el que manda es el router.
 */
router.post(
  '/subredes/:id/sincronizar-pool',
  asyncHandler(async (req, res) => {
    res.json(await poolsOnu.sincronizarPool(req.params.id))
  }),
)

/**
 * Reconstruye los bloques leyendo el MikroTik.
 *
 * Es lo que evita cargar a mano la red de un ISP que llega con todo armado: la
 * información ya está en los nombres de sus pools.
 */
router.post(
  '/routers/:id/importar-bloques',
  asyncHandler(async (req, res) => {
    res.json(await poolsOnu.importarDelRouter(req.params.id, req.body ?? {}))
  }),
)

export default router
