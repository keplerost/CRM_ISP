import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  Award,
  CheckCircle2,
  Flame,
  MessageCircle,
  Phone,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from 'lucide-react'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Select,
  Table,
} from '../../components/ui'
import BotonTema from '../../components/ventas/BotonTema'
import { usePermisos } from '../../lib/AuthContext'
import { useTemaCampo } from '../../lib/temaCampo'
import { dineroCero as dinero } from '../../lib/formato'
import { enlaceWhatsApp } from '../../lib/telefono'
import {
  ESTADOS_COMISION,
  ESTADOS_PERIODO,
  comisionesApi,
  proyeccion,
} from '../../lib/comisiones'
import { SITUACIONES, carteraApi } from '../../lib/cartera'

/**
 * Mi comisión.
 *
 * ── Qué contesta esta pantalla, en este orden ──
 *
 *   cuánto llevo · qué me falta para el escalón siguiente · qué ventas me
 *   cuentan y cuáles no y por qué · cómo va la calidad de mi cartera · a quién
 *   tengo que llamar hoy · qué se me liquidó.
 *
 * ── Por qué el progreso propio y no un ranking ──
 *
 * El punto 22 lo pide explícito: el tablero del vendedor no se basa en compararlo
 * con los compañeros. Comparar es una herramienta de gestión y vive en la
 * pantalla del Super Admin. Acá el único referente es el escalón siguiente.
 *
 * ── Sobre los números ──
 *
 * Ninguno se calcula acá para mostrarlo lindo. Las ventas válidas, el nivel y el
 * monto salen del motor —la misma función que después congela la liquidación—.
 * Lo único que se estima en el navegador es "si conseguís N ventas más", y esa
 * tarjeta dice que es una estimación.
 */

const hoyPeriodo = () => `${new Date().toISOString().slice(0, 7)}-01`

const mesLargo = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('es-EC', { month: 'long', year: 'numeric' })

export default function MiComisionPage() {
  const { perfil } = usePermisos()
  const { tema, alternar } = useTemaCampo()

  const [periodo, setPeriodo] = useState(hoyPeriodo)
  const [datos, setDatos] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [abriendo, setAbriendo] = useState(null)

  const yo = perfil?.id

  const recargar = useCallback(async () => {
    if (!yo) return
    setCargando(true)
    try {
      const [esquema, resumen, embudo, ventas, cohortes, cartera, liquidaciones] = await Promise.all([
        comisionesApi.esquema(),
        comisionesApi.resumen({ vendedor: yo }),
        comisionesApi.embudo({ vendedor: yo }),
        comisionesApi.ventas({ vendedor: yo, periodo }),
        comisionesApi.cohortes({ vendedor: yo }),
        carteraApi.enRiesgo({ vendedor: yo }),
        comisionesApi.liquidaciones({ vendedor: yo }),
      ])
      setDatos({ esquema, resumen, embudo, ventas, cohortes, cartera, liquidaciones })
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [yo, periodo])

  useEffect(() => {
    recargar()
  }, [recargar])

  /** Abre la gestión de recuperación de un cliente y lo manda a la bandeja. */
  async function gestionar(clienteId) {
    setAbriendo(clienteId)
    try {
      await carteraApi.abrirGestion(clienteId)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setAbriendo(null)
    }
  }

  const delMes = useMemo(
    () => datos?.resumen?.find((r) => r.periodo === periodo) ?? null,
    [datos, periodo],
  )
  const embudo = useMemo(
    () => datos?.embudo?.find((e) => e.periodo === periodo) ?? null,
    [datos, periodo],
  )

  // Los períodos que se pueden mirar: los que tienen algo, más el actual.
  const periodos = useMemo(() => {
    const set = new Set([hoyPeriodo(), ...(datos?.embudo ?? []).map((e) => e.periodo)])
    return [...set].sort().reverse()
  }, [datos])

  const proy = useMemo(() => {
    if (!datos?.esquema) return null
    return proyeccion(datos.esquema, {
      ventas: Number(delMes?.ventas_validas ?? 0),
      baseTotal: Number(delMes?.base_total ?? 0),
    })
  }, [datos, delMes])

  // La cohorte que se le está midiendo: la abierta más reciente, y si no hay
  // ninguna abierta, la última cerrada.
  const cohorte = useMemo(() => {
    const cs = datos?.cohortes ?? []
    return cs.find((c) => c.estado === 'abierta') ?? cs[0] ?? null
  }, [datos])

  const sinRenovar = useMemo(
    () => (datos?.cartera ?? []).filter((c) => c.situacion !== 'baja'),
    [datos],
  )

  if (cargando && !datos) return <Cargando texto="Buscando tus ventas…" />

  return (
    <div className="campo campo-fondo -m-6 space-y-5 p-6" data-tema={tema}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="t-titulo text-lg font-bold text-slate-100">Mi comisión</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Lo que llevás ganado este mes, y qué te falta para el escalón siguiente.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={periodo}
            onChange={(e) => setPeriodo(e.target.value)}
            className="w-44"
          >
            {periodos.map((p) => (
              <option key={p} value={p}>
                {mesLargo(p)}
              </option>
            ))}
          </Select>
          <BotonTema tema={tema} onAlternar={alternar} />
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {!datos?.esquema && (
        <Aviso tipo="alerta">
          Todavía no hay un esquema de comisiones vigente. Hasta que administración cargue las bases
          y los escalones, esta pantalla no puede calcular nada.
        </Aviso>
      )}

      {/* ------------------------------------------------- Mi comisión */}
      <Hero delMes={delMes} proy={proy} />

      {/* ------------------------------------------------- El embudo */}
      {embudo && <Embudo embudo={embudo} />}

      {/* ------------------------------------------------- Mis ventas */}
      <Card title="Mis ventas del período" icon={Wallet}>
        <Table
          columnas={['Abonado', 'Plan', 'Base', 'Estado', 'Qué le falta']}
          filas={datos?.ventas ?? []}
          vacio="Ninguna venta registrada en este período."
          renderFila={(v) => {
            const e = ESTADOS_COMISION[v.estado] ?? { label: v.estado, color: 'gris' }
            return (
              <tr key={v.id}>
                <td className="px-3 py-2 text-slate-200">{v.cliente ?? v.prospecto ?? '—'}</td>
                <td className="px-3 py-2 text-slate-400">{v.plan ?? '—'}</td>
                <td className="px-3 py-2 text-slate-300">{dinero(v.base)}</td>
                <td className="px-3 py-2">
                  <Badge color={e.color}>{e.label}</Badge>
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {v.le_falta ? (
                    <span className="text-amber-400">{v.le_falta}</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-emerald-400">
                      <CheckCircle2 size={13} /> Cuenta para tu comisión
                    </span>
                  )}
                </td>
              </tr>
            )
          }}
        />
      </Card>

      {/* ------------------------------------------------- Calidad */}
      <Calidad cohorte={cohorte} />

      {/* ------------------------------------------------- Cartera */}
      <Card
        title="Clientes que requieren atención"
        icon={AlertTriangle}
        actions={
          <Link to="/ventas/cobranza">
            <Button variante="fantasma">Ir a mis gestiones</Button>
          </Link>
        }
      >
        {sinRenovar.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-slate-500">
            Ninguno de tus clientes está atrasado. Así se mantiene el bono.
          </p>
        ) : (
          <>
            <p className="mb-3 text-sm text-slate-300">
              <strong className="text-amber-400">{sinRenovar.length}</strong>{' '}
              {sinRenovar.length === 1 ? 'cliente tuyo no renovó' : 'clientes tuyos no renovaron'}.
              Cada uno que recuperes cuenta para la calidad de tu cohorte.
            </p>
            <Table
              columnas={['Abonado', 'Situación', 'Sin pagar', 'Contacto', '']}
              filas={sinRenovar}
              vacio=""
              renderFila={(c) => {
                const s = SITUACIONES[c.situacion] ?? { label: c.situacion, tono: 'gris' }
                return (
                  <tr key={c.venta_id}>
                    <td className="px-3 py-2 text-slate-200">{c.cliente}</td>
                    <td className="px-3 py-2">
                      <Badge color={s.tono}>{s.label}</Badge>
                    </td>
                    <td className="px-3 py-2 text-slate-300">{c.meses_sin_pago} meses</td>
                    <td className="px-3 py-2">
                      {c.telefono ? (
                        <div className="flex gap-2">
                          <a
                            href={`tel:${c.telefono}`}
                            className="inline-flex items-center gap-1 text-xs text-sky-300"
                          >
                            <Phone size={13} /> {c.telefono}
                          </a>
                          <a
                            href={enlaceWhatsApp(c.telefono)}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-emerald-300"
                          >
                            <MessageCircle size={13} />
                          </a>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500">sin teléfono</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {c.asignacion_id ? (
                        <span className="text-[11px] text-slate-500">
                          {c.ultimo_resultado ? `último: ${c.ultimo_resultado}` : 'en gestión'}
                        </span>
                      ) : (
                        <Button
                          variante="fantasma"
                          cargando={abriendo === c.cliente_id}
                          onClick={() => gestionar(c.cliente_id)}
                        >
                          Gestionar
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              }}
            />
          </>
        )}
      </Card>

      {/* ------------------------------------------------- Liquidaciones */}
      <Card title="Mis liquidaciones" icon={ShieldCheck}>
        <Table
          columnas={['Período', 'Ventas', 'Nivel', 'Comisión', 'Bono', 'Total', 'Estado']}
          filas={datos?.liquidaciones ?? []}
          vacio="Todavía no se cerró ningún período tuyo."
          renderFila={(l) => {
            const e = ESTADOS_PERIODO[l.estado] ?? { label: l.estado, color: 'gris' }
            return (
              <tr key={l.id}>
                <td className="px-3 py-2 text-slate-200">{mesLargo(l.periodo)}</td>
                <td className="px-3 py-2 text-slate-300">{l.ventas_validas}</td>
                <td className="px-3 py-2 text-slate-400">
                  {l.nivel ?? '—'}
                  {l.porcentaje ? ` · ${l.porcentaje} %` : ''}
                </td>
                <td className="px-3 py-2 text-slate-300">{dinero(l.monto)}</td>
                <td className="px-3 py-2 text-slate-300">{dinero(l.bono)}</td>
                <td className="px-3 py-2 font-semibold text-slate-100">{dinero(l.total_a_pagar)}</td>
                <td className="px-3 py-2">
                  <Badge color={e.color}>{e.label}</Badge>
                </td>
              </tr>
            )
          }}
        />
        <p className="mt-3 text-[11px] leading-snug text-slate-500">
          Una liquidación cerrada guarda las reglas con las que se calculó. Cambiar la configuración
          hoy no toca lo que ya se cerró.
        </p>
      </Card>
    </div>
  )
}

/**
 * La tarjeta grande: cuánto llevo y qué me falta.
 *
 * La barra de progreso mide contra el escalón siguiente y no contra una meta
 * mensual, porque el escalón es lo que cambia la plata: llegar a 26 no suma una
 * venta, sube el porcentaje de las 26.
 */
function Hero({ delMes, proy }) {
  const ventas = Number(delMes?.ventas_validas ?? 0)
  const pendientes = Number(delMes?.pendientes ?? 0)
  const monto = Number(proy?.actual?.monto ?? delMes?.monto ?? 0)
  const nivel = proy?.actual?.nivel?.nombre ?? delMes?.nivel
  const pct = Number(proy?.actual?.porcentaje ?? delMes?.porcentaje ?? 0)
  const sig = proy?.siguiente

  // El tramo recorrido dentro del escalón actual: de dónde arrancó este nivel
  // hasta dónde arranca el que viene.
  const desde = Number(proy?.actual?.nivel?.desde_ventas ?? 0)
  const hasta = sig ? sig.objetivo : ventas
  const avance = hasta > desde ? Math.min(100, ((ventas - desde) / (hasta - desde)) * 100) : 100

  return (
    <Card>
      <div className="grid gap-5 md:grid-cols-[1.2fr_1fr]">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Este período</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-3">
            <span className="text-4xl font-semibold text-slate-100">{ventas}</span>
            <span className="text-sm text-slate-400">
              {ventas === 1 ? 'venta válida' : 'ventas válidas'}
            </span>
            {nivel && (
              <Badge color="verde">
                <Award size={12} className="mr-1" />
                {nivel} · {pct} %
              </Badge>
            )}
          </div>

          {pendientes > 0 && (
            <p className="mt-2 text-xs text-amber-400">
              {pendientes} {pendientes === 1 ? 'venta espera' : 'ventas esperan'} el primer pago
              dentro del período de cortesía. Cuando entre, cuentan.
            </p>
          )}

          {sig ? (
            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="inline-flex items-center gap-1.5 font-medium text-amber-300">
                  <Flame size={14} />
                  Te {sig.faltan === 1 ? 'falta' : 'faltan'} {sig.faltan}{' '}
                  {sig.faltan === 1 ? 'venta' : 'ventas'} para {sig.nivel.nombre} —{' '}
                  {sig.nivel.porcentaje} %
                </span>
                <span className="text-slate-400">
                  {ventas} / {sig.objetivo}
                </span>
              </div>
              <div
                className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800"
                role="progressbar"
                aria-valuenow={ventas}
                aria-valuemin={desde}
                aria-valuemax={sig.objetivo}
              >
                <div
                  className="h-full rounded-full bg-gradient-to-r from-sky-500 to-emerald-400 transition-all"
                  style={{ width: `${avance}%` }}
                />
              </div>
            </div>
          ) : (
            ventas > 0 && (
              <p className="mt-4 inline-flex items-center gap-1.5 text-xs text-emerald-400">
                <Award size={14} /> Estás en el escalón más alto del esquema.
              </p>
            )
          )}
        </div>

        <div className="t-card p-4">
          <p className="text-xs text-slate-400">Comisión proyectada</p>
          <p className="mt-1 text-3xl font-semibold text-emerald-300">{dinero(monto)}</p>

          {sig && (
            <div className="mt-3 border-t border-slate-800 pt-3">
              <p className="text-xs text-slate-400">
                Si conseguís {sig.faltan} {sig.faltan === 1 ? 'venta más' : 'ventas más'}:
              </p>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-xl font-semibold text-slate-100">{dinero(sig.monto)}</span>
                <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-400">
                  <TrendingUp size={14} />+{dinero(sig.incremento)}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
                Estimado con el promedio de lo que vendiste este mes ({dinero(sig.promedio)} por
                venta). El monto final depende de los planes que cierres.
              </p>
            </div>
          )}

          <p className="mt-3 text-[11px] leading-snug text-slate-500">
            Proyectada: el período todavía está abierto. Se congela al cerrarlo.
          </p>
        </div>
      </div>
    </Card>
  )
}

/**
 * El embudo del punto 6.
 *
 * Existe para que "30 solicitudes" y "12 ventas" convivan en la misma línea sin
 * que ninguna de las dos parezca un error.
 */
function Embudo({ embudo }) {
  const pasos = [
    ['Solicitudes', embudo.solicitudes],
    ['Cerradas', embudo.ganadas],
    ['Instaladas', embudo.instaladas],
    ['Activadas', embudo.activadas],
    ['Con primer pago', embudo.con_primer_pago],
    ['Comisionables', embudo.comisionables],
  ]

  return (
    <Card title="De solicitud a comisión" subtitle="Ingresar una solicitud no es vender">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {pasos.map(([label, valor], i) => (
          <div
            key={label}
            className={`rounded-lg border p-3 ${
              i === pasos.length - 1
                ? 'border-emerald-600/40 bg-emerald-500/5'
                : 'border-slate-800 bg-slate-900/40'
            }`}
          >
            <p className="text-[11px] leading-tight text-slate-500">{label}</p>
            <p
              className={`mt-1 text-xl font-semibold ${
                i === pasos.length - 1 ? 'text-emerald-300' : 'text-slate-200'
              }`}
            >
              {valor ?? 0}
            </p>
          </div>
        ))}
      </div>
      {embudo.en_cortesia > 0 && (
        <p className="mt-3 text-xs text-amber-400">
          {embudo.en_cortesia} en período de cortesía: instaladas y activas, esperando el primer
          pago.
        </p>
      )}
    </Card>
  )
}

/**
 * La calidad de la cartera y el bono.
 *
 * ── Por qué se muestra aunque falte para cerrar ──
 *
 * Porque es el único momento en que se puede hacer algo. Un bono que aparece
 * recién al cerrarse la cohorte informa de un resultado; mostrarlo mientras
 * corre convierte "perdiste dos clientes" en "te faltan dos llamadas".
 */
function Calidad({ cohorte }) {
  if (!cohorte) {
    return (
      <Card title="Calidad de mis ventas" icon={ShieldCheck}>
        <p className="px-3 py-6 text-center text-sm text-slate-500">
          Todavía no hay ninguna cohorte con ventas para medir.
        </p>
      </Card>
    )
  }

  const abierta = cohorte.estado === 'abierta'
  const calidad = Number(cohorte.calidad ?? 0)

  return (
    <Card
      title="Calidad de mis ventas"
      subtitle={`Cohorte de ${mesLargo(cohorte.cohorte)}`}
      icon={ShieldCheck}
      actions={
        <Badge color={abierta ? 'azul' : 'gris'}>
          {abierta ? `${cohorte.dias_restantes} días para cerrar` : 'Cerrada'}
        </Badge>
      }
    >
      <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
        <div>
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-3xl font-semibold text-slate-100">{calidad} %</span>
            <span className="text-sm text-slate-400">
              {cohorte.conservados} de {cohorte.evaluables} conservados
            </span>
          </div>

          <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-amber-500 to-emerald-400"
              style={{ width: `${Math.min(100, calidad)}%` }}
            />
          </div>

          {cohorte.excluidos > 0 && (
            <p className="mt-2 text-[11px] text-slate-500">
              {cohorte.excluidos} no se cuentan: se fueron por motivos que no dependen de vos.
            </p>
          )}
          {cohorte.detalle && (
            <p className="mt-2 text-[11px] leading-snug text-slate-500">{cohorte.detalle}</p>
          )}
        </div>

        <div className="t-card p-4">
          <p className="text-xs text-slate-400">
            {abierta ? 'Bono proyectado' : 'Bono de esta cohorte'}
          </p>
          <p className="mt-1 text-3xl font-semibold text-emerald-300">{dinero(cohorte.bono)}</p>

          {abierta && cohorte.faltan_clientes > 0 && (
            <p className="mt-3 text-xs leading-snug text-amber-400">
              Te {cohorte.faltan_clientes === 1 ? 'falta' : 'faltan'} {cohorte.faltan_clientes}{' '}
              {cohorte.faltan_clientes === 1 ? 'cliente evaluable' : 'clientes evaluables'} para que
              esta cohorte pueda cobrar bono.
            </p>
          )}

          {abierta && cohorte.siguiente_bono != null && (
            <p className="mt-3 inline-flex items-start gap-1.5 text-xs leading-snug text-amber-300">
              <Flame size={14} className="mt-0.5 shrink-0" />
              Mantené {cohorte.siguiente_calidad} % o más para llegar a{' '}
              {dinero(cohorte.siguiente_bono)}
              {cohorte.faltan_para_siguiente > 0
                ? ` — te ${cohorte.faltan_para_siguiente === 1 ? 'falta' : 'faltan'} ${
                    cohorte.faltan_para_siguiente
                  } por recuperar.`
                : '.'}
            </p>
          )}

          {!abierta && (
            <p className="mt-3 text-[11px] leading-snug text-slate-500">
              Cerrada: una reactivación posterior no la modifica.
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}
