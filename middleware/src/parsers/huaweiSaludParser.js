/**
 * Salud de una OLT Huawei MA5800.
 *
 * Los formatos están tomados de la salida real de un MA5800-X7 con firmware
 * MA5800V100R018C00, no de la documentación: cada versión imprime lo suyo y
 * escribir esto "de memoria" fue exactamente lo que costó horas en los drivers
 * de ONU.
 *
 * Todo se parsea por línea con expresiones tolerantes, nunca por posición de
 * columna: la CLI alinea con códigos de cursor y una línea puede aparecer
 * corrida sin que eso signifique nada.
 *
 * Y todo devuelve `null` o lista vacía cuando no puede leer, jamás cero: una
 * temperatura de 0 °C es una lectura, "no lo sé" es otra cosa, y confundirlas
 * en un tablero de salud es peor que no mostrarlo.
 */

/** Quita los códigos de terminal y normaliza los saltos de línea. */
const limpiar = (s) =>
  String(s ?? '')
    .replace(/\x1b?\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')

/** `display version` → modelo, firmware y parche. */
export function parseVersion(salida) {
  const t = limpiar(salida)
  const version = t.match(/VERSION\s*:\s*(\S+)/i)?.[1] ?? null
  const parche = t.match(/PATCH\s*:\s*(\S+)/i)?.[1] ?? null
  const producto = t.match(/PRODUCT\s*:\s*(\S+)/i)?.[1] ?? null

  if (!version && !producto) return null
  return { modelo: producto, firmware: version, parche }
}

/**
 * `display sysuptime` → "System up time: 42 day 21 hour 29 minute 41 second"
 *
 * Se devuelven los segundos totales además del texto: el número sirve para
 * comparar —"se reinició hace poco"— y el texto para leerlo.
 */
export function parseUptime(salida) {
  const t = limpiar(salida)
  const m = t.match(/System up time:\s*(.+)/i)
  if (!m) return null

  const trozo = m[1]
  const n = (unidad) => Number(trozo.match(new RegExp(`(\\d+)\\s*${unidad}`, 'i'))?.[1] ?? 0)

  const dias = n('day')
  const horas = n('hour')
  const minutos = n('minute')
  const segundos = n('second')

  if (!dias && !horas && !minutos && !segundos) return null

  return {
    dias,
    horas,
    minutos,
    total_segundos: dias * 86400 + horas * 3600 + minutos * 60 + segundos,
    texto: dias ? `${dias} d ${horas} h` : `${horas} h ${minutos} min`,
  }
}

/**
 * `display time` → "2026-08-02 21:48:12-05:00"
 *
 * Importa más de lo que parece: si el reloj de la OLT está corrido, los eventos
 * que registra no se pueden cruzar con los del resto del sistema y cualquier
 * reclamo "¿a qué hora se cayó?" queda sin respuesta confiable.
 */
export function parseHora(salida) {
  const m = limpiar(salida).match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})?/)
  if (!m) return null

  const iso = `${m[1].replace(' ', 'T')}${m[2] ?? ''}`
  const fecha = new Date(iso)
  if (Number.isNaN(fecha.getTime())) return { texto: m[0], desfase_segundos: null }

  return {
    texto: m[0],
    iso: fecha.toISOString(),
    // Contra el reloj de quien pregunta. Unos segundos son normales; unos
    // minutos ya ensucian la correlación de eventos.
    desfase_segundos: Math.round((Date.now() - fecha.getTime()) / 1000),
  }
}

/**
 * `display ntp-service status`
 *
 *   clock status: synchronized
 *   clock stratum: 2
 *   reference clock ID: 216.239.35.4
 *   clock offset: -0.8441 ms
 *   synchronization state: clock synchronized
 *
 * Escrito contra la salida real de un MA5800-X7 R018.
 *
 * Importa más de lo que parece: el reloj del equipo es lo que fecha cada evento
 * que registra. Si se corre, "¿a qué hora se cayó el servicio?" deja de tener
 * respuesta confiable y los eventos del equipo no se pueden cruzar con los del
 * resto del sistema.
 *
 * Un equipo que dice "unsynchronized" está peor que uno sin NTP configurado: cree
 * que tiene hora buena y no la tiene.
 */
export function parseNtp(salida) {
  const t = limpiar(salida)

  const estado = t.match(/clock status:\s*(\S+)/i)?.[1] ?? null
  if (!estado) return null

  const num = (re) => {
    const v = t.match(re)?.[1]
    return v == null ? null : Number(v)
  }

  return {
    sincronizado: /^synchronized$/i.test(estado),
    estado,
    estrato: num(/clock stratum:\s*(\d+)/i),
    referencia: t.match(/reference clock ID:\s*(\S+)/i)?.[1] ?? null,
    desfase_ms: num(/clock offset:\s*(-?[\d.]+)\s*ms/i),
    // Un estrato 16 es "no tengo referencia", aunque el estado diga otra cosa.
    sin_referencia: num(/clock stratum:\s*(\d+)/i) === 16,
  }
}

/**
 * `display temperature 0`
 *   SlotID:  6      BoardName: H901GPHF       Temperature:   36C(  96F)
 */
export function parseTemperaturas(salida) {
  const filas = []
  const re = /SlotID:\s*(\d+)\s+BoardName:\s*(\S+)\s+Temperature:\s*(-?\d+)\s*C/gi

  let m
  while ((m = re.exec(limpiar(salida)))) {
    filas.push({ slot: Number(m[1]), placa: m[2], celsius: Number(m[3]) })
  }
  return filas
}

/**
 * `display power 0`
 *   FrameID  Power(unit:Watt)
 *   0        551
 */
export function parsePotencia(salida) {
  const t = limpiar(salida)
  if (!/Power\s*\(unit:\s*Watt\)/i.test(t)) return null

  // Después del encabezado: una línea con el frame y los watts.
  const m = t.match(/^\s*(\d+)\s+(\d+)\s*$/m)
  if (!m) return null

  return { frame: Number(m[1]), watts: Number(m[2]) }
}

/**
 * `display board 0`
 *   SlotID  BoardName  Status          SubType0 SubType1    Online/Offline
 *   6       H901GPHF   Normal
 *
 * Los slots vacíos aparecen con el número y nada más: se descartan, porque un
 * slot sin placa no es una falla.
 */
export function parsePlacas(salida) {
  const filas = []

  for (const linea of limpiar(salida).split('\n')) {
    const m = linea.match(/^\s*(\d+)\s+([A-Z0-9]{6,})\s+(\S+)/i)
    if (!m) continue

    const estado = m[3]
    filas.push({
      slot: Number(m[1]),
      placa: m[2],
      estado,
      // "Normal", "Active_normal" y "Standby_normal" son los tres estados sanos
      // de un MA5800: el par de placas de control trabaja en activo/reserva.
      ok: /normal/i.test(estado),
      // La de reserva no está fallando: está esperando. Distinguirlo evita que
      // el tablero muestre en rojo algo que es correcto.
      reserva: /standby/i.test(estado),
    })
  }
  return filas
}

/** `display frame info 0` → el backplane y su estado. */
export function parseFrame(salida) {
  const t = limpiar(salida)
  const tipo = t.match(/Type:\s*(\S+)/i)?.[1] ?? null
  const estado = t.match(/State:\s*([A-Za-z_]+)/i)?.[1] ?? null
  const emu = t.match(/EMU ID:\s*\d+\s+Subnode:\d+\s+State:\s*(.+)/i)?.[1]?.trim() ?? null

  if (!tipo && !estado) return null
  return { tipo, estado, ok: /normal/i.test(estado ?? ''), emu }
}

/**
 * `display board 0/<slot>` → los puertos PON de una placa.
 *
 *     Port   Port   min-distance   max-distance   Optical-module
 *            type       (km)           (km)           status
 *     0     GPON        0              20             Online
 *
 * El estado del módulo óptico por puerto es lo que avisa de un SFP muerto: los
 * abonados de ese puerto caen todos juntos y desde la ficha de cada uno parece
 * un problema distinto.
 */
export function parsePuertosPon(salida) {
  const puertos = []
  const re = /^\s*(\d+)\s+(GPON|EPON|XGPON|XGSPON)\s+(\d+)\s+(\d+)\s+(\S+)/gim

  let m
  while ((m = re.exec(limpiar(salida)))) {
    const estado = m[5]
    puertos.push({
      puerto: Number(m[1]),
      tipo: m[2].toUpperCase(),
      distancia_max_km: Number(m[4]),
      modulo_optico: estado,
      ok: /online/i.test(estado),
    })
  }

  const t = limpiar(salida)
  return {
    placa: t.match(/Board Name\s*:\s*(\S+)/i)?.[1] ?? null,
    estado: t.match(/Board Status\s*:\s*(\S+)/i)?.[1] ?? null,
    alimentacion: t.match(/^\s*(POWER-O\S+)/im)?.[1] ?? null,
    puertos,
  }
}
