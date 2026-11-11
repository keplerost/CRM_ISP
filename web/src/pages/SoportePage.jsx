import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, LifeBuoy, Plus, Radio, Search, Waves, X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { Button, Card, ErrorBanner, Input, Modal, Select, Stat } from '../components/ui'
import TicketForm from '../components/soporte/TicketForm'
import ConPermiso from '../components/layout/ConPermiso'
import { usePermisos } from '../lib/AuthContext'
import { pareceAdministrativo } from '../lib/pendientes'

// Un id que no existe. Sirve para que el filtro por técnico no traiga nada
// cuando el usuario no tiene técnico vinculado: sin esto, `.eq('tecnico_id',
// undefined)` desaparece de la consulta y devuelve la bandeja completa —el
// error se ve como que funciona, que es la peor forma de fallar.
const NADIE = '00000000-0000-0000-0000-000000000000'
import {
  ESTADOS,
  PRIORIDADES,
  coincideTicket,
  esDeAsignado,
  deQuien,
  etiquetaIncidencia,
  haceCuanto,
} from '../lib/soporte'

/**
 * Los tickets abiertos, de un vistazo.
 *
 * El orden no es por fecha sino por urgencia real: primero lo atrasado, después
 * la prioridad y recién ahí la antigüedad. Un reclamo de prioridad alta de hoy
 * importa más que uno bajo de la semana pasada, y una visita que se pasó de
 * fecha importa más que los dos.
 */

const PESO_PRIORIDAD = { alta: 0, media: 1, baja: 2 }

const fecha = (f) =>
  f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString() : null

const fechaHoraCorta = (f) =>
  f ? new Date(f).toLocaleString('es-EC', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''

/** "2026-11-11" de una fecha local (no UTC: a las 20:00 en Ecuador ya es mañana en UTC). */
const diaLocal = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Los atajos de fecha para los cerrados. */
function rangoRapido(clave) {
  const hoy = new Date()
  const dia = (n) => {
    const d = new Date(hoy)
    d.setDate(d.getDate() + n)
    return diaLocal(d)
  }
  if (clave === 'hoy') return { desde: dia(0), hasta: dia(0) }
  if (clave === 'ayer') return { desde: dia(-1), hasta: dia(-1) }
  if (clave === 'semana') return { desde: dia(-((hoy.getDay() + 6) % 7)), hasta: dia(0) }
  if (clave === 'mes') return { desde: diaLocal(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), hasta: dia(0) }
  if (clave === 'mes_pasado') {
    return {
      desde: diaLocal(new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1)),
      hasta: diaLocal(new Date(hoy.getFullYear(), hoy.getMonth(), 0)),
    }
  }
  return null
}

const ATAJOS = [
  ['hoy', 'Hoy'],
  ['ayer', 'Ayer'],
  ['semana', 'Esta semana'],
  ['mes', 'Este mes'],
  ['mes_pasado', 'Mes pasado'],
]

// Lo que hace falta para la lista de cerrados: sin la firma ni el checklist,
// que pesan y acá no se muestran (pueden ser cientos de tickets).
const COLUMNAS_CERRADOS =
  'id,numero,codigo,nombre,identificacion,telefono,telefono_whatsapp,direccion,sector,tecnologia,tipo_incidencia,' +
  'incidencia_otro,descripcion,prioridad,estado,fecha_visita,tecnico_id,cuadrilla_id,tecnico,cuadrilla,cerrado_at,' +
  'updated_at,created_at,horas_abierto,visita_atrasada,minutos_en_sitio,solucion,motivo_cancelacion'

export default function SoportePage() {
  const navegar = useNavigate()

  const [tickets, setTickets] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [creando, setCreando] = useState(false)
  // El filtro sale de la URL para que el panel pueda enlazar ya filtrado:
  // "14 tickets abiertos" tiene que abrir los 14, no la bandeja entera para
  // que uno vuelva a elegir a mano lo que el número ya decía.
  //
  // Solo se lee al arrancar. Lo que se elija después vive en la pantalla y no
  // reescribe la URL: el filtro es una vista, no un lugar.
  const [params] = useSearchParams()
  const [filtro, setFiltro] = useState(() => params.get('estado') ?? 'pendientes')
  const [busqueda, setBusqueda] = useState('')
  // Para el técnico: los suyos, los de su cuadrilla, o todos.
  const [deQuienVer, setDeQuienVer] = useState('todos')
  // Para la oficina: los de un técnico, una cuadrilla, o los sin asignar.
  const [asignadoA, setAsignadoA] = useState('todos')
  const [miembros, setMiembros] = useState([])
  const [listaTecnicos, setListaTecnicos] = useState([])
  // Resueltos y cancelados: se traen de la base por fecha de cierre, no de los
  // últimos 300, para poder mirar cualquier mes.
  const [rango, setRango] = useState(() => rangoRapido('mes'))
  const [cerrados, setCerrados] = useState([])
  const [cargandoCerrados, setCargandoCerrados] = useState(false)
  const verCerrados = filtro === 'resuelto' || filtro === 'cancelado'
  const { puede, perfil } = usePermisos()
  // Un técnico ve los suyos y los de su cuadrilla: puede separarlos.
  const esTecnico = !puede('soporte.ver') && Boolean(perfil?.tecnico_id)
  // Quien ve todo pero también sale a campo (el administrador con ficha de
  // técnico): puede filtrar lo que le asignaron a él.
  const conFicha = Boolean(perfil?.tecnico_id)

  /**
   * Trae los tickets, y solo los que corresponden.
   *
   * Quien tiene `soporte.ver` los ve todos. Quien solo tiene
   * `soporte.asignados` —el técnico— ve únicamente los suyos: ocultarle el
   * botón de crear no serviría de nada si la lista igual le muestra los
   * reclamos de toda la ciudad, con el nombre y la dirección de cada abonado.
   *
   * El vínculo es `perfil.tecnico_id`, que se elige al crear el usuario. Si
   * quedó vacío, la consulta no trae nada: es preferible una bandeja vacía —que
   * se entiende y se arregla— a mostrarle de más a quien no debería.
   */
  const recargar = useCallback(async () => {
    setCargando(true)

    let consulta = supabase.from('v_tickets').select('*')
    if (!puede('soporte.ver')) {
      /* Los suyos y los de las cuadrillas que integra: un ticket asignado a la
         cuadrilla es trabajo de todos sus integrantes, no de nadie. */
      const yo = perfil?.tecnico_id ?? NADIE
      const { data: cuadrillas } = await supabase.rpc('mis_cuadrillas')
      const ids = (cuadrillas ?? []).map((c) => (typeof c === 'string' ? c : c.mis_cuadrillas))
      consulta = ids.length
        ? consulta.or(`tecnico_id.eq.${yo},cuadrilla_id.in.(${ids.join(',')})`)
        : consulta.eq('tecnico_id', yo)
    }

    const { data, error: err } = await consulta
      .order('created_at', { ascending: false })
      .limit(300)

    if (err) setError(err)
    setTickets(data ?? [])
    setCargando(false)
  }, [puede, perfil])

  useEffect(() => {
    recargar()
  }, [recargar])

  const cargarCerrados = useCallback(async () => {
    if (!verCerrados || !rango?.desde || !rango?.hasta) return
    setCargandoCerrados(true)
    // El cancelado no guarda la hora de cierre: se usa la última modificación.
    const campo = filtro === 'resuelto' ? 'cerrado_at' : 'updated_at'
    const hastaExcl = new Date(`${rango.hasta}T00:00:00`)
    hastaExcl.setDate(hastaExcl.getDate() + 1)
    let consulta = supabase
      .from('v_tickets')
      .select(COLUMNAS_CERRADOS)
      .eq('estado', filtro)
      .gte(campo, new Date(`${rango.desde}T00:00:00`).toISOString())
      .lt(campo, hastaExcl.toISOString())
    if (!puede('soporte.ver')) {
      const yo = perfil?.tecnico_id ?? NADIE
      const { data: cuadrillas } = await supabase.rpc('mis_cuadrillas')
      const ids = (cuadrillas ?? []).map((c) => (typeof c === 'string' ? c : c.mis_cuadrillas))
      consulta = ids.length
        ? consulta.or(`tecnico_id.eq.${yo},cuadrilla_id.in.(${ids.join(',')})`)
        : consulta.eq('tecnico_id', yo)
    }
    const { data, error: err } = await consulta.order(campo, { ascending: false }).limit(2000)
    if (err) setError(err)
    setCerrados(data ?? [])
    setCargandoCerrados(false)
  }, [verCerrados, filtro, rango, puede, perfil])

  useEffect(() => {
    cargarCerrados()
  }, [cargarCerrados])

  useEffect(() => {
    if (!puede('soporte.ver')) return
    supabase
      .from('cuadrilla_miembros')
      .select('cuadrilla_id, tecnico_id')
      .then(({ data }) => setMiembros(data ?? []))
    supabase
      .from('tecnicos')
      .select('id, nombre')
      .eq('activo', true)
      .order('nombre')
      .then(({ data }) => setListaTecnicos(data ?? []))
  }, [puede])

  /* Las opciones de "Asignado a": todos los técnicos activos —aunque no
     tengan nada a su nombre, como el que solo tiene lo de su cuadrilla— y las
     cuadrillas que aparecen en los tickets. */
  const opcionesAsignado = useMemo(() => {
    const cuadrillas = new Map()
    for (const t of [...tickets, ...cerrados]) {
      if (t.cuadrilla_id && t.cuadrilla) cuadrillas.set(t.cuadrilla_id, t.cuadrilla)
    }
    return {
      tecnicos: listaTecnicos.map((t) => [t.id, t.nombre]),
      cuadrillas: [...cuadrillas.entries()].sort((a, b) => a[1].localeCompare(b[1])),
    }
  }, [tickets, cerrados, listaTecnicos])

  const visibles = useMemo(() => {
    const abiertos = (t) => !['resuelto', 'cancelado'].includes(t.estado)

    const buscando = busqueda.trim() !== ''
    // Viendo resueltos o cancelados, la lista es la del rango de fechas.
    const fuente = verCerrados && !buscando ? cerrados : tickets
    const filtrados = fuente.filter((t) => {
      if (!esDeAsignado(t, asignadoA, miembros)) return false
      if (!conFicha || deQuienVer === 'todos' || deQuien(t, perfil?.tecnico_id) === deQuienVer) {
        // Buscando, se busca en TODOS los estados: el que busca "¿le creé el
        // ticket a esta persona?" no sabe si ya se cerró.
        if (buscando) return coincideTicket(t, busqueda)
        if (verCerrados) return true
        if (filtro === 'pendientes') return abiertos(t)
        if (filtro === 'todos') return true
        return t.estado === filtro
      }
      return false
    })

    if (verCerrados && !buscando) return filtrados // ya vienen del más reciente al más viejo

    return filtrados.sort(
      (a, b) =>
        Number(b.visita_atrasada) - Number(a.visita_atrasada) ||
        (PESO_PRIORIDAD[a.prioridad] ?? 9) - (PESO_PRIORIDAD[b.prioridad] ?? 9) ||
        Number(b.horas_abierto) - Number(a.horas_abierto),
    )
  }, [tickets, cerrados, verCerrados, filtro, busqueda, deQuienVer, conFicha, perfil?.tecnico_id, asignadoA, miembros])

  /* Cuántos cerró cada uno en el rango, por la cuadrilla o el técnico
     asignado. Sin el filtro de "Asignado a", para poder compararlos. */
  const porResponsable = useMemo(() => {
    if (!verCerrados) return []
    const m = new Map()
    for (const t of cerrados) {
      const clave = t.cuadrilla_id ? `c:${t.cuadrilla_id}` : t.tecnico_id ? `t:${t.tecnico_id}` : 'sin_asignar'
      const nombre = t.cuadrilla ? `Cuadrilla ${t.cuadrilla}` : (t.tecnico ?? 'Sin asignar')
      const x = m.get(clave) ?? { clave, nombre, total: 0 }
      x.total += 1
      m.set(clave, x)
    }
    return [...m.values()].sort((a, b) => b.total - a.total)
  }, [verCerrados, cerrados])

  const abiertos = tickets.filter((t) => !['resuelto', 'cancelado'].includes(t.estado))
  const atrasados = abiertos.filter((t) => t.visita_atrasada)
  const altos = abiertos.filter((t) => t.prioridad === 'alta')

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-100">
            <LifeBuoy className="text-sky-400" /> Soporte técnico
          </h1>
          <p className="text-sm text-slate-500">
            Reclamos, visitas y órdenes de trabajo.
          </p>
        </div>

        <ConPermiso permiso="soporte.crear" envezDe={null}>
          <Button variante="primario" icon={Plus} onClick={() => setCreando(true)}>
            Nuevo ticket
          </Button>
        </ConPermiso>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Sin resolver" valor={abiertos.length} icon={LifeBuoy} />
        <Stat
          label="Prioridad alta"
          valor={altos.length}
          icon={AlertTriangle}
          color="text-rose-400"
        />
        <Stat
          label="Visita atrasada"
          valor={atrasados.length}
          sub={atrasados.length ? 'La fecha pactada ya pasó' : 'Todo al día'}
          icon={AlertTriangle}
          color={atrasados.length ? 'text-amber-400' : 'text-emerald-400'}
        />
      </div>

      {/* El buscador. Busca en todos los estados, abiertos y cerrados. */}
      <div className="relative">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <Input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar por nombre, cédula, teléfono, N° de ticket, dirección o técnico"
          className="pl-9 pr-9"
        />
        {busqueda && (
          <button
            type="button"
            onClick={() => setBusqueda('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-300"
            aria-label="Borrar búsqueda"
          >
            <X size={15} />
          </button>
        )}
      </div>

      {conFicha && (
        <div className="flex gap-2">
          {[
            ['todos', 'Todos'],
            ['mio', `Asignados a mí (${tickets.filter((t) => deQuien(t, perfil?.tecnico_id) === 'mio').length})`],
            // "De mi cuadrilla" solo para el técnico: para quien ve todo,
            // "lo que no es mío" sería la bandeja entera.
            ...(esTecnico
              ? [['cuadrilla', `De mi cuadrilla (${tickets.filter((t) => deQuien(t, perfil?.tecnico_id) === 'cuadrilla').length})`]]
              : []),
          ].map(([v, label]) => (
            <button
              key={v}
              onClick={() => setDeQuienVer(v)}
              className={`rounded-full border px-3 py-1.5 text-xs transition ${
                deQuienVer === v
                  ? 'border-violet-500/60 bg-violet-500/15 text-violet-200'
                  : 'border-slate-700 text-slate-400 hover:border-slate-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* "Asignado a": lo de una persona o una cuadrilla, para la oficina. */}
      {puede('soporte.ver') && (opcionesAsignado.tecnicos.length > 0 || opcionesAsignado.cuadrillas.length > 0) && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Asignado a</span>
          <div className="w-64">
            <Select value={asignadoA} onChange={(e) => setAsignadoA(e.target.value)}>
              <option value="todos">Todos</option>
              <option value="sin_asignar">Sin asignar</option>
              {opcionesAsignado.cuadrillas.length > 0 && (
                <optgroup label="Cuadrillas">
                  {opcionesAsignado.cuadrillas.map(([id, nombre]) => (
                    <option key={id} value={`c:${id}`}>
                      {nombre}
                    </option>
                  ))}
                </optgroup>
              )}
              {opcionesAsignado.tecnicos.length > 0 && (
                <optgroup label="Técnicos (a su nombre y de su cuadrilla)">
                  {opcionesAsignado.tecnicos.map(([id, nombre]) => (
                    <option key={id} value={`t:${id}`}>
                      {nombre}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </div>
        </div>
      )}

      {/* Filtros: en el celular se deslizan de costado en vez de apilarse. */}
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {[
          ['pendientes', 'Sin resolver'],
          ...Object.entries(ESTADOS).map(([k, v]) => [k, v.label]),
          ['todos', 'Todos'],
        ].map(([valor, label]) => (
          <button
            key={valor}
            onClick={() => setFiltro(valor)}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs transition ${
              filtro === valor
                ? 'border-sky-500/60 bg-sky-500/15 text-sky-200'
                : 'border-slate-700 text-slate-400 hover:border-slate-600'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Resueltos y cancelados: por fecha de cierre, y cuántos cerró cada uno. */}
      {verCerrados && !busqueda.trim() && (
        <Card>
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-slate-500">
                {filtro === 'resuelto' ? 'Resueltos desde' : 'Cancelados desde'}
                <Input
                  type="date"
                  value={rango.desde}
                  max={rango.hasta}
                  onChange={(e) => setRango((r) => ({ ...r, desde: e.target.value }))}
                  className="mt-1 w-40"
                />
              </label>
              <label className="text-xs text-slate-500">
                hasta
                <Input
                  type="date"
                  value={rango.hasta}
                  min={rango.desde}
                  onChange={(e) => setRango((r) => ({ ...r, hasta: e.target.value }))}
                  className="mt-1 w-40"
                />
              </label>
              <div className="flex flex-wrap gap-1.5">
                {ATAJOS.map(([k, label]) => {
                  const r = rangoRapido(k)
                  const activo = r.desde === rango.desde && r.hasta === rango.hasta
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setRango(r)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                        activo
                          ? 'border-sky-500/60 bg-sky-500/15 text-sky-200'
                          : 'border-slate-700 text-slate-400 hover:border-slate-600'
                      }`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>

            {porResponsable.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs text-slate-500">
                  {cerrados.length} {filtro === 'resuelto' ? 'resueltos' : 'cancelados'} en esas fechas · tocá uno para
                  ver solo los suyos
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {porResponsable.map((x) => (
                    <button
                      key={x.clave}
                      type="button"
                      onClick={() => setAsignadoA(asignadoA === x.clave ? 'todos' : x.clave)}
                      className={`rounded-lg border px-2.5 py-1.5 text-xs transition ${
                        asignadoA === x.clave
                          ? 'border-violet-500/60 bg-violet-500/15 text-violet-200'
                          : 'border-slate-700 text-slate-300 hover:border-slate-600'
                      }`}
                    >
                      {x.nombre} <b className="ml-1">{x.total}</b>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {cargando || (verCerrados && cargandoCerrados) ? (
        <p className="p-4 text-sm text-slate-500">Cargando tickets…</p>
      ) : visibles.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-slate-500">
            {busqueda.trim()
              ? `Ningún ticket coincide con "${busqueda.trim()}", ni abierto ni cerrado.`
              : verCerrados
                ? `No hay tickets ${filtro === 'resuelto' ? 'resueltos' : 'cancelados'} en esas fechas${asignadoA !== 'todos' ? ' para ese técnico o cuadrilla' : ''}.`
                : `No hay tickets ${filtro === 'pendientes' ? 'sin resolver' : 'en este estado'}.`}
          </p>
        </Card>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {visibles.map((t) => {
            const estado = ESTADOS[t.estado] ?? ESTADOS.abierto
            return (
              <li key={t.id}>
                <button
                  onClick={() => navegar(`/soporte/${t.id}`)}
                  className="w-full t-card-sm p-4 text-left transition hover:border-sky-500/50 hover:bg-[#F6F8FB]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-mono text-[11px] text-slate-500">
                        N° {t.codigo}
                        {t.tecnologia === 'ftth' ? (
                          <Waves size={12} className="text-sky-400" />
                        ) : (
                          <Radio size={12} className="text-violet-400" />
                        )}
                      </p>
                      <b className="block truncate text-slate-100">{t.nombre}</b>
                      <p className="truncate text-sm text-slate-400">
                        {etiquetaIncidencia(t.tipo_incidencia, t.incidencia_otro)}
                      </p>
                      {/* Sugerencia, no decisión: lo que suena a trámite
                          ("cambiar a $23.10") probablemente es un pendiente. */}
                      {!['resuelto', 'cancelado'].includes(t.estado) && pareceAdministrativo(t) && (
                        <p className="mt-0.5 text-[11px] text-violet-400">
                          ¿No es soporte? Abrilo y pasalo a Pendientes.
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] ${estado.clase}`}>
                        {estado.label}
                      </span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] ${PRIORIDADES[t.prioridad]?.clase ?? ''}`}
                      >
                        {PRIORIDADES[t.prioridad]?.label}
                      </span>
                    </div>
                  </div>

                  <p className="mt-2 truncate text-xs text-slate-500">
                    {[t.sector, t.direccion].filter(Boolean).join(' · ') || 'Sin dirección'}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                    {t.estado === 'resuelto' && t.cerrado_at ? (
                      <span className="text-emerald-400">
                        resuelto {fechaHoraCorta(t.cerrado_at)}
                        {t.minutos_en_sitio != null && ` · ${Math.round(t.minutos_en_sitio)} min en sitio`}
                      </span>
                    ) : t.estado === 'cancelado' ? (
                      <span className="text-rose-400">cancelado {fechaHoraCorta(t.updated_at)}</span>
                    ) : (
                      <span className="text-slate-500">{haceCuanto(t.horas_abierto)}</span>
                    )}
                    {t.tecnico || t.cuadrilla ? (
                      <span className="text-slate-400">→ {t.tecnico ?? t.cuadrilla}</span>
                    ) : (
                      <span className="text-amber-400">sin asignar</span>
                    )}
                    {t.visita_atrasada && (
                      <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-rose-300">
                        visita {fecha(t.fecha_visita)} vencida
                      </span>
                    )}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <Modal
        abierto={creando}
        titulo="Nuevo ticket de soporte"
        onCerrar={() => setCreando(false)}
        ancho="max-w-3xl"
      >
        <TicketForm
          onError={setError}
          onCancelar={() => setCreando(false)}
          onCreado={(t) => {
            setCreando(false)
            navegar(`/soporte/${t.id}`)
          }}
        />
      </Modal>
    </div>
  )
}
