/**
 * Manejo de códigos ANSI en la salida de las CLIs.
 *
 * El hallazgo clave del taller (ver docs/comandos-referencia.md § 1.6): la CLI de
 * V-SOL NO alinea las columnas con espacios, las alinea moviendo el cursor con
 * ESC[<n>C ("cursor forward"). Un parser que haga `linea.split(/\s+/)` recibe una
 * línea sin separadores reales y encima con dígitos basura (el <n> del código),
 * así que primero hay que convertir esos saltos de cursor en un separador visible.
 */

// ESC [ <n> C  → avanzar n columnas. Es el que usa V-SOL para tabular.
const CURSOR_FORWARD = /\x1b\[(\d*)C/g

// Cualquier otra secuencia CSI / OSC (colores, borrado de línea, etc.)
const OTRAS_SECUENCIAS = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[@-Z\\-_]/g

/** Convierte los saltos de cursor en el separador dado (por defecto '|'). */
export function cursorForwardASeparador(texto, separador = '|') {
  return String(texto).replace(CURSOR_FORWARD, separador)
}

/** Elimina las secuencias ANSI restantes (colores, etc.). */
export function stripAnsi(texto) {
  return String(texto).replace(OTRAS_SECUENCIAS, '')
}

/**
 * Normaliza salida de V-SOL: primero los saltos de cursor a '|', después el resto.
 * El orden importa — si se hace strip primero se pierden los separadores.
 */
export function normalizarVsol(texto) {
  return stripAnsi(cursorForwardASeparador(texto, '|'))
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
}

/** Normaliza salida de Huawei VRP: no usa saltos de cursor, alcanza con limpiar ANSI. */
export function normalizarHuawei(texto) {
  return stripAnsi(cursorForwardASeparador(texto, ' '))
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
}

/** Parte una línea ya normalizada de V-SOL en celdas no vacías. */
export function celdas(linea) {
  return linea
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
}
