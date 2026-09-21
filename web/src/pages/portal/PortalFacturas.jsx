import { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'
import { portalApi } from '../../lib/portalApi'
import { dineroCero as dinero } from '../../lib/formato'
import { Cargando, Tarjeta, Vacio } from './PortalApp'

/**
 * Las facturas del abonado.
 *
 * Lo pendiente arriba y separado: es lo que vino a ver. Las pagadas quedan
 * abajo, más apagadas, porque sirven para consultar pero no requieren nada.
 */
export default function PortalFacturas() {
  const [facturas, setFacturas] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    portalApi
      .facturas()
      .then(setFacturas)
      .catch((e) => setError(e.message))
  }, [])

  if (error) return <p className="py-8 text-center text-sm text-rose-400">{error}</p>
  if (!facturas) return <Cargando />
  if (!facturas.length) {
    return <Vacio icono={FileText}>Todavía no tenés facturas emitidas.</Vacio>
  }

  const pendientes = facturas.filter((f) => f.estado !== 'pagada')
  const pagadas = facturas.filter((f) => f.estado === 'pagada')
  const total = pendientes.reduce((s, f) => s + f.pendiente, 0)

  return (
    <div className="space-y-4">
      {pendientes.length > 0 && (
        <>
          <Tarjeta>
            <p className="text-xs text-slate-500">Total pendiente</p>
            <p className="text-3xl font-semibold text-slate-100">{dinero(total)}</p>
          </Tarjeta>

          <div className="space-y-2">
            {pendientes.map((f) => (
              <Factura key={f.id} f={f} />
            ))}
          </div>
        </>
      )}

      {pagadas.length > 0 && (
        <div className="space-y-2">
          <h2 className="pt-2 text-xs font-medium uppercase tracking-wider text-slate-500">
            Pagadas
          </h2>
          {pagadas.map((f) => (
            <Factura key={f.id} f={f} />
          ))}
        </div>
      )}
    </div>
  )
}

const fecha = (f) =>
  f ? new Date(`${f}T12:00:00`).toLocaleDateString('es-EC', { day: 'numeric', month: 'short' }) : ''

function Factura({ f }) {
  const color = {
    vencida: 'border-rose-500/30 bg-rose-500/5',
    pendiente: 'border-slate-800 bg-slate-900/50',
    pagada: 'border-slate-800/60 bg-slate-900/30',
  }[f.estado]

  return (
    <div className={`rounded-xl border p-3.5 ${color}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-slate-200">{f.concepto}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            N° {f.numero} · vence el {fecha(f.vencimiento)}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p
            className={`font-semibold ${f.estado === 'pagada' ? 'text-slate-500' : 'text-slate-100'}`}
          >
            {dinero(f.estado === 'pagada' ? f.total : f.pendiente)}
          </p>
          <Etiqueta estado={f.estado} />
        </div>
      </div>

      {/* El pago parcial se dice: si alguien abonó la mitad, ver el total
          entero le haría pensar que su pago no se registró. */}
      {f.pagado > 0 && f.estado !== 'pagada' && (
        <p className="mt-1.5 text-xs text-slate-500">
          Ya abonaste {dinero(f.pagado)} de {dinero(f.total)}
        </p>
      )}
    </div>
  )
}

const Etiqueta = ({ estado }) => {
  const estilo = {
    vencida: 'text-rose-400',
    pendiente: 'text-amber-400',
    pagada: 'text-emerald-500',
  }[estado]
  const texto = { vencida: 'Vencida', pendiente: 'Por pagar', pagada: 'Pagada' }[estado]
  return <p className={`text-[11px] ${estilo}`}>{texto}</p>
}
