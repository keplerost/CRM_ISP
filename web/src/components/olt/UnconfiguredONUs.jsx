import { useState } from 'react'
import { RefreshCw, Search, Zap } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Button, Card, Cargando, ErrorBanner, Table } from '../ui'

/**
 * ONUs detectadas por la OLT que todavía no están registradas (autofind).
 *
 * Si no se indica puerto, el middleware barre todos los puertos del slot — es lo
 * más cómodo en el taller, donde no sabés de antemano en qué puerto conectaron la ONT.
 */
export default function UnconfiguredONUs({ olt, ubicacion, onRegistrar }) {
  const [onus, setOnus] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState(null)

  async function buscar({ todosLosPuertos = false } = {}) {
    if (!olt) return
    setCargando(true)
    setError(null)
    try {
      const resultado = await api.olt.autofind(olt.id, {
        frame: ubicacion.frame,
        slot: ubicacion.slot,
        puerto: todosLosPuertos ? undefined : ubicacion.puerto,
        puertos: todosLosPuertos ? 8 : undefined,
      })
      setOnus(resultado)
    } catch (err) {
      setError(err)
      setOnus(null)
    } finally {
      setCargando(false)
    }
  }

  return (
    <Card
      title="ONUs sin configurar (autofind)"
      subtitle="Equipos que la OLT ve en la fibra pero que todavía no están dados de alta"
      icon={Search}
      actions={
        <>
          <Button icon={RefreshCw} onClick={() => buscar()} cargando={cargando} disabled={!olt}>
            Escanear puerto {ubicacion.puerto}
          </Button>
          <Button
            variante="fantasma"
            onClick={() => buscar({ todosLosPuertos: true })}
            disabled={!olt || cargando}
          >
            Todos los puertos
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {cargando && <Cargando texto="Consultando la OLT…" />}

        {!cargando && onus === null && (
          <p className="py-6 text-center text-sm text-slate-500">
            Escaneá para ver las ONUs pendientes de registro.
          </p>
        )}

        {!cargando && onus?.length === 0 && (
          <Aviso>
            La OLT no reporta ninguna ONU sin registrar. Si acabás de conectar una, esperá unos
            segundos y volvé a escanear.
          </Aviso>
        )}

        {!cargando && onus?.length > 0 && (
          <Table
            columnas={['SN', 'Modelo', 'Puerto', 'Vendor', '']}
            filas={onus}
            renderFila={(onu, i) => (
              <tr key={`${onu.sn}-${i}`} className="text-slate-300">
                <td className="px-3 py-2 font-mono text-xs text-slate-100">{onu.sn}</td>
                <td className="px-3 py-2">{onu.equipmentId || onu.modelo || '—'}</td>
                <td className="px-3 py-2">{onu.puerto ?? '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{onu.vendorId || '—'}</td>
                <td className="px-3 py-2 text-right">
                  <Button variante="primario" icon={Zap} onClick={() => onRegistrar(onu)}>
                    Registrar
                  </Button>
                </td>
              </tr>
            )}
          />
        )}
      </div>
    </Card>
  )
}
