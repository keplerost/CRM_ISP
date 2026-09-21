import { useState } from 'react'
import { Zap } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { useTabla } from '../../lib/useTabla'
import { Aviso, Button, ErrorBanner, Field, Input, Select } from '../ui'

/**
 * Aprovisionamiento de una ONU.
 * Vincula Cliente + Tipo de ONT + Line Profile + Plan, registra en la OLT y guarda
 * en Supabase (el middleware hace las dos cosas, en ese orden).
 */
export default function ONUProvisionForm({ olt, ubicacion, onuDetectada, onListo, onCancelar }) {
  const { filas: tiposOnt } = useTabla('tipos_ont', { orderBy: 'marca', ascending: true })
  const { filas: lineProfiles } = useTabla('line_profiles', { orderBy: 'nombre', ascending: true })
  const { filas: planes } = useTabla('planes_velocidad', { orderBy: 'nombre', ascending: true })

  const esVsol = String(olt?.marca).toLowerCase() !== 'huawei'

  const [form, setForm] = useState({
    sn: onuDetectada?.sn ?? '',
    nombre_cliente: '',
    puerto: onuDetectada?.puerto ?? ubicacion.puerto,
    tipo_ont_id: '',
    line_profile_id: '',
    plan_id: '',
    vlan: '',
  })
  const [error, setError] = useState(null)
  const [resultado, setResultado] = useState(null)
  const [enviando, setEnviando] = useState(false)

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  const perfilElegido = lineProfiles.find((p) => p.id === form.line_profile_id)
  const vlanEfectiva = form.vlan || perfilElegido?.vlan_id || ''

  async function aprovisionar(e) {
    e.preventDefault()
    setError(null)
    setResultado(null)
    setEnviando(true)

    try {
      // Paso 1: registrar en la OLT (y persistir en Supabase si conocemos el SN)
      const alta = await api.olt.registrar(olt.id, {
        frame: ubicacion.frame,
        slot: ubicacion.slot,
        puerto: Number(form.puerto),
        sn: form.sn || undefined,
        nombre_cliente: form.nombre_cliente || undefined,
        tipo_ont_id: form.tipo_ont_id || undefined,
        line_profile_id: form.line_profile_id || undefined,
        plan_id: form.plan_id || undefined,
        lineProfile: esVsol ? perfilElegido?.nombre : undefined,
      })

      // Paso 2 (solo V-SOL): la secuencia tcont → gemport → service-port que da VLAN
      let servicio = null
      if (esVsol && vlanEfectiva && alta?.registradaEnOlt?.onuIndex != null) {
        servicio = await api.olt.configurarServicio(olt.id, {
          puerto: Number(form.puerto),
          onuId: alta.registradaEnOlt.onuIndex,
          vlan: Number(vlanEfectiva),
        })
      }

      setResultado({ alta, servicio })
      onListo?.()
    } catch (err) {
      setError(err)
    } finally {
      setEnviando(false)
    }
  }

  return (
    <form onSubmit={aprovisionar} className="space-y-4">
      {esVsol && (
        <Aviso tipo="alerta">
          En V-SOL, la primera vez que se usa un <code>tcont</code> nuevo en un puerto el puerto PON
          entero puede caerse unos segundos y afectar a las demás ONUs. Si el puerto ya tiene
          servicio configurado, no debería pasar.
        </Aviso>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Serial (SN)" hint={esVsol ? 'V-SOL confirma la cola de auto-find del puerto' : undefined}>
          <Input
            value={form.sn}
            onChange={set('sn')}
            placeholder="485754431A2B3C4D"
            className="font-mono"
            required={!esVsol}
          />
        </Field>

        <Field label="Cliente">
          <Input value={form.nombre_cliente} onChange={set('nombre_cliente')} placeholder="Juan Pérez" />
        </Field>

        <Field label="Puerto PON">
          <Input type="number" value={form.puerto} onChange={set('puerto')} min={0} required />
        </Field>

        <Field label="Tipo de ONT">
          <Select value={form.tipo_ont_id} onChange={set('tipo_ont_id')}>
            <option value="">— sin especificar —</option>
            {tiposOnt.map((t) => (
              <option key={t.id} value={t.id}>
                {t.marca} {t.modelo}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Line Profile" hint="Define la VLAN que se etiqueta en la OLT">
          <Select value={form.line_profile_id} onChange={set('line_profile_id')}>
            <option value="">— sin perfil —</option>
            {lineProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre} (VLAN {p.vlan_id})
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Plan de velocidad">
          <Select value={form.plan_id} onChange={set('plan_id')}>
            <option value="">— sin plan —</option>
            {planes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre} ({p.bajada_kbps / 1000}/{p.subida_kbps / 1000} Mbps)
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="VLAN"
          hint={perfilElegido ? `Por defecto la del perfil: ${perfilElegido.vlan_id}` : 'Requerida para dar servicio'}
          className="sm:col-span-2"
        >
          <Input
            type="number"
            value={vlanEfectiva}
            onChange={set('vlan')}
            min={1}
            max={4094}
            placeholder="100"
          />
        </Field>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {resultado && (
        <Aviso>
          <p className="font-medium">ONU aprovisionada.</p>
          {resultado.alta?.registradaEnOlt?.comando && (
            <p className="mt-1 font-mono text-[11px] opacity-80">
              {resultado.alta.registradaEnOlt.comando}
            </p>
          )}
          {resultado.alta?.guardadaEnBase === false && (
            <p className="mt-1 text-amber-300">
              Quedó registrada en la OLT pero no se guardó en la base: {resultado.alta.error}
            </p>
          )}
          {resultado.servicio?.comandos?.map((c) => (
            <p key={c} className="font-mono text-[11px] opacity-80">
              {c}
            </p>
          ))}
        </Aviso>
      )}

      <div className="flex justify-end gap-2">
        {onCancelar && (
          <Button type="button" variante="fantasma" onClick={onCancelar}>
            Cerrar
          </Button>
        )}
        <Button type="submit" variante="primario" icon={Zap} cargando={enviando}>
          Aprovisionar
        </Button>
      </div>
    </form>
  )
}
