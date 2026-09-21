import { conSesionSsh } from '../lib/sshSession.js'
import { config } from '../config.js'
import { AppError, badRequest } from '../lib/errors.js'
import { normalizarSn, aHexSn } from '../lib/sn.js'
import { normalizarHuawei } from '../lib/ansi.js'
import { aAsciiParaEquipo } from '../lib/nombres.js'
import {
  parsePerfiles,
  parseIndicesServicePort,
  parseServicePortsDeOnt,
  parseServicePortsPorPuerto,
  parseConfigOnt,
  parseEstadisticasServicePort,
  parseTrafficTables,
  parseTrafficTablesDetalle,
  primerIndiceLibre,
} from '../parsers/huaweiPerfilParser.js'
import {
  contarAsignacionesTr069,
  contarIpsDeGestion,
  diagnosticoTr069,
  parseMacsDeOnt,
  parsePerfilesTr069,
  parseTr069DeOnt,
} from '../parsers/huaweiTr069Parser.js'
import { parseEstadoPuerto, parseAutofindPorPuerto } from '../parsers/huaweiPuertoParser.js'
import { parseEthPortsOnt, parsePotsPortsOnt } from '../parsers/huaweiPuertosOntParser.js'
import {
  parsePuertosPlaca,
  parseVlansDePuerto,
  parseVlansConUso,
  comprimirRangos,
} from '../parsers/huaweiUplinkParser.js'
import {
  parseOntInfoAll,
  parseAutofind,
  parseOpticalInfo,
  parseOntVersion,
  parseOntIpconfig,
  parseCausaCaida,
  parseWanInfo,
  parseWanProfiles,
  parseDistancia,
  detectarFallo,
} from '../parsers/huaweiOntParser.js'
import {
 parseVersion,
 parseUptime,
 parseHora,
 parseTemperaturas,
 parsePotencia,
 parsePlacas,
 parseFrame,
 parsePuertosPon,
 parseNtp,
} from '../parsers/huaweiSaludParser.js'

/**
 * Driver OLT Huawei (MA5800 / VRP).
 *
 * Dos cosas que hay que tener presentes leyendo este archivo:
 *
 * 1. El "Enter extra". Cuando un comando VRP admite parámetros opcionales, la CLI
 *    muestra el hint `{ <cr>||<K> }:` y NO ejecuta hasta recibir otro Enter. Por eso
 *    todos los `display ont ...` van seguidos de un comando vacío ''.
 *    (docs/comandos-referencia.md § 2.2)
 *
 * 2. El estado es secuencial: enable → config → interface gpon F/S. Los comandos de
 *    ONT solo existen dentro del contexto del puerto.
 *
 * 3. Cómo se lee la ayuda del equipo. En `{ board<K>|index<U><0,139263>|port<K> }`
 *    el `<K>` marca una palabra clave y el `<U>` un número. O sea que `index` NO
 *    se escribe: va el número solo.
 *
 *      undo service-port index 17   ✗  % Parameter error
 *      undo service-port 17         ✓
 *
 *    Confundirlos costó caro: el borrado de service-ports fallaba siempre, y como
 *    el error se perdía (ver `escribir`), las ONTs quedaban imposibles de borrar
 *    y de mover sin que nada lo dijera.
 */

const credenciales = (olt) => ({
  host: olt.ip_host,
  port: olt.puerto_ssh || 22,
  username: olt.usuario,
  password: olt.password,
})

/** enable (+ password si lo pide) → config */
async function entrarModoConfig(sesion, olt) {
  const salidaEnable = await sesion.run('enable')
  if (/password/i.test(salidaEnable)) {
    await sesion.run(olt.enablePassword || olt.password)
  }

  // Se verifica que el equipo haya aceptado entrar. Importa desde que la sesión
  // se reutiliza: si quedó dentro de una interfaz, `config` no es válido ahí y
  // todos los comandos siguientes correrían en el contexto equivocado sin que
  // nada lo delate. Al fallar, el envoltorio descarta la sesión y reintenta con
  // una nueva.
  const salidaConfig = await sesion.run('config')
  const fallo = detectarFallo(salidaConfig)
  if (fallo) {
    throw new AppError(`La OLT rechazó "config": ${fallo}`, {
      status: 502,
      hint: 'La sesión pudo haber quedado en otro modo. Se va a reintentar con una sesión nueva.',
    })
  }
}

/**
 * Cómo volver al punto de partida una sesión que ya estaba abierta.
 *
 * Dos `quit`: desde la interfaz sube a config y de ahí al modo privilegiado,
 * que es desde donde `entrarModoConfig` sabe empezar. No se manda un tercero a
 * propósito — en el nivel de usuario, `quit` cierra la sesión.
 */
export const volverAlInicio = async (sesion) => {
  await sesion.run('quit')
  await sesion.run('quit')
}

/**
 * Toda operación de este driver pasa por acá.
 *
 * Centraliza cómo se reutiliza la sesión: si estuviera repetido en cada
 * llamada, la primera que se agregue olvidándolo ejecutaría sus comandos en el
 * modo en que quedó la anterior.
 */
const enLaOlt = (olt, fn) => conSesionSsh(credenciales(olt), fn, { normalizar: volverAlInicio })

/** Entra al contexto del puerto PON. `interface gpon <frame>/<slot>` */
async function entrarInterfaz(sesion, { frame = 0, slot }) {
  if (slot == null) throw badRequest('Falta el slot de la OLT')
  const salida = await sesion.run(`interface gpon ${frame}/${slot}`)
  const fallo = detectarFallo(salida)
  if (fallo) {
    throw new AppError(`La OLT rechazó "interface gpon ${frame}/${slot}": ${fallo}`, {
      status: 400,
      hint: 'Verificá que el frame/slot exista y que sea una placa GPON.',
    })
  }
}

/** Ejecuta un display y su Enter extra, devolviendo la salida del display. */
async function display(sesion, comando) {
  const salida = await sesion.run(comando)
  // Si quedó esperando en el hint de autocompletado, el Enter lo destraba y trae
  // el resto de la salida. Concatenamos las dos porque la tabla puede empezar
  // antes del hint.
  //
  // La espera mínima es para los comandos que tardan en producir su primer byte:
  // `display ntp-service status` consulta a su servidor antes de imprimir, y sin
  // esto el Enter volvía con un salto de línea y la tabla se le atribuía al
  // comando siguiente.
  const resto = await sesion.run('', { esperaMinimaMs: config.ssh.esperaSalidaMs })
  return `${salida}\n${resto}`
}

/** El equipo quedó esperando en el hint de autocompletado, sin haber ejecutado nada. */
const esperandoHint = (salida) => /\{[^}\n]*<cr>[^}\n]*\}\s*:\s*$/.test(normalizarHuawei(salida).trimEnd())

/** Está pidiendo una confirmación (y/n) antes de hacer el trabajo. */
const pideConfirmacion = (salida) => /\(y\/n\)/i.test(salida)

/**
 * Ejecuta un comando de ESCRITURA y devuelve todo lo que el equipo contestó.
 *
 * Existe por un error que costó caro encontrar. Muchos comandos de escritura no
 * se ejecutan de una: el equipo contesta con el hint de autocompletado
 *
 *   ont add 9 17 sn-auth "534B..." ...
 *   { <cr>|ont-type<K> }:
 *
 * y se queda esperando un Enter. Leyendo solo esa primera respuesta no aparece
 * ni el "success: 1" ni el "Failure:", porque todavía no pasó nada. El detector
 * de fallos no encontraba nada malo y el sistema informaba que había salido
 * bien.
 *
 * Peor todavía: como nadie mandaba el Enter, el comando SIGUIENTE se pegaba
 * como continuación de este, y el equipo terminaba rechazando los dos. Así se
 * dio de alta una ONT que nunca existió en el equipo, con el abonado ya
 * guardado en la base: el sistema decía que tenía servicio y no tenía nada.
 *
 * Por eso acá se manda el Enter que falta, se contesta el (y/n) cuando lo pide,
 * y se devuelve la conversación completa para que el detector de fallos vea el
 * resultado de verdad.
 */
async function escribir(sesion, comando) {
  let salida = await sesion.run(comando)

  if (esperandoHint(salida)) {
    salida += `\n${await sesion.run('', { esperaMinimaMs: config.ssh.esperaSalidaMs })}`
  }
  if (pideConfirmacion(salida)) {
    salida += `\n${await sesion.run('y', { esperaMinimaMs: config.ssh.esperaSalidaMs })}`
  }

  // Si después de todo eso sigue esperando, no se ejecutó. Devolver la salida
  // tal cual dejaría pasar por bueno un comando que no llegó a correr.
  if (esperandoHint(salida)) {
    throw new AppError(`El equipo dejó "${comando}" a medio escribir y no lo ejecutó`, {
      status: 502,
      detalle: salida.slice(-200),
      hint: 'Le falta algún parámetro obligatorio: el equipo se quedó pidiéndolo.',
    })
  }

  return salida
}

/**
 * Una foto de la configuración de una ONT sirve para recrearla.
 *
 * Le falta algo si no tiene la serie o alguno de los dos perfiles: con eso
 * incompleto, la ONT se recrea distinta de como estaba.
 */
const completa = (c) => Boolean(c?.sn) && c?.lineProfileId != null && c?.srvProfileId != null

/** Ejecuta una escritura y aborta con un mensaje claro si el equipo la rechaza. */
async function escribirOFallar(sesion, comando, contexto, extra = {}) {
  const salida = await escribir(sesion, comando)
  const fallo = detectarFallo(salida)
  if (fallo) {
    throw new AppError(`${contexto}: ${fallo}`, { status: 400, detalle: comando, ...extra })
  }
  return salida
}

// --- Salud ------------------------------------------------------------------

export async function probarConexion(olt) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    const salida = await display(sesion, 'display version')

    // El modelo sale del campo PRODUCT, que es donde el equipo lo pone. Buscarlo
    // con un /MA\d{4}.../ suelto encontraba primero la cadena de la VERSION
    // —"MA5800V100R018C00"— y devolvía modelo y firmware idénticos, que es lo
    // que apareció al probar contra el X7: el chasis es un MA5800-X7.
    const leido = parseVersion(salida)
    const modelo = leido?.modelo ?? salida.match(/(MA\d{4}-[A-Z0-9]+)/i)?.[1] ?? null
    const version = leido?.firmware ?? salida.match(/VERSION\s*:\s*(\S+)/i)?.[1] ?? null

    return { ok: true, marca: 'Huawei', modelo, version, parche: leido?.parche ?? null }
  })
}

/**
 * Salud del equipo: qué tiene, cómo está y desde cuándo.
 *
 * Todo en UNA sesión, que es la diferencia entre un tablero que se puede
 * refrescar y uno que agota las sesiones del equipo.
 *
 * Cada lectura va por separado y un comando que la plataforma no soporta no
 * tumba el resto: el MA5800-X7 no entiende `display fan` ni `display cpu`, y
 * eso no puede impedir mostrar la temperatura. Lo que no se pudo leer se
 * informa como tal —no como cero— porque "no lo sé" y "está en cero" son cosas
 * distintas en un tablero de salud.
 */
export async function leerSalud(olt) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const sinFallar = async (comando, parsear) => {
      try {
        return parsear(await display(sesion, comando))
      } catch {
        return null
      }
    }

    const version = await sinFallar('display version', parseVersion)
    const uptime = await sinFallar('display sysuptime', parseUptime)
    const hora = await sinFallar('display time', parseHora)
    const temperaturas = (await sinFallar('display temperature 0', parseTemperaturas)) ?? []
    const potencia = await sinFallar('display power 0', parsePotencia)
    const placas = (await sinFallar('display board 0', parsePlacas)) ?? []
    const frame = await sinFallar('display frame info 0', parseFrame)

    // El detalle de puertos solo de las placas de servicio: preguntarle a una
    // de control por sus puertos PON es un comando de más por cada refresco.
    const dePuertos = placas.filter((p) => /GP|EP|XG/i.test(p.placa) && p.ok)
    const tarjetas = []
    for (const p of dePuertos) {
      const detalle = await sinFallar(`display board 0/${p.slot}`, parsePuertosPon)
      if (detalle) tarjetas.push({ slot: p.slot, ...detalle })
    }

    return { marca: 'Huawei', version, uptime, hora, temperaturas, potencia, placas, frame, tarjetas }
  })
}

/**
 * La comunidad SNMP de lectura, preguntada al propio equipo.
 *
 * Evita el paso incómodo de que alguien la copie del equipo, la mande por chat
 * y la tipee acá. El valor va directo del equipo a la columna cifrada: quien lo
 * llama lo guarda, nadie lo muestra.
 */
export async function leerComunidadSnmp(olt, { escritura = false } = {}) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    const salida = await display(
      sesion,
      `display snmp-agent community ${escritura ? 'write' : 'read'}`,
    )
    return salida.match(/Community name\s*:\s*(\S+)/i)?.[1] ?? null
  })
}

/**
 * Estado del reloj del equipo.
 *
 * Un solo comando: se usa en la auditoría profunda, donde hay que preguntarle
 * esto a cada OLT y no sirve pagar una lectura de salud completa por equipo.
 */
export async function leerNtp(olt) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    return parseNtp(await display(sesion, 'display ntp-service status'))
  })
}

/**
 * Solo las placas, con su temperatura pegada.
 *
 * Es `leerSalud` recortado a propósito. La pestaña de tarjetas no necesita el
 * consumo del bastidor ni los puertos de cada placa, y contra una CLI cada
 * comando de más se paga en segundos de espera del que está mirando.
 */
export async function leerPlacas(olt) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const placas = parsePlacas(await display(sesion, 'display board 0')) ?? []
    const temperaturas = parseTemperaturas(await display(sesion, 'display temperature 0')) ?? []

    return placas.map((p) => ({
      ...p,
      celsius: temperaturas.find((t) => t.slot === p.slot)?.celsius ?? null,
      // Qué tipo de placa es, para que la pantalla sepa a cuál puede pedirle
      // puertos PON y a cuál no tiene sentido preguntarle.
      servicio: /GP|EP|XG/i.test(p.placa),
      control: /MP/i.test(p.placa),
    }))
  })
}

/**
 * Puertos PON. Con `slot` pregunta por una placa; sin él, por todas las de
 * servicio que estén sanas.
 *
 * A una placa de control preguntarle por sus puertos PON es un comando tirado a
 * la basura, y a una en falla la respuesta no significa nada.
 */
export async function leerPuertosPon(olt, { slot } = {}) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    let slots = [Number(slot)]
    if (slot == null) {
      const placas = parsePlacas(await display(sesion, 'display board 0')) ?? []
      slots = placas.filter((p) => /GP|EP|XG/i.test(p.placa) && p.ok).map((p) => p.slot)
    }

    const tarjetas = []
    for (const s of slots) {
      try {
        const detalle = parsePuertosPon(await display(sesion, `display board 0/${s}`))
        if (detalle) tarjetas.push({ slot: s, ...detalle })
      } catch {
        // Una placa que no contesta no puede dejar sin puertos a las demás.
      }
    }
    return tarjetas
  })
}

/**
 * Estado detallado de los puertos PON de una placa.
 *
 * Un comando por puerto: es caro (dieciséis puertos son un minuto y medio) y
 * por eso va bajo demanda, como el botón "Refresh PON ports info" de cualquier
 * gestor. Lo barato —cuántas ONTs tiene cada puerto y su señal promedio— sale
 * de la base y se muestra al instante.
 *
 * Trae lo que no se ve de otra forma: la potencia Tx del módulo de la OLT, su
 * temperatura, si hay una ONU rogue, y cuándo se cayó el puerto por última vez
 * y por qué.
 */
export async function leerEstadoPuertos(olt, { slot, puertos = 16 }) {
  if (slot == null) throw badRequest('Falta el slot')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame: 0, slot })

    // NO se lee `display current-configuration` acá. Son ochocientas líneas y
    // dejan la sesión envenenada: los `display port state` siguientes vuelven
    // con restos del volcado anterior y no parsean. El auto-find, que es lo
    // único que había ahí, se saca del respaldo ya guardado.
    const filas = []
    const fallos = []

    for (let puerto = 0; puerto < puertos; puerto++) {
      try {
        const estado = parseEstadoPuerto(await display(sesion, `display port state ${puerto}`))
        if (estado) filas.push({ slot, puerto, ...estado })
        else fallos.push({ puerto, motivo: 'el equipo contestó algo que no se pudo interpretar' })
      } catch (err) {
        // Un puerto que no contesta no puede dejar sin datos a los otros quince,
        // pero tampoco puede desaparecer sin dejar rastro: un silencio se lee
        // como "ese puerto no existe".
        fallos.push({ puerto, motivo: err.message })
      }
    }
    return { puertos: filas, fallos }
  })
}

/**
 * Puertos de subida, con las VLANs que pasan por cada uno.
 *
 * Los uplinks viven en las placas de control. Se recorren las que estén
 * presentes y, por cada puerto, se pregunta qué VLANs lo atraviesan — que es lo
 * que hace falta para armar un troncal.
 *
 * Es un comando por placa más uno por puerto: con dos placas de cuatro puertos,
 * diez comandos. Va bajo demanda.
 */
export async function leerUplinks(olt, { slots } = {}) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    // Sin lista explícita, se buscan las placas de control: son las que tienen
    // los puertos de subida.
    let aRevisar = slots
    if (!aRevisar?.length) {
      const placas = parsePlacas(await display(sesion, 'display board 0')) ?? []
      aRevisar = placas.filter((p) => /MP/i.test(p.placa) && p.ok).map((p) => p.slot)
    }

    // El agregado de enlaces puede no existir, y eso NO es un error: es una OLT
    // sin LAG configurado.
    let agregados = null
    try {
      const salida = await display(sesion, 'display link-aggregation all')
      agregados = /does not exist/i.test(salida) ? [] : salida.trim()
    } catch {
      agregados = null
    }

    const placas = []
    for (const slot of aRevisar) {
      const placa = parsePuertosPlaca(await display(sesion, `display board 0/${slot}`))
      if (!placa.puertos.length) continue

      for (const p of placa.puertos) {
        try {
          const vlans = parseVlansDePuerto(
            await display(sesion, `display port vlan 0/${slot}/${p.puerto}`),
          )
          Object.assign(p, vlans, { rangos: comprimirRangos(vlans.vlans) })
        } catch (err) {
          // Sin las VLANs el puerto sigue siendo útil —velocidad, enlace— pero
          // hay que decir que esa parte no se pudo leer.
          p.vlans = null
          p.error_vlans = err.message
        }
      }

      placas.push({ slot, ...placa })
    }

    return { placas, agregados }
  })
}

/**
 * Agrega o quita VLANs de puertos de subida.
 *
 *   port vlan <lista> <frame>/<slot> <lista-puertos>
 *   undo port vlan <lista> <frame>/<slot> <lista-puertos>
 *
 * Sintaxis confirmada con la ayuda del equipo, sin llegar nunca a formar un
 * comando ejecutable durante el relevamiento.
 *
 * # Las dos protecciones
 *
 * **La VLAN nativa no se toca.** Sacarla del troncal deja el puerto sin poder
 * cursar el tráfico sin etiquetar, que es por donde suele ir la gestión.
 *
 * **Una VLAN con abonados no se saca sin insistir.** Quitar la 200 de este
 * equipo deja a noventa clientes sin salida, todos en el mismo segundo, y desde
 * el lado GPON no se ve nada raro: las ONTs siguen online. Es de las averías
 * que más tardan en diagnosticarse, así que el sistema exige `forzar` y dice
 * cuántos son.
 */
export async function cambiarVlansDeUplink(
  olt,
  { slot, puertos, vlans, quitar = false, forzar = false, crear = false },
) {
  if (slot == null) throw badRequest('Falta el slot')
  if (!vlans?.length) throw badRequest('No se indicó ninguna VLAN')
  if (!puertos?.length) throw badRequest('No se indicó ningún puerto')

  const creadas = []

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const conUso = parseVlansConUso(await display(sesion, 'display vlan all'))

    // La protección FALLA CERRADA. Si no se pudo leer la tabla de VLANs, no se
    // sabe cuántos abonados hay detrás de cada una — y "no sé" nunca puede
    // interpretarse como "ninguno". Se vio la lectura volver vacía en una
    // corrida real; sin esto, ese momento habría dejado pasar el quite de una
    // VLAN con noventa clientes.
    if (!conUso.length) {
      throw new AppError('No se pudo leer qué VLANs tiene el equipo', {
        status: 502,
        hint: 'Sin esa lista no se puede saber cuántos abonados quedarían sin servicio. Reintentá.',
      })
    }

    const afectados = vlans
      .map((v) => conUso.find((x) => x.vlan === v))
      .filter((x) => x && x.abonados > 0)

    if (!quitar) {
      // Una VLAN que no existe en el equipo no se puede asignar a un puerto: el
      // comando falla con "VLAN does not exist". Se avisa antes, con el número
      // concreto, en vez de dejar que el operador lea un error del equipo.
      const inexistentes = vlans.filter((v) => !conUso.some((x) => x.vlan === v))
      if (inexistentes.length && !crear) {
        throw new AppError(
          `La VLAN ${inexistentes.join(', ')} no existe en el equipo`,
          {
            status: 409,
            hint: 'Hay que crearla antes de poder ponerla en un troncal. Repetí con crear = true y se crea como smart.',
          },
        )
      }

      for (const v of inexistentes) {
        await escribirOFallar(sesion, `vlan ${v} smart`, `No se pudo crear la VLAN ${v}`)
        creadas.push(v)
      }
    }

    if (quitar) {
      // La nativa de cada puerto, leída del equipo y no supuesta.
      const placa = parsePuertosPlaca(await display(sesion, `display board 0/${slot}`))
      const nativas = new Set(
        placa.puertos.filter((p) => puertos.includes(p.puerto)).map((p) => p.vlan_nativa),
      )
      const choca = vlans.filter((v) => nativas.has(v))
      if (choca.length) {
        throw new AppError(
          `La VLAN ${choca.join(', ')} es la nativa de alguno de esos puertos y no se puede quitar`,
          {
            status: 409,
            hint: 'Sin VLAN nativa el puerto deja de cursar el tráfico sin etiquetar. Cambiala primero si de verdad hace falta.',
          },
        )
      }

      if (afectados.length && !forzar) {
        const detalle = afectados.map((a) => `VLAN ${a.vlan}: ${a.abonados} abonados`).join(' · ')
        throw new AppError(`Esas VLANs tienen abonados colgando (${detalle})`, {
          status: 409,
          hint:
            'Quitarlas del troncal los deja sin salida en el mismo segundo, y desde el lado GPON no se ve nada raro: ' +
            'las ONTs siguen online. Si es a propósito, repetí con forzar = true.',
          detalle,
        })
      }
    }

    const lista = comprimirRangos(vlans)
    const listaPuertos = comprimirRangos(puertos)
    const comando = `${quitar ? 'undo ' : ''}port vlan ${lista.replace(/, /g, ',')} 0/${slot} ${listaPuertos.replace(/, /g, ',')}`

    await escribirOFallar(sesion, comando, 'La OLT rechazó el cambio de VLANs')

    // Se relee para confirmar: el equipo puede aceptar el comando y aplicar algo
    // distinto de lo pedido, y decir "listo" sin verificar sería adivinar.
    const despues = []
    for (const p of puertos) {
      const r = parseVlansDePuerto(await display(sesion, `display port vlan 0/${slot}/${p}`))
      despues.push({ puerto: p, vlans: r.vlans, rangos: comprimirRangos(r.vlans) })
    }

    return {
      comando,
      quitar,
      creadas,
      abonados_afectados: afectados.reduce((a, x) => a + x.abonados, 0),
      puertos: despues,
    }
  })
}

/**
 * Acciones masivas sobre los puertos de una placa.
 *
 * Se recorre puerto por puerto porque este firmware NO tiene un atajo: `port
 * all` solo admite `online-ont-threshold`, no el láser ni el auto-find. Lo
 * verifiqué con la ayuda del equipo antes de escribir esto.
 *
 * Cada puerto se reporta por separado. Que falle el 7 no puede impedir que se
 * apliquen el 8 al 15, y tampoco puede desaparecer sin dejar rastro: un
 * silencio se leería como "salió bien".
 */
export async function aplicarAPuertos(olt, { slot, puertos = 16, accion }) {
  const COMANDOS = {
    // Enciende el láser del puerto: es el "habilitar" de un puerto PON.
    encender: (p) => `port ${p} laser-switch on`,
    apagar: (p) => `port ${p} laser-switch off`,
    // Con el auto-find apagado, una ONT nueva se conecta y el equipo no la
    // reporta: el técnico la instala y nadie se entera de que está ahí.
    autofind_on: (p) => `port ${p} ont-auto-find enable`,
    autofind_off: (p) => `port ${p} ont-auto-find disable`,
    // Deja sin servicio a TODOS los abonados del puerto por uno o dos minutos.
    reiniciar_onts: (p) => `ont reset graceful ${p} all`,
  }

  const armar = COMANDOS[accion]
  if (!armar) {
    throw badRequest(`Acción desconocida: ${accion}`, {
      hint: `Válidas: ${Object.keys(COMANDOS).join(', ')}`,
    })
  }
  if (slot == null) throw badRequest('Falta el slot')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame: 0, slot })

    const hechos = []
    const fallos = []

    for (let puerto = 0; puerto < puertos; puerto++) {
      const comando = armar(puerto)
      try {
        const fallo = detectarFallo(await escribir(sesion, comando))
        if (fallo) fallos.push({ puerto, comando, motivo: fallo })
        else hechos.push({ puerto, comando })
      } catch (err) {
        fallos.push({ puerto, comando, motivo: err.message })
      }
    }

    return { slot, accion, hechos, fallos }
  })
}

/**
 * Reinicia las ONTs de un puerto.
 *
 * `ont reset <portid> all` — sintaxis confirmada con la ayuda del equipo, sin
 * llegar nunca a ejecutar un comando completo durante el relevamiento.
 *
 * `graceful` le avisa a la ONT antes de tirarla, en vez de cortarle la
 * alimentación de golpe. Es lo que corresponde cuando del otro lado hay gente
 * mirando una película.
 *
 * Esto DEJA SIN SERVICIO a todos los abonados del puerto por uno o dos minutos.
 */
export async function reiniciarOnts(olt, { slot, puerto, ontId, graceful = true }) {
  if (slot == null || puerto == null) throw badRequest('Faltan el slot o el puerto')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame: 0, slot })

    const objetivo = ontId == null ? 'all' : ontId
    const comando = `ont reset${graceful ? ' graceful' : ''} ${puerto} ${objetivo}`

    const salida = await escribirOFallar(sesion, comando, 'La OLT rechazó el reinicio')

    return { slot, puerto, objetivo, comando, salida: salida.trim().slice(0, 300) }
  })
}

/**
 * Corre comandos y devuelve la salida cruda junto con si el equipo los rechazó.
 *
 * Es la herramienta del relevamiento: preguntarle al equipo qué entiende ANTES
 * de escribir un parser contra lo que dice la documentación. Escribir los
 * parsers al revés —de la doc al código— es lo que costó horas en los drivers de
 * ONU, y la lección quedó cara.
 */
export async function relevar(olt, comandos) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const salidas = []
    for (const comando of comandos) {
      try {
        const salida = await display(sesion, comando)
        salidas.push({ comando, salida, rechazo: detectarFallo(salida) })
      } catch (err) {
        salidas.push({ comando, salida: '', rechazo: err.message })
      }
    }
    return salidas
  })
}

// --- Descubrimiento ---------------------------------------------------------

/** `display ont info <portid> all` */
export async function listarOnts(olt, { frame = 0, slot, puerto }) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })
    const salida = await display(sesion, `display ont info ${puerto} all`)
    return parseOntInfoAll(salida).map((o) => ({ ...o, frame, slot, puerto }))
  })
}

/** `display ont autofind <portid>` — ONTs nuevas sin registrar */
export async function listarAutofind(olt, { frame = 0, slot, puerto }) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })
    const salida = await display(sesion, `display ont autofind ${puerto}`)
    return parseAutofind(salida).map((o) => ({
      ...o,
      frame: o.frame ?? frame,
      slot: o.slot ?? slot,
      puerto: o.puerto ?? puerto,
    }))
  })
}

/** Barre todos los puertos del slot buscando ONTs sin registrar. */
export async function escanearAutofind(olt, { frame = 0, slot, puertos = 8 }) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })

    const encontradas = []
    for (let puerto = 0; puerto < puertos; puerto++) {
      const salida = await display(sesion, `display ont autofind ${puerto}`)
      for (const o of parseAutofind(salida)) {
        encontradas.push({
          ...o,
          frame: o.frame ?? frame,
          slot: o.slot ?? slot,
          puerto: o.puerto ?? puerto,
        })
      }
    }
    return encontradas
  })
}

// --- Aprovisionamiento ------------------------------------------------------

/**
 * Registra una ONT. Si no se pasa ontId, se calcula el primero libre del puerto.
 * `ont add <portid> <ontid> sn-auth <SN> omci [desc <texto>]`
 */
export async function registrarOnt(
  olt,
  { frame = 0, slot, puerto, ontId, sn, descripcion, lineProfileId, srvProfileId },
) {
  if (!sn) throw badRequest('Falta el SN de la ONT')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })

    let idFinal = ontId
    if (idFinal == null) {
      const salida = await display(sesion, `display ont info ${puerto} all`)
      const usados = new Set(parseOntInfoAll(salida).map((o) => o.ontId))
      idFinal = 0
      while (usados.has(idFinal) && idFinal <= 255) idFinal++
      if (idFinal > 255) {
        throw new AppError(`El puerto ${puerto} no tiene ONT-IDs libres (0-255 ocupados)`, {
          status: 409,
        })
      }
    }

    // La forma exacta salió del respaldo de configuración de este mismo equipo,
    // donde están escritas sus 85 ONTs. Tres detalles que no se adivinan:
    // la serie va en HEXADECIMAL y entre comillas, los perfiles van por ID
    // numérico —no por nombre— y la descripción también entre comillas.
    //
    //   ont add 0 1 sn-auth "48575443304D1BB2" omci
    //           ont-lineprofile-id 2 ont-srvprofile-id 7 desc "..."
    const partes = [`ont add ${puerto} ${idFinal} sn-auth "${aHexSn(sn)}" omci`]
    if (lineProfileId != null) partes.push(`ont-lineprofile-id ${lineProfileId}`)
    if (srvProfileId != null) partes.push(`ont-srvprofile-id ${srvProfileId}`)
    // Dos cosas antes de mandarla:
    //
    // 1. A ASCII. El equipo no guarda acentos ni la ñ: los pierde, no los
    //    convierte. "José Luis Oña Riera" quedó escrito "Jos_Luis_Oa_Riera" en
    //    la ONT de ese abonado — un apellido que ya no se puede buscar.
    // 2. Los espacios a guiones bajos, como están escritas las 85 que ya tiene
    //    el equipo. Con espacios, el equipo parte la descripción por las
    //    palabras al mostrarla y volver a leerla entera se vuelve adivinanza.
    if (descripcion) {
      const limpia = aAsciiParaEquipo(descripcion).replace(/"/g, "'").replace(/\s+/g, '_')
      partes.push(`desc "${limpia}"`)
    }

    const comando = partes.join(' ')
    await escribirOFallar(sesion, comando, 'La OLT rechazó el registro de la ONT')

    // Se relee. El equipo puede aceptar el comando y no dejar la ONT creada, y
    // devolver "listo" sin haber mirado es lo que dejó a un abonado guardado en
    // la base sin existir en el equipo.
    const quedo = parseConfigOnt(await display(sesion, `display ont info ${puerto} ${idFinal}`))
    if (!quedo) {
      throw new AppError(`La OLT aceptó el comando pero la ONT ${puerto}/${idFinal} no quedó creada`, {
        status: 502,
        detalle: comando,
        hint: 'No se guardó nada: el alta habría quedado solo en el sistema y no en el equipo.',
      })
    }

    return { frame, slot, puerto, ontId: idFinal, sn: normalizarSn(sn), comando }
  })
}

/**
 * Lista los perfiles de línea y de servicio que tiene cargados el equipo.
 *
 * El formulario de autorización los necesita para poder ofrecerlos, y el número
 * de ONTs que usa cada uno para saber cuál proponer: el que ya usan 76 abonados
 * es casi seguro el correcto para el 77.
 */
export async function listarPerfilesOnt(olt) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    return {
      line: parsePerfiles(await display(sesion, 'display ont-lineprofile gpon all')),
      srv: parsePerfiles(await display(sesion, 'display ont-srvprofile gpon all')),
    }
  })
}

/**
 * Crea el service-port: es lo que le da servicio real a la ONT.
 *
 * Registrarla con `ont add` solo la deja reconocida. Sin esto no pasa tráfico.
 *
 *   service-port <idx> vlan <vlan> gpon <f>/<s>/<p> ont <id> gemport <g>
 *     multi-service user-vlan <vlan> tag-transform translate
 *     inbound traffic-table index <in> outbound traffic-table index <out>
 *
 * El índice no lo asigna el equipo: hay que buscar uno libre. Reusar uno ocupado
 * le pisaría el servicio a otro abonado.
 */
export async function crearServicePort(
  olt,
  { frame = 0, slot, puerto, ontId, vlan, gemport = 1, ttEntrada, ttSalida },
) {
  if (vlan == null) throw badRequest('Falta la VLAN del service-port')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const usados = parseIndicesServicePort(await display(sesion, 'display service-port all'))
    const indice = primerIndiceLibre(usados)

    const partes = [
      `service-port ${indice} vlan ${vlan} gpon ${frame}/${slot}/${puerto} ont ${ontId}`,
      `gemport ${gemport} multi-service user-vlan ${vlan} tag-transform translate`,
    ]
    // Sin traffic tables la ONT queda con servicio pero sin límite de velocidad.
    // Se permite a propósito: es mejor un abonado conectado sin shaping que un
    // alta que falla entera porque su plan no tiene índice asignado.
    if (ttEntrada != null && ttSalida != null) {
      partes.push(`inbound traffic-table index ${ttEntrada} outbound traffic-table index ${ttSalida}`)
    }

    const comando = partes.join(' ')
    await escribirOFallar(sesion, comando, 'La OLT rechazó el service-port', {
      hint: 'La ONT quedó registrada. Sin service-port no pasa tráfico: revisá la VLAN y el gemport.',
    })

    return { indice, comando, sinVelocidad: ttEntrada == null || ttSalida == null }
  })
}

/**
 * Los service-ports de una ONT: su índice, su VLAN y su estado.
 *
 * Hace falta para las dos operaciones sobre una ONT ya instalada. Una ONT
 * suele tener más de uno —el de internet y el de gestión— y tocar solo el
 * primero deja la mitad del servicio con la configuración vieja.
 */
export async function listarServicePortsDeOnt(olt, { frame = 0, slot, puerto, ontId }) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    const salida = await display(
      sesion,
      `display service-port port ${frame}/${slot}/${puerto} ont ${ontId}`,
    )
    return parseServicePortsDeOnt(salida)
  })
}

/**
 * Todo lo que define a una ONT: sus perfiles, su descripción y sus
 * service-ports con VLAN y traffic-tables.
 *
 * Es la foto que hay que sacar ANTES de moverla de puerto. Mover una ONT en
 * Huawei es borrarla y recrearla —no existe un comando de mover— así que si
 * esta lectura sale incompleta, el abonado vuelve distinto de como estaba.
 */
export async function leerConfigCompletaOnt(olt, { frame = 0, slot, puerto, ontId }) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const servicePorts = parseServicePortsDeOnt(
      await display(sesion, `display service-port port ${frame}/${slot}/${puerto} ont ${ontId}`),
    )

    await entrarInterfaz(sesion, { frame, slot })

    // La salida son diez mil caracteres y a veces llega cortada: el lector
    // termina en un silencio del medio del volcado. Cuando eso pasa, los
    // perfiles quedan en null y la foto sale creíble pero incompleta.
    //
    // Eso ya hizo daño: al mover una ONT con la foto cortada, el `ont add` salió
    // sin `ont-srvprofile-id` y el equipo la recreó con el perfil por defecto.
    // La ONT "volvió" —misma descripción, mismo perfil de línea— pero con otra
    // configuración de puertos. Por eso se reintenta, y si sigue incompleta se
    // corta acá en vez de seguir con datos a medias.
    let config = null
    for (let intento = 0; intento < 3 && !completa(config); intento++) {
      config = parseConfigOnt(await display(sesion, `display ont info ${puerto} ${ontId}`))
    }

    if (!config) {
      throw new AppError(`No se pudo leer la configuración de la ONT ${puerto}/${ontId}`, {
        status: 502,
        hint: 'Sin ella no se puede recrear igual en otro puerto.',
      })
    }

    return { frame, slot, puerto, ontId, ...config, servicePorts, completa: completa(config) }
  })
}

/**
 * Mueve una ONT a otro puerto PON.
 *
 * No hay comando de mover: se borra del puerto viejo y se crea en el nuevo con
 * la misma configuración. Eso significa que el abonado queda sin servicio unos
 * segundos y que, si algo falla en el medio, queda sin servicio y sin
 * configuración.
 *
 * Por eso el orden es: leer TODO primero, y recién después tocar. La foto se
 * devuelve siempre —salga bien o mal— para que se pueda rehacer a mano si algo
 * se rompe a mitad de camino.
 *
 * Esto es la parte de software. La fibra la mueve una persona: si el pigtail
 * sigue en el puerto viejo, la ONT no va a levantar en el nuevo.
 */
export async function moverOnt(olt, { frame = 0, slot, puerto, ontId, nuevoSlot, nuevoPuerto }) {
  const destinoSlot = nuevoSlot ?? slot
  if (destinoSlot === slot && nuevoPuerto === puerto) {
    throw badRequest('El puerto de destino es el mismo que el de origen')
  }

  const foto = await leerConfigCompletaOnt(olt, { frame, slot, puerto, ontId })

  // Antes de borrar nada. Con la foto a medias la ONT se recrearía con el perfil
  // por defecto: vuelve a estar online, con el mismo nombre, y con otra
  // configuración de puertos. Nadie lo relaciona con la mudanza.
  if (!completa(foto)) {
    throw new AppError('No se leyó completa la configuración de la ONT', {
      status: 502,
      hint:
        `Falta ${!foto.sn ? 'la serie' : foto.lineProfileId == null ? 'el perfil de línea' : 'el perfil de servicio'}. ` +
        'No se tocó nada: sin eso la ONT volvería distinta de como estaba. Probá de nuevo.',
      foto,
    })
  }

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    const hechos = []

    const correr = async (comando, contexto) => {
      const salida = await escribir(sesion, comando)
      const fallo = detectarFallo(salida)
      if (fallo) {
        throw new AppError(`Falló ${contexto}: ${fallo}`, {
          status: 400,
          detalle: comando,
          hint: `Se hicieron antes: ${hechos.join(' · ') || 'nada'}. La foto de la configuración original está en la respuesta.`,
          foto,
        })
      }
      hechos.push(comando)
      return salida
    }

    // 1. Sacar los service-ports viejos.
    for (const sp of foto.servicePorts) {
      await correr(`undo service-port ${sp.indice}`, `borrar el service-port ${sp.indice}`)
    }

    // 2. Borrar la ONT del puerto viejo.
    await entrarInterfaz(sesion, { frame, slot })
    const falloBorrado = detectarFallo(await escribir(sesion, `ont delete ${puerto} ${ontId}`))
    if (falloBorrado) {
      throw new AppError(`No se pudo borrar la ONT del puerto viejo: ${falloBorrado}`, {
        status: 400,
        hint: `Ya se borraron sus ${foto.servicePorts.length} service-ports: el abonado está sin servicio. La foto está en la respuesta.`,
        foto,
      })
    }
    hechos.push(`ont delete ${puerto} ${ontId}`)

    // 3. Crearla en el puerto nuevo, con la misma configuración.
    if (destinoSlot !== slot) await entrarInterfaz(sesion, { frame, slot: destinoSlot })

    const partes = [`ont add ${nuevoPuerto} sn-auth "${aHexSn(foto.sn)}" omci`]
    if (foto.lineProfileId != null) partes.push(`ont-lineprofile-id ${foto.lineProfileId}`)
    if (foto.srvProfileId != null) partes.push(`ont-srvprofile-id ${foto.srvProfileId}`)
    if (foto.descripcion) partes.push(`desc "${foto.descripcion.replace(/"/g, "'")}"`)

    // Sin ONT-ID explícito el equipo asigna el primero libre del puerto nuevo:
    // el viejo puede estar ocupado ahí.
    const alta = partes.join(' ')
    const falloAlta = detectarFallo(await escribir(sesion, alta))
    if (falloAlta) {
      throw new AppError(`No se pudo crear la ONT en el puerto nuevo: ${falloAlta}`, {
        status: 400,
        detalle: alta,
        hint: 'La ONT ya se borró del puerto viejo: el abonado está sin servicio. La foto está en la respuesta para poder rehacerla a mano.',
        foto,
      })
    }
    hechos.push(alta)

    // Qué ONT-ID le tocó.
    const nuevas = parseOntInfoAll(await display(sesion, `display ont info ${nuevoPuerto} all`))
    const creada = nuevas.find((o) => normalizarSn(o.sn) === normalizarSn(foto.sn))
    const nuevoOntId = creada?.ontId

    if (nuevoOntId == null) {
      throw new AppError('La ONT se creó pero no aparece en el puerto nuevo', {
        status: 502,
        hint: 'Revisá a mano antes de seguir. La foto está en la respuesta.',
        foto,
      })
    }

    // 4. Rehacer los service-ports.
    await sesion.run('quit')
    const usados = parseIndicesServicePort(await display(sesion, 'display service-port all'))
    const nuevosSp = []

    for (const sp of foto.servicePorts) {
      const indice = primerIndiceLibre(usados)
      usados.add(indice)

      // Una ONT autorizada sin plan no tiene traffic tables: sus columnas vienen
      // con un guion. Escribir "index null" haría fallar el comando y la dejaría
      // sin service-port después de haberla borrado del puerto viejo.
      const conVelocidad =
        sp.ttEntrada != null && sp.ttSalida != null
          ? ` inbound traffic-table index ${sp.ttEntrada} outbound traffic-table index ${sp.ttSalida}`
          : ''

      const comando =
        `service-port ${indice} vlan ${sp.vlan} gpon ${frame}/${destinoSlot}/${nuevoPuerto} ` +
        `ont ${nuevoOntId} gemport ${sp.gemport} multi-service user-vlan ${sp.userVlan} tag-transform translate` +
        conVelocidad

      await correr(comando, `recrear el service-port de la VLAN ${sp.vlan}`)
      nuevosSp.push({ indice, vlan: sp.vlan })
    }

    return {
      ok: true,
      desde: { slot, puerto, ontId },
      hasta: { slot: destinoSlot, puerto: nuevoPuerto, ontId: nuevoOntId },
      sn: foto.sn,
      servicePorts: nuevosSp,
      comandos: hechos,
      foto,
    }
  })
}

/**
 * Cambia la velocidad de una ONT.
 *
 * SIN cortar el servicio: el equipo deja modificar las traffic-tables de un
 * service-port existente —lo confirmé con su propia ayuda— así que no hay que
 * borrarlo y recrearlo. Rehacerlo dejaría al abonado sin internet unos
 * segundos, y multiplicado por doscientos abonados en un cambio de plan masivo
 * eso es una tarde de reclamos.
 *
 *   service-port <idx> inbound traffic-table index <N> outbound traffic-table index <M>
 */
export async function cambiarPlanOnt(olt, { frame = 0, slot, puerto, ontId, ttEntrada, ttSalida }) {
  if (ttEntrada == null || ttSalida == null) {
    throw badRequest('Faltan los índices de traffic table', {
      hint: 'Salen del plan. Un plan sin índice no se puede aplicar en la OLT.',
    })
  }

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const puertos = parseServicePortsDeOnt(
      await display(sesion, `display service-port port ${frame}/${slot}/${puerto} ont ${ontId}`),
    )
    if (!puertos.length) {
      throw new AppError('Esa ONT no tiene ningún service-port', {
        status: 409,
        hint: 'Sin service-port no pasa tráfico: primero hay que crearle uno.',
      })
    }

    const comandos = []
    for (const sp of puertos) {
      const comando = `service-port ${sp.indice} inbound traffic-table index ${ttEntrada} outbound traffic-table index ${ttSalida}`
      const fallo = detectarFallo(await escribir(sesion, comando))
      if (fallo) {
        throw new AppError(`La OLT rechazó el cambio en el service-port ${sp.indice}: ${fallo}`, {
          status: 400,
          detalle: comando,
          hint: comandos.length
            ? `Ojo: ${comandos.length} service-ports ya se cambiaron. La ONT quedó a medias.`
            : undefined,
        })
      }
      comandos.push(comando)
    }

    return { slot, puerto, ontId, servicePorts: puertos.map((p) => p.indice), comandos }
  })
}

/**
 * Suspende una ONT sin borrarla.
 *
 * Es lo que corresponde para un corte por falta de pago: la configuración queda
 * intacta y se reactiva con un comando. Borrarla obligaría a darla de alta de
 * nuevo cuando el abonado pague.
 */
export async function activarOnt(olt, { frame = 0, slot, puerto, ontId, activar = true }) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })

    const comando = `ont ${activar ? 'activate' : 'deactivate'} ${puerto} ${ontId}`
    await escribirOFallar(
      sesion,
      comando,
      `La OLT rechazó ${activar ? 'activar' : 'suspender'} la ONT`,
    )
    return { slot, puerto, ontId, activa: activar, comando }
  })
}

/**
 * `ont delete <portid> <ontid>`, limpiando antes sus service-ports.
 *
 * El orden importa: borrar la ONT dejando sus service-ports colgados deja
 * índices ocupados por un abonado que ya no existe, y esos índices son un
 * recurso finito del equipo.
 */
export async function eliminarOnt(olt, { frame = 0, slot, puerto, ontId }) {
  if (ontId == null) throw badRequest('Falta el ONT-ID a eliminar')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    // Primero los service-ports, desde el modo config.
    const servicePorts = parseServicePortsDeOnt(
      await display(sesion, `display service-port port ${frame}/${slot}/${puerto} ont ${ontId}`),
    )
    const limpiados = []
    for (const sp of servicePorts) {
      const comando = `undo service-port ${sp.indice}`
      if (!detectarFallo(await escribir(sesion, comando))) limpiados.push(sp.indice)
    }

    await entrarInterfaz(sesion, { frame, slot })

    // El borrado pide confirmación: "Are you sure to delete the ONT? (y/n)[n]:",
    // y escribir() la contesta.
    const comando = `ont delete ${puerto} ${ontId}`
    const salida = await escribir(sesion, comando)

    const fallo = detectarFallo(salida)
    if (fallo) {
      throw new AppError(`La OLT rechazó el borrado: ${fallo}`, {
        status: 400,
        detalle: comando,
        hint: limpiados.length
          ? `Se borraron antes ${limpiados.length} service-ports (${limpiados.join(', ')}). La ONT quedó sin servicio pero todavía registrada.`
          : undefined,
      })
    }

    return { ok: true, comando, servicePortsBorrados: limpiados }
  })
}

// --- Telemetría -------------------------------------------------------------

/**
 * Potencia óptica, versión y distancia de una ONT.
 * OJO: estas tres lecturas son OMCI en vivo — si la ONT está offline la OLT no
 * puede responderlas (docs/comandos-referencia.md § 4).
 */
export async function leerMetricas(olt, { frame = 0, slot, puerto, ontId }) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })

    const salidaOptica = await display(sesion, `display ont optical-info ${puerto} ${ontId}`)
    const optica = parseOpticalInfo(salidaOptica)

    // `display ont info` se pide siempre, también con la ONT caída: es donde
    // está la causa de la última caída, que es justo lo que hace falta saber
    // cuando no responde.
    const salidaInfo = await display(sesion, `display ont info ${puerto} ${ontId}`)
    const caida = parseCausaCaida(salidaInfo)

    if (!optica) {
      return {
        online: false,
        ...caida,
        mensaje:
          caida.causa === 'power_off'
            ? 'La ONT está caída por falta de energía en el domicilio del abonado (dying gasp), no por un problema de fibra.'
            : 'La OLT no devolvió potencia óptica. La ONT tiene que estar online: es una lectura OMCI en vivo.',
      }
    }

    const salidaVersion = await display(sesion, `display ont version ${puerto} ${ontId}`)

    return {
      online: true,
      ...optica,
      ...caida,
      version: parseOntVersion(salidaVersion),
      distanciaM: parseDistancia(salidaInfo),
    }
  })
}

// --- Perfiles y planes ------------------------------------------------------

/**
 * ont-lineprofile gpon profile-name "<nombre>" / vlan-map <gemport> <vlan> / commit
 */
export async function crearLineProfile(olt, { nombre, vlan, gemport = 1 }) {
  if (!nombre || !vlan) throw badRequest('Faltan nombre o VLAN del line profile')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const comandos = [
      `ont-lineprofile gpon profile-name "${nombre}"`,
      `vlan-map ${gemport} ${vlan}`,
      'commit',
      'quit',
    ]
    const resultados = await sesion.runAll(comandos)

    for (const { comando, salida } of resultados) {
      const fallo = detectarFallo(salida)
      if (fallo) {
        throw new AppError(`La OLT rechazó "${comando}": ${fallo}`, { status: 400 })
      }
    }

    return { ok: true, comandos }
  })
}

/**
 * traffic table ip index <idx> name "<nombre>" cir <subida> pir <bajada> priority <p>
 *
 * cir/pir van en kbps. cir = caudal garantizado, pir = pico permitido.
 */
export async function crearTrafficTable(olt, { index, nombre, cir, pir, priority = 0 }) {
  if (index == null || !nombre) throw badRequest('Faltan index o nombre de la traffic table')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    // La forma completa, copiada de las tablas que el propio equipo ya tiene
    // cargadas. Sin la política de prioridad del final, el equipo contesta
    // "% Incomplete command" y no crea nada — y eso pasaba por bueno, dejando
    // al plan apuntando a una tabla que nunca existió.
    const comando =
      `traffic table ip index ${index} name "${nombre}" cir ${cir} pir ${pir ?? cir} ` +
      `priority ${priority} inner-priority ${priority} priority-policy local-setting`

    const salida = await escribirOFallar(sesion, comando, 'La OLT rechazó la traffic table')

    // Se exige la confirmación explícita del equipo. Que no haya error no es lo
    // mismo que que se haya creado.
    if (!/successfully/i.test(normalizarHuawei(salida))) {
      throw new AppError(`La OLT no confirmó la creación de la traffic table ${index}`, {
        status: 502,
        detalle: normalizarHuawei(salida).split('\n').slice(-4).join(' ').trim(),
      })
    }

    return { ok: true, comando }
  })
}

/**
 * Qué VLANs tiene puestas cada puerto PON, según el equipo.
 *
 * Se lee de los service-ports, que son los que llevan la VLAN de verdad. Un
 * solo comando para toda la OLT: preguntar puerto por puerto son treinta y dos
 * viajes y esto es un vistazo.
 *
 * Es distinto de lo que guarda nuestra base. Nosotros anotamos UNA VLAN por
 * ONU, y acá se ve que cada ONT tiene dos: la de internet y la de gestión. Un
 * puerto que en el sistema figura "solo con la 200" en realidad está pasando
 * también la 999, y esa diferencia importa a la hora de tocar troncales.
 */
export async function leerVlansPorPuerto(olt) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const filas = parseServicePortsPorPuerto(await display(sesion, 'display service-port all'))

    // Agrupado por puerto, con cuántos service-ports tiene cada VLAN. El número
    // sirve para distinguir la VLAN de todos los abonados de una que quedó
    // suelta en un service-port viejo.
    const porPuerto = new Map()
    for (const f of filas) {
      const clave = `${f.slot}/${f.puerto}`
      if (!porPuerto.has(clave)) {
        porPuerto.set(clave, { slot: f.slot, puerto: f.puerto, vlans: new Map(), onts: new Set() })
      }
      const p = porPuerto.get(clave)
      p.vlans.set(f.vlan, (p.vlans.get(f.vlan) ?? 0) + 1)
      p.onts.add(f.ontId)
    }

    return [...porPuerto.values()]
      .map((p) => ({
        slot: p.slot,
        puerto: p.puerto,
        onts: p.onts.size,
        vlans: [...p.vlans]
          .map(([vlan, service_ports]) => ({ vlan, service_ports }))
          .sort((a, b) => a.vlan - b.vlan),
      }))
      .sort((a, b) => a.slot - b.slot || a.puerto - b.puerto)
  })
}

/** Escotilla de escape: ejecutar comandos crudos (útil durante el taller). */
export async function ejecutarCrudo(olt, comandos) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    return sesion.runAll(comandos)
  })
}

/**
 * `display log cli all`: los comandos que ejecutaron los usuarios de CLI,
 * SmartOLT incluido. Es largo y paginado, por eso lleva más tiempo y páginas.
 */
export async function leerRegistroCli(olt) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    const hint = await sesion.run('display log cli all')
    const resto = await sesion.run('', {
      esperaMinimaMs: config.ssh.esperaSalidaMs,
      timeoutMs: 300000,
      maxPaginas: 20000,
    })
    return `${hint}\n${resto}`
  })
}

// --- Acciones sobre UNA ONT, las del taller ---------------------------------

/**
 * Vuelve a registrar la ONT para que la OLT le reenvíe su configuración.
 *
 *   ont re-register <puerto> <ontId>
 *
 * Es lo que hace falta cuando la configuración por TR069 no llegó a aplicarse:
 * la ONT está online, el sistema dice que está todo bien, y el abonado no tiene
 * servicio o le falta parte. Forzar el re-registro hace que la OLT le vuelva a
 * empujar todo por OMCI y TR069.
 *
 * Corta el servicio unos segundos: la ONT se reasocia.
 */
/**
 * La IP de gestión de la ONT: la que usa el ACS para configurarla.
 *
 *   ont ipconfig <puerto> <ontId> static ip-address <ip> mask <mask>
 *       gateway <gw> pri-dns <d1> slave-dns <d2> vlan <vlan>
 *
 * Sin esto la ONT está online y pasa tráfico, pero nadie puede hablarle: ni el
 * ACS para empujarle el usuario y la clave PPPoE, ni el sistema para leerle el
 * WiFi o reiniciarla. Es el eslabón que convierte un alta en un alta completa.
 *
 * La sintaxis se preguntó al equipo, nivel por nivel. La máscara NO es opcional
 * y va pegada a `ip-address`; el resto sí lo es.
 */
export async function configurarIpGestionOnt(
  olt,
  { frame = 0, slot, puerto, ontId, ip, mascara = '255.255.255.0', gateway, dns1, dns2, vlan, prioridad = 2 },
) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')
  if (!ip) throw badRequest('Falta la dirección de gestión')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })

    // La prioridad elige el gemport: los line profiles de esta OLT mapean por
    // 802.1p (0/7 → gem 1, 2 → gem 2, 5 → gem 3) y el service-port de gestión
    // va en el gem 2. Sin `priority`, la OLT pone 5 y la gestión sale por un
    // gem sin service-port: IP configurada, nada llega al ACS.
    // `priority` solo se acepta después de `vlan`.
    const comando =
      `ont ipconfig ${puerto} ${ontId} static ip-address ${ip} mask ${mascara}` +
      (gateway ? ` gateway ${gateway}` : '') +
      (dns1 ? ` pri-dns ${dns1}` : '') +
      (dns2 ? ` slave-dns ${dns2}` : '') +
      (vlan != null ? ` vlan ${vlan}` + (prioridad != null ? ` priority ${prioridad}` : '') : '')

    await escribirOFallar(sesion, comando, 'La OLT rechazó la IP de gestión', {
      hint: 'Revisá que la VLAN de gestión exista en el equipo y que la ONT esté online.',
    })

    // Se relee. Que el comando no diera error no significa que el equipo lo
    // haya tomado: una ONT que no soporta configuración estática lo acepta y
    // deja la dirección en blanco, y el alta seguiría creyendo que quedó lista.
    const leido = parseOntIpconfig(await display(sesion, `display ont ipconfig ${puerto} ${ontId}`))

    if (!leido?.ip) {
      throw new AppError('El equipo aceptó el comando pero la ONT quedó sin IP de gestión', {
        status: 502,
        comando,
        hint: 'Puede que el modelo no soporte configuración estática. Probá con DHCP.',
      })
    }
    if (leido.ip !== ip) {
      throw new AppError(`Se pidió ${ip} y la ONT quedó con ${leido.ip}`, {
        status: 502,
        comando,
        leido,
      })
    }

    return { slot, puerto, ontId, comando, ...leido }
  })
}

/**
 * La IP de gestión, pero por DHCP en vez de estática.
 *
 *   ont ipconfig <puerto> <ontId> dhcp [vlan <vlan>]
 *
 * El mismo eslabón que la versión estática, para el caso de que la red de
 * gestión reparta por DHCP en vez de con direcciones fijas por pool. La VLAN
 * es opcional en el equipo, pero acá se pide igual: sin ella la ONT intenta
 * el DHCP en la VLAN nativa, que casi nunca es la de gestión.
 */
export async function configurarIpGestionOntDhcp(olt, { frame = 0, slot, puerto, ontId, vlan, prioridad = 2 }) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })

    // Misma prioridad que la estática: es la que manda la gestión al gem 2.
    const comando =
      `ont ipconfig ${puerto} ${ontId} dhcp` +
      (vlan != null ? ` vlan ${vlan}` + (prioridad != null ? ` priority ${prioridad}` : '') : '')

    await escribirOFallar(sesion, comando, 'La OLT rechazó el DHCP de gestión', {
      hint: 'Revisá que la VLAN de gestión exista en el equipo y que la ONT esté online.',
    })

    // Igual que en la estática: que el comando no diera error no prueba que
    // el equipo haya quedado pidiendo DHCP de verdad.
    const leido = parseOntIpconfig(await display(sesion, `display ont ipconfig ${puerto} ${ontId}`))

    if (!leido || !/dhcp/i.test(leido.tipo ?? '')) {
      throw new AppError('El equipo aceptó el comando pero la ONT no quedó en modo DHCP', {
        status: 502,
        comando,
        leido,
      })
    }

    return { slot, puerto, ontId, comando, ...leido }
  })
}

/**
 * Saca la IP de gestión: la ONT queda pasando tráfico pero inalcanzable.
 *
 *   undo ont ipconfig <puerto> <ontId>
 *
 * Es "Inactive" en el otro lenguaje. No borra el perfil TR-069 ni el service-
 * port de gestión —esos son cosas distintas—, solo la dirección: después de
 * esto nadie llega a la ONT hasta que se le vuelva a poner una IP, estática o
 * por DHCP.
 */
export async function quitarIpGestionOnt(olt, { frame = 0, slot, puerto, ontId }) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })

    const comando = `undo ont ipconfig ${puerto} ${ontId}`
    await escribirOFallar(sesion, comando, 'La OLT rechazó sacar la IP de gestión')

    const leido = parseOntIpconfig(await display(sesion, `display ont ipconfig ${puerto} ${ontId}`))
    if (leido?.ip) {
      throw new AppError('El equipo aceptó el comando pero la ONT sigue con IP de gestión', {
        status: 502,
        comando,
        leido,
      })
    }

    return { slot, puerto, ontId, comando }
  })
}

/**
 * El modelo de muchas ONTs, en una sola sesión.
 *
 * El modelo no sale de `display ont info <puerto> all` —esa tabla trae serie,
 * estado y descripción, nada más— así que hay que preguntar ONT por ONT. Lo que
 * sí se puede es no abrir una sesión por cada una: entrando una vez por placa,
 * ochenta y siete consultas son un minuto y medio en vez de tres cuartos de
 * hora.
 *
 * Una ONT apagada no contesta su versión, y eso no es un error del barrido: se
 * anota y se sigue.
 */
export async function leerModelosDeOnts(olt, { onts, alAvanzar } = {}) {
  if (!onts?.length) return []

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const porSlot = new Map()
    for (const o of onts) {
      if (!porSlot.has(o.slot)) porSlot.set(o.slot, [])
      porSlot.get(o.slot).push(o)
    }

    const salida = []
    let hechas = 0

    for (const [slot, lista] of porSlot) {
      await entrarInterfaz(sesion, { frame: 0, slot })

      for (const o of lista) {
        try {
          const v = parseOntVersion(await display(sesion, `display ont version ${o.puerto} ${o.ontId}`))
          salida.push({
            ...o,
            // El parser ya trae el Equipment-ID bajo el nombre `modelo`:
            // HG8145X6-13. Es el mismo texto contra el que se resuelve la foto
            // del equipo y las características de su tipo.
            modelo: v?.modelo ?? null,
            version: v?.versionSoftware ?? null,
            leido: Boolean(v?.modelo),
          })
        } catch (err) {
          salida.push({ ...o, leido: false, error: err.message })
        }
        alAvanzar?.(++hechas, onts.length)
      }
    }

    return salida
  })
}

/**
 * Las IPs de gestión de muchas ONTs, en una sola sesión.
 *
 * Es un comando por ONT —el equipo no las lista juntas— pero entrando una vez
 * por placa en vez de una por ONT. Con noventa ONTs la diferencia es entre un
 * par de minutos y tres cuartos de hora.
 *
 * Una ONT que no contesta no corta el recorrido: se anota el motivo y se sigue.
 * En una migración, que falte una es un dato; que se corte a la mitad deja el
 * trabajo sin saber por dónde iba.
 */
export async function leerIpsGestionDeOnts(olt, { onts, alAvanzar } = {}) {
  if (!onts?.length) return []

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    // Agrupadas por placa: entrar a la interfaz es lo caro.
    const porSlot = new Map()
    for (const o of onts) {
      if (!porSlot.has(o.slot)) porSlot.set(o.slot, [])
      porSlot.get(o.slot).push(o)
    }

    const salida = []
    let hechas = 0

    for (const [slot, lista] of porSlot) {
      await entrarInterfaz(sesion, { frame: 0, slot })

      for (const o of lista) {
        try {
          const leido = parseOntIpconfig(
            await display(sesion, `display ont ipconfig ${o.puerto} ${o.ontId}`),
          )
          salida.push({ ...o, ...(leido ?? {}), leida: Boolean(leido?.ip) })
        } catch (err) {
          salida.push({ ...o, leida: false, error: err.message })
        }
        alAvanzar?.(++hechas, onts.length)
      }
    }

    return salida
  })
}

/** Lee la IP de gestión que tiene puesta una ONT. */
export async function leerIpGestionOnt(olt, { frame = 0, slot, puerto, ontId }) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })
    return parseOntIpconfig(await display(sesion, `display ont ipconfig ${puerto} ${ontId}`))
  })
}

/**
 * Cambia los perfiles de una ONT que ya está autorizada.
 *
 *   ont modify <puerto> <ontId> ont-srvprofile-id <n> [ont-lineprofile-id <m>]
 *
 * ── Por qué `ont modify` y no borrar y recrear ──
 *
 * Cambiar el perfil de servicio se puede hacer de dos maneras. La otra —borrar
 * la ONT y volver a crearla, que es lo que hace `moverOnt`— funciona, pero le
 * corta el servicio al abonado y le cambia el ONT-ID, y con eso quedan
 * desactualizados el `onu_index` guardado, los service-ports y cualquier cosa
 * que apunte a la ONT por su número.
 *
 * `ont modify` cambia el perfil en caliente. La ONT se reaprovisiona por OMCI
 * —unos segundos de interrupción— y conserva su ONT-ID.
 *
 * ── Verificado contra el equipo ──
 *
 * Se comprobó en un MA5800-X7 con MA5800V100R018C00 mandando el comando
 * incompleto contra un puerto sin ONTs. El equipo respondió ofreciendo el
 * siguiente parámetro:
 *
 *   { <cr>|ont-lineprofile-id<K>|ont-lineprofile-name<K> }
 *
 * O sea que acepta el perfil de servicio solo, o los dos juntos. El `<cr>` es
 * lo que permite mandar únicamente `ont-srvprofile-id`.
 *
 * ── Por qué exige al menos uno ──
 *
 * Un `ont modify` sin atributos deja al equipo esperando un parámetro que nunca
 * llega, y la sesión queda colgada a mitad de un prompt. Con la sesión guardada
 * del pool eso ensucia el comando siguiente, que es de lo más difícil de
 * diagnosticar: falla algo que no tiene nada que ver.
 */
export async function cambiarPerfilesOnt(
  olt,
  { frame = 0, slot, puerto, ontId, srvProfileId = null, lineProfileId = null },
) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')
  if (srvProfileId == null && lineProfileId == null) {
    throw badRequest('Hay que indicar al menos un perfil para cambiar')
  }

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })

    const partes = [`ont modify ${puerto} ${ontId}`]
    if (srvProfileId != null) partes.push(`ont-srvprofile-id ${srvProfileId}`)
    if (lineProfileId != null) partes.push(`ont-lineprofile-id ${lineProfileId}`)

    const comando = partes.join(' ')
    await escribirOFallar(sesion, comando, 'La OLT rechazó el cambio de perfil')

    /**
     * Lo que quedó de verdad, leído del equipo.
     *
     * No se devuelve lo que se pidió: si la OLT aceptó el comando pero aplicó
     * otra cosa —o lo aplicó a medias— hay que verlo. `display ont info <puerto>
     * <ontId>` es el que trae los dos perfiles; la versión `all` del mismo
     * comando no los muestra.
     */
    const ahora = parseConfigOnt(await display(sesion, `display ont info ${puerto} ${ontId}`))

    return {
      slot,
      puerto,
      ontId,
      comando,
      srvProfileId: ahora?.srvProfileId ?? srvProfileId,
      srvProfileNombre: ahora?.srvProfileNombre ?? null,
      lineProfileId: ahora?.lineProfileId ?? lineProfileId,
      lineProfileNombre: ahora?.lineProfileNombre ?? null,
    }
  })
}

/**
 * La WAN de una ONT: cómo sale a internet y con qué dirección.
 *
 *   display ont wan-info <puerto> <ontId>
 *
 * ── Qué se ve y qué no ──
 *
 * La consulta va por OMCI, y no todos los modelos la implementan. Las Huawei
 * contestan; un Skyworth GN256VH o un H3-1s devuelven "The ONT can not
 * support". Por eso el resultado trae `soportado`: una ONT que no sabe
 * contestar NO es una ONT sin WAN, y mostrar un hueco haría creer lo contrario.
 *
 * En esos modelos la WAN se mira por la página web del equipo o por TR-069.
 */
export async function leerWanDeOnt(olt, { frame = 0, slot, puerto, ontId }) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })
    return parseWanInfo(await display(sesion, `display ont wan-info ${puerto} ${ontId}`))
  })
}

/** Los perfiles de WAN que tiene la OLT, con cuántas ONTs usa cada uno. */
export async function listarWanProfiles(olt) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    return parseWanProfiles(await display(sesion, 'display ont wan-profile all'))
  })
}

/**
 * Crea o actualiza un perfil de WAN.
 *
 *   ont wan-profile profile-id <n> profile-name "<nombre>"
 *     connection-type <route|bridge>
 *     nat <enable|disable>
 *
 * ── Qué guarda un perfil y qué no ──
 *
 * SOLO el modo —enrutado o puente— y si hace NAT. Se comprobó leyendo el que
 * dejó otra herramienta en un MA5800-X7:
 *
 *   Connection type : Route
 *   NAT switch      : Enable
 *
 * La dirección IP, la máscara, el gateway y los DNS NO viven acá: se le mandan
 * a la ONT por TR-069 o se ponen en su página web. Quien espere configurarlos
 * desde este perfil va a buscar un campo que no existe.
 *
 * ── Por qué no se toca un perfil con vínculos ──
 *
 * Porque un perfil de WAN lo comparten todas las ONTs vinculadas: cambiarle el
 * modo a uno con veinte abonados encima los cambia a los veinte de una vez, sin
 * que nadie lo haya pedido. Para eso está crear otro.
 */
export async function asegurarWanProfile(
  olt,
  { profileId, nombre, tipo = 'route', nat = true, permitirPisar = false },
) {
  if (profileId == null) throw badRequest('Falta el número de perfil')
  if (!nombre?.trim()) throw badRequest('El perfil necesita un nombre')

  const existentes = await listarWanProfiles(olt)
  const yaEsta = existentes.find((p) => p.id === Number(profileId))

  if (yaEsta && yaEsta.vinculos > 0 && !permitirPisar) {
    throw new AppError(
      `El perfil ${profileId} ("${yaEsta.nombre}") lo usan ${yaEsta.vinculos} ONTs`,
      {
        status: 409,
        hint:
          'Cambiarlo se las cambia a todas de golpe. Usá un número libre para crear otro, o '
          + 'confirmá que querés pisar el que hay.',
      },
    )
  }

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const abrir = `ont wan-profile profile-id ${profileId} profile-name "${nombre.replace(/"/g, "'")}"`
    await escribirOFallar(sesion, abrir, 'La OLT rechazó el perfil de WAN')

    // Adentro de la vista del perfil. `quit` cierra y deja el equipo donde estaba.
    const dentro = [
      `connection-type ${tipo === 'bridge' ? 'bridge' : 'route'}`,
      `nat ${nat ? 'enable' : 'disable'}`,
    ]
    const aplicados = []
    for (const c of dentro) {
      const fallo = detectarFallo(await escribir(sesion, c))
      // Un parámetro que este firmware no acepta no tira abajo el perfil: se
      // informa cuál falló y el resto queda puesto.
      aplicados.push({ comando: c, ok: !fallo, error: fallo ?? null })
    }
    await escribir(sesion, 'quit')

    return { profileId: Number(profileId), nombre, tipo, nat, aplicados, creado: !yaEsta }
  })
}

/**
 * Vincula una WAN a la ONT.
 *
 *   ont wan-config <puerto> <ontId> ip-index <n> profile-id <m>
 *
 * ── Qué le cambia al abonado ──
 *
 * Todo: es cómo su equipo sale a internet. Una ONT que venía funcionando en
 * puente y pasa a enrutada deja de entregar la IP que entregaba, y al revés.
 * Por eso quien llama tiene que haberlo confirmado.
 *
 * `ip-index` es cuál de las WAN de la ONT se toca. La 1 es la de servicio; la
 * de gestión suele ir en otra. Se pide explícito para no pisar la de gestión
 * por defecto y dejar la ONT sin ACS.
 */
export async function vincularWanOnt(
  olt,
  { frame = 0, slot, puerto, ontId, ipIndex = 1, profileId },
) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')
  if (profileId == null) throw badRequest('Falta el perfil de WAN')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })

    const comando = `ont wan-config ${puerto} ${ontId} ip-index ${ipIndex} profile-id ${profileId}`
    const fallo = detectarFallo(await escribir(sesion, comando))

    if (fallo) {
      /**
       * "The IP interface does not exist" no es un índice mal elegido.
       *
       * `ip-index` NO crea una WAN: apunta a una interfaz IP que la ONT ya
       * declara por OMCI. Los modelos que no implementan esa parte del estándar
       * no declaran ninguna, así que TODOS los índices fallan igual — no hay uno
       * que funcione y el mensaje del equipo no lo dice.
       *
       * Se reconoce por la misma familia: las que devuelven "The ONT can not
       * support" al preguntarles su WAN son las que van a rechazar esto. En un
       * MA5800-X7 lo aceptó una HG8145X6-13 y lo rechazó un Skyworth GN256VH.
       *
       * Sin esta traducción, el próximo que lo intente prueba con el índice 2,
       * el 3 y el 4 antes de darse cuenta de que el problema es el modelo.
       */
      if (/IP interface does not exist/i.test(fallo)) {
        throw new AppError(
          'Esta ONT no acepta que la WAN se le configure desde la OLT',
          {
            status: 409,
            hint:
              'El modelo no declara interfaces IP por OMCI, así que ningún ip-index va a andar: '
              + 'no es que este índice esté mal. Su WAN se configura en la página web del equipo '
              + 'o por TR-069.',
            detalle: fallo,
            comando,
          },
        )
      }
      throw new AppError(`La OLT rechazó la configuración de WAN: ${fallo}`, {
        status: 400,
        detalle: comando,
      })
    }

    return { slot, puerto, ontId, ipIndex, profileId, comando }
  })
}

/** Saca la WAN de la ONT. La deja como estaba antes de configurársela. */
export async function desvincularWanOnt(olt, { frame = 0, slot, puerto, ontId, ipIndex = 1 }) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })

    const comando = `undo ont wan-config ${puerto} ${ontId} ip-index ${ipIndex}`
    await escribirOFallar(sesion, comando, 'La OLT rechazó sacar la WAN')

    return { slot, puerto, ontId, ipIndex, comando }
  })
}

export async function reprovisionarOnt(olt, { frame = 0, slot, puerto, ontId }) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })

    const comando = `ont re-register ${puerto} ${ontId}`
    await escribirOFallar(sesion, comando, 'La OLT rechazó el re-registro')
    return { slot, puerto, ontId, comando }
  })
}

/**
 * Devuelve la ONT a los valores de fábrica.
 *
 *   ont factory-setting-restore <puerto> <ontId> [completely]
 *
 * Borra TODO lo que configuró el usuario dentro del equipo: el nombre y la
 * contraseña del wifi, los reenvíos de puertos, lo que haya tocado. Después la
 * OLT le vuelve a aplicar la configuración de servicio, así que el internet
 * vuelve solo — pero el wifi del abonado queda con la clave de fábrica y va a
 * llamar preguntando por qué no se conecta.
 *
 * Con `completely` borra además los parámetros de servicio, conservando solo la
 * autenticación. Es más agresivo y se pide aparte a propósito.
 */
export async function restaurarFabricaOnt(
  olt,
  { frame = 0, slot, puerto, ontId, completamente = false },
) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })

    const comando = `ont factory-setting-restore ${puerto} ${ontId}${completamente ? ' completely' : ''}`
    await escribirOFallar(sesion, comando, 'La OLT rechazó la restauración de fábrica')
    return { slot, puerto, ontId, comando, completamente }
  })
}

/**
 * La configuración que la OLT tiene EN EJECUCIÓN para esta ONT.
 *
 *   display current-configuration ont <frame>/<slot>/<puerto> <ontId>
 *
 * La versión acotada, no el `display current-configuration` a secas: ése vuelca
 * las ochocientas líneas del equipo entero, deja la sesión inservible para los
 * comandos siguientes y de paso imprime los hashes de las contraseñas.
 */
export async function leerConfigActivaOnt(olt, { frame = 0, slot, puerto, ontId }) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    const salida = await display(
      sesion,
      `display current-configuration ont ${frame}/${slot}/${puerto} ${ontId}`,
    )

    // Se queda con las líneas de configuración y descarta el eco del comando,
    // el encabezado y el prompt: lo que sirve es lo que se puede copiar y pegar.
    const lineas = normalizarHuawei(salida)
      .split('\n')
      .filter((l) => /^\s*(ont|service-port|interface|#|\[)/.test(l))
      .map((l) => l.replace(/\s+$/, ''))

    return { frame, slot, puerto, ontId, lineas, texto: lineas.join('\n') }
  })
}

/**
 * Contadores de tráfico de un service-port.
 *
 *   display statistics service-port <index>
 *
 * Son ACUMULADOS desde que se creó el service-port, no una velocidad. La
 * velocidad sale de restar dos lecturas y dividir por el tiempo entre ellas —
 * eso lo hace el servicio, no acá.
 */
export async function leerEstadisticasServicePort(olt, { indice }) {
  if (indice == null) throw badRequest('Falta el índice del service-port')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    const salida = await display(sesion, `display statistics service-port ${indice}`)
    return { indice, ...parseEstadisticasServicePort(salida) }
  })
}

/**
 * Los puertos de adentro de la ONT: los ethernet de la casa y los de teléfono.
 *
 *   display ont port state <puerto> <ontId> eth-port all
 *   display ont port state <puerto> <ontId> pots-port all
 *
 * Son consultas OMCI en vivo: con la ONT caída el equipo no las puede contestar.
 * Cada una va con su propio catch — que un modelo sin teléfono no sepa contestar
 * lo de POTS no puede dejar sin información los ethernet, que son los que casi
 * siempre se necesitan.
 */
export async function leerPuertosOnt(olt, { frame = 0, slot, puerto, ontId }) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })

    // Se reintenta cuando vuelve vacío. La salida a veces llega cortada —el
    // lector termina en un silencio del medio— y una tabla vacía se lee como
    // "esta ONT no tiene puertos", que es distinto de "no llegué a leerlos".
    // Ya pasó con la lectura de configuración y es el mismo mecanismo.
    const leer = async (tipo, parser) => {
      try {
        for (let intento = 0; intento < 3; intento++) {
          const filas = parser(
            await display(sesion, `display ont port state ${puerto} ${ontId} ${tipo} all`),
          )
          if (filas.length) return filas
        }
        return []
      } catch (err) {
        return { error: err.message }
      }
    }

    const eth = await leer('eth-port', parseEthPortsOnt)
    const pots = await leer('pots-port', parsePotsPortsOnt)

    return {
      frame,
      slot,
      puerto,
      ontId,
      ethernet: Array.isArray(eth) ? eth : [],
      telefonia: Array.isArray(pots) ? pots : [],
      problemas: [eth?.error, pots?.error].filter(Boolean),
    }
  })
}

/**
 * Todo lo que hace falta de un puerto PON de una sola vez.
 *
 *   display ont info <puerto> all              → todas sus ONTs con descripción
 *   display service-port port <f>/<s>/<puerto> → todos sus service-ports
 *
 * Dos comandos para el puerto entero, en vez de cuatro por cada ONT. Con
 * noventa abonados la diferencia es entre un minuto y tres cuartos de hora, y
 * son sesiones SSH que la OLT le está sacando a quien esté trabajando.
 */
export async function leerPuertoCompleto(olt, { frame = 0, slot, puerto }) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const servicePorts = parseServicePortsDeOnt(
      await display(sesion, `display service-port port ${frame}/${slot}/${puerto}`),
    )

    await entrarInterfaz(sesion, { frame, slot })
    const onts = parseOntInfoAll(await display(sesion, `display ont info ${puerto} all`))

    return {
      frame,
      slot,
      puerto,
      onts: onts.map((o) => ({
        ...o,
        // Sus service-ports, para saber en qué VLAN está cada abonado.
        servicePorts: servicePorts.filter((s) => s.ontId === o.ontId),
      })),
    }
  })
}

/**
 * Las traffic tables cargadas en el equipo, con su velocidad.
 *
 * Sirven para dos cosas: ofrecerlas al armar un plan, y comprobar que las que
 * un plan ya tiene guardadas existan de verdad. Lo segundo importa más — un
 * índice inventado no falla hasta el día que alguien da de alta a un abonado,
 * y ahí la ONT queda registrada sin pasar tráfico.
 */
export async function leerTrafficTables(olt, { desde = 0, hasta = 63, conNombre = false } = {}) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    if (!conNombre) {
      const salida = await display(
        sesion,
        `display traffic table ip from-index ${desde} to-index ${hasta}`,
      )
      return parseTrafficTables(salida)
    }

    // El nombre solo está en la salida detallada, que son cuarenta líneas por
    // tabla. Leer sesenta de una vez son dos mil quinientas líneas: es el mismo
    // volumen que dejó la sesión inservible con `display current-configuration`.
    // Por eso va de a poco.
    const filas = []
    for (let i = desde; i <= hasta; i += 6) {
      const hastaTramo = Math.min(i + 5, hasta)
      const salida = await display(
        sesion,
        `display traffic table ip from-index ${i} to-index ${hastaTramo} detail`,
      )
      filas.push(...parseTrafficTablesDetalle(salida))
    }
    return filas
  })
}

/**
 * Las VLANs que tiene el equipo, con cuántos abonados cuelgan de cada una.
 *
 * El número de abonados es lo que convierte una lista de números en algo
 * accionable: la VLAN con noventa abonados no se toca, la que tiene cero se
 * puede borrar sin llamar a nadie.
 */
export async function leerVlans(olt) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    const filas = parseVlansConUso(await display(sesion, 'display vlan all'))

    // Fallo cerrado, igual que en los uplinks: una lista vacía puede ser "no
    // hay VLANs" o "no se pudo leer", y confundirlas dejaría borrar una VLAN
    // con abonados creyendo que está libre.
    if (!filas.length) {
      throw new AppError('No se pudo leer la tabla de VLANs del equipo', {
        status: 502,
        hint: 'Sin ella no se sabe cuántos abonados hay detrás de cada una. Reintentá.',
      })
    }
    return filas
  })
}

/**
 * Crea VLANs. Acepta varias de una.
 *
 * Cada una se confirma por separado: el equipo puede aceptar unas y rechazar
 * otras, y decir "listo" sin mirar dejaría al operador creyendo que creó veinte
 * cuando creó tres.
 */
export async function crearVlans(olt, vlans = [], { tipo = 'smart' } = {}) {
  if (!vlans.length) throw badRequest('No se indicó ninguna VLAN')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const existentes = new Set(parseVlansConUso(await display(sesion, 'display vlan all')).map((v) => v.vlan))
    const creadas = []
    const yaEstaban = []
    const fallidas = []

    for (const v of vlans) {
      if (existentes.has(v)) {
        // No es un error: el operador quería que existiera y existe. Pero se
        // informa aparte para que el resumen no diga "creadas 20" cuando
        // dieciocho ya estaban.
        yaEstaban.push(v)
        continue
      }
      try {
        await escribirOFallar(sesion, `vlan ${v} ${tipo}`, `No se pudo crear la VLAN ${v}`)
        creadas.push(v)
      } catch (err) {
        fallidas.push({ vlan: v, error: err.message })
      }
    }

    return { creadas, yaEstaban, fallidas }
  })
}

/**
 * Borra VLANs, negándose a tocar las que tienen abonados.
 *
 * La comprobación se hace acá y no en la pantalla porque es la última línea:
 * quitar una VLAN con abonados los deja sin salida en el mismo segundo, y desde
 * el lado GPON no se ve nada raro — las ONTs siguen online.
 */
export async function borrarVlans(olt, vlans = [], { forzar = false } = {}) {
  if (!vlans.length) throw badRequest('No se indicó ninguna VLAN')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const conUso = parseVlansConUso(await display(sesion, 'display vlan all'))
    if (!conUso.length) {
      throw new AppError('No se pudo leer qué VLANs tiene el equipo', {
        status: 502,
        hint: 'Sin esa lista no se sabe cuántos abonados quedarían sin servicio. Reintentá.',
      })
    }

    const conAbonados = vlans
      .map((v) => conUso.find((x) => x.vlan === v))
      .filter((x) => x && x.abonados > 0)

    if (conAbonados.length && !forzar) {
      throw new AppError(
        `Esas VLANs tienen abonados: ${conAbonados.map((x) => `${x.vlan} (${x.abonados})`).join(', ')}`,
        {
          status: 409,
          hint: 'Borrarlas los deja sin servicio en el momento. Si es a propósito, repetí con forzar = true.',
        },
      )
    }

    const borradas = []
    const noEstaban = []
    const fallidas = []
    const existentes = new Set(conUso.map((v) => v.vlan))

    for (const v of vlans) {
      if (!existentes.has(v)) {
        noEstaban.push(v)
        continue
      }
      try {
        await escribirOFallar(sesion, `undo vlan ${v}`, `No se pudo borrar la VLAN ${v}`)
        borradas.push(v)
      } catch (err) {
        fallidas.push({ vlan: v, error: err.message })
      }
    }

    return { borradas, noEstaban, fallidas }
  })
}

// --- TR-069: a qué ACS mira cada ONT ----------------------------------------

/**
 * Los perfiles TR-069 del equipo.
 *
 * Un perfil es "a qué ACS ir y con qué credencial". Es global a la OLT: se crea
 * una vez y después cada ONT se apunta a uno. Por eso mudar el padrón entero de
 * un ACS a otro puede ser cambiar una línea, y no ochenta.
 */
export async function listarPerfilesTr069(olt) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const perfiles = parsePerfilesTr069(
      await display(sesion, 'display current-configuration | include tr069-server-profile'),
    )
    const usos = contarAsignacionesTr069(
      await display(sesion, 'display current-configuration | include tr069-server-config'),
    )

    return perfiles.map((p) => ({ ...p, onts: usos.get(p.id) ?? 0 }))
  })
}

/**
 * Cómo está el TR-069 en el equipo, de un vistazo.
 *
 * Tres números que no son el mismo número, y la pantalla los muestra separados
 * porque cada uno falla por su lado: tener perfil no es tener IP de gestión, y
 * tener las dos no es que la ONT esté hablando.
 */
export async function resumenTr069(olt) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const perfiles = parsePerfilesTr069(
      await display(sesion, 'display current-configuration | include tr069-server-profile'),
    )
    const asignaciones = contarAsignacionesTr069(
      await display(sesion, 'display current-configuration | include tr069-server-config'),
    )
    const conIp = contarIpsDeGestion(
      await display(sesion, 'display current-configuration | include ont ipconfig'),
    )

    let total = 0
    for (const n of asignaciones.values()) total += n

    return {
      perfiles: perfiles.map((p) => ({ ...p, onts: asignaciones.get(p.id) ?? 0 })),
      ontsConPerfil: total,
      ontsConIpDeGestion: conIp,
    }
  })
}

/**
 * Crea un perfil TR-069.
 *
 * El `profile-id` es la posición dentro del equipo y lo elige quien lo crea: no
 * se autoasigna. Si ya existe uno con ese número, la OLT lo rechaza en vez de
 * pisarlo — y está bien que sea así, porque pisarlo cambiaría de ACS a todas
 * las ONT que lo estén usando, sin avisar.
 *
 * La clave viaja al equipo y no vuelve nunca: al releer el perfil, la OLT la
 * devuelve cifrada con su propio esquema y el parser la descarta.
 */
export async function crearPerfilTr069(olt, { profileId, nombre, url, usuario, clave }) {
  if (profileId == null) throw badRequest('Falta el número de perfil')
  if (!nombre) throw badRequest('Falta el nombre del perfil')
  if (!url) throw badRequest('Falta la URL del ACS')

  // La URL la escribe una persona y un dedazo acá deja al padrón entero
  // hablándole a nadie: el equipo acepta cualquier cadena sin chistar.
  if (!/^https?:\/\/[^\s"]+$/i.test(url)) {
    throw badRequest('La URL del ACS tiene que empezar con http:// o https:// y no llevar espacios')
  }
  if (usuario && !clave) throw badRequest('Si el ACS pide usuario, también hace falta la clave')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const partes = [
      `ont tr069-server-profile add profile-id ${profileId}`,
      `profile-name "${String(nombre).replace(/"/g, '')}"`,
      `url "${url}"`,
    ]
    if (usuario) partes.push(`user "${String(usuario).replace(/"/g, '')}" "${String(clave).replace(/"/g, '')}"`)

    await escribirOFallar(sesion, partes.join(' '), 'La OLT rechazó el perfil TR-069', {
      hint: 'Puede que ese número de perfil ya esté ocupado. Elegí otro.',
    })

    // Se relee. Que el comando no diera error no alcanza: el perfil tiene que
    // estar y con la URL que se pidió, o el sistema estaría informando un ACS
    // que el equipo no guardó.
    const perfiles = parsePerfilesTr069(
      await display(sesion, 'display current-configuration | include tr069-server-profile'),
    )
    const creado = perfiles.find((p) => p.id === Number(profileId))

    if (!creado) {
      throw new AppError('El equipo aceptó el comando pero el perfil no quedó guardado', {
        status: 502,
      })
    }
    if (creado.url !== url) {
      throw new AppError(`Se pidió ${url} y el equipo guardó ${creado.url}`, { status: 502 })
    }

    return creado
  })
}

/**
 * Apunta una ONT a un perfil TR-069.
 *
 * Es UNA línea y es reversible con la misma línea y el número anterior. Pero no
 * es inocua: una ONT habla con un ACS a la vez, así que moverla la saca del
 * anterior. Por eso se devuelve de dónde venía — sin eso, volver atrás depende
 * de que alguien se haya acordado.
 */
export async function asignarPerfilTr069(olt, { frame = 0, slot, puerto, ontId, profileId }) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')
  if (profileId == null) throw badRequest('Falta el perfil TR-069')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarInterfaz(sesion, { frame, slot })

    const antes = parseTr069DeOnt(await display(sesion, `display ont info ${puerto} ${ontId}`))

    const comando = `ont tr069-server-config ${puerto} ${ontId} profile-id ${profileId}`
    await escribirOFallar(sesion, comando, 'La OLT rechazó el cambio de perfil TR-069', {
      hint: 'Revisá que el perfil exista y que la ONT esté registrada en ese puerto.',
    })

    const despues = parseTr069DeOnt(await display(sesion, `display ont info ${puerto} ${ontId}`))

    if (despues.perfilId !== Number(profileId)) {
      throw new AppError(
        `Se pidió el perfil ${profileId} y la ONT quedó con ${despues.perfilId ?? 'ninguno'}`,
        { status: 502, comando },
      )
    }

    return {
      slot,
      puerto,
      ontId,
      comando,
      perfilAnterior: antes.perfilId,
      perfilAnteriorNombre: antes.perfilNombre,
      perfil: despues.perfilId,
      perfilNombre: despues.perfilNombre,
    }
  })
}

/**
 * El estado TR-069 de una ONT: perfil, IP escrita, IP viva y qué le falta.
 *
 * Lee las dos cosas en la misma sesión a propósito. Preguntadas por separado
 * son dos viajes a la OLT de medio minuto cada uno, y esta pantalla se abre
 * para mirar una ONT puntual mientras alguien espera.
 */
export async function leerTr069DeOnt(olt, { frame = 0, slot, puerto, ontId }) {
  if (ontId == null) throw badRequest('Falta el ONT-ID')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    // La tabla de MAC se pide ANTES de entrar a la interfaz: ese comando vive en
    // el modo config y desde adentro de `interface gpon` no existe.
    const macs = parseMacsDeOnt(
      await display(sesion, `display mac-address port ${frame}/${slot}/${puerto} ont ${ontId}`),
    )

    await entrarInterfaz(sesion, { frame, slot })

    const info = parseTr069DeOnt(await display(sesion, `display ont info ${puerto} ${ontId}`))
    const ip = parseOntIpconfig(await display(sesion, `display ont ipconfig ${puerto} ${ontId}`))

    const vlanGestion = ip?.vlan ?? null
    // Sin saber cuál es la VLAN de gestión no se puede contar "MACs en la VLAN
    // de gestión": queda en null y el diagnóstico dice que falta comprobarlo,
    // en vez de contar cero y acusar a la ONT de estar muda.
    const macsEnGestion =
      vlanGestion == null ? null : macs.filter((m) => m.vlan === vlanGestion).length

    return {
      slot,
      puerto,
      ontId,
      ...info,
      ipConfigurada: ip?.ip ?? null,
      vlanGestion,
      prioridad: ip?.prioridad ?? null,
      gateway: ip?.gateway ?? null,
      macs,
      macsEnGestion,
      diagnostico: diagnosticoTr069({ ...info, ipConfigurada: ip?.ip ?? null, macsEnGestion }),
    }
  })
}
