/**
 * MODO DEMO — se activa con VITE_DEMO_MODE=true en web/.env
 *
 * Sirve para recorrer la interfaz sin Supabase ni equipos de red: reemplaza la
 * capa de datos por un store en memoria y las llamadas al middleware por
 * respuestas de ejemplo.
 *
 * Todo lo que se cree se pierde al recargar la página. No es un entorno de
 * pruebas: es una maqueta navegable para ver el frontend.
 */

export const modoDemo = import.meta.env.VITE_DEMO_MODE === 'true'

const uid = () => crypto.randomUUID()

const ID_OLT_HUAWEI = uid()
const ID_OLT_VSOL = uid()
const ID_ROUTER = uid()
const ID_PLAN_100 = uid()
const ID_PLAN_50 = uid()
const ID_PERFIL_100 = uid()

const ahora = () => new Date().toISOString()
const haceMinutos = (m) => new Date(Date.now() - m * 60000).toISOString()

/** Datos de ejemplo, uno por tabla del schema. */
const SEMILLA = {
  olts: [
    {
      id: ID_OLT_HUAWEI,
      nombre: 'OLT Central',
      marca: 'Huawei',
      ip_host: '192.168.1.10',
      puerto_ssh: 22,
      usuario: 'root',
      password_encrypted: 'demo',
      activo: true,
      created_at: haceMinutos(4000),
    },
    {
      id: ID_OLT_VSOL,
      nombre: 'OLT Barrio Norte',
      marca: 'VSOL',
      ip_host: '192.168.1.20',
      puerto_ssh: 22,
      usuario: 'admin',
      password_encrypted: 'demo',
      activo: true,
      created_at: haceMinutos(3000),
    },
  ],

  routers_mikrotik: [
    {
      id: ID_ROUTER,
      nombre: 'Router Borde',
      ip_host: '192.168.88.1',
      puerto_api: 80,
      usa_https: false,
      usuario: 'admin',
      password_encrypted: 'demo',
      activo: true,
      created_at: haceMinutos(3500),
    },
  ],

  tipos_ont: [
    { id: uid(), marca: 'Huawei', modelo: 'HG8310M', puertos_ethernet: 1, puertos_fxs: 0, wifi: false, created_at: haceMinutos(5000) },
    { id: uid(), marca: 'Huawei', modelo: 'HG8546M', puertos_ethernet: 4, puertos_fxs: 1, wifi: true, created_at: haceMinutos(5000) },
    { id: uid(), marca: 'V-SOL', modelo: 'V2801RH', puertos_ethernet: 1, puertos_fxs: 0, wifi: false, created_at: haceMinutos(5000) },
    { id: uid(), marca: 'V-SOL', modelo: 'V2802RGW', puertos_ethernet: 4, puertos_fxs: 1, wifi: true, created_at: haceMinutos(5000) },
  ],

  line_profiles: [
    { id: ID_PERFIL_100, olt_id: ID_OLT_HUAWEI, nombre: 'PROFILE_VLAN100', vlan_id: 100, gemport_id: 1, profile_id_olt: 100, created_at: haceMinutos(2000) },
    { id: uid(), olt_id: ID_OLT_HUAWEI, nombre: 'PROFILE_VLAN200', vlan_id: 200, gemport_id: 1, profile_id_olt: 200, created_at: haceMinutos(1900) },
  ],

  planes_velocidad: [
    { id: uid(), nombre: 'PLAN_30M', bajada_kbps: 30000, subida_kbps: 15000, burst_limit: null, precio: 18, traffic_table_index: 30, created_at: haceMinutos(5000) },
    { id: ID_PLAN_50, nombre: 'PLAN_50M', bajada_kbps: 50000, subida_kbps: 25000, burst_limit: '60M/30M', precio: 25, traffic_table_index: 50, created_at: haceMinutos(5000) },
    { id: ID_PLAN_100, nombre: 'PLAN_100M', bajada_kbps: 102400, subida_kbps: 10240, burst_limit: '120M/60M', precio: 35, traffic_table_index: 10, created_at: haceMinutos(5000) },
  ],

  onus: [
    {
      id: uid(), olt_id: ID_OLT_HUAWEI, sn: '485754431A2B3C4D', nombre_cliente: 'Juan Pérez',
      frame: 0, slot: 1, puerto: 0, onu_index: 0, plan_id: ID_PLAN_100, plan_velocidad: 'PLAN_100M',
      line_profile_id: ID_PERFIL_100, estado: 'online', rx_power_dbm: -21.4, tx_power_dbm: 2.31,
      distancia_m: 1240, ultima_lectura: haceMinutos(6), created_at: haceMinutos(1200),
    },
    {
      id: uid(), olt_id: ID_OLT_HUAWEI, sn: '48575443AABBCCDD', nombre_cliente: 'Panadería La Esquina',
      frame: 0, slot: 1, puerto: 0, onu_index: 1, plan_id: ID_PLAN_50, plan_velocidad: 'PLAN_50M',
      line_profile_id: ID_PERFIL_100, estado: 'online', rx_power_dbm: -28.9, tx_power_dbm: 2.05,
      distancia_m: 3870, ultima_lectura: haceMinutos(4), created_at: haceMinutos(900),
    },
    {
      id: uid(), olt_id: ID_OLT_HUAWEI, sn: '4857544311223344', nombre_cliente: 'María Gómez',
      frame: 0, slot: 1, puerto: 1, onu_index: 0, plan_id: ID_PLAN_50, plan_velocidad: 'PLAN_50M',
      estado: 'offline', rx_power_dbm: null, tx_power_dbm: null, distancia_m: null,
      ultima_lectura: null, created_at: haceMinutos(600),
    },
    {
      id: uid(), olt_id: ID_OLT_VSOL, sn: 'GPON00112233', nombre_cliente: 'Kiosco Central',
      frame: 0, slot: 0, puerto: 1, onu_index: 18, plan_id: null, plan_velocidad: 'PLAN_30M',
      estado: 'los', rx_power_dbm: -30.2, tx_power_dbm: null, distancia_m: 1,
      ultima_lectura: haceMinutos(30), created_at: haceMinutos(300),
    },
  ],

  ip_addresses: [],
  firewall_bloqueos: [],

  clientes: [
    {
      id: uid(), router_id: ID_ROUTER, nombre: 'Juan Pérez', ip: '10.0.0.5',
      usuario_ppp: 'jperez', velocidad_cruda: '25M/50M', estado: 'activo',
      origen: 'ppp-secret', mac_address: 'AA:BB:CC:DD:EE:FF', created_at: haceMinutos(1200),
    },
    {
      id: uid(), router_id: ID_ROUTER, nombre: 'Panadería La Esquina', ip: '10.0.0.7',
      usuario_ppp: null, velocidad_cruda: '10M/20M', estado: 'cortado',
      origen: 'simple-queue', comentario: 'Factura 0234 vencida', created_at: haceMinutos(900),
    },
    {
      id: uid(), router_id: ID_ROUTER, nombre: 'María Gómez', ip: '10.0.0.12',
      usuario_ppp: 'mgomez', velocidad_cruda: '25M/50M', estado: 'activo',
      origen: 'ppp-secret', created_at: haceMinutos(600),
    },
  ],
}

// Copia mutable: la semilla queda intacta para poder resetear.
let store = estructuraInicial()

function estructuraInicial() {
  return JSON.parse(JSON.stringify(SEMILLA))
}

export function resetDemo() {
  store = estructuraInicial()
}

// --- Capa de datos (reemplaza a Supabase) -----------------------------------

const esperar = (ms = 180) => new Promise((r) => setTimeout(r, ms))

export const demoDb = {
  async listar(tabla, { orderBy, ascending }) {
    await esperar()
    const filas = [...(store[tabla] ?? [])]
    if (orderBy) {
      filas.sort((a, b) => {
        const x = a[orderBy], y = b[orderBy]
        if (x === y) return 0
        const menor = x == null ? true : y == null ? false : x < y
        return (menor ? -1 : 1) * (ascending ? 1 : -1)
      })
    }
    return filas
  },

  async insertar(tabla, fila) {
    await esperar()
    const nueva = { id: uid(), created_at: ahora(), ...fila }
    store[tabla] = [...(store[tabla] ?? []), nueva]
    return nueva
  },

  async actualizar(tabla, id, cambios) {
    await esperar()
    store[tabla] = (store[tabla] ?? []).map((f) => (f.id === id ? { ...f, ...cambios } : f))
  },

  async eliminar(tabla, id) {
    await esperar()
    store[tabla] = (store[tabla] ?? []).filter((f) => f.id !== id)
  },
}

// --- Capa de red (reemplaza al middleware) ----------------------------------

const ONUS_PUERTO = [
  { ontId: 0, onuIndex: 0, sn: '485754431A2B3C4D', estado: 'online', runState: 'online', descripcion: 'Juan Pérez', modelo: 'HG8310M' },
  { ontId: 1, onuIndex: 1, sn: '48575443AABBCCDD', estado: 'online', runState: 'online', descripcion: 'Panadería La Esquina', modelo: 'HG8546M' },
  { ontId: 2, onuIndex: 2, sn: '4857544311223344', estado: 'offline', runState: 'offline', descripcion: 'María Gómez', modelo: 'HG8310M' },
]

const AUTOFIND = [
  { sn: '485754439ABCDEF0', puerto: 0, equipmentId: 'HG8546M', vendorId: 'HWTC' },
  { sn: '4857544355667788', puerto: 1, equipmentId: 'HG8310M', vendorId: 'HWTC' },
]

const POOLS = [
  { '.id': '*1', name: 'pool-clientes', ranges: '10.0.0.10-10.0.0.254', comment: 'PPPoE' },
  { '.id': '*2', name: 'pool-gestion', ranges: '172.16.0.10-172.16.0.50', comment: '' },
]

const ADDRESSES = [
  { '.id': '*1', address: '10.0.0.1/24', network: '10.0.0.0', interface: 'ether2', comment: 'Gateway clientes' },
  { '.id': '*2', address: '192.168.88.1/24', network: '192.168.88.0', interface: 'ether1', comment: '' },
]

const INTERFACES = [
  { id: '*1', nombre: 'ether1', tipo: 'ether', running: true, disabled: false },
  { id: '*2', nombre: 'ether2', tipo: 'ether', running: true, disabled: false },
  { id: '*3', nombre: 'vlan100', tipo: 'vlan', running: true, disabled: false },
]

let bloqueosDemo = [
  { id: '*5', address: '10.0.0.55', lista: 'CORTE_MOROSOS', comment: 'Factura 0234 vencida', dynamic: false },
]

/**
 * Enruta la llamada a una respuesta de ejemplo. Devuelve `undefined` si la ruta
 * no está contemplada, para que el cliente avise en vez de fingir un éxito.
 */
export async function demoApi(metodo, ruta, body) {
  await esperar(320)

  if (ruta === '/api/health') return { ok: true, servicio: 'demo', configuracionFaltante: [] }
  if (ruta.startsWith('/api/crypto/encrypt')) return { encrypted: 'v1:demo:demo:demo' }

  // --- OLT ---
  if (/\/api\/olt\/[^/]+\/test/.test(ruta)) {
    return { ok: true, marca: 'Huawei', modelo: 'MA5800-X7', version: 'V100R019C10' }
  }
  if (/\/api\/olt\/[^/]+\/autofind/.test(ruta)) return AUTOFIND
  if (/\/api\/olt\/[^/]+\/onus\/\d+\/metricas/.test(ruta)) {
    const rx = -21.4 + (Math.random() * 2 - 1)
    return {
      online: true,
      rxPowerDbm: Number(rx.toFixed(2)),
      txPowerDbm: 2.31,
      temperaturaC: 47,
      voltajeV: 3.28,
      distanciaM: 1240,
      version: { modelo: 'HG8310M', versionSoftware: 'V5R020C10S115' },
      umbralDbm: -27,
      alerta: rx < -27,
    }
  }
  if (/\/api\/olt\/[^/]+\/onus$/.test(ruta) && metodo === 'GET') return ONUS_PUERTO
  if (/\/api\/olt\/[^/]+\/onus$/.test(ruta) && metodo === 'POST') {
    return {
      ok: true,
      registradaEnOlt: { ontId: 3, onuIndex: 3, comando: 'ont add 0 3 sn-auth 485754439ABCDEF0 omci' },
      guardadaEnBase: true,
    }
  }
  if (/\/api\/olt\/[^/]+\/onus\/servicio/.test(ruta)) {
    return {
      ok: true,
      comandos: ['onu 3 tcont 1', 'onu 3 gemport 1 tcont 1', 'onu 3 service-port 1 gemport 1 uservlan 100 vlan 100'],
      advertencia: 'Si este tcont era nuevo en el puerto, el puerto PON pudo caer unos segundos.',
    }
  }
  if (/\/api\/olt\/[^/]+\/onus\/\d+$/.test(ruta) && metodo === 'DELETE') return { ok: true }
  if (/\/api\/olt\/[^/]+\/line-profiles/.test(ruta)) {
    return {
      ok: true,
      creadoEnOlt: { comandos: ['ont-lineprofile gpon profile-name "PROFILE_VLAN300"', 'vlan-map 1 300', 'commit', 'quit'] },
    }
  }
  if (/\/api\/olt\/[^/]+\/traffic-tables/.test(ruta)) {
    return { ok: true, comando: 'traffic table ip index 10 name "PLAN_100M" cir 10240 pir 102400 priority 6' }
  }

  // --- MikroTik ---
  if (/\/api\/mikrotik\/[^/]+\/test/.test(ruta)) {
    return { ok: true, identidad: 'RouterBorde', version: '7.16.1', modelo: 'RB4011iGS+', uptime: '12d04:31:07' }
  }
  if (/\/api\/mikrotik\/[^/]+\/pools/.test(ruta)) {
    if (metodo === 'POST') return { ok: true, pools: POOLS }
    if (metodo === 'DELETE') return { ok: true }
    return POOLS
  }
  if (/\/api\/mikrotik\/[^/]+\/interfaces/.test(ruta)) return INTERFACES
  if (/\/api\/mikrotik\/[^/]+\/addresses/.test(ruta)) {
    if (metodo === 'POST') return { ok: true, addresses: ADDRESSES }
    if (metodo === 'DELETE') return { ok: true }
    return ADDRESSES
  }
  if (/\/api\/mikrotik\/[^/]+\/bloqueos/.test(ruta)) {
    if (metodo === 'POST') return { ok: true, regla: { creada: false, mensaje: 'La regla de corte ya existía' } }
    if (metodo === 'DELETE') {
      bloqueosDemo = bloqueosDemo.slice(1)
      return { ok: true }
    }
    return bloqueosDemo
  }
  if (/\/api\/mikrotik\/[^/]+\/redireccion-pago/.test(ruta)) {
    return { creada: true, mensaje: 'Regla de redirección de pago creada' }
  }
  if (/\/api\/mikrotik\/[^/]+\/queues/.test(ruta)) return []

  // --- Importación de clientes ---
  if (/\/api\/mikrotik\/[^/]+\/escaneo/.test(ruta)) return ESCANEO_DEMO
  if (/\/api\/mikrotik\/[^/]+\/importar/.test(ruta)) {
    return { ok: true, creados: 3, actualizados: 1 }
  }
  if (/\/api\/mikrotik\/[^/]+\/exportar/.test(ruta)) {
    return {
      modo: 'simple-queue',
      creados: ['Juan Pérez', 'María Gómez'],
      salteados: ['Panadería La Esquina'],
      fallidos: [{ nombre: 'Kiosco Central', error: 'no tiene IP' }],
    }
  }
  if (/\/api\/mikrotik\/[^/]+\/sincronizar-morosos/.test(ruta)) {
    const plan = {
      lista: 'CORTE_MOROSOS',
      agregar: [{ address: '10.0.0.7', nombre: 'Panadería La Esquina', comment: 'Panadería La Esquina' }],
      quitar: [
        { address: '10.0.0.12', nombre: 'María Gómez', motivo: 'el cliente figura como "activo" en el sistema', conocido: true },
        { address: '192.168.99.4', nombre: null, motivo: 'no hay ningún cliente con esa IP en el sistema', conocido: false },
      ],
      sinIp: [{ nombre: 'Kiosco Central', motivo: 'el cliente no tiene IP registrada' }],
      yaCoinciden: 2,
      sinCambios: false,
    }
    if (!body?.aplicar) return { plan, aplicado: false }
    return {
      plan,
      aplicado: true,
      resultado: { lista: 'CORTE_MOROSOS', agregadas: ['10.0.0.7'], quitadas: ['10.0.0.12'], fallidas: [] },
      aviso: 'Se dejaron sin tocar 1 bloqueo(s) que no corresponden a ningún cliente del sistema.',
    }
  }
  if (/\/api\/mikrotik\/[^/]+\/migrar-lista/.test(ruta)) {
    return {
      origen: 'Moroso',
      destino: 'CORTE_MOROSOS',
      encontradas: 4,
      copiadas: ['10.0.0.7', '10.0.0.31', '10.0.0.44'],
      salteadas: ['10.0.0.55'],
      fallidas: [],
      guardadoEnBase: true,
    }
  }

  return undefined
}

/** Resultado de escaneo de ejemplo, con los casos que vale la pena mostrar. */
const ESCANEO_DEMO = {
  listaMorosos: 'Moroso',
  clientes: [
    { nombre: 'Juan Pérez', ip: '10.0.0.5', usuario_ppp: 'jperez', mac_address: 'AA:BB:CC:DD:EE:FF', velocidad_cruda: '25M/50M', estado: 'activo', origen: 'ppp-secret', origenes: ['ppp-secret', 'simple-queue', 'dhcp-lease'] },
    { nombre: 'Panadería La Esquina', ip: '10.0.0.7', usuario_ppp: null, velocidad_cruda: '10M/20M', estado: 'cortado', origen: 'simple-queue', origenes: ['simple-queue', 'address-list'] },
    { nombre: 'María Gómez', ip: '10.0.0.12', usuario_ppp: 'mgomez', velocidad_cruda: '25M/50M', estado: 'activo', origen: 'ppp-secret', origenes: ['ppp-secret'] },
    { nombre: 'Carlos Ruiz', ip: '10.0.0.31', usuario_ppp: 'cruiz', velocidad_cruda: '10M/20M', estado: 'cortado', origen: 'ppp-secret', origenes: ['ppp-secret', 'address-list'] },
    // Sin IP: PPPoE con dirección dinámica y sin sesión activa al escanear.
    { nombre: 'Kiosco Central', ip: null, usuario_ppp: 'kiosco', velocidad_cruda: null, estado: 'activo', origen: 'ppp-secret', origenes: ['ppp-secret'] },
    // Solo aparece en la lista de cortes: cliente viejo sin cola ni secret.
    { nombre: 'Cliente sin cola', ip: '10.0.0.44', usuario_ppp: null, velocidad_cruda: null, estado: 'cortado', origen: 'address-list', origenes: ['address-list'] },
    { nombre: 'Ferretería Sur', ip: '10.0.0.60', usuario_ppp: null, velocidad_cruda: '50M/100M', estado: 'suspendido', origen: 'simple-queue', origenes: ['simple-queue'] },
  ],
  listas: [
    { nombre: 'Moroso', cantidad: 4 },
    { nombre: 'servers_wisphub', cantidad: 6 },
    { nombre: 'permitidos', cantidad: 2 },
  ],
  resumen: {
    total: 7,
    cortados: 3,
    conVelocidad: 5,
    sinIp: 1,
    fuentes: { pppSecrets: 4, pppActive: 3, simpleQueues: 5, dhcpLeases: 8, addressList: 12 },
  },
}

/** Sesión falsa para poder entrar sin Supabase. */
export const usuarioDemo = {
  id: 'demo-user',
  email: 'demo@taller.local',
  app_metadata: {},
  user_metadata: {},
  aud: 'authenticated',
}

export const sesionDemo = {
  access_token: 'demo-token',
  token_type: 'bearer',
  user: usuarioDemo,
}
