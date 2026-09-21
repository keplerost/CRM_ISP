import { AlertTriangle } from 'lucide-react'

/**
 * La franja que avisa que esto NO es el sistema de verdad.
 *
 * ── Por qué existe ──
 *
 * El ambiente de prueba es una copia exacta: mismas pantallas, mismos colores,
 * mismos botones. Lo único que los distingue es el número del puerto en la barra
 * de direcciones, y nadie mira la barra de direcciones antes de apretar
 * "Anular el cobro".
 *
 * El error que evita no es entrar al ambiente equivocado —eso se nota enseguida
 * porque los datos son otros—. Es el contrario: creer que estás en prueba y
 * estar en producción. Ahí la prueba destructiva se hace sobre la plata real, y
 * la señal de que algo salió mal llega días después.
 *
 * Por eso la franja marca el ambiente de PRUEBA y no el de producción: se
 * confía en su ausencia. Si no ves la franja, estás en el sistema de verdad.
 *
 * ── Por qué se declara y no se adivina ──
 *
 * Sale de `VITE_AMBIENTE`, que se pone a mano en el `.env` de cada ambiente. Se
 * podría deducir del puerto o de la URL de Supabase, pero las dos cosas cambian
 * —un ambiente de prueba puede terminar publicado en un dominio— y una alarma
 * que se apaga sola cuando cambia la infraestructura es peor que no tenerla.
 */
export default function FranjaAmbiente() {
  const ambiente = import.meta.env.VITE_AMBIENTE

  if (!ambiente) return null

  return (
    <div
      // `sticky` y no `fixed`: empuja el contenido en vez de taparlo. Con
      // `fixed` la franja se comería la primera fila de cualquier tabla.
      className="sticky top-0 z-[60] flex items-center justify-center gap-2
                 border-b border-amber-400/40 bg-amber-500 px-4 py-1.5
                 text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-950"
      role="status"
    >
      <AlertTriangle size={14} className="flex-none" />
      <span>Ambiente de {ambiente}</span>
      <span className="hidden font-normal normal-case tracking-normal opacity-80 sm:inline">
        · los datos no son reales y nada de lo que hagas acá afecta a los abonados
      </span>
    </div>
  )
}
