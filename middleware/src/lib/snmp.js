import snmp from 'net-snmp'
import { config } from '../config.js'
import { AppError } from './errors.js'

/**
 * Cliente SNMP.
 *
 * Existe para lo que la CLI hace mal: leer muchos valores del mismo tipo. Una
 * sesión CLI por abonado no escala —con mil ONTs son mil conversaciones con
 * prompt, paginador y tabla para humanos— y además consume las poquísimas
 * ranuras de sesión que tienen estos equipos. SNMP no tiene ese techo: el
 * agente no guarda estado por consultante, así que se le puede preguntar todo
 * de una sin dejar a nadie afuera.
 *
 * Va sobre UDP, y eso cambia cómo hay que programarlo: no hay conexión que se
 * caiga ni error de "cerró la sesión". Si no contesta, no contesta, y el timeout
 * lo decide quien pregunta.
 */

/** Valor centinela de SNMP para "este dato no está disponible". */
export const NO_DISPONIBLE = 2147483647

/**
 * Convierte un valor crudo a número, o a null si el equipo dijo que no lo tiene.
 *
 * Es la distinción de siempre y sigue importando igual: 0 dBm es una lectura
 * buenísima y "no sé" es otra cosa. Confundirlas acá pondría en verde a una ONT
 * que no está reportando nada.
 */
export function valor(crudo) {
  if (crudo == null) return null
  const n = Number(crudo)
  if (!Number.isFinite(n)) return null
  // -1 es lo que devuelven estos equipos para una posición sin ONT.
  if (n === NO_DISPONIBLE || n === -1) return null
  return n
}

function abrir(equipo, comunidad) {
  if (!comunidad) {
    throw new AppError('El equipo no tiene cargada la comunidad SNMP de lectura', {
      status: 400,
      hint: 'Usá "Detectar comunidad" en la ficha: se lee del propio equipo y se guarda cifrada.',
    })
  }

  return snmp.createSession(equipo.ip_host, comunidad, {
    port: equipo.snmp_puerto || 161,
    version: snmp.Version2c,
    timeout: config.snmp.timeoutMs,
    retries: config.snmp.reintentos,
  })
}

/**
 * Recorre una rama del árbol y devuelve todo lo que cuelga de ella.
 *
 * Usa getBulk y no getNext: getNext es un viaje de ida y vuelta por valor —con
 * 85 ONTs por 6 columnas son 510 viajes— mientras que getBulk trae de a
 * decenas. Es la diferencia entre segundos y milisegundos.
 *
 * El tope no es decoración: una rama equivocada en un equipo cargado puede
 * devolver decenas de miles de valores y llenar la memoria del proceso.
 */
export function recorrer(equipo, comunidad, base, { tope = 20000 } = {}) {
  const sesion = abrir(equipo, comunidad)

  return new Promise((resolve, reject) => {
    const filas = []
    let actual = base
    let terminado = false

    const terminar = (fn, arg) => {
      if (terminado) return
      terminado = true
      try {
        sesion.close()
      } catch {
        // Ya estaba cerrada.
      }
      fn(arg)
    }

    // Red de seguridad: si el equipo deja de contestar a mitad de camino, la
    // promesa quedaría colgada para siempre. Sin conexión que se corte, no hay
    // otro evento que avise.
    const limite = setTimeout(
      () => terminar(reject, new AppError(`El recorrido SNMP de ${base} no terminó a tiempo`, {
        status: 504,
        hint: 'El equipo dejó de responder a mitad del recorrido.',
      })),
      config.snmp.recorridoTimeoutMs,
    )

    let fallosSeguidos = 0

    const paso = () => {
      sesion.getBulk([actual], 0, config.snmp.porLote, (err, varbinds) => {
        if (err) {
          // Perder un paquete es lo normal en UDP, no una falla del equipo. Se
          // reintenta desde donde quedó: sin esto, un recorrido de quinientos
          // valores se cae entero por una sola pérdida.
          fallosSeguidos++
          if (fallosSeguidos <= config.snmp.reintentosPaso) {
            return setTimeout(paso, config.snmp.esperaReintentoMs)
          }

          clearTimeout(limite)
          return terminar(
            reject,
            new AppError(`SNMP no respondió en ${equipo.ip_host}: ${err.message}`, {
              status: 502,
              hint: `Se reintentó ${config.snmp.reintentosPaso} veces desde el mismo punto. Verificá que SNMP esté habilitado, que la comunidad sea la correcta y que no haya una ACL bloqueando.`,
              detalle: `Se cortó tras leer ${filas.length} valores, en ${actual}`,
            }),
          )
        }

        fallosSeguidos = 0

        const lote = (varbinds[0] ?? []).filter((v) => !snmp.isVarbindError(v))
        let seguir = false

        for (const v of lote) {
          // Salirse de la rama es la señal de que terminó: el agente sigue
          // devolviendo lo que viene después en el árbol global.
          if (!v.oid.startsWith(`${base}.`)) {
            clearTimeout(limite)
            return terminar(resolve, filas)
          }
          filas.push({ oid: v.oid, valor: v.value })
          actual = v.oid
          seguir = true
        }

        if (!seguir || filas.length >= tope) {
          clearTimeout(limite)
          return terminar(resolve, filas)
        }
        paso()
      })
    }

    paso()
  })
}

/**
 * ifIndex de un puerto GPON Huawei.
 *
 * El equipo empaqueta el slot y el puerto dentro del número de interfaz:
 *
 *     0xFA000000  +  (slot << 13)  +  (puerto << 8)
 *
 * Verificado contra el MA5800-X7: 4194353152 → slot 6, puerto 0, y la ONT que
 * el índice apunta ahí es la misma que devuelve `display ont optical-info 0 0`.
 */
export const BASE_IFINDEX_GPON = 0xfa000000

export function decodificarIfIndex(ifIndex) {
  const n = Number(ifIndex) - BASE_IFINDEX_GPON
  if (!Number.isFinite(n) || n < 0) return null
  return { slot: (n >> 13) & 0xff, puerto: (n >> 8) & 0x1f }
}

export const codificarIfIndex = (slot, puerto) =>
  BASE_IFINDEX_GPON + ((slot & 0xff) << 13) + ((puerto & 0x1f) << 8)
