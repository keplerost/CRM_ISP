import { Link } from 'react-router-dom'
import { Lock } from 'lucide-react'
import { usePermisos } from '../../lib/AuthContext'
import { nombreRol } from '../../lib/permisos'

/**
 * La pantalla que ve quien entró a donde no le corresponde.
 *
 * Dice tres cosas a propósito, y ninguna es decorativa: con qué rol entró —para
 * que note si se quedó con la sesión de otro—, a quién pedirle el permiso, y
 * una salida. Un "acceso denegado" a secas termina en una llamada al soporte
 * del ISP preguntando qué pasó.
 */
export default function SinPermiso({ que = 'esta pantalla' }) {
  const { rol } = usePermisos()

  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-slate-800 bg-slate-900">
        <Lock size={24} className="text-slate-500" />
      </div>
      <h1 className="t-titulo text-lg font-bold text-slate-100">No tenés acceso a {que}</h1>
      <p className="mt-2 text-sm text-slate-400">
        Tu usuario entra como <span className="text-slate-200">{nombreRol(rol) || 'sin rol'}</span> y
        ese rol no incluye esta sección. Si la necesitás para trabajar, pedile a un administrador que
        te la habilite en Ajustes → Gestión de personal.
      </p>
      <Link
        to="/"
        className="mt-5 inline-block rounded-lg bg-slate-800 px-4 py-2 text-sm text-slate-200 hover:bg-slate-700"
      >
        Volver al inicio
      </Link>
    </div>
  )
}
