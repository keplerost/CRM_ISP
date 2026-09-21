import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { AJUSTES } from '../lib/ajustes'
import { usePermisos } from '../lib/AuthContext'
import { puedeEntrar } from '../lib/rutasPermisos'

/**
 * Ajustes — el tablero de configuración.
 *
 * Todos los botones abren. Los que todavía no tienen módulo llevan a su propia
 * ficha, que dice para qué va a servir la sección y dónde está hoy ese dato
 * mientras tanto. Un botón que no hace nada obliga a probarlo para saberlo; uno
 * que explica, no.
 *
 * Los que ya funcionan se ven encendidos y los pendientes apagados, así se
 * distingue de un vistazo sin tener que apretar los treinta y cinco.
 */

function Boton({ nombre, icono: Icono, a, slug }) {
  const listo = Boolean(a)
  return (
    <Link
      to={a ?? `/ajustes/${slug}`}
      className={`flex aspect-square w-full flex-col items-center justify-center rounded-full border transition ${
        listo
          ? 'border-sky-500/50 text-sky-300 hover:border-sky-400 hover:bg-sky-500/10 hover:text-sky-200'
          : 'border-slate-700/70 text-slate-500 hover:border-slate-500 hover:bg-slate-800/40 hover:text-slate-300'
      }`}
    >
      <Icono size={26} className="mb-2" />
      <span className="px-2 text-center text-[11px] font-medium leading-tight">{nombre}</span>
    </Link>
  )
}

const Cuadricula = ({ items }) => (
  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
    {items.map((x) => (
      <Boton key={x.slug} {...x} />
    ))}
  </div>
)

export default function AjustesPage() {
  const { puede } = usePermisos()

  /**
   * Se esconden las secciones a las que este usuario no puede entrar.
   *
   * Las que todavía no existen no se filtran: no llevan a ningún dato, solo a
   * una ficha que explica qué va a hacer la sección. Ocultárselas a alguien
   * sería esconderle el mapa de a dónde va el sistema, que no es un secreto.
   */
  const visibles = useMemo(
    () => AJUSTES.filter((x) => !x.a || puedeEntrar(puede, x.a)),
    [puede],
  )

  const listos = visibles.filter((x) => x.a)
  const pendientes = visibles.filter((x) => !x.a)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="t-titulo text-lg font-bold text-slate-100">Ajustes</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          {listos.length} de {visibles.length} secciones ya funcionan. Las demás abren igual y
          explican qué van a hacer.
        </p>
      </div>

      <Cuadricula items={listos} />

      <div className="space-y-3 pt-2">
        <div className="flex items-center gap-3">
          <h2 className="text-xs uppercase tracking-wider text-slate-500">En construcción</h2>
          <span className="h-px flex-1 bg-slate-800" />
        </div>
        <Cuadricula items={pendientes} />
      </div>
    </div>
  )
}
