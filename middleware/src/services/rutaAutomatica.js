import { db } from '../lib/db.js'
import { ordenarRutaAutomatica } from '../../../web/src/lib/ruta.js'

/**
 * La ruta del día, ordenada sola (migración 223).
 *
 * ── Por qué ──
 *
 * La ruta salía ordenada por prioridad, fecha y franja, sin mirar dónde queda
 * cada abonado: el técnico iba de una punta a la otra. Con los datos del
 * 10/11/2026, la de TROOPER sumaba 122 km en línea recta; por cercanía, 61.
 *
 * ── Qué hace ──
 *
 * Cada pocos minutos, para cada ruta del día (una por cuadrilla y una por
 * técnico suelto), arma el orden con la misma regla que el botón "Ordenar
 * automáticamente" de Soporte → Rutas —en curso, urgente, franja, cercanía— y
 * lo guarda si cambió. Así un ticket que entra a media mañana se mete donde le
 * queda de paso, y no al final de la lista.
 *
 * ── Lo que no toca ──
 *
 * Una ruta que alguien ordenó a mano hoy. La oficina o el jefe de grupo saben
 * cosas que el mapa no: un cliente que solo está a la tarde, un puente
 * cortado. El automático propone por defecto; la persona manda.
 */

const estado = {
  automatico: false,
  cada_minutos: null,
  corriendo: false,
  ultimaCorrida: null,
  ultimoResultado: null,
}

export const estadoRutas = () => ({ ...estado })

/**
 * El orden nuevo de una ruta, o null si no hay nada que guardar.
 *
 * No se guarda cuando la ruta ya está en ese orden y fijada: sin esto cada
 * pasada reescribiría las mismas filas, y el historial de cambios del ticket
 * se llenaría de movimientos que no movieron nada.
 *
 * @param items  lo que devuelve `items_de_ruta`, en el orden actual
 * @param vence  (item) => vencimiento del plazo, o null
 */
export function planDeRuta(items, { vence = () => null, ahora = new Date() } = {}) {
  if (!items?.length) return null
  /*
   * Siempre desde el mismo punto de partida: la lista ordenada por id.
   *
   * El orden por cercanía depende del orden en que recibe los trabajos. Si se
   * le pasara el orden actual, cada pasada podía darlo vuelta —de norte a sur,
   * y diez minutos después de sur a norte— y el técnico vería saltar su
   * próximo trabajo sin que nada hubiera cambiado. Con la misma entrada, la
   * misma salida: la ruta solo se mueve cuando cambian los trabajos.
   */
  const estable = [...items].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const nuevo = ordenarRutaAutomatica(estable, { vence, ahora })
  const igual = nuevo.every((i, k) => i.id === items[k].id)
  if (igual && items.every((i) => i.orden_fijado)) return null
  return nuevo.map((i) => ({ tipo: i.tipo, id: i.id }))
}

/** Una pasada sobre todas las rutas del día. */
export async function ordenarRutas({ cliente = db(), ahora = new Date() } = {}) {
  if (estado.corriendo) return { salteada: true }
  estado.corriendo = true

  const resultado = { ordenadas: [], manuales: [], sin_cambios: 0, errores: [] }
  try {
    const { data: grupos, error } = await cliente.rpc('rutas_a_ordenar')
    if (error) throw new Error(error.message)

    for (const g of grupos ?? []) {
      if (g.manual) {
        resultado.manuales.push(g.nombre)
        continue
      }
      try {
        const { data: items, error: e1 } = await cliente.rpc('items_de_ruta', {
          p_tecnicos: g.tecnicos,
          p_cuadrillas: g.cuadrillas,
          p_fecha: g.hoy,
        })
        if (e1) throw new Error(e1.message)
        if (!items?.length) continue

        // El plazo de cada trabajo: lo que está por vencer pasa adelante.
        const { data: plazos } = await cliente
          .from('v_plazos_trabajo')
          .select('id, vence_at')
          .in('id', items.map((i) => i.id))
        const vencimientos = new Map((plazos ?? []).map((p) => [p.id, p.vence_at]))

        const plan = planDeRuta(items, { vence: (i) => vencimientos.get(i.id), ahora })
        if (!plan) {
          resultado.sin_cambios++
          continue
        }

        const { error: e2 } = await cliente.rpc('ordenar_ruta_auto', { p_items: plan })
        if (e2) throw new Error(e2.message)
        resultado.ordenadas.push(`${g.nombre} (${plan.length})`)
      } catch (err) {
        resultado.errores.push(`${g.nombre}: ${err.message}`)
      }
    }
  } finally {
    estado.corriendo = false
    estado.ultimaCorrida = new Date().toISOString()
    estado.ultimoResultado = resultado
  }
  return resultado
}

export function programarRutas({ activo = true, cada_minutos = 10 } = {}) {
  estado.automatico = Boolean(activo)
  estado.cada_minutos = cada_minutos
  if (!activo) return null

  const correr = async () => {
    try {
      const r = await ordenarRutas()
      if (r.salteada) return
      if (r.ordenadas.length) console.log(`[rutas] ordenadas: ${r.ordenadas.join(', ')}`)
      for (const e of r.errores) console.error(`[rutas] ${e}`)
    } catch (err) {
      // Sin la 223 la función no existe: se avisa una vez por pasada y nada más.
      console.error('[rutas] no se pudieron ordenar:', err.message)
    }
  }

  const primera = setTimeout(correr, 30_000)
  primera.unref?.()

  const tarea = setInterval(correr, cada_minutos * 60_000)
  tarea.unref?.()
  return tarea
}
