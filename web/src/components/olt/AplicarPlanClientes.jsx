import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Users } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Button, Cargando, ErrorBanner, Modal } from '../ui'

/**
 * Aplicar la velocidad de un plan a todos sus abonados.
 *
 * Se abre en dos tiempos —primero qué pasaría, después hacerlo— porque es una
 * operación que se aprieta una vez y toca los equipos de cientos de personas.
 * Ver de antemano a cuántos afecta es lo que permite darse cuenta de que se
 * eligió el plan equivocado ANTES y no después.
 *
 * La asimetría que explica toda esta pantalla: en PPPoE el límite lo pone el
 * perfil, que es uno solo y lo comparten todos —no hay nada que reescribir—;
 * con IP fija cada abonado tiene su propia cola y hay que ir de a una.
 */

function Fila({ icono: Icono, color, titulo, children }) {
  return (
    <div className="flex items-start gap-3 t-panel px-3 py-2.5">
      <Icono size={16} className={`mt-0.5 shrink-0 ${color}`} />
      <div className="min-w-0 flex-1 text-sm">
        <p className="text-slate-200">{titulo}</p>
        {children && <div className="mt-1 text-xs text-slate-500">{children}</div>}
      </div>
    </div>
  )
}

const COLOR_REVISION = {
  ok: 'text-emerald-400',
  difiere: 'text-amber-400',
  no_existe: 'text-rose-400',
  sin_limite: 'text-rose-400',
  error: 'text-slate-500',
}

export default function AplicarPlanClientes({ plan, onCerrar }) {
  const [impacto, setImpacto] = useState(null)
  const [resultado, setResultado] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [aplicando, setAplicando] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!plan) return

    let vigente = true
    setCargando(true)
    setResultado(null)
    setError(null)

    api.planes
      .impacto(plan.id)
      .then((r) => vigente && setImpacto(r))
      .catch((err) => vigente && setError(err))
      .finally(() => vigente && setCargando(false))

    return () => {
      vigente = false
    }
  }, [plan])

  async function aplicar() {
    setAplicando(true)
    setError(null)
    try {
      setResultado(await api.planes.sincronizar(plan.id))
    } catch (err) {
      setError(err)
    } finally {
      setAplicando(false)
    }
  }

  const revisiones = resultado?.pppoe?.revisiones ?? impacto?.pppoe?.revisiones ?? []

  return (
    <Modal
      abierto={Boolean(plan)}
      titulo={`Aplicar ${plan?.nombre ?? ''} a sus abonados`}
      onCerrar={onCerrar}
      ancho="max-w-xl"
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {cargando ? (
          <Cargando texto="Viendo a cuántos afecta…" />
        ) : !impacto ? null : (
          <>
            <p className="text-sm text-slate-400">
              El plan quedó en <b className="text-slate-200">{impacto.plan.bajada}</b> de bajada y{' '}
              <b className="text-slate-200">{impacto.plan.subida}</b> de subida.{' '}
              {impacto.total === 0
                ? 'Todavía no lo tiene ningún abonado.'
                : `Lo tienen ${impacto.total} abonados.`}
            </p>

            {impacto.colas.cantidad > 0 && (
              <Fila
                icono={Users}
                color="text-sky-400"
                titulo={`${impacto.colas.cantidad} con IP fija: se les reescribe la Simple Queue`}
              >
                Una por abonado, en {impacto.colas.routers}{' '}
                {impacto.colas.routers === 1 ? 'router' : 'routers'}.
              </Fila>
            )}

            {impacto.pppoe.cantidad > 0 && (
              <Fila
                icono={Check}
                color="text-slate-400"
                titulo={`${impacto.pppoe.cantidad} por PPPoE: no se les toca nada`}
              >
                El límite lo pone el perfil PPP, que es uno solo y lo comparten todos. Se corrige en
                el router una vez.
              </Fila>
            )}

            {revisiones.map((r, i) => (
              <Fila
                key={i}
                icono={r.estado === 'ok' ? Check : AlertTriangle}
                color={COLOR_REVISION[r.estado] ?? 'text-slate-400'}
                titulo={r.mensaje}
              >
                {r.aplica && (
                  <>
                    En {r.router}, el perfil aplica {r.aplica} y el plan dice {r.deberia}.
                  </>
                )}
              </Fila>
            ))}

            {/* Lo que quedó mal configurado se muestra ANTES de aplicar: es
                para lo que existe esta pantalla. No bloquea —la velocidad se
                aplica igual— pero hay que verlo. */}
            {(resultado?.avisos ?? impacto.avisos ?? []).map((a) => (
              <Fila key={a} icono={AlertTriangle} color="text-amber-400" titulo={a} />
            ))}

            {impacto.sin_datos.length > 0 && (
              <Fila
                icono={AlertTriangle}
                color="text-amber-400"
                titulo={`${impacto.sin_datos.length} quedan afuera por datos incompletos`}
              >
                {impacto.sin_datos
                  .slice(0, 5)
                  .map((c) => `${c.nombre} (falta ${c.falta})`)
                  .join(' · ')}
                {impacto.sin_datos.length > 5 && ` y ${impacto.sin_datos.length - 5} más`}
              </Fila>
            )}

            {resultado ? (
              <>
                <Aviso tipo={resultado.ok ? 'info' : 'alerta'}>{resultado.mensaje}</Aviso>

                {resultado.duplicados?.length > 0 && (
                  <Aviso tipo="alerta">
                    Hay abonados con más de una cola apuntándoles. Se corrigió la primera, pero la
                    otra puede estar limitando de más:{' '}
                    {resultado.duplicados.map((d) => `${d.nombre} (${d.ip})`).join(', ')}
                  </Aviso>
                )}

                {resultado.fallidos?.length > 0 && (
                  <Aviso tipo="alerta">
                    No se pudo con {resultado.fallidos.length}:
                    <ul className="mt-1 list-inside list-disc">
                      {resultado.fallidos.slice(0, 5).map((f, i) => (
                        <li key={i}>
                          {f.nombre} — {f.error}
                        </li>
                      ))}
                    </ul>
                  </Aviso>
                )}

                <Button className="w-full" onClick={onCerrar}>
                  Cerrar
                </Button>
              </>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <Button onClick={onCerrar}>Cancelar</Button>
                <Button
                  variante="primario"
                  cargando={aplicando}
                  disabled={impacto.colas.cantidad === 0}
                  onClick={aplicar}
                >
                  {impacto.colas.cantidad === 0
                    ? 'No hay colas que reescribir'
                    : `Aplicar a ${impacto.colas.cantidad}`}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
