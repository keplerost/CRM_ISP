/**
 * Generación mensual de facturas.
 *
 * Cada abonado activo recibe una factura por su mes de servicio. Antes eso se
 * hacía a mano, cliente por cliente, y el que se olvidaban quedaba sin cobrar.
 *
 * Tres cosas hacen que esto sea seguro de dejar corriendo solo:
 *
 * 1. La decisión de a quién facturar es una función pura, separada del insert.
 *    Se puede ver la lista sin escribir nada y se puede probar sin base.
 * 2. La base impide duplicar: hay un índice único por (cliente, período), así
 *    que correrlo dos veces el mismo día no cobra dos veces.
 * 3. No emite nada ante el SRI. Esto crea la factura del sistema; el
 *    comprobante fiscal se emite después, revisado, desde "Por facturar".
 */

import { db } from '../lib/db.js'
import { avisarFacturaNueva } from './avisoFactura.js'
import { config } from '../config.js'

/** Fecha local en YYYY-MM-DD. `toISOString` daría la del huso UTC. */
export function fechaLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Período que cubre la factura que se emite hoy.
 *
 * En prepago se cobra el mes que viene —el abonado paga por adelantado—; en
 * postpago, el que acaba de terminar. Confundirlos hace que la factura diga que
 * cubre un mes que el cliente ya usó y pagó.
 */
export function periodoDe(modalidad, hoy = new Date()) {
  const desplazamiento = modalidad === 'postpago' ? -1 : 0
  const desde = new Date(hoy.getFullYear(), hoy.getMonth() + desplazamiento, 1, 12)
  const hasta = new Date(hoy.getFullYear(), hoy.getMonth() + desplazamiento + 1, 0, 12)
  return { desde: fechaLocal(desde), hasta: fechaLocal(hasta) }
}

/**
 * Reparte un importe entre base e impuesto.
 *
 *   incluido → el precio ya trae el IVA y se desglosa hacia atrás
 *   mas      → se le suma
 *   ninguno  → exento
 */
export function repartirImpuesto(
  importe,
  tipo = 'incluido',
  tarifa = 15,
  { descuentoPct = 0, descuentoFijo = 0 } = {},
) {
  const n = Number(importe) || 0
  const r2 = (x) => Math.round(x * 100) / 100
  const pct = Math.min(Math.max(Number(descuentoPct) || 0, 0), 100)
  const fijo = Math.max(Number(descuentoFijo) || 0, 0)

  // `subtotal` es la base COMPLETA y el descuento se resta aparte: así el papel
  // cierra —subtotal − descuento + impuesto = total— y el abonado con derecho
  // puede ver que se lo aplicaron, en vez de un importe rebajado sin explicar.
  const base = tipo === 'incluido' ? r2(n / (1 + tarifa / 100)) : r2(n)
  const factor = tipo === 'ninguno' ? 1 : 1 + tarifa / 100

  /**
   * El descuento por porcentaje se aplica sobre la base; el fijo, sobre el
   * total.
   *
   * ── Por qué el fijo se calcula hacia atrás ──
   *
   * Porque es lo que la persona acordó con el abonado: «que le quede en 23».
   * Nadie negocia sobre la base imponible.
   *
   * Restarlo directamente de la base da un centavo de menos. Con IVA del 15%
   * sobre 23.10:
   *
   *   base 20.09 · restar 0.10 a la base → 19.99 × 1.15 = 22.99   ✗
   *   base 20.09 · objetivo 23.00 → gravado 20.00 → total 23.00   ✓
   *
   * Así que se calcula el total al que hay que llegar y se deduce qué parte de
   * la base hay que sacar para aterrizar ahí.
   */
  const porPct = r2(base * (pct / 100))
  const totalTrasPct = r2((base - porPct) * factor)
  const objetivo = Math.max(0, r2(totalTrasPct - fijo))
  const gravado = r2(objetivo / factor)

  // El descuento del papel es todo lo que se le sacó a la base, venga de donde
  // venga: una sola línea que el abonado entiende y que hace cerrar la resta.
  const descuento = r2(base - gravado)
  const impuesto = tipo === 'ninguno' ? 0 : r2(gravado * (tarifa / 100))

  return { subtotal: base, descuento, impuesto, total: r2(gravado + impuesto) }
}

/** Cómo se llama cada descuento de ley en el papel. */
const MOTIVO_LEY = {
  tercera_edad: 'Descuento tercera edad',
  discapacidad: 'Descuento por discapacidad',
}

/**
 * El descuento que le corresponde a este abonado en esta fecha.
 *
 * El de ley —tercera edad, discapacidad— no vence y manda sobre cualquier otro:
 * darle además la promoción comercial sería regalar dos veces lo mismo, y
 * quitárselo para darle la promoción sería ilegal.
 *
 * La promoción se mide contra la fecha del período que se factura, no contra
 * hoy: así una promoción de 3 meses cubre exactamente 3 facturas, sin depender
 * de qué día se corra la generación.
 */
export function descuentoDe(cliente = {}, fecha = new Date()) {
  const tipo = cliente.descuento_tipo
  if (tipo === 'tercera_edad' || tipo === 'discapacidad') {
    // 50% es lo que manda la norma; el campo existe porque puede escalonarse.
    const pct = Number(cliente.descuento_porcentaje ?? 50)
    if (pct > 0) {
      return { porcentaje: pct, fijo: 0, motivo: `${MOTIVO_LEY[tipo]} ${pct}%`, ley: true }
    }
  }

  /**
   * El acuerdo en plata, antes que la promoción.
   *
   * ── Por qué los tres se excluyen entre sí ──
   *
   * El de ley manda sobre todo: es un derecho, y quitárselo para darle otra
   * cosa sería ilegal. Sumárselo tampoco: sería regalar dos veces.
   *
   * Entre el acuerdo fijo y la promoción gana el fijo, por dos razones. Es más
   * específico —se negoció con ESE abonado— y no vence, mientras que la
   * promoción se apaga sola a los N meses. Si se aplicaran los dos, el día que
   * la promoción venciera la factura subiría sin que nadie hubiera tocado
   * nada, y eso es exactamente la llamada que este acuerdo vino a evitar.
   */
  const fijo = Number(cliente.descuento_fijo ?? 0)
  if (fijo > 0) {
    return {
      porcentaje: 0,
      fijo,
      motivo: cliente.descuento_fijo_motivo?.trim() || 'Descuento acordado',
      ley: false,
    }
  }

  const pct = Number(cliente.promo_porcentaje ?? 0)
  const meses = Number(cliente.promo_meses ?? 0)
  if (!(pct > 0) || !(meses > 0) || !cliente.promo_desde) {
    return { porcentaje: 0, fijo: 0, motivo: null, ley: false }
  }

  const desde = new Date(`${String(cliente.promo_desde).slice(0, 10)}T12:00:00`)
  const hasta = new Date(desde)
  hasta.setMonth(hasta.getMonth() + meses)

  // Vencida: se factura el precio de lista sin que nadie tenga que acordarse.
  if (fecha >= hasta) return { porcentaje: 0, fijo: 0, motivo: null, ley: false, promoVencida: true }

  return {
    porcentaje: pct,
    fijo: 0,
    motivo: `Promoción ${pct}% por ${meses} ${meses === 1 ? 'mes' : 'meses'}`,
    ley: false,
    hasta: fechaLocal(hasta),
  }
}

/** El día del mes en que le toca factura a este abonado. */
const diaDeGeneracion = (cliente) =>
  cliente.dia_generar_factura ?? cliente.dia_facturacion ?? null

/**
 * Decide a quién le corresponde factura hoy.
 *
 * @param clientes  filas de `clientes` con su plan
 * @param hoy       fecha de corrida
 * @returns {{ facturar: object[], omitidos: object[] }}
 */
export function decidirFacturacion(clientes = [], hoy = new Date(), { tarifa = 15 } = {}) {
  const facturar = []
  const omitidos = []
  const diaDeHoy = hoy.getDate()

  for (const c of clientes) {
    /*
      El cortado SÍ se factura: dejó de pagar, no dejó de ser abonado, y su
      deuda sigue corriendo. El suspendido NO: pidió parar el servicio —se va de
      viaje, hay una obra— y cobrarle el mes que no usó es exactamente lo que
      vino a evitar. Al volver se lo reactiva y vuelve a facturar.

      El de baja tampoco, por razones obvias.
    */
    if (c.estado === 'suspendido') {
      omitidos.push({
        ...c,
        motivo: c.suspendido_motivo
          ? `Pausado: ${c.suspendido_motivo}`
          : 'Pausado a pedido del abonado',
      })
      continue
    }

    if (!['activo', 'cortado'].includes(c.estado)) {
      omitidos.push({ ...c, motivo: `Está de ${c.estado}` })
      continue
    }

    const dia = diaDeGeneracion(c)
    if (dia == null) {
      omitidos.push({ ...c, motivo: 'No tiene día de facturación configurado' })
      continue
    }
    if (dia !== diaDeHoy) continue

    const precio = Number(c.precio_mensual ?? c.plan_precio ?? 0)
    if (!(precio > 0)) {
      omitidos.push({ ...c, motivo: 'No tiene precio mensual ni plan con precio' })
      continue
    }

    const periodo = periodoDe(c.modalidad_pago, hoy)

    // Se evalúa contra el inicio del período facturado: la promoción cubre los
    // meses que se pactaron, no los que hayan pasado desde que se cargó.
    const descuento = descuentoDe(c, new Date(`${periodo.desde}T12:00:00`))

    // El impuesto sale del plan y la ficha del abonado puede desviarse.
    //
    // El plan es de dónde viene la venta: si se vende "con IVA incluido", eso
    // vale para todos los que lo tienen sin que nadie tenga que acordarse de
    // ponérselo uno por uno. La ficha manda cuando dice algo, porque hay
    // abonados exentos y no por eso se les cambia el plan.
    const impuesto = c.tipo_impuesto ?? c.plan_tipo_impuesto ?? 'incluido'
    const tarifaAplicada = Number(c.plan_iva_porcentaje ?? tarifa) || tarifa

    const montos = repartirImpuesto(precio, impuesto, tarifaAplicada, {
      descuentoPct: descuento.porcentaje,
      descuentoFijo: descuento.fijo,
    })

    // El vencimiento es su día de pago dentro del mes de emisión.
    const diaPago = c.dia_facturacion ?? dia
    const vence = new Date(hoy.getFullYear(), hoy.getMonth(), diaPago, 12)

    facturar.push({
      cliente: c,
      periodo,
      vencimiento: fechaLocal(vence),
      ...montos,
      descuento_motivo: descuento.motivo,
      concepto: c.descripcion_servicio || c.plan || 'Servicio de internet',
    })
  }

  return { facturar, omitidos }
}

/**
 * Crea las facturas del día.
 *
 * @param simular  true = devuelve la lista sin escribir nada
 */
export async function generarFacturas({ simular = false, fecha = null } = {}) {
  const hoy = fecha ? new Date(`${fecha}T12:00:00`) : new Date()

  const { data: clientes, error } = await db()
    .from('v_clientes_ficha')
    .select(
      'id, nombre, estado, precio_mensual, plan, plan_precio, descripcion_servicio, ' +
        'dia_facturacion, dia_generar_factura, modalidad_pago, tipo_impuesto, suspendido_motivo, ' +
        // Del plan: el impuesto por defecto y su tarifa, para los abonados que
        // no lo tienen puesto en la ficha.
        'plan_tipo_impuesto, plan_iva_porcentaje, ' +
        'descuento_tipo, descuento_porcentaje, promo_porcentaje, promo_meses, promo_desde',
    )
  if (error) throw new Error(`No se pudieron leer los clientes: ${error.message}`)

  /**
   * El descuento acordado se lee de `clientes`, no de la vista.
   *
   * `v_clientes_ficha` está definida con `c.*`, y Postgres expande eso EN EL
   * MOMENTO DE CREARLA: una columna agregada después no aparece hasta que
   * alguien rehaga la vista. Hoy le faltan varias.
   *
   * Rehacerla obligaría a rehacer también lo que cuelga de ella
   * —`v_cobros_por_gestionar`— y eso es mucho riesgo para dos columnas. Se leen
   * aparte y se pegan por id: dos consultas en vez de una, una vez al mes.
   */
  const { data: acuerdos, error: errAcuerdo } = await db()
    .from('clientes')
    .select('id, descuento_fijo, descuento_fijo_motivo')
    .not('descuento_fijo', 'is', null)
    .gt('descuento_fijo', 0)

  if (errAcuerdo) {
    throw new Error(`No se pudieron leer los descuentos acordados: ${errAcuerdo.message}`)
  }

  const porCliente = new Map(acuerdos.map((a) => [a.id, a]))
  for (const c of clientes) {
    const a = porCliente.get(c.id)
    if (a) {
      c.descuento_fijo = a.descuento_fijo
      c.descuento_fijo_motivo = a.descuento_fijo_motivo
    }
  }

  const { facturar, omitidos } = decidirFacturacion(clientes ?? [], hoy)

  if (simular) {
    return { simulado: true, fecha: fechaLocal(hoy), pendientes: facturar, omitidos, creadas: [] }
  }

  const creadas = []
  const fallidas = []
  let avisados = 0

  for (const f of facturar) {
    const { data: nueva, error: errIns } = await db()
      .from('facturas')
      .insert({
        client_id: f.cliente.id,
        cliente_nombre: f.cliente.nombre,
        tipo: 'servicios',
        concepto: f.concepto,
        periodo_desde: f.periodo.desde,
        periodo_hasta: f.periodo.hasta,
        fecha_emision: fechaLocal(hoy),
        fecha_vencimiento: f.vencimiento,
        subtotal: f.subtotal,
        descuento: f.descuento,
        descuento_motivo: f.descuento_motivo,
        impuesto: f.impuesto,
        total: f.total,
      })
      .select()
      .single()

    if (errIns) {
      // 23505 = ya existe la factura de ese período. No es un error: es la
      // protección contra correr la generación dos veces.
      if (errIns.code === '23505') {
        omitidos.push({ ...f.cliente, motivo: 'Ya tenía la factura de este período' })
      } else {
        fallidas.push({ cliente: f.cliente.nombre, error: errIns.message })
      }
      continue
    }

    // Lo que el abonado había pagado de más se imputa a esta factura. Sin
    // esto, el mes siguiente se le cobra completo y alguien tiene que
    // acordarse a mano de descontarle lo que ya entregó.
    let aplicado = 0
    const { data: saldoAplicado, error: errSaldo } = await db().rpc('aplicar_saldo_a_favor', {
      p_factura_id: nueva.id,
    })

    if (errSaldo) {
      // La factura ya existe: que falle la imputación no la invalida, pero
      // tiene que verse para poder aplicarla a mano.
      fallidas.push({
        cliente: f.cliente.nombre,
        error: `Factura creada, pero no se aplicó su saldo a favor: ${errSaldo.message}`,
      })
    } else {
      aplicado = Number(saldoAplicado) || 0
    }

    /**
     * Y se le avisa que tiene factura nueva.
     *
     * A todos: es la factura interna del negocio. Que el abonado pida
     * comprobante del SRI no tiene nada que ver — eso se emite después, solo al
     * cobrar y solo a quien lo pidió.
     *
     * `avisarFacturaNueva` no lanza nunca. La factura ya existe y es lo que
     * importa: que un mensaje no salga no puede hacer fallar la facturación de
     * los abonados que siguen en la lista.
     */
    const aviso = await avisarFacturaNueva(nueva, f.cliente)
    if (aviso.enviado) avisados++

    creadas.push({
      cliente: f.cliente.nombre,
      total: f.total,
      periodo: f.periodo,
      /**
       * Lo que pasó con el aviso, dicho sin adornos.
       *
       * Tres desenlaces distintos y hay que poder distinguirlos: llegó, quedó
       * escrito para mandar a mano, o no salió. Antes los dos primeros se
       * informaban igual —"whatsapp"— y una corrida con WhatsApp sin proveedor
       * parecía perfecta con cero mensajes entregados.
       */
      aviso: aviso.enviado
        ? aviso.canal + (aviso.pendientes?.length ? ` (+${aviso.pendientes.join(', ')} pendiente)` : '')
        : aviso.motivo,
      ...(aplicado > 0 ? { saldoAplicado: aplicado } : {}),
    })
  }

  return { simulado: false, fecha: fechaLocal(hoy), creadas, fallidas, omitidos, avisados }
}

// --- Programador ------------------------------------------------------------

export const estadoFacturacion = {
  automatica: false,
  hora: null,
  ultimaCorrida: null,
  ultimoResultado: null,
}

function llegoLaHora(ahora, hora) {
  const [h, m] = String(hora).split(':').map(Number)
  if (Number.isNaN(h)) return false
  return ahora.getHours() > h || (ahora.getHours() === h && ahora.getMinutes() >= (m || 0))
}

/**
 * Arranca la generación diaria.
 *
 * Corre todos los días —no una vez al mes— porque cada abonado tiene su propio
 * día de facturación: el 1, el 15, el 28. Lo que decide es la fecha de cada
 * cliente, no la del calendario.
 */
export function programarFacturacion({
  activo = config.facturacion.automatica,
  hora = config.facturacion.hora,
  intervaloMs = 5 * 60 * 1000,
  ejecutar = generarFacturas,
} = {}) {
  estadoFacturacion.automatica = activo
  estadoFacturacion.hora = hora

  if (!activo) return null

  const revisar = async () => {
    const ahora = new Date()
    const hoy = fechaLocal(ahora)

    if (estadoFacturacion.ultimaCorrida === hoy) return
    if (!llegoLaHora(ahora, hora)) return

    estadoFacturacion.ultimaCorrida = hoy
    try {
      const r = await ejecutar({})
      estadoFacturacion.ultimoResultado = r
      console.log(`[facturación] ${r.creadas.length} facturas creadas, ${r.omitidos.length} omitidos`)
    } catch (err) {
      estadoFacturacion.ultimoResultado = { error: err.message }
      console.error(`[facturación] la corrida falló: ${err.message}`)
      // Se libera para reintentar: un error de red no puede dejar sin facturar
      // a todo un día.
      estadoFacturacion.ultimaCorrida = null
    }
  }

  const temporizador = setInterval(revisar, intervaloMs)
  temporizador.unref?.()
  revisar()

  return temporizador
}
