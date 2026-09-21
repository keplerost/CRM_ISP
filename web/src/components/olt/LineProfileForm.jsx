import { useState } from 'react'
import { Layers, Plus, Trash2 } from 'lucide-react'
import { useTabla } from '../../lib/useTabla'
import { api } from '../../lib/apiNetwork'
import { Aviso, Button, Card, Cargando, ErrorBanner, Field, Input, Select, Table } from '../ui'

const VACIO = { nombre: '', vlan_id: '', gemport_id: 1, profile_id_olt: '' }

/**
 * Line Profiles: la VLAN que la OLT etiqueta para esa ONT.
 *
 * A diferencia del catálogo de tipos de ONT, esto SÍ toca el equipo: el middleware
 * ejecuta ont-lineprofile + vlan-map + commit y recién después guarda en la base.
 */
export default function LineProfileForm() {
  const { filas: olts } = useTabla('olts')
  const {
    filas: perfiles,
    cargando,
    error,
    recargar,
    eliminar,
    setError,
  } = useTabla('line_profiles', { orderBy: 'nombre', ascending: true })

  const [oltId, setOltId] = useState('')
  const [form, setForm] = useState(VACIO)
  const [creando, setCreando] = useState(false)
  const [resultado, setResultado] = useState(null)

  const olt = olts.find((o) => o.id === oltId)
  const esHuawei = String(olt?.marca).toLowerCase() === 'huawei'

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  async function crear(e) {
    e.preventDefault()
    setError(null)
    setResultado(null)
    setCreando(true)
    try {
      const r = await api.olt.crearLineProfile(oltId, {
        nombre: form.nombre,
        vlan: Number(form.vlan_id),
        gemport: Number(form.gemport_id) || 1,
        profile_id_olt: form.profile_id_olt ? Number(form.profile_id_olt) : undefined,
      })
      setResultado(r)
      setForm(VACIO)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setCreando(false)
    }
  }

  return (
    <Card
      title="Line Profiles"
      subtitle="Perfiles de línea GPON — definen la VLAN de servicio"
      icon={Layers}
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <form onSubmit={crear} className="grid items-end gap-3 sm:grid-cols-6">
          <Field label="OLT" className="sm:col-span-2">
            <Select value={oltId} onChange={(e) => setOltId(e.target.value)} required>
              <option value="">— elegí —</option>
              {olts.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.nombre} ({o.marca})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Nombre">
            <Input
              value={form.nombre}
              onChange={set('nombre')}
              placeholder="PROFILE_VLAN100"
              required
            />
          </Field>
          <Field label="VLAN">
            <Input type="number" value={form.vlan_id} onChange={set('vlan_id')} min={1} max={4094} required />
          </Field>
          <Field label="GEM port">
            <Input type="number" value={form.gemport_id} onChange={set('gemport_id')} min={1} />
          </Field>
          <div className="pb-2">
            <Button
              type="submit"
              variante="primario"
              icon={Plus}
              cargando={creando}
              disabled={!oltId}
              className="w-full"
            >
              Crear en la OLT
            </Button>
          </div>
        </form>

        {oltId && !esHuawei && (
          <Aviso tipo="alerta">
            La creación automática de line profiles está implementada para Huawei. En V-SOL creá el
            perfil desde la CLI y después usá su nombre al confirmar las ONUs
            (<code>onu confirm line-profile &lt;nombre&gt;</code>).
          </Aviso>
        )}

        {resultado && (
          <Aviso>
            Perfil creado en la OLT.
            {resultado.creadoEnOlt?.comandos?.map((c) => (
              <span key={c} className="mt-1 block font-mono text-[11px] opacity-80">
                {c}
              </span>
            ))}
          </Aviso>
        )}

        {cargando ? (
          <Cargando />
        ) : (
          <Table
            columnas={['Nombre', 'VLAN', 'GEM port', 'ID en OLT', '']}
            filas={perfiles}
            vacio="Sin perfiles cargados."
            renderFila={(p) => (
              <tr key={p.id} className="text-slate-300">
                <td className="px-3 py-2 font-medium text-slate-100">{p.nombre}</td>
                <td className="px-3 py-2">{p.vlan_id}</td>
                <td className="px-3 py-2">{p.gemport_id}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{p.profile_id_olt}</td>
                <td className="px-3 py-2 text-right">
                  <Button
                    variante="fantasma"
                    icon={Trash2}
                    title="Solo borra el registro de la base, no el perfil de la OLT"
                    onClick={() => eliminar(p.id).catch(setError)}
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
