/**
 * Convierte lo que se lee de un MikroTik en clientes del sistema.
 *
 * Al migrar desde otro sistema de gestión, los datos de los clientes están
 * repartidos por el router y ninguna fuente los tiene completos:
 *
 *   ppp secret    → usuario PPPoE, IP fija asignada, perfil
 *   simple queue  → nombre del cliente, IP objetivo, velocidad contratada
 *   dhcp lease    → MAC, IP, y el nombre suele estar en el comentario
 *   address-list  → quiénes están cortados
 *
 * El mismo cliente aparece en varias, así que hay que fusionarlas en vez de
 * importar cada una por separado — o quedan tres filas del mismo abonado.
 *
 * Todo acá es lógica pura, sin red ni base de datos, para poder probarlo.
 */

import { sinServicio } from '../lib/estados.js'

const RE_IP = /^(\d{1,3}\.){3}\d{1,3}$/

/** true si el texto es una IPv4 con octetos válidos. */
export function esIp(valor) {
  if (typeof valor !== 'string' || !RE_IP.test(valor)) return false
  return valor.split('.').every((o) => Number(o) <= 255)
}

/**
 * Saca la IP de un campo de RouterOS.
 * `target` de una simple queue puede venir como "10.0.0.5/32", como una lista
 * separada por comas, o directamente como el nombre de una interfaz.
 */
export function extraerIp(valor) {
  if (!valor || typeof valor !== 'string') return null
  for (const parte of valor.split(',')) {
    const sinMascara = parte.trim().split('/')[0]
    if (esIp(sinMascara)) return sinMascara
  }
  return null
}

/**
 * Saca el usuario PPPoE del nombre de una cola dinámica.
 *
 * Cuando un cliente se conecta por PPPoE, RouterOS le crea sola una cola
 * llamada `<pppoe-USUARIO>` cuyo target es la interfaz, no una IP. Sin esto,
 * esas colas se importaban como clientes sueltos llamados "<pppoe-0000000371>",
 * separados del abonado real que está en /ppp/active.
 */
export function usuarioDeColaPppoe(valor) {
  if (typeof valor !== 'string') return null
  const m = valor.match(/^<(?:pppoe|pptp|l2tp|ovpn|sstp)-(.+)>$/i)
  return m ? m[1] : null
}

/**
 * Pasa "50000000/50000000" a "50M/50M".
 *
 * RouterOS devuelve max-limit en bits por segundo. El valor crudo sigue siendo
 * válido para volver a escribirlo en el equipo, pero es ilegible en pantalla.
 */
export function formatearVelocidad(maxLimit) {
  const v = interpretarVelocidad(maxLimit)
  if (!v) return null
  const legible = (kbps) =>
    kbps >= 1000 && kbps % 1000 === 0 ? `${kbps / 1000}M` : `${kbps}k`
  return `${legible(v.subidaKbps)}/${legible(v.bajadaKbps)}`
}

/** Normaliza una MAC a mayúsculas con dos puntos. */
export function normalizarMac(valor) {
  if (typeof valor !== 'string') return null
  const limpia = valor.trim().toUpperCase().replace(/-/g, ':')
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(limpia) ? limpia : null
}

const esVerdadero = (v) => v === true || v === 'true' || v === 'yes'

/**
 * Convierte "50M/25M" al formato del sistema.
 * RouterOS escribe max-limit como subida/bajada.
 */
export function interpretarVelocidad(maxLimit) {
  if (typeof maxLimit !== 'string' || !maxLimit.includes('/')) return null

  const aKbps = (t) => {
    const m = t.trim().match(/^(\d+(?:\.\d+)?)\s*([kMG]?)/i)
    if (!m) return null
    const n = Number.parseFloat(m[1])
    const mult = { k: 1, m: 1000, g: 1000000, '': 1 / 1000 }[m[2].toLowerCase()]
    return Math.round(n * mult)
  }

  const [subida, bajada] = maxLimit.split('/')
  const s = aKbps(subida)
  const b = aKbps(bajada)
  if (s == null || b == null) return null

  return { subidaKbps: s, bajadaKbps: b, crudo: maxLimit }
}

/** Un nombre presentable, priorizando lo que más se parece al del abonado. */
function elegirNombre(...candidatos) {
  for (const c of candidatos) {
    if (typeof c === 'string' && c.trim() && c.trim() !== '-') return c.trim()
  }
  return null
}

/**
 * Fusiona los parciales en el acumulador.
 * La clave es la IP cuando existe, porque es lo único que comparten las cuatro
 * fuentes. Sin IP se cae al usuario PPPoE, y como último recurso al nombre.
 */
function fusionar(mapa, parcial) {
  const clave = parcial.ip ?? (parcial.usuario_ppp ? `ppp:${parcial.usuario_ppp}` : null) ??
    (parcial.nombre ? `nombre:${parcial.nombre.toLowerCase()}` : null)
  if (!clave) return

  const previo = mapa.get(clave) ?? { origenes: [] }

  mapa.set(clave, {
    ...previo,
    ...Object.fromEntries(Object.entries(parcial).filter(([, v]) => v != null && v !== '')),
    // El nombre del abonado suele estar mejor en la queue que en el lease.
    nombre: elegirNombre(previo.nombre, parcial.nombre),
    origenes: [...new Set([...previo.origenes, parcial.origen])].filter(Boolean),
  })
}

/**
 * Punto de entrada: escaneo crudo → clientes candidatos + resumen de listas.
 *
 * @param escaneo       lo que devuelve driver.escanear()
 * @param listaMorosos  nombre del address-list que marca a los cortados
 */
export const FUENTES = ['ppp-secret', 'simple-queue', 'dhcp-lease', 'address-list']

/**
 * Servicios de PPP que corresponden a abonados.
 *
 * Los secrets de l2tp, sstp y ovpn suelen ser accesos del personal o túneles de
 * gestión —en el router del taller había uno llamado "tecnico"—. Importarlos
 * como clientes ensucia el padrón.
 */
const ES_SERVICIO_CLIENTE = /^(pppoe|any)$/i

export function normalizarEscaneo(
  escaneo = {},
  { listaMorosos = 'CORTE_MOROSOS', fuentes = FUENTES } = {},
) {
  const usar = (f) => fuentes.includes(f)

  // Cada RB administra a sus clientes de una manera: unos con PPPoE, otros con
  // colas simples sobre IP fija. Poder elegir la fuente evita traer basura de
  // las que ese router no usa para clientes.
  const pppSecrets = usar('ppp-secret') ? (escaneo.pppSecrets ?? []) : []
  const pppActive = usar('ppp-secret') ? (escaneo.pppActive ?? []) : []
  const simpleQueues = usar('simple-queue') ? (escaneo.simpleQueues ?? []) : []
  const dhcpLeases = usar('dhcp-lease') ? (escaneo.dhcpLeases ?? []) : []
  // El address-list siempre se lee: es lo que marca a los cortados. Lo que
  // cambia es si además crea clientes por su cuenta.
  const addressList = escaneo.addressList ?? []
  const crearDesdeLista = usar('address-list')

  const mapa = new Map()
  // Cuentas que NO son abonados: túneles de gestión, accesos del personal.
  const noClientes = []

  // Las IPs de los activos se indexan ANTES de procesar los secrets.
  // Si no, un secret sin IP fija se guarda bajo la clave "ppp:usuario" y el
  // activo del mismo abonado bajo su IP: dos claves distintas, dos clientes
  // duplicados. Resolviendo la IP de entrada, los dos caen en la misma.
  const ipPorUsuario = new Map()
  for (const a of pppActive) {
    const ip = extraerIp(a.address)
    if (a.name && ip) ipPorUsuario.set(a.name, ip)
  }

  // El nombre real del abonado suele estar en el comentario de la sesión
  // activa, no en el del secret. Y el caller-id trae la MAC del equipo.
  const datosDeActivo = new Map()
  for (const a of pppActive) {
    if (!a.name) continue
    datosDeActivo.set(a.name, {
      nombre: elegirNombre(a.comment),
      mac: normalizarMac(a['caller-id']),
    })
  }

  // --- PPPoE secrets ---
  const usuariosVistos = new Set()
  for (const s of pppSecrets) {
    if (!s.name) continue
    // Los secrets de l2tp/sstp/ovpn son accesos de personal o túneles de
    // gestión, no abonados. Importarlos como clientes sería un error.
    if (s.service && !ES_SERVICIO_CLIENTE.test(s.service)) {
      noClientes.push({ nombre: s.name, servicio: s.service })
      continue
    }

    usuariosVistos.add(s.name)
    const activo = datosDeActivo.get(s.name)
    fusionar(mapa, {
      origen: 'ppp-secret',
      usuario_ppp: s.name,
      ip: extraerIp(s['remote-address']) ?? ipPorUsuario.get(s.name) ?? null,
      mac_address: activo?.mac ?? null,
      nombre: elegirNombre(activo?.nombre, s.comment, s.name),
      comentario: elegirNombre(activo?.nombre, s.comment),
      perfil: s.profile ?? null,
      deshabilitado: esVerdadero(s.disabled),
    })
  }

  // --- Activos sin secret: conexiones que no tienen usuario guardado ---
  for (const a of pppActive) {
    if (!a.name || usuariosVistos.has(a.name)) continue
    if (a.service && !ES_SERVICIO_CLIENTE.test(a.service)) continue
    fusionar(mapa, {
      origen: 'ppp-secret',
      usuario_ppp: a.name,
      ip: extraerIp(a.address),
      mac_address: normalizarMac(a['caller-id']),
      nombre: elegirNombre(a.comment, a.name),
      comentario: a.comment ?? null,
    })
  }

  // --- Simple queues: aportan la velocidad contratada ---
  for (const q of simpleQueues) {
    // Una cola de PPPoE apunta a la interfaz, no a una IP: el vínculo con el
    // cliente es el usuario que va en el nombre.
    const usuarioPppoe = usuarioDeColaPppoe(q.name) ?? usuarioDeColaPppoe(q.target)
    const ip = usuarioPppoe ? null : extraerIp(q.target)
    if (!ip && !usuarioPppoe) continue

    const vel = interpretarVelocidad(q['max-limit'])
    const activo = usuarioPppoe ? datosDeActivo.get(usuarioPppoe) : null

    fusionar(mapa, {
      origen: 'simple-queue',
      ip: ip ?? (usuarioPppoe ? (ipPorUsuario.get(usuarioPppoe) ?? null) : null),
      usuario_ppp: usuarioPppoe,
      mac_address: activo?.mac ?? null,
      // En una cola dinámica el "nombre" es <pppoe-usuario>: no sirve como
      // nombre de cliente. El del abonado viene de la sesión activa.
      nombre: usuarioPppoe
        ? elegirNombre(activo?.nombre, q.comment)
        : elegirNombre(q.comment, q.name),
      velocidad_cruda: q['max-limit'] ?? null,
      velocidad: formatearVelocidad(q['max-limit']),
      bajada_kbps: vel?.bajadaKbps ?? null,
      subida_kbps: vel?.subidaKbps ?? null,
      comentario: q.comment ?? null,
      deshabilitado: esVerdadero(q.disabled),
    })
  }

  // --- Leases DHCP: aportan MAC, y a veces el nombre ---
  for (const l of dhcpLeases) {
    const ip = extraerIp(l.address)
    if (!ip) continue
    fusionar(mapa, {
      origen: 'dhcp-lease',
      ip,
      mac_address: normalizarMac(l['mac-address']),
      nombre: elegirNombre(l.comment, l['host-name']),
      comentario: l.comment ?? null,
    })
  }

  // --- Address-lists: marcan quién está cortado ---
  const cortados = new Set(
    addressList
      .filter((e) => e.list === listaMorosos)
      .map((e) => extraerIp(e.address))
      .filter(Boolean),
  )

  if (crearDesdeLista) {
    for (const e of addressList) {
      const ip = extraerIp(e.address)
      if (!ip || e.list !== listaMorosos) continue
      // Un cortado que no aparece en ninguna otra fuente igual es un cliente.
      fusionar(mapa, {
        origen: 'address-list',
        ip,
        nombre: elegirNombre(e.comment),
        comentario: e.comment ?? null,
      })
    }
  }

  // El comentario de la lista de cortes a veces trae el código del abonado en
  // vez de una IP. Sirve para marcar como cortado a quien está desconectado y
  // por lo tanto no tiene IP activa.
  const usuariosCortados = new Set(
    addressList
      .filter((e) => e.list === listaMorosos && e.comment)
      .map((e) => String(e.comment).trim()),
  )

  const clientes = [...mapa.values()]
    .map((c) => {
      const cortado =
        (c.ip && cortados.has(c.ip)) || (c.usuario_ppp && usuariosCortados.has(c.usuario_ppp))

      return {
        nombre: c.nombre ?? c.usuario_ppp ?? c.ip,
        ip: c.ip ?? null,
        mac_address: c.mac_address ?? null,
        usuario_ppp: c.usuario_ppp ?? null,
        // El crudo sirve para volver a escribirlo en el equipo; el otro, para mostrar.
        velocidad_cruda: c.velocidad_cruda ?? null,
        velocidad: c.velocidad ?? c.velocidad_cruda ?? null,
        bajada_kbps: c.bajada_kbps ?? null,
        subida_kbps: c.subida_kbps ?? null,
        perfil: c.perfil ?? null,
        comentario: c.comentario ?? null,
        estado: cortado ? 'cortado' : c.deshabilitado ? 'suspendido' : 'activo',
        // El primero es el de mejor calidad para identificar al abonado.
        origen: c.origenes?.[0] ?? 'manual',
        origenes: c.origenes ?? [],
      }
    })
    .sort((a, b) => (a.nombre ?? '').localeCompare(b.nombre ?? ''))

  return {
    clientes,
    listas: resumirListas(addressList),
    noClientes,
    resumen: {
      total: clientes.length,
      cortados: clientes.filter((c) => c.estado === 'cortado').length,
      conVelocidad: clientes.filter((c) => c.velocidad_cruda).length,
      sinIp: clientes.filter((c) => !c.ip).length,
      descartados: noClientes.length,
      fuentes: {
        pppSecrets: pppSecrets.length,
        pppActive: pppActive.length,
        simpleQueues: simpleQueues.length,
        dhcpLeases: dhcpLeases.length,
        addressList: addressList.length,
      },
    },
  }
}

/** Qué address-lists existen y cuántas entradas tiene cada una. */
export function resumirListas(addressList = []) {
  const cuenta = new Map()
  for (const e of addressList) {
    if (!e.list) continue
    cuenta.set(e.list, (cuenta.get(e.list) ?? 0) + 1)
  }
  return [...cuenta.entries()]
    .map(([nombre, cantidad]) => ({ nombre, cantidad }))
    .sort((a, b) => b.cantidad - a.cantidad)
}

/** Direcciones de una lista, listas para copiarlas a otra. */
export function entradasDeLista(addressList = [], lista) {
  return addressList
    .filter((e) => e.list === lista)
    .map((e) => ({ address: e.address, comment: e.comment ?? null }))
    .filter((e) => e.address)
}

/**
 * Compara los clientes cortados del sistema con el address-list del router y
 * dice qué habría que cambiar para que coincidan.
 *
 * Devuelve un PLAN, no lo ejecuta. Quitar una dirección de la lista de cortes le
 * restaura el servicio a alguien: eso tiene que verse y confirmarse antes, no
 * pasar como efecto secundario de apretar "sincronizar".
 *
 * @param clientes  filas de la tabla clientes de este router
 * @param entradas  entradas del address-list del router (todas las listas)
 * @param lista     nombre del address-list de cortes
 */
export function planificarSincronizacion(clientes = [], entradas = [], lista) {
  const enLista = new Map()
  for (const e of entradas) {
    if (e.list !== lista) continue
    const ip = extraerIp(e.address)
    if (ip) enLista.set(ip, e)
  }

  const cortadosEnSistema = new Map()
  const sinIp = []
  for (const c of clientes) {
    // Igual que en reparar: suspendido también va a la lista de corte.
    if (!sinServicio(c.estado)) continue
    const ip = extraerIp(c.ip)
    // Sin IP no se puede cortar por address-list: hay que avisarlo, no ignorarlo.
    if (!ip) sinIp.push({ nombre: c.nombre, motivo: 'el cliente no tiene IP registrada' })
    else cortadosEnSistema.set(ip, c)
  }

  // Cortados en el sistema que el router todavía no bloquea.
  const agregar = []
  for (const [ip, c] of cortadosEnSistema) {
    if (!enLista.has(ip)) agregar.push({ address: ip, nombre: c.nombre, comment: c.nombre })
  }

  // Bloqueados en el router que en el sistema ya no están cortados.
  const quitar = []
  for (const [ip, e] of enLista) {
    const cliente = clientes.find((c) => extraerIp(c.ip) === ip)
    if (cortadosEnSistema.has(ip)) continue
    quitar.push({
      address: ip,
      id: e['.id'] ?? e.id ?? null,
      nombre: cliente?.nombre ?? null,
      // Distinguir "está activo" de "no lo conozco" importa: lo segundo puede
      // ser un bloqueo puesto a mano que no conviene deshacer a ciegas.
      motivo: cliente
        ? `el cliente figura como "${cliente.estado}" en el sistema`
        : 'no hay ningún cliente con esa IP en el sistema',
      conocido: Boolean(cliente),
    })
  }

  return {
    lista,
    agregar: agregar.sort((a, b) => a.address.localeCompare(b.address)),
    quitar: quitar.sort((a, b) => a.address.localeCompare(b.address)),
    sinIp,
    yaCoinciden: [...cortadosEnSistema.keys()].filter((ip) => enLista.has(ip)).length,
    sinCambios: agregar.length === 0 && quitar.length === 0,
  }
}
