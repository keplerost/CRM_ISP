import { useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { Network, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Badge, Button, Card, Cargando, ErrorBanner, Field, Input, Select, Table } from '../ui'

/** Direcciones IP asignadas a las interfaces del router. */
export default function IPAddressManager({ router }) {
  const confirmar = useConfirmar()
  const [addresses, setAddresses] = useState(null)
  const [interfaces, setInterfaces] = useState([])
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState(null)
  const [form, setForm] = useState({ address: '', interfaz: '', comment: '' })
  const [creando, setCreando] = useState(false)

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  async function cargar() {
    if (!router) return
    setCargando(true)
    setError(null)
    try {
      const [addrs, ifaces] = await Promise.all([
        api.mikrotik.addresses(router.id),
        api.mikrotik.interfaces(router.id),
      ])
      setAddresses(addrs)
      setInterfaces(ifaces)
    } catch (err) {
      setError(err)
      setAddresses(null)
    } finally {
      setCargando(false)
    }
  }

  useEffect(() => {
    setAddresses(null)
    setInterfaces([])
    if (router) cargar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router?.id])

  async function crear(e) {
    e.preventDefault()
    setCreando(true)
    setError(null)
    try {
      const r = await api.mikrotik.crearAddress(router.id, form)
      setAddresses(r.addresses)
      setForm({ address: '', interfaz: '', comment: '' })
    } catch (err) {
      setError(err)
    } finally {
      setCreando(false)
    }
  }

  async function borrar(addr) {
    if (!await confirmar(`¿Eliminar la dirección ${addr.address} de ${addr.interface}?`)) return
    try {
      await api.mikrotik.borrarAddress(router.id, addr['.id'])
      await cargar()
    } catch (err) {
      setError(err)
    }
  }

  return (
    <Card
      title="IP Addresses"
      subtitle="Direcciones e interfaces del router (gateways de las ONUs)"
      icon={Network}
      actions={
        <Button icon={RefreshCw} onClick={cargar} cargando={cargando} disabled={!router}>
          Refrescar
        </Button>
      }
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <form onSubmit={crear} className="grid items-end gap-3 sm:grid-cols-4">
          <Field label="Dirección" hint="Con máscara: 10.0.0.1/24">
            <Input value={form.address} onChange={set('address')} placeholder="10.0.0.1/24" required />
          </Field>
          <Field label="Interfaz">
            <Select value={form.interfaz} onChange={set('interfaz')} required>
              <option value="">— elegí —</option>
              {interfaces.map((i) => (
                <option key={i.id} value={i.nombre}>
                  {i.nombre} ({i.tipo})
                </option>
              ))}
            </Select>
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
              Asignar IP
            </Button>
          </div>
        </form>

        {cargando ? (
          <Cargando texto="Consultando el router…" />
        ) : addresses === null ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Elegí un router para ver sus direcciones.
          </p>
        ) : (
          <Table
            columnas={['Dirección', 'Red', 'Interfaz', 'Estado', 'Comentario', '']}
            filas={addresses}
            vacio="El router no tiene direcciones configuradas."
            renderFila={(a) => (
              <tr key={a['.id']} className="text-slate-300">
                <td className="px-3 py-2 font-mono text-xs text-slate-100">{a.address}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">{a.network || '—'}</td>
                <td className="px-3 py-2">{a.interface}</td>
                <td className="px-3 py-2">
                  {a.disabled === 'true' ? (
                    <Badge color="gris">deshabilitada</Badge>
                  ) : a.dynamic === 'true' ? (
                    <Badge color="azul">dinámica</Badge>
                  ) : (
                    <Badge color="verde">activa</Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">{a.comment || '—'}</td>
                <td className="px-3 py-2 text-right">
                  {a.dynamic !== 'true' && (
                    <Button variante="fantasma" icon={Trash2} onClick={() => borrar(a)} />
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
