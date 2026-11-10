import { useEffect, useState } from 'react'
import { Lock, Save, Search } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { usePermisos } from '../../lib/AuthContext'
import { TIPOS_PENDIENTE } from '../../lib/pendientes'
import { Button, Field, Input, Select, Textarea } from '../ui'

/**
 * Crear o editar un pendiente.
 *
 * Una sola pantalla y corta, a propósito: es "anotá que hay que hacer esto",
 * no un formulario de alta. Si cuesta más que crear un ticket, la gente va a
 * seguir creando tickets.
 *
 * El abonado se elige de las fichas o se escribe a mano: casi todos siguen en
 * MikroWISP y no tienen ficha acá.
 */

const VACIO = {
  client_id: null,
  nombre: '',
  identificacion: '',
  telefono: '',
  tipo: 'otro',
  detalle: '',
  asignado_a: '',
  vence_el: '',
  privado: false,
}

const texto = (v) => (String(v ?? '').trim() === '' ? null : String(v).trim())

export default function PendienteForm({ inicial = null, cliente = null, onGuardado, onCancelar, onError }) {
  const { perfil } = usePermisos()
  const editando = Boolean(inicial?.id)
  const [form, setForm] = useState(() => ({
    ...VACIO,
    asignado_a: perfil?.id ?? '',
    ...(cliente
      ? {
          client_id: cliente.id,
          nombre: cliente.nombre ?? '',
          identificacion: cliente.identificacion ?? '',
          telefono: cliente.telefono_movil ?? cliente.telefono ?? '',
        }
      : {}),
    ...Object.fromEntries(Object.entries(inicial ?? {}).filter(([k, v]) => k in VACIO && v != null)),
  }))
  const [usuarios, setUsuarios] = useState([])
  const [busqueda, setBusqueda] = useState('')
  const [encontrados, setEncontrados] = useState([])
  const [guardando, setGuardando] = useState(false)

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  useEffect(() => {
    supabase
      .from('usuarios_sistema')
      .select('id, nombre, apellido, rol')
      .eq('activo', true)
      .order('nombre')
      .then(({ data }) => setUsuarios(data ?? []))
  }, [])

  async function buscar(e) {
    e?.preventDefault()
    const q = busqueda.trim()
    if (q.length < 3) return
    const { data } = await supabase
      .from('v_clientes_ficha')
      .select('id, nombre, identificacion, telefono, telefono_movil')
      .or(`nombre.ilike.%${q}%,identificacion.ilike.%${q}%`)
      .limit(6)
    setEncontrados(data ?? [])
  }

  async function guardar(e) {
    e.preventDefault()
    if (!form.nombre.trim()) return onError?.(new Error('Falta el nombre del abonado'))
    setGuardando(true)
    onError?.(null)
    const fila = {
      client_id: form.client_id || null,
      nombre: form.nombre.trim(),
      identificacion: texto(form.identificacion),
      telefono: texto(form.telefono),
      tipo: form.tipo,
      detalle: texto(form.detalle),
      asignado_a: form.asignado_a || null,
      vence_el: form.vence_el || null,
      privado: Boolean(form.privado),
    }
    try {
      const r = editando
        ? await supabase.from('pendientes').update(fila).eq('id', inicial.id).select().single()
        : await supabase.from('pendientes').insert(fila).select().single()
      if (r.error) throw r.error
      onGuardado?.(r.data)
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  const nombreUsuario = (u) => `${u.nombre ?? ''} ${u.apellido ?? ''}`.trim()

  return (
    <form onSubmit={guardar} className="space-y-4">
      {/* El abonado: de una ficha, o a mano. */}
      {!cliente && !editando && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && buscar(e)}
              placeholder="Buscar en las fichas (nombre o cédula)… o escribilo abajo"
            />
            <Button type="button" icon={Search} onClick={buscar}>
              Buscar
            </Button>
          </div>
          {encontrados.length > 0 && (
            <ul className="space-y-1">
              {encontrados.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setForm((f) => ({
                        ...f,
                        client_id: c.id,
                        nombre: c.nombre ?? '',
                        identificacion: c.identificacion ?? '',
                        telefono: c.telefono_movil ?? c.telefono ?? '',
                      }))
                      setEncontrados([])
                      setBusqueda('')
                    }}
                    className="w-full rounded-lg border border-slate-700 px-3 py-1.5 text-left text-xs text-slate-300 hover:border-sky-500/50"
                  >
                    {c.nombre} <span className="text-slate-500">· {c.identificacion ?? 'sin cédula'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Abonado" className="sm:col-span-3">
          <Input
            value={form.nombre}
            onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value, client_id: null }))}
            placeholder="Nombre y apellido"
            disabled={Boolean(cliente)}
          />
          {form.client_id && <p className="mt-1 text-[11px] text-emerald-400">Atado a su ficha del sistema</p>}
        </Field>
        <Field label="Cédula">
          <Input value={form.identificacion} onChange={set('identificacion')} disabled={Boolean(cliente)} />
        </Field>
        <Field label="Teléfono">
          <Input value={form.telefono} onChange={set('telefono')} />
        </Field>
        <Field label="Qué hay que hacer">
          <Select value={form.tipo} onChange={set('tipo')}>
            {TIPOS_PENDIENTE.map((t) => (
              <option key={t.valor} value={t.valor}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Detalle" hint="Ej.: pasar al plan de $23.10 · llevar el contrato impreso">
        <Textarea rows={2} value={form.detalle} onChange={set('detalle')} />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Le toca a">
          <Select value={form.asignado_a} onChange={set('asignado_a')}>
            <option value="">— cualquiera de la oficina —</option>
            {usuarios.map((u) => (
              <option key={u.id} value={u.id}>
                {nombreUsuario(u)}
                {u.id === perfil?.id ? ' (yo)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Para cuándo" hint="opcional">
          <Input type="date" value={form.vence_el} onChange={set('vence_el')} />
        </Field>
      </div>

      <label className="flex items-start gap-2 text-sm text-slate-300">
        <input
          type="checkbox"
          checked={form.privado}
          onChange={(e) => setForm((f) => ({ ...f, privado: e.target.checked }))}
          className="mt-1"
        />
        <span>
          <Lock size={13} className="mr-1 inline" />
          Solo para mí y a quien se lo asigno
          <span className="block text-[11px] text-slate-500">
            Sin marcar, lo ve todo el equipo: así el técnico que va a la casa se entera de que falta,
            por ejemplo, la firma.
          </span>
        </span>
      </label>

      <div className="flex justify-end gap-2 border-t border-slate-800 pt-3">
        <Button type="button" variante="fantasma" onClick={onCancelar}>
          Cancelar
        </Button>
        <Button type="submit" variante="primario" icon={Save} cargando={guardando}>
          {editando ? 'Guardar cambios' : 'Crear pendiente'}
        </Button>
      </div>
    </form>
  )
}
