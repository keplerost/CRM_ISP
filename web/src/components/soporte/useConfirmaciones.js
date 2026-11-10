import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { llamadasDeHoy, llamadasDesde } from '../../lib/confirmaciones'

/**
 * Las llamadas de hoy de la oficina, para una lista de tickets.
 *
 * Sin la migración 227 la tabla no existe: devuelve un mapa vacío y la ruta
 * se ve como antes.
 */
export function useConfirmaciones(ids = [], { desdeDia = null } = {}) {
  const clave = [...ids].sort().join(',')
  const [mapa, setMapa] = useState(new Map())

  const recargar = useCallback(async () => {
    if (!clave) return setMapa(new Map())
    // Sin `desdeDia`, las de hoy. Con él (Rutas), desde ese día: la ruta de
    // mañana se confirma llamando hoy.
    const desde = desdeDia ? new Date(`${desdeDia}T00:00:00`) : new Date()
    if (!desdeDia) desde.setHours(0, 0, 0, 0)
    const { data } = await supabase
      .from('confirmaciones_visita')
      .select('ticket_id, resultado, detalle, creado_at, usuario_id')
      .in('ticket_id', clave.split(','))
      .gte('creado_at', desde.toISOString())
    setMapa(desdeDia ? llamadasDesde(data ?? [], desdeDia) : llamadasDeHoy(data ?? []))
  }, [clave, desdeDia])

  useEffect(() => {
    recargar()
  }, [recargar])

  return { confirmaciones: mapa, recargar }
}
