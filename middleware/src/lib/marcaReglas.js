/**
 * Cómo firma el sistema las reglas que escribe en un MikroTik.
 *
 * ── Por qué es un identificador y no el nombre del sistema ──
 *
 * El nombre visible se configura en Ajustes y puede cambiar cuando el ISP
 * quiera. Esto no: queda escrito en el comentario de una regla, dentro de un
 * equipo que está en un poste, y es por donde el sistema reconoce lo suyo.
 *
 * Si saliera del nombre configurable, el día que alguien renombra la marca el
 * sistema buscaría `NuevoNombre-CorteMorosos` en un router donde la regla dice
 * `ViejoNombre-CorteMorosos`, no la encontraría, y crearía otra. Multiplicado
 * por cada router y cada tipo de regla. Y la vieja seguiría ahí, cortando gente,
 * sin que el sistema sepa que existe.
 *
 * ── El nombre heredado ──
 *
 * Hasta septiembre de 2026 las reglas se firmaban `SmartOLT-*`. Se reconocen
 * las dos formas a propósito: los equipos que ya están en la calle tienen las
 * viejas, y dejar de reconocerlas es exactamente el problema que este módulo
 * existe para evitar.
 *
 * `SmartOLT` además es el nombre de un producto ajeno con el que el sistema se
 * integra. Por eso el renombre se hizo acá, sobre estas cuatro cadenas, y no
 * con un buscar-y-reemplazar: en el resto del código esa palabra casi siempre
 * se refiere al producto de terceros —los perfiles `SMARTOLT-1G-UP` que deja en
 * la OLT, el usuario `smartoltusr` de sus sesiones— y renombrarla rompería
 * lecturas que funcionan.
 */

const ACTUAL = 'ZenithCore'
const HEREDADO = 'SmartOLT'

/**
 * La marca, para lo que el sistema escribe en un equipo y no busca después
 * —el comentario de una cola, por ejemplo—. Ahí sí puede cambiar sin romper
 * nada: nadie la usa para reconocer.
 */
export const MARCA = ACTUAL

/** El sufijo de cada regla, sin la marca. */
const SUFIJOS = {
  corte: 'CorteMorosos',
  redireccion: 'RedireccionPago',
  corteV6Salida: 'CorteMorosos-v6-salida',
  corteV6Entrada: 'CorteMorosos-v6-entrada',
}

/** Con qué comentario se escribe una regla nueva. */
export const comentario = (clave) => `${ACTUAL}-${SUFIJOS[clave]}`

/** El comentario con el que se escribía antes, para reconocer lo ya instalado. */
export const comentarioHeredado = (clave) => `${HEREDADO}-${SUFIJOS[clave]}`

/** ¿Esta regla es nuestra? Vale tanto la firma nueva como la vieja. */
export const esNuestra = (texto, clave) =>
  texto === comentario(clave) || texto === comentarioHeredado(clave)

/** ¿Hay que actualizarle el nombre? Solo si es nuestra y todavía tiene el viejo. */
export const hayQueRenombrar = (texto, clave) => texto === comentarioHeredado(clave)

export const CLAVES = Object.keys(SUFIJOS)
