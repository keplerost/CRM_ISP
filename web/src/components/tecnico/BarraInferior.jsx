import { NavLink } from 'react-router-dom'
import { Boxes, ClipboardList, LayoutDashboard, LifeBuoy, User } from 'lucide-react'

/**
 * La navegación del técnico: cinco destinos, abajo, donde llega el pulgar.
 *
 * ── Por qué abajo y no un menú lateral ──
 *
 * El menú lateral existe y funciona bien en una computadora. En un celular
 * sostenido con una mano, la esquina superior izquierda —donde vive el botón de
 * hamburguesa— es justo el punto al que el pulgar no llega sin reacomodar el
 * teléfono. Reacomodar el teléfono con una escalera en la otra mano es cómo se
 * caen los teléfonos.
 *
 * ── Por qué cinco y no las que haya ──
 *
 * Cinco es lo que entra sin que los toques se pisen en una pantalla de 5". El
 * sexto destino no se agrega acá: entra dentro de INICIO. Esa restricción es lo
 * que mantiene la pantalla usable con guantes.
 */

/**
 * Los cinco destinos.
 *
 * ── Todos cuelgan de `/campo` a propósito ──
 *
 * Antes "Materiales" apuntaba a `/inventario/mi-almacen`, que vive dentro del
 * layout de escritorio. Tocarlo en el celular sacaba al técnico de la app de
 * campo y lo metía en el marco de la computadora, con el menú lateral encima y
 * todo descuadrado.
 *
 * La pantalla de inventario es la misma —se reutiliza tal cual, no se duplicó—;
 * lo que cambió es que ahora se muestra adentro del marco correcto.
 *
 * ── Y por qué "Avisos" no está acá ──
 *
 * Porque ya está la campana en el encabezado, con su contador. Repetirlo abajo
 * gastaría uno de los cinco lugares en algo que ya se ve, y cinco es lo que
 * entra sin que los toques se pisen en una pantalla de 5".
 */
export const DESTINOS = [
  { to: '/campo', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/campo/ordenes', label: 'Órdenes', icon: ClipboardList },
  { to: '/campo/soporte', label: 'Soporte', icon: LifeBuoy },
  { to: '/campo/inventario', label: 'Inventario', icon: Boxes },
  { to: '/campo/perfil', label: 'Perfil', icon: User },
]

/**
 * En el escritorio la barra de abajo desaparece y la navegación sube al
 * encabezado.
 *
 * Una barra pegada al pie de una pantalla de 27" es un error de traducción: ahí
 * el pulgar no existe, el puntero está donde uno lo dejó, y el borde inferior es
 * el punto más lejano de la mirada. Lo que en el celular es la mejor ubicación
 * posible, en el escritorio es la peor.
 */
export function NavEscritorio({ pendientes = {} }) {
  return (
    <nav className="hidden items-center gap-1 md:flex">
      {DESTINOS.map((d) => (
        <NavLink
          key={d.to}
          to={d.to}
          end={d.end}
          className={({ isActive }) =>
            `relative flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition ${
              isActive
                ? 'bg-sky-600/15 font-medium text-sky-300'
                : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
            }`
          }
        >
          <d.icon size={16} />
          {d.label}
          {pendientes[d.label.toLowerCase()] > 0 && (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-rose-500/20 px-1 text-[10px] font-semibold text-rose-300">
              {pendientes[d.label.toLowerCase()]}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

export default function BarraInferior({ pendientes = {} }) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-800 bg-white/95 backdrop-blur md:hidden"
      // El teléfono con gesto de inicio se come la última franja: sin esto, el
      // último centímetro de los botones no responde y parece que la app se
      // colgó.
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="mx-auto flex max-w-lg">
        {DESTINOS.map((d) => (
          <NavLink
            key={d.to}
            to={d.to}
            end={d.end}
            className={({ isActive }) =>
              `relative flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] transition ${
                isActive ? 'text-sky-400' : 'text-slate-500'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span className="relative">
                  <d.icon size={21} strokeWidth={isActive ? 2.4 : 1.8} />
                  {/* Un punto y no un número: en 10 px un "12" no se lee, y lo
                      que importa es saber que hay algo, no cuánto. */}
                  {pendientes[d.label.toLowerCase()] > 0 && (
                    <span className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-slate-950" />
                  )}
                </span>
                {d.label}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
