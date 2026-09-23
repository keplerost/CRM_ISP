import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  FileText,
  Home,
  LifeBuoy,
  Loader2,
  LogOut,
  User,
  Wifi,
} from 'lucide-react'
import { olvidarToken, portalApi, tokenGuardado } from '../../lib/portalApi'
import { useMarca } from '../../lib/useMarca'
import PortalLogin from './PortalLogin'
import PortalInicio from './PortalInicio'
import PortalFacturas from './PortalFacturas'
import PortalReclamos from './PortalReclamos'
import PortalWifi from './PortalWifi'
import PortalPerfil from './PortalPerfil'

/**
 * El portal del abonado.
 *
 * Vive aparte del sistema del personal: sin menú lateral, sin tablas anchas,
 * sin nada que asuma un escritorio. El abonado entra desde el celular, casi
 * siempre porque algo no anda o porque le llegó la factura — y en los dos casos
 * necesita llegar en un toque.
 *
 * De ahí la barra de abajo con cinco destinos y nada más. Un menú con quince
 * opciones sería el mismo sistema del personal disfrazado.
 */

const SECCIONES = [
  { clave: 'inicio', nombre: 'Inicio', icono: Home, Pantalla: PortalInicio },
  { clave: 'facturas', nombre: 'Facturas', icono: FileText, Pantalla: PortalFacturas },
  { clave: 'wifi', nombre: 'WiFi', icono: Wifi, Pantalla: PortalWifi },
  { clave: 'reclamos', nombre: 'Ayuda', icono: LifeBuoy, Pantalla: PortalReclamos },
  { clave: 'perfil', nombre: 'Mis datos', icono: User, Pantalla: PortalPerfil },
]

export default function PortalApp() {
  const marca = useMarca()
  const [entrado, setEntrado] = useState(Boolean(tokenGuardado()))
  const [seccion, setSeccion] = useState('inicio')
  const [cuenta, setCuenta] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const cargar = useCallback(() => {
    if (!tokenGuardado()) {
      setEntrado(false)
      setCargando(false)
      return Promise.resolve()
    }
    return portalApi
      .miCuenta()
      .then((c) => {
        setCuenta(c)
        setError(null)
      })
      .catch((err) => {
        // Una sesión vencida no es un error que mostrar: es volver a entrar.
        if (err.sesionVencida || err.status === 401) setEntrado(false)
        else setError(err.message)
      })
      .finally(() => setCargando(false))
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  async function salir() {
    await portalApi.salir().catch(() => {})
    olvidarToken()
    setEntrado(false)
    setCuenta(null)
    setSeccion('inicio')
  }

  if (!entrado) {
    return (
      <PortalLogin
        onEntrar={() => {
          setEntrado(true)
          setCargando(true)
          cargar()
        }}
      />
    )
  }

  if (cargando) {
    return (
      <div className="grid min-h-dvh place-items-center bg-[#F6F8FB]">
        <Loader2 size={28} className="animate-spin text-slate-600" />
      </div>
    )
  }

  const actual = SECCIONES.find((s) => s.clave === seccion) ?? SECCIONES[0]
  const Pantalla = actual.Pantalla

  return (
    <div className="flex min-h-dvh flex-col bg-[#F6F8FB]">
      <header className="flex items-center gap-3 border-b border-slate-800 px-4 py-3">
        {marca.logo_b64 ? (
          <img src={marca.logo_b64} alt="" className="max-h-7" />
        ) : (
          <span className="grid size-7 place-items-center rounded-lg bg-sky-600 text-xs font-bold text-white">
            {marca.nombre_sistema.trim().charAt(0).toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-200">
            {/* El primer nombre: "Hola José Luis Oña Riera" en un celular ocupa
                dos líneas y no saluda a nadie. */}
            Hola, {String(cuenta?.nombre ?? '').split(' ')[0]}
          </p>

          {/*
            El selector de servicio, solo para quien tiene más de uno.
            `servicios` viene vacío con uno solo, así que para la mayoría el
            encabezado no cambia en nada.

            Es un <select> nativo a propósito: se abre con el selector del
            sistema operativo, que en un celular es más cómodo y accesible que
            cualquier menú dibujado a mano.
          */}
          {cuenta?.servicios?.length > 1 && (
            <select
              id="servicio-actual"
              value={cuenta.servicios.find((x) => x.actual)?.id ?? ''}
              onChange={async (e) => {
                await portalApi.cambiarServicio(e.target.value)
                await cargar()
              }}
              className="mt-0.5 max-w-full truncate rounded border border-slate-700 bg-transparent py-0.5 pl-1 pr-5 text-xs text-slate-500"
              aria-label="Qué servicio estás viendo"
            >
              {cuenta.servicios.map((sv) => (
                <option key={sv.id} value={sv.id}>
                  {sv.referencia || sv.direccion || sv.nombre}
                </option>
              ))}
            </select>
          )}
        </div>
        <button onClick={salir} className="p-1 text-slate-500" aria-label="Salir">
          <LogOut size={18} />
        </button>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-4 pb-24">
        {error ? (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4 text-sm text-rose-300">
            {error}
          </div>
        ) : (
          <Pantalla cuenta={cuenta} recargar={cargar} />
        )}
      </main>

      {/* Fija abajo: es donde llega el pulgar. Un menú arriba en un celular
          grande obliga a usar las dos manos. */}
      <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-slate-800 bg-white/95 backdrop-blur">
        {SECCIONES.map((s) => (
          <button
            key={s.clave}
            onClick={() => setSeccion(s.clave)}
            className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] ${
              seccion === s.clave ? 'text-sky-400' : 'text-slate-500'
            }`}
          >
            <s.icono size={20} />
            {s.nombre}
          </button>
        ))}
      </nav>
    </div>
  )
}

/** Compartida por todas las pantallas del portal. */
export function Tarjeta({ titulo, children, className = '' }) {
  return (
    <section className={`t-card p-4 ${className}`}>
      {titulo && (
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-500">
          {titulo}
        </h2>
      )}
      {children}
    </section>
  )
}

export const Cargando = () => (
  <div className="grid place-items-center py-16">
    <Loader2 size={24} className="animate-spin text-slate-600" />
  </div>
)

export const Vacio = ({ children, icono: Icono = Activity }) => (
  <div className="grid place-items-center gap-2 py-12 text-center">
    <Icono size={28} className="text-slate-700" />
    <p className="max-w-xs text-sm text-slate-500">{children}</p>
  </div>
)
