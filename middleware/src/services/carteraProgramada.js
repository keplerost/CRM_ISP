import { db } from '../lib/db.js'
import { fechaLocal } from './cortesPromesas.js'

/**
 * La cartera que se cae: órdenes de retiro y regresos.
 *
 * ── Por qué es una tarea aparte de la de comisiones ──
 *
 * Porque la de comisiones cierra períodos, y cerrar un período congela lo que se
 * le va a pagar a alguien. Esa arranca apagada y con advertencia, y es razonable
 * que una empresa la deje apagada durante meses mientras afina las bases.
 *
 * Esta no le cuesta plata a nadie: abre órdenes de trabajo y anota quién volvió.
 * Si las dos vivieran en el mismo interruptor habría que elegir entre no generar
 * retiros o encender el cierre antes de tiempo, y esa elección no debería
 * existir.
 *
 * ── Lo que esta tarea NO hace ──
 *
 * Mandar al técnico. Abre la orden y ahí se detiene: a quién se le asigna y
 * cuándo va es una decisión de quien organiza el día, no de un reloj.
 */

export const estadoCartera = {
  automaticas: false,
  hora: '04:00',
  ultimaCorrida: null,
  ultimoResultado: null,
}

/** ¿Ya pasó la hora de hoy? Misma lógica que cortes, facturación y comisiones. */
function llegoLaHora(ahora, hora) {
  const [h, m] = String(hora ?? '04:00')
    .split(':')
    .map(Number)
  return ahora.getHours() > h || (ahora.getHours() === h && ahora.getMinutes() >= m)
}

/**
 * Una corrida: genera los retiros que correspondan y detecta reactivaciones.
 *
 * Las dos partes son independientes y cada una se reporta por separado. Que no
 * se puedan detectar los regresos no es razón para no abrir las órdenes de
 * retiro: son problemas distintos y uno solo de los dos tiene un equipo en la
 * calle esperando.
 */
export async function ejecutarCartera() {
  const resultado = { retiros: null, reactivaciones: null, recordatorios: null, fichas: null, aviso: null }

  const avisar = (texto) => {
    resultado.aviso = resultado.aviso ? `${resultado.aviso} · ${texto}` : texto
  }

  const { data: ret, error: eRet } = await db().rpc('generar_retiros_equipo')
  if (eRet) {
    avisar(`Los retiros no se pudieron generar: ${eRet.message}`)
  } else {
    resultado.retiros = ret?.[0] ?? ret
  }

  const { data: rea, error: eRea } = await db().rpc('detectar_reactivaciones')
  if (eRea) {
    avisar(`Las reactivaciones no se pudieron detectar: ${eRea.message}`)
  } else {
    resultado.reactivaciones = rea?.[0] ?? rea
  }

  /**
   * Los recordatorios de las citas.
   *
   * Va en esta misma corrida y no en una tarea aparte porque es el mismo
   * trabajo —la cartera que se cae— y porque una tarea más que encender es una
   * tarea más que alguien se olvida de encender.
   *
   * Avisa de las citas de las próximas 24 horas y, todos los días, de las que
   * ya se pasaron sin cerrarse. Ese segundo caso es el que importa: una cita
   * vencida en silencio es un equipo que se queda en la casa.
   */
  /**
   * Y el pendiente de cerrar la ficha del que se quedó sin equipo.
   *
   * `notificar` no repite el mismo aviso sobre la misma entidad dentro del día,
   * así que correrlo a diario no molesta: el pendiente vuelve a aparecer una vez
   * por día hasta que alguien lo resuelva, y deja de insistir a los 90 días.
   */
  const { data: fic, error: eFic } = await db().rpc('avisar_fichas_por_cerrar')
  if (eFic) avisar(`Los avisos de ficha por cerrar no salieron: ${eFic.message}`)
  else resultado.fichas = fic?.[0] ?? fic

  const { data: rec, error: eRec } = await db().rpc('recordar_retiros_agendados')
  if (eRec) {
    avisar(`Los recordatorios de retiro no salieron: ${eRec.message}`)
  } else {
    resultado.recordatorios = rec?.[0] ?? rec
  }

  // Que fallen las dos sí es un problema del sistema y no del dato: se levanta,
  // para que quede en el log como error y no como una corrida vacía.
  if (eRet && eRea) {
    throw new Error(resultado.aviso)
  }

  return resultado
}

/**
 * Arranca la tarea diaria.
 *
 * Se revisa cada pocos minutos en vez de programar un temporizador de 24 horas,
 * por lo mismo que el corte de morosos: un `setTimeout` largo se desfasa con la
 * suspensión del equipo y basta un reinicio para que nunca dispare.
 */
export function programarCartera({
  activo = false,
  hora = '04:00',
  intervaloMs = 5 * 60 * 1000,
  ejecutar = ejecutarCartera,
} = {}) {
  estadoCartera.automaticas = activo
  estadoCartera.hora = hora

  if (!activo) return null

  const revisar = async () => {
    const ahora = new Date()
    const hoy = fechaLocal(ahora)

    if (estadoCartera.ultimaCorrida === hoy) return
    if (!llegoLaHora(ahora, hora)) return

    estadoCartera.ultimaCorrida = hoy
    try {
      const r = await ejecutar({ hoy: ahora })
      estadoCartera.ultimoResultado = r
      const ret = r.retiros ?? {}
      const rea = r.reactivaciones ?? {}
      console.log(
        `[cartera] ${ret.creadas ?? 0} órdenes de retiro nuevas, ` +
          `${ret.canceladas ?? 0} canceladas, ` +
          `${rea.detectadas ?? 0} reactivaciones, ` +
          `${(r.recordatorios?.avisadas ?? 0) + (r.recordatorios?.vencidas ?? 0)} recordatorios` +
          (r.aviso ? ` · ${r.aviso}` : ''),
      )
    } catch (err) {
      estadoCartera.ultimoResultado = { error: err.message }
      console.error(`[cartera] la corrida falló: ${err.message}`)
      // Se libera la marca para reintentar en el próximo tick: un error de red
      // no puede dejar los equipos sin orden hasta mañana.
      estadoCartera.ultimaCorrida = null
    }
  }

  const temporizador = setInterval(revisar, intervaloMs)
  temporizador.unref?.()
  revisar()

  return temporizador
}
