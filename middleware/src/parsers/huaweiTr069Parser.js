import { normalizarHuawei } from '../lib/ansi.js'

/**
 * Lo que la OLT sabe de TR-069, leído de su propia configuración.
 *
 * ── Por qué hay un parser y no se lee "a ojo" ──
 *
 * El TR-069 de una OLT Huawei vive en dos lugares distintos y hay que juntarlos
 * para que la pantalla diga algo verdadero:
 *
 *   1. El PERFIL, global al equipo: a qué ACS apuntar, con qué usuario.
 *        ont tr069-server-profile add profile-id 1 profile-name "SmartOLT" ...
 *
 *   2. La ASIGNACIÓN, una línea por ONT, dentro de su placa:
 *        ont tr069-server-config 0 1 profile-id 1
 *
 * Tener el perfil no significa que ninguna ONT lo use, y tener la asignación no
 * significa que la ONT pueda hablar —para eso necesita además su IP de gestión
 * viva—. Las tres cosas son verdades separadas y la pantalla las muestra
 * separadas: confundirlas es cómo se llega a "está todo configurado" sobre un
 * padrón que el ACS no ve.
 */

/**
 * Los perfiles TR-069 del equipo.
 *
 * La clave NUNCA se devuelve. El equipo la guarda cifrada con su propio esquema
 * (`%$%#...%$%#`) y aun así no tiene por qué viajar al navegador: es la
 * credencial con la que TODAS las ONT del padrón se presentan ante el ACS. Se
 * informa si tiene una puesta, que es lo único que la pantalla necesita saber.
 */
export function parsePerfilesTr069(salida) {
  const texto = normalizarHuawei(salida)
  const perfiles = []

  for (const linea of texto.split('\n')) {
    // La línea de creación es la única que interesa. El `display` la devuelve
    // tal cual quedó guardada, con las comillas incluidas.
    const m = linea.match(/ont\s+tr069-server-profile\s+add\s+profile-id\s+(\d+)/i)
    if (!m) continue

    const entre = (etiqueta) => {
      const x = linea.match(new RegExp(`${etiqueta}\\s+"([^"]*)"`, 'i'))
      return x?.[1] ?? null
    }

    // El usuario y la clave van como dos cadenas seguidas después de `user`:
    //   user "soltcpe" "%$%#...cifrado...%$%#"
    const credenciales = linea.match(/\buser\s+"([^"]*)"(?:\s+"([^"]*)")?/i)

    perfiles.push({
      id: Number(m[1]),
      nombre: entre('profile-name'),
      url: entre('url'),
      usuario: credenciales?.[1] ?? null,
      conClave: Boolean(credenciales?.[2]),
    })
  }

  return perfiles
}

/**
 * Cuántas ONT usa cada perfil.
 *
 * Sale de contar las líneas de asignación. Se cuenta y no se listan las ONT a
 * propósito: `display current-configuration | include` devuelve las líneas SIN
 * el contexto de la placa en que están, así que un `ont tr069-server-config 0 1`
 * de la placa 6 y otro igual de la placa 7 llegan indistinguibles. El total es
 * exacto; el detalle por ONT se pregunta ONT por ONT, que sí es exacto.
 */
export function contarAsignacionesTr069(salida) {
  const texto = normalizarHuawei(salida)
  const porPerfil = new Map()

  for (const linea of texto.split('\n')) {
    const m = linea.match(/ont\s+tr069-server-config\s+\d+\s+\d+\s+profile-id\s+(\d+)/i)
    if (!m) continue
    const id = Number(m[1])
    porPerfil.set(id, (porPerfil.get(id) ?? 0) + 1)
  }

  return porPerfil
}

/** Cuántas ONT tienen escrita una IP de gestión. */
export function contarIpsDeGestion(salida) {
  const texto = normalizarHuawei(salida)
  let total = 0
  for (const linea of texto.split('\n')) {
    if (/ont\s+ipconfig\s+\d+\s+\d+\s+(static|dhcp)/i.test(linea)) total++
  }
  return total
}

/**
 * El estado TR-069 de UNA ONT, leído de `display ont info`.
 *
 * ── La distinción que hace útil a esta función ──
 *
 * Devuelve dos cosas que se parecen y no son lo mismo:
 *
 *   `ipConfigurada` : lo que la OLT le escribió a la ONT.
 *   `ipViva`        : la dirección que la ONT REPORTA tener puesta.
 *
 * Una ONT puede acusar recibo de la configuración y no levantar nunca la
 * interfaz: entonces la primera está y la segunda no. Ese caso —medido en una
 * SKYW GN256VH del padrón— se ve desde la OLT como si estuviera todo bien, y es
 * exactamente el que deja a un técnico buscando el problema en el ACS.
 */
export function parseTr069DeOnt(salida) {
  const texto = normalizarHuawei(salida)

  const buscar = (re) => texto.match(re)?.[1]?.trim() ?? null
  const limpiar = (v) => (!v || v === '-' ? null : v)

  const perfilId = buscar(/TR069\s+server\s+profile\s+ID\s*:\s*(\S+)/i)
  const viva = buscar(/ONT\s+IP\s+\d+\s+address\/mask\s*:\s*([\d.]+)\/(?:\d+)/i)

  return {
    perfilId: perfilId && /^\d+$/.test(perfilId) ? Number(perfilId) : null,
    perfilNombre: limpiar(buscar(/TR069\s+server\s+profile\s+name\s*:\s*(.+)/i)),
    // El equipo dice si la gestión por TR-069 está habilitada en el line
    // profile. Sin esto la ONT ni siquiera arranca su cliente.
    gestionHabilitada: /TR069\s+management\s*:\s*Enable/i.test(texto),
    ipViva: limpiar(viva),
    estado: limpiar(buscar(/Run\s+state\s*:\s*(\S+)/i)),
  }
}

/**
 * Las MAC que la OLT le aprendió a una ONT, por VLAN.
 *
 * ── Por qué esto es la prueba y no la IP ──
 *
 * `display ont info` devuelve la dirección del IP host apenas la ONT acusa
 * recibo de la configuración. Eso NO significa que la haya levantado: una SKYW
 * GN256VH del padrón reporta `192.168.240.250/24` y no responde al ping ni
 * apareció nunca en el ACS.
 *
 * La MAC sí es prueba. Para que la OLT la aprenda, la ONT tuvo que poner una
 * trama real en esa VLAN. Sin MAC en la VLAN de gestión no hay TR-069 posible,
 * diga lo que diga el resto de la configuración.
 */
export function parseMacsDeOnt(salida) {
  const texto = normalizarHuawei(salida)
  const macs = []

  for (const linea of texto.split('\n')) {
    const mac = linea.match(/\b([0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4})\b/i)?.[1]
    if (!mac) continue
    // La VLAN es el último número de la fila. Sacarla por posición de columna
    // sería frágil: el ancho cambia entre versiones de firmware.
    const numeros = linea.trim().match(/\d+/g) ?? []
    const vlan = numeros.length ? Number(numeros[numeros.length - 1]) : null
    macs.push({ mac: mac.toLowerCase(), vlan })
  }

  return macs
}

/**
 * ¿La ONT está lista para que el ACS la vea?
 *
 * Junta las condiciones en una sola respuesta, con el motivo. El motivo es la
 * mitad del valor: "no lista" sin decir por qué manda a revisar al azar.
 */
export function diagnosticoTr069({
  perfilId,
  gestionHabilitada,
  ipViva,
  ipConfigurada,
  estado,
  macsEnGestion,
}) {
  if (estado && !/online/i.test(estado)) {
    return { lista: false, motivo: 'La ONT está fuera de línea.' }
  }
  if (!gestionHabilitada) {
    return {
      lista: false,
      motivo: 'El line profile de esta ONT no tiene TR069 management habilitado.',
    }
  }
  if (!perfilId) {
    return { lista: false, motivo: 'No tiene ningún perfil TR-069 asignado: no sabe a qué ACS ir.' }
  }
  if (!ipConfigurada) {
    return { lista: false, motivo: 'No tiene IP de gestión configurada.' }
  }
  if (!ipViva) {
    return {
      lista: false,
      motivo:
        'Tiene la IP escrita pero la ONT no la reporta como puesta: aceptó la configuración y no levantó la interfaz.',
    }
  }

  /**
   * La última comprobación, y la que hay que leer con cuidado.
   *
   * ── Por qué la MAC solo cuenta cuando ESTÁ ──
   *
   * Que la OLT le haya aprendido una MAC en la VLAN de gestión prueba que la
   * ONT puso una trama de verdad ahí: es la única evidencia dura de que está
   * hablando y no solo configurada.
   *
   * Pero su ausencia NO prueba lo contrario, y eso costó una versión de esta
   * función. La tabla de MAC envejece: una CMDC H3-1s del padrón que responde
   * al ping figuraba sin MAC en la 999 porque su IP host no manda nada mientras
   * el ACS no la busca. Con la regla anterior, esta pantalla declaraba "no
   * lista" a una ONT perfectamente gestionable.
   *
   * Así que hay tres respuestas y no dos. "No lo sé" es una de ellas, y es
   * mejor que cualquiera de las dos mentiras.
   */
  if (macsEnGestion > 0) {
    return {
      lista: true,
      motivo:
        'Perfil, IP de gestión viva y tráfico real en la VLAN de gestión: la OLT le está aprendiendo la MAC.',
    }
  }

  return {
    lista: null,
    motivo:
      macsEnGestion === 0
        ? 'La configuración está completa, pero la OLT no le tiene ninguna MAC aprendida en la VLAN de gestión ahora mismo. Eso no la condena: la tabla envejece cuando la ONT está callada. Para saberlo, hacele ping a su IP de gestión.'
        : 'La configuración está completa. No se comprobó si la ONT está hablando de verdad.',
  }
}
