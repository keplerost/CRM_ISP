import { db } from '../lib/db.js'
import { fechaLocal } from './facturacionMensual.js'

/**
 * La foto mensual de cada router: activos, cortados, pausados y deuda.
 *
 * ── Por qué una foto y no una consulta ──
 *
 * Porque el sistema guarda el estado de HOY de cada abonado, no su historia.
 * Cuántos morosos tenía un router en marzo no se puede averiguar en junio: hay
 * que haberlo anotado en marzo. Esto lo anota.
 *
 * ── Por qué todos los días y no el día 1 ──
 *
 * La función pisa la fila del mes en curso, así que lo que queda al terminar el
 * mes es la foto del último día en que corrió. Correr solo el día 1 dejaría el
 * mes sin foto si ese día el servidor estaba caído; corriendo todos los días,
 * en el peor caso queda la del anteúltimo.
 */
export async function ejecutarFotoRouters({ hoy = fechaLocal() } = {}) {
  const { data, error } = await db().rpc('tomar_foto_routers', { p_hoy: hoy })
  if (error) {
    throw new Error(
      /does not exist|could not find/i.test(error.message)
        ? 'Falta la función de la foto. Corré supabase/migracion-203-el-crecimiento-por-router.sql'
        : `No se pudo tomar la foto de los routers: ${error.message}`,
    )
  }
  return { routers: data ?? 0, mes: hoy.slice(0, 7) }
}

export const estadoFotoRouters = { automaticas: false, hora: '23:30', ultimaCorrida: null, error: null }

/**
 * Una vez por día, a la hora configurada. Mismo esquema que las otras diarias:
 * se revisa cada pocos minutos si ya pasó la hora y todavía no corrió hoy.
 */
export function programarFotoRouters({
  activo = false,
  hora = '23:30',
  intervaloMs = 5 * 60 * 1000,
  ejecutar = ejecutarFotoRouters,
} = {}) {
  estadoFotoRouters.automaticas = activo
  estadoFotoRouters.hora = hora

  if (!activo) return null

  let ultimoDia = null

  const revisar = async () => {
    const ahora = new Date()
    const hoy = fechaLocal(ahora)
    if (ultimoDia === hoy) return

    const [h, m] = String(hora).split(':').map(Number)
    const minutosAhora = ahora.getHours() * 60 + ahora.getMinutes()
    if (minutosAhora < (h ?? 23) * 60 + (m ?? 30)) return

    ultimoDia = hoy
    try {
      estadoFotoRouters.ultimaCorrida = { ...(await ejecutar({ hoy })), cuando: ahora.toISOString() }
      estadoFotoRouters.error = null
    } catch (err) {
      estadoFotoRouters.error = err.message
    }
  }

  const reloj = setInterval(revisar, intervaloMs)
  reloj.unref?.()
  revisar()
  return () => clearInterval(reloj)
}
