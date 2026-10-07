/**
 * Cuando el servidor se actualiza, la web se compila de nuevo y los archivos de
 * cada pantalla cambian de nombre (`Dashboard-m9mGcc-G.js` pasa a ser otro). Los
 * viejos se borran. Una pestaña abierta desde antes —o la app de campo
 * guardada en el teléfono— sigue pidiendo el archivo viejo, y falla con
 * "Failed to fetch dynamically imported module".
 *
 * No se perdió nada: es una versión vieja de la página. Se recarga sola, una
 * vez, y trae la nueva. La marca en sessionStorage evita un bucle de recargas
 * si el problema fuera otro (el servidor caído, sin señal).
 */
const MARCA = 'recarga-por-version-nueva'
const VENTANA_MS = 30000

export const esVersionVieja = (error) =>
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk \S+ failed|Unable to preload CSS/i.test(
    String(error?.message ?? error ?? ''),
  )

/** Recarga la página si no se recargó hace un momento. Devuelve si recargó. */
export function recargarPorVersionNueva() {
  try {
    const antes = Number(sessionStorage.getItem(MARCA) || 0)
    if (Date.now() - antes < VENTANA_MS) return false
    sessionStorage.setItem(MARCA, String(Date.now()))
  } catch {
    /* sin sessionStorage: se recarga igual, una vez por carga de página */
  }
  window.location.reload()
  return true
}
