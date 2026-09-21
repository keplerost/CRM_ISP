import { useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { Check, Pencil, Plus, Star, Trash2 } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, ErrorBanner, Field, Input, Select, Table } from '../ui'

/**
 * Plantillas de autorización.
 *
 * Autorizar pide siempre los mismos seis datos y solo uno cambia entre altas de
 * la misma zona. Los otros cinco se escriben de memoria cada vez, y ahí es donde
 * se cuela el error que nadie encuentra: una VLAN mal tipeada deja al abonado
 * sin salida y desde el lado GPON se ve todo normal.
 *
 * Una plantilla puede ser de una OLT o servir para todas. La diferencia importa
 * por los perfiles: sus IDs son de cada equipo, así que una plantilla general se
 * resuelve por NOMBRE en la OLT donde se use, y avisa si ahí no existe en vez de
 * usar el número a ciegas.
 */
export default function Presets({ olt, perfiles, planes = [], onListo }) {
  const confirmar = useConfirmar()
  const [lista, setLista] = useState([])
  const [editando, setEditando] = useState(null)
  const [error, setError] = useState(null)
  const [guardando, setGuardando] = useState(false)

  async function cargar() {
    try {
      setLista(await api.olt.presets(olt?.id))
    } catch (err) {
      setError(err)
    }
  }

  useEffect(() => {
    cargar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [olt?.id])

  async function guardar() {
    setGuardando(true)
    setError(null)
    try {
      await api.olt.guardarPreset(editando)
      setEditando(null)
      await cargar()
      onListo?.()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  async function borrar(p) {
    if (!await confirmar(`Borrar la plantilla "${p.nombre}"?\n\nNo afecta a las ONTs ya autorizadas.`)) return
    try {
      await api.olt.borrarPreset(p.id)
      await cargar()
    } catch (err) {
      setError(err)
    }
  }

  const nueva = () => ({
    nombre: '',
    olt_id: olt?.id ?? null,
    line_profile_id: '',
    line_profile_nombre: '',
    srv_profile_id: '',
    srv_profile_nombre: '',
    vlan: '',
    gemport: 1,
    plan_id: '',
    zona: '',
    predeterminado: false,
  })

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-xs leading-relaxed text-slate-500">
          Guardan el juego de datos que se repite. Al autorizar se elige una y los seis campos
          quedan llenos.
        </p>
        <Button variante="primario" icon={Plus} onClick={() => setEditando(nueva())}>
          Nueva plantilla
        </Button>
      </div>

      {editando && (
        <div className="space-y-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Nombre" className="sm:col-span-2">
              <Input
                value={editando.nombre}
                onChange={(e) => setEditando({ ...editando, nombre: e.target.value })}
                placeholder="Residencial zona centro"
              />
            </Field>
            <Field label="Alcance">
              <Select
                value={editando.olt_id ?? ''}
                onChange={(e) => setEditando({ ...editando, olt_id: e.target.value || null })}
              >
                <option value="">Todas las OLTs</option>
                {olt && <option value={olt.id}>Solo {olt.nombre}</option>}
              </Select>
            </Field>

            <Field label="Perfil de línea">
              <Select
                value={editando.line_profile_id ?? ''}
                onChange={(e) => {
                  const p = (perfiles?.line ?? []).find((x) => String(x.id) === e.target.value)
                  setEditando({
                    ...editando,
                    line_profile_id: e.target.value,
                    line_profile_nombre: p?.nombre ?? '',
                  })
                }}
              >
                <option value="">— elegí —</option>
                {(perfiles?.line ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} · {p.nombre}
                  </option>
                ))}
              </Select>
            </Field>

            {/* El de servicio depende del MODELO de la ONT, no de la zona ni
                del plan. En este equipo los perfiles están nombrados como los
                modelos y hay veintidós: fijar uno en la plantilla le pondría el
                perfil de un Huawei a un GN256VH, y la ONT queda online con
                parte de sus puertos sin configurar. */}
            <Field
              label="Perfil de servicio"
              hint="lo normal es dejarlo automático: depende del modelo de cada ONT"
            >
              <Select
                value={editando.srv_profile_id ?? ''}
                onChange={(e) => {
                  const p = (perfiles?.srv ?? []).find((x) => String(x.id) === e.target.value)
                  setEditando({
                    ...editando,
                    srv_profile_id: e.target.value,
                    srv_profile_nombre: p?.nombre ?? '',
                  })
                }}
              >
                <option value="">Automático, según el modelo de la ONT</option>
                {(perfiles?.srv ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} · {p.nombre}
                    {p.usos ? ` (${p.usos})` : ''}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="VLAN">
              <Input
                type="number"
                value={editando.vlan ?? ''}
                onChange={(e) => setEditando({ ...editando, vlan: e.target.value })}
              />
            </Field>
            <Field label="Gemport">
              <Input
                type="number"
                value={editando.gemport ?? 1}
                onChange={(e) => setEditando({ ...editando, gemport: e.target.value })}
              />
            </Field>
            <Field label="Plan">
              <Select
                value={editando.plan_id ?? ''}
                onChange={(e) => setEditando({ ...editando, plan_id: e.target.value })}
              >
                <option value="">Sin plan</option>
                {planes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Zona">
              <Input
                value={editando.zona ?? ''}
                onChange={(e) => setEditando({ ...editando, zona: e.target.value })}
              />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={Boolean(editando.predeterminado)}
              onChange={(e) => setEditando({ ...editando, predeterminado: e.target.checked })}
              className="accent-sky-500"
            />
            Ofrecerla marcada al abrir el formulario de autorización
          </label>

          {editando.olt_id === null && (
            <Aviso>
              Al usarla en una OLT, los perfiles se buscan por <b>nombre</b>. Si esa OLT no tiene
              un perfil con ese nombre, avisa en vez de usar el número — que ahí puede ser otro
              perfil distinto.
            </Aviso>
          )}

          <div className="flex gap-2">
            <Button
              variante="primario"
              icon={Check}
              cargando={guardando}
              disabled={!editando.nombre?.trim()}
              onClick={guardar}
            >
              Guardar
            </Button>
            <Button variante="fantasma" onClick={() => setEditando(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {lista.length === 0 ? (
        <p className="px-1 py-6 text-center text-sm text-slate-500">
          Todavía no hay plantillas.
        </p>
      ) : (
        <Table
          columnas={['Nombre', 'Alcance', 'Perfiles', 'VLAN', 'Plan', '']}
          filas={lista}
          renderFila={(p) => (
            <tr key={p.id} className="text-slate-300">
              <td className="px-3 py-2 text-sm text-slate-100">
                <span className="flex items-center gap-1.5">
                  {p.predeterminado && <Star size={12} className="text-amber-400" />}
                  {p.nombre}
                </span>
                {p.zona && <span className="text-[11px] text-slate-500">{p.zona}</span>}
              </td>
              <td className="px-3 py-2 text-xs">
                {p.olt_id ? <Badge color="azul">esta OLT</Badge> : <Badge color="gris">todas</Badge>}
              </td>
              <td className="px-3 py-2 text-xs text-slate-400">
                {p.line_profile_nombre ?? p.line_profile_id ?? '—'} /{' '}
                {p.srv_profile_nombre ?? p.srv_profile_id ?? '—'}
              </td>
              <td className="px-3 py-2 font-mono text-xs">{p.vlan ?? '—'}</td>
              <td className="px-3 py-2 text-xs">{p.plan_id ? '✓' : '—'}</td>
              <td className="px-3 py-2 text-right">
                <div className="flex justify-end gap-1.5">
                  <Button variante="fantasma" icon={Pencil} onClick={() => setEditando(p)}>
                    Editar
                  </Button>
                  <Button variante="fantasma" icon={Trash2} onClick={() => borrar(p)}>
                    Borrar
                  </Button>
                </div>
              </td>
            </tr>
          )}
        />
      )}
    </div>
  )
}
