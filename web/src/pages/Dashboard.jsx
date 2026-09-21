import { AlertTriangle, Network, Radio, Router as RouterIcon, Waves } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTabla } from '../lib/useTabla'
import { UMBRAL_RX_DBM } from '../components/olt/ONUStatsCard'
import { Aviso, Badge, Card, Cargando, ErrorBanner, Stat, Table } from '../components/ui'
import ResumenAreas from '../components/layout/ResumenAreas'

export default function Dashboard() {
  const { filas: olts, cargando: c1, error: e1 } = useTabla('olts')
  const { filas: routers, cargando: c2 } = useTabla('routers_mikrotik')
  const { filas: onus, cargando: c3 } = useTabla('onus')
  const { filas: planes } = useTabla('planes_velocidad')

  const cargando = c1 || c2 || c3

  const online = onus.filter((o) => o.estado === 'online').length
  const conAlerta = onus.filter((o) => o.rx_power_dbm != null && o.rx_power_dbm < UMBRAL_RX_DBM)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="t-titulo text-lg font-bold text-slate-100">Dashboard</h1>
        <p className="text-xs text-slate-500">Resumen de la red</p>
      </div>

      <ErrorBanner error={e1} />

      {/* Las dos áreas antes que la red.
          Quien abre esta pantalla dirige: primero quiere saber si hay algo raro
          en ventas o en campo, y recién después mirar equipos. Va arriba y no
          se espera a que carguen las OLTs — son consultas distintas y una lenta
          no tiene por qué tapar a la otra. */}
      <ResumenAreas />

      {cargando ? (
        <Cargando />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="OLTs" valor={olts.length} icon={Network} />
            <Stat label="Routers MikroTik" valor={routers.length} icon={RouterIcon} />
            <Stat
              label="ONUs registradas"
              valor={onus.length}
              sub={`${online} online`}
              icon={Radio}
            />
            <Stat
              label="Señal baja"
              valor={conAlerta.length}
              sub={`bajo ${UMBRAL_RX_DBM} dBm`}
              icon={Waves}
              color={conAlerta.length ? 'text-red-400' : 'text-emerald-400'}
            />
          </div>

          {olts.length === 0 && (
            <Aviso>
              Todavía no hay equipos cargados. Empezá registrando una OLT en{' '}
              <Link to="/olts" className="underline">
                OLTs
              </Link>{' '}
              o un router en{' '}
              <Link to="/red/routers" className="underline">
                Routers MikroTik
              </Link>
              .
            </Aviso>
          )}

          {conAlerta.length > 0 && (
            <Card
              title="ONUs con señal baja"
              subtitle={`Potencia Rx por debajo de ${UMBRAL_RX_DBM} dBm en la última lectura`}
              icon={AlertTriangle}
            >
              <Table
                columnas={['Cliente', 'SN', 'Puerto', 'Rx', 'Última lectura']}
                filas={conAlerta}
                renderFila={(o) => (
                  <tr key={o.id} className="text-slate-300">
                    <td className="px-3 py-2 text-slate-100">{o.nombre_cliente || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{o.sn}</td>
                    <td className="px-3 py-2">{o.puerto}</td>
                    <td className="px-3 py-2">
                      <Badge color="rojo">{o.rx_power_dbm} dBm</Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {o.ultima_lectura ? new Date(o.ultima_lectura).toLocaleString('es') : '—'}
                    </td>
                  </tr>
                )}
              />
            </Card>
          )}

          <Card title="Últimas ONUs registradas" icon={Radio}>
            <Table
              columnas={['Cliente', 'SN', 'Ubicación', 'Plan', 'Estado']}
              filas={onus.slice(0, 10)}
              vacio="Todavía no se aprovisionó ninguna ONU."
              renderFila={(o) => (
                <tr key={o.id} className="text-slate-300">
                  <td className="px-3 py-2 text-slate-100">{o.nombre_cliente || '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{o.sn}</td>
                  <td className="px-3 py-2 text-xs">
                    {o.frame}/{o.slot}/{o.puerto} · ONT {o.onu_index}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-400">{o.plan_velocidad || '—'}</td>
                  <td className="px-3 py-2">
                    <Badge color={o.estado === 'online' ? 'verde' : 'gris'}>{o.estado}</Badge>
                  </td>
                </tr>
              )}
            />
          </Card>

          <Card title="Planes cargados">
            <div className="flex flex-wrap gap-2">
              {planes.length === 0 ? (
                <p className="text-sm text-slate-500">Sin planes definidos.</p>
              ) : (
                planes.map((p) => (
                  <Badge key={p.id} color="azul">
                    {p.nombre} — {p.bajada_kbps / 1000}/{p.subida_kbps / 1000} Mbps
                  </Badge>
                ))
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
