import { useState } from 'react'
import { Save } from 'lucide-react'
import { TIPOS_NODO } from '../../lib/red'
import { Aviso, Button, Field, Input, Select, Textarea } from '../ui'

/**
 * Alta y edición de un nodo.
 *
 * Vive en un modal y no en la pantalla porque se usa una vez por equipo y el
 * listado se mira todos los días: un formulario de doce campos permanentemente
 * arriba empuja la tabla —que es lo que se viene a ver— fuera de la pantalla.
 *
 * El campo que importa más que todos los demás es "depende de". Sin el árbol
 * armado, un corte de fibra en una torre manda un mensaje por cada antena que
 * cuelga de ella, y a partir de ahí nadie los lee.
 */
export default function NodoForm({ nodo, nodos, routers, puntos, tecnicos, onGuardar, onCancelar }) {
  const [form, setForm] = useState({
    nombre: nodo?.nombre ?? '',
    tipo: nodo?.tipo ?? 'ptmp',
    equipo: nodo?.equipo ?? '',
    ip: nodo?.ip ?? '',
    padre_id: nodo?.padre_id ?? '',
    router_id: nodo?.router_id ?? '',
    punto_id: nodo?.punto_id ?? '',
    tecnico_id: nodo?.tecnico_id ?? '',
    latencia_warning_ms: nodo?.latencia_warning_ms ?? 150,
    perdida_warning_pct: nodo?.perdida_warning_pct ?? 20,
    notas: nodo?.notas ?? '',
  })
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  // Un nodo no puede depender de sí mismo, y ofrecerlo en la lista invita al
  // error que la base después rechaza con un mensaje que no explica nada.
  const posiblesPadres = nodos.filter((n) => n.id !== nodo?.id)

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)
    try {
      const texto = (v) => String(v ?? '').trim() || null
      await onGuardar({
        nombre: form.nombre.trim(),
        tipo: form.tipo,
        equipo: texto(form.equipo),
        ip: form.ip.trim(),
        padre_id: form.padre_id || null,
        router_id: form.router_id || null,
        punto_id: form.punto_id || null,
        tecnico_id: form.tecnico_id || null,
        latencia_warning_ms: Number(form.latencia_warning_ms) || 150,
        perdida_warning_pct: Number(form.perdida_warning_pct) || 20,
        notas: texto(form.notas),
      })
    } catch (err) {
      setError(
        err.code === '23505' ? `Ya hay un nodo llamado "${form.nombre}"` : err.message,
      )
    } finally {
      setGuardando(false)
    }
  }

  return (
    <form onSubmit={guardar} className="space-y-4">
      {error && <Aviso tipo="alerta">{error}</Aviso>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre">
          <Input value={form.nombre} onChange={set('nombre')} placeholder="BASE SAN AGUSTIN" required />
        </Field>

        <Field label="Tipo" hint={TIPOS_NODO[form.tipo]?.ayuda}>
          <Select value={form.tipo} onChange={set('tipo')}>
            {Object.entries(TIPOS_NODO).map(([valor, t]) => (
              <option key={valor} value={valor}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Equipo" hint="Qué repuesto llevar si hay que subir">
          <Input value={form.equipo} onChange={set('equipo')} placeholder="RB912UAG-5HPnD" />
        </Field>

        <Field label="IP a monitorear">
          <Input value={form.ip} onChange={set('ip')} placeholder="10.10.8.246" required spellCheck={false} />
        </Field>

        <Field label="Sondear desde" hint="El router con ruta hasta esa IP">
          <Select value={form.router_id} onChange={set('router_id')}>
            <option value="">Sin asignar</option>
            {routers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.nombre}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Depende de" hint="Si este cae, sus hijos no alertan aparte">
          <Select value={form.padre_id} onChange={set('padre_id')}>
            <option value="">Ninguno (es cabecera)</option>
            {posiblesPadres.map((n) => (
              <option key={n.id} value={n.id}>
                {n.nombre}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Sitio" hint="De acá salen los abonados que se le cuentan">
          <Select value={form.punto_id} onChange={set('punto_id')}>
            <option value="">Sin asignar</option>
            {puntos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Técnico" hint="A quién se le avisa">
          <Select value={form.tecnico_id} onChange={set('tecnico_id')}>
            <option value="">Al destino general</option>
            {tecnicos.map((t) => (
              <option key={t.id} value={t.id}>
                {t.nombre}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Latencia máxima (ms)" hint="Por encima queda degradado, no caído">
          <Input
            type="number"
            min={1}
            value={form.latencia_warning_ms}
            onChange={set('latencia_warning_ms')}
          />
        </Field>

        <Field label="Pérdida máxima (%)">
          <Input
            type="number"
            min={1}
            max={100}
            value={form.perdida_warning_pct}
            onChange={set('perdida_warning_pct')}
          />
        </Field>

        <Field label="Notas" className="sm:col-span-2">
          <Textarea rows={2} value={form.notas} onChange={set('notas')} />
        </Field>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="button" onClick={onCancelar}>
          Cancelar
        </Button>
        <Button type="submit" variante="primario" icon={Save} cargando={guardando}>
          {nodo ? 'Guardar cambios' : 'Registrar'}
        </Button>
      </div>
    </form>
  )
}
