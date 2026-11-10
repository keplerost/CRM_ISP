import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'

/**
 * Los pendientes y los usuarios del equipo (para mostrar a quién le toca).
 *
 * @param filtro  (consulta) => consulta: para acotar, por ejemplo, a un abonado
 * @param clave   cambia cuando cambia el filtro, para volver a cargar
 */
export function usePendientes({ filtro = (q) => q, clave = '' } = {}) {
  const [pendientes, setPendientes] = useState(null)
  const [usuarios, setUsuarios] = useState(new Map())
  const [error, setError] = useState(null)

  const recargar = useCallback(async () => {
    const [p, u] = await Promise.all([
      filtro(supabase.from('pendientes').select('*')).order('created_at', { ascending: false }).limit(500),
      supabase.from('usuarios_sistema').select('id, nombre, apellido'),
    ])
    // Sin la 225 la tabla no existe: la sección no se dibuja.
    if (p.error && /does not exist|schema cache/i.test(p.error.message)) return setPendientes(false)
    if (p.error) setError(p.error)
    setPendientes(p.data ?? [])
    setUsuarios(new Map((u.data ?? []).map((x) => [x.id, x])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave])

  useEffect(() => {
    recargar()
  }, [recargar])

  return { pendientes, usuarios, error, setError, recargar }
}
