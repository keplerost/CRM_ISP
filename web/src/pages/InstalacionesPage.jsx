import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  CalendarClock,
  ChevronRight,
  Radio,
  Smartphone,
  UserCheck,
  Waypoints,
  Wrench,
} from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { ESTADOS, FACTIBILIDAD, TECNOLOGIAS } from '../lib/instalaciones'
import ProspectoForm from '../components/instalaciones/ProspectoForm'
import { Aviso, Badge, Card, Cargando, ErrorBanner, Input, Stat, Table } from '../components/ui'

/**
 * Prospectos y trabajos nuevos.
 *
 * Es la bandeja de entrada de todo lo que todavía no es un abonado: quién pidió
 * el servicio, si le llega, qué día se le prometió y quién va. Cuando el
 * técnico cierra el alta en el celular, la fila desaparece de acá y aparece en
 * Usuarios — que es lo que hace que el padrón de clientes sean los que tienen
 * servicio y no los que alguna vez llamaron.
 */

const fecha = (f) => (f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString() : '—')
const hoy = () => new Date().toISOString().slice(0, 10)

const FILTROS = [
  { valor: 'abiertos', label: 'Abiertos' },
  { valor: 'prospecto', label: 'Prospectos' },
  { valor: 'agendada', label: 'Agendadas' },
  { valor: 'en_curso', label: 'En curso' },
  { valor: 'hecha', label: 'Hechas' },
  { valor: 'cancelada', label: 'Canceladas' },
  { valor: '', label: 'Todas' },
]

export default function InstalacionesPage() {
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [filtro, setFiltro] = useState('abiertos')
  const [busqueda, setBusqueda] = useState('')

  const recargar = useCallback(async () => {
    setCargando(true)
    const { data, error: err } = await supabase
      .from('v_instalaciones')
      .select('*')
      .order('fecha', { ascending: false })
      .limit(500)

    if (err) setError(err)
    setFilas(data ?? [])
    setCargando(false)
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  const visibles = useMemo(() => {
    const texto = busqueda.trim().toLowerCase()

    return filas.filter((i) => {
      if (filtro === 'abiertos') {
        if (!['prospecto', 'agendada', 'en_curso'].includes(i.estado)) return false
      } else if (filtro && i.estado !== filtro) return false

      if (!texto) return true
      return [i.titular, i.cedula, i.telefono, i.direccion, i.sector, i.tecnico_nombre]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(texto))
    })
  }, [filas, filtro, busqueda])

  const cuenta = (predicado) => filas.filter(predicado).length
  const mes = hoy().slice(0, 7)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Instalaciones</h1>
        <p className="text-sm text-slate-500">
          Prospectos y trabajos nuevos: del pedido a la validación de cobertura, la agenda y el alta
          en campo.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Prospectos"
          valor={cuenta((i) => i.estado === 'prospecto')}
          sub="Sin agendar todavía"
          icon={UserCheck}
        />
        <Stat
          label="Agendadas"
          valor={cuenta((i) => i.estado === 'agendada')}
          sub={`${cuenta((i) => i.estado === 'agendada' && i.fecha === hoy())} para hoy`}
          icon={CalendarClock}
          color="text-amber-400"
        />
        <Stat
          label="En curso"
          valor={cuenta((i) => i.estado === 'en_curso')}
          sub="El técnico está instalando"
          icon={Wrench}
          color="text-violet-400"
        />
        <Stat
          label="Altas del mes"
          valor={cuenta((i) => i.estado === 'hecha' && String(i.fecha ?? '').startsWith(mes))}
          sub="Pasaron a Usuarios"
          icon={Waypoints}
          color="text-emerald-400"
        />
      </div>

      <ProspectoForm onError={setError} onCreado={recargar} />

      <Card
        title="Trabajos"
        icon={Wrench}
        actions={
          <Input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Nombre, cédula, dirección…"
            className="w-56"
          />
        }
      >
        <div className="mb-4 flex flex-wrap gap-2">
          {FILTROS.map((f) => (
            <button
              key={f.valor}
              type="button"
              onClick={() => setFiltro(f.valor)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                filtro === f.valor
                  ? 'border-sky-500/50 bg-sky-500/15 text-sky-300'
                  : 'border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {cargando ? (
          <Cargando />
        ) : visibles.length === 0 ? (
          <Aviso>
            {filas.length === 0
              ? 'Todavía no hay pedidos cargados. El primero se registra en el formulario de arriba.'
              : 'Ningún trabajo coincide con el filtro.'}
          </Aviso>
        ) : (
          <Table
            columnas={['Titular', 'Tecnología', 'Fecha', 'Quién va', 'Factibilidad', 'Estado', '']}
            filas={visibles}
            renderFila={(i) => (
              <tr key={i.id} className="text-slate-300">
                <td className="px-3 py-2">
                  <Link
                    to={`/clientes/instalaciones/${i.id}`}
                    className="text-slate-100 hover:text-sky-400 hover:underline"
                  >
                    {i.titular ?? '—'}
                  </Link>
                  <p className="text-[11px] text-slate-500">
                    {[i.cedula, i.sector || i.direccion].filter(Boolean).join(' · ') || 'Sin datos'}
                  </p>
                </td>

                <td className="px-3 py-2 text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    {i.tecnologia === 'wireless' ? <Radio size={13} /> : <Waypoints size={13} />}
                    {TECNOLOGIAS[i.tecnologia ?? 'ftth'].label}
                  </span>
                  <p className="text-[11px] text-slate-500">{i.nap ?? i.torre ?? 'Sin punto'}</p>
                </td>

                <td className="px-3 py-2 text-xs">
                  {fecha(i.fecha)}
                  {i.hora && (
                    <span className="ml-1 text-slate-500">{String(i.hora).slice(0, 5)}</span>
                  )}
                </td>

                <td className="px-3 py-2 text-xs">
                  {i.tecnico_nombre ?? i.cuadrilla ?? i.tecnico ?? (
                    <span className="text-slate-500">Sin asignar</span>
                  )}
                </td>

                <td className="px-3 py-2">
                  <Badge color={FACTIBILIDAD[i.factibilidad ?? 'pendiente'].color}>
                    {FACTIBILIDAD[i.factibilidad ?? 'pendiente'].label}
                  </Badge>
                </td>

                <td className="px-3 py-2">
                  <Badge color={ESTADOS[i.estado]?.color ?? 'gris'}>
                    {ESTADOS[i.estado]?.label ?? i.estado}
                  </Badge>
                </td>

                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-2">
                    {['agendada', 'en_curso'].includes(i.estado) && (
                      <Link
                        to={`/instalaciones/${i.id}/alta`}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 py-1.5 text-xs text-sky-300 hover:bg-sky-500/20"
                        title="Asistente de alta en campo"
                      >
                        <Smartphone size={13} />
                        Alta
                      </Link>
                    )}
                    <Link
                      to={`/clientes/instalaciones/${i.id}`}
                      className="text-slate-500 hover:text-slate-200"
                      title="Abrir la orden de trabajo"
                    >
                      <ChevronRight size={16} />
                    </Link>
                  </div>
                </td>
              </tr>
            )}
          />
        )}
      </Card>
    </div>
  )
}
