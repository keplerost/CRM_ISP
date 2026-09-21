import { useState } from 'react'
import { Activity, AlertTriangle, Ruler, Waves } from 'lucide-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api } from '../../lib/apiNetwork'
import { Aviso, Button, Card, ErrorBanner, Stat } from '../ui'

/** Umbral de alerta del taller: por debajo de esto la señal se considera baja. */
export const UMBRAL_RX_DBM = -27

/**
 * Señal óptica de una ONU.
 *
 * La lectura es OMCI en vivo: si la ONU está offline la OLT no puede responderla.
 * Por eso el estado "sin datos" se explica en vez de mostrar un cero engañoso.
 */
export default function ONUStatsCard({ olt, ubicacion, onuId, etiqueta }) {
  const [metricas, setMetricas] = useState(null)
  const [historial, setHistorial] = useState([])
  const [leyendo, setLeyendo] = useState(false)
  const [error, setError] = useState(null)

  async function leer() {
    setLeyendo(true)
    setError(null)
    try {
      const r = await api.olt.metricas(olt.id, onuId, ubicacion)
      setMetricas(r)
      if (r.rxPowerDbm != null) {
        setHistorial((h) =>
          [...h, { hora: new Date().toLocaleTimeString('es', { timeStyle: 'medium' }), rx: r.rxPowerDbm }].slice(-20),
        )
      }
    } catch (err) {
      setError(err)
      setMetricas(null)
    } finally {
      setLeyendo(false)
    }
  }

  const alerta = metricas?.rxPowerDbm != null && metricas.rxPowerDbm < UMBRAL_RX_DBM

  return (
    <Card
      title={`Señal óptica — ONU ${onuId}`}
      subtitle={etiqueta}
      icon={Waves}
      actions={
        <Button icon={Activity} onClick={leer} cargando={leyendo}>
          Leer ahora
        </Button>
      }
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {!metricas && !error && (
          <p className="py-6 text-center text-sm text-slate-500">
            Pulsá “Leer ahora” para consultar la potencia óptica en vivo.
          </p>
        )}

        {metricas && !metricas.online && (
          <Aviso tipo="alerta">
            {metricas.mensaje ||
              'La ONU no está online. La potencia óptica se lee por OMCI contra el equipo del cliente, así que no hay dato disponible.'}
          </Aviso>
        )}

        {metricas?.online && (
          <>
            {alerta && (
              <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                <AlertTriangle size={16} />
                Señal baja: <b>{metricas.rxPowerDbm} dBm</b> está por debajo del umbral de{' '}
                {UMBRAL_RX_DBM} dBm.
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Rx power"
                valor={metricas.rxPowerDbm != null ? `${metricas.rxPowerDbm} dBm` : '—'}
                sub={`umbral ${UMBRAL_RX_DBM} dBm`}
                icon={Waves}
                color={alerta ? 'text-red-400' : 'text-emerald-400'}
              />
              <Stat
                label="Tx power"
                valor={metricas.txPowerDbm != null ? `${metricas.txPowerDbm} dBm` : '—'}
                icon={Waves}
              />
              <Stat
                label="Distancia"
                valor={metricas.distanciaM != null ? `${metricas.distanciaM} m` : '—'}
                icon={Ruler}
              />
              <Stat
                label="Temperatura"
                valor={metricas.temperaturaC != null ? `${metricas.temperaturaC} °C` : '—'}
                icon={Activity}
              />
            </div>

            {historial.length > 1 && (
              <div className="h-48 t-panel p-3">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={historial}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="hora" tick={{ fill: '#64748b', fontSize: 10 }} />
                    <YAxis
                      tick={{ fill: '#64748b', fontSize: 10 }}
                      domain={['dataMin - 2', 'dataMax + 2']}
                      unit=" dBm"
                      width={64}
                    />
                    <Tooltip
                      contentStyle={{
                        background: '#0f172a',
                        border: '1px solid #1e293b',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <ReferenceLine y={UMBRAL_RX_DBM} stroke="#ef4444" strokeDasharray="4 4" />
                    <Line
                      type="monotone"
                      dataKey="rx"
                      stroke="#38bdf8"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      name="Rx"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  )
}
