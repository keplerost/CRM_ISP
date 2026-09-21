import { useState } from 'react'
import { Copy, KeyRound, RefreshCcw } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../lib/apiNetwork'
import { useLicencia } from '../lib/useLicencia'
import { Aviso, Button, Card, Cargando, ErrorBanner, Field, Textarea } from '../components/ui'

/**
 * La licencia de esta instalación.
 *
 * Se llega desde Ajustes, y también desde el login cuando venció — porque ahí
 * es cuando de verdad hace falta. Por eso no exige sesión: pedirle al cliente
 * bloqueado que entre para poder desbloquearse sería cerrar la puerta y dejar
 * la llave adentro.
 */
export default function LicenciaPage({ suelta = false }) {
  const { licencia, cargando, consultar } = useLicencia()
  const [token, setToken] = useState('')
  const [error, setError] = useState(null)
  const [trabajando, setTrabajando] = useState(false)
  const [copiado, setCopiado] = useState(false)

  async function activar(e) {
    e.preventDefault()
    setTrabajando(true)
    setError(null)
    try {
      await api.licencia.activar(token.trim())
      setToken('')
      await consultar()
      // Recargar en vez de navegar: media aplicación quedó con datos que no se
      // pudieron cargar mientras estaba bloqueada.
      if (suelta) window.location.href = '/'
    } catch (err) {
      setError(err)
    } finally {
      setTrabajando(false)
    }
  }

  /** Reintento manual: tras pagar, nadie quiere esperar a la renovación de mañana. */
  async function reintentar() {
    setTrabajando(true)
    setError(null)
    try {
      await api.licencia.renovar()
      await consultar()
    } catch (err) {
      setError(err)
    } finally {
      setTrabajando(false)
    }
  }

  function copiarId() {
    navigator.clipboard?.writeText(licencia?.instalacion ?? '')
    setCopiado(true)
    setTimeout(() => setCopiado(false), 2000)
  }

  if (cargando) return <Cargando texto="Verificando la licencia…" />

  const vencida = licencia?.habilitada === false

  /**
   * Esta copia no está bajo licencia: es la del proveedor, o un ambiente de
   * prueba. Se dice y se termina la pantalla. Mostrar "vigente" con todos los
   * campos vacíos haría pensar que hay una licencia cargada que no existe.
   */
  if (licencia && licencia.gestionada === false) {
    return (
      <div className={suelta ? 'mx-auto max-w-2xl p-6' : ''}>
        <div className="space-y-4">
          {!suelta && (
            <Link to="/ajustes" className="inline-block text-sm text-slate-400">
              ← Volver a Ajustes
            </Link>
          )}
          <h1 className="text-lg font-semibold text-slate-100">Licencia</h1>
          <Aviso>
            Esta instalación no está bajo licencia: funciona sin límite ni vencimiento. Es lo
            normal en la copia del proveedor y en los ambientes de prueba.
          </Aviso>
          <Card>
            <div className="space-y-3 p-4">
              <div className="grid grid-cols-2 gap-3">
                <Dato titulo="Abonados" valor={licencia.abonados ?? '—'} />
                <Dato titulo="Límite" valor="sin límite" />
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-500">
                  Código de esta instalación
                </p>
                <code className="mt-1 block select-all break-all rounded border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-300">
                  {licencia.instalacion}
                </code>
              </div>
              <p className="text-xs leading-snug text-slate-500">
                El licenciamiento se enciende cargando la clave pública del proveedor en{' '}
                <code className="text-slate-400">LICENCIA_CLAVE_PUBLICA</code>, dentro de{' '}
                <code className="text-slate-400">middleware/.env</code>. Recién ahí este sistema
                empieza a exigir un permiso vigente.
              </p>
            </div>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className={suelta ? 'mx-auto max-w-2xl p-6' : ''}>
      <div className="space-y-4">
        {!suelta && (
          <Link to="/ajustes" className="inline-block text-sm text-slate-400">
            ← Volver a Ajustes
          </Link>
        )}

        <div>
          <h1 className="text-lg font-semibold text-slate-100">Licencia</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            El permiso que habilita este sistema. Se renueva solo cuando el pago se acredita.
          </p>
        </div>

        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <Card>
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  vencida ? 'bg-red-500/15 text-red-300' : 'bg-emerald-500/15 text-emerald-300'
                }`}
              >
                {vencida ? 'VENCIDA' : 'Vigente'}
              </span>
              {licencia?.isp && <span className="text-sm text-slate-300">{licencia.isp}</span>}
            </div>

            {vencida && <Aviso tipo="alerta">{licencia?.motivo}</Aviso>}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Dato titulo="Abonados" valor={licencia?.abonados ?? '—'} />
              <Dato
                titulo="Cubiertos"
                valor={licencia?.clientes_max ?? (vencida ? '—' : 'sin límite')}
              />
              <Dato
                titulo="Vence"
                valor={
                  licencia?.vence ? new Date(licencia.vence).toLocaleDateString('es-EC') : '—'
                }
              />
              <Dato
                titulo="Días restantes"
                valor={licencia?.dias_restantes ?? '—'}
                color={
                  licencia?.dias_restantes != null && licencia.dias_restantes <= 5
                    ? 'text-amber-400'
                    : undefined
                }
              />
            </div>

            {/* Crecer no bloquea: se avisa y se le vende el plan que le toca.
                Apagarle el sistema al cliente que más creció sería castigar
                justo al mejor. */}
            {licencia?.excedido && <Aviso tipo="alerta">{licencia.aviso}</Aviso>}

            {licencia?.en_gracia && !vencida && (
              <Aviso tipo="alerta">
                La licencia venció y está corriendo el margen de gracia. Regularizá el pago para no
                quedar bloqueado.
              </Aviso>
            )}

            {/* Lo primero que le van a pedir al llamar al proveedor. */}
            <div>
              <p className="text-[11px] uppercase tracking-wider text-slate-500">
                Código de esta instalación
              </p>
              <div className="mt-1 flex items-center gap-2">
                <code className="select-all break-all rounded border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-300">
                  {licencia?.instalacion ?? '—'}
                </code>
                <Button type="button" variante="fantasma" icon={Copy} onClick={copiarId}>
                  {copiado ? 'Copiado' : 'Copiar'}
                </Button>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                Pasale este código a tu proveedor para que emita o renueve la licencia.
              </p>
            </div>

            {licencia?.ultimo_error && (
              <p className="text-xs text-amber-400">
                Última renovación automática: {licencia.ultimo_error}
              </p>
            )}
          </div>
        </Card>

        <Card title="Activar una licencia" icon={KeyRound}>
          <form onSubmit={activar} className="space-y-3">
            <Field label="Código" hint="El texto largo que te pasó el proveedor">
              <Textarea
                rows={4}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="eyJpbnN0YWxhY2lvbiI6…"
                className="font-mono text-xs"
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variante="primario" cargando={trabajando} disabled={!token.trim()}>
                Activar
              </Button>
              <Button
                type="button"
                variante="secundario"
                icon={RefreshCcw}
                cargando={trabajando}
                onClick={reintentar}
              >
                Buscar renovación
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  )
}

const Dato = ({ titulo, valor, color }) => (
  <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
    <p className="text-[11px] uppercase tracking-wider text-slate-500">{titulo}</p>
    <p className={`mt-1 text-lg font-semibold ${color ?? 'text-slate-100'}`}>{valor}</p>
  </div>
)
