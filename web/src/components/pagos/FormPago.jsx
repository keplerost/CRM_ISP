import { useEffect, useMemo, useState } from 'react'
import { dineroCero as dinero } from '../../lib/formato'
import { AlertTriangle, Check } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { imprimirPdf } from '../../lib/pdf'
import { errorTransaccionRepetida } from '../../lib/pagos'
import { usePermisos } from '../../lib/AuthContext'
import { Aviso, Button, Field, Input, Select, Textarea } from '../ui'

/**
 * Registro de un cobro.
 *
 * Dos decisiones que explican la forma de este formulario:
 *
 * 1. Una factura no se marca como "pagada": el saldo se calcula sumando los
 *    pagos aplicados. Así un cobro parcial —lo normal cuando el abonado trae
 *    la mitad— deja el resto pendiente sin ningún estado intermedio que
 *    mantener a mano.
 * 2. El monto viene sugerido pero se puede editar. Obligar a pagar el total
 *    exacto haría que el cobrador registre mal el pago para poder cerrarlo.
 */

/**
 * Cómo pagó, y a qué clase de cuenta puede entrar esa plata.
 *
 * ── El error que esto corrige ──
 *
 * El selector ofrecía TODAS las cuentas sin mirar la forma de pago, así que al
 * cobrar en efectivo se elegía entre cuentas del banco. Esa plata no está en
 * ningún banco: está en la caja de la oficina, en la mano de quien cobró.
 *
 * No es un detalle cosmético. Un cobro en efectivo imputado a la cuenta del
 * Pichincha aparece después en la conciliación como "sin respaldo" —el banco no
 * lo tiene, obviamente— y manda a llamar a un abonado que pagó en ventanilla.
 *
 * `electronico` es lo que decide si la cuenta es obligatoria: el efectivo entra a
 * caja y el resto deja rastro en algún lado.
 */
const FORMAS_PAGO = [
  { valor: 'efectivo', label: 'Efectivo', tipos: ['efectivo'], electronico: false },
  { valor: 'transferencia', label: 'Transferencia', tipos: ['banco'], electronico: true },
  { valor: 'deposito', label: 'Depósito', tipos: ['banco'], electronico: true },
  { valor: 'tarjeta', label: 'Tarjeta', tipos: ['banco'], electronico: true },
  // Billeteras, cobros por convenio, lo que aparezca. Se ofrecen todas porque no
  // se sabe cuál corresponde, pero la cuenta se sigue pidiendo.
  { valor: 'otro', label: 'Otro', tipos: null, electronico: true },
]

/**
 * Las formas de pago que este usuario puede usar.
 *
 * Sin `pagos.otras_formas`, solo efectivo. Es lo que corresponde a un punto de
 * recaudación: cobra en la mano y no tiene con qué verificar una transferencia.
 */
export function formasPara(puede) {
  return puede('pagos.otras_formas') ? FORMAS_PAGO : FORMAS_PAGO.filter((f) => !f.electronico)
}

/** Las cuentas donde puede entrar un pago hecho de esta forma. */
export function cuentasPara(cuentas = [], formaPago = 'efectivo') {
  const forma = FORMAS_PAGO.find((f) => f.valor === formaPago)
  if (!forma?.tipos) return cuentas
  return cuentas.filter((c) => forma.tipos.includes(c.tipo))
}

/** ¿Hace falta decir a qué cuenta entró? */
export function exigeCuenta(formaPago = 'efectivo') {
  return FORMAS_PAGO.find((f) => f.valor === formaPago)?.electronico ?? true
}

/**
 * De dónde sale el número según cómo pagó.
 *
 * Todo cobro tiene un número único: el del comprobante del banco cuando pasó
 * por ahí, y el del recibo manual cuando fue en efectivo. Es lo que permite
 * detectar que la misma transferencia —o el mismo recibo— se cargó dos veces.
 */
const ORIGEN_NUMERO = {
  efectivo: 'Si usaste recibera, anotá su número. Si imprimís el recibo, dejalo vacío.',
  transferencia: 'El N° del comprobante del banco',
  deposito: 'El N° del comprobante del depósito',
  tarjeta: 'El N° del voucher',
  otro: 'El número con el que identificás este cobro',
}

const hoy = () => new Date().toISOString().slice(0, 10)

/** Fecha a N días de hoy, en YYYY-MM-DD local. */
function enDias(n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Días de gracia que se dan por sobre la fecha máxima de pago. */
const DIAS_DE_GRACIA = 5

/**
 * Fecha límite sugerida para una promesa.
 *
 * El abonado tiene hasta el día `diaMaximo` de cada mes para pagar; la promesa
 * le da unos días más sobre esa fecha, no sobre hoy. Contarlos desde hoy daría
 * plazos distintos según el día en que se acerque a pedirlos, y el que viene
 * tarde terminaría con más tiempo que el que avisó a tiempo.
 *
 * Si esa fecha ya pasó —el abonado viene bien atrasado—, la gracia se cuenta
 * desde hoy: una fecha en el pasado no sirve como plazo.
 */
export function fechaSugerida(diaMaximo = 5, hoyIso = null) {
  const p = (x) => String(x).padStart(2, '0')
  const iso = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`

  const ahora = hoyIso ? new Date(`${hoyIso}T12:00:00`) : new Date()
  const dia = Math.min(Math.max(1, Number(diaMaximo) || 5), 28)
  const hoyMediodia = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), 12)

  const conGracia = new Date(ahora.getFullYear(), ahora.getMonth(), dia, 12)
  conGracia.setDate(conGracia.getDate() + DIAS_DE_GRACIA)

  if (conGracia >= hoyMediodia) return iso(conGracia)

  const desdeHoy = new Date(hoyMediodia)
  desdeHoy.setDate(desdeHoy.getDate() + DIAS_DE_GRACIA)
  return iso(desdeHoy)
}

/** Cuántos días faltan para una fecha. */
function diasHasta(iso) {
  if (!iso) return null
  const hoyD = new Date(`${enDias(0)}T12:00:00`)
  const objetivo = new Date(`${iso}T12:00:00`)
  return Math.round((objetivo - hoyD) / 86400000)
}

export default function FormPago({ cliente, onRegistrado, onCancelar, onError }) {
  const { puede } = usePermisos()
  /**
   * Las formas que puede usar, resueltas una vez.
   *
   * Si le queda una sola, el formulario arranca con esa: dejar seleccionado
   * "efectivo" cuando es lo único posible evita un estado inicial que la pantalla
   * ya no ofrece.
   */
  const formasPosibles = formasPara(puede)

  const [facturas, setFacturas] = useState([])
  const [cuentas, setCuentas] = useState([])
  const [promesa, setPromesa] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [repetida, setRepetida] = useState(null)

  const [form, setForm] = useState({
    document_id: '',
    monto: '',
    comision: '0',
    forma_pago: 'efectivo',
    cuenta_id: '',
    n_transaccion: '',
    fecha_pago: hoy(),
    tipo: 'registrar',
    dia_pago: cliente.dia_facturacion ?? '',
    notas: '',
    // Hasta cuándo se le habilita el servicio cuando en vez de pagar promete.
    // Se recalcula al cargar, con el día máximo de pago configurado.
    fecha_limite: fechaSugerida(),
    // Se le emite factura electrónica por este cobro. Arranca con lo que dice
    // la ficha del cliente, pero se decide cobro por cobro: el mismo abonado
    // puede pedir factura un mes y no pedirla al siguiente.
    facturar: cliente.factura_electronica !== false,
    // Cuando el cobro es parcial, el resto puede quedar prometido.
    promesa_saldo: false,
    fecha_saldo: fechaSugerida(),
  })

  /** Día del mes hasta el que se puede pagar, de la configuración del emisor. */
  const [diaMaximo, setDiaMaximo] = useState(5)

  const esPromesa = form.tipo === 'promesa'
  const diasFaltantes = diasHasta(form.fecha_limite)

  const set = (campo) => (e) => {
    const valor = e.target.value

    /**
     * Cambiar la forma de pago cambia a qué cuentas puede entrar.
     *
     * Sin esto, quien elige "Efectivo" después de haber tenido "Transferencia"
     * se queda con la cuenta del banco seleccionada —ya no aparece en la lista,
     * pero sigue guardada— y el cobro en efectivo termina imputado al Pichincha.
     * Un valor que el usuario ya no puede ver es un valor que nadie corrige.
     */
    if (campo === 'forma_pago') {
      setForm((f) => {
        const posibles = cuentasPara(cuentas, valor)
        const sigueValiendo = posibles.some((c) => c.id === f.cuenta_id)
        return {
          ...f,
          forma_pago: valor,
          // Si hay una sola, se elige sola: es el caso del efectivo, que casi
          // siempre tiene una única caja.
          cuenta_id: sigueValiendo ? f.cuenta_id : (posibles.length === 1 ? posibles[0].id : ''),
        }
      })
      return
    }

    setForm((f) => ({ ...f, [campo]: valor }))
  }

  useEffect(() => {
    let vigente = true

    async function cargar() {
      setCargando(true)
      try {
        const [f, c, p, cfg] = await Promise.all([
          supabase
            .from('v_facturas_por_cobrar')
            .select('*')
            .eq('client_id', cliente.id)
            .order('fecha_emision'),
          /**
           * Las cuentas que ESTE usuario puede usar, no todas.
           *
           * Cada cobrador tiene su caja: la vista devuelve las suyas —o las de la
           * oficina si no tiene ninguna— más todas las cuentas bancarias, que no
           * son de nadie en particular. Ofrecer la caja de otro hace que su arqueo
           * cierre mal y el propio bien, y nadie entiende por qué.
           */
          supabase.from('v_mis_cuentas_de_cobro').select('*').order('nombre'),
          supabase
            .from('promesas_pago')
            .select('*')
            .eq('client_id', cliente.id)
            .eq('estado', 'activa')
            .maybeSingle(),
          supabase.from('sri_config').select('dia_maximo_pago').limit(1).maybeSingle(),
        ])

        if (!vigente) return
        if (f.error) throw f.error
        if (c.error) throw c.error

        setFacturas(f.data ?? [])
        setCuentas(c.data ?? [])
        setPromesa(p.data ?? null)

        const dia = cfg.data?.dia_maximo_pago ?? 5
        setDiaMaximo(dia)

        // La factura más vieja es la que se cobra primero, y su saldo es el
        // monto que casi siempre corresponde.
        const primera = f.data?.[0]
        setForm((prev) => ({
          ...prev,
          document_id: primera?.id ?? '',
          monto: primera ? Number(primera.saldo).toFixed(2) : '',
          /**
           * La cuenta que se propone tiene que servir para la forma de pago con
           * la que abre el formulario —efectivo—, no ser la primera de la lista.
           *
           * La primera alfabéticamente puede ser una cuenta del banco, y el
           * cajero que no toca ese campo termina imputando el efectivo al
           * Pichincha sin haber elegido nada.
           */
          cuenta_id: cuentasPara(c.data ?? [], prev.forma_pago)[0]?.id ?? '',
          dia_pago: cliente.dia_facturacion ?? '',
          fecha_limite: fechaSugerida(dia),
          fecha_saldo: fechaSugerida(dia),
        }))
      } catch (err) {
        if (vigente) onError?.(err)
      } finally {
        if (vigente) setCargando(false)
      }
    }

    cargar()
    return () => {
      vigente = false
    }
  }, [cliente.id, cliente.dia_facturacion, onError])

  /**
   * Lo que queda debiendo de la factura después de este cobro.
   *
   * Media unidad de centavo de tolerancia: el redondeo del IVA no puede dejar
   * un saldo de $0.00 ofreciendo una promesa por nada.
   */
  const facturaElegida = facturas.find((f) => f.id === form.document_id)

  // La deuda que el cobro va a saldar solo: los meses de servicio, más la
  // factura elegida si es de otro tipo. Los cables y la instalación no entran
  // acá —se cobran eligiéndolos— porque el pago del mes no puede irse en ellos y
  // dejar el servicio impago.
  const totalPendiente = useMemo(() => {
    const cuentan = facturas.filter((f) => f.tipo === 'servicios' || f.id === form.document_id)
    return cuentan.reduce((s, f) => s + Number(f.saldo ?? 0), 0)
  }, [facturas, form.document_id])

  const otrosConceptos = useMemo(
    () =>
      facturas.filter((f) => f.tipo !== 'servicios' && f.id !== form.document_id),
    [facturas, form.document_id],
  )

  const saldoRestante = Math.round((totalPendiente - Number(form.monto || 0)) * 100) / 100
  const esCobroParcial = !esPromesa && saldoRestante > 0.005
  // El otro lado: trae más de lo que debía y la diferencia le queda a favor.
  const excedente = !esPromesa ? Math.round(-saldoRestante * 100) / 100 : 0
  const hayExcedente = excedente > 0.005

  /**
   * Avisa si ese número de transacción ya se registró.
   *
   * La base lo rechaza igual, pero enterarse al salir del campo evita llenar
   * todo el formulario para descubrirlo al guardar.
   */
  async function verificarTransaccion() {
    const numero = form.n_transaccion.trim()
    if (!numero) return setRepetida(null)

    const { data } = await supabase
      .from('v_pagos')
      .select('numero, cliente, monto, fecha_pago')
      .eq('n_transaccion', numero)
      .eq('anulado', false)
      .maybeSingle()

    setRepetida(data ?? null)
  }

  /** Al cambiar de comprobante, el monto sugerido es su saldo. */
  function elegirComprobante(e) {
    const id = e.target.value
    const f = facturas.find((x) => x.id === id)
    setForm((prev) => ({ ...prev, document_id: id, monto: f ? Number(f.saldo).toFixed(2) : prev.monto }))
  }

  /**
   * Quita al cliente del address-list de morosos.
   *
   * Es lo único de este formulario que toca la red, así que va por el
   * middleware. Que falle no invalida el cobro: la plata entró igual y el
   * pago ya quedó registrado — por eso se informa aparte en vez de abortar.
   */
  async function activarServicio() {
    if (!cliente.router_id || !cliente.ip) {
      return { ok: false, nota: 'El cliente no tiene router o IP asignados: activalo a mano.' }
    }

    try {
      const entradas = await api.mikrotik.bloqueos(cliente.router_id)
      const entrada = entradas.find(
        (e) => e.address === cliente.ip || String(e.address).startsWith(`${cliente.ip}/`),
      )

      if (!entrada) return { ok: true, nota: 'No estaba bloqueado en el router.' }

      await api.mikrotik.desbloquear(cliente.router_id, entrada.id)
      return { ok: true, nota: `Se quitó ${cliente.ip} del corte en el router.` }
    } catch (err) {
      return { ok: false, nota: `No se pudo desbloquear en el router: ${err.message}` }
    }
  }

  /**
   * Registra la promesa y habilita el servicio hasta la fecha acordada.
   *
   * El servicio se reactiva de verdad —el abonado navega—, así que queda
   * marcado en la promesa: quien corta necesita saber a quién volver a cortar
   * si la fecha pasa sin pago. Sin esa marca, prometer sería una forma de
   * quedarse conectado gratis.
   */
  async function registrarPromesa() {
    const { data: sesion } = await supabase.auth.getUser()

    const { data: promesaNueva, error } = await supabase
      .from('promesas_pago')
      .insert({
        client_id: cliente.id,
        factura_id: form.document_id || null,
        monto: form.monto === '' ? null : Number(form.monto),
        fecha_promesa: form.fecha_limite,
        nota: form.notas.trim() || null,
        activo_servicio: true,
        created_by: sesion?.user?.id ?? null,
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        throw new Error(
          `${cliente.nombre} ya tiene una promesa activa. Cerrala en la pestaña de promesas antes de registrar otra.`,
        )
      }
      throw error
    }

    const pasos = []
    const r = await activarServicio()
    pasos.push(r)

    if (r.ok) {
      const { error: errEstado } = await supabase
        .from('clientes')
        .update({ estado: 'activo' })
        .eq('id', cliente.id)
      if (errEstado) {
        pasos.push({ ok: false, nota: `El servicio se habilitó pero el estado del cliente no se actualizó: ${errEstado.message}` })
      }
    }

    pasos.push({
      ok: true,
      nota: `Queda habilitado hasta el ${new Date(`${form.fecha_limite}T12:00:00`).toLocaleDateString()}. Si no paga, aparece en "Promesas" como vencida.`,
    })

    return { promesa: promesaNueva, pasos }
  }

  async function registrar(e) {
    e.preventDefault()

    const monto = Number(form.monto)

    if (esPromesa) {
      if (!form.fecha_limite) return onError?.(new Error('Elegí hasta cuándo se le habilita el servicio'))
      if (form.fecha_limite < hoy()) {
        return onError?.(new Error('La fecha límite no puede ser anterior a hoy'))
      }
    } else {
      if (!(monto > 0)) return onError?.(new Error('El monto tiene que ser mayor que cero'))

      /**
       * Sin permiso de cobro parcial, el monto es el de la factura.
       *
       * El campo es de solo lectura, pero eso no alcanza: `readOnly` se saca desde
       * la consola en dos segundos, y el valor podría venir de un estado viejo. La
       * comprobación acá es la que decide, y la de la base —el disparador de la
       * 160— es la que decide de verdad.
       */
      if (!puede('pagos.parcial')) {
        const factura = facturas.find((f) => f.id === form.document_id)
        const debido = Number(factura?.saldo ?? 0)

        if (factura && Math.abs(monto - debido) > 0.01) {
          return onError?.(
            new Error(
              `Se cobra el valor completo: esta factura debe ${dinero(debido)}. `
              + 'Si el abonado no trae todo, no se puede registrar acá.',
            ),
          )
        }
      }

      /**
       * La cuenta es obligatoria siempre, y el mensaje cambia según la forma.
       *
       * En un cobro electrónico es lo que después permite conciliar contra el
       * extracto: sin cuenta no se sabe en qué banco buscarlo, y con dos cuentas
       * del mismo banco la comparación da cruces que parecen buenos y no lo son.
       */
      if (!form.cuenta_id) {
        return onError?.(
          new Error(
            form.forma_pago === 'efectivo'
              ? 'Elegí a qué caja entró el efectivo'
              : 'Elegí a qué cuenta entró el pago: sin eso no se puede conciliar con el banco',
          ),
        )
      }

      /**
       * Y que sea una cuenta donde esa plata pueda estar de verdad.
       *
       * Un cobro en efectivo imputado a la cuenta del banco aparece después en la
       * conciliación como "sin respaldo" y manda a llamar a un abonado que pagó
       * en ventanilla.
       */
      if (!cuentasPara(cuentas, form.forma_pago).some((c) => c.id === form.cuenta_id)) {
        return onError?.(
          new Error(
            form.forma_pago === 'efectivo'
              ? 'El efectivo entra a caja, no a una cuenta del banco'
              : 'Esa cuenta no corresponde a esta forma de pago',
          ),
        )
      }
    }

    setGuardando(true)
    onError?.(null)

    if (esPromesa) {
      try {
        onRegistrado?.(await registrarPromesa())
      } catch (err) {
        onError?.(err)
      } finally {
        setGuardando(false)
      }
      return
    }

    try {
      const { data: sesion } = await supabase.auth.getUser()

      // Un cobro puede saldar varias facturas: el mes atrasado, el corriente y
      // los materiales que se llevó. La base lo reparte de la más vieja a la más
      // nueva —empezando por la que está en pantalla— y devuelve el detalle.
      // Repartirlo acá obligaría a varios viajes y dejaría el cobro a medias si
      // uno fallara.
      const { data: resultado, error } = await supabase.rpc('aplicar_cobro', {
        p_client_id: cliente.id,
        p_monto: monto,
        p_forma_pago: form.forma_pago,
        p_cuenta_id: form.cuenta_id,
        p_n_transaccion: form.n_transaccion.trim() || null,
        p_fecha_pago: form.fecha_pago,
        p_notas: form.notas.trim() || null,
        p_comision: Number(form.comision) || 0,
        p_factura_id: form.document_id || null,
        p_facturar: Boolean(form.facturar),
        p_activo_servicio: form.tipo === 'activar',
        p_created_by: sesion?.user?.id ?? null,
      })

      if (error) throw error

      // El recibo se imprime desde el cobro principal: es el que lleva el número
      // y el que suma lo que el abonado entregó.
      const { data: pago } = await supabase
        .from('v_pagos')
        .select('*')
        .eq('id', resultado.pago_id)
        .maybeSingle()

      const pasos = []

      const saldadas = resultado.facturas ?? []
      if (saldadas.length > 1) {
        pasos.push({
          ok: true,
          nota: `Se repartió entre ${saldadas.length} facturas: ${saldadas
            .map((f) => `N° ${f.numero} ${dinero(f.monto)}`)
            .join(', ')}.`,
        })
      }

      if (Number(resultado.excedente) > 0.005) {
        pasos.push({
          ok: true,
          nota: saldadas.length
            ? `Quedan ${dinero(resultado.excedente)} a favor del cliente: se aplican solos a la próxima factura.`
            : `No tenía facturas pendientes: los ${dinero(resultado.excedente)} quedan a favor.`,
        })
      }

      // La promesa la cierra la base, no esta pantalla: cumplida si saldó lo
      // que prometió, incumplida si trajo una parte. Se vuelve a leer solo
      // para poder contarlo en el resultado.
      if (promesa) {
        const { data: cerrada } = await supabase
          .from('promesas_pago')
          .select('estado')
          .eq('id', promesa.id)
          .maybeSingle()

        pasos.push({
          ok: cerrada?.estado === 'cumplida',
          nota:
            cerrada?.estado === 'cumplida'
              ? 'Promesa cumplida: no le queda deuda de lo que prometió pagar.'
              : 'Promesa incumplida: pagó menos de lo prometido. Podés anotarle un plazo nuevo.',
        })
      }

      // Lo que quedó debiendo, prometido para una fecha.
      //
      // Va después de que la base cerró la anterior: como pagar de menos la
      // deja incumplida, el lugar queda libre para anotar el plazo nuevo que el
      // abonado acaba de pedir.
      if (esCobroParcial && form.promesa_saldo) {
        const { error: errNueva } = await supabase.from('promesas_pago').insert({
          client_id: cliente.id,
          factura_id: form.document_id || null,
          monto: saldoRestante,
          fecha_promesa: form.fecha_saldo,
          nota: `Saldo de ${dinero(saldoRestante)} tras el pago de ${dinero(monto)}.`,
          activo_servicio: form.tipo === 'activar',
          created_by: sesion?.user?.id ?? null,
        })

        pasos.push({
          ok: !errNueva,
          nota: errNueva
            ? errNueva.code === '23505'
              ? 'El cobro se registró. La promesa por el saldo no se creó porque el cliente ya tiene una activa: revisala en Promesas.'
              : `El cobro se registró pero la promesa por el saldo no: ${errNueva.message}`
            : `Quedan ${dinero(saldoRestante)} prometidos para el ${new Date(`${form.fecha_saldo}T12:00:00`).toLocaleDateString()}.`,
        })
      } else if (esCobroParcial) {
        // Aunque no se prometa nada, el saldo tiene que quedar dicho: es la
        // diferencia entre "ya está" y "todavía debe".
        pasos.push({
          ok: true,
          nota: `Le quedan ${dinero(saldoRestante)} pendientes.`,
        })
      }

      // El día de pago pactado vive en la ficha del cliente, no en el cobro.
      const dia = form.dia_pago === '' ? null : Number(form.dia_pago)
      if (dia !== (cliente.dia_facturacion ?? null)) {
        await supabase.from('clientes').update({ dia_facturacion: dia }).eq('id', cliente.id)
      }

      if (form.tipo === 'activar') {
        const r = await activarServicio()
        pasos.push(r)
        if (r.ok) {
          const { error: errEstado } = await supabase
            .from('clientes')
            .update({ estado: 'activo' })
            .eq('id', cliente.id)
          if (errEstado) pasos.push({ ok: false, nota: `El servicio se activó en el router pero el estado del cliente no se actualizó: ${errEstado.message}` })
        }
      }

      /**
       * El recibo sale solo, para entregárselo al cliente.
       *
       * Solo para quien tiene `pagos.recibo_automatico` —el punto de recaudación—:
       * en la ventanilla de la oficina no siempre se imprime, y abrir una pestaña
       * con un PDF en cada cobro sería molesto para quien cobra cincuenta.
       *
       * Va antes de avisar que terminó y sin `await` a propósito: que la
       * impresora falle no puede dejar el cobro pareciendo incompleto. El cobro
       * ya está registrado.
       *
       * `imprimirPdf` y no `abrirPdf`: abrir una pestaña después de un `await` lo
       * bloquea el navegador en silencio, y desde afuera se ve como que el
       * sistema no hizo nada. Con un marco escondido cae directo en el diálogo de
       * impresión, que es lo que hace falta con el cliente esperando el papel.
       */
      if (puede('pagos.recibo_automatico') && pago?.id) {
        /**
         * Qué papel sale lo decide el servidor, no esta pantalla.
         *
         * Cuando el cobro saldó una factura se imprime la FACTURA SALDADA —la
         * misma hoja que va por correo, con la banda verde que dice PAGADO—; si no
         * hay factura, el recibo. La primera versión elegía acá, y los botones de
         * imprimir de las listas seguían sacando el recibo viejo: el mismo cobro
         * salía en dos papeles distintos según por dónde se lo pidiera.
         */
        imprimirPdf(() => api.pagos.comprobante(pago.id)).catch(() => {
          onError?.(
            new Error(
              'El cobro se registró, pero no se pudo abrir el comprobante. '
              + 'Imprimilo desde el listado de pagos.',
            ),
          )
        })
      }

      onRegistrado?.({ pago, pasos })
    } catch (err) {
      // 23505 = el número de transacción ya está registrado en otro cobro.
      onError?.(
        err?.code === '23505' ? await errorTransaccionRepetida(form.n_transaccion.trim()) : err,
      )
    } finally {
      setGuardando(false)
    }
  }

  if (cargando) return <p className="p-4 text-sm text-slate-500">Cargando la cuenta del cliente…</p>

  return (
    <form onSubmit={registrar} className="space-y-4">
      {facturas.length > 0 ? (
        <Aviso tipo="alerta">
          El cliente tiene <b>{facturas.length}</b>{' '}
          {facturas.length === 1 ? 'factura por cobrar' : 'facturas por cobrar'} (total{' '}
          <b>{dinero(totalPendiente)}</b>).
        </Aviso>
      ) : (
        <Aviso>
          El cliente no tiene facturas pendientes. Lo que registres queda como abono a cuenta.
        </Aviso>
      )}

      {promesa && (
        <Aviso tipo="alerta">
          <AlertTriangle size={14} className="mr-1 inline" />
          Tiene una promesa de pago para el{' '}
          <b>{new Date(`${promesa.fecha_promesa}T12:00:00`).toLocaleDateString()}</b>
          {promesa.monto ? ` por ${dinero(promesa.monto)}` : ''}. Al registrar el cobro se cierra.
        </Aviso>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          <Field label="Comprobante a pagar" hint="Vacío = abono a cuenta, sin factura asociada">
            <Select value={form.document_id} onChange={elegirComprobante}>
              <option value="">— sin comprobante —</option>
              {facturas.map((f) => (
                <option key={f.id} value={f.id}>
                  N° {f.numero} — {dinero(f.saldo)} pendiente de {dinero(f.importe_total)} (
                  {f.fecha_emision}){f.tipo !== 'servicios' ? ` · ${f.tipo}` : ''}
                </option>
              ))}
            </Select>
          </Field>

          {/* El cobro se reparte solo entre los meses de servicio. Lo demás
              existe y hay que verlo, pero se cobra eligiéndolo: si no, el pago
              del mes se lo come una factura vieja de materiales y el abonado
              queda cortado habiendo pagado. */}
          {!esPromesa && otrosConceptos.length > 0 && (
            <div className="rounded-lg border border-sky-500/40 bg-sky-500/10 p-3 text-sm text-sky-100">
              Además debe{' '}
              <b>{dinero(otrosConceptos.reduce((t, f) => t + Number(f.saldo), 0))}</b> por otros
              conceptos:{' '}
              {otrosConceptos.map((f) => `N° ${f.numero} ${f.concepto} (${dinero(f.saldo)})`).join(', ')}.
              Este cobro no los toca — para cobrarlos, elegilos arriba.
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {/* En una promesa no entró plata: pedir comisión, cuenta o número
                de transacción solo invita a llenar datos inventados. */}
            {!esPromesa && (
              <>
                <Field label="Comisión $" hint="Lo que retiene el intermediario">
                  <Input
                    type="number"
                    step="0.01"
                    min={0}
                    value={form.comision}
                    onChange={set('comision')}
                  />
                </Field>
                {/**
                 * ── Obligatorio en lo electrónico, opcional en el efectivo ──
                 *
                 * Sin número, una transferencia NO se puede conciliar: la
                 * comparación contra el extracto del banco cruza justamente por
                 * ahí, y un cobro sin él aparece como "sin respaldo" aunque la
                 * plata haya entrado.
                 *
                 * En efectivo no hay nada contra qué cruzar. El número es el de la
                 * recibera que se le entrega al punto de recaudación para cuando
                 * no tiene impresora o se le dañó — un respaldo en papel, no un
                 * requisito. Exigirlo obligaría a inventar uno, y un número
                 * inventado es peor que ninguno.
                 */}
                <Field
                  label={
                    form.forma_pago === 'efectivo'
                      ? 'N° de recibera (opcional)'
                      : 'N° de transacción'
                  }
                  hint={
                    repetida
                      ? `Ya registrado: recibo N° ${String(repetida.numero).padStart(6, '0')} de ${repetida.cliente} por ${dinero(repetida.monto)}.`
                      : (ORIGEN_NUMERO[form.forma_pago] ?? 'No se puede repetir')
                  }
                >
                  <Input
                    value={form.n_transaccion}
                    onChange={set('n_transaccion')}
                    onBlur={verificarTransaccion}
                    required={form.forma_pago !== 'efectivo'}
                    className={repetida ? 'border-red-500' : ''}
                  />
                </Field>

                <Field label="Forma de pago">
                  {/**
                   * El punto de recaudación cobra SOLO en efectivo.
                   *
                   * La plata se la entregan en la mano. Dejarle elegir
                   * "transferencia" abre la puerta a registrar un cobro que nunca
                   * entró —y que después aparece en la conciliación como un
                   * comprobante sin respaldo, mandando a llamar a un abonado que
                   * sí pagó—.
                   *
                   * Con una sola opción se muestra el texto, no un desplegable de
                   * un ítem: un selector que no se puede cambiar invita a
                   * buscarle la vuelta.
                   */}
                  {formasPosibles.length === 1 ? (
                    <div className="flex h-9 items-center rounded-lg border border-slate-700 bg-slate-800/60 px-3 text-sm text-slate-300">
                      {formasPosibles[0].label}
                    </div>
                  ) : (
                    <Select value={form.forma_pago} onChange={set('forma_pago')}>
                      {formasPosibles.map((f) => (
                        <option key={f.valor} value={f.valor}>
                          {f.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field
                  label={form.forma_pago === 'efectivo' ? 'Caja' : 'Cuenta de destino'}
                  hint={
                    form.forma_pago === 'efectivo'
                      ? 'El efectivo entra a caja, no a una cuenta del banco'
                      : 'A dónde entró la plata. Es lo que después permite conciliar con el banco.'
                  }
                >
                  <Select value={form.cuenta_id} onChange={set('cuenta_id')} required>
                    <option value="">— elegí una cuenta —</option>
                    {cuentasPara(cuentas, form.forma_pago).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nombre}
                        {c.numero ? ` — ${c.numero}` : ''}
                        {/* "tu caja" y no el nombre del dueño: quien cobra sabe
                            cuál es la suya, y el resto no le sirve de nada. */}
                        {c.propia && c.tipo === 'efectivo' ? ' (tu caja)' : ''}
                      </option>
                    ))}
                  </Select>
                  {/* Sin cuenta del tipo que corresponde no se puede cobrar así:
                      decirlo acá evita que alguien elija la cuenta equivocada
                      solo porque es la única que le aparece. */}
                  {!cuentasPara(cuentas, form.forma_pago).length && (
                    <p className="mt-1 text-xs text-amber-400">
                      {form.forma_pago === 'efectivo'
                        ? 'No tenés una caja asignada. Pedila en Ajustes → Cuentas de pago: sin caja propia no se puede cobrar en efectivo.'
                        : 'No hay ninguna cuenta de este tipo cargada. Creala en Ajustes → Cuentas de pago.'}
                    </p>
                  )}
                </Field>
              </>
            )}

            <Field label="Tipo de pago">
              <Select value={form.tipo} onChange={set('tipo')}>
                <option value="registrar">Registrar pago</option>
                <option value="activar">Registrar pago y activar servicio</option>
                <option value="promesa">Promesa de pago (habilitar sin cobrar)</option>
              </Select>
            </Field>

            {esPromesa && (
              <Field
                label="Fecha límite de pago"
                className="sm:col-span-2"
                hint={
                  form.fecha_limite === fechaSugerida(diaMaximo)
                    ? `Sugerida: ${DIAS_DE_GRACIA} días más allá del ${diaMaximo} de cada mes, que es la fecha máxima de pago. Tocá el campo para elegir otra.`
                    : diasFaltantes > 30
                      ? `Son ${diasFaltantes} días de plazo: es mucho para una promesa.`
                      : `El servicio queda habilitado ${diasFaltantes <= 0 ? 'solo por hoy' : `${diasFaltantes} día(s) más`}.`
                }
              >
                {/* type="date" ya trae el calendario del navegador, pero en
                    Chrome solo se abre desde el iconito. showPicker() lo abre
                    tocando cualquier parte del campo, que es lo que espera
                    quien está atendiendo con el cliente enfrente. */}
                <Input
                  type="date"
                  value={form.fecha_limite}
                  onChange={set('fecha_limite')}
                  onClick={(e) => {
                    try {
                      e.currentTarget.showPicker?.()
                    } catch {
                      // Navegador sin soporte: queda el calendario del iconito.
                    }
                  }}
                  min={hoy()}
                  max={enDias(90)}
                  required
                  className="cursor-pointer"
                />
              </Field>
            )}
            <Field label="Día de pago" hint="Día del mes en que se le factura">
              <Select value={form.dia_pago ?? ''} onChange={set('dia_pago')}>
                <option value="">— sin definir —</option>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {String(d).padStart(2, '0')} de cada mes
                  </option>
                ))}
              </Select>
            </Field>

            {!esPromesa && (
              <Field label="Fecha del pago">
                <Input type="date" value={form.fecha_pago} onChange={set('fecha_pago')} max={hoy()} />
              </Field>
            )}
          </div>

          {/* Un cobro contra una factura ya emitida no genera otra. Solo los
              cobros sin comprobante entran a la cola del cierre. */}
          {!esPromesa && !form.document_id && (
            <div className="t-panel p-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={Boolean(form.facturar)}
                  onChange={(e) => setForm((f) => ({ ...f, facturar: e.target.checked }))}
                  className="accent-sky-500"
                />
                Emitirle factura electrónica por este cobro
              </label>
              <p className="mt-1 text-[11px] text-slate-500">
                {form.facturar
                  ? 'Queda en Facturación → Por facturar. Se revisa y se envía al SRI al cierre de la jornada.'
                  : 'Solo se le entrega el recibo del cobro.'}
                {cliente.factura_electronica === false && form.facturar && (
                  <span className="text-amber-400">
                    {' '}
                    La ficha de este cliente dice que no se le factura.
                  </span>
                )}
              </p>
            </div>
          )}

          {hayExcedente && (
            <div className="rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 p-3 text-sm text-fuchsia-100">
              Paga <b>{dinero(excedente)}</b> de más sobre los {dinero(totalPendiente)} que
              debe. Esa diferencia queda <b>a favor del cliente</b> y se aplica sola a la
              próxima factura.
            </div>
          )}

          {esCobroParcial && (
            <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="text-sm text-amber-100">
                Cobro parcial: de {dinero(totalPendiente)} que debe quedan{' '}
                <b>{dinero(saldoRestante)}</b> pendientes.
              </p>

              {/* Al SRI se le emite una sola factura por el mes, el día que
                  termina de pagarlo. Emitir por cada abono le daría dos
                  comprobantes del mismo mes. */}
              {cliente.factura_electronica !== false && (
                <p className="text-xs text-amber-200/80">
                  No entra a la cola del SRI todavía: el comprobante se emite por el mes
                  completo cuando termine de cancelarlo.
                </p>
              )}

              <label className="flex cursor-pointer items-center gap-2 text-sm text-amber-100">
                <input
                  type="checkbox"
                  checked={form.promesa_saldo}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, promesa_saldo: e.target.checked }))
                  }
                  className="accent-amber-500"
                />
                Registrar promesa de pago por el saldo
              </label>

              {form.promesa_saldo && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Se compromete a pagar el" hint="Tocá el campo para abrir el calendario">
                    <Input
                      type="date"
                      value={form.fecha_saldo}
                      onChange={set('fecha_saldo')}
                      onClick={(e) => {
                        try {
                          e.currentTarget.showPicker?.()
                        } catch {
                          // Navegador sin soporte: queda el calendario del iconito.
                        }
                      }}
                      min={hoy()}
                      max={enDias(90)}
                      className="cursor-pointer"
                      required
                    />
                  </Field>
                  <Field label="Monto de la promesa" hint="Es el saldo de la factura">
                    <div className="t-panel px-3 py-2 text-sm text-slate-300">
                      {dinero(saldoRestante)}
                    </div>
                  </Field>
                </div>
              )}
            </div>
          )}

          <Field
            label={esPromesa ? 'MONTO PROMETIDO' : 'TOTAL A PAGAR'}
            hint={
              esPromesa
                ? 'Opcional: cuánto se comprometió a pagar.'
                : esCobroParcial
                  ? `Cobro parcial: quedarían ${dinero(saldoRestante)} pendientes.`
                  : hayExcedente
                    ? `${dinero(excedente)} quedan a favor del cliente.`
                    : 'Editable: se puede cobrar de más (queda a favor) o de menos (queda pendiente).'
            }
          >
            <div className="flex items-center gap-2">
              <span className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-400">
                $
              </span>
              <Input
                type="number"
                step="0.01"
                min={0.01}
                value={form.monto}
                onChange={set('monto')}
                required={!esPromesa}
                /**
                 * ── Quién no puede cambiar el monto ──
                 *
                 * El punto de recaudación cobra el valor completo. Es la regla que
                 * más tienta a saltarse —el abonado dice "solo tengo veinte" y el
                 * del local lo carga igual con tal de no perder la venta— y deja
                 * una factura a medio pagar que el abonado cree cancelada, más un
                 * corte que llega igual.
                 *
                 * El permiso existía desde siempre y no lo aplicaba nadie.
                 */
                readOnly={!puede('pagos.parcial') && !esPromesa}
                className={`text-lg font-semibold ${esPromesa ? 'text-amber-300' : 'text-emerald-300'} ${
                  !puede('pagos.parcial') && !esPromesa ? 'cursor-not-allowed opacity-70' : ''
                }`}
              />
            </div>
            {!puede('pagos.parcial') && !esPromesa && (
              <p className="mt-1 text-xs text-slate-500">
                Se cobra el valor completo de la factura.
              </p>
            )}
          </Field>
        </div>

        <div className="space-y-4 lg:border-l lg:border-slate-800 lg:pl-6">
          <Field label="Notas">
            <Textarea
              rows={5}
              value={form.notas}
              onChange={set('notas')}
              placeholder="Comentario del pago"
            />
          </Field>

          {esPromesa ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              No se registra ningún cobro. El servicio se habilita ahora y hasta el{' '}
              <b>
                {form.fecha_limite
                  ? new Date(`${form.fecha_limite}T12:00:00`).toLocaleDateString()
                  : '—'}
              </b>
              . Si llega esa fecha sin pago, el cliente aparece en <b>Promesas</b> como vencido para
              volver a cortarlo.
            </div>
          ) : (
            <div className="t-card-sm p-3 text-xs text-slate-400">
              <div className="flex justify-between py-0.5">
                <span>Cobrado al cliente</span>
                <b className="text-slate-200">{dinero(form.monto)}</b>
              </div>
              <div className="flex justify-between py-0.5">
                <span>Comisión</span>
                <span>− {dinero(form.comision)}</span>
              </div>
              <div className="mt-1 flex justify-between border-t border-slate-800 pt-1.5">
                <span>Entra a la cuenta</span>
                <b className="text-emerald-300">
                  {dinero(Number(form.monto || 0) - Number(form.comision || 0))}
                </b>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variante="fantasma" onClick={onCancelar}>
              Cancelar
            </Button>
            <Button type="submit" variante="primario" icon={Check} cargando={guardando}>
              {esPromesa ? 'Registrar promesa y habilitar' : 'Registrar pago'}
            </Button>
          </div>
        </div>
      </div>
    </form>
  )
}

export { FORMAS_PAGO, dinero }
