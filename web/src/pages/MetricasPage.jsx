import { useState } from 'react'
import { RefreshCw, Waves } from 'lucide-react'
import { useTabla } from '../lib/useTabla'
import { api } from '../lib/apiNetwork'
import SelectorOlt from '../components/olt/SelectorOlt'
import ONUStatsCard from '../components/olt/ONUStatsCard'
import { Aviso, Button, Card, Cargando, ErrorBanner, EstadoBadge, Table } from '../components/ui'

/** Fase 4 del taller: potencia óptica en vivo y alerta por señal baja. */
export default function MetricasPage() {
  const { filas: olts, cargando: cargandoOlts } = useTabla('olts')
  const [oltId, setOltId] = useState('')
  const [ubicacion, setUbicacion] = useState({ frame: 0, slot: 0, puerto: 1 })
  const [onus, setOnus] = useState(null)
  const [seleccionada, setSeleccionada] = useState(null)
  const [leyendo, setLeyendo] = useState(false)
  const [error, setError] = useState(null)

  const olt = olts.find((o) => o.id === oltId)

  async function leerOnus() {
    if (!olt) return
    setLeyendo(true)
    setError(null)
    setSeleccionada(null)
    try {
      setOnus(await api.olt.onus(olt.id, ubicacion))
    } catch (err) {
      setError(err)
      setOnus(null)
    } finally {
      setLeyendo(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-100">Métricas ópticas</h1>
        <p className="text-xs text-slate-500">
          Potencia Rx/Tx, distancia y alerta de señal baja por debajo de -27 dBm
        </p>
      </div>

      <Card
        title="Puerto a monitorear"
        actions={
          <Button icon={RefreshCw} onClick={leerOnus} cargando={leyendo} disabled={!olt}>
            Leer ONUs
          </Button>
        }
      >
        {cargandoOlts ? (
          <Cargando />
        ) : olts.length === 0 ? (
          <Aviso tipo="alerta">Registrá una OLT primero para poder leer métricas.</Aviso>
        ) : (
          <SelectorOlt
            olts={olts}
            oltId={oltId}
            onOltId={setOltId}
            ubicacion={ubicacion}
            onUbicacion={setUbicacion}
          />
        )}
      </Card>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {onus && (
        <Card title="ONUs del puerto" icon={Waves}>
          <Table
            columnas={['ID', 'SN', 'Estado', '']}
            filas={onus}
            vacio="El puerto no tiene ONUs registradas."
            renderFila={(onu, i) => {
              const id = onu.ontId ?? onu.onuIndex
              return (
                <tr key={`${id}-${i}`} className="text-slate-300">
                  <td className="px-3 py-2 font-medium text-slate-100">{id}</td>
                  <td className="px-3 py-2 font-mono text-xs">{onu.sn || '—'}</td>
                  <td className="px-3 py-2">
                    <EstadoBadge estado={onu.estado ?? onu.runState} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variante={seleccionada?.id === id ? 'primario' : 'secundario'}
                      onClick={() => setSeleccionada({ id, sn: onu.sn })}
                    >
                      Ver señal
                    </Button>
                  </td>
                </tr>
              )
            }}
          />
        </Card>
      )}

      {seleccionada && olt && (
        <ONUStatsCard
          key={`${olt.id}-${ubicacion.puerto}-${seleccionada.id}`}
          olt={olt}
          ubicacion={ubicacion}
          onuId={seleccionada.id}
          etiqueta={`${olt.nombre} · puerto ${ubicacion.puerto} · SN ${seleccionada.sn || 's/n'}`}
        />
      )}
    </div>
  )
}
