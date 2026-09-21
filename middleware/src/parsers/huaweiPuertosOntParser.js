import { normalizarHuawei } from '../lib/ansi.js'

/**
 * Los puertos de adentro de una ONT: los ethernet de la casa y los de teléfono.
 *
 * Es lo que contesta la pregunta del abonado que llama diciendo "no me anda
 * internet" cuando la fibra está perfecta: si sus cuatro puertos están en
 * `down`, el problema está del router para adentro y no hay nada que revisar en
 * la red.
 *
 * Salida literal de un MA5800-X7.
 */

/** El equipo escribe "-" cuando no tiene el dato. Eso es null, no un guion. */
const oNada = (v) => {
  const s = (v ?? '').trim()
  return !s || s === '-' ? null : s
}

const numeroONada = (v) => {
  const s = oNada(v)
  if (s == null) return null
  const n = Number.parseFloat(s)
  return Number.isFinite(n) ? n : null
}

/**
 * `display ont port state <puerto> <ontId> eth-port all`
 *
 *   ONT-ID   ONT      ONT       Speed(Mbps)   Duplex   LinkState  RingStatus
 *            port-ID  Port-type
 *       10         1         GE -             -        down       noloop
 *
 * `LinkState` es lo único que importa de verdad: dice si hay algo enchufado.
 * Las columnas de velocidad y duplex vienen con guion mientras el puerto está
 * caído, y ahí "-" significa "no aplica", no "cero".
 */
export function parseEthPortsOnt(salidaCruda) {
  const salida = normalizarHuawei(salidaCruda)
  const filas = []

  for (const linea of salida.split('\n')) {
    // ONT-ID, port-ID, tipo, velocidad, duplex, link, anillo.
    const m = linea.match(
      /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(up|down)\s+(\S+)\s*$/i,
    )
    if (!m) continue

    filas.push({
      ontId: Number(m[1]),
      puerto: Number(m[2]),
      tipo: m[3],
      velocidad_mbps: numeroONada(m[4]),
      duplex: oNada(m[5]),
      // Lo importante: si está en `up`, el abonado tiene algo enchufado ahí.
      conectado: /^up$/i.test(m[6]),
      estado: m[6].toLowerCase(),
      // "noloop" es lo normal, "loop" es un cable de la casa enchufado en dos
      // bocas del mismo equipo. Pero el equipo también escribe "-" cuando no
      // tiene el dato —la detección de bucle está apagada o el modelo no la
      // soporta— y eso NO es un bucle.
      //
      // Tomar el guion como bucle levantaba una alarma roja en los cuatro
      // puertos de una ONT que no tenía ningún problema, y una alarma que se
      // enciende sin motivo deja de mirarse cuando el problema es real.
      anillo: oNada(m[7]),
      bucle: oNada(m[7]) == null ? null : /loop/i.test(m[7]) && !/noloop/i.test(m[7]),
    })
  }

  return filas
}

/**
 * `display ont port state <puerto> <ontId> pots-port all`
 *
 *    Port Physical Admin  Hook    Session    Service     Call          Service
 *    ID   State    State  State   Type       State       State         Codec
 *    1    Normal   Unlock OnHook  Idle       AutoBlock   RegisterFail  G711A
 *
 * El campo que decide si el teléfono del abonado funciona es `Call State`:
 * `RegisterFail` significa que la línea no llegó a registrarse contra el
 * servidor, y desde afuera se ve exactamente igual que una que sí funciona —
 * la ONT está online y el puerto existe.
 */
export function parsePotsPortsOnt(salidaCruda) {
  const salida = normalizarHuawei(salidaCruda)
  const filas = []

  for (const linea of salida.split('\n')) {
    const m = linea.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/)
    if (!m) continue

    const registro = m[7]

    filas.push({
      puerto: Number(m[1]),
      estado_fisico: oNada(m[2]),
      administrativo: oNada(m[3]),
      // OnHook = colgado, OffHook = descolgado o el teléfono quedó mal puesto.
      gancho: oNada(m[4]),
      sesion: oNada(m[5]),
      servicio: oNada(m[6]),
      registro,
      // Registrado de verdad. Se compara contra la lista de lo que SÍ está bien
      // en vez de contra la de fallos: una versión de VRP que devuelva un estado
      // nuevo tiene que caer del lado de "revisalo", no del de "está todo bien".
      registrado: /^(registered|normal|idle)$/i.test(registro ?? ''),
      codec: oNada(m[8]),
    })
  }

  return filas
}
