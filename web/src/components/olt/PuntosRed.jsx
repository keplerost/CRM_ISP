import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { Antenna, Plus, Trash2 } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useTabla } from '../../lib/useTabla'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Field,
  Input,
  Select,
  Table,
} from '../ui'

/**
 * Puntos de red: cajas NAP, antenas y torres.
 *
 * Es de lo que cuelga cada abonado. Una caja NAP y un AP de radioenlace son lo
 * mismo desde la ficha del cliente —el punto del que se alimenta—, así que
 * viven en la misma tabla y se administran acá juntos.
 *
 * La capacidad importa: es lo que permite ver de un vistazo qué caja está llena
 * antes de mandar al técnico a colgar a alguien más.
 */

const TIPOS = [
  { valor: 'nap', label: 'Caja NAP' },
  { valor: 'antena', label: 'Antena / AP' },
  { valor: 'torre', label: 'Torre' },
  { valor: 'switch', label: 'Switch' },
  { valor: 'otro', label: 'Otro' },
]

const COLOR_TIPO = { nap: 'azul', antena: 'verde', torre: 'ambar', switch: 'gris', otro: 'gris' }

const VACIO = { nombre: '', tipo: 'nap', capacidad: '', direccion: '', olt_id: '', puerto_pon: '' }

export default function PuntosRed() {
  const confirmar = useConfirmar()
  const { filas: olts } = useTabla('olts', { orderBy: 'nombre', ascending: true })

  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [form, setForm] = useState(VACIO)
  const [guardando, setGuardando] = useState(false)

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  const recargar = useCallback(async () => {
    setCargando(true)
    const { data, error: err } = await supabase.from('v_puntos_red').select('*').order('nombre')
    if (err) setError(err)
    setFilas(data ?? [])
    setCargando(false)
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  async function agregar(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)
    try {
      const { error: err } = await supabase.from('puntos_red').insert({
        nombre: form.nombre.trim(),
        tipo: form.tipo,
        capacidad: form.capacidad === '' ? null : Number(form.capacidad),
        direccion: form.direccion.trim() || null,
        olt_id: form.olt_id || null,
        puerto_pon: form.puerto_pon.trim() || null,
      })
      if (err) throw err
      setForm(VACIO)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  async function eliminar(p) {
    if (p.clientes > 0) {
      return setError(
        new Error(
          `"${p.nombre}" tiene ${p.clientes} abonado(s) colgando. Movelos antes de borrarla, o desactivala.`,
        ),
      )
    }
    if (!await confirmar(`¿Eliminar "${p.nombre}"?`)) return

    const { error: err } = await supabase.from('puntos_red').delete().eq('id', p.id)
    if (err) setError(err)
    else await recargar()
  }

  async function alternarActivo(p) {
    const { error: err } = await supabase
      .from('puntos_red')
      .update({ activo: !p.activo })
      .eq('id', p.id)
    if (err) setError(err)
    else await recargar()
  }

  return (
    <Card
      title="Puntos de red"
      subtitle="Cajas NAP, antenas y torres de las que cuelgan los abonados"
      icon={Antenna}
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <form onSubmit={agregar} className="grid items-end gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="Nombre">
            <Input value={form.nombre} onChange={set('nombre')} placeholder="NAP-01 San Gerardo" required />
          </Field>
          <Field label="Tipo">
            <Select value={form.tipo} onChange={set('tipo')}>
              {TIPOS.map((t) => (
                <option key={t.valor} value={t.valor}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Capacidad" hint="Puertos o abonados">
            <Input type="number" min={1} value={form.capacidad} onChange={set('capacidad')} />
          </Field>
          <Field label="OLT" hint="Si es una caja de fibra">
            <Select value={form.olt_id} onChange={set('olt_id')}>
              <option value="">— ninguna —</option>
              {olts.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.nombre}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Puerto PON">
            <Input value={form.puerto_pon} onChange={set('puerto_pon')} placeholder="0/1/2" />
          </Field>
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
            Todavía no hay puntos de red. Cargá las cajas NAP y las antenas para poder asignarlas en
            la ficha de cada abonado.
          </Aviso>
        ) : (
          <Table
            columnas={['Nombre', 'Tipo', 'Ocupación', 'OLT / Puerto', 'Dirección', 'Estado', '']}
            filas={filas}
            renderFila={(p) => (
              <tr key={p.id} className="text-slate-300">
                <td className="px-3 py-2 font-medium text-slate-100">{p.nombre}</td>
                <td className="px-3 py-2">
                  <Badge color={COLOR_TIPO[p.tipo] ?? 'gris'}>{p.tipo}</Badge>
                </td>
                <td className="px-3 py-2 text-xs">
                  {p.capacidad ? (
                    <>
                      <b className={p.disponibles === 0 ? 'text-red-400' : 'text-slate-200'}>
                        {p.clientes}/{p.capacidad}
                      </b>
                      <span className="ml-1 text-slate-500">
                        {p.disponibles === 0 ? '· llena' : `· ${p.disponibles} libres`}
                      </span>
                    </>
                  ) : (
                    <span className="text-slate-500">{p.clientes} abonado(s)</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-slate-400">{p.puerto_pon ?? '—'}</td>
                <td className="px-3 py-2 text-xs">{p.direccion ?? '—'}</td>
                <td className="px-3 py-2">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
                    <input
                      type="checkbox"
                      checked={p.activo}
                      onChange={() => alternarActivo(p)}
                      className="accent-sky-500"
                    />
                    {p.activo ? 'activo' : 'inactivo'}
                  </label>
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end">
                    <Button variante="fantasma" icon={Trash2} onClick={() => eliminar(p)} />
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
