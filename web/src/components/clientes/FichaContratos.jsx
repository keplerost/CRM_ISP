import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { dineroCero as dinero } from '../../lib/formato'
import { Link } from 'react-router-dom'
import { ExternalLink, FileSignature, Plus, Printer, Square, Trash2, X } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { abrirPdf } from '../../lib/pdf'
import { useTabla } from '../../lib/useTabla'
import { codigoLargo } from '../../lib/abonados'
import BuscadorCliente from '../pagos/BuscadorCliente'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  Field,
  Input,
  Select,
  Stat,
  Table,
  Textarea,
} from '../ui'

/**
 * Contratos del abonado.
 *
 * Un cliente tiene un solo contrato vigente: si cambia de plan, el anterior se
 * termina y se firma otro. La base lo garantiza con un índice, así que no puede
 * quedar ambiguo cuál es el precio que rige.
 */

const COLOR = { vigente: 'verde', terminado: 'gris', anulado: 'rojo', suspendido: 'ambar' }

const hoy = () => new Date().toISOString().slice(0, 10)
const fecha = (f) => (f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString() : '—')

const VACIO = {
  numero: '',
  plan_id: '',
  fecha_inicio: hoy(),
  fecha_fin: '',
  permanencia_meses: '',
  precio_mensual: '',
  dia_pago: '',
  documento_url: '',
  notas: '',
}

export default function FichaContratos({ cliente = null, onError, onGuardado }) {
  const confirmar = useConfirmar()
  const { filas: planes } = useTabla('planes_velocidad', { orderBy: 'nombre', ascending: true })

  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [form, setForm] = useState(VACIO)
  const [destino, setDestino] = useState(cliente)
  const [guardando, setGuardando] = useState(false)

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  const recargar = useCallback(async () => {
    setCargando(true)
    let consulta = supabase.from('v_contratos').select('*').order('fecha_inicio', { ascending: false })
    if (cliente) consulta = consulta.eq('client_id', cliente.id)

    const { data, error } = await consulta
    if (error) onError?.(error)
    setFilas(data ?? [])
    setCargando(false)
  }, [cliente, onError])

  useEffect(() => {
    recargar()
  }, [recargar])

  /** Al elegir el plan, el precio pasa a ser el de ese plan. Se puede editar. */
  function elegirPlan(e) {
    const id = e.target.value
    const plan = planes.find((p) => p.id === id)
    setForm((f) => ({
      ...f,
      plan_id: id,
      precio_mensual: plan ? String(plan.precio) : f.precio_mensual,
    }))
  }

  async function crear(e) {
    e.preventDefault()
    const paraQuien = cliente ?? destino
    if (!paraQuien) return onError?.(new Error('Elegí de qué cliente es el contrato'))

    setGuardando(true)
    onError?.(null)
    try {
      const { data: sesion } = await supabase.auth.getUser()
      const { error } = await supabase.from('contratos').insert({
        client_id: paraQuien.id,
        // Sin número escrito se usa el del abonado: es el identificador con el
        // que se lo busca en papel y el que ya está impreso en su carpeta.
        numero: form.numero.trim() || codigoLargo(paraQuien.codigo) || null,
        plan_id: form.plan_id || paraQuien.plan_id || null,
        fecha_inicio: form.fecha_inicio,
        fecha_fin: form.fecha_fin || null,
        permanencia_meses: form.permanencia_meses === '' ? null : Number(form.permanencia_meses),
        precio_mensual:
          form.precio_mensual === ''
            ? Number(paraQuien.precio_mensual ?? 0)
            : Number(form.precio_mensual),
        dia_pago:
          form.dia_pago === ''
            ? (paraQuien.dia_facturacion ?? null)
            : Number(form.dia_pago),
        documento_url: form.documento_url.trim() || null,
        notas: form.notas.trim() || null,
        created_by: sesion?.user?.id ?? null,
      })

      if (error) {
        if (error.code === '23505') {
          throw new Error(
            'Ese cliente ya tiene un contrato vigente. Terminá el anterior antes de firmar otro.',
          )
        }
        throw error
      }

      setForm(VACIO)
      if (!cliente) setDestino(null)
      await recargar()
      await onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  async function terminar(c) {
    if (
      !await confirmar(
        `¿Terminar el contrato de ${c.cliente}?\n\n` +
          'Deja de ser el vigente y recién ahí se le puede cargar uno nuevo.',
      )
    )
      return

    const { error } = await supabase
      .from('contratos')
      .update({ estado: 'terminado', fecha_fin: c.fecha_fin ?? hoy() })
      .eq('id', c.id)

    if (error) onError?.(error)
    else {
      await recargar()
      await onGuardado?.()
    }
  }

  async function eliminar(c) {
    if (!await confirmar(`¿Eliminar el contrato ${c.numero ?? ''} de ${c.cliente}?`)) return
    const { error } = await supabase.from('contratos').delete().eq('id', c.id)
    if (error) onError?.(error)
    else {
      await recargar()
      await onGuardado?.()
    }
  }

  const vigentes = filas.filter((c) => c.estado === 'vigente')

  return (
    <div className="space-y-4">
      {!cliente && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Contratos" valor={filas.length} icon={FileSignature} />
          <Stat label="Vigentes" valor={vigentes.length} color="text-emerald-400" />
          <Stat
            label="Facturación mensual comprometida"
            valor={dinero(vigentes.reduce((s, c) => s + Number(c.precio_mensual ?? 0), 0))}
          />
        </div>
      )}

      <Card title="Nuevo contrato" icon={Plus}>
        <form onSubmit={crear} className="space-y-4">
          {!cliente &&
            (destino ? (
              <div className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
                <span className="text-sm text-slate-100">{destino.nombre}</span>
                <Button type="button" variante="fantasma" icon={X} onClick={() => setDestino(null)}>
                  Cambiar
                </Button>
              </div>
            ) : (
              <BuscadorCliente onElegir={setDestino} autoFocus={false} />
            ))}

          {(cliente || destino) && (
            <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
              <Field
                label="N° de contrato"
                hint={
                  (cliente ?? destino)?.codigo
                    ? `En blanco toma el del abonado: ${codigoLargo((cliente ?? destino).codigo)}`
                    : undefined
                }
              >
                <Input
                  value={form.numero}
                  onChange={set('numero')}
                  placeholder={codigoLargo((cliente ?? destino)?.codigo) || 'CT-0001'}
                />
              </Field>
              <Field label="Plan">
                <Select value={form.plan_id} onChange={elegirPlan}>
                  <option value="">— el del cliente —</option>
                  {planes.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre} (${Number(p.precio).toFixed(2)})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Precio mensual">
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  value={form.precio_mensual}
                  onChange={set('precio_mensual')}
                />
              </Field>
              <Field label="Día de pago">
                <Select value={form.dia_pago} onChange={set('dia_pago')}>
                  <option value="">— el del cliente —</option>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      {String(d).padStart(2, '0')} de cada mes
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Inicio">
                <Input type="date" value={form.fecha_inicio} onChange={set('fecha_inicio')} required />
              </Field>
              <Field label="Fin" hint="Vacío = sin plazo">
                <Input type="date" value={form.fecha_fin} onChange={set('fecha_fin')} />
              </Field>
              <Field label="Permanencia (meses)">
                <Input
                  type="number"
                  min={0}
                  value={form.permanencia_meses}
                  onChange={set('permanencia_meses')}
                />
              </Field>
              <Field label="Documento firmado" hint="Enlace a Drive o carpeta compartida">
                <Input value={form.documento_url} onChange={set('documento_url')} />
              </Field>

              <Field label="Notas" className="sm:col-span-2 lg:col-span-3">
                <Textarea rows={2} value={form.notas} onChange={set('notas')} />
              </Field>

              <div className="flex items-end pb-1">
                <Button
                  type="submit"
                  variante="primario"
                  icon={Plus}
                  cargando={guardando}
                  className="w-full"
                >
                  Registrar
                </Button>
              </div>
            </div>
          )}
        </form>
      </Card>

      <Card title={cliente ? 'Contratos del cliente' : 'Contratos'} icon={FileSignature}>
        {cargando ? (
          <Cargando />
        ) : filas.length === 0 ? (
          <Aviso>Todavía no hay contratos cargados.</Aviso>
        ) : (
          <Table
            columnas={[
              ...(cliente ? [] : ['Cliente']),
              'N°',
              'Plan',
              'Vigencia',
              'Precio',
              'Estado',
              '',
            ]}
            filas={filas}
            renderFila={(c) => (
              <tr key={c.id} className={`text-slate-300 ${c.vencido ? 'bg-amber-500/5' : ''}`}>
                {!cliente && (
                  <td className="px-3 py-2">
                    <Link
                      to={`/clientes/${c.client_id}`}
                      className="text-slate-100 hover:text-sky-400 hover:underline"
                    >
                      {c.cliente ?? '—'}
                    </Link>
                  </td>
                )}
                <td className="px-3 py-2 font-mono text-xs">{c.numero ?? '—'}</td>
                <td className="px-3 py-2 text-xs">{c.plan ?? '—'}</td>
                <td className="px-3 py-2 text-xs">
                  {fecha(c.fecha_inicio)} → {c.fecha_fin ? fecha(c.fecha_fin) : 'sin plazo'}
                  {c.vencido && <span className="ml-2 text-amber-400">vencido</span>}
                  {c.permanencia_meses ? (
                    <span className="block text-slate-500">
                      permanencia {c.permanencia_meses} meses
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2">{dinero(c.precio_mensual)}</td>
                <td className="px-3 py-2">
                  <Badge color={COLOR[c.estado] ?? 'gris'}>{c.estado}</Badge>
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    {/*
                      El contrato para imprimir y hacer firmar. Sale con el texto
                      que tenga la plantilla en Ajustes → Editor de plantillas, y
                      con las condiciones de ESTE contrato: reimprimir uno viejo
                      no le cambia el precio al que lo firmó.
                    */}
                    <Button
                      variante="fantasma"
                      icon={Printer}
                      title="Imprimir el contrato para firmar"
                      onClick={() =>
                        abrirPdf(() =>
                          api.documentos.contrato(c.client_id, { contratoId: c.id }),
                        ).catch(onError)
                      }
                    >
                      Imprimir
                    </Button>
                    {c.documento_url && (
                      <a
                        href={c.documento_url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
                        title="Abrir el documento firmado"
                      >
                        <ExternalLink size={15} />
                      </a>
                    )}
                    {c.estado === 'vigente' && (
                      <Button
                        variante="fantasma"
                        icon={Square}
                        title="Terminar el contrato"
                        onClick={() => terminar(c)}
                      >
                        Terminar
                      </Button>
                    )}
                    <Button variante="fantasma" icon={Trash2} onClick={() => eliminar(c)} />
                  </div>
                </td>
              </tr>
            )}
          />
        )}
      </Card>
    </div>
  )
}
