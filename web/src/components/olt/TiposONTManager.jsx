import { useState } from 'react'
import { Plus, Trash2, Cpu } from 'lucide-react'
import { useTabla } from '../../lib/useTabla'
import { Badge, Button, Card, Cargando, ErrorBanner, Field, Input, Table } from '../ui'

const VACIO = { marca: '', modelo: '', puertos_ethernet: 1, puertos_fxs: 0, wifi: false }

/** Catálogo de modelos de ONT. Es solo base de datos: no toca ningún equipo. */
export default function TiposONTManager() {
  const { filas, cargando, error, insertar, eliminar, setError } = useTabla('tipos_ont', {
    orderBy: 'marca',
    ascending: true,
  })
  const [form, setForm] = useState(VACIO)
  const [guardando, setGuardando] = useState(false)

  const set = (campo) => (e) =>
    setForm((f) => ({
      ...f,
      [campo]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
    }))

  async function agregar(e) {
    e.preventDefault()
    setGuardando(true)
    try {
      await insertar({
        marca: form.marca,
        modelo: form.modelo,
        puertos_ethernet: Number(form.puertos_ethernet) || 0,
        puertos_fxs: Number(form.puertos_fxs) || 0,
        wifi: Boolean(form.wifi),
      })
      setForm(VACIO)
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Card title="Tipos de ONT" subtitle="Catálogo de modelos disponibles" icon={Cpu}>
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <form onSubmit={agregar} className="grid items-end gap-3 sm:grid-cols-5">
          <Field label="Marca">
            <Input value={form.marca} onChange={set('marca')} placeholder="Huawei" required />
          </Field>
          <Field label="Modelo">
            <Input value={form.modelo} onChange={set('modelo')} placeholder="HG8546M" required />
          </Field>
          <Field label="Eth">
            <Input type="number" value={form.puertos_ethernet} onChange={set('puertos_ethernet')} min={0} />
          </Field>
          <Field label="FXS">
            <Input type="number" value={form.puertos_fxs} onChange={set('puertos_fxs')} min={0} />
          </Field>
          <div className="flex items-center gap-3 pb-2">
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={form.wifi}
                onChange={set('wifi')}
                className="accent-sky-500"
              />
              WiFi
            </label>
            <Button type="submit" variante="primario" icon={Plus} cargando={guardando} />
          </div>
        </form>

        {cargando ? (
          <Cargando />
        ) : (
          <Table
            columnas={['Marca', 'Modelo', 'Puertos', 'WiFi', '']}
            filas={filas}
            vacio="Sin modelos cargados."
            renderFila={(t) => (
              <tr key={t.id} className="text-slate-300">
                <td className="px-3 py-2">{t.marca}</td>
                <td className="px-3 py-2 font-medium text-slate-100">{t.modelo}</td>
                <td className="px-3 py-2 text-xs">
                  {t.puertos_ethernet} eth {t.puertos_fxs > 0 && `· ${t.puertos_fxs} FXS`}
                </td>
                <td className="px-3 py-2">
                  {t.wifi ? <Badge color="verde">sí</Badge> : <Badge>no</Badge>}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    variante="fantasma"
                    icon={Trash2}
                    onClick={() => eliminar(t.id).catch(setError)}
                  />
                </td>
              </tr>
            )}
          />
        )}
      </div>
    </Card>
  )
}
