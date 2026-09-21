import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, Link2, Radio, RefreshCw, Search, Settings2, UserX } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { dbm, nivel } from '../../lib/optica'
import ImportarOnus from './ImportarOnus'
import EnlazarAbonados from './EnlazarAbonados'
import AccionesOnu from './AccionesOnu'
import { Badge, Button, Card, ErrorBanner, Input, Modal, Select, SkeletonTabla, Table } from '../ui'

/**
 * Las ONUs de esta OLT, con su abonado.
 *
 * Contesta las dos preguntas que antes había que cruzar a mano: de qué abonado
 * es esta señal baja, y qué ONTs están dando servicio a alguien que no está en
 * el sistema —o sea, servicio dado y nadie a quien facturarle.
 */

const FILTROS = {
  todas: { label: 'Todas', prueba: () => true },
  sin_abonado: { label: 'Sin abonado', prueba: (o) => o.sin_abonado },
  senal_baja: { label: 'Señal baja', prueba: (o) => o.senal_baja },
  caidas: { label: 'Caídas', prueba: (o) => o.onu_estado !== 'online' },
  sin_plan: { label: 'Sin plan', prueba: (o) => o.client_id && !o.plan_id },
}

export default function OltOnus({ olt }) {
  const [filas, setFilas] = useState(null)
  const [error, setError] = useState(null)
  const [busqueda, setBusqueda] = useState('')
  const [filtro, setFiltro] = useState('todas')
  const [asistente, setAsistente] = useState(null)
  const [acciones, setAcciones] = useState(null)
  const [planes, setPlanes] = useState([])

  const cargar = useCallback(async () => {
    // Los planes se traen junto con las ONUs: los necesita el panel de acciones
    // y pedirlos al abrirlo agregaría una espera en cada clic.
    supabase
      .from('planes_velocidad')
      .select('*')
      .order('bajada_kbps')
      .then(({ data }) => setPlanes(data ?? []))

    const { data, error: err } = await supabase
      .from('v_onus_clientes')
      .select('*')
      .eq('olt_id', olt.id)
      .order('slot')
      .order('puerto')
      .order('onu_index')

    if (err) {
      // La vista llega con la migración 39. Decirlo así evita que parezca que
      // no hay ONUs cuando lo que falta es la vista.
      if (err.code === '42P01') {
        setError({
          message: 'Falta la vista v_onus_clientes',
          hint: 'Corré supabase/migracion-39-clientes-desde-onu.sql en el SQL Editor.',
        })
      } else setError(err)
      setFilas([])
      return
    }
    setFilas(data ?? [])
  }, [olt.id])

  useEffect(() => {
    cargar()
  }, [cargar])

  const visibles = useMemo(() => {
    if (!filas) return []
    const q = busqueda.trim().toUpperCase()
    return filas.filter((o) => {
      if (!FILTROS[filtro].prueba(o)) return false
      if (!q) return true
      return [o.sn, o.cliente, o.nombre_en_la_olt, `${o.slot}/${o.puerto}/${o.onu_index}`]
        .filter(Boolean)
        .some((v) => String(v).toUpperCase().includes(q))
    })
  }, [filas, busqueda, filtro])

  const cuenta = (clave) => (filas ?? []).filter(FILTROS[clave].prueba).length

  return (
    <>
      <Card
        title="ONUs y abonados"
        subtitle={
          filas
            ? `${filas.length} registradas · ${cuenta('sin_abonado')} sin abonado · ${cuenta('senal_baja')} con señal baja`
            : olt.nombre
        }
        icon={Radio}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button icon={RefreshCw} onClick={cargar} />
            <Button icon={Link2} onClick={() => setAsistente('abonados')}>
              Enlazar abonados
            </Button>
            <Button variante="primario" icon={Download} onClick={() => setAsistente('importar')}>
              Importar del equipo
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <ErrorBanner error={error} onCerrar={() => setError(null)} />

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
              <Input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Serie, abonado o ubicación…"
                className="pl-9"
              />
            </div>
            <Select value={filtro} onChange={(e) => setFiltro(e.target.value)} className="w-auto">
              {Object.entries(FILTROS).map(([clave, f]) => (
                <option key={clave} value={clave}>
                  {f.label} ({cuenta(clave)})
                </option>
              ))}
            </Select>
          </div>

          {!filas ? (
            <SkeletonTabla filas={6} columnas={6} />
          ) : (
            <Table
              columnas={['Ubicación', 'Serie', 'Abonado', 'Plan', 'Señal', 'Estado', '']}
              filas={visibles}
              vacio={
                filas.length === 0
                  ? 'Esta OLT no tiene ONUs en el sistema. Usá «Importar del equipo».'
                  : 'Ninguna coincide con el filtro.'
              }
              renderFila={(o) => {
                const n = nivel(o.rx_power_dbm)
                return (
                  <tr key={o.onu_id} className={o.sin_abonado ? 'bg-sky-500/[0.04]' : ''}>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">
                      {o.slot}/{o.puerto}/{o.onu_index}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-300">{o.sn}</td>

                    <td className="px-3 py-2">
                      {o.client_id ? (
                        <Link
                          to={`/clientes/${o.client_id}`}
                          className="text-slate-100 hover:text-sky-300"
                        >
                          {o.cliente}
                        </Link>
                      ) : (
                        <span className="flex items-center gap-1.5">
                          <UserX size={13} className="text-sky-400/70" />
                          <span className="text-xs text-slate-400">{o.nombre_en_la_olt ?? '—'}</span>
                          <Badge color="azul">sin ficha</Badge>
                        </span>
                      )}
                    </td>

                    <td className="px-3 py-2 text-xs">
                      {o.plan ? (
                        <span className="text-slate-300">{o.plan}</span>
                      ) : o.client_id ? (
                        <Badge color="ambar">sin plan</Badge>
                      ) : (
                        <span className="text-slate-700">—</span>
                      )}
                    </td>

                    <td className="px-3 py-2">
                      <span
                        title={n.ayuda}
                        className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs ${n.clase}`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${n.punto}`} />
                        {dbm(o.rx_power_dbm)}
                      </span>
                      {o.distancia_m != null && (
                        <span className="ml-2 text-[10px] text-slate-600">{o.distancia_m} m</span>
                      )}
                    </td>

                    <td className="px-3 py-2">
                      <Badge
                        color={
                          o.onu_estado === 'online'
                            ? 'verde'
                            : o.onu_estado === 'unknown'
                              ? 'ambar'
                              : 'gris'
                        }
                      >
                        {/* "unknown" es como queda una ONT suspendida a mano.
                            Mostrarlo tal cual no le dice nada a nadie. */}
                        {o.onu_estado === 'unknown' ? 'suspendida' : o.onu_estado}
                      </Badge>
                    </td>

                    <td className="px-3 py-2 text-right">
                      <Button
                        variante="fantasma"
                        icon={Settings2}
                        title="Cambiar plan, suspender o dar de baja"
                        onClick={() => setAcciones(o)}
                      />
                    </td>
                  </tr>
                )
              }}
            />
          )}

          {filas?.some((o) => o.sin_abonado) && (
            <p className="text-[11px] leading-relaxed text-slate-500">
              Las filas resaltadas tienen servicio dado pero ninguna ficha de abonado: nadie a quien
              facturarle. Se resuelven con <b className="text-slate-400">Enlazar abonados</b>.
            </p>
          )}
        </div>
      </Card>

      <Modal
        abierto={asistente === 'importar'}
        titulo={`Importar ONUs de ${olt.nombre}`}
        onCerrar={() => setAsistente(null)}
        ancho="max-w-5xl"
      >
        <ImportarOnus olt={olt} onListo={cargar} />
      </Modal>

      <Modal
        abierto={asistente === 'abonados'}
        titulo="Enlazar ONTs con abonados"
        onCerrar={() => setAsistente(null)}
        ancho="max-w-5xl"
      >
        <EnlazarAbonados olt={olt} onListo={cargar} />
      </Modal>

      <Modal
        abierto={acciones !== null}
        titulo={`ONT ${acciones?.sn ?? ''}`}
        onCerrar={() => setAcciones(null)}
        ancho="max-w-2xl"
      >
        {acciones && (
          <AccionesOnu
            olt={olt}
            onu={acciones}
            planes={planes}
            onListo={cargar}
            onCerrar={() => setAcciones(null)}
          />
        )}
      </Modal>
    </>
  )
}
