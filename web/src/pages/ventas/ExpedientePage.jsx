import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Check, FileSignature, Send, X } from 'lucide-react'
import {
  Aviso,
  Badge,
  Button,
  Cargando,
  ErrorBanner,
  Field,
  Input,
  Textarea,
} from '../../components/ui'
import CapturaFoto from '../../components/ventas/CapturaFoto'
import CapturaUbicacion from '../../components/ventas/CapturaUbicacion'
import { usePermisos } from '../../lib/AuthContext'
import { useTemaCampo } from '../../lib/temaCampo'
import BotonTema from '../../components/ventas/BotonTema'
import { dineroCero as dinero } from '../../lib/formato'
import { ESTADOS_FIRMA, PASOS, expedientesApi, loQueFalta } from '../../lib/expedientes'

/**
 * El expediente de venta, paso por paso.
 *
 * ── Mobile-first, y en serio ──
 *
 * Va fuera del layout de escritorio, igual que el alta en campo del técnico: se
 * usa parado en la vereda, con una mano, con el cliente esperando. Todo el ancho
 * es para el paso actual, los botones son altos y la navegación está abajo,
 * donde llega el pulgar.
 *
 * ── Cada paso guarda solo ──
 *
 * No hay un "guardar todo" al final. La foto se sube cuando se saca, la
 * ubicación cuando se confirma. El vendedor se queda sin señal con una
 * frecuencia que sorprende, y cuando vuelve tiene que retomar donde estaba —no
 * empezar de cero con el cliente mirando.
 */
export default function ExpedientePage() {
  const { id } = useParams()
  const navegar = useNavigate()
  const { perfil } = usePermisos()
  const { tema, alternar } = useTemaCampo()

  const [expediente, setExpediente] = useState(null)
  const [documentos, setDocumentos] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [paso, setPaso] = useState(1)
  const [enviando, setEnviando] = useState(false)

  const recargar = useCallback(async () => {
    try {
      const { expediente: e, documentos: d } = await expedientesApi.abrir(id)
      setExpediente(e)
      setDocumentos(d)
      return e
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [id])

  useEffect(() => {
    recargar()
  }, [recargar])

  // Abre donde de verdad se cortó, no siempre en el primero.
  useEffect(() => {
    if (!expediente || paso !== 1) return
    if (!expediente.ok_datos) return setPaso(1)
    if (!expediente.ok_cedula_frontal || !expediente.ok_cedula_posterior) return setPaso(2)
    if (!expediente.ok_fotos) return setPaso(3)
    if (!expediente.ok_ubicacion) return setPaso(4)
    setPaso(5)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expediente?.id])

  if (cargando) return <Cargando texto="Cargando el expediente…" />

  if (!expediente) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />
        <Aviso tipo="alerta">No existe ese expediente, o ya no está en tu cartera.</Aviso>
        <Link to="/ventas/prospectos" className="text-sm text-sky-400 hover:underline">
          Volver a Prospectos
        </Link>
      </div>
    )
  }

  const docDe = (tipo) => documentos.find((d) => d.tipo === tipo && d.estado !== 'rechazado')
  const falta = loQueFalta(expediente)
  const actual = PASOS.find((p) => p.n === paso) ?? PASOS[0]

  // --- Ya enviado -----------------------------------------------------------
  if (expediente.estado === 'enviado') {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6 text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-emerald-500/15 text-emerald-400">
          <Check size={32} />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Enviado a instalaciones</h1>
          <p className="mt-2 text-sm text-slate-400">
            La venta de <b>{expediente.cliente}</b> ya está en la bandeja del backoffice con toda la
            documentación. Podés seguir su estado desde el tablero.
          </p>
        </div>
        <Button variante="primario" className="w-full" onClick={() => navegar('/ventas/tablero')}>
          Volver al tablero
        </Button>
      </div>
    )
  }

  return (
    <div className="campo campo-fondo flex min-h-dvh flex-col" data-tema={tema}>
      {/* Cabecera fija: de quién es esta venta, siempre a la vista. */}
      <header className="campo-fondo campo-borde sticky top-0 z-10 border-b px-4 py-3">
        <div className="mx-auto flex max-w-2xl items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="campo-txt truncate text-sm font-semibold">{expediente.cliente}</p>
            <p className="campo-tenue truncate text-[11px]">
              {expediente.plan ?? 'sin plan'}
              {expediente.plan_precio ? ` · ${dinero(expediente.plan_precio)}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <BotonTema tema={tema} onAlternar={alternar} />
            <Link
              to="/ventas/prospectos"
              className="grid h-11 w-11 place-items-center rounded-lg campo-suave"
              aria-label="Salir"
            >
              <X size={18} />
            </Link>
          </div>
        </div>

        <nav className="mx-auto mt-3 flex max-w-2xl gap-1.5">
          {PASOS.map((p) => {
            const listo =
              (p.n === 1 && expediente.ok_datos) ||
              (p.n === 2 && expediente.ok_cedula_frontal && expediente.ok_cedula_posterior) ||
              (p.n === 3 && expediente.ok_fotos) ||
              (p.n === 4 && expediente.ok_ubicacion) ||
              (p.n === 5 && expediente.ok_firma)
            return (
              <button
                key={p.n}
                type="button"
                onClick={() => setPaso(p.n)}
                className={`flex-1 rounded-full py-1 text-[10px] font-medium transition ${
                  p.n === paso
                    ? 'bg-sky-500/20 text-sky-300'
                    : listo
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : 'campo-sup campo-tenue'
                }`}
              >
                {p.corto}
              </button>
            )
          })}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 space-y-4 p-4">
        <div>
          <p className="campo-tenue text-[11px] uppercase tracking-wider">
            Paso {actual.n} de {PASOS.length}
          </p>
          <h1 className="campo-txt text-lg font-semibold">{actual.titulo}</h1>
        </div>

        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {/* PASO 1 — datos */}
        {paso === 1 && (
          <div className="space-y-4">
            <Aviso>
              Confirmá estos datos con el cliente delante. Después se usan para el contrato y para
              que el técnico llegue.
            </Aviso>
            <div className="campo-sup campo-borde space-y-2 rounded-xl border p-3 text-[13px]">
              <Dato etiqueta="Nombre" valor={expediente.cliente} />
              <Dato etiqueta="Teléfono" valor={expediente.telefono} />
              <Dato etiqueta="Dirección" valor={expediente.direccion} />
              <Dato etiqueta="Sector" valor={expediente.sector} />
              <Dato etiqueta="Cómo llegar" valor={expediente.como_llegar} />
              <Dato etiqueta="Plan" valor={expediente.plan} />
            </div>
            {!expediente.ok_plan && (
              <Aviso tipo="alerta">
                Falta el plan. Volvé a la ficha del prospecto y elegí cuál contrató.
              </Aviso>
            )}
            <Field label="Observaciones para el técnico">
              <Textarea
                rows={3}
                defaultValue={expediente.notas ?? ''}
                onBlur={(e) => expedientesApi.guardar(expediente.id, { notas: e.target.value })}
                placeholder="Perro suelto, timbre roto, preguntar por la señora…"
              />
            </Field>
            <Button
              variante="primario"
              className="w-full py-4 text-base"
              onClick={async () => {
                try {
                  await expedientesApi.guardar(expediente.id, {
                    datos_confirmados_en: new Date().toISOString(),
                  })
                  await recargar()
                  setPaso(2)
                } catch (err) {
                  setError(err)
                }
              }}
            >
              {expediente.ok_datos ? 'Datos confirmados · continuar' : 'Confirmo que están bien'}
            </Button>
          </div>
        )}

        {/* PASO 2 — cédula */}
        {paso === 2 && (
          <div className="space-y-3">
            <Aviso>
              Las dos caras. Que se lea el número: si sale borrosa, el backoffice la rechaza y hay
              que volver.
            </Aviso>
            {['cedula_frontal', 'cedula_posterior'].map((t) => (
              <CapturaFoto
                key={t}
                expedienteId={expediente.id}
                tipo={t}
                documento={docDe(t)}
                perfil={perfil}
                onCambio={recargar}
                onError={setError}
              />
            ))}
          </div>
        )}

        {/* PASO 3 — domicilio */}
        {paso === 3 && (
          <div className="space-y-3">
            <Aviso>
              Con una alcanza, pero las tres ayudan al técnico a encontrar la casa sin llamar.
            </Aviso>
            {['fachada', 'referencia', 'lugar_instalacion'].map((t) => (
              <CapturaFoto
                key={t}
                expedienteId={expediente.id}
                tipo={t}
                documento={docDe(t)}
                perfil={perfil}
                onCambio={recargar}
                onError={setError}
              />
            ))}
          </div>
        )}

        {/* PASO 4 — ubicación */}
        {paso === 4 && (
          <CapturaUbicacion
            expediente={expediente}
            onError={setError}
            onGuardar={async (datos) => {
              await expedientesApi.guardarUbicacion({
                expedienteId: expediente.id,
                ...datos,
                perfil,
              })
              await recargar()
            }}
          />
        )}

        {/* PASO 5 — contrato y firma */}
        {paso === 5 && (
          <div className="space-y-4">
            {!expediente.ok_contrato ? (
              <>
                <Aviso>
                  El contrato se arma con los datos que ya cargaste: cliente, plan, precio y
                  dirección.
                </Aviso>
                <Button
                  variante="primario"
                  className="w-full py-4 text-base"
                  icon={FileSignature}
                  disabled={!expediente.ok_plan}
                  onClick={async () => {
                    try {
                      await expedientesApi.generarContrato({ expediente, perfil })
                      await recargar()
                    } catch (err) {
                      setError(err)
                    }
                  }}
                >
                  Generar contrato
                </Button>
              </>
            ) : (
              <div className="campo-sup campo-borde space-y-3 rounded-xl border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] text-slate-200">
                    Contrato {expediente.contrato_numero ?? ''}
                  </span>
                  <Badge color={ESTADOS_FIRMA[expediente.firma_estado]?.color ?? 'gris'}>
                    {ESTADOS_FIRMA[expediente.firma_estado]?.label ?? expediente.firma_estado}
                  </Badge>
                </div>

                {/* Acá va el proveedor de firma cuando esté contratado. Hasta
                    entonces el expediente no avanza, y se dice por qué en vez de
                    ofrecer un botón que no hace lo que promete. */}
                <Aviso tipo="alerta">
                  <b>Falta conectar el proveedor de firma.</b> Cuando esté, desde acá se le manda al
                  cliente el enlace y firma con verificación biométrica. El expediente no se puede
                  enviar a instalaciones hasta que el contrato esté firmado — es la regla que pediste.
                </Aviso>
              </div>
            )}

            {/* El envío al backoffice */}
            <div className="campo-sup campo-borde rounded-xl border p-3">
              <h3 className="campo-txt mb-2 text-sm font-medium">Enviar a instalaciones</h3>
              {falta.length > 0 ? (
                <div className="space-y-1 text-[13px] text-slate-400">
                  <p>Falta:</p>
                  <ul className="space-y-0.5">
                    {falta.map((f) => (
                      <li key={f} className="text-amber-400">
                        · {f}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-[13px] text-emerald-400">
                  Todo listo. Al enviarlo se crea la orden y aparece en el backoffice.
                </p>
              )}
              <Button
                variante="primario"
                icon={Send}
                className="mt-3 w-full py-4 text-base"
                disabled={falta.length > 0 || enviando}
                cargando={enviando}
                onClick={async () => {
                  setEnviando(true)
                  try {
                    await expedientesApi.enviar(expediente.id)
                    await recargar()
                  } catch (err) {
                    setError(err)
                  } finally {
                    setEnviando(false)
                  }
                }}
              >
                Enviar a instalaciones
              </Button>
            </div>
          </div>
        )}
      </main>

      {/* Navegación abajo, donde llega el pulgar. */}
      <footer className="campo-fondo campo-borde sticky bottom-0 border-t px-4 py-3">
        <div className="mx-auto flex max-w-2xl gap-2">
          <Button
            className="flex-1 py-3"
            icon={ArrowLeft}
            disabled={paso === 1}
            onClick={() => setPaso((p) => Math.max(1, p - 1))}
          >
            Atrás
          </Button>
          <Button
            className="flex-1 py-3"
            disabled={paso === PASOS.length}
            onClick={() => setPaso((p) => Math.min(PASOS.length, p + 1))}
          >
            Siguiente <ArrowRight size={16} />
          </Button>
        </div>
      </footer>
    </div>
  )
}

const Dato = ({ etiqueta, valor }) => (
  <div className="flex justify-between gap-3">
    <span className="campo-tenue">{etiqueta}</span>
    <span className="campo-txt text-right">{valor || '—'}</span>
  </div>
)
