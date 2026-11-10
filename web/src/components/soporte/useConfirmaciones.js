import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { llamadasDeHoy } from '../../lib/confirmaciones'

/**
 * Las llamadas de hoy de la oficina, para una lista de tickets.
 *
 * Sin la migración 227 la tabla no existe: devuelve un mapa vacío y la ruta
 * se ve como antes.
 */
export function useConfirmaciones(ids = []) {
  const clave = [...ids].sort().join(',')
  const [mapa, setMapa] = useState(new Map())

  const recargar = useCallback(async () => {
    if (!clave) return setMapa(new Map())
    const desde = new Date()
    desde.setHours(0, 0, 0, 0)
    const { data } = await supabase
      .from('confirmaciones_visita')
      .select('ticket_id, resultado, detalle, creado_at, usuario_id')
      .in('ticket_id', clave.split(','))
      .gte('creado_at', desde.toISOString())
    setMapa(llamadasDeHoy(data ?? []))
  }, [clave])

  useEffect(() => {
    recargar()
  }, [recargar])

  return { confirmaciones: mapa, recargar }
}
