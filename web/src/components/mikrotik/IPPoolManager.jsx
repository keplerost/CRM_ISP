import { useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { Boxes, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Button, Card, Cargando, ErrorBanner, Field, Input, Table } from '../ui'

/** IP Pools del router (Fase 2 del taller: crear un pool desde la web). */
export default function IPPoolManager({ router }) {
  const confirmar = useConfirmar()
  const [pools, setPools] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState(null)
  const [form, setForm] = useState({ name: '', ranges: '', comment: '' })
  const [creando, setCreando] = useState(false)

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  async function cargar() {
    if (!router) return
    setCargando(true)
    setError(null)
    try {
      setPools(await api.mikrotik.pools(router.id))
    } catch (err) {
      setError(err)
      setPools(null)
    } finally {
      setCargando(false)
    }
  }

  useEffect(() => {
    setPools(null)
    if (router) cargar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router?.id])

  async function crear(e) {
    e.preventDefault()
    setCreando(true)
    setError(null)
    try {
      const r = await api.mikrotik.crearPool(router.id, form)
      setPools(r.pools)
      setForm({ name: '', ranges: '', comment: '' })
    } catch (err) {
      setError(err)
    } finally {
      setCreando(false)
    }
  }

  async function borrar(pool) {
    if (!await confirmar(`¿Eliminar el pool "${pool.name}" del router?`)) return
    try {
      await api.mikrotik.borrarPool(router.id, pool['.id'])
      await cargar()
    } catch (err) {
      setError(err)
    }
  }

  return (
    <Card
      title="IP Pools"
      subtitle="Rangos de direcciones que reparte el router"
      icon={Boxes}
      actions={
        <Button icon={RefreshCw} onClick={cargar} cargando={cargando} disabled={!router}>
          Refrescar
        </Button>
      }
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <form onSubmit={crear} className="grid items-end gap-3 sm:grid-cols-4">
          <Field label="Nombre">
            <Input value={form.name} onChange={set('name')} placeholder="pool-clientes" required />
          </Field>
          <Field label="Rango" hint="Ej: 10.0.0.10-10.0.0.254">
            <Input value={form.ranges} onChange={set('ranges')} placeholder="10.0.0.10-10.0.0.254" required />
          </Field>
          <Field label="Comentario">
            <Input value={form.comment} onChange={set('comment')} />
          </Field>
          <div className="pb-2">
            <Button
              type="submit"
              variante="primario"
              icon={Plus}
              cargando={creando}
              disabled={!router}
              className="w-full"
            >
              Crear pool
            </Button>
          </div>
        </form>

        {cargando ? (
          <Cargando texto="Consultando el router…" />
        ) : pools === null ? (
          <p className="py-6 text-center text-sm text-slate-500">Elegí un router para ver sus pools.</p>
        ) : (
          <Table
            columnas={['Nombre', 'Rango', 'Siguiente pool', 'Comentario', '']}
            filas={pools}
            vacio="El router no tiene pools definidos."
            renderFila={(p) => (
              <tr key={p['.id']} className="text-slate-300">
                <td className="px-3 py-2 font-medium text-slate-100">{p.name}</td>
                <td className="px-3 py-2 font-mono text-xs">{p.ranges}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{p['next-pool'] || '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{p.comment || '—'}</td>
                <td className="px-3 py-2 text-right">
                  <Button variante="fantasma" icon={Trash2} onClick={() => borrar(p)} />
                </td>
              </tr>
            )}
          />
        )}
      </div>
    </Card>
  )
}
