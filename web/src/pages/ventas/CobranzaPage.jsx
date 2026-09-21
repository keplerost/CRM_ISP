import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CalendarClock,
  Check,
  MessageCircle,
  Phone,
  RefreshCw,
  Wallet,
} from 'lucide-react'
import {
  Aviso,
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
  SkeletonTabla,
  Stat,
  Textarea,
} from '../../components/ui'
import { usePermisos } from '../../lib/AuthContext'
import { useTemaCampo } from '../../lib/temaCampo'
import BotonTema from '../../components/ventas/BotonTema'
import { dineroCero as dinero } from '../../lib/formato'
import {
  CANALES,
  RESULTADOS_COBRO,
  cobranzaApi,
  enlaceWhatsApp,
  esUrgente,
} from '../../lib/cobranza'

/**
 * Cobros por gestionar.
 *
 * ── Qué NO hay en esta pantalla ──
 *
 * Un buscador de clientes. Ni un enlace a la ficha. Ni el historial de pagos.
 * La bandeja es una lista de tareas que se vacía sola cuando el cliente paga: no
 * es una vista de la cartera con otro nombre.
 *
 * Cada tarjeta trae lo justo para llamar y anotar el resultado — nombre,
 * teléfono, plan, saldo y días de atraso— porque eso es lo que hace falta para
 * cobrar. Lo demás no aparece, y tampoco se puede pedir: la tabla `clientes`
 * está cerrada por RLS para quien entra acá.
 *
 * ── El orden ──
 *
 * Por días de atraso, de mayor a menor. No por monto: un cliente con 40 días
 * debiendo $20 está más cerca del corte —y de irse a la competencia— que uno con
 * 3 días debiendo $60.
 */
export default function CobranzaPage() {
  const { perfil, puede } = usePermisos()
  const { tema, alternar } = useTemaCampo()

  const [cobros, setCobros] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [gestionando, setGestionando] = useState(null)
  const [sincronizando, setSincronizando] = useState(false)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      setCobros(await cobranzaApi.bandeja())
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  const total = useMemo(
    () => cobros.reduce((t, c) => t + Number(c.saldo_pendiente || 0), 0),
    [cobros],
  )
  const urgentes = cobros.filter(esUrgente).length
  const promesasHoy = cobros.filter(
    (c) => c.promesa_fecha && c.promesa_fecha === new Date().toISOString().slice(0, 10),
  ).length

  return (
    <div className="campo campo-fondo -m-6 space-y-5 p-6" data-tema={tema}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="campo-txt flex items-center gap-2 text-xl font-semibold">
            <Wallet size={20} className="text-sky-400" />
            Cobros por gestionar
          </h1>
          <p className="campo-suave text-sm">
            Clientes que vendiste y hoy deben. Desaparecen solos cuando pagan.
          </p>
        </div>
        <div className="flex items-center gap-1">
        <BotonTema tema={tema} onAlternar={alternar} />
        <Button
          icon={RefreshCw}
          cargando={sincronizando}
          onClick={async () => {
            setSincronizando(true)
            try {
              const r = await cobranzaApi.sincronizar()
              await recargar()
              if (r.abiertas || r.cerradas) {
                setError({
                  message: `${r.abiertas} cobros nuevos · ${r.cerradas} cerrados por pago o vencimiento`,
                })
              }
            } catch (err) {
              setError(err)
            } finally {
              setSincronizando(false)
            }
          }}
        >
          Revisar deudas
        </Button>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Por gestionar" valor={cobros.length} icon={Wallet} />
        <Stat label="Monto total" valor={dinero(total)} color="text-sky-400" />
        <Stat
          label="Más de 15 días"
          valor={urgentes}
          sub="Cerca del corte"
          icon={AlertTriangle}
          color={urgentes ? 'text-red-400' : 'text-slate-400'}
        />
        <Stat
          label="Promesas para hoy"
          valor={promesasHoy}
          icon={CalendarClock}
          color={promesasHoy ? 'text-amber-400' : 'text-slate-400'}
        />
      </div>

      {cargando ? (
        <Card>
          <SkeletonTabla filas={4} columnas={4} />
        </Card>
      ) : cobros.length === 0 ? (
        <Aviso>
          No tenés cobros asignados. Cuando un cliente que vendiste quede con saldo pendiente y esté
          dentro de tu período de acompañamiento, va a aparecer acá solo.
        </Aviso>
      ) : (
        <div className="space-y-2">
          {cobros.map((c) => {
            const wa = enlaceWhatsApp(c)
            const urgente = esUrgente(c)
            const promesaHoy =
              c.promesa_fecha && c.promesa_fecha === new Date().toISOString().slice(0, 10)

            return (
              <div
                key={c.asignacion_id}
                className={`rounded-xl border p-3 ${
                  urgente
                    ? 'border-red-500/30 bg-red-500/5'
                    : 'campo-borde campo-sup'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="campo-txt font-medium">{c.cliente}</span>
                      <Badge color={RESULTADOS_COBRO[c.estado]?.color ?? 'gris'}>
                        {RESULTADOS_COBRO[c.estado]?.label ?? c.estado}
                      </Badge>
                      {promesaHoy && <Badge color="ambar">Prometió para hoy</Badge>}
                    </div>
                    <p className="mt-0.5 text-[12px] text-slate-500">
                      {c.plan ?? 'sin plan'}
                      {c.telefono ? ` · ${c.telefono}` : ' · sin teléfono'}
                      {c.ultimo_pago
                        ? ` · último pago ${new Date(c.ultimo_pago).toLocaleDateString('es-EC')}`
                        : ' · sin pagos registrados'}
                    </p>
                  </div>

                  <div className="text-right">
                    <div className="campo-txt text-lg font-semibold">
                      {dinero(c.saldo_pendiente)}
                    </div>
                    <div
                      className={`text-[12px] ${urgente ? 'font-medium text-red-400' : 'text-slate-500'}`}
                    >
                      {c.dias_atraso ?? 0} días de atraso
                    </div>
                  </div>
                </div>

                {c.ultima_gestion && (
                  <p className="mt-2 text-[11px] text-slate-500">
                    Última gestión: {new Date(c.ultima_gestion).toLocaleString('es-EC')}
                    {c.promesa_fecha
                      ? ` · prometió pagar el ${new Date(`${c.promesa_fecha}T12:00:00`).toLocaleDateString('es-EC')}`
                      : ''}
                  </p>
                )}

                {/* Los tres botones del punto 5, altos y separados: esto se usa
                    en el celular, caminando. */}
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <a
                    href={c.telefono ? `tel:${c.telefono}` : undefined}
                    className={`flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 py-2.5 text-[13px] ${
                      c.telefono
                        ? 'text-slate-200 hover:border-sky-500/50 hover:text-sky-300'
                        : 'pointer-events-none opacity-40'
                    }`}
                  >
                    <Phone size={15} /> Llamar
                  </a>
                  <a
                    href={wa ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className={`flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 py-2.5 text-[13px] ${
                      wa
                        ? 'text-slate-200 hover:border-emerald-500/50 hover:text-emerald-300'
                        : 'pointer-events-none opacity-40'
                    }`}
                  >
                    <MessageCircle size={15} /> WhatsApp
                  </a>
                  <button
                    type="button"
                    onClick={() =>
                      setGestionando({
                        cobro: c,
                        canal: 'llamada',
                        resultado: 'contactado',
                        observacion: '',
                        promesaFecha: '',
                        promesaMonto: '',
                      })
                    }
                    className="flex items-center justify-center gap-1.5 rounded-lg bg-sky-600 py-2.5 text-[13px] font-medium text-white hover:bg-sky-500"
                  >
                    <Check size={15} /> Registrar
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Registrar la gestión */}
      <Modal
        abierto={!!gestionando}
        titulo={`Gestión de cobro — ${gestionando?.cobro?.cliente ?? ''}`}
        onCerrar={() => setGestionando(null)}
      >
        {gestionando && (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Canal">
                <Select
                  value={gestionando.canal}
                  onChange={(e) => setGestionando({ ...gestionando, canal: e.target.value })}
                >
                  {Object.entries(CANALES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Resultado">
                <Select
                  value={gestionando.resultado}
                  onChange={(e) => setGestionando({ ...gestionando, resultado: e.target.value })}
                >
                  {Object.entries(RESULTADOS_COBRO)
                    .filter(([k]) => k !== 'pendiente_contacto')
                    .map(([k, v]) => (
                      <option key={k} value={k}>
                        {v.label}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>

            {gestionando.resultado === 'promesa_pago' && (
              <>
                <Aviso>
                  La fecha es obligatoria: sin ella no se puede recordar ni reclamar. El día que
                  vence te va a aparecer en el tablero.
                </Aviso>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="¿Cuándo va a pagar?">
                    <Input
                      type="date"
                      value={gestionando.promesaFecha}
                      onChange={(e) =>
                        setGestionando({ ...gestionando, promesaFecha: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Cuánto (opcional)">
                    <Input
                      type="number"
                      step="0.01"
                      value={gestionando.promesaMonto}
                      onChange={(e) =>
                        setGestionando({ ...gestionando, promesaMonto: e.target.value })
                      }
                      placeholder={String(gestionando.cobro.saldo_pendiente ?? '')}
                    />
                  </Field>
                </div>
              </>
            )}

            {gestionando.resultado === 'pagado' && (
              <Aviso tipo="alerta">
                Anotar "pagado" no saca al cliente de la bandeja: eso lo decide el pago real cuando
                se registra en caja. Sirve para dejar constancia de lo que te dijo.
              </Aviso>
            )}

            {gestionando.resultado === 'escalar' && (
              <Aviso tipo="alerta">
                Esto cierra tu gestión y pasa el caso al área de cartera. No vas a volver a ver a
                este cliente salvo que un administrador te lo reasigne.
              </Aviso>
            )}

            <Field label="Observación">
              <Textarea
                rows={3}
                value={gestionando.observacion}
                onChange={(e) => setGestionando({ ...gestionando, observacion: e.target.value })}
                placeholder="Qué dijo el cliente"
              />
            </Field>

            <div className="flex justify-end gap-2 border-t border-slate-800 pt-3">
              <Button variante="fantasma" onClick={() => setGestionando(null)}>
                Cancelar
              </Button>
              <Button
                disabled={
                  gestionando.resultado === 'promesa_pago' && !gestionando.promesaFecha
                }
                onClick={async () => {
                  try {
                    await cobranzaApi.registrar({
                      asignacionId: gestionando.cobro.asignacion_id,
                      ...gestionando,
                    })
                    setGestionando(null)
                    await recargar()
                  } catch (err) {
                    setError(err)
                  }
                }}
              >
                Guardar gestión
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
