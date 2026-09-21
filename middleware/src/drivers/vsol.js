import { conSesionSsh } from '../lib/sshSession.js'
import { AppError, badRequest } from '../lib/errors.js'
import {
  parseOnuState,
  parseOnuInfo,
  parseAutoFind,
  parseDistancia,
  parseOpticalInfo,
  parseStatistics,
  detectarFallo,
} from '../parsers/vsolOnuParser.js'

/**
 * Driver OLT V-SOL (CLI estilo Cisco sobre SSH).
 *
 * Secuencia de acceso: enable → <password> → configure terminal → interface gpon 0/<puerto>.
 * A diferencia de Huawei, acá el `enable` SIEMPRE pide contraseña.
 *
 * La salida viene tabulada con códigos ANSI de cursor, no con espacios — eso lo
 * resuelve el parser (parsers/vsolOnuParser.js).
 */

const credenciales = (olt) => ({
  host: olt.ip_host,
  port: olt.puerto_ssh || 22,
  username: olt.usuario,
  password: olt.password,
})

/**
 * Cómo dice esta CLI que rechazó el enable.
 *
 * "Bad UserName or Bad Password , Login Failed." es el mensaje real de este
 * firmware, y no contiene ninguna de las palabras que se suelen buscar
 * —incorrect, denied, invalid—. Sin reconocerlo, el código seguía adelante
 * creyendo que había entrado.
 */
const RECHAZO_ENABLE =
  /bad\s+user\s*name|bad\s+password|login\s+failed|authentication\s+failed|incorrect|denied|invalid\s+password/i

/**
 * Tras un enable rechazado, este equipo devuelve la sesión al prompt de login.
 *
 * Es lo que convertía un error de contraseña en algo mucho peor: a partir de
 * ahí, cada comando que se mandaba se interpretaba como un intento de usuario y
 * después de contraseña. La sesión quedaba inservible y el equipo la cerraba,
 * y el síntoma que se veía era "la OLT cortó la sesión" — que apunta al lado
 * equivocado del problema.
 */
const VOLVIO_AL_LOGIN = /(^|\n)\s*(login|username)\s*:\s*$/im

/** El equipo está esperando el usuario. Solo cuenta si es lo ÚLTIMO que dijo. */
const PIDE_LOGIN = /(login|username)\s*:\s*$/i

/** …y ahora la contraseña. */
const PIDE_PASSWORD = /password\s*:\s*$/i

/**
 * El login que este equipo pide DENTRO del shell SSH.
 *
 * Autenticarse por SSH no deja en la CLI: deja en el prompt `Login:` del propio
 * equipo, que vuelve a pedir usuario y contraseña. Es una segunda puerta y hay
 * que atravesarla antes de poder hacer nada.
 *
 * Sin esto, el primer comando que se mandaba —`enable`— se consumía como
 * NOMBRE DE USUARIO, y el siguiente como contraseña. El equipo contestaba "Bad
 * UserName or Bad Password" y volvía a `Login:`, así que cada comando posterior
 * alimentaba otro intento fallido hasta que cortaba la sesión. Lo que se veía
 * era "la OLT cerró la sesión", que apunta a un problema de sesiones
 * simultáneas y no a este.
 *
 * Es idempotente: si la sesión ya está adentro, el Enter devuelve el prompt
 * normal de la CLI y no se hace nada.
 */
export async function iniciarSesionCli(sesion, olt) {
  // Un Enter para ver en qué prompt está parado el equipo.
  let salida = await sesion.run('')

  // El equipo puede arrancar en CUALQUIERA de los dos prompts. Cuando el usuario
  // ya viajó en la autenticación SSH, se saltea el de usuario y pide la
  // contraseña directamente.
  //
  // Suponer el orden en vez de mirarlo tuvo dos consecuencias, y la segunda es
  // la grave:
  //
  //   1. Al arrancar en "Password:", esta función salía creyendo que ya estaba
  //      adentro, y el primer comando se consumía como contraseña.
  //   2. Al reintentar, la contraseña terminaba escrita en el prompt "Login:",
  //      que SÍ hace eco — y quedaba impresa en claro en la salida, en los logs
  //      y en cualquier transcripción de diagnóstico.
  //
  // Por eso ahora la contraseña se manda ÚNICAMENTE cuando lo último que dijo el
  // equipo fue pedirla.
  if (PIDE_LOGIN.test(salida)) {
    salida = await sesion.run(olt.usuario)

    if (!PIDE_PASSWORD.test(salida)) {
      throw new AppError('La OLT V-SOL rechazó el usuario', {
        status: 401,
        hint: 'Es el mismo usuario con el que se entra por PuTTY.',
        detalle: salida.trim().slice(0, 200),
      })
    }
  }

  // Ni usuario ni contraseña: la sesión ya estaba adentro de la CLI.
  if (!PIDE_PASSWORD.test(salida)) return

  const trasPassword = await sesion.run(olt.password)

  // Volver a ver cualquiera de los dos prompts es el rechazo: el equipo no dice
  // "mal" de otra forma que reiniciando la secuencia.
  if (
    RECHAZO_ENABLE.test(trasPassword) ||
    PIDE_LOGIN.test(trasPassword) ||
    PIDE_PASSWORD.test(trasPassword)
  ) {
    throw new AppError('La OLT V-SOL rechazó la contraseña', {
      status: 401,
      hint:
        'Son los mismos datos con los que se entra por PuTTY. Ojo: si el equipo tiene activado el código de verificación, ' +
        'lo pide en este mismo prompt y no hay forma de contestarlo desde acá — hay que desactivarlo.',
      detalle: trasPassword.trim().slice(0, 200),
    })
  }
}

async function entrarModoConfig(sesion, olt) {
  // Primero la puerta del equipo; recién después su CLI.
  await iniciarSesionCli(sesion, olt)

  const salida = await sesion.run('enable')
  if (/password/i.test(salida)) {
    const salidaPass = await sesion.run(olt.enablePassword || olt.password)

    /**
     * Volver a pedir la contraseña ES el rechazo.
     *
     * Este equipo no dice "incorrecta": simplemente reimprime `Password:` y
     * espera otro intento. Sin detectarlo, el código seguía adelante y los
     * comandos siguientes —`configure terminal`, `show version`— se consumían
     * como más intentos de contraseña, hasta que el equipo cortaba la sesión.
     * El síntoma era "la OLT cerró la sesión", que apunta a otro lado.
     */
    if (PIDE_PASSWORD.test(salidaPass) || RECHAZO_ENABLE.test(salidaPass) || VOLVIO_AL_LOGIN.test(salidaPass)) {
      throw new AppError('La OLT V-SOL rechazó la contraseña de enable', {
        status: 401,
        hint: olt.enable_password_encrypted
          ? 'La contraseña de enable cargada no es la correcta. Corregila en la ficha de la OLT.'
          : 'Esta OLT no tiene contraseña de enable cargada, así que se probó con la de login y la rechazó. Cargá la de enable en la ficha de la OLT.',
        detalle: salidaPass.trim().slice(0, 200),
      })
    }
  }

  // Se verifica que el equipo haya aceptado entrar. Importa desde que la sesión
  // se reutiliza: si quedó dentro de un puerto PON, "configure terminal" no es
  // válido ahí y todos los comandos siguientes correrían en el contexto
  // equivocado sin que nada lo delate. Al fallar, el envoltorio descarta esta
  // sesión y reintenta con una nueva.
  const salidaConfig = await sesion.run('configure terminal')
  const fallo = detectarFallo(salidaConfig)
  if (fallo) {
    throw new AppError(`La OLT rechazó "configure terminal": ${fallo}`, {
      status: 502,
      hint: 'La sesión pudo haber quedado en otro modo. Se va a reintentar con una sesión nueva.',
    })
  }
}

/**
 * Cómo volver al punto de partida una sesión que ya estaba abierta.
 *
 * `end` sale de cualquier submodo de configuración y deja el equipo en el modo
 * privilegiado, que es desde donde `entrarModoConfig` sabe empezar. Es un solo
 * comando y no una cadena de `exit`: un `exit` de más en el nivel superior
 * cierra la sesión, que es exactamente lo que no queremos.
 */
export const volverAlInicio = (sesion) => sesion.run('end')

/**
 * Toda operación de este driver pasa por acá.
 *
 * Centraliza cómo se reutiliza la sesión: si estuviera repetido en cada
 * llamada, la primera que se agregue olvidándolo ejecutaría sus comandos en el
 * modo en que quedó la anterior.
 */
const enLaOlt = (olt, fn) => conSesionSsh(credenciales(olt), fn, { normalizar: volverAlInicio })

async function entrarPuertoPon(sesion, puerto) {
  if (puerto == null) throw badRequest('Falta el puerto PON')
  const salida = await sesion.run(`interface gpon 0/${puerto}`)
  const fallo = detectarFallo(salida)
  if (fallo) {
    throw new AppError(`La OLT rechazó "interface gpon 0/${puerto}": ${fallo}`, { status: 400 })
  }
}

// --- Salud ------------------------------------------------------------------

export async function probarConexion(olt) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    const salida = await sesion.run('show version')
    const modelo = salida.match(/(V\d{4}[A-Z0-9-]*)/i)?.[1] ?? null

    /**
     * La versión no puede ser un prompt.
     *
     * Con el equipo esperando una contraseña, `show version` se consume como
     * otro intento y su "salida" es el prompt de vuelta. La expresión lo tomaba
     * como número de versión y la prueba de conexión reportaba
     * `version: "Password:"` — verde, con basura adentro.
     */
    const crudo = salida.match(/version\s*:?\s*(\S+)/i)?.[1] ?? null
    const version = crudo && !/^(password|login|username):?$/i.test(crudo) ? crudo : null

    /**
     * No alcanza con que la sesión abra: hay que haber ENTRADO.
     *
     * Antes esto devolvía `ok: true` pasara lo que pasara. Con la contraseña de
     * enable mal cargada, el equipo devolvía la sesión al prompt de login y la
     * prueba igual decía "conectado" —eso sí, con el modelo y la versión
     * vacíos—. Un diagnóstico que dice que todo está bien cuando no lo está es
     * peor que no tenerlo: manda a buscar el problema a otro lado.
     */
    if (!modelo && !version) {
      throw new AppError('La OLT respondió pero no se pudo leer su versión', {
        status: 502,
        hint: VOLVIO_AL_LOGIN.test(salida)
          ? 'La sesión terminó en el prompt de login: revisá la contraseña de enable en la ficha de la OLT.'
          : 'La sesión se abrió pero "show version" no devolvió nada reconocible. Puede ser un firmware con otra salida.',
        detalle: salida.trim().slice(0, 300),
      })
    }

    return { ok: true, marca: 'VSOL', modelo, version }
  })
}

// --- Descubrimiento ---------------------------------------------------------

/**
 * ONUs registradas del puerto. Fusiona `show onu state all` (estado) con
 * `show onu info all` (modelo y SN), que son dos tablas distintas.
 */
export async function listarOnus(olt, { puerto }) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarPuertoPon(sesion, puerto)

    const estados = parseOnuState(await sesion.run('show onu state all'), puerto)
    const infos = parseOnuInfo(await sesion.run('show onu info all'), puerto)

    const porIndice = new Map(infos.map((i) => [i.onuIndex, i]))
    return estados.map((e) => ({ ...e, ...(porIndice.get(e.onuIndex) ?? {}) }))
  })
}

/** `show onu auto-find` — ONUs nuevas todavía sin registrar */
export async function listarAutofind(olt, { puerto }) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarPuertoPon(sesion, puerto)
    return parseAutoFind(await sesion.run('show onu auto-find'), puerto)
  })
}

/** Barre varios puertos PON buscando ONUs sin registrar. */
export async function escanearAutofind(olt, { puertos = 8 }) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)

    const encontradas = []
    for (let puerto = 1; puerto <= puertos; puerto++) {
      await sesion.run(`interface gpon 0/${puerto}`)
      encontradas.push(...parseAutoFind(await sesion.run('show onu auto-find'), puerto))
      await sesion.run('exit')
    }
    return encontradas
  })
}

// --- Aprovisionamiento ------------------------------------------------------

/**
 * `onu confirm` / `onu confirm line-profile <perfil>`
 * Confirma lo que esté en la cola de auto-find del puerto.
 */
export async function confirmarOnus(olt, { puerto, lineProfile }) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarPuertoPon(sesion, puerto)

    const comando = lineProfile ? `onu confirm line-profile ${lineProfile}` : 'onu confirm'
    const salida = await sesion.run(comando)
    const fallo = detectarFallo(salida)
    if (fallo) throw new AppError(`La OLT rechazó "${comando}": ${fallo}`, { status: 400 })

    return { ok: true, comando, salida: salida.trim() }
  })
}

/**
 * Da servicio (VLAN) a una ONU ya registrada. Secuencia de 3 pasos validada en el
 * taller.
 *
 * ⚠️ La PRIMERA vez que se usa un tcont nuevo en un puerto, el equipo del taller
 * tiró el puerto PON completo por unos segundos ("PON down"), afectando a las
 * demás ONUs de ese puerto. Por eso la respuesta incluye `advertencia` y la UI la
 * muestra antes de ejecutar. (docs/comandos-referencia.md § 1.4)
 */
export async function configurarServicio(
  olt,
  { puerto, onuIndex, vlan, tcontId = 1, gemportId = 1, servicePortId = 1 },
) {
  if (onuIndex == null || vlan == null) {
    throw badRequest('Faltan el índice de la ONU o la VLAN')
  }

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarPuertoPon(sesion, puerto)

    const comandos = [
      `onu ${onuIndex} tcont ${tcontId}`,
      `onu ${onuIndex} gemport ${gemportId} tcont ${tcontId}`,
      `onu ${onuIndex} service-port ${servicePortId} gemport ${gemportId} uservlan ${vlan} vlan ${vlan}`,
    ]

    const resultados = await sesion.runAll(comandos)
    for (const { comando, salida } of resultados) {
      const fallo = detectarFallo(salida)
      if (fallo) throw new AppError(`La OLT rechazó "${comando}": ${fallo}`, { status: 400 })
    }

    return {
      ok: true,
      comandos,
      advertencia:
        'Si este tcont era nuevo en el puerto, el puerto PON pudo caer unos segundos y afectar a las demás ONUs.',
    }
  })
}

/** `no onu <id>` */
export async function eliminarOnu(olt, { puerto, onuIndex }) {
  if (onuIndex == null) throw badRequest('Falta el índice de la ONU a eliminar')

  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarPuertoPon(sesion, puerto)

    const comando = `no onu ${onuIndex}`
    let salida = await sesion.run(comando)
    if (/\(y\/n\)|confirm/i.test(salida)) {
      salida += await sesion.run('y')
    }

    const fallo = detectarFallo(salida)
    if (fallo) throw new AppError(`La OLT rechazó el borrado: ${fallo}`, { status: 400 })

    return { ok: true, comando }
  })
}

// --- Telemetría -------------------------------------------------------------

export async function leerMetricas(olt, { puerto, onuIndex }) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    await entrarPuertoPon(sesion, puerto)

    const distancia = parseDistancia(await sesion.run(`show onu distance ${onuIndex}`))
    const estadisticas = parseStatistics(await sesion.run(`show onu statistics ${onuIndex}`))
    // El nombre del comando de diagnóstico óptico varía entre firmwares; probamos
    // el más común y caemos al alternativo si el equipo lo rechaza.
    let optica = parseOpticalInfo(await sesion.run(`show onu optical-info ${onuIndex}`))
    if (!optica) {
      optica = parseOpticalInfo(
        await sesion.run(`show onu optical-transceiver-diagnosis ${onuIndex}`),
      )
    }

    return {
      online: Boolean(optica),
      ...(optica ?? {}),
      distanciaM: distancia,
      estadisticas,
      ...(optica
        ? {}
        : {
            mensaje:
              'No se pudo leer la potencia óptica. La ONU tiene que estar online, o este firmware usa otro comando de diagnóstico.',
          }),
    }
  })
}

/**
 * Corre comandos y devuelve la salida cruda junto con si el equipo los rechazó.
 *
 * Sin el Enter extra de Huawei: la CLI de V-SOL no usa el hint de autocompletado
 * que obliga a mandarlo. Es el mismo relevamiento con la diferencia de forma que
 * separa a las dos marcas.
 */
export async function relevar(olt, comandos, { enable = true } = {}) {
  return enLaOlt(olt, async (sesion) => {
    // Con `enable: false` se entra al equipo pero no al modo privilegiado.
    //
    // Los `show` son de solo lectura y no lo necesitan, y esto destraba el caso
    // real: relevar un equipo cuya contraseña de enable no se tiene a mano. Sin
    // la opción, no saber esa clave dejaba sin poder ni mirar la configuración.
    if (enable) await entrarModoConfig(sesion, olt)
    else await iniciarSesionCli(sesion, olt)

    const salidas = []
    for (const comando of comandos) {
      try {
        const salida = await sesion.run(comando)
        salidas.push({ comando, salida, rechazo: detectarFallo(salida) })
      } catch (err) {
        salidas.push({ comando, salida: '', rechazo: err.message })
      }
    }
    return salidas
  })
}

export async function ejecutarCrudo(olt, comandos) {
  return enLaOlt(olt, async (sesion) => {
    await entrarModoConfig(sesion, olt)
    return sesion.runAll(comandos)
  })
}
