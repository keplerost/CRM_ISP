import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, Card, ErrorBanner, Input } from '../ui'

/**
 * Dejar un equipo recién cargado listo para operar.
 *
 * Es el paso que antes se hacía pegando comandos en la terminal del MikroTik.
 * En la puesta en marcha del primer router del piloto llevó media tarde, y dos
 * de los errores fueron de tipeo.
 *
 * Primero muestra el plan y después aplica, igual que `RepararRouter`. En un
 * equipo con abonados, ver qué va a pasar antes de que pase no es una cortesía:
 * es lo que permite apretar el botón delante del cliente sin jugarse nada.
 */

const SEMAFORO = {
  ok: { color: 'verde', texto: 'listo' },
  falta: { color: 'ambar', texto: 'falta' },
  atencion: { color: 'ambar', texto: 'revisar' },
  error: { color: 'rojo', texto: 'error' },
  'no-aplica': { color: 'gris', texto: 'no aplica' },
}

export default function ConfigurarRouter({ router }) {
  const [plan, setPlan] = useState(null)
  const [hecho, setHecho] = useState(null)
  const [error, setError] = useState(null)
  const [trabajando, setTrabajando] = useState(false)
  const [destino, setDestino] = useState('')
  const [forzarApi, setForzarApi] = useState(false)

  const revisar = async () => {
    setTrabajando(true)
    setError(null)
    try {
      setHecho(null)
      setPlan(await api.mikrotik.revisarConfiguracion(router.id))
    } catch (err) {
      setError(err)
    } finally {
      setTrabajando(false)
    }
  }

  const aplicar = async () => {
    setTrabajando(true)
    setError(null)
    try {
      // Solo lo que falta. Los pasos en 'ok' son idempotentes igual, pero
      // mandarlos sería pedirle al router trabajo que no hace falta.
      const pasos = plan.pasos
        .filter((p) => p.estado === 'falta' || (p.estado === 'atencion' && forzarApi))
        .map((p) => p.clave)

      setHecho(
        await api.mikrotik.configurar(router.id, {
          pasos,
          destinoAviso: destino.trim() || undefined,
          forzarApi,
        }),
      )
    } catch (err) {
      setError(err)
    } finally {
      setTrabajando(false)
    }
  }

  const faltantes = plan?.pasos.filter((p) => p.estado === 'falta') ?? []
  const pideDestino = faltantes.some((p) => p.requiereDestino)
  const pideConfirmar = plan?.pasos.some((p) => p.requiereConfirmacion)
  const hayQueHacer = faltantes.length > 0 || (pideConfirmar && forzarApi)

  return (
    <Card>
      <div className="space-y-3 p-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Configurar el equipo</h3>
          <p className="mt-0.5 text-xs leading-snug text-slate-500">
            Revisa que el router tenga lo que el sistema necesita para trabajar —la regla de corte,
            su equivalente en IPv6, la página de aviso y el permiso de API desde la red de gestión—
            y crea lo que falte. No levanta la VPN: el túnel tiene que existir antes.
          </p>
        </div>

        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {hecho ? (
          <>
            <ul className="divide-y divide-[rgba(15,23,42,0.06)] text-sm">
              {hecho.hechos.map((h) => (
                <li key={h.clave} className="flex items-start gap-2 py-2">
                  <Badge color={h.ok ? (h.cambio ? 'verde' : 'gris') : 'rojo'}>
                    {h.ok ? (h.cambio ? 'aplicado' : 'sin cambios') : 'falló'}
                  </Badge>
                  <div className="min-w-0">
                    <p className="font-medium text-slate-100">{h.titulo}</p>
                    <p className="text-xs leading-snug text-slate-500">{h.mensaje}</p>
                  </div>
                </li>
              ))}
            </ul>
            {hecho.hechos.length === 0 && <Aviso>No había nada seleccionado para aplicar.</Aviso>}
            <Button variante="fantasma" onClick={revisar} cargando={trabajando}>
              Volver a revisar
            </Button>
          </>
        ) : !plan ? (
          <Button variante="primario" icon={ShieldCheck} cargando={trabajando} onClick={revisar}>
            Revisar el equipo
          </Button>
        ) : (
          <>
            {plan.redGestion && (
              <p className="text-xs text-slate-500">
                Red de gestión: <span className="font-mono text-slate-300">{plan.redGestion}</span>
              </p>
            )}

            <ul className="divide-y divide-[rgba(15,23,42,0.06)] text-sm">
              {plan.pasos.map((p) => {
                const s = SEMAFORO[p.estado] ?? SEMAFORO.error
                return (
                  <li key={p.clave} className="flex items-start gap-2 py-2">
                    <Badge color={s.color}>{s.texto}</Badge>
                    <div className="min-w-0">
                      <p className="font-medium text-slate-100">{p.titulo}</p>
                      <p className="text-xs leading-snug text-slate-500">{p.detalle}</p>
                    </div>
                  </li>
                )
              })}
            </ul>

            {pideDestino && (
              <label className="block text-xs text-slate-500">
                A qué dirección mandar al abonado cortado
                <Input
                  value={destino}
                  onChange={(e) => setDestino(e.target.value)}
                  placeholder="10.66.0.1"
                />
                <span className="mt-1 block leading-snug">
                  Es la dirección donde este router alcanza al servidor. Si se deja vacío, ese paso
                  se salta y el resto se aplica igual.
                </span>
              </label>
            )}

            {pideConfirmar && (
              <Aviso tipo="alerta">
                <label className="flex items-start gap-2">
                  <input
                    id="forzar-api"
                    type="checkbox"
                    checked={forzarApi}
                    onChange={(e) => setForzarApi(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-xs leading-snug">
                    Restringir igual la API a la red de gestión. Hoy responde a cualquier origen:
                    al restringirla, <b>cualquier otro sistema que administre este router deja de
                    entrar</b>. Marcá esto solo si sabés que ninguno lo hace.
                  </span>
                </label>
              </Aviso>
            )}

            <div className="flex gap-2">
              <Button
                variante="primario"
                icon={ShieldCheck}
                cargando={trabajando}
                disabled={!hayQueHacer}
                onClick={aplicar}
              >
                {hayQueHacer ? `Aplicar lo que falta (${faltantes.length})` : 'No hay nada que hacer'}
              </Button>
              <Button variante="fantasma" onClick={revisar} cargando={trabajando}>
                Volver a revisar
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  )
}
