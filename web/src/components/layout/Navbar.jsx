import { useEffect, useState } from 'react'
import { DollarSign, LogOut, Menu, ServerCog } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { useAuth, usePermisos } from '../../lib/AuthContext'
import { api } from '../../lib/apiNetwork'
import { modoDemo } from '../../lib/demo'
import Campana from './Campana'

/**
 * Barra superior. Muestra el estado del middleware porque, sin él, todo el módulo
 * de red falla — conviene verlo de un vistazo antes de empezar a debuggear.
 */
export default function Navbar({ onAbrirMenu = () => {} }) {
  const { puede } = usePermisos()
  const { usuario, cerrarSesion } = useAuth()
  const [middleware, setMiddleware] = useState({ estado: 'consultando' })

  useEffect(() => {
    let vigente = true
    const consultar = () =>
      api
        .health()
        .then((r) => {
          if (!vigente) return
          setMiddleware(
            r.ok
              ? { estado: 'ok' }
              : { estado: 'incompleto', detalle: r.configuracionFaltante?.join(', ') },
          )
        })
        .catch(() => vigente && setMiddleware({ estado: 'caido' }))

    consultar()
    const t = setInterval(consultar, 30000)
    return () => {
      vigente = false
      clearInterval(t)
    }
  }, [])

  const indicador = {
    consultando: ['bg-slate-500', 'consultando…'],
    ok: ['bg-emerald-500', 'middleware ok'],
    incompleto: ['bg-amber-500', `middleware sin configurar: ${middleware.detalle || ''}`],
    caido: ['bg-red-500', 'middleware no responde'],
  }[middleware.estado]

  return (
    <header className="flex items-center justify-between border-b border-[rgba(15,23,42,0.06)] bg-white px-3 py-2.5 sm:px-6 sm:py-3">
      <div className="flex min-w-0 items-center gap-3 text-xs text-slate-400">
        {/* Abre el menú. Solo en pantallas chicas: de `lg` para arriba la barra
            lateral está siempre a la vista y este botón no haría nada. */}
        <button
          type="button"
          onClick={onAbrirMenu}
          aria-label="Abrir el menú"
          className="-ml-1 shrink-0 rounded-lg p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200 lg:hidden"
        >
          <Menu size={20} />
        </button>

        {modoDemo && (
          <span className="rounded-full bg-[#FFFBEB] px-2.5 py-0.5 font-semibold text-amber-300">
            MODO DEMO — datos de ejemplo
          </span>
        )}
        <span className="flex items-center gap-2" title={indicador[1]}>
          <ServerCog size={14} />
          <span className={`h-2 w-2 rounded-full ${indicador[0]}`} />
          {/* El texto solo desde `sm`: en un teléfono "middleware sin configurar:
              ..." empuja todo y deja sin lugar a los botones. El punto de color
              sigue estando, y su `title` dice lo mismo al tocarlo. */}
          <span className="hidden sm:inline">{indicador[1]}</span>
        </span>
      </div>

      <div className="flex items-center gap-3">
        {/**
         * Cobrar, a un clic desde cualquier pantalla.
         *
         * Es la acción que más se repite en el día —cincuenta veces en una
         * ventanilla— y hasta ahora había que volver al menú, abrir Finanzas y
         * entrar a Pagos. Va antes de la campana porque se usa mucho más: la
         * campana se mira cuando avisa, esto se aprieta todo el tiempo.
         *
         * Solo aparece para quien puede cobrar. Un botón que lleva a una pantalla
         * que rebota es peor que no tenerlo.
         */}
        {puede('pagos.registrar') && (
          <NavLink
            to="/pagos"
            title="Registrar un pago"
            className={({ isActive }) =>
              `flex size-8 items-center justify-center rounded-xl border transition ${
                isActive
                  ? 'border-transparent bg-[#ECFDF5] text-emerald-400'
                  : 'border-slate-700 text-emerald-400 hover:bg-slate-800'
              }`
            }
          >
            <DollarSign size={16} />
          </NavLink>
        )}

        <Campana />
        {/* El correo lleva a Mi perfil: es donde uno busca sus propios datos,
            y es el único camino para cambiarse la contraseña. */}
        <NavLink
          to="/mi-perfil"
          title="Mi perfil y mi contraseña"
          className="hidden max-w-[16rem] truncate rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200 sm:inline-block"
        >
          {usuario?.email}
        </NavLink>
        <button
          onClick={cerrarSesion}
          className="flex items-center gap-1.5 rounded-xl border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
        >
          <LogOut size={13} />
          Salir
        </button>
      </div>
    </header>
  )
}
