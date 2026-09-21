import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { dinero } from '../../lib/formato'
import { CalendarClock, Check, Pencil, ShieldAlert, Trash2, Wifi } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
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
  Textarea,
} from '../ui'

/**
 * Promesas de pago.
 *
 * "Pagame el viernes y no me cortes" es una conversación que si no se registra
 * vive en la cabeza de quien atendió. Acá queda: el que corta el servicio sabe
 * que hay un compromiso, y el que atiende sabe si el cliente ya prometió tres
 * veces sin cumplir.
 *
 * Se crean al cobrar —en Registrar pago, eligiendo "Promesa de pago"—, porque
 * es el mismo momento y el mismo cliente ya buscado. Acá se hace el seguimiento.
 *
 * Lo vencido no se guarda como estado: se deduce de la fecha. Guardarlo
 * obligaría a un proceso diario para que el dato no mienta.
 */

const fecha = (f) => (f ? new Date(`${f}T12:00:00`).toLocaleDateString() : '—')

const COLOR = { activa: 'azul', cumplida: 'verde', incumplida: 'rojo', anulada: 'gris' }

export default function PromesasPago({ onError }) {
  const confirmar = useConfirmar()
  const [filtro, setFiltro] = useState('activa')
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [cortando, setCortando] = useState(null)
  const [automatico, setAutomatico] = useState(null)
  const [corriendo, setCorriendo] = useState(false)
  const [editando, setEditando] = useState(null)
  const [guardando, setGuardando] = useState(false)

  const recargar = useCallback(async () => {
    setCargando(true)
    let consulta = supabase.from('v_promesas_pago').select('*').order('fecha_promesa')
    if (filtro !== 'todas') consulta = consulta.eq('estado', filtro)

    const { data, error } = await consulta
    if (error) onError?.(error)
    setFilas(data ?? [])
    setCargando(false)
  }, [filtro, onError])

  useEffect(() => {
    recargar()
  }, [recargar])

  // El estado del corte automático vive en el middleware, no en la base: es una
  // cuestión de configuración del servicio, no de datos.
  useEffect(() => {
    api.pagos
      .cortes()
      .then(setAutomatico)
      .catch(() => setAutomatico(null))
  }, [])

  /** Corre el corte ahora, sin esperar a la hora programada. */
  async function cortarTodos() {
    const cuantos = automatico?.pendientes?.length ?? 0
    if (
      !await confirmar(
        `Se va a cortar el servicio de ${cuantos} ${cuantos === 1 ? 'cliente' : 'clientes'} ` +
          'con promesa vencida y saldo pendiente.\n\n¿Continuar?',
      )
    )
      return

    setCorriendo(true)
    onError?.(null)
    try {
      const r = await api.pagos.ejecutarCortes({})
      setAutomatico((a) => ({ ...a, ultimoResultado: r, pendientes: [] }))
      if (r.fallidos?.length) {
        onError?.(
          new Error(
            `${r.cortados.length} cortados. No se pudo con ${r.fallidos.length}: ${r.fallidos
              .map((f) => `${f.cliente} (${f.error})`)
              .join(' · ')}`,
          ),
        )
      }
      await recargar()
    } catch (err) {
      onError?.(err)
    } finally {
      setCorriendo(false)
    }
  }

  async function cambiarEstado(promesa, estado) {
    const { error } = await supabase.from('promesas_pago').update({ estado }).eq('id', promesa.id)
    if (error) onError?.(error)
    else await recargar()
  }

  /**
   * Guarda los cambios de una promesa.
   *
   * Se edita en vez de crear otra porque lo habitual es correr la fecha: el
   * cliente avisa que no llega y pide unos días más. Registrarlo como una
   * promesa nueva borraría que ya había pedido plazo una vez.
   */
  async function guardarEdicion(e) {
    e.preventDefault()
    setGuardando(true)
    onError?.(null)

    try {
      const { error } = await supabase
        .from('promesas_pago')
        // El monto no viaja: lo que se debe lo define la factura del cliente.
        .update({
          fecha_promesa: editando.fecha_promesa,
          nota: editando.nota?.trim() || null,
          estado: editando.estado,
        })
        .eq('id', editando.id)

      if (error) {
        if (error.code === '23505') {
          throw new Error(
            'Ese cliente ya tiene otra promesa activa. Cerrá una de las dos antes de reactivar esta.',
          )
        }
        throw error
      }

      setEditando(null)
      await recargar()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  /**
   * Borra la promesa.
   *
   * A diferencia de un pago —que se anula y queda—, una promesa mal cargada no
   * tiene valor contable: si se registró por error, lo correcto es que
   * desaparezca. Lo que sí avisa es cuando había habilitado el servicio, porque
   * borrarla deja al cliente conectado sin nada que explique por qué.
   */
  async function eliminar(p) {
    const aviso =
      p.activo_servicio && p.estado === 'activa'
        ? `\n\nOJO: esta promesa habilitó el servicio de ${p.cliente}. Si la borrás, queda conectado y nadie va a saber por qué. Si no pagó, conviene cortarlo primero.`
        : ''

    if (!await confirmar(`¿Eliminar la promesa de ${p.cliente} del ${fecha(p.fecha_promesa)}?${aviso}`)) return

    const { error } = await supabase.from('promesas_pago').delete().eq('id', p.id)
    if (error) onError?.(error)
    else await recargar()
  }

  /**
   * Vuelve a cortar a quien prometió, se le habilitó el servicio y no pagó.
   *
   * Es la contracara de habilitar por una promesa: sin esto, prometer sería una
   * forma de quedarse conectado sin pagar.
   */
  async function cortar(promesa) {
    if (!promesa.router_id || !promesa.ip) {
      return onError?.(
        new Error(`${promesa.cliente} no tiene router o IP asignados: hay que cortarlo a mano.`),
      )
    }

    if (
      !await confirmar(
        `Se va a cortar el servicio de ${promesa.cliente} (${promesa.ip}).\n\n` +
          `Prometió pagar el ${fecha(promesa.fecha_promesa)} y no lo hizo.\n\n¿Continuar?`,
      )
    )
      return

    setCortando(promesa.id)
    onError?.(null)
    try {
      await api.mikrotik.bloquear(promesa.router_id, {
        address: promesa.ip,
        comment: `Promesa incumplida del ${promesa.fecha_promesa}`,
      })

      await supabase.from('clientes').update({ estado: 'cortado' }).eq('id', promesa.client_id)
      await supabase.from('promesas_pago').update({ estado: 'incumplida' }).eq('id', promesa.id)
      await recargar()
    } catch (err) {
      onError?.(err)
    } finally {
      setCortando(null)
    }
  }

  const activas = filas.filter((p) => p.estado === 'activa')
  const vencidas = activas.filter((p) => p.vencida)
  const aCortar = vencidas.filter((p) => p.activo_servicio && p.estado_cliente === 'activo')

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Promesas activas" valor={activas.length} icon={CalendarClock} />
        <Stat label="Vencidas" valor={vencidas.length} color="text-amber-400" />
        <Stat
          label="Para volver a cortar"
          valor={aCortar.length}
          color="text-red-400"
          icon={ShieldAlert}
        />
      </div>

      {aCortar.length > 0 && (
        <Aviso tipo="alerta">
          Hay <b>{aCortar.length}</b> {aCortar.length === 1 ? 'cliente' : 'clientes'} con el servicio
          habilitado por una promesa que ya venció sin pago. Están marcados abajo.
        </Aviso>
      )}

      {/*
        El título dice "por promesa incumplida" y no "Corte automático": hay dos
        cortes automáticos en el sistema, y el nombre genérico hace pensar que
        este es el único. El otro —el corte por mora— corta por deuda.
      */}
      {automatico && (
        <Card
          title="Corte por promesa incumplida"
          icon={ShieldAlert}
          actions={
            <Button
              variante={automatico.pendientes?.length ? 'peligro' : 'secundario'}
              icon={ShieldAlert}
              cargando={corriendo}
              disabled={!automatico.pendientes?.length}
              onClick={cortarTodos}
            >
              Cortar ahora
            </Button>
          }
        >
          <div className="space-y-2 text-xs text-slate-400">
            <p>
              {automatico.automaticos ? (
                <>
                  <span className="text-emerald-400">Activo.</span> Corre todos los días a las{' '}
                  <b className="text-slate-200">{automatico.hora}</b> y corta a quien prometió, se le
                  habilitó el servicio y sigue debiendo.
                </>
              ) : (
                <>
                  <span className="text-amber-400">Desactivado.</span> Poné{' '}
                  <code className="text-slate-300">CORTES_AUTOMATICOS=true</code> en el{' '}
                  <code className="text-slate-300">.env</code> del middleware y reinicialo. Mientras
                  tanto, el botón corta a mano.
                </>
              )}
            </p>

            <p>
              Si corriera ahora cortaría a <b className="text-slate-200">{automatico.pendientes?.length ?? 0}</b>.
              {automatico.omitidos?.length > 0 && (
                <> Quedan {automatico.omitidos.length} afuera (ya pagaron o no tienen IP conocida).</>
              )}
            </p>

            {automatico.ultimaCorrida && (
              <p>
                Última corrida automática: <b className="text-slate-200">{automatico.ultimaCorrida}</b>
                {automatico.ultimoResultado?.cortados && (
                  <> — {automatico.ultimoResultado.cortados.length} cortados.</>
                )}
                {automatico.ultimoResultado?.error && (
                  <span className="text-red-300"> — falló: {automatico.ultimoResultado.error}</span>
                )}
              </p>
            )}
          </div>
        </Card>
      )}

      <Card
        title="Promesas"
        subtitle='Se registran al cobrar, eligiendo "Promesa de pago" como tipo'
        icon={CalendarClock}
        actions={
          <Select value={filtro} onChange={(e) => setFiltro(e.target.value)} className="w-44">
            <option value="activa">Activas</option>
            <option value="cumplida">Cumplidas</option>
            <option value="incumplida">Incumplidas</option>
            <option value="anulada">Anuladas</option>
            <option value="todas">Todas</option>
          </Select>
        }
      >
        {cargando ? (
          <Cargando />
        ) : filas.length === 0 ? (
          <Aviso>
            No hay promesas {filtro === 'todas' ? 'registradas' : `en estado ${filtro}`}. Se crean
            desde <b>Registrar pago</b>, eligiendo <b>Promesa de pago</b> en el tipo.
          </Aviso>
        ) : (
          <Table
            columnas={['Cliente', 'Se comprometió a', 'Monto', 'Comprobante', 'Estado', '']}
            filas={filas}
            renderFila={(p) => (
              <tr key={p.id} className={`text-slate-300 ${p.vencida ? 'bg-red-500/5' : ''}`}>
                <td className="px-3 py-2">
                  <span className="block text-slate-100">{p.cliente ?? '—'}</span>
                  <span className="text-[11px] text-slate-500">
                    {p.identificacion ?? ''}
                    {p.ip ? ` · ${p.ip}` : ''}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs">
                  {fecha(p.fecha_promesa)}
                  {p.estado === 'activa' && (
                    <span className={`ml-2 ${p.vencida ? 'text-red-400' : 'text-slate-500'}`}>
                      {p.vencida
                        ? `vencida hace ${Math.abs(p.dias_restantes)} día(s)`
                        : `en ${p.dias_restantes} día(s)`}
                    </span>
                  )}
                  {p.activo_servicio && (
                    <span
                      className="ml-2 inline-flex items-center gap-1 text-[11px] text-sky-400"
                      title="Esta promesa habilitó el servicio"
                    >
                      <Wifi size={11} /> habilitó
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">{dinero(p.monto)}</td>
                <td className="px-3 py-2 font-mono text-[11px]">{p.numero_comprobante ?? '—'}</td>
                <td className="px-3 py-2">
                  <Badge color={COLOR[p.estado] ?? 'gris'}>{p.estado}</Badge>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap justify-end gap-1">
                    {p.estado === 'activa' && (
                      <>
                        {p.vencida && p.activo_servicio && p.estado_cliente === 'activo' && (
                          <Button
                            variante="peligro"
                            icon={ShieldAlert}
                            cargando={cortando === p.id}
                            title="Prometió, se le habilitó y no pagó"
                            onClick={() => cortar(p)}
                          >
                            Cortar
                          </Button>
                        )}
                        <Button
                          variante="fantasma"
                          icon={Check}
                          title="Ya pagó: cerrar la promesa"
                          onClick={() => cambiarEstado(p, 'cumplida')}
                        >
                          Cumplida
                        </Button>
                      </>
                    )}
                    <Button
                      variante="fantasma"
                      icon={Pencil}
                      title="Cambiar la fecha, el monto o el estado"
                      onClick={() =>
                        setEditando({
                          id: p.id,
                          cliente: p.cliente,
                          fecha_promesa: p.fecha_promesa,
                          monto: p.monto ?? '',
                          nota: p.nota ?? '',
                          estado: p.estado,
                          activo_servicio: p.activo_servicio,
                        })
                      }
                    >
                      Editar
                    </Button>
                    <Button
                      variante="fantasma"
                      icon={Trash2}
                      title="Eliminar la promesa"
                      onClick={() => eliminar(p)}
                    />
                  </div>
                </td>
              </tr>
            )}
          />
        )}
      </Card>

      <Modal
        abierto={Boolean(editando)}
        titulo={`Promesa de ${editando?.cliente ?? ''}`}
        onCerrar={() => setEditando(null)}
      >
        {editando && (
          <form onSubmit={guardarEdicion} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nueva fecha límite" hint="Tocá el campo para abrir el calendario">
                <Input
                  type="date"
                  value={editando.fecha_promesa}
                  onChange={(e) => setEditando((p) => ({ ...p, fecha_promesa: e.target.value }))}
                  onClick={(e) => {
                    try {
                      e.currentTarget.showPicker?.()
                    } catch {
                      // Navegador sin soporte: queda el calendario del iconito.
                    }
                  }}
                  className="cursor-pointer"
                  required
                />
              </Field>

              {/* El monto se muestra pero no se edita: lo que el cliente debe
                  lo define la factura, no esta pantalla. Cambiarlo acá haría que
                  la promesa dijera una cosa y la cuenta del cliente otra. */}
              <Field label="Monto prometido" hint="Sale de la factura del cliente">
                <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-400">
                  {dinero(editando.monto)}
                </div>
              </Field>

              <Field label="Estado" className="sm:col-span-2">
                <Select
                  value={editando.estado}
                  onChange={(e) => setEditando((p) => ({ ...p, estado: e.target.value }))}
                >
                  <option value="activa">Activa</option>
                  <option value="cumplida">Cumplida</option>
                  <option value="incumplida">Incumplida</option>
                  <option value="anulada">Anulada</option>
                </Select>
              </Field>
              <Field label="Nota" className="sm:col-span-2">
                <Textarea
                  rows={3}
                  value={editando.nota}
                  onChange={(e) => setEditando((p) => ({ ...p, nota: e.target.value }))}
                  placeholder="Por qué se cambió la fecha"
                />
              </Field>
            </div>

            {editando.activo_servicio && editando.estado === 'activa' && (
              <Aviso>
                Correr la fecha extiende el plazo antes de que el corte automático lo tome: el
                cliente sigue conectado hasta la fecha nueva.
              </Aviso>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variante="fantasma" onClick={() => setEditando(null)}>
                Cancelar
              </Button>
              <Button type="submit" variante="primario" icon={Check} cargando={guardando}>
                Guardar cambios
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
