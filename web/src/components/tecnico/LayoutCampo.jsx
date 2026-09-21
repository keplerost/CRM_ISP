import { useCallback, useEffect, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { usePermisos } from '../../lib/AuthContext'
import { saludo } from '../../lib/campo'
import BarraInferior, { DESTINOS, NavEscritorio } from './BarraInferior'
import EstadoConexion from './EstadoConexion'
import { arrancarCola } from '../../lib/cola'
// Registra qué sabe hacer la cola. El import tiene efecto de módulo y no
// exporta nada que se use acá: sin él, la cola acepta operaciones que después
// no sabe despachar.
import '../../lib/colaCampo'

/**
 * El marco de la app de campo.
 *
 * ── Por qué existe ──
 *
 * Sin esto, cada pantalla del técnico tenía que dibujar su propio encabezado y
 * su propia barra. Peor: los enlaces del inicio apuntaban a pantallas que viven
 * dentro del layout de escritorio —`/inventario/mi-almacen` es la más obvia— y
 * tocar "Materiales" en el celular tiraba al técnico dentro del marco pensado
 * para un monitor, con el menú lateral encima y todo descuadrado.
 *
 * El error de fondo fue tratar la app de campo como una pantalla suelta. Es un
 * espacio con varias pantallas, y un espacio necesita marco.
 *
 * ── Qué NO hace ──
 *
 * No controla permisos. Eso lo hace el `ConPermiso` que envuelve la ruta en
 * `App.jsx`, y está bien que sea así: un marco que además decide quién entra es
 * un marco que hay que revisar cada vez que se agrega una pantalla adentro.
 */
export default function LayoutCampo() {
  const { perfil } = usePermisos()
  const { pathname } = useLocation()
  const [sinLeer, setSinLeer] = useState(0)

  const contar = useCallback(async () => {
    const { count } = await supabase
      .from('v_notificaciones')
      .select('id', { count: 'exact', head: true })
      .is('leida_en', null)
    setSinLeer(count ?? 0)
  }, [])

  useEffect(() => {
    contar()
    // Cada dos minutos, igual que el resto: son datos que cambian por hora, y
    // el técnico está con datos móviles.
    const t = setInterval(contar, 120000)
    return () => clearInterval(t)
  }, [contar])

  // El despachador vive mientras la app de campo está abierta. Va acá y no en
  // `main.jsx` porque la cola es del técnico: nadie más encola nada, y
  // arrancarla para todos dejaría un intervalo corriendo en las pantallas de
  // oficina sin ninguna razón.
  useEffect(() => arrancarCola(), [])

  // El título de la sección, para que en el celular se sepa dónde se está: la
  // barra de abajo marca el ícono activo, pero un ícono resaltado en 10 px no
  // alcanza cuando hay sol de frente.
  const seccion = DESTINOS.find((d) =>
    d.end ? pathname === d.to : pathname.startsWith(d.to),
  )
  const enInicio = pathname === '/campo'

  return (
    <div className="min-h-dvh bg-[#F6F8FB] pb-24 text-slate-200 md:pb-6">
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            {/* En el inicio, el saludo. En el resto, dónde estás — que ahí es
                más útil que que te vuelvan a saludar. */}
            <p className="truncate text-[15px] font-semibold text-slate-100">
              {enInicio ? saludo(perfil?.nombre) : (seccion?.label ?? 'Campo')}
            </p>
            <p className="text-[11px] text-slate-500">
              {enInicio
                ? new Date().toLocaleDateString('es-EC', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  })
                : `${perfil?.nombre ?? ''} ${perfil?.apellido ?? ''}`.trim()}
            </p>
          </div>

          <NavEscritorio pendientes={{ avisos: sinLeer }} />

          <Link
            to="/campo/avisos"
            className="relative grid h-10 w-10 shrink-0 place-items-center rounded-xl text-slate-400 active:bg-slate-800"
            aria-label={sinLeer ? `${sinLeer} avisos sin leer` : 'Avisos'}
          >
            <Bell size={19} />
            {sinLeer > 0 && (
              <span className="absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white">
                {sinLeer > 9 ? '9+' : sinLeer}
              </span>
            )}
          </Link>
        </div>
        {/* Va DENTRO del encabezado pegajoso: si se pudiera desplazar fuera de
            vista, el técnico dejaría de saber que tiene trabajo sin enviar
            justo cuando está mirando la pantalla de abajo. */}
        <EstadoConexion />
      </header>

      <div className="mx-auto max-w-6xl p-3 md:p-4">
        <Outlet context={{ recargarAvisos: contar }} />
      </div>

      <BarraInferior pendientes={{ avisos: sinLeer }} />
    </div>
  )
}
