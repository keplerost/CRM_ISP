import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { dineroCero as dinero } from '../../lib/formato'
import { Link } from 'react-router-dom'
import { Check, Pencil, Send, X } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { useTabla } from '../../lib/useTabla'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  Field,
  Input,
  Modal,
  Select,
  Stat,
  Table,
} from '../ui'

/**
 * Cobros que esperan comprobante.
 *
 * Es la bandeja del cierre de jornada. Durante el día se cobra y se tipea el
 * número de comprobante del banco —que a veces sale mal—; acá se revisa, se
 * corrige y recién entonces sale todo junto al SRI.
 *
 * Nada se envía solo. El botón es explícito porque una factura autorizada no se
 * puede borrar: se anula con una nota de crédito, que es un trámite aparte.
 */

const fecha = (f) => (f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString() : '—')

const FORMAS = [
  { valor: 'efectivo', label: 'Efectivo' },
  { valor: 'transferencia', label: 'Transferencia' },
  { valor: 'deposito', label: 'Depósito' },
  { valor: 'tarjeta', label: 'Tarjeta' },
  { valor: 'otro', label: 'Otro' },
]

export default function PorFacturar({ onError }) {
  const confirmar = useConfirmar()
  const { filas: cuentas } = useTabla('cuentas_pago', { orderBy: 'nombre', ascending: true })

  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [elegidos, setElegidos] = useState(() => new Set())
  const [editando, setEditando] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [desde, setDesde] = useState('')

  const recargar = useCallback(async () => {
    setCargando(true)
    let consulta = supabase
      .from('v_pagos_por_facturar')
      .select('*')
      .order('fecha_pago', { ascending: false })
    if (desde) consulta = consulta.gte('fecha_pago', desde)

    const { data, error } = await consulta
    if (error) onError?.(error)
    setFilas(data ?? [])
    // Se preseleccionan los que están en condiciones de emitirse.
    setElegidos(new Set((data ?? []).filter((p) => !p.falta_identificacion).map((p) => p.id)))
    setCargando(false)
  }, [desde, onError])

  useEffect(() => {
    recargar()
  }, [recargar])

  function alternar(id) {
    setElegidos((prev) => {
      const s = new Set(prev)
      if (s.has(id)) s.delete(id)
      else s.add(id)
      return s
    })
  }

  /** Corrige el cobro antes de que se convierta en una factura. */
  async function guardarCorreccion(e) {
    e.preventDefault()
    setGuardando(true)
    onError?.(null)

    try {
      const { error } = await supabase
        .from('pagos')
        .update({
          n_transaccion: editando.n_transaccion?.trim() || null,
          monto: Number(editando.monto),
          forma_pago: editando.forma_pago,
          cuenta_id: editando.cuenta_id || null,
          fecha_pago: editando.fecha_pago,
          notas: editando.notas?.trim() || null,
        })
        .eq('id', editando.id)

      if (error) throw error
      setEditando(null)
      await recargar()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  /** Saca el cobro de la cola sin emitir: el abonado no quería factura. */
  async function noFacturar(p) {
    if (
      !await confirmar(
        `¿Sacar de la cola el cobro de ${p.cliente} por ${dinero(p.monto)}?\n\n` +
          'El cobro y su recibo quedan como están; simplemente no se le emite factura electrónica.',
      )
    )
      return

    const { error } = await supabase.from('pagos').update({ facturar: false }).eq('id', p.id)
    if (error) onError?.(error)
    else await recargar()
  }

  async function emitir() {
    const ids = [...elegidos]
    if (!ids.length) return onError?.(new Error('No hay cobros seleccionados'))

    const total = filas
      .filter((f) => elegidos.has(f.id))
      .reduce((s, f) => s + Number(f.total_facturar ?? f.monto), 0)

    if (
      !await confirmar(
        `Se van a emitir ${ids.length} factura(s) por ${dinero(total)} y enviarlas al SRI.\n\n` +
          'Una factura autorizada no se puede borrar: solo anular con nota de crédito.\n\n¿Continuar?',
      )
    )
      return

    setEnviando(true)
    setResultado(null)
    onError?.(null)
    try {
      const r = await api.sri.facturarLote({ pagos: ids, enviar: true })
      setResultado(r)
      await recargar()
    } catch (err) {
      onError?.(err)
    } finally {
      setEnviando(false)
    }
  }

  const seleccionados = filas.filter((f) => elegidos.has(f.id))
  const totalSeleccionado = seleccionados.reduce(
    (s, f) => s + Number(f.total_facturar ?? f.monto),
    0,
  )
  const conProblema = filas.filter((f) => f.falta_identificacion).length

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Cobros por facturar" valor={filas.length} icon={Send} />
        <Stat label="Seleccionados" valor={seleccionados.length} color="text-sky-400" />
        <Stat label="Total a facturar" valor={dinero(totalSeleccionado)} color="text-emerald-400" />
        <Stat
          label="Sin identificación"
          valor={conProblema}
          color={conProblema ? 'text-red-400' : 'text-slate-400'}
        />
      </div>

      {resultado && (
        <Card title="Resultado del envío al SRI">
          <div className="space-y-2">
            <Aviso tipo={resultado.conError ? 'alerta' : 'info'}>
              <b>{resultado.emitidas}</b> factura(s) autorizadas
              {resultado.conError > 0 && (
                <>
                  {' '}
                  y <b>{resultado.conError}</b> con problemas
                </>
              )}
              .
            </Aviso>
            {resultado.resultados?.map((r, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className={r.ok ? 'text-emerald-400' : 'text-red-400'}>
                  {r.ok ? '✓' : '✗'}
                </span>
                <span className="text-slate-300">
                  {r.cliente ?? r.pago_id}
                  {r.numero && <span className="ml-2 font-mono text-slate-400">{r.numero}</span>}
                  {r.error && <span className="ml-2 text-red-300">{r.error}</span>}
                  {r.aviso && <span className="ml-2 text-amber-300">{r.aviso}</span>}
                  {/* Cuando la factura quedó emitida pero sin enviar, hay que
                      reintentar el envío y no volver a emitirla. */}
                  {r.siguiente && (
                    <span className="mt-0.5 block text-amber-300">{r.siguiente}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card
        title="Cobros pendientes de facturar"
        subtitle="Revisá los números de comprobante antes de enviar"
        icon={Send}
        actions={
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={desde}
              onChange={(e) => setDesde(e.target.value)}
              title="Mostrar desde esta fecha"
              className="w-40 py-1.5 text-xs"
            />
            <Button
              variante="primario"
              icon={Send}
              cargando={enviando}
              disabled={!seleccionados.length}
              onClick={emitir}
            >
              Emitir y enviar al SRI ({seleccionados.length})
            </Button>
          </div>
        }
      >
        {cargando ? (
          <Cargando />
        ) : filas.length === 0 ? (
          <Aviso>
            No hay cobros esperando factura. Los cobros entran acá cuando se registran con{' '}
            <b>“Emitirle factura electrónica”</b> marcado.
          </Aviso>
        ) : (
          <>
            {conProblema > 0 && (
              <div className="mb-3">
                <Aviso tipo="alerta">
                  Hay <b>{conProblema}</b> cobro(s) de clientes sin cédula ni RUC. El SRI los
                  rechazaría, así que quedan sin seleccionar: completá la identificación en la ficha
                  del cliente.
                </Aviso>
              </div>
            )}

            <Table
              columnas={['', 'Recibo', 'Fecha', 'Cliente', 'N° transacción', 'Forma', 'Monto', '']}
              filas={filas}
              renderFila={(p) => (
                <tr
                  key={p.id}
                  className={`text-slate-300 ${p.falta_identificacion ? 'bg-red-500/5' : ''}`}
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={elegidos.has(p.id)}
                      onChange={() => alternar(p.id)}
                      disabled={p.falta_identificacion}
                      className="accent-sky-500"
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-100">
                    {String(p.numero ?? '').padStart(6, '0')}
                  </td>
                  <td className="px-3 py-2 text-xs">{fecha(p.fecha_pago)}</td>
                  <td className="px-3 py-2">
                    <Link
                      to={`/clientes/${p.client_id}`}
                      className="text-slate-100 hover:text-sky-400 hover:underline"
                    >
                      {p.cliente ?? p.cliente_nombre}
                    </Link>
                    <span className="block text-[11px] text-slate-500">
                      {p.identificacion ?? (
                        <span className="text-red-400">sin identificación</span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px]">
                    {p.n_transaccion ?? <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs capitalize">{p.forma_pago}</td>
                  <td className="px-3 py-2">
                    <b className="text-emerald-300">{dinero(p.total_facturar ?? p.monto)}</b>
                    {/* El comprobante sale por el mes completo. Cuando el
                        abonado pagó en dos veces, el último cobro es menor que
                        la factura y hay que poder ver de dónde sale el número. */}
                    {p.numero_factura && Number(p.total_facturar) !== Number(p.monto) && (
                      <span className="block text-[11px] text-slate-500">
                        factura N° {p.numero_factura} · este cobro {dinero(p.monto)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        variante="fantasma"
                        icon={Pencil}
                        title="Corregir el cobro antes de facturarlo"
                        onClick={() =>
                          setEditando({
                            id: p.id,
                            cliente: p.cliente ?? p.cliente_nombre,
                            n_transaccion: p.n_transaccion ?? '',
                            monto: p.monto,
                            forma_pago: p.forma_pago,
                            cuenta_id: p.cuenta_id ?? '',
                            fecha_pago: String(p.fecha_pago).slice(0, 10),
                            notas: p.notas ?? '',
                          })
                        }
                      >
                        Corregir
                      </Button>
                      <Button
                        variante="fantasma"
                        icon={X}
                        title="No emitirle factura por este cobro"
                        onClick={() => noFacturar(p)}
                      />
                    </div>
                  </td>
                </tr>
              )}
            />

            <p className="mt-3 text-[11px] text-slate-500">
              Se emite por el total de la factura del mes —el IVA sale de ahí, no se suma encima—
              y se firma y envía al SRI. Acá solo llegan los meses ya cancelados: mientras el
              abonado deba una parte, su cobro no entra a la cola. Los que fallen quedan en la
              lista para reintentar.
            </p>
          </>
        )}
      </Card>

      <Modal
        abierto={Boolean(editando)}
        titulo={`Corregir el cobro de ${editando?.cliente ?? ''}`}
        onCerrar={() => setEditando(null)}
      >
        {editando && (
          <form onSubmit={guardarCorreccion} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="N° de transacción" hint="El del comprobante del banco">
                <Input
                  value={editando.n_transaccion}
                  onChange={(e) =>
                    setEditando((p) => ({ ...p, n_transaccion: e.target.value }))
                  }
                  autoFocus
                  className="font-mono"
                />
              </Field>
              <Field label="Forma de pago">
                <Select
                  value={editando.forma_pago}
                  onChange={(e) => setEditando((p) => ({ ...p, forma_pago: e.target.value }))}
                >
                  {FORMAS.map((f) => (
                    <option key={f.valor} value={f.valor}>
                      {f.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Monto" hint="Es el total que se va a facturar, con IVA incluido">
                <Input
                  type="number"
                  step="0.01"
                  min={0.01}
                  value={editando.monto}
                  onChange={(e) => setEditando((p) => ({ ...p, monto: e.target.value }))}
                  required
                />
              </Field>
              <Field label="Cuenta">
                <Select
                  value={editando.cuenta_id}
                  onChange={(e) => setEditando((p) => ({ ...p, cuenta_id: e.target.value }))}
                >
                  <option value="">— sin cuenta —</option>
                  {cuentas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nombre}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Fecha del cobro" className="sm:col-span-2">
                <Input
                  type="date"
                  value={editando.fecha_pago}
                  onChange={(e) => setEditando((p) => ({ ...p, fecha_pago: e.target.value }))}
                />
              </Field>
            </div>

            <Aviso>
              Corregir acá cambia el cobro registrado. Si ya le entregaste el recibo impreso,
              volvé a imprimirlo.
            </Aviso>

            <div className="flex justify-end gap-2">
              <Button type="button" variante="fantasma" onClick={() => setEditando(null)}>
                Cancelar
              </Button>
              <Button type="submit" variante="primario" icon={Check} cargando={guardando}>
                Guardar corrección
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
