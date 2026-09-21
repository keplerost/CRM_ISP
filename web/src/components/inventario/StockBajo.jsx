import { useEffect, useState } from 'react'
import { AlertTriangle, PackageX, Pencil, Trash2, TriangleAlert } from 'lucide-react'
import { Badge, Button, Card, ErrorBanner, Field, Input, Modal, Select, SkeletonTabla } from '../ui'
import { inventarioApi } from '../../lib/inventario'

/**
 * Lo que se está por acabar.
 *
 * ── Por qué se agrupa por almacén ──
 *
 * Porque es lo que hay que hacer con la respuesta. El pedido de material sale de
 * una bodega o de la mochila de un técnico; un total sumado de todos lados no le
 * dice a nadie qué cargar en la camioneta. Un renglón "Conector SC/APC: 4" sin
 * decir dónde obliga a ir a mirar almacén por almacén, que es justo lo que esta
 * pantalla viene a evitar.
 *
 * ── Por qué el mínimo se edita acá ──
 *
 * Porque el momento en que a alguien le importa cuál es el mínimo es cuando ve
 * un aviso que le parece mal: o suena y no debería, o no suena y debería. Tener
 * que ir a otra pantalla a corregirlo hace que no se corrija nunca, y una alerta
 * mal calibrada que nadie ajusta termina ignorada.
 */
export default function StockBajo({ almacenes = [], articulos = [] }) {
  const [filas, setFilas] = useState(null)
  const [error, setError] = useState(null)
  const [editando, setEditando] = useState(null)
  const [nuevo, setNuevo] = useState(null)

  const recargar = () =>
    inventarioApi.stockBajo().then(setFilas).catch(setError)

  useEffect(() => {
    recargar()
  }, [])

  if (error) return <ErrorBanner error={error} onCerrar={() => setError(null)} />
  if (!filas) return <SkeletonTabla filas={4} columnas={5} />

  // Agrupado por almacén, con lo agotado primero adentro de cada uno.
  const porAlmacen = new Map()
  for (const f of filas) {
    if (!porAlmacen.has(f.almacen_id)) {
      porAlmacen.set(f.almacen_id, { almacen: f.almacen, tipo: f.almacen_tipo, tecnico: f.tecnico, items: [] })
    }
    porAlmacen.get(f.almacen_id).items.push(f)
  }

  const agotados = filas.filter((f) => f.agotado).length

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-400">
          {filas.length === 0 ? (
            'Nada está por acabarse.'
          ) : (
            <>
              <b className="text-slate-200">{filas.length}</b> en el mínimo o por debajo
              {agotados > 0 && (
                <>
                  {' · '}
                  <b className="text-rose-400">{agotados} sin nada</b>
                </>
              )}
            </>
          )}
        </div>
        <Button
          icon={Pencil}
          className="py-1.5 text-xs"
          onClick={() => setNuevo({ almacen_id: '', articulo_id: '', minimo: '', reponer: '' })}
        >
          Poner un mínimo
        </Button>
      </div>

      {filas.length === 0 && (
        <Card>
          <div className="p-6 text-center text-sm text-slate-500">
            <PackageX size={28} className="mx-auto mb-2 text-slate-700" />
            Nada llegó a su mínimo.
            <p className="mt-1 text-xs text-slate-600">
              Si esperabas ver algo acá, revisá que el artículo tenga mínimo cargado: sin mínimo no
              se controla.
            </p>
          </div>
        </Card>
      )}

      {[...porAlmacen.values()].map((g) => (
        <Card key={g.almacen}>
          <div className="border-b border-slate-800 px-4 py-2.5">
            <p className="text-sm font-medium text-slate-100">{g.almacen}</p>
            <p className="text-[11px] text-slate-500">
              {g.tipo === 'tecnico' ? `Mochila de ${g.tecnico ?? 'un técnico'}` : g.tipo}
              {' · '}
              {g.items.length} {g.items.length === 1 ? 'artículo' : 'artículos'}
            </p>
          </div>

          <table className="w-full text-xs">
            <tbody>
              {g.items.map((f) => (
                <tr key={f.articulo_id} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-4 py-2">
                    <span className="text-slate-200">{f.articulo}</span>
                    {f.codigo && <span className="ml-1.5 font-mono text-[11px] text-slate-600">{f.codigo}</span>}
                    {/* De dónde salió el mínimo. Sin esto, un aviso que sorprende
                        no se puede explicar sin ir a buscar a dos lados. */}
                    {!f.minimo_propio && (
                      <span className="ml-1.5 text-[11px] text-slate-600">(mínimo del artículo)</span>
                    )}
                  </td>
                  <td className="px-2 py-2 tabular-nums">
                    {f.agotado ? (
                      <Badge color="rojo">
                        <AlertTriangle size={10} className="mr-1 inline" />
                        sin nada
                      </Badge>
                    ) : (
                      <span className="text-amber-400">
                        {f.cantidad} {f.unidad}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 tabular-nums text-slate-500">
                    mínimo {f.minimo}
                  </td>
                  <td className="px-2 py-2 tabular-nums text-slate-300">
                    {Number(f.sugerido) > 0 ? `pedir ${f.sugerido}` : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      title="Cambiar el mínimo de este artículo en este almacén"
                      onClick={() =>
                        setEditando({
                          almacen_id: f.almacen_id,
                          articulo_id: f.articulo_id,
                          almacen: f.almacen,
                          articulo: f.articulo,
                          minimo: f.minimo ?? '',
                          reponer: f.minimo_propio ? (f.sugerido ?? '') : '',
                          propio: f.minimo_propio,
                        })
                      }
                      className="text-slate-500 hover:text-slate-200"
                    >
                      <Pencil size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}

      <FormularioMinimo
        valor={editando ?? nuevo}
        esNuevo={!editando}
        almacenes={almacenes}
        articulos={articulos}
        onCerrar={() => {
          setEditando(null)
          setNuevo(null)
        }}
        onGuardado={() => {
          setEditando(null)
          setNuevo(null)
          recargar()
        }}
      />
    </div>
  )
}

function FormularioMinimo({ valor, esNuevo, almacenes, articulos, onCerrar, onGuardado }) {
  const [form, setForm] = useState(valor)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => setForm(valor), [valor])

  if (!form) return null

  const cambiar = (campo, v) => setForm((f) => ({ ...f, [campo]: v }))

  const guardar = async () => {
    setGuardando(true)
    setError(null)
    try {
      await inventarioApi.guardarMinimo(form)
      onGuardado()
    } catch (e) {
      setError(e)
    } finally {
      setGuardando(false)
    }
  }

  const quitar = async () => {
    setGuardando(true)
    setError(null)
    try {
      await inventarioApi.borrarMinimo(form)
      onGuardado()
    } catch (e) {
      setError(e)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Modal abierto titulo={esNuevo ? 'Poner un mínimo' : `Mínimo de ${form.articulo}`} onCerrar={onCerrar}>
      <div className="space-y-3">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {esNuevo ? (
          <>
            <Field label="Almacén">
              <Select value={form.almacen_id} onChange={(e) => cambiar('almacen_id', e.target.value)}>
                <option value="">Elegí el almacén…</option>
                {almacenes.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nombre}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Artículo">
              <Select value={form.articulo_id} onChange={(e) => cambiar('articulo_id', e.target.value)}>
                <option value="">Elegí el artículo…</option>
                {articulos.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nombre}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        ) : (
          <p className="text-xs text-slate-400">
            {form.articulo} en <b className="text-slate-200">{form.almacen}</b>
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Avisar cuando quede en" hint="0 = avisar recién cuando se acabe">
            <Input
              type="number"
              min={0}
              value={form.minimo}
              onChange={(e) => cambiar('minimo', e.target.value)}
            />
          </Field>
          <Field label="Cuánto pedir" hint="opcional; si no, se pide lo que falta">
            <Input
              type="number"
              min={1}
              value={form.reponer ?? ''}
              onChange={(e) => cambiar('reponer', e.target.value)}
            />
          </Field>
        </div>

        {/* La razón de que exista este formulario, dicha una sola vez y donde se
            está tomando la decisión. */}
        <p className="text-[11px] leading-snug text-slate-500">
          <TriangleAlert size={11} className="mr-1 inline text-slate-600" />
          Este mínimo vale solo para este almacén. La bodega y la mochila del técnico no se miden
          igual: la bodega avisa a las 20 ONTs y el técnico a las 2. Un almacén de técnico sin
          mínimo propio no alerta.
        </p>

        <div className="flex justify-between pt-1">
          <div>
            {!esNuevo && form.propio && (
              <Button variante="fantasma" icon={Trash2} cargando={guardando} onClick={quitar}>
                Dejar de controlarlo acá
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variante="fantasma" onClick={onCerrar}>
              Cancelar
            </Button>
            <Button
              variante="primario"
              cargando={guardando}
              disabled={!form.almacen_id || !form.articulo_id || form.minimo === ''}
              onClick={guardar}
            >
              Guardar
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
