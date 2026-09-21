import { db } from '../lib/db.js'
import { fechaLocal } from './cortesPromesas.js'

/**
 * Avisar de lo que se está por acabar.
 *
 * ── Por qué corre temprano ──
 *
 * Porque el aviso sirve si llega ANTES de que el técnico salga a la ruta. Un
 * mensaje a media mañana diciéndole que le quedan dos conectores le llega
 * cuando ya está en el poste, y ahí el material que falta es una instalación
 * que no se hace y un abonado que espera otra semana.
 *
 * ── Por qué una vez al día y no cada vez que baja el stock ──
 *
 * Se evaluó dispararlo desde el trigger de existencias, en el momento exacto en
 * que un movimiento cruza el mínimo. Se descartó: una salida de material a un
 * técnico mueve varios artículos seguidos, y eso mandaría cinco avisos en
 * cuatro segundos. A la tercera notificación del día nadie las lee, y la que
 * importaba se pierde con las otras.
 *
 * Una vez por día, con la lista completa, es un pedido de material. Cinco
 * avisos sueltos son ruido.
 */

export const estadoStock = {
  automaticas: false,
  hora: '07:00',
  ultimaCorrida: null,
  ultimoResultado: null,
}

/** ¿Ya pasó la hora de hoy? Misma lógica que cortes, facturación y cartera. */
function llegoLaHora(ahora, hora) {
  const [h, m] = String(hora ?? '07:00')
    .split(':')
    .map(Number)
  return ahora.getHours() > h || (ahora.getHours() === h && ahora.getMinutes() >= m)
}

/**
 * Una corrida.
 *
 * Devuelve además QUÉ está bajo, y no solo cuántos avisos salieron: sirve para
 * poder correrla a mano desde la pantalla de tareas y ver el resultado sin
 * tener que ir a mirar las notificaciones de otro.
 */
export async function ejecutarStock() {
  const { data: avisos, error } = await db().rpc('avisar_stock_bajo')

  if (error) {
    // El mensaje distingue "todavía no corriste la migración" de "algo se rompió",
    // que son dos problemas con soluciones muy distintas.
    const falta = /does not exist/i.test(error.message)
    throw new Error(
      falta
        ? 'Falta la función avisar_stock_bajo. Corré supabase/migracion-123-cuando-se-esta-por-acabar-el-material.sql'
        : `No se pudieron mandar los avisos de stock: ${error.message}`,
    )
  }

  const { data: bajos } = await db()
    .from('v_stock_bajo')
    .select('almacen, articulo, cantidad, minimo, falta, agotado')
    .order('agotado', { ascending: false })
    .order('falta', { ascending: false })
    .limit(50)

  return {
    avisos: avisos?.avisos ?? 0,
    articulos: bajos?.length ?? 0,
    agotados: (bajos ?? []).filter((b) => b.agotado).length,
    detalle: bajos ?? [],
  }
}

/**
 * Arranca la tarea diaria.
 *
 * Se revisa cada pocos minutos en vez de programar un temporizador de 24 horas,
 * por lo mismo que el corte de morosos: un `setTimeout` largo se desfasa con la
 * suspensión del equipo y basta un reinicio para que nunca dispare.
 */
export function programarStock({
  activo = false,
  hora = '07:00',
  intervaloMs = 5 * 60 * 1000,
  ejecutar = ejecutarStock,
} = {}) {
  estadoStock.automaticas = activo
  estadoStock.hora = hora

  if (!activo) return null

  const revisar = async () => {
    const ahora = new Date()
    const hoy = fechaLocal(ahora)

    if (estadoStock.ultimaCorrida === hoy) return
    if (!llegoLaHora(ahora, hora)) return

    estadoStock.ultimaCorrida = hoy
    try {
      const r = await ejecutar()
      estadoStock.ultimoResultado = r
      console.log(
        `[stock] ${r.articulos} artículos en el mínimo o por debajo ` +
          `(${r.agotados} agotados), ${r.avisos} avisos enviados`,
      )
    } catch (e) {
      // La corrida del día ya quedó marcada: si falla, se reintenta mañana en
      // vez de insistir cada cinco minutos con el mismo error.
      estadoStock.ultimoResultado = { error: e.message }
      console.error(`[stock] ${e.message}`)
    }
  }

  const timer = setInterval(revisar, intervaloMs)
  timer.unref?.()
  revisar()

  return timer
}
