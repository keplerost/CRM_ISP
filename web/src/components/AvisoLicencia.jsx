import { AlertTriangle } from 'lucide-react'

/**
 * El recuadro rojo de licencia vencida.
 *
 * Arriba a la derecha y fijo: es lo primero que se ve al abrir el sistema y no
 * se va al hacer scroll. No lleva botón de cerrar a propósito — es la razón por
 * la que no se puede entrar, no un aviso que se despacha.
 *
 * Dice el identificador de la instalación porque es lo primero que le van a
 * pedir cuando llame al proveedor. Tenerlo a la vista ahorra la parte más
 * molesta de esa llamada.
 */
export default function AvisoLicencia({ licencia }) {
  if (!licencia || licencia.habilitada !== false) return null

  return (
    <div className="fixed right-4 top-4 z-50 max-w-sm rounded-lg border border-red-500/60 bg-red-950/95 p-4 shadow-xl backdrop-blur">
      <div className="flex gap-3">
        <AlertTriangle size={20} className="mt-0.5 shrink-0 text-red-400" />
        <div className="space-y-1.5">
          <p className="text-sm font-semibold text-red-200">
            ¡ERROR! Su licencia se encuentra VENCIDA
          </p>
          <p className="text-xs leading-snug text-red-200/80">{licencia.motivo}</p>
          <p className="text-xs leading-snug text-red-200/70">
            Contactá a tu proveedor para renovarla. El sistema se habilita solo apenas se acredite
            el pago.
          </p>
          {licencia.instalacion && (
            <p className="pt-1 text-[11px] text-red-300/60">
              Instalación{' '}
              <span className="select-all font-mono text-red-200/80">{licencia.instalacion}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
