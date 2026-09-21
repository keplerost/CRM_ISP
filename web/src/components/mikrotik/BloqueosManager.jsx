import { useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { Ban, RefreshCw, Undo2 } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, Card, Cargando, ErrorBanner, Field, Input, Table } from '../ui'

/**
 * Corte de servicio por address-list.
 *
 * El corte son dos piezas: la IP en la lista CORTE_MOROSOS y una regla de filter
 * que dropea el forward de esa lista. El middleware crea la regla la primera vez
 * (idempotente, identificada por comment), así que acá alcanza con agregar la IP.
 */
export default function BloqueosManager({ router }) {
  const confirmar = useConfirmar()
  const [bloqueos, setBloqueos] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState(null)
  const [form, setForm] = useState({ address: '', comment: '' })
  const [enviando, setEnviando] = useState(false)
  const [aviso, setAviso] = useState(null)

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  async function cargar() {
    if (!router) return
    setCargando(true)
    setError(null)
    try {
      setBloqueos(await api.mikrotik.bloqueos(router.id))
    } catch (err) {
      setError(err)
      setBloqueos(null)
    } finally {
      setCargando(false)
    }
  }

  useEffect(() => {
    setBloqueos(null)
    if (router) cargar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router?.id])

  async function bloquear(e) {
    e.preventDefault()
    setEnviando(true)
    setError(null)
    setAviso(null)
    try {
      const r = await api.mikrotik.bloquear(router.id, form)
      if (r.regla?.creada) setAviso('Se creó también la regla de filter que aplica el corte.')
      setForm({ address: '', comment: '' })
      await cargar()
    } catch (err) {
      setError(err)
    } finally {
      setEnviando(false)
    }
  }

  async function restaurar(entrada) {
    if (!await confirmar(`¿Restaurar el servicio de ${entrada.address}?`)) return
    try {
      await api.mikrotik.desbloquear(router.id, entrada.id)
      await cargar()
    } catch (err) {
      setError(err)
    }
  }

  return (
    <Card
      title="Cortes por mora"
      subtitle="Address-list CORTE_MOROSOS + regla de drop en forward"
      icon={Ban}
      actions={
        <Button icon={RefreshCw} onClick={cargar} cargando={cargando} disabled={!router}>
          Refrescar
        </Button>
      }
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />
        {aviso && <Aviso>{aviso}</Aviso>}

        <form onSubmit={bloquear} className="grid items-end gap-3 sm:grid-cols-3">
          <Field label="IP del cliente">
            <Input value={form.address} onChange={set('address')} placeholder="10.0.0.55" required />
          </Field>
          <Field label="Motivo / cliente">
            <Input value={form.comment} onChange={set('comment')} placeholder="Juan Pérez - factura 0234" />
          </Field>
          <div className="pb-2">
            <Button
              type="submit"
              variante="peligro"
              icon={Ban}
              cargando={enviando}
              disabled={!router}
              className="w-full"
            >
              Cortar servicio
            </Button>
          </div>
        </form>

        {cargando ? (
          <Cargando texto="Consultando el router…" />
        ) : bloqueos === null ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Elegí un router para ver los cortes activos.
          </p>
        ) : (
          <Table
            columnas={['IP', 'Lista', 'Motivo', 'Origen', '']}
            filas={bloqueos}
            vacio="No hay ningún cliente cortado."
            renderFila={(b) => (
              <tr key={b.id} className="text-slate-300">
                <td className="px-3 py-2 font-mono text-xs text-slate-100">{b.address}</td>
                <td className="px-3 py-2">
                  <Badge color="rojo">{b.lista}</Badge>
                </td>
                <td className="px-3 py-2 text-xs text-slate-400">{b.comment || '—'}</td>
                <td className="px-3 py-2">
                  {b.dynamic ? <Badge color="azul">dinámica</Badge> : <Badge>manual</Badge>}
                </td>
                <td className="px-3 py-2 text-right">
                  {!b.dynamic && (
                    <Button variante="fantasma" icon={Undo2} onClick={() => restaurar(b)}>
                      Restaurar
                    </Button>
                  )}
                </td>
              </tr>
            )}
          />
        )}
      </div>
    </Card>
  )
}
