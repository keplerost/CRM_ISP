import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../lib/confirmar'
import { dineroCero as dinero } from '../lib/formato'
import {
  Ban,
  CalendarClock,
  CreditCard,
  Inbox,
  Landmark,
  Printer,
  Receipt,
  ShoppingCart,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { api } from '../lib/apiNetwork'
import BuscadorCliente, { COLOR_ESTADO } from '../components/pagos/BuscadorCliente'
import FormPago from '../components/pagos/FormPago'
import PromesasPago from '../components/pagos/PromesasPago'
import PagosReportados from '../components/pagos/PagosReportados'
import { usePermisos } from '../lib/AuthContext'
import ConPermiso from '../components/layout/ConPermiso'
import { MOTIVOS_ANULACION } from '../lib/motivos'
import { Aviso, Badge, Button, Card, Cargando, ErrorBanner, PedirMotivo, Stat, Table } from '../components/ui'

/**
 * Abre un PDF que llega como blob.
 *
 * El pedido lleva el token de Supabase en la cabecera, así que no se puede
 * resolver con un enlace común. La URL temporal se libera después: revocarla
 * enseguida deja la pestaña nueva sin nada que mostrar.
 */
async function abrirPdf(descargar) {
  const blob = await descargar()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * Cobros.
 *
 * Está separado de Facturación a propósito: emitir es una obligación con el SRI
 * y cobrar es una operación del negocio. Se hacen en momentos distintos, muchas
 * veces por personas distintas, y mezclarlos obliga a quien cobra en el
 * mostrador a moverse por una pantalla llena de cosas que no le tocan.
 */

// Las cuentas de cobro se configuran una vez y no se tocan más, así que viven
// en Facturación → Configuración junto con el resto de los parámetros. Acá
// quedan solo las tres cosas que se hacen todos los días.
const PESTANAS = [
  { id: 'registrar', label: 'Registrar pago', icon: CreditCard, permiso: 'pagos.registrar' },
  { id: 'hoy', label: 'Pagos registrados (hoy)', icon: ShoppingCart, permiso: 'pagos.ver' },
  { id: 'promesas', label: 'Promesas de pago', icon: CalendarClock, permiso: 'pagos.promesas' },
  /**
   * Lo que reportó el bot y todavía no es un cobro.
   *
   * Va acá y no en Ajustes → Integraciones porque es una cola de trabajo de
   * cobranza, no una configuración: quien la atiende es el mismo que cobra en
   * el mostrador, y tiene que encontrarla donde ya está mirando.
   *
   * Pide `pagos.ver` para entrar y `pagos.registrar` para confirmar: mirar la
   * bandeja no es lo mismo que meter plata en la caja del día.
   */
  { id: 'reportados', label: 'Pagos reportados', icon: Inbox, permiso: 'pagos.ver' },
]


export default function PagosPage() {
  const { puede } = usePermisos()
  // Solo las pestañas de este usuario. Al cobrador que solo registra no le
  // sirve abrir en "Registrar" si no puede: se arranca en la primera que tenga.
  const visibles = PESTANAS.filter((p) => puede(p.permiso))
  const [pestana, setPestana] = useState(visibles[0]?.id ?? 'registrar')
  const [error, setError] = useState(null)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Cobros</h1>
        <p className="text-sm text-slate-500">
          Registro de pagos, cuentas de destino y promesas de pago.
        </p>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-slate-800">
        {visibles.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setPestana(id)}
            className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-sm transition ${
              pestana === id
                ? 'border-b-2 border-sky-500 bg-slate-900 text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {pestana === 'registrar' && <Registrar onError={setError} />}
      {pestana === 'hoy' && <PagosDelDia onError={setError} />}
      {pestana === 'promesas' && <PromesasPago onError={setError} />}
      {pestana === 'reportados' && <PagosReportados onError={setError} />}
    </div>
  )
}

// ---------------------------------------------------------------------------

function Registrar({ onError }) {
  const [cliente, setCliente] = useState(null)
  const [resultado, setResultado] = useState(null)

  function registrado({ pago, promesa, pasos }) {
    setResultado({ pago, promesa, pasos, cliente })
    setCliente(null)
  }

  return (
    <div className="space-y-4">
      <Card>
        <BuscadorCliente
          onElegir={(c) => {
            setResultado(null)
            setCliente(c)
          }}
        />
      </Card>

      {resultado && (
        <Card
          title={resultado.pago ? 'Pago registrado' : 'Promesa registrada'}
          icon={resultado.pago ? Receipt : CalendarClock}
          actions={
            resultado.pago && (
              <Button
                variante="primario"
                icon={Printer}
                onClick={() =>
                  abrirPdf(() => api.pagos.comprobante(resultado.pago.id)).catch(onError)
                }
              >
                Imprimir recibo
              </Button>
            )
          }
        >
          <div className="space-y-2">
            <Aviso>
              {resultado.pago ? (
                <>
                  Se registró <b>{dinero(resultado.pago.monto)}</b> de{' '}
                  <b>{resultado.cliente?.nombre}</b> — recibo N°{' '}
                  <b>{String(resultado.pago.numero ?? '').padStart(6, '0')}</b>.
                </>
              ) : (
                <>
                  <b>{resultado.cliente?.nombre}</b> se comprometió a pagar el{' '}
                  <b>
                    {new Date(`${resultado.promesa.fecha_promesa}T12:00:00`).toLocaleDateString()}
                  </b>
                  .
                </>
              )}
            </Aviso>
            {resultado.pasos?.map((p, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className={p.ok ? 'text-emerald-400' : 'text-amber-400'}>
                  {p.ok ? '✓' : '!'}
                </span>
                <span className="text-slate-300">{p.nota}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {cliente && (
        // No usa Card porque la barra del cliente va pegada al borde, y Card
        // siempre deja padding alrededor de su contenido.
        <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 shadow-lg shadow-black/20">
          {/* La barra con el nombre y el estado: quien cobra tiene que ver de
              entrada si el cliente está cortado. */}
          <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-950 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="font-semibold uppercase tracking-wide text-slate-100">
                {cliente.nombre}
              </span>
              <Badge color={COLOR_ESTADO[cliente.estado] ?? 'gris'}>{cliente.estado}</Badge>
              {cliente.ip && <span className="font-mono text-xs text-slate-500">{cliente.ip}</span>}
            </div>
            <Button variante="fantasma" icon={X} onClick={() => setCliente(null)}>
              Cerrar
            </Button>
          </div>

          <div className="p-4">
            <FormPago
              key={cliente.id}
              cliente={cliente}
              onRegistrado={registrado}
              onCancelar={() => setCliente(null)}
              onError={onError}
            />
          </div>
        </section>
      )}

      {!cliente && !resultado && (
        <Aviso>
          Buscá al abonado por nombre, cédula/RUC, IP o por el número de la factura que trae.
        </Aviso>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * Lo cobrado en el día.
 *
 * Es el cierre de caja: cuánto entró, por qué medio y a qué cuenta. Por eso se
 * agrupa por cuenta y no es una lista plana.
 */
function PagosDelDia({ onError }) {
  const confirmar = useConfirmar()
  const [fecha, setFecha] = useState(() => new Date().toISOString().slice(0, 10))
  const [filas, setFilas] = useState([])
  // Lo que se está por anular. Mientras sea null, la ventana no existe.
  const [aAnular, setAAnular] = useState(null)
  const [anulando, setAnulando] = useState(false)
  const [cargando, setCargando] = useState(true)

  const recargar = useCallback(async () => {
    setCargando(true)
    const { data, error } = await supabase
      .from('v_pagos')
      .select('*')
      .eq('fecha_pago', fecha)
      .order('created_at', { ascending: false })

    if (error) onError?.(error)
    setFilas(data ?? [])
    setCargando(false)
  }, [fecha, onError])

  useEffect(() => {
    recargar()
  }, [recargar])

  /**
   * Borra el cobro.
   *
   * Es distinto de anular: anular deja el rastro de que ese cobro existió y se
   * dio de baja —lo correcto cuando la plata entró de verdad y hay que
   * explicar por qué se revirtió—; borrar es para el cobro que nunca debió
   * existir, cargado hace un momento con el monto o el comprobante mal.
   *
   * Si ya había generado un comprobante del SRI sin enviar, se anula y su
   * número vuelve a la bolsa para que la factura corregida lo reutilice.
   */
  async function borrar(pago) {
    const fiscalPendiente =
      pago.document_id && !['AUTORIZADO', 'ANULADO'].includes(pago.estado_comprobante)

    if (
      !await confirmar(
        `¿Eliminar el cobro de ${dinero(pago.monto)} de ${pago.cliente}?\n\n` +
          'Desaparece del cierre del día y de la factura: es para el cobro que se cargó mal.\n' +
          (fiscalPendiente
            ? `\nEl comprobante ${pago.numero_comprobante} todavía no se envió al SRI: se va a anular y su número volverá a la bolsa.\n`
            : '') +
          '\nSi la plata entró de verdad y solo querés dejar constancia, usá Anular.',
      )
    )
      return

    onError?.(null)

    const { error } = await supabase.from('pagos').delete().eq('id', pago.id)
    if (error) return onError?.(error)

    if (fiscalPendiente) {
      try {
        await api.sri.liberarNumero(pago.document_id, {
          motivo: 'Anulado al borrar el cobro que lo originó',
        })
        if (pago.factura_id) {
          await supabase.from('facturas').update({ document_id: null }).eq('id', pago.factura_id)
        }
      } catch (err) {
        onError?.(
          new Error(`El cobro se borró, pero el comprobante no se anuló: ${err.message}`),
        )
      }
    }

    await recargar()
  }

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
      await recargar()
    }
  }

  const validos = filas.filter((p) => !p.anulado)
  const total = validos.reduce((s, p) => s + Number(p.monto), 0)
  const neto = validos.reduce((s, p) => s + Number(p.neto ?? p.monto), 0)

  const porCuenta = validos.reduce((acc, p) => {
    const clave = p.cuenta ?? 'Sin cuenta'
    acc[clave] = (acc[clave] ?? 0) + Number(p.monto)
    return acc
  }, {})

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Cobros" valor={validos.length} icon={Receipt} />
        <Stat label="Total cobrado" valor={dinero(total)} color="text-emerald-400" />
        <Stat label="Neto (menos comisiones)" valor={dinero(neto)} />
        <Stat label="Anulados" valor={filas.length - validos.length} color="text-red-400" />
      </div>

      {Object.keys(porCuenta).length > 0 && (
        <Card title="Por cuenta" icon={Landmark}>
          <div className="grid gap-2 sm:grid-cols-3">
            {Object.entries(porCuenta).map(([cuenta, monto]) => (
              <div
                key={cuenta}
                className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm"
              >
                <span className="text-slate-400">{cuenta}</span>
                <b className="text-slate-100">{dinero(monto)}</b>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card
        title="Pagos registrados"
        icon={ShoppingCart}
        actions={
          <input
            type="date"
            value={fecha}
            onChange={(e) => setFecha(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100"
          />
        }
      >
        {cargando ? (
          <Cargando />
        ) : filas.length === 0 ? (
          <Aviso>No hay cobros registrados en esa fecha.</Aviso>
        ) : (
          <Table
            columnas={['Cliente', 'Comprobante', 'Forma', 'Cuenta', 'N° transacción', 'Monto', '']}
            filas={filas}
            renderFila={(p) => (
              <tr key={p.id} className={`text-slate-300 ${p.anulado ? 'opacity-50' : ''}`}>
                <td className="px-3 py-2">
                  <span className="block text-slate-100">{p.cliente ?? '—'}</span>
                  <span className="text-[11px] text-slate-500">{p.identificacion ?? ''}</span>
                </td>
                <td className="px-3 py-2 font-mono text-[11px]">{p.numero_comprobante ?? '—'}</td>
                <td className="px-3 py-2 text-xs capitalize">{p.forma_pago}</td>
                <td className="px-3 py-2 text-xs">{p.cuenta ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-[11px]">{p.n_transaccion ?? '—'}</td>
                <td className="px-3 py-2">
                  <b className={p.anulado ? 'line-through' : 'text-emerald-300'}>
                    {dinero(p.monto)}
                  </b>
                  {Number(p.comision) > 0 && (
                    <span className="block text-[11px] text-slate-500">
                      comisión {dinero(p.comision)}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variante="fantasma"
                      icon={Printer}
                      title="Recibo: original y copia en la misma hoja"
                      onClick={() => abrirPdf(() => api.pagos.comprobante(p.id)).catch(onError)}
                    >
                      Recibo
                    </Button>
                    {p.activo_servicio && (
                      <span title="Este cobro reactivó el servicio">
                        <Undo2 size={13} className="text-sky-400" />
                      </span>
                    )}
                    {p.anulado ? (
                      <span
                        className="flex items-center gap-1 text-[11px] text-red-300"
                        title={p.motivo_anulacion ?? ''}
                      >
                        <Ban size={12} /> anulado
                      </span>
                    ) : (
                      // Anular y borrar deshacen plata cobrada: el cajero
                      // registra, pero revertir es otra decisión y otro permiso.
                      <ConPermiso permiso="pagos.anular" envezDe={null}>
                        <Button variante="fantasma" icon={Ban} onClick={() => setAAnular(p)}>
                          Anular
                        </Button>
                        <Button
                          variante="fantasma"
                          icon={Trash2}
                          title="Se cargó mal: borrarlo del todo"
                          onClick={() => borrar(p)}
                        />
                      </ConPermiso>
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
