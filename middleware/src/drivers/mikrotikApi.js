import { RouterOSAPI } from 'node-routeros'
import { Channel } from 'node-routeros/dist/Channel.js'
import { AppError } from '../lib/errors.js'
import { enCola } from '../lib/cola.js'

/**
 * RouterOS contesta `!empty` cuando un listado no tiene ni una fila, y
 * node-routeros no conoce esa respuesta: la trata como desconocida, LANZA y
 * cierra el canal.
 *
 * Lanza desde el manejador del socket, fuera de la promesa, así que ningún
 * try/catch alrededor del await la agarra. En producción el efecto era que la
 * petición quedaba colgada sin contestar nunca: el técnico veía la rueda girar
 * para siempre porque el router no tenía ni un lease de DHCP.
 *
 * `!empty` no es un final: viene SEGUIDO de un `!done` normal. Así que lo
 * correcto no es resolver la promesa —eso cierra el canal y el `!done` llega a
 * un tag ya dado de baja, que vuelve a lanzar— sino ignorarlo y dejar que el
 * `!done` cierre como en cualquier listado.
 *
 * Se probó con la 1.6.9 y se comporta igual, así que actualizar no alcanza.
 */
const processPacketOriginal = Channel.prototype.processPacket
Channel.prototype.processPacket = function (packet) {
  if (packet?.[0] === '!empty') return
  return processPacketOriginal.call(this, packet)
}

/**
 * Driver MikroTik — API binaria de RouterOS.
 *
 * Es la forma habitual de integrarse con un MikroTik en un ISP: IP pública y
 * puerto de API (8728 en claro, 8729 con TLS). No depende de que el servicio web
 * esté publicado.
 *
 * El driver REST (drivers/mikrotik.js) queda como alternativa para redes donde
 * el 8728 está bloqueado por firewall — que fue el caso de la red del taller
 * (ver docs/comandos-referencia.md § 3).
 *
 * Las dos implementaciones exponen la MISMA interfaz, así que services/
 * mikrotikService.js puede elegir una u otra sin que las rutas se enteren.
 */

export const LISTA_MOROSOS = 'CORTE_MOROSOS'
const TIMEOUT_S = 10

/**
 * Que vaya cifrado lo decide el campo explícito, NUNCA el número de puerto.
 *
 * El puerto de la API se cambia habitualmente por seguridad, así que cualquier
 * regla del tipo "8729 significa TLS" se rompe en cuanto alguien mueve el
 * servicio. Con esto, el puerto es un dato libre y no cambia el comportamiento.
 */
const esTls = (router) => Boolean(router.usa_https)

/**
 * Sesiones reutilizadas, una por equipo.
 *
 * Antes cada operación abría su propia conexión: entrar a la ficha de un router
 * disparaba un login para los pools, otro para las direcciones, otro para las
 * interfaces… El log del MikroTik se llenaba de inicios de sesión y, con el
 * límite de sesiones que tienen estos equipos, era además arriesgado.
 *
 * Ahora se hace login una vez y la conexión se reutiliza. Se cierra sola tras un
 * rato sin uso, para no ocupar una ranura del equipo indefinidamente.
 */
const IDLE_MS = 60000
const sesiones = new Map()

const claveDe = (router) => `${router.ip_host}:${router.puerto_api ?? ''}:${router.usuario}`

function programarCierre(clave) {
  const s = sesiones.get(clave)
  if (!s) return
  clearTimeout(s.temporizador)
  s.temporizador = setTimeout(() => cerrarSesion(clave), IDLE_MS)
  // Que un temporizador pendiente no mantenga vivo el proceso.
  s.temporizador.unref?.()
}

async function cerrarSesion(clave) {
  const s = sesiones.get(clave)
  if (!s) return
  sesiones.delete(clave)
  clearTimeout(s.temporizador)
  try {
    await s.conn.close()
  } catch {
    /* ya estaba cerrada */
  }
}

/** Cierra todas las sesiones abiertas. Se usa al terminar el proceso. */
export async function cerrarTodas() {
  await Promise.all([...sesiones.keys()].map(cerrarSesion))
}

/** Cuántas sesiones hay abiertas. Para diagnóstico. */
export const sesionesAbiertas = () => sesiones.size

async function obtenerConexion(router) {
  const clave = claveDe(router)
  const existente = sesiones.get(clave)

  if (existente?.conn?.connected) {
    programarCierre(clave)
    return existente.conn
  }
  // Quedó una entrada muerta: se descarta antes de crear la nueva.
  if (existente) await cerrarSesion(clave)

  const conn = new RouterOSAPI({
    host: router.ip_host,
    user: router.usuario,
    password: router.password,
    // El puerto guardado manda. Los estándar (8728/8729) son solo el respaldo
    // para cuando el campo quedó vacío.
    port: Number(router.puerto_api) || (esTls(router) ? 8729 : 8728),
    timeout: TIMEOUT_S,
    keepalive: true,
    ...(esTls(router) ? { tls: { rejectUnauthorized: false } } : {}),
  })

  /**
   * El `timeout` de node-routeros vale para los comandos, NO para el connect.
   *
   * Contra un puerto que descarta los paquetes en silencio —un firewall con
   * DROP, que es lo normal en una IP pública— el socket se queda esperando el
   * tiempo de TCP del sistema operativo: más de dos minutos en Windows. Durante
   * ese rato la petición queda colgada sin error y sin nada que mirar.
   *
   * Importa más de lo que parece: el monitoreo recorre todos los nodos, y un
   * solo router inalcanzable estiraría cada pasada a varios minutos.
   */
  // El intento abandonado se silencia y se cierra: si no, el socket queda
  // abierto y su rechazo tardío llega cuando ya nadie lo espera, como un error
  // sin manejar que tumba el proceso.
  const intento = conn.connect()
  intento.catch(() => {})

  let reloj
  try {
    await Promise.race([
      intento,
      new Promise((_, rechazar) => {
        reloj = setTimeout(
          () => rechazar(new Error(`Timed out after ${TIMEOUT_S} seconds`)),
          TIMEOUT_S * 1000,
        )
        reloj.unref?.()
      }),
    ])
  } catch (err) {
    await conn.close().catch(() => {})
    throw err
  } finally {
    clearTimeout(reloj)
  }

  sesiones.set(clave, { conn, temporizador: null })
  programarCierre(clave)
  return conn
}

/**
 * Ejecuta `fn(conn)` sobre la sesión del equipo, reutilizándola.
 *
 * Las operaciones sobre un mismo router se encolan: la API binaria es con
 * estado y compartir una conexión entre llamadas simultáneas mezclaría las
 * respuestas. Equipos distintos siguen trabajando en paralelo.
 */
function conConexion(router, fn) {
  const clave = claveDe(router)

  return enCola(`mikrotik:${clave}`, async () => {
    let conn
    try {
      conn = await obtenerConexion(router)
    } catch (err) {
      await cerrarSesion(clave)
      throw traducirError(err, router)
    }

    try {
      return await fn(conn)
    } catch (err) {
      // Ante un fallo la conexión puede haber quedado inservible: se descarta
      // para que la próxima operación arranque con una sana.
      await cerrarSesion(clave)
      throw traducirError(err, router)
    }
  })
}

function traducirError(err, router) {
  if (err instanceof AppError) return err

  const msg = String(err?.message ?? err)
  const puerto = router.puerto_api || 8728

  if (err?.errno === 'ECONNREFUSED' || /ECONNREFUSED/i.test(msg)) {
    return new AppError(`El router ${router.ip_host}:${puerto} rechazó la conexión`, {
      status: 502,
      hint: `El servicio de API no está escuchando en ese puerto. Habilitalo con: /ip service enable api (8728) o api-ssl (8729).`,
    })
  }
  // "Timed out after 10 seconds" no contiene "timeout": hay que contemplar las
  // dos formas o el error cae en el genérico y pierde la pista útil.
  if (/timed?\s*out|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(msg)) {
    return new AppError(`No hay respuesta de ${router.ip_host}:${puerto}`, {
      status: 504,
      hint:
        'El paquete se descarta en silencio. En RouterOS hay que habilitar el acceso en DOS lugares y suele faltar uno: ' +
        '(1) /ip service set api address=… tiene que incluir tu IP pública — ojo que "set address" reemplaza la lista entera; ' +
        '(2) /ip firewall filter necesita un accept en la cadena input para ese puerto, con place-before=0. ' +
        'Si solo hacés uno de los dos, el síntoma es exactamente este timeout.',
    })
  }
  if (/cannot log in|invalid user name or password|not allowed/i.test(msg)) {
    return new AppError('Usuario o contraseña incorrectos para el MikroTik', {
      status: 401,
      hint: 'Verificá las credenciales y que el usuario tenga el permiso "api" en /user group.',
    })
  }
  if (/no such command|unknown command|syntax error/i.test(msg)) {
    return new AppError(`RouterOS no reconoció el comando: ${msg}`, {
      status: 400,
      hint: 'Puede ser una diferencia de versión de RouterOS.',
    })
  }

  // node-routeros a veces rechaza con un error sin mensaje (por ejemplo cuando el
  // puerto contesta pero no habla el protocolo de la API). Un error vacío no le
  // sirve a nadie, así que se reemplaza por la causa más probable.
  if (!msg || msg === 'undefined' || msg === '[object Object]') {
    return new AppError(`El puerto ${puerto} de ${router.ip_host} no responde como API de RouterOS`, {
      status: 502,
      hint: `Suele pasar al apuntar al puerto equivocado: la API va en 8728 (o 8729 con TLS). Si el router solo expone el servicio web, elegí el modo "REST API" al cargarlo.`,
      detalle: err?.code ?? err?.errno ?? undefined,
    })
  }

  return new AppError(`Error contra ${router.ip_host}: ${msg}`, { status: 502 })
}

/** Convierte {name: 'x'} en ['=name=x'], que es lo que espera la API binaria. */
const params = (obj) =>
  Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `=${k}=${v}`)

// --- Salud ------------------------------------------------------------------

export const probarConexion = (router) =>
  conConexion(router, async (conn) => {
    const [identidad] = await conn.write('/system/identity/print')
    const [recurso] = await conn.write('/system/resource/print').catch(() => [null])

    return {
      ok: true,
      identidad: identidad?.name ?? null,
      version: recurso?.version ?? null,
      modelo: recurso?.['board-name'] ?? null,
      uptime: recurso?.uptime ?? null,
      via: 'api-binaria',
    }
  })

// --- IP Pools ---------------------------------------------------------------

export const listarPools = (router) => conConexion(router, (conn) => conn.write('/ip/pool/print'))

export const crearPool = (router, { name, ranges, comment }) =>
  conConexion(router, (conn) => conn.write('/ip/pool/add', params({ name, ranges, comment })))

export const borrarPool = (router, id) =>
  conConexion(router, (conn) => conn.write('/ip/pool/remove', [`=.id=${id}`]))

// --- IP Addresses -----------------------------------------------------------

export const listarDirecciones = (router) =>
  conConexion(router, (conn) => conn.write('/ip/address/print'))

export const crearDireccion = (router, { address, interface: iface, comment }) =>
  conConexion(router, (conn) =>
    conn.write('/ip/address/add', params({ address, interface: iface, comment })),
  )

export const borrarDireccion = (router, id) =>
  conConexion(router, (conn) => conn.write('/ip/address/remove', [`=.id=${id}`]))

export const listarInterfaces = (router) =>
  conConexion(router, (conn) => conn.write('/interface/print'))

// --- Bloqueos ---------------------------------------------------------------

/**
 * Entradas del address-list de morosos.
 *
 * El filtrado se hace en JavaScript a propósito, NO con la consulta `?list=`
 * del lado de RouterOS. Cuando esa consulta no encuentra nada, el equipo
 * responde `!empty`, una respuesta que node-routeros no reconoce: lanza una
 * excepción de forma asíncrona, fuera del try/catch, y tira el proceso entero.
 *
 * Un print sin filtro devuelve `!done` normalmente, incluso sin resultados.
 */
export const listarBloqueos = async (router, lista = LISTA_MOROSOS) => {
  const todas = await conConexion(router, (conn) =>
    conn.write('/ip/firewall/address-list/print'),
  )
  return filtrarPorLista(todas, lista)
}

/** Separado del acceso a red para poder probarlo sin un equipo. */
export function filtrarPorLista(entradas, lista) {
  if (!Array.isArray(entradas)) return []
  return entradas.filter((e) => e.list === lista)
}

export const bloquearIp = (router, { address, comment, lista = LISTA_MOROSOS }) =>
  conConexion(router, (conn) =>
    conn.write('/ip/firewall/address-list/add', params({ list: lista, address, comment })),
  )

export const desbloquear = (router, id) =>
  conConexion(router, (conn) => conn.write('/ip/firewall/address-list/remove', [`=.id=${id}`]))

export const listarReglasFilter = (router) =>
  conConexion(router, (conn) => conn.write('/ip/firewall/filter/print'))

export const listarReglasNat = (router) =>
  conConexion(router, (conn) => conn.write('/ip/firewall/nat/print'))

/**
 * Crea la regla de drop del corte de morosos, una sola vez.
 * Se identifica por el comment para no duplicarla en cada arranque del taller.
 */
export const asegurarReglaCorte = (router, lista = LISTA_MOROSOS) =>
  conConexion(router, async (conn) => {
    const COMENTARIO = 'SmartOLT-CorteMorosos'
    const reglas = await conn.write('/ip/firewall/filter/print')
    if (reglas.some((r) => r.comment === COMENTARIO)) {
      return { creada: false, mensaje: 'La regla de corte ya existía' }
    }

    await conn.write(
      '/ip/firewall/filter/add',
      params({
        chain: 'forward',
        'src-address-list': lista,
        action: 'drop',
        comment: COMENTARIO,
      }),
    )
    return { creada: true, mensaje: 'Regla de corte creada' }
  })

// =============================================================================
// IPv6 — el mismo corte, en el otro espacio de direcciones
// =============================================================================
//
// En RouterOS `/ip/firewall` y `/ipv6/firewall` son dos mundos separados: no
// comparten listas ni reglas. Un abonado bloqueado en v4 sigue navegando por v6
// si acá no se hace lo mismo — y como Google, YouTube y Netflix responden por
// IPv6, para él no cambia nada.
//
// Nada de esto depende del medio: son reglas de capa 3. Sirve igual para un
// abonado de fibra que para uno de radioenlace.

export const LISTA_MOROSOS_V6 = 'CORTE_MOROSOS_V6'

/**
 * ¿Este equipo puede hablar IPv6?
 *
 * En RouterOS v6 el paquete `ipv6` viene deshabilitado de fábrica, y con él
 * apagado cualquier escritura en `/ipv6/` falla. En v7 está integrado y siempre
 * responde. Se pregunta antes de tocar nada para poder dar un mensaje que diga
 * qué hacer, en vez de un error de la API.
 */
export const soportaIpv6 = (router) =>
  conConexion(router, async (conn) => {
    try {
      await conn.write('/ipv6/firewall/filter/print')
      return { disponible: true }
    } catch (err) {
      return {
        disponible: false,
        motivo: String(err?.message ?? err),
        // El caso habitual y su arreglo, para no mandar a nadie a buscarlo.
        sugerencia:
          'En RouterOS v6 el paquete ipv6 viene apagado: System → Packages → ipv6 → Enable y reiniciar.',
      }
    }
  })

export const listarBloqueosIpv6 = async (router, lista = LISTA_MOROSOS_V6) => {
  const todas = await conConexion(router, (conn) =>
    conn.write('/ipv6/firewall/address-list/print'),
  )
  return filtrarPorLista(todas, lista)
}

export const bloquearIpv6 = (router, { address, comment, lista = LISTA_MOROSOS_V6 }) =>
  conConexion(router, (conn) =>
    conn.write('/ipv6/firewall/address-list/add', params({ list: lista, address, comment })),
  )

export const desbloquearIpv6 = (router, id) =>
  conConexion(router, (conn) => conn.write('/ipv6/firewall/address-list/remove', [`=.id=${id}`]))

export const listarReglasFilterIpv6 = (router) =>
  conConexion(router, (conn) => conn.write('/ipv6/firewall/filter/print'))

/**
 * Las reglas de corte de v6. Son DOS, y las dos hacen falta.
 *
 * En IPv4 alcanza con una regla sobre `src-address-list` porque detrás del NAT
 * el abonado no recibe conexiones entrantes: cortar lo que sale corta todo.
 *
 * En IPv6 no hay NAT y cada dispositivo del cliente es alcanzable desde
 * internet. Con una sola regla sobre el origen, el cortado no puede navegar
 * pero cualquiera de afuera sí puede llegarle —y él contestar—. Por eso también
 * se corta lo que va HACIA su prefijo.
 */
export const asegurarReglaCorteIpv6 = (router, lista = LISTA_MOROSOS_V6) =>
  conConexion(router, async (conn) => {
    const reglas = await conn.write('/ipv6/firewall/filter/print')
    const hechas = []

    for (const [comentario, campo] of [
      ['SmartOLT-CorteMorosos-v6-salida', 'src-address-list'],
      ['SmartOLT-CorteMorosos-v6-entrada', 'dst-address-list'],
    ]) {
      if (reglas.some((r) => r.comment === comentario)) continue
      await conn.write(
        '/ipv6/firewall/filter/add',
        params({ chain: 'forward', [campo]: lista, action: 'drop', comment: comentario }),
      )
      hechas.push(comentario)
    }

    return {
      creadas: hechas.length,
      mensaje: hechas.length
        ? `Se crearon ${hechas.length} regla(s) de corte IPv6`
        : 'Las reglas de corte IPv6 ya existían',
    }
  })

export const asegurarRedireccionPago = (router, { destino, puerto = 80, lista = LISTA_MOROSOS }) =>
  conConexion(router, async (conn) => {
    const COMENTARIO = 'SmartOLT-RedireccionPago'
    const reglas = await conn.write('/ip/firewall/nat/print')
    if (reglas.some((r) => r.comment === COMENTARIO)) {
      return { creada: false, mensaje: 'La regla de redirección ya existía' }
    }

    await conn.write(
      '/ip/firewall/nat/add',
      params({
        chain: 'dstnat',
        protocol: 'tcp',
        'dst-port': '80',
        'src-address-list': lista,
        action: 'dst-nat',
        'to-addresses': destino,
        'to-ports': String(puerto),
        comment: COMENTARIO,
      }),
    )
    return { creada: true, mensaje: 'Regla de redirección de pago creada' }
  })

// --- Simple Queues ----------------------------------------------------------

export const listarSimpleQueues = (router) =>
  conConexion(router, (conn) => conn.write('/queue/simple/print'))

/**
 * La cola de un abonado, buscada como la busca el router: por objetivo.
 *
 * El `target` es lo que decide a quién limita la cola; el nombre es una
 * etiqueta que alguien pudo haber cambiado. Buscar por nombre encontraría la
 * cola equivocada cuando dos abonados se llaman parecido, y no encontraría
 * ninguna cuando a alguien le corrigieron el apellido.
 *
 * El objetivo puede estar escrito "10.0.0.5" o "10.0.0.5/32" según cómo se creó,
 * y RouterOS admite varios separados por coma. Se comparan las direcciones.
 */
export function buscarColaPorIp(colas, ip) {
  const buscada = String(ip ?? '').trim()
  if (!buscada) return []

  return (Array.isArray(colas) ? colas : []).filter((q) =>
    String(q.target ?? '')
      .split(',')
      .some((t) => t.trim().split('/')[0] === buscada),
  )
}

/**
 * Deja la Simple Queue del abonado con la velocidad que corresponde.
 *
 * Se usa al cambiar un plan: en PPPoE alcanza con tocar el perfil, que es uno
 * solo y lo comparten todos, pero con IP fija cada abonado tiene su propia cola
 * y hay que reescribirlas de a una. Si no existe se crea.
 */
/**
 * A quién limita la cola: la IPv4 y, si la hay, el prefijo IPv6.
 *
 * ── Por qué una sola cola y no dos ──
 *
 * `target` de una simple queue acepta varias direcciones separadas por coma, y
 * los prefijos IPv6 son válidos ahí. Con las dos en la misma cola, el abonado
 * tiene UN límite de 150 Mbps y no dos de 150 que se suman a 300 según por
 * dónde baje.
 *
 * Es también lo que evita el error clásico: limitar solo v4 y que el tráfico
 * v6 —que es casi todo YouTube y Netflix— pase sin tope.
 */
export const objetivoDeCola = (ip, ipv6) =>
  [ip ? `${ip}/32` : null, ipv6 || null].filter(Boolean).join(',')

export const asegurarSimpleQueue = (router, { nombre, ip, ipv6, comentario, campos: cola = {} }) =>
  conConexion(router, async (conn) => {
    const previas = buscarColaPorIp(await conn.write('/queue/simple/print'), ip)
    // Los campos de velocidad llegan ya traducidos (`camposDeCola`): el driver
    // no decide qué se aplica, solo lo escribe.
    const campos = params({
      name: nombre,
      target: objetivoDeCola(ip, ipv6),
      ...cola,
      comment: comentario,
    })

    if (previas.length) {
      // Solo la primera: si un abonado tiene dos colas apuntándole, la segunda
      // es basura de una importación y tocarla no arregla nada. Se informa.
      await conn.write('/queue/simple/set', [`=.id=${previas[0]['.id']}`, ...campos])
      return { creada: false, actualizada: true, duplicadas: previas.length - 1 }
    }

    await conn.write('/queue/simple/add', campos)
    return { creada: true, actualizada: false, duplicadas: 0 }
  })

// --- Fuentes para importar clientes -----------------------------------------
//
// Al migrar desde otro sistema de gestión, los datos de los clientes quedan
// repartidos en el router. Cada fuente aporta algo distinto:
//   ppp secret    → usuario, IP fija asignada, perfil
//   simple queue  → nombre, IP objetivo, velocidad contratada
//   dhcp lease    → MAC, IP, y el nombre suele estar en el comentario
//   address-list  → quién está cortado

export const listarPppSecrets = (router) =>
  conConexion(router, (conn) => conn.write('/ppp/secret/print'))

/**
 * Los perfiles PPP del equipo.
 *
 * En PPPoE la velocidad la aplica el perfil, no una cola: es el dato que hay
 * que elegir al configurar un plan, y tiene que salir del router y no de la
 * memoria de nadie —el nombre se escribe exacto o no aplica nada—.
 */
export const listarPppProfiles = (router) =>
  conConexion(router, (conn) => conn.write('/ppp/profile/print'))

/**
 * Los servidores PPPoE y sobre qué interfaz escucha cada uno.
 *
 * Es el dato que decide si un abonado nuevo puede autenticar: sin un servidor
 * escuchando en SU VLAN, la ONT levanta, el service-port pasa tráfico, y el
 * PPPoE del cliente no encuentra con quién hablar. Desde el lado GPON no se ve
 * nada raro.
 */
export const listarPppoeServers = (router) =>
  conConexion(router, (conn) => conn.write('/interface/pppoe-server/server/print'))

/** Las interfaces VLAN del router: sobre qué troncal y con qué id. */
export const listarInterfacesVlan = (router) =>
  conConexion(router, (conn) => conn.write('/interface/vlan/print'))

/**
 * Deja el perfil PPP de un plan como tiene que quedar en el equipo.
 *
 * `rateLimit` vacío NO significa "no tocar": significa **sin límite**, y es lo
 * que corresponde en FTTH, donde el caudal lo controla la traffic table de la
 * OLT. Un límite acá pelearía con ella y el abonado terminaría con el menor de
 * los dos sin que nadie sepa por qué.
 *
 * Por eso el campo se manda siempre, con cadena vacía cuando no hay límite:
 * omitirlo dejaría el valor viejo de un plan anterior para siempre.
 */
export const asegurarPppProfile = (router, { nombre, rateLimit = '', comentario, pool, localAddress }) =>
  conConexion(router, async (conn) => {
    const previos = buscarPorNombre(await conn.write('/ppp/profile/print'), nombre)

    // `params` descarta lo vacío, y acá el vacío es un valor: se arma a mano.
    const campos = [
      `=name=${nombre}`,
      `=rate-limit=${rateLimit ?? ''}`,
      ...(pool ? [`=remote-address=${pool}`] : []),
      // La puerta de enlace que recibe el abonado. Sin ella autentica y queda
      // sin salida: un fallo que no se ve al crear el perfil sino cuando el
      // cliente llama porque "conecta pero no navega".
      ...(localAddress ? [`=local-address=${localAddress}`] : []),
      ...(comentario ? [`=comment=${comentario}`] : []),
    ]

    if (previos.length) {
      // El perfil por defecto de RouterOS no se toca: lo usan las sesiones que
      // no tienen otro y renombrarle el límite afectaría a quien no corresponde.
      if (previos[0].default === 'true') {
        throw new AppError(`"${nombre}" es un perfil por defecto de RouterOS y no se modifica`, {
          status: 400,
          hint: 'Usá un nombre propio para el plan, distinto de default y default-encryption.',
        })
      }
      await conn.write('/ppp/profile/set', [`=.id=${previos[0]['.id']}`, ...campos])
      return { creado: false, actualizado: true, nombre, rate_limit: rateLimit ?? '' }
    }

    await conn.write('/ppp/profile/add', campos)
    return { creado: true, actualizado: false, nombre, rate_limit: rateLimit ?? '' }
  })

export const listarPppActive = (router) =>
  conConexion(router, (conn) => conn.write('/ppp/active/print'))

export const listarDhcpLeases = (router) =>
  conConexion(router, (conn) => conn.write('/ip/dhcp-server/lease/print'))

/** Todas las entradas de todos los address-list, sin filtrar. */
export const listarTodasLasEntradas = (router) =>
  conConexion(router, (conn) => conn.write('/ip/firewall/address-list/print'))

// --- Salud del equipo --------------------------------------------------------

/**
 * Carga de CPU, memoria y disco del router.
 *
 * `probarConexion` ya trae la versión y el modelo, pero eso solo dice que el
 * equipo contesta. Un CCR al 95% de CPU contesta perfecto y le está cortando el
 * tráfico a todos: es la falla que se busca cuando "anda lento" y los pings dan
 * bien.
 */
export const leerRecursos = (router) =>
  conConexion(router, async (conn) => {
    const [recurso] = await conn.write('/system/resource/print')
    return recurso ?? null
  })

/**
 * Barrido activo de una subred con la herramienta del propio router.
 *
 * `/tool/ip-scan` recorre el rango desde el equipo, que es el único lugar con
 * ruta hasta las IPs de los abonados. Hacerlo desde el servidor del middleware
 * no encontraría nada: no está en esa red.
 *
 * `duration` es obligatorio por la misma razón que `count` en el ping: sin él
 * la herramienta corre indefinidamente y la conexión queda colgada.
 */
export const escanearRango = (router, { rango, duracion = 15, interfaz }) =>
  conConexion(router, (conn) =>
    conn.write('/tool/ip-scan', [
      `=address-range=${rango}`,
      `=duration=${Math.min(Number(duracion) || 15, 60)}`,
      ...(interfaz ? [`=interface=${interfaz}`] : []),
    ]),
  )

// --- Alta de un abonado nuevo ------------------------------------------------

/**
 * Quién está asociado a la radio, con su señal y su CCQ.
 *
 * RouterOS v7 tiene dos pilas de wireless según el modelo y el paquete
 * instalado: la clásica en `/interface/wireless` y wifiwave2 en
 * `/interface/wifi`. Cuál está no se deduce de la versión, así que se prueban
 * las dos en la misma conexión.
 */
export const listarRegistroWireless = (router) =>
  conConexion(router, async (conn) => {
    const clasica = await conn
      .write('/interface/wireless/registration-table/print')
      .catch(() => null)
    if (clasica?.length) return clasica

    const wave2 = await conn.write('/interface/wifi/registration-table/print').catch(() => null)
    return wave2 ?? clasica ?? []
  })

/**
 * Busca por nombre entre lo que ya trajo el equipo.
 *
 * La consulta se hace acá y NO del lado de RouterOS (`?name=…`) por la misma
 * razón que en `filtrarPorLista`: cuando una consulta del equipo no encuentra
 * nada responde `!empty`, que node-routeros no reconoce, y lanza una excepción
 * ASÍNCRONA que ningún try/catch alcanza. La petición queda colgada para
 * siempre.
 *
 * Y "no encuentra nada" es el caso NORMAL acá: un abonado nuevo justamente no
 * tiene secret todavía.
 */
export const buscarPorNombre = (filas, nombre) =>
  (Array.isArray(filas) ? filas : []).filter((f) => f.name === nombre)

/**
 * Deja el secret PPPoE del abonado como tiene que quedar.
 *
 * Si ya existe se modifica en vez de crear otro: en un alta que se reintenta
 * —el técnico perdió señal y volvió a apretar— un `add` daría "already have
 * such name" y dejaría el trabajo trabado con el equipo ya instalado.
 */
export const asegurarPppSecret = (router, { usuario, clave, perfil, ip, comentario }) =>
  conConexion(router, async (conn) => {
    const previos = buscarPorNombre(await conn.write('/ppp/secret/print'), usuario)
    const campos = params({
      name: usuario,
      password: clave,
      service: 'pppoe',
      profile: perfil,
      'remote-address': ip,
      comment: comentario,
    })

    if (previos.length) {
      await conn.write('/ppp/secret/set', [`=.id=${previos[0]['.id']}`, ...campos])
      return { creado: false, actualizado: true, usuario }
    }

    await conn.write('/ppp/secret/add', campos)
    return { creado: true, actualizado: false, usuario }
  })

/**
 * Borra el secret de un abonado.
 *
 * Se busca por nombre y no se recibe el `.id` desde afuera: los identificadores
 * de RouterOS cambian de posición y borrar por un `.id` guardado hace un rato es
 * cómo se termina dando de baja al abonado equivocado.
 *
 * Que no exista no es un error: dar de baja dos veces tiene que poder pasar sin
 * romper nada.
 */
export const borrarPppSecret = (router, usuario) =>
  conConexion(router, async (conn) => {
    const previos = buscarPorNombre(await conn.write('/ppp/secret/print'), usuario)
    if (!previos.length) return { borrado: false, motivo: 'no existía', usuario }

    await conn.write('/ppp/secret/remove', [`=.id=${previos[0]['.id']}`])
    return { borrado: true, usuario }
  })

/** Igual que `buscarPorNombre`, pero por MAC y sin distinguir mayúsculas. */
export const buscarPorMac = (filas, mac) =>
  (Array.isArray(filas) ? filas : []).filter(
    (f) => String(f['mac-address'] ?? '').toUpperCase() === String(mac ?? '').toUpperCase(),
  )

/**
 * Reserva fija por DHCP: al equipo con esa MAC siempre le toca esa IP.
 *
 * Es lo que hace que un "DHCP" se comporte como IP fija sin configurar nada en
 * el equipo del cliente — que es justo lo que no se puede hacer cuando el
 * router lo pone el abonado.
 */
export const asegurarLeaseFija = (router, { ip, mac, servidor, comentario }) =>
  conConexion(router, async (conn) => {
    const direccionMac = String(mac).toUpperCase()
    // Se filtra acá y no con `?mac-address=…`: ver `buscarPorNombre`.
    const previas = buscarPorMac(await conn.write('/ip/dhcp-server/lease/print'), direccionMac)
    const campos = params({
      address: ip,
      'mac-address': direccionMac,
      server: servidor,
      comment: comentario,
    })

    if (previas.length) {
      // Una lease dinámica es la que el servidor repartió sola: no se puede
      // editar hasta convertirla en estática, y sin eso el equipo vuelve a
      // tomar otra IP en la próxima renovación.
      if (previas[0].dynamic === 'true') {
        await conn.write('/ip/dhcp-server/lease/make-static', [`=.id=${previas[0]['.id']}`])
      }
      await conn.write('/ip/dhcp-server/lease/set', [`=.id=${previas[0]['.id']}`, ...campos])
      return { creada: false, actualizada: true, ip }
    }

    await conn.write('/ip/dhcp-server/lease/add', campos)
    return { creada: true, actualizada: false, ip }
  })

/**
 * Copia las entradas de una address-list a otra, en UNA sola conexión.
 *
 * Abrir una sesión por entrada agotaría el límite de sesiones del equipo en
 * cuestión de segundos. Las direcciones que ya estén en la lista destino se
 * saltean, así que se puede reintentar sin duplicar.
 */
/**
 * Los campos de una regla que se pueden volver a escribir.
 *
 * RouterOS devuelve, además de la configuración, contadores y banderas que NO
 * son parámetros: `bytes`, `packets`, `invalid`, `dynamic`. Mandárselos de
 * vuelta al crear una regla hace fallar el comando entero.
 */
const REGLA_SOLO_LECTURA = new Set(['.id', 'bytes', 'packets', 'invalid', 'dynamic'])

function camposDeRegla(regla) {
  const limpio = {}
  for (const [k, v] of Object.entries(regla)) {
    if (REGLA_SOLO_LECTURA.has(k)) continue
    limpio[k] = v
  }
  return limpio
}

/**
 * Clona una regla cambiándole la lista de origen.
 *
 * ── Por qué `place-before` y no agregarla al final ──
 *
 * Porque en el firewall el ORDEN es la lógica. La regla que redirige al moroso
 * a la página de pago viene después de otra que le permite VER esa página; si el
 * clon se agrega al final, puede quedar detrás de un `accept` que lo anule, o
 * delante del permiso y dejar al moroso sin poder ver ni siquiera dónde pagar.
 *
 * Poniéndolo justo antes del original, el clon ocupa exactamente el mismo lugar
 * y se comporta igual.
 */
export const clonarReglaCorte = (router, { tipo = 'nat', id, lista, marca }) =>
  conConexion(router, async (conn) => {
    const ruta = tipo === 'filter' ? '/ip/firewall/filter' : '/ip/firewall/nat'
    const todas = await conn.write(`${ruta}/print`)
    const original = todas.find((r) => r['.id'] === id)
    if (!original) throw new Error(`No existe la regla ${id} en ${ruta}`)

    const campos = camposDeRegla(original)
    campos['src-address-list'] = lista
    // La marca es lo que permite encontrar estos clones después para
    // deshacerlos. Sin ella, revertir sería ir a buscarlos a ojo.
    campos.comment = `${marca}${original.comment ? ` · ${original.comment}` : ''}`
    campos['place-before'] = id

    const creada = await conn.write(`${ruta}/add`, params(campos))
    return { tipo, original: id, creada: creada?.[0]?.ret ?? null, comment: campos.comment }
  })

/** Apaga o enciende una regla, sin borrarla: es lo que permite volver atrás. */
export const cambiarReglaHabilitada = (router, { tipo = 'nat', id, apagar = true }) =>
  conConexion(router, async (conn) => {
    const ruta = tipo === 'filter' ? '/ip/firewall/filter' : '/ip/firewall/nat'
    await conn.write(`${ruta}/set`, params({ '.id': id, disabled: apagar ? 'yes' : 'no' }))
    return { tipo, id, apagada: apagar }
  })

export const copiarLista = (router, { origen, destino }) =>
  conConexion(router, async (conn) => {
    const todas = await conn.write('/ip/firewall/address-list/print')

    const aCopiar = filtrarPorLista(todas, origen)
    const yaEstan = new Set(filtrarPorLista(todas, destino).map((e) => e.address))

    const copiadas = []
    const salteadas = []
    const fallidas = []

    for (const entrada of aCopiar) {
      if (yaEstan.has(entrada.address)) {
        salteadas.push(entrada.address)
        continue
      }
      try {
        await conn.write(
          '/ip/firewall/address-list/add',
          params({
            list: destino,
            address: entrada.address,
            comment: entrada.comment ?? `Migrado de ${origen}`,
          }),
        )
        copiadas.push(entrada.address)
      } catch (err) {
        fallidas.push({ address: entrada.address, error: String(err?.message ?? err) })
      }
    }

    return { origen, destino, encontradas: aCopiar.length, copiadas, salteadas, fallidas }
  })

/**
 * Trae todo lo necesario para un escaneo en UNA sola sesión.
 *
 * Importa hacerlo así: abrir una conexión por consulta multiplica las sesiones
 * contra el equipo, y varias fuentes pueden no existir según cómo esté armado
 * el router. Cada una falla por separado sin arruinar el resto.
 */
export async function escanear(router) {
  return conConexion(router, async (conn) => {
    const intentar = async (etiqueta, comando) => {
      try {
        return await conn.write(comando)
      } catch (err) {
        console.warn(`[escaneo] ${etiqueta} no disponible: ${err?.message ?? err}`)
        return []
      }
    }

    return {
      pppSecrets: await intentar('ppp secrets', '/ppp/secret/print'),
      pppActive: await intentar('ppp active', '/ppp/active/print'),
      simpleQueues: await intentar('simple queues', '/queue/simple/print'),
      dhcpLeases: await intentar('dhcp leases', '/ip/dhcp-server/lease/print'),
      addressList: await intentar('address lists', '/ip/firewall/address-list/print'),
    }
  })
}

/**
 * Crea en el router las colas o los secrets de los clientes del sistema.
 *
 * Todo en UNA conexión: exportar 200 clientes abriendo una sesión por cada uno
 * agotaría el límite del equipo de inmediato.
 *
 * Lo que ya existe se saltea en vez de fallar, así que se puede reintentar y
 * volver a exportar después de agregar clientes nuevos.
 */
export const exportarClientes = (router, { clientes, modo = 'simple-queue' }) =>
  conConexion(router, async (conn) => {
    const creados = []
    const salteados = []
    const fallidos = []

    if (modo === 'ppp-secret') {
      const existentes = new Set(
        (await conn.write('/ppp/secret/print')).map((s) => s.name).filter(Boolean),
      )

      for (const c of clientes) {
        if (!c.usuario_ppp) {
          fallidos.push({ nombre: c.nombre, error: 'no tiene usuario PPPoE' })
          continue
        }
        if (existentes.has(c.usuario_ppp)) {
          salteados.push(c.usuario_ppp)
          continue
        }
        try {
          await conn.write(
            '/ppp/secret/add',
            params({
              name: c.usuario_ppp,
              password: c.password_ppp ?? c.usuario_ppp,
              service: 'pppoe',
              'remote-address': c.ip,
              comment: c.nombre,
            }),
          )
          creados.push(c.usuario_ppp)
        } catch (err) {
          fallidos.push({ nombre: c.nombre, error: String(err?.message ?? err) })
        }
      }

      return { modo, creados, salteados, fallidos }
    }

    // simple-queue
    const colas = await conn.write('/queue/simple/print')
    const nombresUsados = new Set(colas.map((q) => q.name).filter(Boolean))
    const targetsUsados = new Set(colas.map((q) => q.target).filter(Boolean))

    for (const c of clientes) {
      if (!c.ip) {
        fallidos.push({ nombre: c.nombre, error: 'no tiene IP' })
        continue
      }
      if (!c.velocidad_cruda) {
        fallidos.push({ nombre: c.nombre, error: 'no tiene velocidad ni plan asignado' })
        continue
      }

      const target = `${c.ip}/32`
      if (nombresUsados.has(c.nombre) || targetsUsados.has(target)) {
        salteados.push(c.nombre)
        continue
      }

      try {
        await conn.write(
          '/queue/simple/add',
          params({
            name: c.nombre,
            target,
            'max-limit': c.velocidad_cruda,
            comment: c.comentario ?? 'SmartOLT',
          }),
        )
        creados.push(c.nombre)
      } catch (err) {
        fallidos.push({ nombre: c.nombre, error: String(err?.message ?? err) })
      }
    }

    return { modo, creados, salteados, fallidos }
  })

/**
 * Aplica un plan de sincronización de morosos: agrega y quita entradas del
 * address-list en una sola conexión.
 */
export const aplicarSincronizacion = (router, { lista, agregar = [], quitar = [] }) =>
  conConexion(router, async (conn) => {
    const agregadas = []
    const quitadas = []
    const fallidas = []

    for (const a of agregar) {
      try {
        await conn.write(
          '/ip/firewall/address-list/add',
          params({ list: lista, address: a.address, comment: a.comment ?? a.nombre }),
        )
        agregadas.push(a.address)
      } catch (err) {
        fallidas.push({ address: a.address, accion: 'agregar', error: String(err?.message ?? err) })
      }
    }

    // Los ids pueden haber cambiado desde que se armó el plan, así que se
    // vuelven a buscar por dirección en vez de confiar en el id guardado.
    if (quitar.length) {
      const actuales = await conn.write('/ip/firewall/address-list/print')
      const porDireccion = new Map(
        actuales
          .filter((e) => e.list === lista)
          .map((e) => [String(e.address).split('/')[0], e['.id']]),
      )

      for (const q of quitar) {
        const id = porDireccion.get(q.address)
        if (!id) {
          fallidas.push({ address: q.address, accion: 'quitar', error: 'ya no estaba en la lista' })
          continue
        }
        try {
          await conn.write('/ip/firewall/address-list/remove', [`=.id=${id}`])
          quitadas.push(q.address)
        } catch (err) {
          fallidas.push({ address: q.address, accion: 'quitar', error: String(err?.message ?? err) })
        }
      }
    }

    return { lista, agregadas, quitadas, fallidas }
  })

export const crearSimpleQueue = (router, { name, target, bajadaKbps, subidaKbps, comment }) =>
  conConexion(router, (conn) =>
    conn.write(
      '/queue/simple/add',
      params({
        name,
        target,
        'max-limit': `${subidaKbps}k/${bajadaKbps}k`,
        comment,
      }),
    ),
  )

// ---------------------------------------------------------------------------
// Diagnóstico y control remoto
// ---------------------------------------------------------------------------
//
// Son las herramientas que hoy se usan entrando al Winbox: probar si el abonado
// responde, reiniciar su equipo, bajarle la sesión para que reconecte. Hacerlas
// desde la ficha evita el paso de buscar la IP a mano, que es donde se cuela el
// error de tocarle el router al vecino.

/**
 * Ping desde el router hacia una IP.
 *
 * `count` es obligatorio: sin él RouterOS pinguea para siempre y la conexión
 * queda colgada hasta que salta el tiempo de espera.
 */
export const ping = (router, { destino, cantidad = 4 }) =>
  conConexion(router, (conn) =>
    conn.write('/ping', [`=address=${destino}`, `=count=${Math.min(Number(cantidad) || 4, 10)}`]),
  )

/** Traceroute desde el router. Se acota el salto máximo por el mismo motivo. */
export const traceroute = (router, { destino, saltos = 12 }) =>
  conConexion(router, (conn) =>
    conn.write('/tool/traceroute', [
      `=address=${destino}`,
      `=count=1`,
      `=max-hops=${Math.min(Number(saltos) || 12, 20)}`,
    ]),
  )

/** Reinicia el router. */
export const reiniciar = (router) =>
  conConexion(router, (conn) => conn.write('/system/reboot'))

/**
 * Baja la sesión PPPoE del abonado.
 *
 * Es lo que se hace cuando quedó "pegado" con una IP vieja o con el perfil
 * anterior: al reconectar toma la configuración nueva. No corta el servicio,
 * lo obliga a renegociar.
 */
export async function bajarSesionPpp(router, { usuario }) {
  return conConexion(router, async (conn) => {
    // Se trae todo y se filtra acá: ver `buscarPorNombre`. Que el abonado no
    // tenga sesión abierta es el caso más común de esta función, y es
    // justamente el que colgaba la petición.
    const activas = buscarPorNombre(await conn.write('/ppp/active/print'), usuario)
    if (!activas.length) return { bajadas: 0, aviso: 'No tenía sesión activa' }

    for (const s of activas) {
      await conn.write('/ppp/active/remove', [`=.id=${s['.id']}`])
    }
    return { bajadas: activas.length }
  })
}

/** Las sesiones PPPoE activas de un usuario. */
export const sesionPpp = (router, { usuario }) =>
  conConexion(router, async (conn) =>
    buscarPorNombre(await conn.write('/ppp/active/print'), usuario),
  )

/**
 * Los equipos conectados en la casa del abonado.
 *
 * Se leen del ARP del router filtrando por la red del cliente. No es la lista
 * del WiFi del cliente —para eso hace falta entrar a su CPE por TR-069— pero
 * responde la pregunta habitual: cuántos aparatos tiene prendidos.
 */
export const listarArp = (router, { interfaz } = {}) =>
  conConexion(router, (conn) =>
    conn.write('/ip/arp/print', interfaz ? [`?interface=${interfaz}`] : []),
  )

/**
 * Cambia el nombre y la clave del WiFi de un MikroTik que hace de CPE.
 *
 * Sirve cuando el equipo del abonado es un hAP o similar administrado por
 * nosotros. Si el CPE es una ONT de la OLT, esto no aplica: ese camino es
 * TR-069 y va por otro lado.
 */
export async function cambiarWifi(router, { ssid, clave, perfil = 'default' }) {
  return conConexion(router, async (conn) => {
    const cambios = []

    if (clave) {
      const perfiles = await conn.write('/interface/wireless/security-profiles/print', [
        `?name=${perfil}`,
      ])
      if (!perfiles.length) throw new Error(`No existe el perfil de seguridad "${perfil}"`)

      await conn.write('/interface/wireless/security-profiles/set', [
        `=.id=${perfiles[0]['.id']}`,
        '=mode=dynamic-keys',
        '=authentication-types=wpa2-psk',
        `=wpa2-pre-shared-key=${clave}`,
      ])
      cambios.push('clave')
    }

    if (ssid) {
      const wifis = await conn.write('/interface/wireless/print')
      if (!wifis.length) throw new Error('El equipo no tiene interfaz inalámbrica')

      for (const w of wifis) {
        await conn.write('/interface/wireless/set', [`=.id=${w['.id']}`, `=ssid=${ssid}`])
      }
      cambios.push('ssid')
    }

    return { cambios }
  })
}

/**
 * Prueba de velocidad interna, del router contra otro equipo de la red.
 *
 * Mide el enlace hasta el abonado, no su salida a internet: es lo que sirve
 * para descartar que el problema esté en nuestra red antes de mandar un
 * técnico. El destino tiene que ser otro RouterOS con el bandwidth-server
 * habilitado.
 *
 * ── Por qué lleva su propio tope de tiempo ──
 *
 * El `timeout` de node-routeros no lo alcanza. `bandwidth-test` no es un
 * comando que responde y termina: se queda emitiendo mediciones hasta que la
 * prueba concluye, y si el otro extremo no habla el protocolo —o sea, cualquier
 * ONT, cualquier CPE que no sea RouterOS— nunca manda el `!done` que la
 * biblioteca espera. Se midió: tres minutos sin resolver ni rechazar.
 *
 * Eso colgaba el alta en campo. El paso 4 llama a esta prueba, la petición
 * nunca volvía, y el técnico se quedaba mirando el botón girar sin poder
 * terminar la instalación. Lo peor es que el error estaba contemplado más
 * arriba —el endpoint atrapa el fallo y sigue— pero un fallo que no ocurre
 * nunca no se puede atrapar.
 *
 * El tope va DENTRO de `conConexion` a propósito. Puesto afuera, la promesa
 * colgada seguiría ocupando el turno de este router en la cola y dejaría sin
 * atender a todo lo que viniera después. Acá, el rechazo hace que `conConexion`
 * cierre la sesión, el socket muera y la escritura pendiente se libere.
 */
export const testVelocidad = (router, { destino, duracion = 5, direccion = 'both' }) => {
  const segundos = Math.min(Number(duracion) || 5, 15)

  return conConexion(router, async (conn) => {
    let reloj

    try {
      return await Promise.race([
        conn.write('/tool/bandwidth-test', [
          `=address=${destino}`,
          `=duration=${segundos}`,
          `=direction=${direccion}`,
        ]),
        new Promise((_, rechazar) => {
          reloj = setTimeout(
            () =>
              rechazar(
                new AppError(`${destino} no respondió la prueba de ancho de banda`, {
                  status: 504,
                  hint:
                    'Es lo normal en una ONT o un CPE que no es RouterOS: el bandwidth-test ' +
                    'necesita un RouterOS con el bandwidth-server habilitado del otro lado.',
                }),
              ),
            // Lo que dura la prueba, más margen para que arranque y cierre.
            (segundos + 10) * 1000,
          )
          reloj.unref?.()
        }),
      ])
    } finally {
      clearTimeout(reloj)
    }
  })
}
