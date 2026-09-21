import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Gauge, Layers, Upload } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import OltRelevamiento from './OltRelevamiento'
import { Aviso, Badge, Button, Card, ErrorBanner, SkeletonTabla, Table } from '../ui'

/**
 * Perfiles de tráfico de esta OLT.
 *
 * Muestra dos cosas que el sistema sí conoce —los line profiles y los planes con
 * su índice de traffic table— y deja abajo el relevamiento para lo que todavía
 * no sabe leer del equipo.
 *
 * Lo que la pantalla no puede afirmar es que lo de la base esté aplicado en el
 * equipo: son dos verdades distintas y confundirlas es cómo se llega a un
 * abonado con la velocidad de otro plan. Por eso el índice se muestra como "lo
 * que se le va a mandar", no como "lo que tiene".
 */
export default function OltPerfiles({ olt }) {
  const [perfiles, setPerfiles] = useState(null)
  const [planes, setPlanes] = useState([])
  const [error, setError] = useState(null)
  const [aplicando, setAplicando] = useState(null)
  const [resultado, setResultado] = useState(null)

  const cargar = useCallback(async () => {
    const [rPerfiles, rPlanes] = await Promise.all([
      supabase.from('line_profiles').select('*').eq('olt_id', olt.id).order('nombre'),
      supabase.from('planes_velocidad').select('*').order('bajada_kbps', { ascending: true }),
    ])
    if (rPerfiles.error) return setError(rPerfiles.error)
    if (rPlanes.error) return setError(rPlanes.error)
    setPerfiles(rPerfiles.data ?? [])
    setPlanes(rPlanes.data ?? [])
  }, [olt.id])

  useEffect(() => {
    cargar()
  }, [cargar])

  async function aplicar(plan) {
    setAplicando(plan.id)
    setError(null)
    setResultado(null)
    try {
      const r = await api.olt.aplicarPlan(olt.id, { plan_id: plan.id })
      setResultado(`Traffic table ${r.plan} aplicada en ${olt.nombre}.`)
      await cargar()
    } catch (err) {
      setError(err)
    } finally {
      setAplicando(null)
    }
  }

  const mbps = (kbps) => (kbps ? `${Math.round(kbps / 1000)} Mbps` : '—')

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />
      {resultado && <Aviso>{resultado}</Aviso>}

      <Card
        title="Line profiles"
        subtitle="La VLAN que la OLT etiqueta para cada ONT"
        icon={Layers}
        actions={
          <Link to="/perfiles">
            <Button>Administrar perfiles</Button>
          </Link>
        }
      >
        {!perfiles ? (
          <SkeletonTabla filas={3} columnas={4} />
        ) : (
          <Table
            columnas={['Nombre', 'VLAN', 'GEM port', 'ID dentro del equipo']}
            filas={perfiles}
            vacio="Esta OLT no tiene line profiles registrados en el sistema."
            renderFila={(p) => (
              <tr key={p.id} className="text-slate-300">
                <td className="px-3 py-2 font-medium text-slate-100">{p.nombre}</td>
                <td className="px-3 py-2">{p.vlan_id}</td>
                <td className="px-3 py-2">{p.gemport_id}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">{p.profile_id_olt}</td>
              </tr>
            )}
          />
        )}
      </Card>

      <Card
        title="Planes y traffic tables"
        subtitle="El ancho de banda del lado de la OLT. El índice es la posición donde vive dentro del equipo."
        icon={Gauge}
        actions={
          <Link to="/servicios/planes">
            <Button>Administrar planes</Button>
          </Link>
        }
      >
        <div className="space-y-3">
          <Table
            columnas={['Plan', 'Bajada', 'Subida', 'Índice', '']}
            filas={planes}
            vacio="No hay planes cargados."
            renderFila={(p) => (
              <tr key={p.id} className="text-slate-300">
                <td className="px-3 py-2 font-medium text-slate-100">{p.nombre}</td>
                <td className="px-3 py-2">{mbps(p.bajada_kbps)}</td>
                <td className="px-3 py-2">{mbps(p.subida_kbps)}</td>
                <td className="px-3 py-2">
                  {p.traffic_table_index != null ? (
                    <span className="font-mono text-xs">{p.traffic_table_index}</span>
                  ) : (
                    <Badge color="ambar">sin índice</Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    icon={Upload}
                    cargando={aplicando === p.id}
                    disabled={p.traffic_table_index == null}
                    title={
                      p.traffic_table_index == null
                        ? 'Sin índice no se puede aplicar: es la posición dentro del equipo.'
                        : `Escribe la traffic table ${p.traffic_table_index} en ${olt.nombre}`
                    }
                    onClick={() => aplicar(p)}
                  >
                    Aplicar
                  </Button>
                </td>
              </tr>
            )}
          />

          <Aviso tipo="alerta">
            Esta tabla dice lo que el sistema <b>va a mandar</b>, no lo que el equipo tiene hoy.
            Para ver lo que hay realmente configurado, usá el relevamiento de abajo.
          </Aviso>
        </div>
      </Card>

      <OltRelevamiento
        olt={olt}
        area="perfiles"
        titulo="Leer los perfiles del equipo"
        ayuda="Traffic tables, DBA y line profiles tal como están hoy en la OLT."
      />
    </div>
  )
}
