import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, Clock, Download, Target, TrendingUp, Users } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { supabase } from '../../lib/supabaseClient'
import { Aviso, Button, Card, ErrorBanner, Select, SkeletonTabla, Table } from '../../components/ui'
import ConPermiso from '../../components/layout/ConPermiso'
import BotonTema from '../../components/ventas/BotonTema'
import { useTemaCampo } from '../../lib/temaCampo'
import { dineroCero as dinero } from '../../lib/formato'
import { paleta } from '../../lib/comercial'
import { personalApi } from '../../lib/personal'

/**
 * Reportes comerciales.
 *
 * ── Qué lugar ocupa ──
 *
 *   El tablero contesta "¿cómo voy hoy?".
 *   Inteligencia contesta "¿dónde conviene invertir?".
 *   Esto contesta "¿qué pasó?".
 *
 * Son tres pantallas y no una a propósito: mezclar el mes en curso con la serie
 * de doce meses da una pantalla donde nada se lee bien.
 *
 * ── Sobre exportar ──
 *
 * Se exportan AGREGADOS —totales por mes, por vendedor, por plan— nunca la lista
 * de prospectos con sus teléfonos. Es la diferencia entre un reporte y una copia
 * de la cartera, y es exactamente la distinción que pide el punto 3 del
 * requerimiento. Cada descarga queda registrada en la auditoría.
 */

const PERIODOS = {
  3: 'Últimos 3 meses',
  6: 'Últimos 6 meses',
  12: 'Últimos 12 meses',
  0: 'Todo el historial',
}

export default function ReportesPage() {
  const { tema, alternar } = useTemaCampo()
  const C = paleta(tema)

  const [datos, setDatos] = useState({ mensual: [], vendedores: [], planes: [], sectores: [] })
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [meses, setMeses] = useState(6)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const [mensual, vendedores, planes, sectores] = await Promise.all([
        supabase.from('v_reporte_mensual').select('*').order('mes'),
        supabase.from('v_reporte_vendedores').select('*').order('ganados', { ascending: false }),
        supabase.from('v_reporte_planes').select('*'),
        supabase.from('v_reporte_sectores').select('*'),
      ])
      if (mensual.error) throw mensual.error
      setDatos({
        mensual: mensual.data ?? [],
        vendedores: vendedores.data ?? [],
        planes: planes.data ?? [],
        sectores: sectores.data ?? [],
      })
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

  const serie = useMemo(() => {
    const filas = [...datos.mensual]
    const recorte = meses > 0 ? filas.slice(-meses) : filas
    return recorte.map((m) => ({
      ...m,
      etiqueta: new Date(`${m.mes}T12:00:00`).toLocaleDateString('es-EC', {
        month: 'short',
        year: '2-digit',
      }),
    }))
  }, [datos.mensual, meses])

  const total = useMemo(
    () =>
      serie.reduce(
        (t, m) => ({
          cargados: t.cargados + m.cargados,
          ganados: t.ganados + m.ganados,
          perdidos: t.perdidos + m.perdidos,
          monto: t.monto + Number(m.monto || 0),
        }),
        { cargados: 0, ganados: 0, perdidos: 0, monto: 0 },
      ),
    [serie],
  )

  const cierre =
    total.ganados + total.perdidos > 0
      ? Math.round((total.ganados / (total.ganados + total.perdidos)) * 100)
      : null

  const diasPromedio = useMemo(() => {
    const con = datos.vendedores.filter((v) => v.dias_cierre != null && v.ganados > 0)
    if (!con.length) return null
    const suma = con.reduce((t, v) => t + Number(v.dias_cierre) * v.ganados, 0)
    const n = con.reduce((t, v) => t + v.ganados, 0)
    return (suma / n).toFixed(1)
  }, [datos.vendedores])

  /**
   * Exporta el reporte a CSV.
   *
   * Solo agregados. Se arma acá y no en el servidor porque son unas decenas de
   * filas ya cargadas en memoria: pedirle al backend que las vuelva a calcular
   * para devolver el mismo texto sería un viaje al pedo.
   */
  const exportar = (nombre, filas, columnas) => {
    if (!filas.length) return
    const escapar = (v) => {
      const s = String(v ?? '')
      // Una coma o una comilla adentro de un campo rompen el archivo si no se
      // encierra: es el error clásico que hace que Excel corra las columnas.
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const csv = [
      columnas.map((c) => escapar(c.titulo)).join(';'),
      ...filas.map((f) => columnas.map((c) => escapar(c.valor(f))).join(';')),
    ].join('\n')

    // El BOM es lo que hace que Excel en español abra los acentos bien. Sin él,
    // "Instalación" se ve como "InstalaciÃ³n" y el reporte parece roto.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${nombre}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)

    personalApi.registrar('reporte.exportar', `Exportó el reporte ${nombre} (${filas.length} filas)`, {
      entidad: 'reporte',
      entidad_id: nombre,
    })
  }

  const vacio = !cargando && datos.mensual.length === 0

  return (
    <div className="campo campo-fondo -m-6 space-y-4 p-4 md:p-6" data-tema={tema}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="campo-txt flex items-center gap-2 text-xl font-semibold">
            <BarChart3 size={20} style={{ color: C.serie }} />
            Reportes comerciales
          </h1>
          <p className="campo-suave text-sm">Qué pasó: la serie histórica y la comparación.</p>
        </div>
        <div className="flex items-center gap-2">
          <BotonTema tema={tema} onAlternar={alternar} />
          <Select value={meses} onChange={(e) => setMeses(Number(e.target.value))} className="w-44">
            {Object.entries(PERIODOS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {vacio && (
        <Aviso>
          Todavía no hay prospectos cargados, así que no hay historia que reportar. Esta pantalla se
          llena sola a medida que se trabaja el embudo.
        </Aviso>
      )}

      {/* ── El resumen del período ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metrica titulo="Prospectos cargados" valor={total.cargados} icono={Users} color={C.etapas[0]} />
        <Metrica titulo="Ganados" valor={total.ganados} icono={Target} color={C.bien} />
        <Metrica titulo="Perdidos" valor={total.perdidos} icono={Target} color={C.critico} />
        <Metrica
          titulo="Tasa de cierre"
          valor={cierre != null ? `${cierre}%` : '—'}
          nota={cierre != null ? 'Sobre los ya cerrados' : 'Nada cerrado todavía'}
          icono={TrendingUp}
          color={C.etapas[2]}
        />
        <Metrica
          titulo="Días para cerrar"
          valor={diasPromedio ?? '—'}
          nota="Promedio desde que entra hasta que se gana"
          icono={Clock}
          color={C.etapas[3]}
        />
      </div>

      {/* ── Evolución ── */}
      <Card
        title="Evolución mensual"
        subtitle="Prospectos que entraron y ventas que se cerraron, mes por mes"
        actions={
          <ConPermiso permiso="reportes.exportar" envezDe={null}>
            <Button
              icon={Download}
              onClick={() =>
                exportar('ventas-por-mes', serie, [
                  { titulo: 'Mes', valor: (f) => f.mes },
                  { titulo: 'Cargados', valor: (f) => f.cargados },
                  { titulo: 'Ganados', valor: (f) => f.ganados },
                  { titulo: 'Perdidos', valor: (f) => f.perdidos },
                  { titulo: 'Monto', valor: (f) => f.monto },
                ])
              }
            >
              Exportar
            </Button>
          </ConPermiso>
        }
      >
        {serie.length === 0 ? (
          <Vacio />
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={serie} margin={{ top: 12, right: 8 }}>
              <CartesianGrid vertical={false} stroke={C.grilla} />
              <XAxis dataKey="etiqueta" stroke={C.eje} fontSize={11} tickLine={false} />
              <YAxis stroke={C.eje} fontSize={11} allowDecimals={false} />
              <Tooltip cursor={{ fill: 'rgba(128,128,128,0.08)' }} content={<Globo />} />
              {/* Dos series, así que hay leyenda — y además cada barra lleva su
                  número escrito arriba. El color no comunica solo. */}
              <Bar dataKey="cargados" name="Cargados" fill={C.etapas[0]} radius={[4, 4, 0, 0]} maxBarSize={28}>
                <LabelList dataKey="cargados" position="top" fill={C.eje} fontSize={10} />
              </Bar>
              <Bar dataKey="ganados" name="Ganados" fill={C.bien} radius={[4, 4, 0, 0]} maxBarSize={28}>
                <LabelList dataKey="ganados" position="top" fill={C.eje} fontSize={10} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
        <div className="mt-2 flex gap-4 text-[12px]">
          <Leyenda color={C.etapas[0]} texto="Prospectos cargados" />
          <Leyenda color={C.bien} texto="Ventas ganadas" />
        </div>
      </Card>

      {/* ── Vendedores ── */}
      <Card
        title="Comparación entre vendedores"
        subtitle="Todo el historial. El mes en curso está en el tablero comercial."
        actions={
          <ConPermiso permiso="reportes.exportar" envezDe={null}>
            <Button
              icon={Download}
              onClick={() =>
                exportar('vendedores', datos.vendedores, [
                  { titulo: 'Vendedor', valor: (f) => f.vendedor },
                  { titulo: 'Cargados', valor: (f) => f.cargados },
                  { titulo: 'Ganados', valor: (f) => f.ganados },
                  { titulo: 'Perdidos', valor: (f) => f.perdidos },
                  { titulo: 'Abiertos', valor: (f) => f.abiertos },
                  { titulo: 'Tasa de cierre %', valor: (f) => f.tasa_cierre ?? '' },
                  { titulo: 'Monto', valor: (f) => f.monto_total },
                  { titulo: 'Días para cerrar', valor: (f) => f.dias_cierre ?? '' },
                ])
              }
            >
              Exportar
            </Button>
          </ConPermiso>
        }
      >
        {cargando ? (
          <SkeletonTabla filas={4} columnas={7} />
        ) : (
          <Table
            columnas={['Vendedor', 'Cargados', 'Ganados', 'Perdidos', 'Abiertos', 'Cierre', 'Monto', 'Días']}
            filas={datos.vendedores}
            vacio="Sin vendedores con actividad."
            renderFila={(v) => (
              <tr key={v.vendedor_id} className="hover:bg-slate-800/40">
                <td className="px-3 py-2">
                  <span className="campo-txt">{v.vendedor}</span>
                  {!v.activo && <span className="campo-tenue text-[11px]"> · inactivo</span>}
                </td>
                <td className="campo-suave px-3 py-2 tabular-nums">{v.cargados}</td>
                <td className="px-3 py-2 tabular-nums" style={{ color: C.bien }}>
                  {v.ganados}
                </td>
                <td className="campo-suave px-3 py-2 tabular-nums">{v.perdidos}</td>
                <td className="campo-suave px-3 py-2 tabular-nums">{v.abiertos}</td>
                <td className="campo-txt px-3 py-2 tabular-nums">
                  {v.tasa_cierre != null ? `${v.tasa_cierre}%` : '—'}
                </td>
                <td className="campo-txt px-3 py-2 tabular-nums">{dinero(v.monto_total)}</td>
                <td className="campo-suave px-3 py-2 tabular-nums">
                  {v.dias_cierre != null ? `${v.dias_cierre} d` : '—'}
                </td>
              </tr>
            )}
          />
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* ── Planes ── */}
        <Card title="Qué plan se vende" subtitle="Cotizados contra cerrados">
          <Table
            columnas={['Plan', 'Cotizado', 'Ganado', 'Monto']}
            filas={datos.planes}
            vacio="Sin datos."
            renderFila={(p) => (
              <tr key={p.plan} className="hover:bg-slate-800/40">
                <td className="campo-txt px-3 py-2">
                  {p.plan}
                  {p.precio != null && (
                    <span className="campo-tenue text-[11px]"> · {dinero(p.precio)}</span>
                  )}
                </td>
                <td className="campo-suave px-3 py-2 tabular-nums">{p.cotizados}</td>
                <td className="px-3 py-2 tabular-nums" style={{ color: C.bien }}>
                  {p.ganados}
                </td>
                <td className="campo-txt px-3 py-2 tabular-nums">{dinero(p.monto)}</td>
              </tr>
            )}
          />
        </Card>

        {/* ── Sectores ── */}
        <Card title="Dónde se vende" subtitle="Por sector, con su tasa de cierre">
          <Table
            columnas={['Sector', 'Prospectos', 'Ganados', 'Cierre', 'Monto']}
            filas={datos.sectores.slice(0, 12)}
            vacio="Sin datos."
            renderFila={(s) => (
              <tr key={s.sector} className="hover:bg-slate-800/40">
                <td className="campo-txt px-3 py-2">{s.sector}</td>
                <td className="campo-suave px-3 py-2 tabular-nums">{s.prospectos}</td>
                <td className="px-3 py-2 tabular-nums" style={{ color: C.bien }}>
                  {s.ganados}
                </td>
                <td className="campo-txt px-3 py-2 tabular-nums">
                  {s.tasa_cierre != null ? `${s.tasa_cierre}%` : '—'}
                </td>
                <td className="campo-txt px-3 py-2 tabular-nums">{dinero(s.monto)}</td>
              </tr>
            )}
          />
        </Card>
      </div>

      <p className="campo-tenue text-[11px]">
        Los reportes exportan totales, nunca la lista de prospectos con sus teléfonos. Cada descarga
        queda registrada en la auditoría con tu nombre y la hora.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------

function Metrica({ titulo, valor, nota, icono: Icono, color }) {
  return (
    <div className="campo-sup campo-borde rounded-xl border p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="campo-suave text-[12px]">{titulo}</span>
        <span
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
          style={{ background: `${color}22`, color }}
        >
          <Icono size={16} />
        </span>
      </div>
      <div className="campo-txt mt-1 text-2xl font-semibold tabular-nums">{valor}</div>
      {nota && <p className="campo-tenue mt-0.5 text-[11px] leading-tight">{nota}</p>}
    </div>
  )
}

const Leyenda = ({ color, texto }) => (
  <span className="flex items-center gap-1.5">
    <i className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
    <span className="campo-suave">{texto}</span>
  </span>
)

const Vacio = () => (
  <p className="campo-tenue py-10 text-center text-[13px]">Sin datos en este período.</p>
)

function Globo({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="t-card-sm px-3 py-2 text-[12px] shadow-lg">
      <p className="mb-0.5 text-slate-200">{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="text-slate-400">
          {p.name}: {p.value}
        </p>
      ))}
    </div>
  )
}
