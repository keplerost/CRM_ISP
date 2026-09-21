import { useEffect, useMemo, useState } from 'react'
import { dineroCero as dinero } from '../lib/formato'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { AlertTriangle, BarChart3, TrendingUp, Users, Wallet } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { Aviso, Card, Cargando, ErrorBanner, Select, Stat } from '../components/ui'

/**
 * Estadísticas financieras.
 *
 * Responde tres preguntas que hoy había que sacar a mano: cuánto se facturó y
 * cuánto entró de verdad mes a mes, por qué medio cobra la gente, y cuánta
 * plata está en la calle.
 *
 * Sobre los colores: los dos únicos que conviven en un mismo gráfico —facturado
 * y cobrado— están validados contra el fondo oscuro de la app y se distinguen
 * también para quien no ve bien los colores. Los gráficos de una sola medida
 * usan un solo tono: ahí el color no codifica nada y varias tonalidades solo
 * agregarían ruido.
 */

const SERIE_FACTURADO = '#3987e5'
const SERIE_COBRADO = '#d95926'
const EJE = '#64748b'
const GRILLA = '#1e293b'

const compacto = (n) => `$${Math.round(Number(n) || 0)}`

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

/** Clave YYYY-MM de una fecha, en hora local. */
const claveMes = (f) => String(f ?? '').slice(0, 7)

/** Los últimos N meses, del más viejo al más nuevo. */
function ultimosMeses(n) {
  const hoy = new Date()
  const meses = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1)
    meses.push({
      clave: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      etiqueta: `${MESES[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`,
    })
  }
  return meses
}

/** Tooltip propio: el de recharts trae fondo claro y no se lee sobre el oscuro. */
function TooltipOscuro({ active, payload, label }) {
  if (!active || !payload?.length) return null

  return (
    <div className="t-card-sm px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 font-medium text-slate-200">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 text-slate-300">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: p.color ?? p.fill }}
          />
          {p.name}: <b className="text-slate-100">{dinero(p.value)}</b>
        </p>
      ))}
    </div>
  )
}

export default function EstadisticasPage() {
  const [meses, setMeses] = useState(12)
  const [pagos, setPagos] = useState([])
  const [facturas, setFacturas] = useState([])
  const [saldos, setSaldos] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let vigente = true

    Promise.all([
      supabase.from('v_pagos').select('fecha_pago, monto, forma_pago, cuenta, anulado'),
      supabase.from('v_facturas').select('fecha_emision, total, saldo, estado, anulada'),
      supabase.from('v_saldo_clientes').select('client_id, nombre, saldo, estado'),
    ])
      .then(([p, f, s]) => {
        if (!vigente) return
        if (p.error) setError(p.error)

        setPagos((p.data ?? []).filter((x) => !x.anulado))
        setFacturas((f.data ?? []).filter((x) => !x.anulada))
        setSaldos(s.data ?? [])
        setCargando(false)
      })
      .catch((err) => vigente && setError(err))

    return () => {
      vigente = false
    }
  }, [])

  // --- Series -------------------------------------------------------------

  const porMes = useMemo(() => {
    const base = ultimosMeses(meses)
    const cobrado = {}
    const facturado = {}

    for (const p of pagos) cobrado[claveMes(p.fecha_pago)] = (cobrado[claveMes(p.fecha_pago)] ?? 0) + Number(p.monto)
    for (const f of facturas)
      facturado[claveMes(f.fecha_emision)] = (facturado[claveMes(f.fecha_emision)] ?? 0) + Number(f.total)

    return base.map((m) => ({
      mes: m.etiqueta,
      Facturado: Math.round((facturado[m.clave] ?? 0) * 100) / 100,
      Cobrado: Math.round((cobrado[m.clave] ?? 0) * 100) / 100,
    }))
  }, [pagos, facturas, meses])

  const porForma = useMemo(() => {
    const acc = {}
    for (const p of pagos) acc[p.forma_pago] = (acc[p.forma_pago] ?? 0) + Number(p.monto)
    return Object.entries(acc)
      .map(([forma, monto]) => ({ forma, monto: Math.round(monto * 100) / 100 }))
      .sort((a, b) => b.monto - a.monto)
  }, [pagos])

  const porCuenta = useMemo(() => {
    const acc = {}
    for (const p of pagos) {
      const clave = p.cuenta ?? 'Sin cuenta'
      acc[clave] = (acc[clave] ?? 0) + Number(p.monto)
    }
    return Object.entries(acc)
      .map(([cuenta, monto]) => ({ cuenta, monto: Math.round(monto * 100) / 100 }))
      .sort((a, b) => b.monto - a.monto)
  }, [pagos])

  // --- Números del encabezado ----------------------------------------------

  const mesActual = claveMes(new Date().toISOString())
  const cobradoMes = pagos
    .filter((p) => claveMes(p.fecha_pago) === mesActual)
    .reduce((s, p) => s + Number(p.monto), 0)
  const facturadoMes = facturas
    .filter((f) => claveMes(f.fecha_emision) === mesActual)
    .reduce((s, f) => s + Number(f.total), 0)

  const deuda = saldos.reduce((s, c) => s + Math.max(0, Number(c.saldo ?? 0)), 0)
  const morosos = saldos.filter((c) => Number(c.saldo ?? 0) > 0.005).length

  if (cargando) return <Cargando texto="Calculando…" />

  const sinDatos = pagos.length === 0 && facturas.length === 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Estadísticas</h1>
          <p className="text-sm text-slate-500">Qué se facturó, qué entró y por dónde.</p>
        </div>
        <Select value={meses} onChange={(e) => setMeses(Number(e.target.value))} className="w-40">
          <option value={6}>Últimos 6 meses</option>
          <option value={12}>Últimos 12 meses</option>
          <option value={24}>Últimos 24 meses</option>
        </Select>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {sinDatos ? (
        <Aviso>
          Todavía no hay cobros ni facturas para graficar. Volvé cuando hayas registrado el primer
          mes.
        </Aviso>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <Stat label="Cobrado este mes" valor={dinero(cobradoMes)} icon={Wallet} color="text-emerald-400" />
            <Stat label="Facturado este mes" valor={dinero(facturadoMes)} icon={TrendingUp} />
            <Stat label="En la calle" valor={dinero(deuda)} color="text-red-400" icon={AlertTriangle} />
            <Stat label="Abonados con deuda" valor={morosos} icon={Users} />
          </div>

          <Card title="Facturado y cobrado por mes" icon={BarChart3}>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={porMes} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  {/* Grilla horizontal apenas visible: ubica el valor sin competir
                      con las barras. */}
                  <CartesianGrid stroke={GRILLA} vertical={false} />
                  <XAxis
                    dataKey="mes"
                    tick={{ fill: EJE, fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: GRILLA }}
                  />
                  <YAxis
                    tick={{ fill: EJE, fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={compacto}
                    width={64}
                  />
                  <Tooltip content={<TooltipOscuro />} cursor={{ fill: '#1e293b55' }} />
                  <Legend
                    wrapperStyle={{ fontSize: 12, color: '#94a3b8', paddingTop: 8 }}
                    iconType="circle"
                  />
                  <Bar dataKey="Facturado" fill={SERIE_FACTURADO} radius={[4, 4, 0, 0]} maxBarSize={26} />
                  <Bar dataKey="Cobrado" fill={SERIE_COBRADO} radius={[4, 4, 0, 0]} maxBarSize={26} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              La diferencia entre las dos barras es lo que quedó sin cobrar de ese mes.
            </p>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <BarrasHorizontales
              titulo="Cobros por forma de pago"
              datos={porForma}
              clave="forma"
              total={pagos.reduce((s, p) => s + Number(p.monto), 0)}
            />
            <BarrasHorizontales
              titulo="Cobros por cuenta"
              datos={porCuenta}
              clave="cuenta"
              total={pagos.reduce((s, p) => s + Number(p.monto), 0)}
            />
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Una sola medida repartida entre categorías.
 *
 * Va en barras horizontales y no en torta: comparar longitudes es preciso y
 * comparar ángulos no. Y en un solo tono, porque el color no codifica nada acá
 * —la categoría ya está escrita al lado— y varias tonalidades harían pensar que
 * significan algo.
 */
function BarrasHorizontales({ titulo, datos, clave, total }) {
  if (!datos.length) {
    return (
      <Card title={titulo}>
        <Aviso>Sin datos todavía.</Aviso>
      </Card>
    )
  }

  const mayor = Math.max(...datos.map((d) => d.monto))

  return (
    <Card title={titulo}>
      <div className="space-y-2.5">
        {datos.map((d) => {
          const porcentaje = total > 0 ? (d.monto / total) * 100 : 0
          return (
            <div key={d[clave]}>
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="capitalize text-slate-300">{d[clave]}</span>
                {/* Valor y porcentaje escritos: no hay que estimarlos de la barra. */}
                <span className="text-slate-400">
                  <b className="text-slate-100">{dinero(d.monto)}</b>
                  <span className="ml-2 text-slate-500">{porcentaje.toFixed(0)}%</span>
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${mayor > 0 ? (d.monto / mayor) * 100 : 0}%`,
                    background: SERIE_FACTURADO,
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
