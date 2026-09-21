import * as binaria from '../drivers/mikrotikApi.js'
import * as rest from '../drivers/mikrotik.js'

/**
 * Elige cómo hablarle a cada MikroTik.
 *
 *   'binaria'  API de RouterOS en 8728 / 8729-TLS. Es la forma habitual en un
 *              ISP: IP pública y puerto de API, sin depender del servicio web.
 *   'rest'     REST API de RouterOS v7 sobre HTTP/HTTPS. Alternativa para redes
 *              donde el 8728 está bloqueado por firewall — el caso de la red del
 *              taller (docs/comandos-referencia.md § 3).
 *
 * Los dos drivers exponen la misma interfaz, así que las rutas no se enteran de
 * cuál se está usando.
 */

export const LISTA_MOROSOS = binaria.LISTA_MOROSOS

/**
 * Qué driver corresponde a este router.
 * Se exporta para poder verificarlo sin abrir una conexión.
 */
export function modoDe(router) {
  if (router.modo_api) return String(router.modo_api).toLowerCase()
  // Sin columna, se deduce del puerto: 80/443 solo tienen sentido para REST.
  const puerto = Number(router.puerto_api)
  return puerto === 80 || puerto === 443 ? 'rest' : 'binaria'
}

const driver = (router) => (modoDe(router) === 'rest' ? rest : binaria)

export const probarConexion = (r) => driver(r).probarConexion(r)

export const listarPools = (r) => driver(r).listarPools(r)
export const crearPool = (r, datos) => driver(r).crearPool(r, datos)
export const borrarPool = (r, id) => driver(r).borrarPool(r, id)

export const listarDirecciones = (r) => driver(r).listarDirecciones(r)
export const crearDireccion = (r, datos) => driver(r).crearDireccion(r, datos)
export const borrarDireccion = (r, id) => driver(r).borrarDireccion(r, id)
export const listarInterfaces = (r) => driver(r).listarInterfaces(r)

export const listarBloqueos = (r, lista) => driver(r).listarBloqueos(r, lista)
export const bloquearIp = (r, datos) => driver(r).bloquearIp(r, datos)
export const desbloquear = (r, id) => driver(r).desbloquear(r, id)

export const listarReglasFilter = (r) => driver(r).listarReglasFilter(r)
export const listarReglasNat = (r) => driver(r).listarReglasNat(r)
export const asegurarReglaCorte = (r, lista) => driver(r).asegurarReglaCorte(r, lista)
export const asegurarRedireccionPago = (r, datos) => driver(r).asegurarRedireccionPago(r, datos)

// --- IPv6, si el router lo tiene encendido ----------------------------------
export const LISTA_MOROSOS_V6 = binaria.LISTA_MOROSOS_V6
export const soportaIpv6 = (r) => driver(r).soportaIpv6(r)
export const listarBloqueosIpv6 = (r, lista) => driver(r).listarBloqueosIpv6(r, lista)
export const bloquearIpv6 = (r, datos) => driver(r).bloquearIpv6(r, datos)
export const desbloquearIpv6 = (r, id) => driver(r).desbloquearIpv6(r, id)
export const listarReglasFilterIpv6 = (r) => driver(r).listarReglasFilterIpv6(r)
export const asegurarReglaCorteIpv6 = (r, lista) => driver(r).asegurarReglaCorteIpv6(r, lista)

export const listarSimpleQueues = (r) => driver(r).listarSimpleQueues(r)
export const crearSimpleQueue = (r, datos) => driver(r).crearSimpleQueue(r, datos)
export const asegurarSimpleQueue = (r, datos) => driver(r).asegurarSimpleQueue(r, datos)

// --- Alta de un abonado nuevo ------------------------------------------------
export const listarRegistroWireless = (r) => driver(r).listarRegistroWireless(r)
export const listarPppProfiles = (r) => driver(r).listarPppProfiles(r)
export const listarPppoeServers = (r) => driver(r).listarPppoeServers(r)
export const listarInterfacesVlan = (r) => driver(r).listarInterfacesVlan(r)
export const asegurarPppProfile = (r, datos) => driver(r).asegurarPppProfile(r, datos)
export const listarPppActive = (r) => driver(r).listarPppActive(r)
export const leerRecursos = (r) => driver(r).leerRecursos(r)
export const asegurarPppSecret = (r, datos) => driver(r).asegurarPppSecret(r, datos)
export const borrarPppSecret = (r, usuario) => driver(r).borrarPppSecret(r, usuario)
export const asegurarLeaseFija = (r, datos) => driver(r).asegurarLeaseFija(r, datos)

// --- Importación de clientes ------------------------------------------------
export const escanear = (r) => driver(r).escanear(r)
export const listarPppSecrets = (r) => driver(r).listarPppSecrets(r)
export const listarDhcpLeases = (r) => driver(r).listarDhcpLeases(r)
export const listarTodasLasEntradas = (r) => driver(r).listarTodasLasEntradas(r)
export const copiarLista = (r, datos) => driver(r).copiarLista(r, datos)
export const exportarClientes = (r, datos) => driver(r).exportarClientes(r, datos)
export const aplicarSincronizacion = (r, datos) => driver(r).aplicarSincronizacion(r, datos)

// --- Diagnóstico y control remoto -------------------------------------------
//
// Solo el driver binario los implementa: son comandos de herramienta, no de
// configuración, y la REST API de RouterOS no los expone igual. Con un router
// en modo REST se avisa en vez de fallar con un error de protocolo.

const soloBinaria = (nombre) => (router) => {
  if (modoDe(router) !== 'binaria') {
    throw new Error(
      `"${nombre}" necesita la API binaria de RouterOS. Este router está configurado en modo REST.`,
    )
  }
}

// Tocar reglas del firewall va solo por la API binaria: es lo único que puede
// poner una regla en una POSICIÓN determinada de la cadena, y en el firewall la
// posición es la lógica.
export const clonarReglaCorte = (r, datos) =>
  (soloBinaria('Clonar regla de corte')(r), binaria.clonarReglaCorte(r, datos))
export const cambiarReglaHabilitada = (r, datos) =>
  (soloBinaria('Apagar regla')(r), binaria.cambiarReglaHabilitada(r, datos))

export const ping = (r, datos) => (soloBinaria('Ping')(r), binaria.ping(r, datos))
export const traceroute = (r, datos) => (soloBinaria('Traceroute')(r), binaria.traceroute(r, datos))
export const reiniciar = (r) => (soloBinaria('Reiniciar')(r), binaria.reiniciar(r))
export const bajarSesionPpp = (r, datos) => (soloBinaria('Kick PPPoE')(r), binaria.bajarSesionPpp(r, datos))
export const sesionPpp = (r, datos) => (soloBinaria('Sesión PPPoE')(r), binaria.sesionPpp(r, datos))
export const listarArp = (r, datos) => (soloBinaria('Dispositivos')(r), binaria.listarArp(r, datos))
export const cambiarWifi = (r, datos) => (soloBinaria('Cambiar WiFi')(r), binaria.cambiarWifi(r, datos))
export const testVelocidad = (r, datos) => (soloBinaria('Test de velocidad')(r), binaria.testVelocidad(r, datos))
export const escanearRango = (r, datos) => (soloBinaria('Escaneo de subred')(r), binaria.escanearRango(r, datos))
