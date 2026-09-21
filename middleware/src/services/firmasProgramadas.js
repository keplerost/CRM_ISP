import { vencerPendientes } from './firmaContrato.js'

/**
 * Vencer los trámites de firma que nadie completó.
 *
 * ── Por qué hace falta una tarea y no alcanza con mirar la fecha ──
 *
 * La pantalla ya muestra en rojo lo que se pasó de plazo, así que para el que
 * está mirando alcanza. El problema es el que NO está mirando: un contrato que
 * se mandó a firmar hace un mes y quedó ahí no aparece en ninguna lista de
 * pendientes mientras su estado diga "enviado", porque nadie lo abre.
 *
 * Al marcarlo vencido pasa a ser algo sobre lo que el sistema puede ofrecer la
 * firma en papel, que es la única forma de que ese contrato termine firmándose.
 *
 * ── Por qué cada hora y no cada minuto ──
 *
 * Porque los plazos se miden en horas —setenta y dos por defecto— y un enlace
 * que vence a las 14:00 no le hace daño a nadie por seguir figurando activo
 * hasta las 14:59. Correrlo cada minuto sería consultar la base mil veces por
 * día para adelantar un aviso que nadie está esperando en ese momento.
 */

let temporizador = null

export const estadoFirmas = {
  activo: false,
  cadaMinutos: 60,
  ultimaCorrida: null,
  ultimoResultado: null,
}

async function correr() {
  try {
    const r = await vencerPendientes()
    estadoFirmas.ultimaCorrida = new Date().toISOString()
    estadoFirmas.ultimoResultado = r
    if (r.vencidos) {
      console.log(`[firmas] ${r.vencidos} trámite(s) de firma vencidos: ya se les puede ofrecer el papel`)
    }
    return r
  } catch (e) {
    // Un fallo acá no puede tirar abajo el resto de las tareas: es un vencimiento
    // que se va a intentar de nuevo en una hora.
    estadoFirmas.ultimoResultado = { error: e.message }
    console.error('[firmas] no se pudieron vencer los trámites:', e.message)
    return { error: e.message }
  }
}

export function programarFirmas({ activo = false, cada_minutos = 60 } = {}) {
  if (temporizador) {
    clearInterval(temporizador)
    temporizador = null
  }

  estadoFirmas.activo = Boolean(activo)
  estadoFirmas.cadaMinutos = Number(cada_minutos) || 60

  if (!estadoFirmas.activo) return null

  temporizador = setInterval(correr, estadoFirmas.cadaMinutos * 60_000)
  // `unref` para que este temporizador no impida que el proceso termine: no es
  // trabajo que valga la pena esperar al apagar el servidor.
  temporizador.unref?.()

  return temporizador
}

export { correr as vencerAhora }
