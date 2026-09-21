import { ejecutarAlertas } from './alertas.js'

/**
 * La tarea de alertas.
 *
 * ── Por qué por intervalo y no a una hora ──
 *
 * Porque es la única del sistema que no puede esperar. Las demás resuelven algo
 * del día —cortar morosos, cerrar comisiones, abrir órdenes de retiro— y da lo
 * mismo si corren a las 3 o a las 4. Esta existe para que alguien se entere de
 * que una ONT se apagó, y una alerta que llega mañana no evita nada.
 *
 * Cinco minutos es el intervalo más corto de todo el sistema. Lo que impide que
 * eso se convierta en cien mensajes por un corte de luz no es el intervalo: es
 * la espera de cada regla, que se configura en minutos desde Ajustes.
 */
export const estadoAlertas = {
  automaticas: false,
  cada: 5,
  ultimaCorrida: null,
  ultimoResultado: null,
  corriendo: false,
}

export function programarAlertas({
  activo = false,
  cada_minutos = 5,
  ejecutar = ejecutarAlertas,
} = {}) {
  estadoAlertas.automaticas = activo
  estadoAlertas.cada = cada_minutos

  if (!activo) return null

  const correr = async () => {
    /*
     * Si la corrida anterior todavía no terminó, esta se saltea.
     *
     * Sin esto, un proveedor de WhatsApp lento —diez segundos por mensaje, veinte
     * mensajes— haría que a los cinco minutos arranque otra corrida sobre los
     * mismos eventos, y el abonado recibiría todo dos veces.
     */
    if (estadoAlertas.corriendo) return
    estadoAlertas.corriendo = true

    try {
      const r = await ejecutar({ ahora: new Date() })
      estadoAlertas.ultimaCorrida = new Date().toISOString()
      estadoAlertas.ultimoResultado = r

      // Se registra solo cuando pasó algo: una línea cada cinco minutos diciendo
      // "0 alertas" convierte el log en ruido y esconde lo que importa.
      if (r.enviados || r.fallidos || r.aviso) {
        console.log(
          `[alertas] ${r.enviados} enviadas, ${r.fallidos} fallidas` +
            (r.aviso ? ` · ${r.aviso}` : ''),
        )
      }
    } catch (err) {
      estadoAlertas.ultimoResultado = { error: err.message }
      console.error(`[alertas] la corrida falló: ${err.message}`)
    } finally {
      estadoAlertas.corriendo = false
    }
  }

  const t = setInterval(correr, Math.max(1, cada_minutos) * 60 * 1000)
  t.unref?.()

  // Una primera pasada al arrancar: si el servidor estuvo caído una hora, lo
  // que se cayó en ese rato tiene que salir ahora y no dentro de cinco minutos.
  correr()

  return t
}
