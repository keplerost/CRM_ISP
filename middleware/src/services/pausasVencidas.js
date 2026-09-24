import { db } from '../lib/db.js'
import { fechaLocal } from './facturacionMensual.js'

/**
 * Avisar de las pausas que ya vencieron.
 *
 * ── Por qué hace falta un aviso y no alcanza con verlo en una pantalla ──
 *
 * Un abonado pausado cuya fecha pasó es la única pérdida del sistema que no
 * genera ningún reclamo: quedó sin internet y sin factura, cree que sigue de
 * vacaciones, y el ISP no cobra. Nadie llama porque a nadie le molesta.
 *
 * El panel ya lo muestra, pero el panel se mira cuando uno entra. Esto lo pone
 * en la campana, que es donde se mira lo que hay que hacer hoy: a quién llamar
 * para avisarle que su período terminó.
 *
 * ── Por qué no reactiva sola ──
 *
 * Porque la fecha es un acuerdo, no un hecho. Quien estiró el viaje se quedaría
 * con el servicio cortado igual —y ahora además facturándose— y quien volvió
 * antes ya lo pidió por teléfono. La decisión es de quien atiende; esto solo se
 * asegura de que se entere.
 */

/** Quién tiene que enterarse. Los que administran abonados y cobranza. */
const ROLES_QUE_AVISAR = ['super_admin', 'admin', 'finanzas']

/**
 * Corre la revisión y deja las notificaciones.
 *
 * Devuelve el detalle para que la pantalla de tareas pueda mostrar qué hizo, y
 * para que una corrida en seco se vea igual que una de verdad.
 */
export async function ejecutarPausasVencidas({ hoy = fechaLocal(), seco = false } = {}) {
  const { data: vencidas, error } = await db()
    .from('clientes')
    .select('id, nombre, telefono, telefono_movil, suspendido_motivo, suspendido_hasta')
    .eq('estado', 'suspendido')
    .not('suspendido_hasta', 'is', null)
    .lt('suspendido_hasta', hoy)
    .order('suspendido_hasta')

  if (error) throw new Error(`No se pudieron leer las pausas: ${error.message}`)
  if (!vencidas?.length) return { revisadas: 0, avisados: 0, notificaciones: 0, detalle: [] }

  const { data: usuarios } = await db()
    .from('usuarios_sistema')
    .select('id, nombre')
    .eq('activo', true)
    .in('rol', ROLES_QUE_AVISAR)

  const detalle = vencidas.map((c) => ({
    cliente: c.nombre,
    hasta: c.suspendido_hasta,
    motivo: c.suspendido_motivo ?? null,
    // El teléfono va en el aviso: el que lee la campana tiene que poder llamar
    // sin abrir la ficha a buscarlo.
    telefono: c.telefono_movil || c.telefono || null,
  }))

  if (seco) {
    return { revisadas: vencidas.length, avisados: usuarios?.length ?? 0, notificaciones: 0, detalle, seco: true }
  }

  let notificaciones = 0
  for (const c of vencidas) {
    const dias = diasDesde(c.suspendido_hasta, hoy)
    for (const u of usuarios ?? []) {
      /*
        `notificar` no duplica: la misma cosa sobre la misma entidad dentro del
        día no se repite. Sin eso, una tarea diaria dejaría un aviso por día
        sobre el mismo abonado hasta que alguien lo atienda, y la campana se
        volvería ilegible justo por avisar de más.
      */
      const { error: err } = await db().rpc('notificar', {
        p_usuario: u.id,
        p_tipo: 'pausa_vencida',
        p_titulo: `${c.nombre}: terminó su pausa`,
        p_detalle:
          `Se le pausó el servicio hasta el ${c.suspendido_hasta}` +
          `${c.suspendido_motivo ? ` (${c.suspendido_motivo})` : ''}. ` +
          `${dias === 1 ? 'Venció ayer' : `Venció hace ${dias} días`}. ` +
          `Sigue sin internet y sin facturarse${
            c.telefono_movil || c.telefono ? `. Teléfono: ${c.telefono_movil || c.telefono}` : ''
          }.`,
        p_ruta: `/clientes/${c.id}`,
        p_entidad: 'cliente',
        p_entidad_id: String(c.id),
      })
      if (!err) notificaciones++
    }
  }

  return { revisadas: vencidas.length, avisados: usuarios?.length ?? 0, notificaciones, detalle }
}

/** Días enteros entre dos fechas en formato AAAA-MM-DD. */
export function diasDesde(desde, hasta) {
  const a = new Date(`${String(desde).slice(0, 10)}T12:00:00`)
  const b = new Date(`${String(hasta).slice(0, 10)}T12:00:00`)
  return Math.max(0, Math.round((b - a) / 86400000))
}

export const estadoPausas = { automaticas: false, hora: '08:00', ultima: null, error: null }

/**
 * Una vez por día, a la hora configurada.
 *
 * Mismo esquema que las otras diarias: se revisa cada pocos minutos si ya pasó
 * la hora y todavía no corrió hoy. Un intervalo simple se desfasaría con los
 * reinicios del servicio y terminaría corriendo a cualquier hora.
 */
export function programarPausasVencidas({
  activo = false,
  hora = '08:00',
  intervaloMs = 5 * 60 * 1000,
  ejecutar = ejecutarPausasVencidas,
} = {}) {
  estadoPausas.automaticas = activo
  estadoPausas.hora = hora

  if (!activo) return null

  let ultimoDia = null

  const revisar = async () => {
    const ahora = new Date()
    const hoy = fechaLocal(ahora)
    if (ultimoDia === hoy) return

    const [h, m] = String(hora).split(':').map(Number)
    const minutosAhora = ahora.getHours() * 60 + ahora.getMinutes()
    if (minutosAhora < (h ?? 8) * 60 + (m ?? 0)) return

    ultimoDia = hoy
    try {
      estadoPausas.ultima = { ...(await ejecutar({ hoy })), cuando: ahora.toISOString() }
      estadoPausas.error = null
    } catch (err) {
      estadoPausas.error = err.message
    }
  }

  const reloj = setInterval(revisar, intervaloMs)
  // Sin esto el temporizador mantiene vivo el proceso: los tests que arman la
  // tarea y no la paran quedan colgados cinco minutos esperando a que el reloj
  // vuelva a sonar. Es lo que hacen todas las demás tareas.
  reloj.unref?.()
  revisar()
  return () => clearInterval(reloj)
}
