import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Activity, Download, FileText, MessageCircle, RefreshCw, Upload } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { Aviso, Button, Card, Field, Select, Stat, Table } from '../ui'
import { enlaceWhatsapp } from '../../lib/soporte'

/**
 * Consumo del abonado, mes a mes.
 *
 * Sirve para dos conversaciones distintas y por eso muestra las dos cosas:
 *
 *  - "No me anduvo tal día": el color de cada barra dice cómo estuvo el
 *    servicio —activo, con compromiso de pago, suspendido—, y eso se contesta
 *    mirando el gráfico, sin buscar en ningún lado.
 *  - "Yo no consumí tanto": el detalle día por día es lo que se puede discutir.
 *    Un total suelto no se verifica ni se refuta.
 */

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

// Azul y naranja son las dos series —bajada y subida—; verde y rojo son estado
// del servicio, no series. Mezclarlos haría que un día suspendido parezca otra
// medición en vez de otra situación.
const COLOR = {
  bajada: '#3987e5',
  subida: '#d95926',
  activo: '#3987e5',
  promesa: '#047857',
  cortado: '#dc2626',
  suspendido: '#64748b',
}

const ETIQUETA_ESTADO = {
  activo: 'Servicio activo',
  promesa: 'Con compromiso de pago',
  cortado: 'Suspendido por deuda',
  suspendido: 'Suspendido',
}

function enGigas(bytes) {
  const b = Number(bytes) || 0
  const gb = b / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  const mb = b / 1024 ** 2
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${(b / 1024).toFixed(0)} KB`
}

const aGigas = (bytes) => Number(((Number(bytes) || 0) / 1024 ** 3).toFixed(3))

export default function FichaConsumo({ cliente, onError }) {
  const hoy = new Date()
  const [anio, setAnio] = useState(hoy.getFullYear())
  const [mes, setMes] = useState(hoy.getMonth() + 1)

  const [dias, setDias] = useState([])
  const [sesiones, setSesiones] = useState([])
  const [cargando, setCargando] = useState(true)
  const [midiendo, setMidiendo] = useState(false)
  const [aviso, setAviso] = useState(null)

  const clave = `${anio}-${String(mes).padStart(2, '0')}`

  const recargar = useCallback(async () => {
    setCargando(true)

    const ultimo = new Date(anio, mes, 0).getDate()
    const desde = `${clave}-01`
    const hasta = `${clave}-${String(ultimo).padStart(2, '0')}`

    const [c, s] = await Promise.all([
      supabase
        .from('consumo_diario')
        .select('*')
        .eq('client_id', cliente.id)
        .gte('fecha', desde)
        .lte('fecha', hasta)
        .order('fecha'),
      supabase
        .from('sesiones_conexion')
        .select('*')
        .eq('client_id', cliente.id)
        .gte('inicio', `${desde}T00:00:00`)
        .order('inicio', { ascending: false })
        .limit(50),
    ])

    if (c.error) onError?.(c.error)
    setDias(c.data ?? [])
    setSesiones(s.data ?? [])
    setCargando(false)
  }, [cliente.id, anio, mes, clave, onError])

  useEffect(() => {
    recargar()
  }, [recargar])

  // Un punto por día del mes, con los que no tienen medición en cero: si se
  // dibujaran solo los días medidos, un mes con tres registros se vería como un
  // mes completo y ocultaría que faltan mediciones.
  const datos = useMemo(() => {
    const ultimo = new Date(anio, mes, 0).getDate()
    const porDia = Object.fromEntries(dias.map((d) => [Number(String(d.fecha).slice(8, 10)), d]))

    return Array.from({ length: ultimo }, (_, i) => {
      const d = porDia[i + 1]
      return {
        dia: i + 1,
        bajada: aGigas(d?.bajada_bytes),
        subida: aGigas(d?.subida_bytes),
        estado: d?.estado_servicio ?? null,
        medido: Boolean(d),
      }
    })
  }, [dias, anio, mes])

  const total = useMemo(
    () =>
      dias.reduce(
        (a, d) => ({
          subida: a.subida + Number(d.subida_bytes),
          bajada: a.bajada + Number(d.bajada_bytes),
        }),
        { subida: 0, bajada: 0 },
      ),
    [dias],
  )

  const cortados = dias.filter((d) => d.estado_servicio === 'cortado').length
  const conPromesa = dias.filter((d) => d.estado_servicio === 'promesa').length

  async function medirAhora() {
    setMidiendo(true)
    setAviso(null)
    try {
      const r = await api.consumo.recolectar()
      setAviso(
        `Se midieron ${r.medidos} abonados.` +
          (r.fallidos?.length ? ` ${r.fallidos.length} con error.` : ''),
      )
      await recargar()
    } catch (err) {
      onError?.(err)
    } finally {
      setMidiendo(false)
    }
  }

  async function verReporte(descargar = false) {
    try {
      const blob = await api.consumo.reporte(cliente.id, clave, descargar)
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      onError?.(err)
    }
  }

  // Por WhatsApp va el resumen escrito, no el PDF: un enlace wa.me no puede
  // adjuntar archivos. El abonado recibe el número y, si lo discute, se le
  // manda el PDF por correo.
  const waResumen = enlaceWhatsapp(
    cliente.telefono_movil || cliente.telefono,
    `Hola ${String(cliente.nombre ?? '').split(' ')[0]}, su consumo de ${MESES[mes - 1]} de ${anio}: ` +
      `descarga ${enGigas(total.bajada)}, subida ${enGigas(total.subida)}, ` +
      `total ${enGigas(total.bajada + total.subida)}.`,
  )

  const anios = Array.from({ length: 4 }, (_, i) => hoy.getFullYear() - i)

  return (
    <div className="space-y-4">
      <Card
        title="Consumo y auditoría"
        icon={Activity}
        actions={
          <Button variante="secundario" icon={RefreshCw} onClick={medirAhora} cargando={midiendo}>
            Medir ahora
          </Button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Año">
            <Select value={anio} onChange={(e) => setAnio(Number(e.target.value))}>
              {anios.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Mes">
            <Select value={mes} onChange={(e) => setMes(Number(e.target.value))}>
              {MESES.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {aviso && (
          <div className="mt-3">
            <Aviso>{aviso}</Aviso>
          </div>
        )}
      </Card>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Descarga" valor={enGigas(total.bajada)} icon={Download} color="text-sky-400" />
        <Stat label="Subida" valor={enGigas(total.subida)} icon={Upload} color="text-orange-400" />
        <Stat
          label="Total del mes"
          valor={enGigas(total.bajada + total.subida)}
          sub={`${dias.length} ${dias.length === 1 ? 'día medido' : 'días medidos'}`}
          icon={Activity}
        />
      </div>

      <Card title={`Consumo diario · ${MESES[mes - 1]} de ${anio}`}>
        {cargando ? (
          <p className="py-10 text-center text-sm text-slate-500">Cargando…</p>
        ) : !dias.length ? (
          <div className="space-y-3 py-6">
            <p className="text-center text-sm text-slate-500">
              No hay mediciones de este mes.
            </p>
            <Aviso>
              La medición se toma de los contadores del router. Encendela con{' '}
              <code className="rounded bg-slate-800 px-1">CONSUMO_AUTOMATICO=true</code> en el
              middleware, o probá con <b>Medir ahora</b> para ver si las colas del router se
              emparejan con este abonado.
            </Aviso>
          </div>
        ) : (
          <>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={datos} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke="#1e293b" vertical={false} />
                  <XAxis
                    dataKey="dia"
                    stroke="#64748b"
                    fontSize={11}
                    tickLine={false}
                    axisLine={{ stroke: '#1e293b' }}
                    interval={4}
                  />
                  <YAxis
                    stroke="#64748b"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={48}
                    tickFormatter={(v) => `${v} GB`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: '#0f172a',
                      border: '1px solid #334155',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={(d) => `${d} de ${MESES[mes - 1]}`}
                    formatter={(v, n, { payload }) => [
                      `${v} GB`,
                      n === 'bajada' ? 'Descarga' : 'Subida',
                      payload,
                    ]}
                  />
                  {/* Apiladas: lo que interesa es el total del día, y la
                      proporción entre subida y bajada se ve igual. */}
                  <Bar dataKey="bajada" stackId="c" radius={[0, 0, 0, 0]}>
                    {datos.map((d) => (
                      <Cell
                        key={d.dia}
                        fill={d.estado && d.estado !== 'activo' ? COLOR[d.estado] : COLOR.bajada}
                      />
                    ))}
                  </Bar>
                  <Bar dataKey="subida" stackId="c" radius={[3, 3, 0, 0]}>
                    {datos.map((d) => (
                      <Cell
                        key={d.dia}
                        fill={d.estado && d.estado !== 'activo' ? COLOR[d.estado] : COLOR.subida}
                        fillOpacity={d.estado && d.estado !== 'activo' ? 0.55 : 1}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* La leyenda nombra las dos series y los dos estados: el color solo
                no alcanza para saber qué se está mirando. */}
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[11px] text-slate-400">
              {[
                ['bajada', 'Descarga'],
                ['subida', 'Subida'],
                ['promesa', 'Con compromiso de pago'],
                ['cortado', 'Suspendido'],
              ].map(([k, label]) => (
                <span key={k} className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLOR[k] }} />
                  {label}
                </span>
              ))}
            </div>

            {(cortados > 0 || conPromesa > 0) && (
              <p className="mt-3 text-xs text-slate-400">
                {cortados > 0 && (
                  <>
                    <b className="text-rose-300">{cortados}</b>{' '}
                    {cortados === 1 ? 'día suspendido' : 'días suspendidos'}
                  </>
                )}
                {cortados > 0 && conPromesa > 0 && ' · '}
                {conPromesa > 0 && (
                  <>
                    <b className="text-emerald-300">{conPromesa}</b>{' '}
                    {conPromesa === 1 ? 'día' : 'días'} conectado por compromiso de pago
                  </>
                )}
              </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <Button variante="primario" icon={FileText} onClick={() => verReporte(false)}>
                Reporte en PDF
              </Button>
              <Button variante="secundario" icon={Download} onClick={() => verReporte(true)}>
                Descargar
              </Button>
              {waResumen && (
                <a
                  href={waResumen}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-emerald-600/40 px-3 py-2 text-sm text-emerald-300 transition hover:bg-emerald-500/10"
                >
                  <MessageCircle size={15} /> Enviar resumen por WhatsApp
                </a>
              )}
            </div>
          </>
        )}
      </Card>

      <Card
        title="Sesiones de conexión"
        subtitle="Registros del router / RADIUS"
      >
        <Table
          columnas={['Inicio', 'Fin', 'IP', 'MAC', 'Equipo', 'Motivo']}
          filas={sesiones}
          vacio="Sin sesiones registradas. Este abonado usa IP fija, no PPPoE, o todavía no se sincronizaron."
          renderFila={(s) => (
            <tr key={s.id} className="border-t border-slate-800">
              <td className="px-3 py-2 text-xs">{new Date(s.inicio).toLocaleString()}</td>
              <td className="px-3 py-2 text-xs">
                {s.fin ? (
                  new Date(s.fin).toLocaleString()
                ) : (
                  <span className="text-emerald-400">conectado</span>
                )}
              </td>
              <td className="px-3 py-2 font-mono text-xs">{s.ip ?? '—'}</td>
              <td className="px-3 py-2 font-mono text-xs">{s.mac ?? '—'}</td>
              <td className="px-3 py-2 text-xs">{s.nas ?? '—'}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{s.motivo_desconexion ?? '—'}</td>
            </tr>
          )}
        />
      </Card>
    </div>
  )
}
