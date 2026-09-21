import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Gauge, Wifi, WifiOff } from 'lucide-react'
import { portalApi } from '../../lib/portalApi'
import { dineroCero as dinero } from '../../lib/formato'
import { Tarjeta } from './PortalApp'

/**
 * La primera pantalla.
 *
 * Contesta, en el orden en que preocupa, las tres preguntas con las que el
 * abonado entra: ¿tengo servicio?, ¿debo algo?, ¿mi equipo está bien?
 *
 * Si está cortado, eso va arriba de todo y dice por qué. Un "servicio
 * suspendido" a secas termina igual en una llamada a la oficina: lo que hace
 * falta es que sepa cuánto pagar para volver.
 */
export default function PortalInicio({ cuenta }) {
  const [consumo, setConsumo] = useState(null)

  useEffect(() => {
    portalApi.consumo().then(setConsumo).catch(() => setConsumo(null))
  }, [])

  const cortado = cuenta.servicio.estado === 'cortado'
  const suspendido = cuenta.servicio.estado === 'suspendido'
  const debe = Number(cuenta.cuenta.saldo) > 0

  return (
    <div className="space-y-3">
      {/* El estado del servicio, primero y grande. */}
      <div
        className={`rounded-2xl border p-4 ${
          cortado || suspendido
            ? 'border-amber-500/40 bg-amber-500/10'
            : 'border-emerald-500/30 bg-emerald-500/10'
        }`}
      >
        <div className="flex items-start gap-3">
          {cortado || suspendido ? (
            <AlertTriangle size={22} className="mt-0.5 shrink-0 text-amber-400" />
          ) : (
            <CheckCircle2 size={22} className="mt-0.5 shrink-0 text-emerald-400" />
          )}
          <div>
            <p
              className={`font-medium ${cortado || suspendido ? 'text-amber-200' : 'text-emerald-200'}`}
            >
              {cortado
                ? 'Tu servicio está suspendido'
                : suspendido
                  ? 'Tu servicio está pausado'
                  : 'Tu servicio está activo'}
            </p>
            {/* El motivo y la salida, no solo el diagnóstico. */}
            {cortado && (
              <p className="mt-1 text-sm leading-snug text-amber-200/80">
                {debe
                  ? `Tenés ${dinero(cuenta.cuenta.saldo)} pendientes. Al registrarse el pago, el servicio vuelve solo.`
                  : 'Comunicate con nosotros para reactivarlo.'}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* La deuda, cuando la hay y el servicio todavía anda: es el aviso que
          evita el corte, y por eso va antes que cualquier otra cosa. */}
      {debe && !cortado && (
        <Tarjeta>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-slate-500">Tenés pendiente</p>
              <p className="text-2xl font-semibold text-slate-100">{dinero(cuenta.cuenta.saldo)}</p>
            </div>
            <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-medium text-amber-300">
              {cuenta.cuenta.facturas_pendientes}{' '}
              {cuenta.cuenta.facturas_pendientes === 1 ? 'factura' : 'facturas'}
            </span>
          </div>
        </Tarjeta>
      )}

      <Tarjeta titulo="Tu plan">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-lg font-medium text-slate-100">
              {cuenta.servicio.plan ?? 'Sin plan asignado'}
            </p>
            {cuenta.servicio.bajada_mbps && (
              <p className="mt-0.5 text-sm text-slate-500">
                {cuenta.servicio.bajada_mbps} Mbps de bajada · {cuenta.servicio.subida_mbps} de
                subida
              </p>
            )}
          </div>
          {cuenta.servicio.precio != null && (
            <p className="text-sm text-slate-400">{dinero(cuenta.servicio.precio)}/mes</p>
          )}
        </div>
      </Tarjeta>

      {cuenta.equipo && (
        <Tarjeta titulo="Tu equipo">
          <div className="space-y-3">
            <div className="flex items-center gap-2.5">
              {cuenta.equipo.en_linea ? (
                <Wifi size={18} className="text-emerald-400" />
              ) : (
                <WifiOff size={18} className="text-slate-600" />
              )}
              <span className="text-sm text-slate-200">
                {cuenta.equipo.en_linea ? 'Conectado' : 'Sin conexión'}
              </span>
              {cuenta.equipo.modelo && (
                <span className="ml-auto text-xs text-slate-600">{cuenta.equipo.modelo}</span>
              )}
            </div>

            {/* La señal en palabras. "−24.7 dBm" no le dice nada a nadie que no
                sea técnico, y quien sí lo es la ve en el sistema. */}
            {cuenta.equipo.senal && (
              <div className="flex items-center gap-2 text-sm">
                <span
                  className={`size-2 rounded-full ${
                    { buena: 'bg-emerald-400', regular: 'bg-amber-400', mala: 'bg-rose-400' }[
                      cuenta.equipo.senal.nivel
                    ]
                  }`}
                />
                <span className="text-slate-400">{cuenta.equipo.senal.texto}</span>
              </div>
            )}

            {!cuenta.equipo.en_linea && (
              <p className="rounded-lg bg-slate-800/60 p-3 text-xs leading-relaxed text-slate-400">
                Probá desenchufar el equipo, esperar un minuto y volver a enchufarlo. Si sigue sin
                conectar, mandanos un reclamo desde <b>Ayuda</b>.
              </p>
            )}
          </div>
        </Tarjeta>
      )}

      {consumo && consumo.dias.length > 0 && (
        <Tarjeta titulo="Consumo del último mes">
          <div className="flex items-center gap-3">
            <Gauge size={20} className="text-sky-400" />
            <div>
              <p className="text-xl font-semibold text-slate-100">{consumo.total_gb} GB</p>
              <p className="text-xs text-slate-500">en los últimos 30 días</p>
            </div>
          </div>
          <Barras dias={consumo.dias} />
        </Tarjeta>
      )}
    </div>
  )
}

/**
 * El consumo diario, en barras.
 *
 * Sin librería de gráficos: son treinta números y un div por cada uno. Traer
 * cien kilobytes de librería para esto le costaría datos móviles al abonado
 * cada vez que entra.
 */
function Barras({ dias }) {
  const max = Math.max(...dias.map((d) => d.bajada_gb + d.subida_gb), 0.1)

  return (
    <div className="mt-3 flex h-16 items-end gap-0.5">
      {dias.map((d) => {
        const total = d.bajada_gb + d.subida_gb
        return (
          <div
            key={d.fecha}
            title={`${d.fecha}: ${total.toFixed(1)} GB`}
            className="flex-1 rounded-t bg-sky-500/50"
            style={{ height: `${Math.max(2, (total / max) * 100)}%` }}
          />
        )
      })}
    </div>
  )
}
