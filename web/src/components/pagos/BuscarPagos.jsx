import { useCallback, useEffect, useState } from 'react'
import { dineroCero as dinero } from '../../lib/formato'
import { Link } from 'react-router-dom'
import { Ban, Printer, Receipt, Search, X } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { imprimirTirilla } from '../../lib/tirilla'
import { useTabla } from '../../lib/useTabla'
import { MOTIVOS_ANULACION } from '../../lib/motivos'
import { Aviso, Button, Card, Cargando, Field, Input, PedirMotivo, Select, Stat, Table } from '../ui'

/**
 * Búsqueda de cobros.
 *
 * El caso que la motiva: llega un comprobante del banco y hay que saber de
 * quién es. Pegar el número acá lo encuentra, sin tener que recordar el nombre
 * del abonado ni el día en que se registró.
 *
 * También sirve para el reclamo típico —"yo pagué el martes"— filtrando por
 * rango de fechas.
 */

const fecha = (f) => (f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString() : '—')

/** Los últimos 30 días: el rango en el que caen casi todas las consultas. */
function hace(dias) {
  const d = new Date()
  d.setDate(d.getDate() - dias)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const hoy = () => hace(0)

async function abrirPdf(descargar) {
  const blob = await descargar()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export default function BuscarPagos({ onError }) {
  const { filas: cuentas } = useTabla('cuentas_pago', { orderBy: 'nombre', ascending: true })

  const [filtros, setFiltros] = useState({
    texto: '',
    desde: hace(30),
    hasta: hoy(),
    forma: '',
    cuenta: '',
    incluirAnulados: false,
  })
  const [filas, setFilas] = useState([])
  // Lo que se está por anular. Mientras sea null, la ventana no existe.
  const [aAnular, setAAnular] = useState(null)
  const [anulando, setAnulando] = useState(false)
  const [buscando, setBuscando] = useState(false)
  const [buscado, setBuscado] = useState(false)

  const set = (campo) => (e) =>
    setFiltros((f) => ({
      ...f,
      [campo]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
    }))

  const buscar = useCallback(
    async (e) => {
      e?.preventDefault()
      setBuscando(true)
      setBuscado(true)

      let q = supabase.from('v_pagos').select('*').order('fecha_pago', { ascending: false })

      const texto = filtros.texto.trim()
      if (texto) {
        // Se busca por número de transacción, por recibo y por nombre a la vez:
        // quien pega un número no tiene por qué saber cuál de los tres es.
        const limpio = texto.replace(/[,()%*\\]/g, ' ').trim()
        const condiciones = [`n_transaccion.ilike.%${limpio}%`, `cliente.ilike.%${limpio}%`]
        if (/^\d+$/.test(limpio)) condiciones.push(`numero.eq.${Number(limpio)}`)
        q = q.or(condiciones.join(','))
      }

      // Con un número puntual el rango de fechas estorba: el comprobante puede
      // ser de hace meses y quien lo pega no sabe de cuándo es.
      if (!texto) {
        if (filtros.desde) q = q.gte('fecha_pago', filtros.desde)
        if (filtros.hasta) q = q.lte('fecha_pago', filtros.hasta)
      }

      if (filtros.forma) q = q.eq('forma_pago', filtros.forma)
      if (filtros.cuenta) q = q.eq('cuenta_id', filtros.cuenta)
      if (!filtros.incluirAnulados) q = q.eq('anulado', false)

      const { data, error } = await q.limit(300)
      if (error) onError?.(error)
      setFilas(data ?? [])
      setBuscando(false)
    },
    [filtros, onError],
  )

  // Primera carga: los últimos 30 días, para no arrancar en blanco.
  useEffect(() => {
    buscar()
    // Solo al montar: después se busca a pedido.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function anular(motivo) {
    const pago = aAnular
    setAnulando(true)
    const { error } = await supabase
      .from('pagos')
      .update({
        anulado: true,
        motivo_anulacion: motivo.trim() || 'Sin motivo indicado',
        anulado_at: new Date().toISOString(),
      })
      .eq('id', pago.id)

    setAnulando(false)
    if (error) onError?.(error)
    else {
      setAAnular(null)
      await buscar()
    }
  }

  const validos = filas.filter((p) => !p.anulado)
  const total = validos.reduce((s, p) => s + Number(p.monto), 0)

  return (
    <div className="space-y-4">
      <Card title="Buscar cobros" icon={Search}>
        <form onSubmit={buscar} className="space-y-4">
          <Field
            label="N° de transacción, recibo o cliente"
            hint="Pegá el número del comprobante del banco y te dice de quién es"
          >
            <div className="flex gap-2">
              <Input
                value={filtros.texto}
                onChange={set('texto')}
                placeholder="884471203, 000012 o parte del nombre"
                autoFocus
                className="font-mono"
              />
              {filtros.texto && (
                <Button
                  type="button"
                  variante="secundario"
                  icon={X}
                  onClick={() => setFiltros((f) => ({ ...f, texto: '' }))}
                  title="Limpiar"
                />
              )}
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Field
              label="Desde"
              hint={filtros.texto ? 'Se ignora al buscar por número' : null}
            >
              <Input
                type="date"
                value={filtros.desde}
                onChange={set('desde')}
                disabled={Boolean(filtros.texto)}
              />
            </Field>
            <Field label="Hasta">
              <Input
                type="date"
                value={filtros.hasta}
                onChange={set('hasta')}
                disabled={Boolean(filtros.texto)}
              />
            </Field>
            <Field label="Forma de pago">
              <Select value={filtros.forma} onChange={set('forma')}>
                <option value="">Todas</option>
                {['efectivo', 'transferencia', 'deposito', 'tarjeta', 'otro'].map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Cuenta">
              <Select value={filtros.cuenta} onChange={set('cuenta')}>
                <option value="">Todas</option>
                {cuentas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end gap-3 pb-2">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
                <input
                  type="checkbox"
                  checked={filtros.incluirAnulados}
                  onChange={set('incluirAnulados')}
                  className="accent-sky-500"
                />
                Anulados
              </label>
              <Button type="submit" variante="primario" icon={Search} cargando={buscando}>
                Buscar
              </Button>
            </div>
          </div>
        </form>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Resultados" valor={filas.length} icon={Search} />
        <Stat label="Total cobrado" valor={dinero(total)} color="text-emerald-400" />
        <Stat
          label="Anulados en el resultado"
          valor={filas.length - validos.length}
          color={filas.length - validos.length ? 'text-red-400' : 'text-slate-400'}
        />
      </div>

      <Card title="Cobros encontrados">
        {buscando ? (
          <Cargando />
        ) : filas.length === 0 ? (
          <Aviso>
            {buscado && filtros.texto
              ? `No hay ningún cobro con "${filtros.texto}". Si el número es del banco y no aparece, todavía no se registró.`
              : 'No hay cobros en ese rango.'}
          </Aviso>
        ) : (
          <Table
            columnas={[
              'Recibo',
              'Fecha',
              'Cliente',
              'N° transacción',
              'Forma',
              'Cuenta',
              'Factura',
              'Monto',
              '',
            ]}
            filas={filas}
            renderFila={(p) => (
              <tr key={p.id} className={`text-slate-300 ${p.anulado ? 'opacity-50' : ''}`}>
                <td className="px-3 py-2 font-mono text-xs text-slate-100">
                  {String(p.numero ?? '').padStart(6, '0')}
                </td>
                <td className="px-3 py-2 text-xs">{fecha(p.fecha_pago)}</td>
                <td className="px-3 py-2">
                  {p.client_id ? (
                    <Link
                      to={`/clientes/${p.client_id}`}
                      className="text-slate-100 hover:text-sky-400 hover:underline"
                    >
                      {p.cliente ?? p.cliente_nombre}
                    </Link>
                  ) : (
                    (p.cliente_nombre ?? '—')
                  )}
                  <span className="block text-[11px] text-slate-500">{p.identificacion ?? ''}</span>
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-sky-300">
                  {p.n_transaccion ?? '—'}
                </td>
                <td className="px-3 py-2 text-xs capitalize">{p.forma_pago}</td>
                <td className="px-3 py-2 text-xs">{p.cuenta ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-[11px]">
                  {p.numero_factura ?? (p.es_excedente ? 'a favor' : '—')}
                  {p.numero_comprobante && (
                    <span className="block text-slate-500">{p.numero_comprobante}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <b className={p.anulado ? 'line-through' : 'text-emerald-300'}>
                    {dinero(p.monto)}
                  </b>
                  {Number(p.excedente) > 0.005 && (
                    <span className="block text-[11px] text-fuchsia-300">
                      cobro de {dinero(p.total_cobro)}
                    </span>
                  )}
                  {p.pago_origen_id && (
                    <span className="block text-[11px] text-slate-500">excedente</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    {p.anulado ? (
                      <span
                        className="flex items-center gap-1 text-[11px] text-red-300"
                        title={p.motivo_anulacion ?? ''}
                      >
                        <Ban size={12} /> anulado
                      </span>
                    ) : (
                      <>
                        <Button
                          variante="fantasma"
                          icon={Printer}
                          title="Recibo del cobro"
                          onClick={() => abrirPdf(() => api.pagos.comprobante(p.id)).catch(onError)}
                        />
                        {/* La tirilla, para la térmica del mostrador. */}
                        <Button
                          variante="fantasma"
                          icon={Receipt}
                          title="Imprimir tirilla en la térmica"
                          onClick={() =>
                            api.documentos
                              .reciboPos(p.id)
                              .then((texto) => imprimirTirilla(texto))
                              .catch(onError)
                          }
                        />
                        <Button
                          variante="fantasma"
                          icon={Ban}
                          title="Anular el cobro"
                          onClick={() => setAAnular(p)}
                        />
                      </>
                    )}
                  </div>
                </td>
              </tr>
            )}
          />
        )}
      </Card>

      <PedirMotivo
        abierto={!!aAnular}
        titulo="Anular el cobro"
        etiquetaAccion="Anular el cobro"
        icon={Ban}
        cargando={anulando}
        advertencia="El pago no se borra: queda anulado con el motivo, y la factura vuelve a figurar por cobrar."
        datos={
          aAnular
            ? [
                ['Abonado', aAnular.cliente],
                ['Monto', dinero(aAnular.monto)],
                ['Fecha', aAnular.fecha ? new Date(`${String(aAnular.fecha).slice(0, 10)}T12:00:00`).toLocaleDateString('es-EC') : '—'],
                ['Forma de pago', aAnular.forma_pago ?? '—'],
              ]
            : []
        }
        sugerencias={MOTIVOS_ANULACION}
        onCancelar={() => setAAnular(null)}
        onConfirmar={anular}
      />
    </div>
  )
}
