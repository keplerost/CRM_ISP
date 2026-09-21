import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import Navbar from './Navbar'
import SinPermiso from './SinPermiso'
import { usePermisos } from '../../lib/AuthContext'
import { puedeEntrar } from '../../lib/rutasPermisos'

/**
 * El marco de la app, y el único punto por donde pasan todas las pantallas.
 *
 * Por eso el control de acceso vive acá: es el lugar donde una ruta nueva queda
 * cubierta sin que su autor tenga que acordarse de nada. Ocultar el ítem del
 * menú no alcanza —la URL se escribe a mano, y quien perdió un permiso suele
 * tener el enlace guardado.
 */
export default function Layout() {
  const { puede, perfil, cargandoPerfil, errorPerfil } = usePermisos()
  const { pathname } = useLocation()
  const permitido = puedeEntrar(puede, pathname)

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Navbar />
        <main className="flex-1 overflow-y-auto p-6">
          {/* Cuatro estados, y ninguno se adivina. Antes eran dos, y "todavía no
              sé" caía del lado de "sí": por eso el vendedor veía medio sistema
              durante la recarga. */}
          {/**
           * "Cargando" solo la PRIMERA vez.
           *
           * Con un perfil ya cargado, una recarga en segundo plano —el token que
           * se renueva al volver a la pestaña— no puede desmontar la página: al
           * volver a montarse pierde todo su estado y devuelve al usuario al
           * principio. Se sigue dibujando lo que había mientras se refresca.
           */}
          {cargandoPerfil && !perfil ? (
            <Cargando />
          ) : errorPerfil ? (
            <NoSePudoVerificar error={errorPerfil} />
          ) : permitido ? (
            <Outlet />
          ) : (
            <SinPermiso />
          )}
        </main>
      </div>
    </div>
  )
}

/**
 * El hueco mientras se resuelve quién entró.
 *
 * Es deliberadamente sobrio: dura menos de un segundo y lo que no puede hacer
 * es parecerse a un error ni a una pantalla vacía definitiva.
 */
/**
 * No se pudo averiguar quién entró.
 *
 * Es un estado raro —red caída, Supabase sin responder— pero tiene que existir
 * como pantalla. Antes no existía y el sistema resolvía solo: trataba el fallo
 * como "este usuario no tiene legajo", que es el caso de una instalación sin
 * migrar, y a ese caso se le abre todo para no dejar a nadie afuera. Un corte de
 * red de un segundo le daba a un vendedor el sistema entero.
 *
 * Decirlo y ofrecer recargar es peor experiencia que adivinar bien, y muchísimo
 * mejor que adivinar mal.
 */
const NoSePudoVerificar = ({ error }) => (
  <div className="mx-auto max-w-md py-16 text-center">
    <h2 className="text-lg font-semibold text-slate-100">No se pudo verificar tu perfil</h2>
    <p className="mt-2 text-sm text-slate-400">
      El sistema no pudo leer quién sos, así que no muestra nada hasta saberlo. Suele ser la
      conexión.
    </p>
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="mt-5 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
    >
      Reintentar
    </button>
    {error?.message && (
      <p className="mt-4 font-mono text-[11px] text-slate-600">{error.message}</p>
    )}
  </div>
)

const Cargando = () => (
  <div className="space-y-3">
    <div className="h-7 w-48 animate-pulse rounded-lg bg-slate-800/60" />
    <div className="h-4 w-72 animate-pulse rounded bg-slate-800/40" />
    <div className="mt-6 grid gap-3 md:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-28 animate-pulse rounded-xl bg-slate-800/40" />
      ))}
    </div>
  </div>
)
