import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { Archive, Download, Eye, Trash2 } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { descargar } from '../../lib/olts'
import { Aviso, Button, Card, ErrorBanner, Modal, SkeletonTabla, Table } from '../ui'

/**
 * Respaldos de configuración.
 *
 * El respaldo se baja pidiéndole la configuración corriente al equipo. Si la
 * salida quedó cortada por el prompt de paginación se guarda igual pero marcada
 * como parcial: un respaldo incompleto que se cree completo es peor que no
 * tenerlo, porque se descubre el día que hay que restaurar.
 */
export default function OltBackups({ olt }) {
  const confirmar = useConfirmar()
  const [backups, setBackups] = useState(null)
  const [error, setError] = useState(null)
  const [tomando, setTomando] = useState(false)
  const [aviso, setAviso] = useState(null)
  const [viendo, setViendo] = useState(null)

  const cargar = useCallback(async () => {
    try {
      const r = await api.olt.backups(olt.id)
      setBackups(r.backups ?? [])
    } catch (err) {
      setError(err)
      setBackups([])
    }
  }, [olt.id])

  useEffect(() => {
    cargar()
  }, [cargar])

  async function tomar() {
    setTomando(true)
    setError(null)
    setAviso(null)
    try {
      const r = await api.olt.respaldar(olt.id)
      setAviso(
        r.truncado
          ? `Se guardó "${r.nombre}", pero ${r.aviso}`
          : `Respaldo guardado: ${r.lineas} líneas leídas con "${r.comando}".`,
      )
      await cargar()
    } catch (err) {
      setError(err)
    } finally {
      setTomando(false)
    }
  }

  async function ver(b) {
    setError(null)
    try {
      setViendo(await api.olt.verBackup(olt.id, b.id))
    } catch (err) {
      setError(err)
    }
  }

  async function bajar(b) {
    try {
      const completo = await api.olt.verBackup(olt.id, b.id)
      const nombre = `${b.nombre.replace(/[^\w.-]+/g, '_')}.txt`
      descargar(nombre, completo.contenido, 'text/plain;charset=utf-8')
    } catch (err) {
      setError(err)
    }
  }

  async function borrar(b) {
    if (!await confirmar(`¿Eliminar el respaldo "${b.nombre}"?`)) return
    try {
      await api.olt.borrarBackup(olt.id, b.id)
      await cargar()
    } catch (err) {
      setError(err)
    }
  }

  const kb = (bytes) => (bytes ? `${(bytes / 1024).toFixed(1)} KB` : '—')
  const cuando = (iso) => new Date(iso).toLocaleString('es-EC')

  return (
    <>
      <Card
        title="Respaldos de configuración"
        subtitle={backups ? `${backups.length} guardados` : olt.ip_host}
        icon={Archive}
        actions={
          <Button variante="primario" icon={Archive} onClick={tomar} cargando={tomando}>
            Respaldar ahora
          </Button>
        }
      >
        <div className="space-y-4">
          <ErrorBanner error={error} onCerrar={() => setError(null)} />
          {aviso && <Aviso>{aviso}</Aviso>}

          {!backups ? (
            <SkeletonTabla filas={3} columnas={4} />
          ) : (
            <Table
              columnas={['Nombre', 'Comando', 'Tamaño', 'Quién', 'Cuándo', '']}
              filas={backups}
              vacio="Todavía no hay respaldos de este equipo."
              renderFila={(b) => (
                <tr key={b.id} className="text-slate-300">
                  <td className="px-3 py-2 font-medium text-slate-100">{b.nombre}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-500">{b.comando}</td>
                  <td className="px-3 py-2 text-xs">{kb(b.bytes)}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{b.quien ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{cuando(b.created_at)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button variante="fantasma" icon={Eye} title="Ver" onClick={() => ver(b)} />
                      <Button
                        variante="fantasma"
                        icon={Download}
                        title="Descargar"
                        onClick={() => bajar(b)}
                      />
                      <Button
                        variante="fantasma"
                        icon={Trash2}
                        title="Eliminar"
                        className="text-red-400 hover:bg-red-500/10"
                        onClick={() => borrar(b)}
                      />
                    </div>
                  </td>
                </tr>
              )}
            />
          )}
        </div>
      </Card>

      <Modal
        abierto={viendo !== null}
        titulo={viendo?.nombre ?? ''}
        onCerrar={() => setViendo(null)}
        ancho="max-w-4xl"
      >
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-slate-400">
          {viendo?.contenido}
        </pre>
      </Modal>
    </>
  )
}
