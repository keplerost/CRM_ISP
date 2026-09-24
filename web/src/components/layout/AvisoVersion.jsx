import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'

/**
 * "Hay una versión nueva" — con un botón para aplicarla.
 *
 * ── Qué problema resuelve ──
 *
 * La app se actualiza sola, pero en la SIGUIENTE apertura: el service worker
 * nuevo se instala y toma el control, y la pestaña que está abierta sigue
 * corriendo el código que ya cargó. Quien deja el sistema abierto todo el día
 * —que es lo normal en una oficina— no ve los cambios hasta el otro día.
 *
 * Y recargar no siempre alcanza: cada pantalla es su propio archivo, así que el
 * panel puede seguir sirviéndose de la versión vieja aunque el resto se haya
 * actualizado. La salida era borrar los datos del sitio a mano, con F12.
 *
 * ── Por qué no se recarga sola ──
 *
 * Porque no se sabe qué está haciendo la persona. Una recarga automática en
 * medio de un cobro, de un alta a medio llenar o de un formulario de ticket
 * pierde lo escrito, y nadie relacionaría esa pérdida con una actualización.
 *
 * Se avisa y se espera. Quien está en medio de algo lo termina y recarga
 * después; y si no hace nada, igual se actualiza en la próxima apertura.
 */
export default function AvisoVersion() {
  const [hayNueva, setHayNueva] = useState(false)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined

    /*
      Sin controlador es la PRIMERA instalación: no hay versión anterior que
      reemplazar. Avisar ahí diría "hay una versión nueva" a alguien que acaba
      de abrir la app por primera vez.
    */
    if (!navigator.serviceWorker.controller) return undefined

    const alCambiar = () => setHayNueva(true)
    navigator.serviceWorker.addEventListener('controllerchange', alCambiar)

    /*
      El navegador busca actualizaciones al navegar, y en una aplicación de una
      sola página casi no hay navegaciones de verdad. Sin esto, una pestaña
      abierta desde la mañana no se entera de nada.

      Al volver a la pestaña y cada cuarto de hora: es barato —una petición
      condicional al service worker— y cubre el caso de quien la deja abierta.
    */
    let registro = null
    navigator.serviceWorker.getRegistration().then((r) => {
      registro = r ?? null
    })

    const buscar = () => registro?.update?.().catch(() => {})
    const reloj = setInterval(buscar, 15 * 60 * 1000)
    window.addEventListener('focus', buscar)

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', alCambiar)
      window.removeEventListener('focus', buscar)
      clearInterval(reloj)
    }
  }, [])

  if (!hayNueva) return null

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-50 flex flex-wrap items-center justify-center gap-3 border-t border-[rgba(15,23,42,0.08)] bg-white px-4 py-3 shadow-[0_-8px_24px_-12px_rgba(15,23,42,0.25)]"
    >
      <span className="text-sm text-slate-200">
        Hay una versión nueva del sistema.
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="t-btn t-btn-marca"
      >
        <RefreshCw size={15} />
        Actualizar ahora
      </button>
      <button
        type="button"
        onClick={() => setHayNueva(false)}
        className="text-xs text-slate-500 hover:text-slate-300"
      >
        Después
      </button>
    </div>
  )
}
