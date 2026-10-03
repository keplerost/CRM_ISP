import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Download, FileText, LineChart as IconoLinea, TrendingDown, TrendingUp, Users } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { api } from '../lib/apiNetwork'
import { usePermisos } from '../lib/AuthContext'
import { fechaLocal } from '../lib/abonados'
import { abrirPdf, descargar } from '../lib/pdf'
import {
  claveRouter,
  desdeParaRango,
  finDeMes,
  nombreMes,
  resumirPorRouter,
  totalesPorMes,
} from '../lib/crecimientoRouters'
import { Aviso, Button, Card, Cargando, ErrorBanner, Select, Stat, Table } from '../components/ui'

/**
 * Crecimiento por router, mes a mes.
 *
 * Responde lo que la gerencia pregunta para planificar: qué sector crece, cuál
 * se achica y dónde se acumulan los morosos. Altas y bajas se reconstruyen de
 * las fichas; cortados, pausados y deuda salen de la foto mensual, que existe
 * desde que se instaló este reporte — antes de eso esas columnas van vacías,
 * no en cero.
 *
 * Colores: la paleta categórica validada (orden fijo, nunca ciclada). Cada
 * router conserva su color aunque cambie el filtro, porque el color se asigna
 * por el orden de la lista completa, no por lo que queda a la vista. Más de
 * siete routers se pliegan en "Otros".
 */

const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7']
const OTROS = '#94a3b8'
const ALTAS = '#2a78d6'
const BAJAS = '#eb6834'
const CARGA = '#94a3b8'
const EJE = '#64748b'
const GRILLA = 'rgba(15,23,42,0.08)'

const RANGOS = [3, 6, 12, 24]

const numero = (n) => (n == null ? '—' : Number(n).toLocaleString('es-EC'))
const dinero = (n) =>
  n == null
    ? '—'
    : `$${Number(n).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const porcentaje = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`)

function TooltipLista({ active, payload, label, formato = numero }) {
  if (!active || !payload?.length) return null
  return (
    <div className="t-card-sm px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 font-medium text-slate-200">{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2 text-slate-300">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.color ?? p.fill }} />
          {p.name}: <b className="text-slate-100">{formato(Math.abs(p.value))}</b>
        </p>
      ))}
    </div>
  )
}

export default function CrecimientoRoutersPage() {
  const { puede } = usePermisos()
  const [params] = useSearchParams()
  const [hasta, setHasta] = useState(() => fechaLocal().slice(0, 7))
  const [meses, setMeses] = useState(12)
  const [soloRouter, setSoloRouter] = useState(() => params.get('router') ?? '')
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const desde = desdeParaRango(hasta, meses)
  const fin = finDeMes(hasta)

  const cargar = useCallback(async () => {
    setCargando(true)
    setError(null)
    const { data, error: err } = await supabase.rpc('reporte_crecimiento_routers', {
      p_desde: desde,
      p_hasta: fin,
    })
    if (err) {
      setError(
        /does not exist|could not find/i.test(err.message)
          ? new Error('Falta la función del reporte. Corré supabase/migracion-203-el-crecimiento-por-router.sql')
          : err,
      )
      setFilas([])
    } else {
      setFilas(data ?? [])
    }
    setCargando(false)
  }, [desde, fin])

  useEffect(() => {
    cargar()
  }, [cargar])

  /* El color se fija sobre la lista COMPLETA ordenada por tamaño: filtrar no
     repinta a los que quedan. */
  const resumenTodos = useMemo(() => resumirPorRouter(filas), [filas])
  const colorDe = useMemo(() => {
    const m = new Map()
    resumenTodos.forEach((r, i) => m.set(r.clave, i < SERIES.length ? SERIES[i] : OTROS))
    return m
  }, [resumenTodos])

  const visibles = useMemo(
    () => (soloRouter ? filas.filter((f) => claveRouter(f) === soloRouter) : filas),
    [filas, soloRouter],
  )
  const resumen = useMemo(() => resumirPorRouter(visibles), [visibles])
  const porMes = useMemo(() => totalesPorMes(visibles), [visibles])

  /* Una columna por router (los siete más grandes) y "Otros" con el resto. */
  const lineas = useMemo(() => {
    const grandes = resumenTodos.slice(0, SERIES.length).map((r) => r.clave)
    const series = soloRouter
      ? resumenTodos.filter((r) => r.clave === soloRouter)
      : resumenTodos.slice(0, SERIES.length)
    const hayOtros = !soloRouter && resumenTodos.length > SERIES.length

    const datos = totalesPorMes(filas).map(({ mes }) => {
      const punto = { mes: nombreMes(mes) }
      for (const f of filas.filter((x) => x.mes === mes)) {
        const k = claveRouter(f)
        if (series.some((s) => s.clave === k)) punto[k] = Number(f.total)
        else if (hayOtros && !grandes.includes(k)) punto.otros = (punto.otros ?? 0) + Number(f.total)
      }
      return punto
    })
    return {
      datos,
      series: [
        ...series.map((s) => ({ clave: s.clave, nombre: s.router, color: colorDe.get(s.clave) })),
        ...(hayOtros ? [{ clave: 'otros', nombre: 'Otros', color: OTROS }] : []),
      ],
    }
  }, [filas, resumenTodos, soloRouter, colorDe])

  const movimiento = porMes.map((m) => ({
    mes: nombreMes(m.mes),
    Altas: m.altas,
    'Carga inicial': m.carga_inicial,
    Bajas: -m.bajas,
  }))
  const hayCarga = porMes.some((m) => m.carga_inicial > 0)

  const total = resumen.reduce(
    (t, r) => ({
      inicio: t.inicio + r.inicio,
      fin: t.fin + r.fin,
      altas: t.altas + r.altas,
      bajas: t.bajas + r.bajas,
    }),
    { inicio: 0, fin: 0, altas: 0, bajas: 0 },
  )
  const variacion = total.inicio ? (total.fin - total.inicio) / total.inicio : null
  const primeraFoto = porMes.find((m) => m.con_foto)?.mes

  const puedeExportar = puede('reportes.exportar') || puede('finanzas.exportar')

  function bajar(formato) {
    const p = new URLSearchParams({ desde, hasta: fin, formato })
    if (soloRouter) p.set('router', soloRouter)
    const traer = () => api.reportes.crecimientoRouters(p.toString())
    const nombre = `crecimiento-routers-${desde.slice(0, 7)}_${hasta}.${formato === 'pdf' ? 'pdf' : 'xlsx'}`
    const accion = formato === 'pdf' ? abrirPdf(traer, nombre) : descargar(traer, nombre)
    Promise.resolve(accion).catch(setError)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Crecimiento por router</h1>
          <p className="text-sm text-slate-500">
            Altas, bajas y morosos de cada MikroTik, mes a mes
          </p>
        </div>
        {puedeExportar && (
          <div className="flex flex-wrap gap-2">
            <Button variante="secundario" icon={FileText} onClick={() => bajar('pdf')}>
              Ver en PDF
            </Button>
            <Button variante="primario" icon={Download} onClick={() => bajar('excel')}>
              Descargar Excel
            </Button>
          </div>
        )}
      </div>

      {/* Los filtros en una sola fila, arriba de todo lo que filtran. */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[11px] uppercase tracking-wide text-slate-500">
          Hasta
          <input
            type="month"
            value={hasta}
            max={fechaLocal().slice(0, 7)}
            onChange={(e) => e.target.value && setHasta(e.target.value)}
            className="mt-1 block rounded-xl border border-slate-700 bg-transparent px-3 py-1.5 text-xs text-slate-200"
          />
        </label>
        <div className="flex gap-1" role="group" aria-label="Cuántos meses">
          {RANGOS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setMeses(r)}
              aria-pressed={meses === r}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                meses === r
                  ? 'bg-[#F0F9FF] text-sky-400'
                  : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
              }`}
            >
              {r} meses
            </button>
          ))}
        </div>
        <div className="w-56">
          <Select value={soloRouter} onChange={(e) => setSoloRouter(e.target.value)} className="py-1.5 text-xs">
            <option value="">Todos los routers</option>
            {resumenTodos.map((r) => (
              <option key={r.clave} value={r.clave}>
                {r.router}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {cargando ? (
        <Cargando texto="Armando el reporte…" />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Abonados al cierre" valor={numero(total.fin)} icon={Users} sub={`${numero(total.inicio)} al inicio`} />
            <Stat
              label="Variación del período"
              valor={porcentaje(variacion)}
              icon={variacion != null && variacion < 0 ? TrendingDown : TrendingUp}
              color={variacion != null && variacion < 0 ? 'text-red-400' : 'text-emerald-400'}
            />
            <Stat label="Altas" valor={numero(total.altas)} icon={TrendingUp} />
            <Stat label="Bajas" valor={numero(total.bajas)} icon={TrendingDown} color="text-red-400" />
          </div>

          {!primeraFoto && (
            <Aviso>
              Todavía no hay fotos mensuales en este período: cortados, pausados y deuda empiezan a
              registrarse desde el mes en que se instaló el reporte. Altas y bajas sí están completas.
            </Aviso>
          )}

          <Card title="Abonados por router" icon={IconoLinea}>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={lineas.datos} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={GRILLA} vertical={false} />
                  <XAxis dataKey="mes" tick={{ fill: EJE, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRILLA }} />
                  <YAxis tick={{ fill: EJE, fontSize: 11 }} tickLine={false} axisLine={false} width={48} allowDecimals={false} />
                  <Tooltip content={<TooltipLista />} cursor={{ stroke: EJE, strokeDasharray: '3 3' }} />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" />
                  {lineas.series.map((s) => (
                    <Line
                      key={s.clave}
                      dataKey={s.clave}
                      name={s.nombre}
                      stroke={s.color}
                      strokeWidth={2}
                      dot={{ r: 3, strokeWidth: 0, fill: s.color }}
                      activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2 }}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Total de abonados (sin contar retirados) al cierre de cada mes.
            </p>
          </Card>

          <Card title="Altas y bajas por mes" icon={TrendingUp}>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={movimiento} stackOffset="sign" margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={GRILLA} vertical={false} />
                  <XAxis dataKey="mes" tick={{ fill: EJE, fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis
                    tick={{ fill: EJE, fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={48}
                    allowDecimals={false}
                    tickFormatter={(v) => Math.abs(v)}
                  />
                  <ReferenceLine y={0} stroke={EJE} />
                  <Tooltip content={<TooltipLista />} cursor={{ fill: 'rgba(15,23,42,0.04)' }} />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" />
                  <Bar dataKey="Altas" stackId="m" fill={ALTAS} maxBarSize={28} stroke="#fff" strokeWidth={1} />
                  {hayCarga && (
                    <Bar dataKey="Carga inicial" stackId="m" fill={CARGA} maxBarSize={28} stroke="#fff" strokeWidth={1} />
                  )}
                  <Bar dataKey="Bajas" stackId="m" fill={BAJAS} maxBarSize={28} stroke="#fff" strokeWidth={1} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Altas hacia arriba, bajas hacia abajo.
              {hayCarga && ' "Carga inicial" son importados sin fecha de instalación: no son ventas de ese mes.'}
            </p>
          </Card>

          <Card title="Resumen del período por router" icon={Users}>
            <Table
              columnas={['Router', 'Al inicio', 'Altas', 'Bajas', 'Al cierre', 'Variación', 'Cortados', 'Pausados', 'Deuda vencida']}
              filas={resumen}
              vacio="No hay routers ni abonados en el período."
              renderFila={(r) => (
                <tr key={r.clave} className="text-slate-300">
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2 font-medium text-slate-100">
                      <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: colorDe.get(r.clave) }} />
                      {r.router_id ? (
                        <Link to={`/clientes?router=${r.router_id}`} className="hover:text-sky-400">
                          {r.router}
                        </Link>
                      ) : (
                        r.router
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">{numero(r.inicio)}</td>
                  <td className="px-3 py-2 text-right">
                    {numero(r.altas)}
                    {r.carga_inicial > 0 && (
                      <span className="block text-[10px] text-slate-500">+{numero(r.carga_inicial)} importados</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">{numero(r.bajas)}</td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-100">{numero(r.fin)}</td>
                  <td className={`px-3 py-2 text-right ${r.variacion < 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                    {porcentaje(r.variacion)}
                  </td>
                  <td className="px-3 py-2 text-right">{numero(r.foto?.cortados)}</td>
                  <td className="px-3 py-2 text-right">{numero(r.foto?.suspendidos)}</td>
                  <td className="px-3 py-2 text-right">{dinero(r.foto?.vencido)}</td>
                </tr>
              )}
            />
            <p className="mt-2 text-[11px] text-slate-500">
              Cortados, pausados y deuda son de la última foto mensual del período
              {primeraFoto ? '' : ' (todavía no hay ninguna)'}.
            </p>
          </Card>

          <Card title="Mes a mes" icon={FileText}>
            <Table
              columnas={['Mes', 'Altas', 'Bajas', 'Neto', 'Total', 'Cortados', 'Pausados', 'Por cobrar', 'Vencido']}
              filas={[...porMes].reverse()}
              renderFila={(m) => (
                <tr key={m.mes} className="text-slate-300">
                  <td className="px-3 py-2 font-medium text-slate-100">{nombreMes(m.mes)}</td>
                  <td className="px-3 py-2 text-right">
                    {numero(m.altas)}
                    {m.carga_inicial > 0 && (
                      <span className="block text-[10px] text-slate-500">+{numero(m.carga_inicial)} importados</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">{numero(m.bajas)}</td>
                  <td className={`px-3 py-2 text-right font-semibold ${m.neto < 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                    {m.neto > 0 ? '+' : ''}
                    {numero(m.neto)}
                  </td>
                  <td className="px-3 py-2 text-right">{numero(m.total)}</td>
                  <td className="px-3 py-2 text-right">{numero(m.cortados)}</td>
                  <td className="px-3 py-2 text-right">{numero(m.suspendidos)}</td>
                  <td className="px-3 py-2 text-right">{dinero(m.por_cobrar)}</td>
                  <td className="px-3 py-2 text-right">{dinero(m.vencido)}</td>
                </tr>
              )}
            />
          </Card>
        </>
      )}
    </div>
  )
}
