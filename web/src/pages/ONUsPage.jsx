import { useState } from 'react'
import { useConfirmar } from '../lib/confirmar'
import { Plus, Radio, RefreshCw, Trash2 } from 'lucide-react'
import { useTabla } from '../lib/useTabla'
import { api } from '../lib/apiNetwork'
import SelectorOlt from '../components/olt/SelectorOlt'
import UnconfiguredONUs from '../components/olt/UnconfiguredONUs'
import ONUProvisionForm from '../components/onus/ONUProvisionForm'
import {
  Aviso,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  EstadoBadge,
  Modal,
  Table,
} from '../components/ui'

export default function ONUsPage() {
  const confirmar = useConfirmar()
  const { filas: olts, cargando: cargandoOlts } = useTabla('olts')
  const [oltId, setOltId] = useState('')
  const [ubicacion, setUbicacion] = useState({ frame: 0, slot: 0, puerto: 1 })

  const [onusEnOlt, setOnusEnOlt] = useState(null)
  const [leyendo, setLeyendo] = useState(false)
  const [error, setError] = useState(null)

  const [provisionando, setProvisionando] = useState(null) // null | {} | {sn, puerto...}

  const olt = olts.find((o) => o.id === oltId)

  async function leerOlt() {
    if (!olt) return
    setLeyendo(true)
    setError(null)
    try {
      setOnusEnOlt(await api.olt.onus(olt.id, ubicacion))
    } catch (err) {
      setError(err)
      setOnusEnOlt(null)
    } finally {
      setLeyendo(false)
    }
  }

  async function eliminar(onu) {
    const id = onu.ontId ?? onu.onuIndex
    if (!await confirmar(`¿Eliminar la ONU ${id} (${onu.sn || 's/n'}) de la OLT?`)) return
    try {
      await api.olt.eliminar(olt.id, id, ubicacion)
      await leerOlt()
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="t-titulo text-lg font-bold text-slate-100">ONUs</h1>
          <p className="text-xs text-slate-500">
            Descubrimiento, aprovisionamiento y baja de equipos de cliente
          </p>
        </div>
        <Button
          variante="primario"
          icon={Plus}
          disabled={!olt}
          onClick={() => setProvisionando({})}
        >
          Alta manual
        </Button>
      </div>

      <Card title="Ubicación en la fibra">
        {cargandoOlts ? (
          <Cargando />
        ) : olts.length === 0 ? (
          <Aviso tipo="alerta">
            No hay ninguna OLT cargada todavía. Registrá una en la sección <b>OLTs</b> para poder
            operar sobre ella.
          </Aviso>
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

      {olt && (
        <>
          <UnconfiguredONUs
            olt={olt}
            ubicacion={ubicacion}
            onRegistrar={(onu) => setProvisionando(onu)}
          />

          <Card
            title="ONUs registradas en el puerto"
            subtitle={`${olt.nombre} · puerto ${ubicacion.puerto}`}
            icon={Radio}
            actions={
              <Button icon={RefreshCw} onClick={leerOlt} cargando={leyendo}>
                Leer de la OLT
              </Button>
            }
          >
            {leyendo ? (
              <Cargando texto="Consultando la OLT…" />
            ) : onusEnOlt === null ? (
              <p className="py-6 text-center text-sm text-slate-500">
                Pulsá “Leer de la OLT” para traer el estado real del puerto.
              </p>
            ) : (
              <Table
                columnas={['ID', 'SN', 'Estado', 'Descripción / Modelo', '']}
                filas={onusEnOlt}
                vacio="El puerto no tiene ONUs registradas."
                renderFila={(onu, i) => (
                  <tr key={`${onu.sn ?? 'sn'}-${i}`} className="text-slate-300">
                    <td className="px-3 py-2 font-medium text-slate-100">
                      {onu.ontId ?? onu.onuIndex}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{onu.sn || '—'}</td>
                    <td className="px-3 py-2">
                      <EstadoBadge estado={onu.estado ?? onu.runState ?? onu.phaseState} />
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-400">
                      {onu.descripcion || onu.modelo || '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button variante="fantasma" icon={Trash2} onClick={() => eliminar(onu)} />
                    </td>
                  </tr>
                )}
              />
            )}
          </Card>
        </>
      )}

      <Modal
        abierto={provisionando !== null}
        titulo="Aprovisionar ONU"
        onCerrar={() => setProvisionando(null)}
        ancho="max-w-2xl"
      >
        {olt && (
          <ONUProvisionForm
            olt={olt}
            ubicacion={ubicacion}
            onuDetectada={provisionando}
            onListo={leerOlt}
            onCancelar={() => setProvisionando(null)}
          />
        )}
      </Modal>
    </div>
  )
}
