import { AppError } from '../lib/errors.js'
import { comentario, esNuestra, hayQueRenombrar, MARCA } from '../lib/marcaReglas.js'

/**
 * Driver MikroTik — REST API de RouterOS v7.
 *
 * No se usa SSH ni la API binaria del puerto 8728: en la red del taller ese puerto
 * estaba bloqueado por firewall aunque el servicio estuviera habilitado
 * (ver docs/comandos-referencia.md § 3).
 *
 * Convenciones de RouterOS REST:
 *   GET    /rest/<ruta>        listar
 *   PUT    /rest/<ruta>        crear
 *   PATCH  /rest/<ruta>/<id>   modificar
 *   DELETE /rest/<ruta>/<id>   borrar
 * Los ids tienen forma "*1", "*A" — hay que URL-encodearlos.
 */

export const LISTA_MOROSOS = 'CORTE_MOROSOS'
const TIMEOUT_MS = 10000

function baseUrl(router) {
  const esquema = router.usa_https ? 'https' : 'http'
  const puerto = router.puerto_api || (router.usa_https ? 443 : 80)
  return `${esquema}://${router.ip_host}:${puerto}/rest`
}

async function request(router, metodo, ruta, body) {
  const url = `${baseUrl(router)}${ruta}`
  const auth = Buffer.from(`${router.usuario}:${router.password}`).toString('base64')

  let res
  try {
    res = await fetch(url, {
      method: metodo,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    throw traducirErrorRed(err, router)
  }

  const contentType = res.headers.get('content-type') || ''
  const texto = await res.text()

  // --- Detección del fallo silencioso -------------------------------------
  // Si la REST API no está realmente activa en esa ruta, RouterOS devuelve la
  // página de Webfig con código 200. Confiar en el status y hacer JSON.parse
  // daría un "Unexpected token <" imposible de diagnosticar para el usuario.
  if (!contentType.includes('json')) {
    const pareceHtml = /^\s*<(!doctype|html)/i.test(texto)
    throw new AppError(
      pareceHtml
        ? 'El router respondió con la página web de Webfig en vez de JSON'
        : `El router respondió con un Content-Type inesperado (${contentType || 'sin definir'})`,
      {
        status: 502,
        hint: 'La REST API no está habilitada o no es alcanzable en esa ruta. Habilitá el servicio "www" en /ip/service y verificá el puerto configurado para este router.',
        detalle: texto.slice(0, 300),
      },
    )
  }

  let datos
  try {
    datos = texto ? JSON.parse(texto) : null
  } catch {
    throw new AppError('El router devolvió JSON inválido', {
      status: 502,
      detalle: texto.slice(0, 300),
    })
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw new AppError('Usuario o contraseña incorrectos para el MikroTik', {
        status: 401,
        hint: 'Revisá las credenciales guardadas para este router.',
      })
    }
    throw new AppError(datos?.message || datos?.detail || `RouterOS devolvió ${res.status}`, {
      status: res.status === 404 ? 404 : 502,
      detalle: datos?.detail,
    })
  }

  return datos
}

function traducirErrorRed(err, router) {
  const nombre = err?.name
  if (nombre === 'TimeoutError' || nombre === 'AbortError') {
    return new AppError(`No hay respuesta de ${router.ip_host} en ${TIMEOUT_MS / 1000}s`, {
      status: 504,
      hint: 'El router no es alcanzable desde donde corre el middleware, o el puerto es incorrecto.',
    })
  }
  return new AppError(`No se pudo conectar con ${router.ip_host}: ${err?.message || err}`, {
    status: 502,
    hint: 'Verificá IP, puerto y que el servicio www/www-ssl esté habilitado en /ip/service.',
  })
}

// --- Salud -----------------------------------------------------------------

export async function probarConexion(router) {
  const identidad = await request(router, 'GET', '/system/identity')
  const recurso = await request(router, 'GET', '/system/resource').catch(() => null)
  return {
    ok: true,
    identidad: identidad?.name ?? null,
    version: recurso?.version ?? null,
    modelo: recurso?.['board-name'] ?? null,
    uptime: recurso?.uptime ?? null,
  }
}

// --- IP Pools --------------------------------------------------------------

export const listarPools = (router) => request(router, 'GET', '/ip/pool')

export const crearPool = (router, { name, ranges, comment }) =>
  request(router, 'PUT', '/ip/pool', { name, ranges, ...(comment ? { comment } : {}) })

export const borrarPool = (router, id) =>
  request(router, 'DELETE', `/ip/pool/${encodeURIComponent(id)}`)

// --- IP Addresses ----------------------------------------------------------

export const listarDirecciones = (router) => request(router, 'GET', '/ip/address')

export const crearDireccion = (router, { address, interface: iface, comment }) =>
  request(router, 'PUT', '/ip/address', {
    address,
    interface: iface,
    ...(comment ? { comment } : {}),
  })

export const borrarDireccion = (router, id) =>
  request(router, 'DELETE', `/ip/address/${encodeURIComponent(id)}`)

export const listarInterfaces = (router) => request(router, 'GET', '/interface')

// --- Bloqueos (corte de morosos) -------------------------------------------

export const listarBloqueos = (router, lista = LISTA_MOROSOS) =>
  request(router, 'GET', `/ip/firewall/address-list?list=${encodeURIComponent(lista)}`)

export const bloquearIp = (router, { address, comment, lista = LISTA_MOROSOS }) =>
  request(router, 'PUT', '/ip/firewall/address-list', {
    list: lista,
    address,
    ...(comment ? { comment } : {}),
  })

export const desbloquear = (router, id) =>
  request(router, 'DELETE', `/ip/firewall/address-list/${encodeURIComponent(id)}`)

export const listarReglasFilter = (router) => request(router, 'GET', '/ip/firewall/filter')

export const listarReglasNat = (router) => request(router, 'GET', '/ip/firewall/nat')

/**
 * Crea la regla de drop del corte de morosos, una sola vez.
 * Se identifica por el comment para poder detectar si ya existe y no duplicarla
 * en cada arranque del taller.
 */
export async function asegurarReglaCorte(router, lista = LISTA_MOROSOS) {
  const reglas = await listarReglasFilter(router)
  const nuestra = Array.isArray(reglas) ? reglas.find((r) => esNuestra(r.comment, 'corte')) : null
  if (nuestra) {
    // Ver el driver binario: el renombre se completa solo, equipo por equipo.
    if (hayQueRenombrar(nuestra.comment, 'corte')) {
      await request(router, 'PATCH', `/ip/firewall/filter/${encodeURIComponent(nuestra['.id'])}`, {
        comment: comentario('corte'),
      })
      return { creada: false, renombrada: true, mensaje: 'La regla de corte ya existía; se actualizó su nombre' }
    }
    return { creada: false, mensaje: 'La regla de corte ya existía' }
  }

  await request(router, 'PUT', '/ip/firewall/filter', {
    chain: 'forward',
    'src-address-list': lista,
    action: 'drop',
    comment: comentario('corte'),
  })
  return { creada: true, mensaje: 'Regla de corte creada' }
}

/**
 * Regla NAT que redirige el HTTP de los morosos a una página de aviso de pago.
 */
// =============================================================================
// IPv6 — el mismo corte, en el otro espacio de direcciones
// =============================================================================
//
// `/ip/firewall` y `/ipv6/firewall` son mundos separados en RouterOS: no
// comparten listas ni reglas. Sin esto, el moroso cortado en v4 sigue navegando
// por v6, que es por donde responden Google, YouTube y Netflix.
//
// Son reglas de capa 3: sirven igual para fibra y para radioenlace.

export const LISTA_MOROSOS_V6 = 'CORTE_MOROSOS_V6'

/** ¿Este equipo puede hablar IPv6? En RouterOS v6 el paquete viene apagado. */
export async function soportaIpv6(router) {
  try {
    await request(router, 'GET', '/ipv6/firewall/filter')
    return { disponible: true }
  } catch (err) {
    return {
      disponible: false,
      motivo: String(err?.message ?? err),
      sugerencia:
        'En RouterOS v6 el paquete ipv6 viene apagado: System → Packages → ipv6 → Enable y reiniciar.',
    }
  }
}

export const listarBloqueosIpv6 = (router, lista = LISTA_MOROSOS_V6) =>
  request(router, 'GET', `/ipv6/firewall/address-list?list=${encodeURIComponent(lista)}`)

export const bloquearIpv6 = (router, { address, comment, lista = LISTA_MOROSOS_V6 }) =>
  request(router, 'PUT', '/ipv6/firewall/address-list', { list: lista, address, comment })

export const desbloquearIpv6 = (router, id) =>
  request(router, 'DELETE', `/ipv6/firewall/address-list/${encodeURIComponent(id)}`)

export const listarReglasFilterIpv6 = (router) => request(router, 'GET', '/ipv6/firewall/filter')

/**
 * Las reglas de corte de v6. Son DOS, y las dos hacen falta.
 *
 * En IPv4, detrás del NAT, cortar lo que sale corta todo. En IPv6 no hay NAT y
 * cada dispositivo del cliente es alcanzable desde afuera: con una sola regla
 * sobre el origen, el cortado no navega pero sigue recibiendo conexiones y
 * contestándolas. Por eso también se corta lo que va HACIA su prefijo.
 */
export async function asegurarReglaCorteIpv6(router, lista = LISTA_MOROSOS_V6) {
  const reglas = await request(router, 'GET', '/ipv6/firewall/filter')
  const hechas = []

  for (const [clave, campo] of [
    ['corteV6Salida', 'src-address-list'],
    ['corteV6Entrada', 'dst-address-list'],
  ]) {
    const nuestra = Array.isArray(reglas) ? reglas.find((r) => esNuestra(r.comment, clave)) : null
    if (nuestra) {
      if (hayQueRenombrar(nuestra.comment, clave)) {
        await request(router, 'PATCH', `/ipv6/firewall/filter/${encodeURIComponent(nuestra['.id'])}`, {
          comment: comentario(clave),
        })
      }
      continue
    }
    await request(router, 'PUT', '/ipv6/firewall/filter', {
      chain: 'forward',
      [campo]: lista,
      action: 'drop',
      comment: comentario(clave),
    })
    hechas.push(comentario(clave))
  }

  return {
    creadas: hechas.length,
    mensaje: hechas.length
      ? `Se crearon ${hechas.length} regla(s) de corte IPv6`
      : 'Las reglas de corte IPv6 ya existían',
  }
}

export async function asegurarRedireccionPago(router, { destino, puerto = 80, lista = LISTA_MOROSOS }) {
  const reglas = await listarReglasNat(router)
  const nuestra = Array.isArray(reglas)
    ? reglas.find((r) => esNuestra(r.comment, 'redireccion'))
    : null
  if (nuestra) {
    if (hayQueRenombrar(nuestra.comment, 'redireccion')) {
      await request(router, 'PATCH', `/ip/firewall/nat/${encodeURIComponent(nuestra['.id'])}`, {
        comment: comentario('redireccion'),
      })
      return { creada: false, renombrada: true, mensaje: 'La redirección ya existía; se actualizó su nombre' }
    }
    return { creada: false, mensaje: 'La regla de redirección ya existía' }
  }

  await request(router, 'PUT', '/ip/firewall/nat', {
    chain: 'dstnat',
    protocol: 'tcp',
    'dst-port': '80',
    'src-address-list': lista,
    action: 'dst-nat',
    'to-addresses': destino,
    'to-ports': String(puerto),
    comment: comentario('redireccion'),
  })
  return { creada: true, mensaje: 'Regla de redirección de pago creada' }
}

/**
 * Simple Queue a partir de un plan de velocidad.
 * max-limit va en "subida/bajada" (upload/download desde la perspectiva del cliente).
 */
export const crearSimpleQueue = (router, { name, target, bajadaKbps, subidaKbps, comment }) =>
  request(router, 'PUT', '/queue/simple', {
    name,
    target,
    'max-limit': `${subidaKbps}k/${bajadaKbps}k`,
    ...(comment ? { comment } : {}),
  })

export const listarSimpleQueues = (router) => request(router, 'GET', '/queue/simple')

/**
 * Deja la Simple Queue del abonado con la velocidad que corresponde.
 *
 * Se busca por `target` y no por nombre: el objetivo es lo que decide a quién
 * limita la cola, mientras que el nombre es una etiqueta que alguien pudo haber
 * cambiado al corregir un apellido.
 */
/**
 * A quién limita la cola: la IPv4 y, si la hay, el prefijo IPv6.
 *
 * `target` acepta varias direcciones separadas por coma. Con las dos en la
 * misma cola el abonado tiene UN límite y no dos que se suman según por dónde
 * baje. Y evita el error de limitar solo v4 mientras el tráfico v6 —casi todo
 * YouTube y Netflix— pasa sin tope.
 */
export const objetivoDeCola = (ip, ipv6) =>
  [ip ? `${ip}/32` : null, ipv6 || null].filter(Boolean).join(',')

/** Ver el driver binario: el nombre de una Simple Queue es único en RouterOS. */
const esNombreRepetido = (err) => /already|such name|duplicate/i.test(err?.message ?? '')

export async function asegurarSimpleQueue(
  router,
  { nombre, nombreAlterno, ip, ipv6, comentario, campos = {} },
) {
  const colas = await listarSimpleQueues(router)
  const previas = (Array.isArray(colas) ? colas : []).filter((q) =>
    String(q.target ?? '')
      .split(',')
      .some((t) => t.trim().split('/')[0] === String(ip).trim()),
  )

  // Los campos de velocidad llegan ya traducidos (`camposDeCola`): el driver no
  // decide qué se aplica, solo lo escribe.
  const cuerpo = (comoSeLlama) => ({
    name: comoSeLlama,
    target: objetivoDeCola(ip, ipv6),
    ...campos,
    ...(comentario ? { comment: comentario } : {}),
  })

  // Si el nombre está tomado se reintenta con el alterno. Sin esto, el segundo
  // servicio de una misma persona se queda SIN COLA y nada lo explica.
  const escribir = async (metodo, ruta) => {
    try {
      await request(router, metodo, ruta, cuerpo(nombre))
      return { renombrada: false }
    } catch (err) {
      if (!nombreAlterno || !esNombreRepetido(err)) throw err
      await request(router, metodo, ruta, cuerpo(nombreAlterno))
      return { renombrada: true }
    }
  }

  if (previas.length) {
    const r = await escribir('PATCH', `/queue/simple/${encodeURIComponent(previas[0]['.id'])}`)
    return { creada: false, actualizada: true, duplicadas: previas.length - 1, ...r }
  }

  const r = await escribir('PUT', '/queue/simple')
  return { creada: true, actualizada: false, duplicadas: 0, ...r }
}

// --- Fuentes para importar clientes -----------------------------------------

export const listarPppSecrets = (router) => request(router, 'GET', '/ppp/secret')

/**
 * Los perfiles PPP del equipo.
 *
 * En PPPoE la velocidad la aplica el perfil, no una cola: es el dato que hay
 * que elegir al configurar un plan, y tiene que salir del router —el nombre se
 * escribe exacto o no aplica nada—.
 */
export const listarPppProfiles = (router) => request(router, 'GET', '/ppp/profile')

/**
 * Deja el perfil PPP de un plan como tiene que quedar en el equipo.
 *
 * `rateLimit` vacío significa **sin límite**, que es lo que corresponde en
 * FTTH: el caudal lo controla la traffic table de la OLT y un límite acá
 * pelearía con ella. Por eso el campo viaja siempre, incluso vacío — omitirlo
 * dejaría el valor de un plan anterior.
 */
export async function asegurarPppProfile(router, { nombre, rateLimit = '', comentario, pool, localAddress }) {
  const perfiles = await listarPppProfiles(router)
  const previos = (Array.isArray(perfiles) ? perfiles : []).filter((p) => p.name === nombre)


  const cuerpo = {
    name: nombre,
    'rate-limit': rateLimit ?? '',
    ...(pool ? { 'remote-address': pool } : {}),
    // La puerta de enlace que recibe el abonado. Sin ella autentica y queda sin
    // salida, y el fallo aparece recién cuando el cliente llama.
    ...(localAddress ? { 'local-address': localAddress } : {}),
    ...(comentario ? { comment: comentario } : {}),
  }

  if (previos.length) {
    if (previos[0].default === 'true' || previos[0].default === true) {
      throw new AppError(`"${nombre}" es un perfil por defecto de RouterOS y no se modifica`, {
        status: 400,
        hint: 'Usá un nombre propio para el plan, distinto de default y default-encryption.',
      })
    }
    await request(router, 'PATCH', `/ppp/profile/${encodeURIComponent(previos[0]['.id'])}`, cuerpo)
    return { creado: false, actualizado: true, nombre, rate_limit: rateLimit ?? '' }
  }

  await request(router, 'PUT', '/ppp/profile', cuerpo)
  return { creado: true, actualizado: false, nombre, rate_limit: rateLimit ?? '' }
}
export const listarPppActive = (router) => request(router, 'GET', '/ppp/active')
export const listarDhcpLeases = (router) => request(router, 'GET', '/ip/dhcp-server/lease')
export const listarTodasLasEntradas = (router) =>
  request(router, 'GET', '/ip/firewall/address-list')

/**
 * Carga de CPU, memoria y disco del router.
 *
 * Un CCR al 95% de CPU contesta los pings perfecto y le está cortando el
 * tráfico a todos: es la falla que se busca cuando "anda lento" y todo lo demás
 * da bien.
 */
export async function leerRecursos(router) {
  const recurso = await request(router, 'GET', '/system/resource')
  return Array.isArray(recurso) ? (recurso[0] ?? null) : (recurso ?? null)
}

// --- Alta de un abonado nuevo ------------------------------------------------

/**
 * Quién está asociado a la radio, con su señal y su CCQ.
 *
 * RouterOS v7 tiene dos pilas de wireless según el modelo y el paquete
 * instalado: la clásica en `/interface/wireless` y wifiwave2 en
 * `/interface/wifi`. Cuál está no se puede deducir de la versión, así que se
 * prueban las dos y se devuelve la que conteste. La segunda solo se intenta si
 * la primera dijo 404: un timeout significa que el router no está, y volver a
 * pegarle sería esperar el doble para el mismo error.
 */
export async function listarRegistroWireless(router) {
  try {
    return await request(router, 'GET', '/interface/wireless/registration-table')
  } catch (err) {
    if (err?.status !== 404) throw err
    return request(router, 'GET', '/interface/wifi/registration-table')
  }
}

/** El secret PPPoE de un usuario, o null si todavía no existe. */
export async function buscarPppSecret(router, usuario) {
  const secrets = await listarPppSecrets(router)
  return (Array.isArray(secrets) ? secrets : []).find((s) => s.name === usuario) ?? null
}

/**
 * Deja el secret PPPoE del abonado como tiene que quedar.
 *
 * Si ya existe se modifica en vez de crear otro: en un alta que se reintenta
 * —el técnico perdió señal y volvió a apretar— un PUT daría "already have such
 * name" y dejaría el trabajo trabado con el equipo ya instalado.
 */
export async function asegurarPppSecret(router, { usuario, clave, perfil, ip, comentario }) {
  const cuerpo = {
    name: usuario,
    password: clave,
    service: 'pppoe',
    ...(perfil ? { profile: perfil } : {}),
    ...(ip ? { 'remote-address': ip } : {}),
    ...(comentario ? { comment: comentario } : {}),
  }

  const previo = await buscarPppSecret(router, usuario)
  if (previo) {
    await request(router, 'PATCH', `/ppp/secret/${encodeURIComponent(previo['.id'])}`, cuerpo)
    return { creado: false, actualizado: true, usuario }
  }

  await request(router, 'PUT', '/ppp/secret', cuerpo)
  return { creado: true, actualizado: false, usuario }
}

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
/** Los servidores PPPoE y sobre qué interfaz escucha cada uno. */
export const listarPppoeServers = (router) =>
  request(router, 'GET', '/interface/pppoe-server/server')

/** Las interfaces VLAN del router. */
export const listarInterfacesVlan = (router) => request(router, 'GET', '/interface/vlan')

export async function borrarPppSecret(router, usuario) {
  const previo = await buscarPppSecret(router, usuario)
  if (!previo) return { borrado: false, motivo: 'no existía', usuario }

  await request(router, 'DELETE', `/ppp/secret/${encodeURIComponent(previo['.id'])}`)
  return { borrado: true, usuario }
}

/**
 * Reserva fija por DHCP: al equipo con esa MAC siempre le toca esa IP.
 *
 * Es lo que hace que un "DHCP" se comporte como IP fija sin tener que
 * configurar nada en el equipo del cliente, que es justamente lo que no se
 * puede hacer cuando el router lo pone el abonado.
 */
export async function asegurarLeaseFija(router, { ip, mac, servidor, comentario }) {
  const leases = await listarDhcpLeases(router)
  const previo = (Array.isArray(leases) ? leases : []).find(
    (l) => String(l['mac-address']).toUpperCase() === String(mac).toUpperCase(),
  )

  const cuerpo = {
    address: ip,
    'mac-address': String(mac).toUpperCase(),
    ...(servidor ? { server: servidor } : {}),
    ...(comentario ? { comment: comentario } : {}),
  }

  if (previo) {
    // Una lease dinámica es la que el servidor repartió sola: no se puede
    // editar hasta convertirla en estática, y sin eso el equipo vuelve a tomar
    // otra IP en la próxima renovación.
    if (previo.dynamic === 'true' || previo.dynamic === true) {
      await request(router, 'POST', '/ip/dhcp-server/lease/make-static', {
        numbers: previo['.id'],
      })
    }
    await request(router, 'PATCH', `/ip/dhcp-server/lease/${encodeURIComponent(previo['.id'])}`, cuerpo)
    return { creada: false, actualizada: true, ip }
  }

  await request(router, 'PUT', '/ip/dhcp-server/lease', cuerpo)
  return { creada: true, actualizada: false, ip }
}

/** Crea colas o secrets para los clientes del sistema. Saltea lo que ya existe. */
export async function exportarClientes(router, { clientes, modo = 'simple-queue' }) {
  const creados = []
  const salteados = []
  const fallidos = []

  if (modo === 'ppp-secret') {
    const previos = await listarPppSecrets(router)
    const existentes = new Set((Array.isArray(previos) ? previos : []).map((s) => s.name))

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
        await request(router, 'PUT', '/ppp/secret', {
          name: c.usuario_ppp,
          password: c.password_ppp ?? c.usuario_ppp,
          service: 'pppoe',
          ...(c.ip ? { 'remote-address': c.ip } : {}),
          comment: c.nombre,
        })
        creados.push(c.usuario_ppp)
      } catch (err) {
        fallidos.push({ nombre: c.nombre, error: String(err?.message ?? err) })
      }
    }
    return { modo, creados, salteados, fallidos }
  }

  const colas = await listarSimpleQueues(router)
  const previas = Array.isArray(colas) ? colas : []
  const nombresUsados = new Set(previas.map((q) => q.name))
  const targetsUsados = new Set(previas.map((q) => q.target))

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
      await request(router, 'PUT', '/queue/simple', {
        name: c.nombre,
        target,
        'max-limit': c.velocidad_cruda,
        comment: c.comentario ?? MARCA,
      })
      creados.push(c.nombre)
    } catch (err) {
      fallidos.push({ nombre: c.nombre, error: String(err?.message ?? err) })
    }
  }

  return { modo, creados, salteados, fallidos }
}

/** Aplica un plan de sincronización de morosos sobre el address-list. */
export async function aplicarSincronizacion(router, { lista, agregar = [], quitar = [] }) {
  const agregadas = []
  const quitadas = []
  const fallidas = []

  for (const a of agregar) {
    try {
      await request(router, 'PUT', '/ip/firewall/address-list', {
        list: lista,
        address: a.address,
        comment: a.comment ?? a.nombre,
      })
      agregadas.push(a.address)
    } catch (err) {
      fallidas.push({ address: a.address, accion: 'agregar', error: String(err?.message ?? err) })
    }
  }

  if (quitar.length) {
    const actuales = await listarTodasLasEntradas(router)
    const porDireccion = new Map(
      (Array.isArray(actuales) ? actuales : [])
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
        await request(router, 'DELETE', `/ip/firewall/address-list/${encodeURIComponent(id)}`)
        quitadas.push(q.address)
      } catch (err) {
        fallidas.push({ address: q.address, accion: 'quitar', error: String(err?.message ?? err) })
      }
    }
  }

  return { lista, agregadas, quitadas, fallidas }
}

/** Copia las entradas de una address-list a otra. Saltea las ya existentes. */
export async function copiarLista(router, { origen, destino }) {
  const todas = await listarTodasLasEntradas(router)
  const lista = Array.isArray(todas) ? todas : []

  const aCopiar = lista.filter((e) => e.list === origen)
  const yaEstan = new Set(lista.filter((e) => e.list === destino).map((e) => e.address))

  const copiadas = []
  const salteadas = []
  const fallidas = []

  for (const entrada of aCopiar) {
    if (yaEstan.has(entrada.address)) {
      salteadas.push(entrada.address)
      continue
    }
    try {
      await request(router, 'PUT', '/ip/firewall/address-list', {
        list: destino,
        address: entrada.address,
        comment: entrada.comment ?? `Migrado de ${origen}`,
      })
      copiadas.push(entrada.address)
    } catch (err) {
      fallidas.push({ address: entrada.address, error: String(err?.message ?? err) })
    }
  }

  return { origen, destino, encontradas: aCopiar.length, copiadas, salteadas, fallidas }
}

/**
 * Trae todo lo necesario para un escaneo.
 * Cada fuente falla por separado: un router puede no usar PPPoE, o no tener
 * servidor DHCP, y eso no debe arruinar el resto del escaneo.
 */
export async function escanear(router) {
  const intentar = async (etiqueta, ruta) => {
    try {
      const r = await request(router, 'GET', ruta)
      return Array.isArray(r) ? r : []
    } catch (err) {
      console.warn(`[escaneo] ${etiqueta} no disponible: ${err?.message ?? err}`)
      return []
    }
  }

  return {
    pppSecrets: await intentar('ppp secrets', '/ppp/secret'),
    pppActive: await intentar('ppp active', '/ppp/active'),
    simpleQueues: await intentar('simple queues', '/queue/simple'),
    dhcpLeases: await intentar('dhcp leases', '/ip/dhcp-server/lease'),
    addressList: await intentar('address lists', '/ip/firewall/address-list'),
  }
}

// =============================================================================
// El servicio de API, restringido a la red de gestión
// =============================================================================
//
// Mismo contrato que en el driver binario. Ver el comentario largo de allá: las
// dos capas —firewall y `/ip/service`— y por qué se vuelve a leer después de
// escribir.

function servicioDe(servicios, router) {
  const puerto = Number(router.puerto_api)
  return (
    servicios.find((s) => Number(s.port) === puerto && /^api/.test(s.name ?? '')) ??
    servicios.find((s) => s.name === (puerto === 8729 ? 'api-ssl' : 'api'))
  )
}

const redesDe = (servicio) =>
  String(servicio?.address ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x, i, todas) => todas.indexOf(x) === i)

export async function leerServicioApi(router) {
  const servicios = await request(router, 'GET', '/ip/service')
  const s = servicioDe(servicios ?? [], router)
  if (!s) return { encontrado: false }

  return {
    encontrado: true,
    nombre: s.name,
    puerto: Number(s.port),
    deshabilitado: s.disabled === 'true' || s.disabled === true,
    redes: redesDe(s),
  }
}

export async function asegurarApiPermitida(router, { red, forzar = false }) {
  if (!red) throw new Error('Falta la red de gestión')

  const servicios = await request(router, 'GET', '/ip/service')
  const s = servicioDe(servicios ?? [], router)
  if (!s) return { cambiada: false, estado: 'sin-servicio' }

  const antes = redesDe(s)

  if (!antes.length && !forzar) return { cambiada: false, estado: 'abierta', antes, despues: antes }
  if (antes.includes(red)) return { cambiada: false, estado: 'ya-estaba', antes, despues: antes }

  const despues = [...antes, red]
  await request(router, 'PATCH', `/ip/service/${encodeURIComponent(s['.id'])}`, {
    address: despues.join(','),
  })

  const confirmado = redesDe(servicioDe((await request(router, 'GET', '/ip/service')) ?? [], router))

  return {
    cambiada: true,
    estado: confirmado.includes(red) ? 'agregada' : 'no-aplico',
    antes,
    despues: confirmado,
  }
}
