import { Field, Input, Select } from '../ui'

/**
 * Selector de OLT + ubicación en la fibra.
 *
 * Huawei direcciona por frame/slot/puerto; V-SOL solo por puerto (siempre 0/x).
 * Por eso frame y slot se ocultan cuando la OLT elegida es V-SOL: mostrarlos
 * confundiría, no los usa.
 */
export default function SelectorOlt({ olts, oltId, onOltId, ubicacion, onUbicacion }) {
  const olt = olts.find((o) => o.id === oltId)
  const esHuawei = String(olt?.marca).toLowerCase() === 'huawei'

  const set = (campo) => (e) => {
    const n = Number.parseInt(e.target.value, 10)
    onUbicacion({ ...ubicacion, [campo]: Number.isFinite(n) ? n : 0 })
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="OLT" className="lg:col-span-2">
        <Select value={oltId ?? ''} onChange={(e) => onOltId(e.target.value)}>
          <option value="">— elegí una OLT —</option>
          {olts.map((o) => (
            <option key={o.id} value={o.id}>
              {o.nombre} ({o.marca} · {o.ip_host})
            </option>
          ))}
        </Select>
      </Field>

      {esHuawei && (
        <>
          <Field label="Frame">
            <Input type="number" value={ubicacion.frame} onChange={set('frame')} min={0} />
          </Field>
          <Field label="Slot">
            <Input type="number" value={ubicacion.slot} onChange={set('slot')} min={0} />
          </Field>
        </>
      )}

      <Field label="Puerto PON">
        <Input type="number" value={ubicacion.puerto} onChange={set('puerto')} min={0} />
      </Field>
    </div>
  )
}
