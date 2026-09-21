import { useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { Landmark, Plus, Trash2 } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useTabla } from '../../lib/useTabla'
import { Aviso, Badge, Button, Card, Cargando, ErrorBanner, Field, Input, Select, Table } from '../ui'

/**
 * Cuentas donde entra la plata.
 *
 * La caja de la oficina es una cuenta más. Tratarla igual que un banco hace que
 * el arqueo de caja y la conciliación bancaria se resuelvan con la misma
 * consulta, en vez de tener el efectivo como un caso aparte.
 */

const VACIA = { nombre: '', tipo: 'banco', banco: '', numero: '', titular: '', usuario_id: '' }

const COLOR_TIPO = { efectivo: 'verde', banco: 'azul', billetera: 'ambar', otro: 'gris' }

export default function CuentasPago() {
  const confirmar = useConfirmar()
  const { filas, cargando, error, insertar, actualizar, eliminar, setError } = useTabla(
    'cuentas_pago',
    { orderBy: 'nombre', ascending: true },
  )

  const [form, setForm] = useState(VACIA)
  const [guardando, setGuardando] = useState(false)

  /**
   * A quién se le puede asignar una caja.
   *
   * Solo el personal activo: asignarle la caja a alguien que ya no trabaja acá
   * dejaría plata a nombre de nadie.
   */
  const [personas, setPersonas] = useState([])
  useEffect(() => {
    supabase
      .from('usuarios_sistema')
      .select('id, nombre, apellido, rol')
      .eq('activo', true)
      .order('nombre')
      .then(({ data }) => setPersonas(data ?? []))
  }, [])

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  async function agregar(e) {
    e.preventDefault()
    setGuardando(true)
    try {
      await insertar({
        nombre: form.nombre.trim(),
        tipo: form.tipo,
        banco: form.banco.trim() || null,
        numero: form.numero.trim() || null,
        titular: form.titular.trim() || null,
        // Solo las cajas tienen dueño: una cuenta del banco es del ISP, no de
        // quien la usa para registrar una transferencia.
        usuario_id: form.tipo === 'efectivo' ? (form.usuario_id || null) : null,
      })
      setForm(VACIA)
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Card
      title="Cuentas de cobro"
      subtitle="Las opciones que aparecen al registrar un pago"
      icon={Landmark}
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <form onSubmit={agregar} className="grid items-end gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="Nombre" className="lg:col-span-2">
            <Input
              value={form.nombre}
              onChange={set('nombre')}
              placeholder="Pichincha Ahorros"
              required
            />
          </Field>
          <Field label="Tipo">
            <Select value={form.tipo} onChange={set('tipo')}>
              <option value="banco">Banco</option>
              <option value="efectivo">Efectivo</option>
              <option value="billetera">Billetera digital</option>
              <option value="otro">Otro</option>
            </Select>
          </Field>
          <Field label="Banco">
            <Input value={form.banco} onChange={set('banco')} />
          </Field>
          {/* El dueño solo tiene sentido en una caja: una cuenta del banco es del
              ISP, no de quien registra la transferencia. */}
          {form.tipo === 'efectivo' ? (
            <Field label="De quién es" hint="Cada cobrador con su caja">
              <Select value={form.usuario_id} onChange={set('usuario_id')}>
                <option value="">De la oficina</option>
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {[p.nombre, p.apellido].filter(Boolean).join(' ')}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="Número de cuenta">
              <Input value={form.numero} onChange={set('numero')} />
            </Field>
          )}
          <div className="pb-2">
            <Button type="submit" variante="primario" icon={Plus} cargando={guardando} className="w-full">
              Agregar
            </Button>
          </div>
        </form>

        {cargando ? (
          <Cargando />
        ) : filas.length === 0 ? (
          <Aviso>
            Todavía no hay cuentas. Cargá al menos una —la caja de la oficina alcanza— para poder
            registrar cobros.
          </Aviso>
        ) : (
          <Table
            columnas={['Cuenta', 'Tipo', 'De quién', 'Banco', 'Número', 'Estado', '']}
            filas={filas}
            renderFila={(c) => (
              <tr key={c.id} className="text-slate-300">
                <td className="px-3 py-2 font-medium text-slate-100">{c.nombre}</td>
                <td className="px-3 py-2">
                  <Badge color={COLOR_TIPO[c.tipo] ?? 'gris'}>{c.tipo}</Badge>
                </td>
                {/* Se puede cambiar de dueño sin borrar la caja: alguien se va,
                    entra otro, y el histórico de esa caja tiene que seguir
                    existiendo para poder explicar los arqueos viejos. */}
                <td className="px-3 py-2">
                  {c.tipo === 'efectivo' ? (
                    <select
                      value={c.usuario_id ?? ''}
                      onChange={(e) =>
                        actualizar(c.id, { usuario_id: e.target.value || null }).catch(setError)
                      }
                      className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
                    >
                      <option value="">De la oficina</option>
                      {personas.map((p) => (
                        <option key={p.id} value={p.id}>
                          {[p.nombre, p.apellido].filter(Boolean).join(' ')}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs text-slate-600">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">{c.banco || '—'}</td>
                <td className="px-3 py-2 font-mono text-xs">{c.numero || '—'}</td>
                <td className="px-3 py-2">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
                    <input
                      type="checkbox"
                      checked={c.activa}
                      onChange={() => actualizar(c.id, { activa: !c.activa }).catch(setError)}
                      className="accent-sky-500"
                    />
                    {c.activa ? 'activa' : 'inactiva'}
                  </label>
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end">
                    <Button
                      variante="fantasma"
                      icon={Trash2}
                      title="Solo se puede borrar una cuenta sin pagos registrados"
                      onClick={async () => {
                        if (
                          await confirmar(
                            `¿Eliminar la cuenta "${c.nombre}"?\n\n` +
                              'Si ya tiene pagos, conviene desactivarla en vez de borrarla: así deja de ' +
                              'aparecer al cobrar pero los cobros viejos siguen diciendo a dónde entró la plata.',
                          )
                        )
                          eliminar(c.id).catch(setError)
                      }}
                    />
                  </div>
                </td>
              </tr>
            )}
          />
        )}
      </div>
    </Card>
  )
}
