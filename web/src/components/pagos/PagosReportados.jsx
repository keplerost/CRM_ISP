import { useCallback, useEffect, useState } from 'react'
import { Check, ExternalLink, Inbox, ShieldAlert, X } from 'lucide-react'

import { api } from '../../lib/apiNetwork'
import { supabase } from '../../lib/supabaseClient'
import { dineroCero as dinero } from '../../lib/formato'
import { usePermisos } from '../../lib/AuthContext'
import { MOTIVOS_RECHAZO_PAGO } from '../../lib/motivos'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  DatosEnFicha,
  Field,
  Modal,
  PedirMotivo,
  Select,
  Table,
} from '../../components/ui'

/**
 * Los pagos que reportó un sistema externo y todavía no son un cobro.
 *
 * ── Por qué esta bandeja existe ──
 *
 * El bot de WhatsApp recibe la palabra del abonado: "ya pagué, acá está el
 * comprobante". Eso no es un cobro — es una declaración, y una captura se edita
 * en treinta segundos. Si el bot pudiera saldar facturas con eso, la deuda
 * desaparecería, el corte no se ejecutaría, y el faltante recién aparecería en
 * la conciliación del mes siguiente: para entonces ya está en el cierre de
 * caja, en la comisión del vendedor y en el reporte de ARCOTEL.
 *
 * Acá alguien lo mira contra el extracto y decide. Recién cuando confirma se
 * llama a `aplicar_cobro` y la plata entra a la caja, con el mismo reparto
 * entre facturas que un cobro de ventanilla.
 *
 * Los pagos que avisa una pasarela NO pasan por acá: en esos, quien afirma que
 * el dinero entró es el que lo recibió, y se acreditan solos. Aparecen en esta
 * lista ya confirmados, para poder verlos.
 */

const fechaCorta = (v) =>
  v ? new Date(`${String(v).slice(0, 10)}T12:00:00`).toLocaleDateString('es-EC') : '—'


export default function PagosReportados({ onError }) {
  const { puede } = usePermisos()
  const [estado, setEstado] = useState('pendiente')
  const [filas, setFilas] = useState([])
  const [cuentas, setCuentas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [trabajando, setTrabajando] = useState(null)

  /**
   * El diálogo abierto, con lo que el operador todavía no mandó.
   *
   * Vive acá y no adentro del modal para que el modal pueda ser tonto: recibe
   * valores y avisa cambios. Así el botón de confirmar puede leer lo elegido
   * sin que el estado se pierda cada vez que React vuelve a dibujar la tabla.
   */
  const [dialogo, setDialogo] = useState(null)

  const puedeResolver = puede('pagos.registrar')

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const [r, cu] = await Promise.all([
        api.integraciones.reportados(estado),
        supabase.from('cuentas_pago').select('id, nombre, tipo').eq('activa', true).order('nombre'),
      ])
      setFilas(r)
      setCuentas(cu.data ?? [])
    } catch (err) {
      onError?.(err)
    } finally {
      setCargando(false)
    }
  }, [estado, onError])

  useEffect(() => {
    recargar()
  }, [recargar])

  /**
   * Confirma el reporte: recién acá es un cobro.
   *
   * Se pregunta la cuenta antes de aplicar y no después: quien confirma está
   * mirando el extracto y a veces descubre que la transferencia entró a una
   * cuenta distinta de la que el bot suponía. Corregirlo después obliga a
   * anular el cobro y rehacerlo.
   */
  async function confirmarAhora() {
    const { fila, cuenta_id, reactivar } = dialogo
    setTrabajando(fila.id)
    try {
      const r = await api.integraciones.confirmar(fila.id, {
        cuenta_id: cuenta_id || null,
        reactivar: Boolean(reactivar),
      })

      if (r.reactivacion && !r.reactivacion.ok) {
        onError?.(
          new Error(
            `El cobro quedó registrado, pero el servicio no se reactivó: ${r.reactivacion.nota}`,
          ),
        )
      }
      setDialogo(null)
      await recargar()
    } catch (err) {
      onError?.(err)
    } finally {
      setTrabajando(null)
    }
  }

  async function rechazarAhora(motivo) {
    const { fila } = dialogo
    setTrabajando(fila.id)
    try {
      await api.integraciones.rechazar(fila.id, motivo)
      setDialogo(null)
      await recargar()
    } catch (err) {
      onError?.(err)
    } finally {
      setTrabajando(null)
    }
  }

  const pendientes = filas.filter((f) => f.estado === 'pendiente')
  const total = pendientes.reduce((s, f) => s + Number(f.monto), 0)

  return (
    <Card
      title="Pagos reportados desde afuera"
      icon={Inbox}
      subtitle="Lo que el bot o el CRM dicen que se pagó. Mientras están pendientes no suman a caja ni saldan facturas."
      actions={
        <Select value={estado} onChange={(e) => setEstado(e.target.value)} className="w-auto">
          <option value="pendiente">Pendientes</option>
          <option value="confirmado">Confirmados</option>
          <option value="rechazado">Rechazados</option>
          <option value="todos">Todos</option>
        </Select>
      }
    >
      {cargando ? (
        <Cargando />
      ) : (
        <div className="space-y-3">
          {estado === 'pendiente' && pendientes.length > 0 && (
            <Aviso tipo="alerta">
              <ShieldAlert size={14} className="mr-1 inline" />
              Hay <b>{pendientes.length}</b> {pendientes.length === 1 ? 'pago' : 'pagos'} esperando
              verificación por <b>{dinero(total)}</b>. Hasta que se confirmen, esos abonados siguen
              figurando con deuda.
            </Aviso>
          )}

          <Table
            columnas={['Abonado', 'Reportó', 'Monto', 'Debe', 'Transacción', 'Estado', '']}
            filas={filas}
            vacio={
              estado === 'pendiente'
                ? 'No hay nada esperando verificación.'
                : 'No hay reportes con ese estado.'
            }
            renderFila={(f) => (
              <tr key={f.id} className="text-slate-300">
                <td className="px-3 py-2">
                  <span className="block text-slate-100">{f.cliente_nombre ?? '—'}</span>
                  <span className="text-[11px] text-slate-500">
                    {f.identificacion}
                    {f.estado_servicio === 'cortado' && (
                      <span className="ml-1 text-red-400">· cortado</span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs">
                  <span className="block">{f.llave_nombre ?? '—'}</span>
                  <span className="text-[11px] text-slate-500">{fechaCorta(f.created_at)}</span>
                </td>
                <td className="px-3 py-2">
                  <b className="text-emerald-300">{dinero(f.monto)}</b>
                  <span className="block text-[11px] capitalize text-slate-500">
                    {f.forma_pago} · {fechaCorta(f.fecha_pago)}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs">
                  {/* Al lado del monto a propósito: un reporte de $20 sobre una
                      deuda de $20 y uno de $20 sobre una de $180 se miran distinto. */}
                  <span
                    className={
                      Number(f.deuda_actual) > Number(f.monto) ? 'text-amber-300' : 'text-slate-400'
                    }
                  >
                    {dinero(f.deuda_actual)}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-[11px]">
                  {f.n_transaccion ?? '—'}
                  {f.comprobante_url && (
                    <a
                      href={f.comprobante_url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-1 inline-flex text-sky-400 hover:text-sky-300"
                      title="Ver el comprobante que mandó el abonado"
                    >
                      <ExternalLink size={12} />
                    </a>
                  )}
                </td>
                <td className="px-3 py-2">
                  {f.estado === 'pendiente' && <Badge color="ambar">Esperando</Badge>}
                  {f.estado === 'confirmado' && <Badge color="verde">Confirmado</Badge>}
                  {f.estado === 'rechazado' && (
                    <>
                      <Badge color="rojo">Rechazado</Badge>
                      <span className="mt-1 block text-[11px] text-slate-500">
                        {f.motivo_rechazo}
                      </span>
                    </>
                  )}
                </td>
                <td className="px-3 py-2">
                  {f.estado === 'pendiente' && puedeResolver && (
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        icon={Check}
                        variante="primario"
                        disabled={trabajando === f.id}
                        onClick={() =>
                          setDialogo({
                            tipo: 'confirmar',
                            fila: f,
                            cuenta_id: '',
                            // Al que está cortado se le devuelve el servicio: es
                            // para eso que pagó. Queda a la vista y se puede
                            // destildar, pero el caso normal no debería requerir
                            // que alguien se acuerde de marcarlo.
                            reactivar: f.estado_servicio === 'cortado',
                          })
                        }
                      >
                        Confirmar
                      </Button>
                      <Button
                        icon={X}
                        variante="fantasma"
                        disabled={trabajando === f.id}
                        onClick={() => setDialogo({ tipo: 'rechazar', fila: f, motivo: '' })}
                      >
                        Rechazar
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            )}
          />
        </div>
      )}

      {/* ---------------------------------------------------------------
          Confirmar. Lo que se ve antes de decidir es lo que se compara
          contra el extracto: monto, número, banco y fecha juntos.
          --------------------------------------------------------------- */}
      <Modal
        abierto={dialogo?.tipo === 'confirmar'}
        titulo="Confirmar el pago"
        onCerrar={() => setDialogo(null)}
      >
        {dialogo?.tipo === 'confirmar' && (
          <div className="space-y-4">
            <DatosEnFicha datos={datosDelPago(dialogo.fila)} />
            {dialogo.fila.comprobante_url && (
              <a
                href={dialogo.fila.comprobante_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300"
              >
                <ExternalLink size={13} />
                Ver el comprobante que mandó el abonado
              </a>
            )}

            <Field
              label="¿A qué cuenta entró la plata?"
              hint="Si la dejás como está, se usa la que informó la integración."
            >
              <Select
                value={dialogo.cuenta_id}
                onChange={(e) => setDialogo({ ...dialogo, cuenta_id: e.target.value })}
              >
                <option value="">La que informó la integración</option>
                {cuentas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre} ({c.tipo})
                  </option>
                ))}
              </Select>
            </Field>

            {dialogo.fila.estado_servicio === 'cortado' && (
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                <input
                  type="checkbox"
                  checked={dialogo.reactivar}
                  onChange={(e) => setDialogo({ ...dialogo, reactivar: e.target.checked })}
                  className="mt-0.5 h-4 w-4 accent-amber-500"
                />
                <span className="text-xs text-amber-200">
                  <b className="block text-amber-100">Devolverle el servicio ahora</b>
                  {dialogo.fila.cliente_nombre} está cortado. Se le quita la IP del address-list de
                  corte en el router y vuelve a navegar.
                </span>
              </label>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variante="fantasma" onClick={() => setDialogo(null)}>
                Cancelar
              </Button>
              <Button
                variante="primario"
                icon={Check}
                cargando={trabajando === dialogo.fila.id}
                onClick={confirmarAhora}
              >
                Confirmar {dinero(dialogo.fila.monto)}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <PedirMotivo
        abierto={dialogo?.tipo === 'rechazar'}
        titulo="Rechazar el pago"
        etiquetaAccion="Rechazar el pago"
        icon={X}
        cargando={trabajando === dialogo?.fila?.id}
        datos={dialogo?.tipo === 'rechazar' ? datosDelPago(dialogo.fila) : []}
        sugerencias={MOTIVOS_RECHAZO_PAGO}
        onCancelar={() => setDialogo(null)}
        onConfirmar={rechazarAhora}
      />
    </Card>
  )
}

/** Lo que hay que mirar contra el extracto, en los dos diálogos. */
function datosDelPago(fila) {
  return [
    ['Abonado', fila.cliente_nombre],
    ['Identificación', fila.identificacion],
    ['Monto', dinero(fila.monto)],
    ['Debe hoy', dinero(fila.deuda_actual)],
    ['Transacción', fila.n_transaccion || 'sin número'],
    ['Banco', fila.banco_origen || '—'],
    ['Fecha del pago', fechaCorta(fila.fecha_pago)],
    ['Lo reportó', fila.llave_nombre || '—'],
  ]
}
