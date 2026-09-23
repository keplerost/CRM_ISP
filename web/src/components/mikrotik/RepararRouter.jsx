import { useState } from 'react'
import { Trash2, Wrench } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, Card, ErrorBanner } from '../ui'

/**
 * Dejar el router igual a lo que dice el sistema.
 *
 * Sirve para dos momentos distintos:
 *
 *   DESPUÉS DE MIGRAR. El router quedó armado por el sistema anterior. Esto lo
 *   reescribe con los datos de acá y deja de tener rastro del otro.
 *
 *   TODOS LOS DÍAS. Se cobra un pago con el router caído y el abonado queda en
 *   la lista de morosos aunque ya no deba. O se le cambia la IP en el sistema y
 *   el secret sigue con la vieja. Nadie lo ve hasta que el cliente llama.
 *
 * Nunca borra lo que no reconoce sin que se lo pidan: un secret que el sistema
 * no tiene puede ser un abonado cuya ficha no se migró todavía, y borrarlo lo
 * deja sin internet.
 */
export default function RepararRouter({ router }) {
  const [plan, setPlan] = useState(null)
  const [hecho, setHecho] = useState(null)
  const [error, setError] = useState(null)
  const [trabajando, setTrabajando] = useState(false)
  const [borrarDesconocidos, setBorrarDesconocidos] = useState(false)

  const correr = async (aplicar) => {
    setTrabajando(true)
    setError(null)
    try {
      const r = aplicar
        ? await api.mikrotik.reparar(router.id, { borrarDesconocidos })
        : await api.mikrotik.revisarReparacion(router.id)
      if (aplicar) setHecho(r)
      else setPlan(r)
    } catch (err) {
      setError(err)
    } finally {
      setTrabajando(false)
    }
  }

  if (hecho) {
    return (
      <Card>
        <div className="space-y-2 p-4 text-sm">
          <p className="font-medium text-emerald-300">
            {hecho.secrets} secrets · {hecho.colas ?? 0} colas · {hecho.leases ?? 0} leases ·{' '}
            {hecho.bloqueos} bloqueos
            {hecho.borrados ? ` · ${hecho.borrados} borrados` : ''}
          </p>
          {hecho.fallos?.map((f) => (
            <p key={f} className="text-xs text-rose-400">
              {f}
            </p>
          ))}
          <Button
            variante="fantasma"
            onClick={() => {
              setHecho(null)
              setPlan(null)
            }}
          >
            Volver a revisar
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <div className="space-y-3 p-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Reparar el router</h3>
          <p className="mt-0.5 text-xs leading-snug text-slate-500">
            Compara lo que dice el sistema contra lo que tiene el MikroTik y corrige la
            diferencia: colas y secrets que faltan, IPs que no coinciden, y abonados que pagaron y
            siguen bloqueados porque el router estaba caído.
          </p>
        </div>

        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {!plan ? (
          <Button variante="primario" icon={Wrench} cargando={trabajando} onClick={() => correr(false)}>
            Ver qué está distinto
          </Button>
        ) : (
          <>
            {plan.resumen.sin_cambios ? (
              <Aviso>
                El router coincide con el sistema en sus {plan.resumen.clientes} abonados. No hay
                nada que corregir.
              </Aviso>
            ) : (
              <>
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <Dato n={plan.resumen.colas_a_crear} t="colas a crear" />
                <Dato n={plan.resumen.colas_a_corregir} t="colas a corregir" />
                <Dato n={plan.resumen.leases_a_corregir} t="leases a corregir" />
                <Dato n={plan.resumen.colas_duplicadas} t="colas duplicadas" />
                <Dato n={plan.resumen.secrets_a_crear} t="secrets a crear" />
                <Dato n={plan.resumen.secrets_a_corregir} t="secrets a corregir" />
                <Dato n={plan.resumen.bloqueos_a_agregar} t="a bloquear" />
                <Dato n={plan.resumen.bloqueos_a_quitar} t="a desbloquear" color="text-emerald-400" />
              </div>

              {plan.colas?.faltan?.length > 0 && (
                <Lista titulo="Sin cola en el router">
                  {plan.colas.faltan.map((c) => (
                    <li key={c.id} className="py-1">
                      <span className="text-slate-200">{c.cliente}</span>
                      <span className="ml-2 font-mono text-slate-500">{c.ip}</span>
                      <span className="ml-2 text-amber-400">navega sin límite</span>
                    </li>
                  ))}
                </Lista>
              )}

              {plan.colas?.corregir?.length > 0 && (
                <Lista titulo="Colas que no coinciden">
                  {plan.colas.corregir.map((c) => (
                    <li key={c.id} className="py-1">
                      <span className="text-slate-200">{c.cliente}</span>
                      <span className="ml-2 text-amber-400">
                        {c.diferencias
                          .map((d) => `${d.campo}: router ${d.router} → sistema ${d.sistema}`)
                          .join(' · ')}
                      </span>
                    </li>
                  ))}
                </Lista>
              )}

              {plan.leases?.corregir?.length > 0 && (
                <Lista titulo="Leases con otra dirección">
                  {plan.leases.corregir.map((l) => (
                    <li key={l.id} className="py-1">
                      <span className="text-slate-200">{l.cliente}</span>
                      <span className="ml-2 text-amber-400">{l.motivo}</span>
                    </li>
                  ))}
                </Lista>
              )}
              </>
            )}

            {plan.secrets.length > 0 && (
              <Lista titulo="Secrets">
                {plan.secrets.map((s) => (
                  <li key={s.usuario} className="py-1">
                    <span className="font-mono text-slate-200">{s.usuario}</span>
                    <span className="ml-2 text-slate-500">{s.cliente}</span>
                    {s.accion === 'crear' ? (
                      <Badge color="verde">crear</Badge>
                    ) : (
                      <span className="ml-2 text-amber-400">
                        {s.diferencias
                          ?.map((d) => `${d.campo}: router ${d.router} → sistema ${d.sistema}`)
                          .join(' · ')}
                      </span>
                    )}
                  </li>
                ))}
              </Lista>
            )}

            {plan.morosos.length > 0 && (
              <Lista titulo="Lista de morosos">
                {plan.morosos.map((m) => (
                  <li key={m.ip} className="py-1">
                    <span className="font-mono text-slate-200">{m.ip}</span>
                    <span className="ml-2 text-slate-500">{m.cliente}</span>
                    <span className={`ml-2 ${m.accion === 'quitar' ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {m.motivo}
                    </span>
                  </li>
                ))}
              </Lista>
            )}

            {/* Lo que falta en el sistema, no en el router. Se dice aparte
                porque no se arregla desde acá: hay que completar la ficha. */}
            {plan.sin_datos.length > 0 && (
              <Aviso tipo="alerta">
                {plan.sin_datos.length} abonados no se pueden reparar porque les falta un dato en el
                sistema:{' '}
                {plan.sin_datos
                  .slice(0, 4)
                  .map((d) => `${d.cliente} (${d.falta})`)
                  .join(' · ')}
                {plan.sin_datos.length > 4 && ` y ${plan.sin_datos.length - 4} más`}
              </Aviso>
            )}

            {/*
              Los accesos que NO son de abonados: L2TP, PPTP, SSTP, OpenVPN.
              Viven en el mismo `/ppp secret` que los clientes, y uno de ellos
              suele ser por donde el administrador entra al sector. Se muestran
              para que se sepa que están, y NO se ofrecen para borrar.
            */}
            {plan.desconocidos.accesos?.length > 0 && (
              <div className="rounded-lg border border-[rgba(15,23,42,0.08)] p-3">
                <p className="text-xs text-slate-400">
                  Además hay <b>{plan.desconocidos.accesos.length}</b> acceso(s) de VPN en el
                  router —L2TP, PPTP u OpenVPN— que no son abonados y no se tocan:{' '}
                  {plan.desconocidos.accesos.map((a) => `${a.usuario} (${a.servicio})`).join(', ')}
                </p>
              </div>
            )}

            {plan.resumen.desconocidos_en_router > 0 && (
              <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="text-xs text-amber-200">
                  El router tiene <b>{plan.desconocidos.secrets.length} secrets</b> y{' '}
                  <b>{plan.desconocidos.bloqueos.length} bloqueos</b> que el sistema no conoce.
                </p>
                <p className="text-[11px] leading-snug text-amber-200/70">
                  Pueden ser abonados cuya ficha todavía no se migró. Borrarlos los deja sin
                  internet sin que nadie sepa por qué, así que no se tocan salvo que lo pidas.
                  Los accesos de VPN del administrador no entran acá: se listan aparte y nunca
                  se borran.
                </p>
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={borrarDesconocidos}
                    onChange={(e) => setBorrarDesconocidos(e.target.checked)}
                  />
                  Borrarlos — el router queda solo con lo que dice el sistema
                </label>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variante={borrarDesconocidos ? 'peligro' : 'primario'}
                icon={borrarDesconocidos ? Trash2 : Wrench}
                cargando={trabajando}
                disabled={plan.resumen.sin_cambios && !borrarDesconocidos}
                onClick={() => correr(true)}
              >
                Reparar
                {borrarDesconocidos ? ` y borrar ${plan.resumen.desconocidos_en_router}` : ''}
              </Button>
              <Button variante="fantasma" onClick={() => setPlan(null)}>
                Cancelar
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

const Dato = ({ n, t, color }) => (
  <div className="rounded border border-slate-800 bg-[#F6F8FB] p-2">
    <p className={`text-lg font-semibold ${n ? (color ?? 'text-slate-100') : 'text-slate-600'}`}>{n}</p>
    <p className="text-[11px] text-slate-500">{t}</p>
  </div>
)

const Lista = ({ titulo, children }) => (
  <div>
    <p className="mb-1 text-[11px] uppercase tracking-wider text-slate-500">{titulo}</p>
    <ul className="max-h-48 divide-y divide-slate-800/60 overflow-y-auto rounded border border-slate-800 px-3 text-xs">
      {children}
    </ul>
  </div>
)
