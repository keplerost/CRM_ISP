import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { dineroCero as dinero } from '../../lib/formato'
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Plus,
  Printer,
  Trash2,
  Wallet,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { useTabla } from '../../lib/useTabla'
import { errorTransaccionRepetida } from '../../lib/pagos'
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
 * Facturas del sistema: lo que el negocio le cobra al abonado.
 *
 * Es distinto del comprobante del SRI —que existe solo para quien pide
 * factura— y por eso vive aparte: el abonado que no quiere factura igual debe
 * el mes, y esa deuda tiene que estar en algún lado.
 *
 * Desde acá se registra el pago, se corrige la factura y, si el cobro quedó mal
 * cargado, se borra el pago y se vuelve a registrar. Borrar el pago es lo
 * correcto y no editarlo: un cobro mal tipeado no es un cobro distinto, es un
 * cobro que no fue así.
 */

const fecha = (f) => (f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString() : '—')
const hoy = () => new Date().toISOString().slice(0, 10)

/** Primer y último día del mes de una fecha YYYY-MM o YYYY-MM-DD. */
function periodoDelMes(mes) {
  const [a, m] = String(mes).split('-').map(Number)
  const p = (x) => String(x).padStart(2, '0')
  const ultimo = new Date(a, m, 0).getDate()
  return { desde: `${a}-${p(m)}-01`, hasta: `${a}-${p(m)}-${p(ultimo)}` }
}

const mesDe = (fecha) => String(fecha ?? '').slice(0, 7)

const NOMBRE_MES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

/** "octubre de 2026" */
function mesEnPalabras(mes) {
  const [a, m] = String(mes).split('-').map(Number)
  return `${NOMBRE_MES[m - 1] ?? mes} de ${a}`
}

/**
 * El primer mes que todavía no tiene factura de servicio.
 *
 * Es lo que se propone al crear una a mano: el caso real es el abonado que
 * viene a pagar dos meses y hay que emitirle el que viene, no repetir el que ya
 * está.
 */
function proximoMesSinFactura(facturas, desde = new Date()) {
  const ocupados = new Set(
    facturas.filter((f) => !f.anulada && f.periodo_desde).map((f) => mesDe(f.periodo_desde)),
  )

  const p = (x) => String(x).padStart(2, '0')
  for (let i = 0; i < 24; i++) {
    const d = new Date(desde.getFullYear(), desde.getMonth() + i, 1)
    const clave = `${d.getFullYear()}-${p(d.getMonth() + 1)}`
    if (!ocupados.has(clave)) return clave
  }
  return `${desde.getFullYear()}-${p(desde.getMonth() + 1)}`
}

const COLOR_ESTADO = {
  pagada: 'verde',
  pendiente: 'ambar',
  vencida: 'rojo',
  anulada: 'gris',
}

const FORMAS = ['efectivo', 'transferencia', 'deposito', 'tarjeta', 'otro']

async function abrirPdf(descargar) {
  const blob = await descargar()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export default function FacturasCliente({ cliente, onError, onGuardado }) {
  const confirmar = useConfirmar()
  const { filas: cuentas } = useTabla('cuentas_pago', { orderBy: 'nombre', ascending: true })

  const [facturas, setFacturas] = useState([])
  const [pagosPorFactura, setPagosPorFactura] = useState({})
  const [cerradas, setCerradas] = useState(() => new Set())
  const [cargando, setCargando] = useState(true)

  const [cobrando, setCobrando] = useState(null)
  const [editando, setEditando] = useState(null)
  const [creando, setCreando] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const [aviso, setAviso] = useState(null)
  const [sinImputar, setSinImputar] = useState([])

  const recargar = useCallback(async () => {
    setCargando(true)

    const [f, p] = await Promise.all([
      supabase
        .from('v_facturas')
        .select('*')
        .eq('client_id', cliente.id)
        .order('fecha_emision', { ascending: false }),
      supabase
        .from('v_pagos')
        .select('*')
        .eq('client_id', cliente.id)
        .order('fecha_pago', { ascending: false }),
    ])

    // Los cobros que no se imputaron a ninguna factura: el saldo a favor. Se
    // muestran aparte porque si no la plata parece haberse evaporado — la
    // factura que la originó figura pagada justo, sin rastro del excedente.
    const aFavorFilas = (p.data ?? []).filter((x) => !x.factura_id && !x.anulado)
    setSinImputar(aFavorFilas)

    if (f.error) onError?.(f.error)

    setFacturas(f.data ?? [])
    // Se agrupan por factura para poder desplegar los pagos de cada una.
    const porFactura = {}
    for (const pago of p.data ?? []) {
      if (!pago.factura_id) continue
      ;(porFactura[pago.factura_id] ??= []).push(pago)
    }
    setPagosPorFactura(porFactura)
    setCargando(false)
  }, [cliente.id, onError])

  useEffect(() => {
    recargar()
  }, [recargar])

  // --- Acciones -------------------------------------------------------------

  async function registrarPago(e) {
    e.preventDefault()
    setGuardando(true)
    onError?.(null)

    try {
      const { data: sesion } = await supabase.auth.getUser()

      // El cobro se reparte entre las facturas que alcance, empezando por esta
      // —que es la que el cobrador tenía abierta— y siguiendo por antigüedad,
      // sin distinguir servicio de materiales. Lo que sobra queda a favor.
      const { data: resultado, error } = await supabase.rpc('aplicar_cobro', {
        p_client_id: cliente.id,
        p_monto: Number(cobrando.monto),
        p_forma_pago: cobrando.forma_pago,
        p_cuenta_id: cobrando.cuenta_id || null,
        p_n_transaccion: cobrando.n_transaccion?.trim() || null,
        p_fecha_pago: cobrando.fecha_pago,
        p_notas: cobrando.notas?.trim() || null,
        p_comision: Number(cobrando.comision) || 0,
        p_factura_id: cobrando.factura.id,
        p_created_by: sesion?.user?.id ?? null,
      })
      if (error) throw error

      const otras = (resultado.facturas ?? []).filter((f) => f.factura_id !== cobrando.factura.id)
      const avisos = []

      if (otras.length) {
        avisos.push(
          `También se saldaron ${otras.map((f) => `la N° ${f.numero} (${dinero(f.monto)})`).join(' y ')}.`,
        )
      }
      if (Number(resultado.excedente) > 0.005) {
        avisos.push(
          `Quedaron ${dinero(resultado.excedente)} a favor de ${cliente.nombre}: se aplican solos a la próxima factura.`,
        )
      }
      if (avisos.length) setAviso(avisos.join(' '))

      setCobrando(null)
      await recargar()
      await onGuardado?.()
    } catch (err) {
      // 23505 = el número de transacción ya existe.
      onError?.(
        err?.code === '23505'
          ? await errorTransaccionRepetida(cobrando.n_transaccion.trim())
          : err,
      )
    } finally {
      setGuardando(false)
    }
  }

  /**
   * Borra un pago mal registrado.
   *
   * A diferencia de la anulación desde Cobros —que deja el rastro del cierre de
   * caja del día—, acá se borra: es el pago que nunca debió existir, cargado
   * hace un momento con el comprobante o el monto equivocados.
   *
   * Si ese cobro ya generó un comprobante del SRI que todavía no se envió, el
   * comprobante se anula y la factura queda libre. Es lo que permite corregir:
   * los comprobantes se mandan a autorizar recién al cierre de la jornada, así
   * que hasta entonces todavía se está a tiempo. Uno ya autorizado no se toca —
   * eso se corrige con una nota de crédito.
   */
  async function borrarPago(pago, factura) {
    const fiscalPendiente =
      factura?.document_id && !['AUTORIZADO', 'ANULADO'].includes(factura.estado_sri)

    const fiscalAutorizado = factura?.estado_sri === 'AUTORIZADO'

    if (
      !await confirmar(
        `¿Eliminar el pago de ${dinero(pago.monto)} del ${fecha(pago.fecha_pago)}?\n\n` +
          'La factura vuelve a quedar impaga y podés registrarlo de nuevo con los datos correctos.\n' +
          (fiscalPendiente
            ? `\nEl comprobante ${factura.numero_fiscal} todavía no se envió al SRI: se va a anular para que se emita de nuevo con el valor corregido.\n`
            : '') +
          (fiscalAutorizado
            ? `\nOJO: el comprobante ${factura.numero_fiscal} ya está AUTORIZADO por el SRI. Borrar el pago no lo corrige: eso se hace con una nota de crédito.\n`
            : '') +
          '\nSi el cobro fue real y solo querés dejar constancia del error, anulalo desde Cobros.',
      )
    )
      return

    onError?.(null)

    const { error } = await supabase.from('pagos').delete().eq('id', pago.id)
    if (error) return onError?.(error)

    if (fiscalPendiente) {
      // Se anula por el middleware, que además le devuelve el número a la
      // bolsa: como el SRI nunca recibió el comprobante, ese secuencial sigue
      // libre y lo va a tomar la factura corregida. Antes de darlo por libre
      // se le pregunta al SRI, porque reutilizar uno que sí recibió haría que
      // rechace el comprobante nuevo por duplicado.
      try {
        const r = await api.sri.liberarNumero(factura.document_id, {
          motivo: 'Anulado al corregir el cobro que lo originó',
        })
        await supabase.from('facturas').update({ document_id: null }).eq('id', factura.id)
        setAviso(r.aviso)
      } catch (err) {
        onError?.(
          new Error(
            `El pago se borró, pero el comprobante ${factura.numero_fiscal} no se pudo anular: ${err.message}`,
          ),
        )
      }
    }

    await recargar()
    await onGuardado?.()
  }

  /**
   * Guarda la factura corregida.
   *
   * Si cambió el valor y ya había un comprobante del SRI sin enviar, ese
   * comprobante quedó diciendo un monto que ya no es: se anula, su número
   * vuelve a la bolsa y la factura se vuelve a poner en la cola del cierre para
   * emitirse con el valor corregido. Es exactamente la ventana que da mandar
   * los comprobantes recién al terminar la jornada.
   */
  async function guardarFactura(e) {
    e.preventDefault()

    const original = facturas.find((f) => f.id === editando.id)
    const cambioElValor = Number(editando.total) !== Number(original?.total)
    const fiscalPendiente =
      original?.document_id && !['AUTORIZADO', 'ANULADO'].includes(original.estado_sri)

    if (cambioElValor && original?.estado_sri === 'AUTORIZADO') {
      if (
        !await confirmar(
          `El comprobante ${original.numero_fiscal} ya está AUTORIZADO por ${dinero(original.total)}.\n\n` +
            'Cambiar el valor acá corrige la factura del sistema, pero NO el comprobante: para eso hace falta una nota de crédito.\n\n¿Continuar igual?',
        )
      )
        return
    }

    if (cambioElValor && fiscalPendiente) {
      if (
        !await confirmar(
          `El comprobante ${original.numero_fiscal} todavía no se envió al SRI y dice ${dinero(original.total)}.\n\n` +
            `Se va a anular y su número volverá a la bolsa, para que se emita de nuevo por ${dinero(editando.total)} al cierre de la jornada.\n\n¿Continuar?`,
        )
      )
        return
    }

    setGuardando(true)
    onError?.(null)

    try {
      const datos = {
        concepto: editando.concepto.trim(),
        fecha_emision: editando.fecha_emision,
        fecha_vencimiento: editando.fecha_vencimiento,
        subtotal: Number(editando.subtotal) || 0,
        impuesto: Number(editando.impuesto) || 0,
        total: Number(editando.total) || 0,
        notas: editando.notas?.trim() || null,
      }

      const { error } = await supabase.from('facturas').update(datos).eq('id', editando.id)
      if (error) throw error

      if (cambioElValor && fiscalPendiente) {
        const r = await api.sri.liberarNumero(original.document_id, {
          motivo: `Anulado al corregir el valor de ${dinero(original.total)} a ${dinero(editando.total)}`,
        })

        await supabase.from('facturas').update({ document_id: null }).eq('id', editando.id)

        // Los cobros de esta factura vuelven a la cola: sin esto la factura
        // corregida se quedaría sin comprobante y nadie se enteraría.
        await supabase
          .from('pagos')
          .update({ facturar: true, document_id: null })
          .eq('factura_id', editando.id)
          .eq('anulado', false)

        setAviso(`${r.aviso} La factura volvió a "Por facturar" con el valor corregido.`)
      }

      setEditando(null)
      await recargar()
      await onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  /**
   * Crea una factura a mano.
   *
   * Al igual que la generación mensual, le imputa lo que el abonado tenía a
   * favor: da lo mismo cómo nació la factura, la plata que ya entregó tiene que
   * descontarse igual. Sin esto, una factura cargada a mano le cobraba de nuevo
   * lo que ya había pagado.
   */
  async function crearFactura(e) {
    e.preventDefault()

    // Una factura de servicio por mes: si el abonado ya tiene la de octubre,
    // crear otra lo haría pagar dos veces el mismo mes. Es el error fácil de
    // cometer cuando viene a cancelar dos meses juntos.
    if (creando.tipo === 'servicios') {
      const repetida = facturas.find(
        (f) => !f.anulada && f.periodo_desde && mesDe(f.periodo_desde) === creando.mes,
      )

      if (repetida) {
        return onError?.(
          new Error(
            `Ya existe la factura N° ${String(repetida.numero).padStart(8, '0')} para ${mesEnPalabras(creando.mes)} ` +
              `(${dinero(repetida.total)}, ${repetida.estado}). Si el abonado va a pagar dos meses, cobrá esa y creá la del mes siguiente.`,
          ),
        )
      }
    }

    setGuardando(true)
    onError?.(null)

    try {
      const { data: sesion } = await supabase.auth.getUser()
      const { data: creada, error } = await supabase.from('facturas').insert({
        client_id: cliente.id,
        cliente_nombre: cliente.nombre,
        tipo: creando.tipo,
        concepto: creando.concepto.trim(),
        // El período es lo que identifica el mes facturado; sin él la base no
        // puede impedir el duplicado.
        periodo_desde:
          creando.tipo === 'servicios' && creando.mes ? periodoDelMes(creando.mes).desde : null,
        periodo_hasta:
          creando.tipo === 'servicios' && creando.mes ? periodoDelMes(creando.mes).hasta : null,
        fecha_emision: creando.fecha_emision,
        fecha_vencimiento: creando.fecha_vencimiento,
        subtotal: Number(creando.subtotal) || 0,
        impuesto: Number(creando.impuesto) || 0,
        total: Number(creando.total) || 0,
        notas: creando.notas?.trim() || null,
        created_by: sesion?.user?.id ?? null,
      })
        .select()
        .single()
      if (error) throw error

      const { data: aplicado } = await supabase.rpc('aplicar_saldo_a_favor', {
        p_factura_id: creada.id,
      })
      if (Number(aplicado) > 0) {
        setAviso(
          `Se le aplicaron ${dinero(aplicado)} que tenía a favor: la factura queda con ${dinero(Number(creando.total) - Number(aplicado))} por cobrar.`,
        )
      }

      setCreando(null)
      await recargar()
      await onGuardado?.()
    } catch (err) {
      // La base tiene su propio índice único por período: es la red para el
      // caso en que dos personas creen el mismo mes a la vez, o cuando la
      // generación automática se adelantó mientras el modal estaba abierto.
      onError?.(
        err?.code === '23505'
          ? new Error(
              `Ya existe una factura de servicio para ${mesEnPalabras(creando.mes)}. Actualizá la lista para verla.`,
            )
          : err,
      )
    } finally {
      setGuardando(false)
    }
  }

  /**
   * Aplica el saldo a favor sin esperar a la próxima generación.
   *
   * Es el caso del mostrador: el abonado pagó de más el mes pasado y hoy viene
   * a preguntar por qué le figura deuda. Se imputa a la factura pendiente más
   * vieja, que es el mismo criterio de la generación mensual.
   */
  async function aplicarSaldoAhora() {
    // El servicio primero: es lo que decide el corte. Recién después los
    // materiales y la instalación, de la más vieja a la más nueva.
    const pendientes = facturas
      .filter((f) => Number(f.saldo) > 0.005 && !f.anulada)
      .sort(
        (a, b) =>
          (a.tipo === 'servicios' ? 0 : 1) - (b.tipo === 'servicios' ? 0 : 1) ||
          String(a.fecha_emision).localeCompare(String(b.fecha_emision)),
      )

    if (!pendientes.length) return

    setGuardando(true)
    onError?.(null)
    try {
      const { data: aplicado, error } = await supabase.rpc('aplicar_saldo_a_favor', {
        p_factura_id: pendientes[0].id,
      })
      if (error) throw error

      setAviso(
        `Se aplicaron ${dinero(aplicado)} a la factura N° ${String(pendientes[0].numero).padStart(8, '0')}.`,
      )
      await recargar()
      await onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  async function eliminarFactura(f) {
    const pagos = pagosPorFactura[f.id] ?? []

    if (f.document_id) {
      return onError?.(
        new Error(
          `La factura ${f.numero_fiscal ?? ''} ya tiene comprobante emitido ante el SRI y no se puede borrar. ` +
            'Un comprobante autorizado se anula con una nota de crédito.',
        ),
      )
    }

    const cobrado = pagos.reduce((s, p) => s + (p.anulado ? 0 : Number(p.monto)), 0)

    if (
      !await confirmar(
        `¿Eliminar la factura N° ${String(f.numero).padStart(8, '0')} por ${dinero(f.total)}?` +
          (pagos.length
            ? `\n\nSe van a borrar también sus ${pagos.length} pago(s), por ${dinero(cobrado)} en total.\n` +
              'Si esa plata entró de verdad, cancelá: borrar la factura sin sus pagos dejaría el dinero como saldo a favor del cliente.'
            : ''),
      )
    )
      return

    onError?.(null)

    // Los pagos se borran primero y a propósito: la base los desvincularía
    // dejándolos sin factura, y esa plata aparecería como saldo a favor sin que
    // nadie sepa de dónde salió.
    if (pagos.length) {
      const { error: errPagos } = await supabase.from('pagos').delete().eq('factura_id', f.id)
      if (errPagos) {
        return onError?.(new Error(`No se pudieron borrar los pagos: ${errPagos.message}`))
      }
    }

    const { error } = await supabase.from('facturas').delete().eq('id', f.id)
    if (error) onError?.(error)
    else {
      await recargar()
      await onGuardado?.()
    }
  }

  // --- Cálculo del impuesto según la configuración del cliente ---------------

  /**
   * Reparte un total entre base e impuesto según cómo se le factura al abonado.
   * Es la misma regla que usa la generación mensual.
   */
  function repartir(valor, tarifa = 15) {
    const n = Number(valor) || 0
    const tipo = cliente.tipo_impuesto ?? 'incluido'

    if (tipo === 'ninguno') return { subtotal: n, impuesto: 0, total: n }
    if (tipo === 'mas') {
      const imp = Math.round(n * (tarifa / 100) * 100) / 100
      return { subtotal: n, impuesto: imp, total: Math.round((n + imp) * 100) / 100 }
    }
    // Incluido: el precio ya trae el IVA y se desglosa hacia atrás.
    const base = Math.round((n / (1 + tarifa / 100)) * 100) / 100
    return { subtotal: base, impuesto: Math.round((n - base) * 100) / 100, total: n }
  }

  if (cargando) return <Cargando />

  const pendientes = facturas.filter((f) => ['pendiente', 'vencida'].includes(f.estado))
  const deuda = pendientes.reduce((s, f) => s + Number(f.saldo), 0)
  // Lo pagado de más sobre facturas ya cubiertas: es plata del abonado.
  const aFavor = facturas.reduce((s, f) => s + Math.max(0, -Number(f.saldo ?? 0)), 0)

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Facturas" valor={facturas.length} icon={Wallet} />
        <Stat
          label="Vencidas"
          valor={facturas.filter((f) => f.estado === 'vencida').length}
          color="text-red-400"
        />
        <Stat label="Deuda" valor={dinero(deuda)} color={deuda > 0 ? 'text-red-400' : 'text-emerald-400'} />
        <Stat
          label={aFavor > 0.005 ? 'Saldo a favor' : 'Facturado'}
          valor={aFavor > 0.005 ? dinero(aFavor) : dinero(facturas.reduce((s, f) => s + Number(f.total), 0))}
          color={aFavor > 0.005 ? 'text-fuchsia-400' : 'text-slate-400'}
        />
      </div>

      {aviso && (
        <Aviso>
          {aviso}{' '}
          <button
            type="button"
            onClick={() => setAviso(null)}
            className="ml-1 underline hover:text-slate-200"
          >
            cerrar
          </button>
        </Aviso>
      )}

      {/* La plata que entró y todavía no se aplicó. Va antes de las facturas
          porque es lo primero que hay que ver: explica por qué una factura
          figura pagada justo y de dónde va a salir el descuento del mes que
          viene. */}
      {sinImputar.length > 0 && (
        <Card title="Saldo a favor" icon={Wallet}>
          <div className="space-y-2">
            <p className="text-sm text-slate-300">
              <b className="text-fuchsia-300">
                {dinero(sinImputar.reduce((s, p) => s + Number(p.monto), 0))}
              </b>{' '}
              cobrados que todavía no se aplicaron a ninguna factura. Se descuentan solos de la
              próxima que se le genere.
            </p>

            {sinImputar.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 t-panel px-3 py-2 text-xs"
              >
                <span className="text-slate-400">
                  Recibo N° {String(p.numero ?? '').padStart(6, '0')} · {fecha(p.fecha_pago)} ·{' '}
                  {p.forma_pago}
                  {p.notas ? <span className="block text-slate-500">{p.notas}</span> : null}
                </span>
                <span className="flex items-center gap-2">
                  <b className="text-fuchsia-300">{dinero(p.monto)}</b>
                  <Button
                    variante="fantasma"
                    icon={Trash2}
                    title="Se cargó mal: borrarlo"
                    onClick={() => borrarPago(p, null)}
                  />
                </span>
              </div>
            ))}

            {facturas.some((f) => Number(f.saldo) > 0.005) && (
              <Button
                variante="secundario"
                icon={Check}
                onClick={aplicarSaldoAhora}
                cargando={guardando}
              >
                Aplicarlo ahora a la factura pendiente más vieja
              </Button>
            )}
          </div>
        </Card>
      )}

      <Card
        title="Facturas"
        subtitle="Lo que se le cobra, con o sin comprobante fiscal"
        icon={Wallet}
        actions={
          <Button
            variante="primario"
            icon={Plus}
            onClick={() => {
              const base = repartir(cliente.precio_mensual ?? cliente.plan_precio ?? 0)
              const mes = proximoMesSinFactura(facturas)
              const periodo = periodoDelMes(mes)
              const dia = String(cliente.dia_facturacion ?? 5).padStart(2, '0')

              setCreando({
                tipo: 'servicios',
                concepto: cliente.descripcion_servicio || cliente.plan || 'Servicio de internet',
                mes,
                fecha_emision: periodo.desde,
                // Vence el día de pago del abonado dentro de ese mes.
                fecha_vencimiento: `${mes}-${dia}`,
                ...base,
                notas: '',
              })
            }}
          >
            Nueva factura
          </Button>
        }
      >
        {facturas.length === 0 ? (
          <Aviso>
            Todavía no tiene facturas. Se crean solas cada mes según su configuración, o a mano con
            el botón de arriba.
          </Aviso>
        ) : (
          <Table
            columnas={[
              '',
              'N° factura',
              'N° fiscal',
              'Emitido',
              'Vencimiento',
              'Estado',
              'Total',
              'Impuesto',
              'Pagado',
              'Fecha pago',
              'Forma',
              '',
            ]}
            filas={facturas}
            renderFila={(f) => {
              const pagos = pagosPorFactura[f.id] ?? []
              // Los pagos se muestran de entrada: son lo que hay que revisar
              // cuando el abonado dice que pagó y el sistema dice que no.
              const desplegada = pagos.length > 0 && !cerradas.has(f.id)

              return (
                <>
                  <tr key={f.id} className="text-slate-300">
                    <td className="px-2 py-2">
                      {pagos.length > 0 && (
                        <button
                          onClick={() =>
                            setCerradas((prev) => {
                              const s = new Set(prev)
                              if (s.has(f.id)) s.delete(f.id)
                              else s.add(f.id)
                              return s
                            })
                          }
                          className="text-slate-500 hover:text-slate-300"
                          title={`${pagos.length} pago(s)`}
                        >
                          {desplegada ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-100">
                      {String(f.numero).padStart(8, '0')}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-400">
                      {f.numero_fiscal ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs">{fecha(f.fecha_emision)}</td>
                    <td className="px-3 py-2 text-xs">{fecha(f.fecha_vencimiento)}</td>
                    <td className="px-3 py-2">
                      <Badge color={COLOR_ESTADO[f.estado] ?? 'gris'}>{f.estado}</Badge>
                    </td>
                    <td className="px-3 py-2">{dinero(f.total)}</td>
                    <td className="px-3 py-2 text-xs text-slate-400">{dinero(f.impuesto)}</td>
                    <td className="px-3 py-2">
                      <b className={Number(f.saldo) > 0.005 ? 'text-amber-300' : 'text-emerald-300'}>
                        {dinero(f.pagado)}
                      </b>
                      {Number(f.saldo) > 0.005 && (
                        <span className="block text-[11px] text-slate-500">
                          debe {dinero(f.saldo)}
                        </span>
                      )}
                      {/* Pagó de más: esa diferencia es plata del abonado. */}
                      {Number(f.saldo) < -0.005 && (
                        <span className="block text-[11px] text-fuchsia-300">
                          a favor {dinero(-f.saldo)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{fecha(f.ultimo_pago)}</td>
                    <td className="px-3 py-2 text-xs capitalize">{f.formas_pago ?? '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        {Number(f.saldo) > 0.005 && !f.anulada && (
                          <Button
                            variante="fantasma"
                            icon={Wallet}
                            title="Registrar un pago de esta factura"
                            onClick={() =>
                              setCobrando({
                                factura: f,
                                monto: Number(f.saldo).toFixed(2),
                                comision: '0',
                                forma_pago: 'efectivo',
                                cuenta_id: cuentas[0]?.id ?? '',
                                n_transaccion: '',
                                fecha_pago: hoy(),
                                notas: '',
                              })
                            }
                          >
                            Pagar
                          </Button>
                        )}
                        {/* El PDF de la factura sale siempre: es el estado de
                            cuenta con sus pagos y su saldo. El RIDE es otra
                            cosa y solo existe si se emitió el comprobante. */}
                        <Button
                          variante="fantasma"
                          icon={Printer}
                          title="Ver la factura con sus pagos"
                          onClick={() => abrirPdf(() => api.pagos.facturaPdf(f.id)).catch(onError)}
                        />
                        {f.document_id && (
                          <Button
                            variante="fantasma"
                            icon={FileText}
                            title={`Ver el RIDE del comprobante ${f.numero_fiscal ?? ''}`}
                            onClick={() => abrirPdf(() => api.sri.ride(f.document_id)).catch(onError)}
                          />
                        )}
                        <Button
                          variante="fantasma"
                          icon={Check}
                          title="Editar la factura"
                          onClick={() =>
                            setEditando({
                              id: f.id,
                              numero: f.numero,
                              concepto: f.concepto ?? '',
                              fecha_emision: String(f.fecha_emision).slice(0, 10),
                              fecha_vencimiento: String(f.fecha_vencimiento).slice(0, 10),
                              subtotal: f.subtotal,
                              impuesto: f.impuesto,
                              total: f.total,
                              notas: f.notas ?? '',
                              tieneFiscal: Boolean(f.document_id),
                            })
                          }
                        />
                        <Button
                          variante="fantasma"
                          icon={Trash2}
                          title="Eliminar la factura"
                          onClick={() => eliminarFactura(f)}
                        />
                      </div>
                    </td>
                  </tr>

                  {desplegada &&
                    pagos.map((p) => (
                      <tr key={p.id} className="bg-[#F6F8FB] text-[11px] text-slate-400">
                        <td />
                        <td className="px-3 py-1.5" colSpan={4}>
                          Recibo N° {String(p.numero ?? '').padStart(6, '0')} ·{' '}
                          {fecha(p.fecha_pago)} · {p.forma_pago}
                          {p.n_transaccion ? ` · ${p.n_transaccion}` : ''}
                          {p.cuenta ? ` · ${p.cuenta}` : ''}
                        </td>
                        <td className="px-3 py-1.5" colSpan={4}>
                          {p.anulado ? (
                            <span className="text-red-300">anulado</span>
                          ) : (
                            <>
                              <span className="text-emerald-300">{dinero(p.monto)}</span>
                              {/* Lo que el abonado entregó, cuando dejó
                                  excedente: si no, el detalle parece decir que
                                  pagó justo. */}
                              {Number(p.excedente) > 0.005 && (
                                <span className="ml-2 text-fuchsia-300">
                                  de {dinero(p.total_cobro)} · {dinero(p.excedente)} a favor
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        <td colSpan={2} />
                        <td className="px-3 py-1.5">
                          <div className="flex justify-end">
                            <Button
                              variante="fantasma"
                              icon={Trash2}
                              title="El pago quedó mal registrado: borrarlo y volver a cargarlo"
                              onClick={() => borrarPago(p, f)}
                            >
                              Eliminar pago
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                </>
              )
            }}
          />
        )}
      </Card>

      {/* --- Registrar un pago ------------------------------------------- */}
      <Modal
        abierto={Boolean(cobrando)}
        titulo={`Pago de la factura N° ${String(cobrando?.factura?.numero ?? '').padStart(8, '0')}`}
        onCerrar={() => setCobrando(null)}
      >
        {cobrando && (
          <form onSubmit={registrarPago} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Monto" hint={`Saldo: ${dinero(cobrando.factura.saldo)}`}>
                <Input
                  type="number"
                  step="0.01"
                  min={0.01}
                  value={cobrando.monto}
                  onChange={(e) => setCobrando((c) => ({ ...c, monto: e.target.value }))}
                  required
                  autoFocus
                />
              </Field>
              <Field label="Fecha del pago">
                <Input
                  type="date"
                  value={cobrando.fecha_pago}
                  onChange={(e) => setCobrando((c) => ({ ...c, fecha_pago: e.target.value }))}
                  max={hoy()}
                />
              </Field>

              <Field label="Forma de pago">
                <Select
                  value={cobrando.forma_pago}
                  onChange={(e) => setCobrando((c) => ({ ...c, forma_pago: e.target.value }))}
                >
                  {FORMAS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Cuenta de destino">
                <Select
                  value={cobrando.cuenta_id}
                  onChange={(e) => setCobrando((c) => ({ ...c, cuenta_id: e.target.value }))}
                  required
                >
                  <option value="">— elegí una cuenta —</option>
                  {cuentas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nombre}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="N° de transacción / recibo"
                hint={
                  cobrando.forma_pago === 'efectivo'
                    ? 'El N° del recibo manual que le entregaste'
                    : 'El N° del comprobante del banco'
                }
              >
                <Input
                  value={cobrando.n_transaccion}
                  onChange={(e) => setCobrando((c) => ({ ...c, n_transaccion: e.target.value }))}
                  required
                  className="font-mono"
                />
              </Field>
              <Field label="Comisión">
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  value={cobrando.comision}
                  onChange={(e) => setCobrando((c) => ({ ...c, comision: e.target.value }))}
                />
              </Field>
            </div>

            {Number(cobrando.monto) < Number(cobrando.factura.saldo) && (
              <Aviso tipo="alerta">
                Cobro parcial: quedarían{' '}
                {dinero(Number(cobrando.factura.saldo) - Number(cobrando.monto))} pendientes.
              </Aviso>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variante="fantasma" onClick={() => setCobrando(null)}>
                Cancelar
              </Button>
              <Button type="submit" variante="primario" icon={Check} cargando={guardando}>
                Registrar pago
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* --- Editar la factura -------------------------------------------- */}
      <Modal
        abierto={Boolean(editando)}
        titulo={`Factura N° ${String(editando?.numero ?? '').padStart(8, '0')}`}
        onCerrar={() => setEditando(null)}
      >
        {editando && (
          <form onSubmit={guardarFactura} className="space-y-4">
            {editando.tieneFiscal && (
              <Aviso tipo="alerta">
                Esta factura ya tiene comprobante emitido ante el SRI. Cambiar los montos acá{' '}
                <b>no</b> cambia el comprobante: para eso hace falta una nota de crédito.
              </Aviso>
            )}

            <Field label="Concepto">
              <Input
                value={editando.concepto}
                onChange={(e) => setEditando((f) => ({ ...f, concepto: e.target.value }))}
                required
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Emitida">
                <Input
                  type="date"
                  value={editando.fecha_emision}
                  onChange={(e) => setEditando((f) => ({ ...f, fecha_emision: e.target.value }))}
                />
              </Field>
              <Field label="Vence">
                <Input
                  type="date"
                  value={editando.fecha_vencimiento}
                  onChange={(e) =>
                    setEditando((f) => ({ ...f, fecha_vencimiento: e.target.value }))
                  }
                />
              </Field>

              <Field label="Subtotal">
                <Input
                  type="number"
                  step="0.01"
                  value={editando.subtotal}
                  onChange={(e) => setEditando((f) => ({ ...f, subtotal: e.target.value }))}
                />
              </Field>
              <Field label="Impuesto">
                <Input
                  type="number"
                  step="0.01"
                  value={editando.impuesto}
                  onChange={(e) => setEditando((f) => ({ ...f, impuesto: e.target.value }))}
                />
              </Field>
              <Field label="Total" className="sm:col-span-2">
                <Input
                  type="number"
                  step="0.01"
                  value={editando.total}
                  onChange={(e) => setEditando((f) => ({ ...f, total: e.target.value }))}
                  className="text-lg font-semibold text-emerald-300"
                />
              </Field>
            </div>

            <Field label="Notas">
              <Textarea
                rows={2}
                value={editando.notas}
                onChange={(e) => setEditando((f) => ({ ...f, notas: e.target.value }))}
              />
            </Field>

            <div className="flex justify-end gap-2">
              <Button type="button" variante="fantasma" onClick={() => setEditando(null)}>
                Cancelar
              </Button>
              <Button type="submit" variante="primario" icon={Check} cargando={guardando}>
                Guardar
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* --- Nueva factura ------------------------------------------------ */}
      <Modal abierto={Boolean(creando)} titulo="Nueva factura" onCerrar={() => setCreando(null)}>
        {creando && (
          <form onSubmit={crearFactura} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Tipo">
                <Select
                  value={creando.tipo}
                  onChange={(e) => setCreando((f) => ({ ...f, tipo: e.target.value }))}
                >
                  <option value="servicios">Servicio mensual</option>
                  <option value="instalacion">Instalación</option>
                  <option value="libre">Factura libre</option>
                  <option value="otro">Otro</option>
                </Select>
              </Field>
              <Field
                label="Importe"
                hint={
                  cliente.tipo_impuesto === 'mas'
                    ? 'Se le suma el IVA'
                    : cliente.tipo_impuesto === 'ninguno'
                      ? 'Sin impuesto'
                      : 'El importe ya incluye el IVA'
                }
              >
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  value={creando.total}
                  onChange={(e) => {
                    const r = repartir(e.target.value)
                    setCreando((f) => ({ ...f, ...r, total: e.target.value }))
                  }}
                  required
                />
              </Field>

              <Field label="Concepto" className="sm:col-span-2">
                <Input
                  value={creando.concepto}
                  onChange={(e) => setCreando((f) => ({ ...f, concepto: e.target.value }))}
                  required
                />
              </Field>

              {creando.tipo === 'servicios' && (
                <Field
                  label="Mes facturado"
                  className="sm:col-span-2"
                  hint={
                    facturas.some(
                      (f) => !f.anulada && f.periodo_desde && mesDe(f.periodo_desde) === creando.mes,
                    )
                      ? `Ya existe una factura para ${mesEnPalabras(creando.mes)}.`
                      : `Se propone ${mesEnPalabras(creando.mes)}, el primer mes sin facturar.`
                  }
                >
                  <Input
                    type="month"
                    value={creando.mes}
                    onChange={(e) => {
                      const mes = e.target.value
                      const periodo = periodoDelMes(mes)
                      const dia = String(cliente.dia_facturacion ?? 5).padStart(2, '0')
                      setCreando((f) => ({
                        ...f,
                        mes,
                        fecha_emision: periodo.desde,
                        fecha_vencimiento: `${mes}-${dia}`,
                      }))
                    }}
                    required
                  />
                </Field>
              )}

              <Field label="Emitida">
                <Input
                  type="date"
                  value={creando.fecha_emision}
                  onChange={(e) => setCreando((f) => ({ ...f, fecha_emision: e.target.value }))}
                />
              </Field>
              <Field label="Vence">
                <Input
                  type="date"
                  value={creando.fecha_vencimiento}
                  onChange={(e) =>
                    setCreando((f) => ({ ...f, fecha_vencimiento: e.target.value }))
                  }
                />
              </Field>
            </div>

            <div className="t-card-sm p-3 text-xs text-slate-400">
              <div className="flex justify-between py-0.5">
                <span>Subtotal</span>
                <span>{dinero(creando.subtotal)}</span>
              </div>
              <div className="flex justify-between py-0.5">
                <span>Impuesto</span>
                <span>{dinero(creando.impuesto)}</span>
              </div>
              <div className="mt-1 flex justify-between border-t border-slate-800 pt-1.5">
                <span>Total</span>
                <b className="text-emerald-300">{dinero(creando.total)}</b>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variante="fantasma" onClick={() => setCreando(null)}>
                Cancelar
              </Button>
              <Button type="submit" variante="primario" icon={Plus} cargando={guardando}>
                Crear factura
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
