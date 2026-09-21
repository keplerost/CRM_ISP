import { config } from '../config.js'
import { AppError } from '../lib/errors.js'
import { aHexSn } from '../lib/sn.js'

/**
 * GenieACS: el servidor TR-069 que habla con las ONTs de los abonados.
 *
 * ── Por qué hace falta ──
 *
 * La OLT sabe autorizar una ONT y darle servicio, pero no sabe nada de su WiFi:
 * en la CLI del MA5800 no hay perfiles de home-gateway ni de TR069, solo
 * `ont tr069-server-config`, que sirve para APUNTAR la ONT a un ACS. El nombre
 * de la red y su clave viven dentro del equipo del abonado, y solo se llega ahí
 * por TR-069.
 *
 * ── Cómo aplica un cambio, de verdad ──
 *
 * TR-069 es al revés de lo que uno espera: el servidor no llama al equipo, el
 * equipo llama al servidor. Cada tanto —el "inform periódico"— la ONT se
 * conecta y pregunta si hay algo para ella.
 *
 * Eso da dos caminos:
 *
 *   CONNECTION REQUEST. El ACS golpea la puerta del equipo para que se conecte
 *   ya. Aplica en segundos, pero exige que el ACS tenga camino de red hasta la
 *   IP de gestión de la ONT.
 *
 *   ESPERAR EL INFORM. Si no hay camino, la tarea queda guardada y se aplica
 *   cuando la ONT llame sola. Puede ser en horas.
 *
 * Y hay un tercer caso que ninguna configuración arregla: la ONT apagada. Un
 * abonado sin luz no recibe nada. Por eso el pedido nunca se promete como
 * hecho hasta que el equipo confirma.
 */

const BASE = () => (config.genieacs.url || '').replace(/\/$/, '')

export const hayAcs = () => Boolean(BASE())

export async function pedir(ruta, opciones = {}) {
  if (!hayAcs()) {
    throw new AppError('No hay servidor TR-069 configurado.', {
      status: 503,
      hint: 'Definí GENIEACS_URL en middleware/.env apuntando al NBI de GenieACS (puerto 7557).',
    })
  }

  let res
  try {
    res = await fetch(`${BASE()}${ruta}`, {
      ...opciones,
      headers: { 'content-type': 'application/json', ...(opciones.headers ?? {}) },
      signal: AbortSignal.timeout(config.genieacs.timeoutMs),
    })
  } catch (err) {
    throw new AppError(`No se pudo contactar al servidor TR-069: ${err.message}`, {
      status: 502,
      hint: 'Verificá que GenieACS esté corriendo y que el middleware llegue a su puerto 7557.',
    })
  }

  const texto = await res.text()
  if (!res.ok) {
    throw new AppError(`El servidor TR-069 respondió ${res.status}: ${texto.slice(0, 200)}`, {
      status: 502,
    })
  }

  return texto ? JSON.parse(texto) : null
}

/**
 * Busca el equipo por su número de serie.
 *
 * Se prueba contra los tres campos donde puede estar según el fabricante. Un
 * Huawei lo reporta en `_deviceId._SerialNumber`, pero no todos: buscar en uno
 * solo hace que el equipo "no exista" cuando en realidad está ahí.
 */
export async function buscarPorSerie(serie) {
  const s = String(serie ?? '').trim()
  if (!s) return null

  const consulta = {
    $or: [
      { '_deviceId._SerialNumber': s },
      { '_deviceId._SerialNumber': s.toUpperCase() },
      { _id: { $regex: s, $options: 'i' } },
    ],
  }

  // Huawei suele reportar por TR-069 los ocho bytes en hexa, no "HWTC…".
  const hex = aHexSn(s)
  if (hex && hex !== s.toUpperCase()) {
    consulta.$or.push({ '_deviceId._SerialNumber': hex }, { _id: { $regex: hex, $options: 'i' } })
  }

  const r = await pedir(`/devices/?query=${encodeURIComponent(JSON.stringify(consulta))}`)
  return r?.[0] ?? null
}

/**
 * Dónde vive el WiFi según el modelo de datos del equipo.
 *
 * Hay dos estándares y conviven: los equipos viejos usan TR-098
 * (InternetGatewayDevice) y los nuevos TR-181 (Device). Las ONTs Huawei que
 * están en esta red son casi todas TR-098, pero asumirlo dejaría afuera a los
 * demás sin ningún aviso — parecería que el cambio se aplicó.
 */
const MODELOS = [
  {
    nombre: 'tr098',
    raiz: 'InternetGatewayDevice',
    ssid: (i) => `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.SSID`,
    clave: (i) => `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.PreSharedKey.1.KeyPassphrase`,
    // Algunos firmwares aceptan la clave solo por acá.
    claveAlterna: (i) => `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.KeyPassphrase`,
    habilitado: (i) => `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.Enable`,
  },
  {
    nombre: 'tr181',
    raiz: 'Device',
    ssid: (i) => `Device.WiFi.SSID.${i}.SSID`,
    clave: (i) => `Device.WiFi.AccessPoint.${i}.Security.KeyPassphrase`,
    claveAlterna: null,
    habilitado: (i) => `Device.WiFi.SSID.${i}.Enable`,
  },
]

/** Saca el valor de una ruta con puntos dentro del árbol que devuelve GenieACS. */
function valorDe(dispositivo, ruta) {
  let nodo = dispositivo
  for (const parte of ruta.split('.')) {
    nodo = nodo?.[parte]
    if (nodo == null) return null
  }
  return nodo?._value ?? null
}

export function modeloDe(dispositivo) {
  return MODELOS.find((m) => dispositivo?.[m.raiz]) ?? null
}

/**
 * Lee el WiFi del equipo, tal como lo reportó la última vez.
 *
 * NO consulta el equipo: devuelve lo que GenieACS guardó del último inform. Es
 * a propósito — para mostrarle al abonado el nombre de su red no hace falta
 * despertar la ONT, y hacerlo en cada visita a la pantalla sería castigar al
 * equipo por una curiosidad.
 *
 * La clave se dice si ESTÁ, nunca cuál es. Muchos firmwares ni la devuelven, y
 * mostrarla convertiría el portal en una forma de averiguar la clave del WiFi
 * de un vecino con solo saber su cédula.
 */
export function leerWifi(dispositivo) {
  const modelo = modeloDe(dispositivo)
  if (!modelo) return null

  const redes = []
  // Hasta 8 radios/SSIDs: 2.4 GHz, 5 GHz y las de invitados.
  for (let i = 1; i <= 8; i++) {
    const ssid = valorDe(dispositivo, modelo.ssid(i))
    if (!ssid) continue

    redes.push({
      indice: i,
      ssid,
      habilitada: valorDe(dispositivo, modelo.habilitado(i)) !== false,
      tiene_clave: Boolean(
        valorDe(dispositivo, modelo.clave(i)) ||
          (modelo.claveAlterna && valorDe(dispositivo, modelo.claveAlterna(i))),
      ),
    })
  }

  return {
    modelo: modelo.nombre,
    ultimo_contacto: dispositivo?._lastInform ?? null,
    redes,
  }
}

/**
 * Aplica el cambio.
 *
 * `connection_request` le pide a GenieACS que despierte al equipo en vez de
 * esperar su próximo inform. Si el ACS no tiene camino hasta la ONT, esto falla
 * — y ese fallo es información, no un problema: significa que la tarea quedó
 * encolada y se va a aplicar más tarde.
 *
 * Se escribe la clave en las DOS rutas posibles porque hay firmwares que solo
 * aceptan una. Escribir en la que no existe da error en esa sola parte, no en
 * todo el cambio.
 */
export async function cambiarWifi(dispositivo, { ssid, clave, indice = 1 } = {}) {
  const modelo = modeloDe(dispositivo)
  if (!modelo) {
    throw new AppError('El equipo no reporta un modelo de datos conocido (ni TR-098 ni TR-181).', {
      status: 422,
    })
  }

  const valores = []
  if (ssid) valores.push([modelo.ssid(indice), String(ssid), 'xsd:string'])
  if (clave) {
    valores.push([modelo.clave(indice), String(clave), 'xsd:string'])
    if (modelo.claveAlterna) valores.push([modelo.claveAlterna(indice), String(clave), 'xsd:string'])
  }

  if (!valores.length) throw new AppError('No hay nada que cambiar.', { status: 400 })

  const id = encodeURIComponent(dispositivo._id)

  try {
    await pedir(`/devices/${id}/tasks?connection_request`, {
      method: 'POST',
      body: JSON.stringify({ name: 'setParameterValues', parameterValues: valores }),
    })
    return { aplicado: true }
  } catch (err) {
    // El equipo no contestó al golpe en la puerta: apagado, sin camino de red,
    // o detrás de un NAT. La tarea igual quedó guardada en GenieACS y se aplica
    // en el próximo inform.
    return { aplicado: false, motivo: err.message, encolado: true }
  }
}

/** Le pide al equipo que se reporte ya. Sirve para refrescar lo que sabemos. */
export async function refrescar(dispositivo) {
  const id = encodeURIComponent(dispositivo._id)
  try {
    await pedir(`/devices/${id}/tasks?connection_request`, {
      method: 'POST',
      body: JSON.stringify({ name: 'refreshObject', objectName: modeloDe(dispositivo)?.raiz ?? '' }),
    })
    return true
  } catch {
    return false
  }
}

/** Cuántos equipos conoce el ACS. Es el número que dice si el TR-069 sirve. */
export async function estado() {
  if (!hayAcs()) return { configurado: false }

  try {
    const dispositivos = await pedir('/devices/?projection=_lastInform&limit=1000')
    const hace24h = Date.now() - 86400_000

    return {
      configurado: true,
      url: BASE(),
      equipos: dispositivos.length,
      // Un equipo que no informa hace más de un día está apagado o perdió el
      // camino al ACS: contarlo como disponible sería mentir.
      activos: dispositivos.filter((d) => new Date(d._lastInform ?? 0).getTime() > hace24h).length,
    }
  } catch (err) {
    return { configurado: true, url: BASE(), error: err.message }
  }
}
