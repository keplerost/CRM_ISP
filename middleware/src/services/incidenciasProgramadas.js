import { drenarIncidencias } from './incidencias.js'

/**
 * El latido que manda los avisos de un corte masivo.
 *
 * ── Por qué es una tarea aparte y no parte del monitoreo ──
 *
 * Porque el monitoreo sondea cada dos minutos y una incidencia grande son
 * cientos de mensajes: atarlos al mismo ciclo haría que un sondeo tarde varios
 * minutos, y el sondeo siguiente se solaparía con el anterior mientras la red
 * sigue caída — justo cuando más importa que el watchdog conteste rápido.
 *
 * Además una incidencia también se abre a mano, sin que haya caído ningún nodo:
 * un mantenimiento programado, una fibra que cortó una retroexcavadora y avisó
 * el vecino. Esos avisos necesitan salir igual.
 */

export const estadoIncidencias = {
  automatico: false,
  cada_minutos: null,
  lote: null,
  ultimaCorrida: null,
  ultimoResultado: null,
}

let tarea = null

export function programarIncidencias({
  activo = false,
  cada_minutos = 2,
  lote = 40,
  ejecutar = drenarIncidencias,
} = {}) {
  if (tarea) clearInterval(tarea)
  tarea = null

  estadoIncidencias.automatico = activo
  estadoIncidencias.cada_minutos = cada_minutos
  estadoIncidencias.lote = lote

  if (!activo) return null

  /**
   * Una corrida por vez.
   *
   * Sin esto, un proveedor de mensajería lento haría que la corrida siguiente
   * empiece con la anterior a mitad de camino, y las dos leerían las mismas
   * filas pendientes. El índice único de la base las salvaría del mensaje
   * duplicado, pero se gastarían dos envíos y uno fallaría con un error que no
   * significa nada.
   */
  let corriendo = false

  tarea = setInterval(
    async () => {
      if (corriendo) return
      corriendo = true
      try {
        const r = await ejecutar({ lote })
        estadoIncidencias.ultimaCorrida = new Date().toISOString()
        estadoIncidencias.ultimoResultado = r

        if (r.enviados || r.fallidos) {
          console.log(
            `[incidencias] ${r.enviados} avisados` +
              (r.fallidos ? `, ${r.fallidos} fallaron` : '') +
              (r.omitidos ? `, ${r.omitidos} omitidos` : ''),
          )
        }
      } catch (err) {
        console.error(`[incidencias] no se pudo drenar la cola: ${err.message}`)
      } finally {
        corriendo = false
      }
    },
    Math.max(1, cada_minutos) * 60 * 1000,
  )

  tarea.unref?.()
  return tarea
}
