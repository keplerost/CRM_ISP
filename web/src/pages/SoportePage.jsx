import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, LifeBuoy, Plus, Radio, Waves } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { Button, Card, ErrorBanner, Modal, Stat } from '../components/ui'
import TicketForm from '../components/soporte/TicketForm'
import ConPermiso from '../components/layout/ConPermiso'
import { usePermisos } from '../lib/AuthContext'

// Un id que no existe. Sirve para que el filtro por técnico no traiga nada
// cuando el usuario no tiene técnico vinculado: sin esto, `.eq('tecnico_id',
// undefined)` desaparece de la consulta y devuelve la bandeja completa —el
// error se ve como que funciona, que es la peor forma de fallar.
const NADIE = '00000000-0000-0000-0000-000000000000'
import {
  ESTADOS,
  PRIORIDADES,
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
  const { puede, perfil } = usePermisos()

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
    if (!puede('soporte.ver')) consulta = consulta.eq('tecnico_id', perfil?.tecnico_id ?? NADIE)

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

  const visibles = useMemo(() => {
    const abiertos = (t) => !['resuelto', 'cancelado'].includes(t.estado)

    const filtrados = tickets.filter((t) => {
      if (filtro === 'pendientes') return abiertos(t)
      if (filtro === 'todos') return true
      return t.estado === filtro
    })

    return filtrados.sort(
      (a, b) =>
        Number(b.visita_atrasada) - Number(a.visita_atrasada) ||
        (PESO_PRIORIDAD[a.prioridad] ?? 9) - (PESO_PRIORIDAD[b.prioridad] ?? 9) ||
        Number(b.horas_abierto) - Number(a.horas_abierto),
    )
  }, [tickets, filtro])

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

      {cargando ? (
        <p className="p-4 text-sm text-slate-500">Cargando tickets…</p>
      ) : visibles.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-slate-500">
            No hay tickets {filtro === 'pendientes' ? 'sin resolver' : 'en este estado'}.
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
                        {etiquetaIncidencia(t.tipo_incidencia)}
                      </p>
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
                    <span className="text-slate-500">{haceCuanto(t.horas_abierto)}</span>
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
