import { Link } from 'react-router-dom'
import { ClipboardList, ChevronRight } from 'lucide-react'
import { usePermisos } from '../../lib/AuthContext'
import { hoyLocal } from '../../lib/soporte'
import { estadoPendiente, etiquetaPendiente, ordenarPendientes } from '../../lib/pendientes'
import { usePendientes } from './usePendientes'

/**
 * Los pendientes administrativos del técnico, en su inicio (225).
 *
 * Solo aparece si tiene alguno: un bloque vacío en la pantalla que se mira
 * apurado antes de salir es ruido.
 */
export default function MisPendientesCampo() {
  const { perfil } = usePermisos()
  const { pendientes } = usePendientes({
    filtro: (q) => q.is('hecho_at', null).eq('asignado_a', perfil?.id ?? '00000000-0000-0000-0000-000000000000'),
    clave: perfil?.id ?? '',
  })
  if (!pendientes || !pendientes.length) return null

  const hoy = hoyLocal()
  const lista = ordenarPendientes(pendientes, hoy).slice(0, 3)
  const vencidos = pendientes.filter((p) => estadoPendiente(p, hoy) === 'vencido').length

  return (
    <Link to="/campo/pendientes" className="t-card block p-4">
      <p className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <span className="flex items-center gap-1.5">
          <ClipboardList size={12} /> Mis pendientes · {pendientes.length}
          {vencidos > 0 && <span className="text-rose-500"> · {vencidos} vencido{vencidos === 1 ? '' : 's'}</span>}
        </span>
        <ChevronRight size={14} />
      </p>
      <ul className="mt-2 space-y-1 text-[13px]">
        {lista.map((p) => (
          <li key={p.id} className="truncate text-slate-300">
            <b>{etiquetaPendiente(p.tipo)}</b> · {p.nombre}
          </li>
        ))}
      </ul>
    </Link>
  )
}
