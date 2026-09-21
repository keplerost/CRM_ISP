import { db } from '../lib/db.js'
import { AppError, badRequest, notFound } from '../lib/errors.js'
import { abrirTicket, misFacturas, miCuenta, pedirCambioWifi } from './portal.js'
import { reactivarServicio } from './reactivacion.js'
import { incidenciaActivaDe } from './incidencias.js'
import { diagnosticar, reiniciarEquipo } from './diagnostico.js'

/**
 * Lo que el CRM y el bot de WhatsApp pueden preguntar y hacer.
 *
 * ── Por qué es una capa aparte y no rutas nuevas colgadas del portal ──
 *
 * El portal del abonado ya sabe contestar casi todo esto, pero recibe siempre
 * un `clienteId` que sale de la SESIÓN de esa persona. El bot no tiene sesión de
 * nadie: llega con una cédula que le escribió alguien por chat. Si se le dejara
 * usar las mismas rutas, la garantía del portal —"ninguna ruta acepta un id de
 * cliente"— se rompería para todos.
 *
 * Así que acá está la única traducción cédula → abonado del sistema, en un solo
 * lugar, con su propio guardia de llave y su propio rastro. De ahí para abajo
 * se reusan las funciones del portal tal cual: la deuda del abonado tiene que
 * dar lo mismo la mire él o se la pregunte el bot.
 *
 * ── Lo que NO se manda por acá ──
 *
 * La clave del PPPoE, la IP, el serial completo de la ONT, el número de
 * contrato. Nada de eso lo necesita el bot para vender ni para cobrar, y todo
 * eso sirve para hacerse pasar por el abonado. Lo que viaja es lo que se le
 * puede leer en voz alta a quien está del otro lado del chat.
 */

/**
 * Lo que se lee del abonado, en un solo lugar.
 *
 * Enumerado y no `*`: agregar una columna a `clientes` no puede publicarla sin
 * querer por una API que consume una empresa de afuera.
 */
const SELECT_CLIENTE =
  'id, nombre, identificacion, estado, telefono, telefono_movil, codigo_pago, pasarela, dias_gracia'

/** Normaliza la cédula: la gente la escribe con puntos, guiones y espacios. */
const limpiar = (v) => String(v ?? '').replace(/[^0-9A-Za-z]/g, '').trim()

/**
 * Cédula → abonado.
 *
 * Es el único punto donde una identificación se convierte en un id, y por eso
 * es el único que hay que revisar cuando alguien pregunta si el bot puede ver
 * la cuenta de otro.
 *
 * Los dados de baja quedan afuera: el índice único de `clientes` solo garantiza
 * una identificación por abonado ENTRE LOS VIGENTES (migración 64). Buscarlos
 * también haría que el ex abonado de una cédula tape al actual.
 */
export async function clientePorIdentificacion(identificacion) {
  const ident = limpiar(identificacion)

  if (!ident) throw badRequest('Falta la identificación (cédula o RUC) del abonado.')
  if (ident.length < 5) throw badRequest('Esa identificación es demasiado corta.')

  const { data, error } = await db()
    .from('clientes')
    .select(SELECT_CLIENTE)
    .eq('identificacion', ident)
    .neq('estado', 'baja')
    .maybeSingle()

  if (error) {
    throw new AppError(`No se pudo buscar al abonado: ${error.message}`, { status: 502 })
  }
  if (!data) {
    throw notFound(`No hay ningún abonado con la identificación ${ident}.`, {
      codigo: 'CLIENTE_NO_ENCONTRADO',
      hint: 'Puede estar cargado con otra cédula, o ser el titular otra persona de la casa.',
    })
  }

  return data
}

/** Solo dígitos. La gente escribe el teléfono de seis formas distintas. */
const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '')

/**
 * Los últimos nueve dígitos de un número ecuatoriano.
 *
 * `0991234567`, `+593991234567` y `593991234567` son el mismo teléfono escrito
 * de tres maneras, y en la ficha del abonado está cargado de cualquiera de las
 * tres. Lo único estable entre todas es la cola: `991234567`.
 *
 * Nueve y no diez: el diez incluiría el cero inicial del formato local, que es
 * justamente el que desaparece en el internacional.
 */
function colaDelTelefono(telefono) {
  const d = soloDigitos(telefono)
  return d.length >= 9 ? d.slice(-9) : null
}

/**
 * Encuentra al abonado por lo que el bot tenga a mano.
 *
 * ── Por qué el teléfono existe como forma de buscar ──
 *
 * Porque es lo primero que un bot de WhatsApp tiene: la conversación llega con
 * un número, no con una cédula. Obligarlo a pedir la cédula antes de poder
 * decir nada convierte cada consulta en dos mensajes más.
 *
 * ── Y por qué es la MENOS confiable de las tres ──
 *
 * Un teléfono no identifica a una persona: identifica a un aparato. El celular
 * de la casa figura en la ficha del padre y en la del hijo que también es
 * abonado. Por eso, cuando el número da más de un abonado, esto NO elige uno:
 * devuelve un error que le dice al bot que pida la cédula. Elegir el primero
 * sería mostrarle a alguien la deuda de otro.
 */
export async function clientePor({ cedula, telefono, cliente_id } = {}) {
  if (cliente_id) {
    const { data, error } = await db()
      .from('clientes')
      .select(SELECT_CLIENTE)
      .eq('id', cliente_id)
      .neq('estado', 'baja')
      .maybeSingle()

    if (error) {
      // Un id con formato inválido lo rechaza Postgres; se contesta "no existe"
      // y no un 502, que mandaría al proveedor a buscar un problema nuestro.
      if (/invalid input syntax/i.test(error.message)) {
        throw notFound(`No hay ningún abonado con el id ${cliente_id}.`, { codigo: 'CLIENTE_NO_ENCONTRADO' })
      }
      throw new AppError(`No se pudo buscar al abonado: ${error.message}`, { status: 502 })
    }
    if (!data) {
      throw notFound(`No hay ningún abonado con el id ${cliente_id}.`, { codigo: 'CLIENTE_NO_ENCONTRADO' })
    }
    return data
  }

  if (cedula) return clientePorIdentificacion(cedula)

  const cola = colaDelTelefono(telefono)
  if (!cola) {
    throw badRequest('Mandá la cédula o el teléfono del abonado.', { codigo: 'DATOS_INVALIDOS' })
  }

  const { data, error } = await db()
    .from('clientes')
    .select(SELECT_CLIENTE)
    .or(`telefono.ilike.%${cola},telefono_movil.ilike.%${cola}`)
    .neq('estado', 'baja')
    .limit(5)

  if (error) throw new AppError(`No se pudo buscar al abonado: ${error.message}`, { status: 502 })

  if (!data?.length) {
    throw notFound(`No hay ningún abonado con el teléfono ${telefono}.`, {
      codigo: 'CLIENTE_NO_ENCONTRADO',
      hint: 'Pedile la cédula: puede tener el servicio a nombre de otra persona de la casa.',
    })
  }

  if (data.length > 1) {
    throw new AppError('Ese teléfono está en la ficha de más de un abonado.', {
      status: 409,
      codigo: 'TELEFONO_AMBIGUO',
      hint: 'Pedile la cédula del titular para saber de cuál de los servicios se trata.',
    })
  }

  return data[0]
}

/**
 * El resumen con el que el bot contesta "¿por qué no tengo internet?".
 *
 * Junta el estado del servicio, la deuda, la fecha en que le toca el corte y si
 * tiene una promesa de pago vigente. Los cuatro juntos porque son la respuesta
 * completa: "estás cortado" sin el monto obliga a una segunda pregunta, y el
 * monto sin la fecha de corte no le dice al que todavía no está cortado cuánto
 * le queda.
 */
export async function estadoDeCuenta(identificacion) {
  const cliente = await clientePorIdentificacion(identificacion)

  const [cuenta, corte, promesa, incidencia] = await Promise.all([
    miCuenta(cliente.id),

    db()
      .rpc('fecha_de_corte', { p_cliente: cliente.id })
      .then((r) => r.data ?? null)
      .catch(() => null),

    db()
      .from('promesas_pago')
      .select('fecha_promesa, monto, estado')
      .eq('client_id', cliente.id)
      // 'activa' es el estado de la promesa que todavía no venció ni se cerró:
      // la base solo admite una por abonado (migración 08).
      .eq('estado', 'activa')
      .order('fecha_promesa', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then((r) => r.data ?? null)
      .catch(() => null),

    /**
     * ¿Está adentro de una avería que ya conocemos?
     *
     * Va en el resumen y no en un endpoint aparte a propósito: es el primer
     * dato que el bot necesita y pedirlo en una segunda llamada garantiza que
     * el día que haya apuro alguien lo saltee. Con esto, la respuesta a "no
     * tengo internet" ya viene con la explicación adentro.
     */
    incidenciaActivaDe(cliente.id).catch(() => null),
  ])

  return {
    cliente: {
      nombre: cuenta.nombre,
      identificacion: cuenta.identificacion,
      codigo_pago: cliente.codigo_pago,
      pasarela: cliente.pasarela,
    },
    servicio: cuenta.servicio,
    equipo: cuenta.equipo,
    cuenta: {
      ...cuenta.cuenta,
      // El día en que le toca el corte por mora. NULL = no debe nada.
      fecha_corte: corte,
      dias_gracia: cliente.dias_gracia ?? 0,
    },
    promesa_vigente: promesa
      ? { fecha: promesa.fecha_promesa, monto: Number(promesa.monto ?? 0) }
      : null,
    // `null` cuando no hay nada conocido. Cuando viene, es LA respuesta: el bot
    // tiene que decir esto antes que cualquier otra cosa.
    incidencia_activa: incidencia,
  }
}

/**
 * El diagnóstico completo, para cuando el abonado dice "no tengo internet".
 *
 * `profundo` habla con la OLT y con el router: tarda segundos y consume una de
 * las pocas sesiones SSH que admite el equipo. El rápido no toca nada y contesta
 * casi todos los casos — ver `services/diagnostico.js`.
 */
export async function diagnosticoDe(identificacion, { profundo = false } = {}) {
  const cliente = await clientePorIdentificacion(identificacion)
  const r = await diagnosticar(cliente.id, { profundo })

  return {
    cliente: { nombre: cliente.nombre, identificacion: cliente.identificacion },
    ...r,
  }
}

/** Reinicia la ONT del abonado. La suya y solo la suya: ver el servicio. */
export async function reiniciarEquipoDe(identificacion) {
  const cliente = await clientePorIdentificacion(identificacion)
  const r = await reiniciarEquipo(cliente.id)
  return { cliente: { nombre: cliente.nombre, identificacion: cliente.identificacion }, ...r }
}

/**
 * Las facturas del abonado.
 *
 * `estado` filtra: `pendiente` es lo que el bot necesita el 90% de las veces
 * —"¿cuánto debo?"— y es el valor por defecto. `todas` sirve para el que pide
 * su historial.
 */
export async function facturasDe(identificacion, { estado = 'pendiente' } = {}) {
  const cliente = await clientePorIdentificacion(identificacion)
  const todas = await misFacturas(cliente.id)

  const facturas = estado === 'todas' ? todas : todas.filter((f) => f.estado !== 'pagada')

  return {
    cliente: {
      nombre: cliente.nombre,
      identificacion: cliente.identificacion,
      codigo_pago: cliente.codigo_pago,
      estado_servicio: cliente.estado,
    },
    total_pendiente: Number(
      todas.filter((f) => f.estado !== 'pagada').reduce((s, f) => s + f.pendiente, 0).toFixed(2),
    ),
    facturas,
  }
}

const FORMAS = ['efectivo', 'transferencia', 'deposito', 'tarjeta', 'otro']

/**
 * Cómo se puede haber comprobado un pago, y cuáles alcanzan para acreditarlo.
 *
 *   bank_api     lo confirmó el banco. Es un hecho.
 *   qr_validado  el QR del comprobante coincide con su texto impreso y con la
 *                cuenta de destino. Retocar el texto visible no cambia el QR, así
 *                que una imagen editada no pasa esta prueba.
 *   human        lo aprobó una persona del ISP mirando el extracto.
 *   ocr_only     solo se leyó la imagen. NO alcanza: una captura se edita en
 *                treinta segundos y nada la contradice.
 *
 * `qr_validado` no prueba que la plata haya entrado a la cuenta del ISP —un
 * comprobante legítimo de una transferencia a otra persona valida igual— y por
 * eso convive con dos cosas que sí lo cubren: que el bot compare la cuenta de
 * destino, y que `hash_qr` sea único en toda la base.
 */
const METODOS = ['bank_api', 'qr_validado', 'human', 'ocr_only']

/** Los que alcanzan para acreditar sin que lo mire una persona. */
const METODOS_SUFICIENTES = ['bank_api', 'qr_validado', 'human']

/**
 * El vocabulario del CRM traducido al nuestro.
 *
 * ── Por qué hace falta traducir y no adoptar el suyo ──
 *
 * Porque `forma_pago` termina en `pagos`, y de ahí sale el reporte de ARCOTEL y
 * la conciliación bancaria. Esas dos cosas hablan de efectivo, transferencia,
 * depósito y tarjeta; no saben qué es un "spi". Meter el riel crudo en esa
 * columna ensucia un reporte del regulador para ganar comodidad en una
 * integración.
 *
 * El riel igual no se pierde: se guarda aparte, en `pagos_reportados.origen` y
 * en las notas del cobro. Es lo que necesita quien concilia —una transferencia
 * por app y un depósito en corresponsal aparecen distinto en el extracto— pero
 * es un dato del canal, no de la forma de pago contable.
 */
const RIELES = {
  app: 'transferencia',       // transferencia desde la app del banco
  spi: 'transferencia',       // interbancaria
  deuna: 'transferencia',     // billetera
  cnb: 'deposito',            // corresponsal no bancario
  transferencia: 'transferencia',
  deposito: 'deposito',
  efectivo: 'efectivo',
  tarjeta: 'tarjeta',
  unknown: 'otro',
  otro: 'otro',
}

/**
 * Revisa y normaliza lo que mandó el sistema externo.
 *
 * Está separada de `registrarPago` —y exportada— porque es la única parte de
 * todo esto que se puede probar sin base: quien llama es un programa de otra
 * empresa, y lo que mande va a ser exactamente lo que su documentación le haga
 * entender. Las reglas de acá son las que evitan que un malentendido de ese
 * lado se convierta en plata mal contada del nuestro.
 *
 * @param hoy  la fecha de referencia, en AAAA-MM-DD. Se recibe en vez de leerse
 *             del reloj para que la prueba de "no puede ser futura" no dependa
 *             del día en que se corra.
 */
export function normalizarPago(datos = {}, hoy = new Date().toISOString().slice(0, 10)) {
  const monto = Number(datos.monto)
  if (!Number.isFinite(monto) || monto <= 0) {
    throw badRequest('El monto tiene que ser un número mayor que cero.')
  }
  if (monto > 100000) {
    // No es un límite legal: es el tope que separa un cobro de un error de
    // tipeo con un cero de más. Un pago real por encima de esto se carga a mano.
    throw badRequest('Ese monto es demasiado alto para registrarlo por acá: cargalo desde el sistema.')
  }

  const riel = String(datos.forma_pago ?? datos.riel ?? 'transferencia').toLowerCase().trim()
  const forma = RIELES[riel]
  if (!forma) {
    throw badRequest(`Forma de pago desconocida: ${riel}`, {
      codigo: 'DATOS_INVALIDOS',
      hint: `Las válidas son: ${Object.keys(RIELES).join(', ')}.`,
    })
  }

  const fecha = fechaLocal(datos.fecha_pago ?? datos.fecha ?? datos.fecha_transaccion, hoy)
  if (!fecha) {
    throw badRequest('La fecha del pago no se entiende.', {
      codigo: 'DATOS_INVALIDOS',
      hint: 'Mandala como AAAA-MM-DD o como fecha y hora ISO 8601.',
    })
  }
  // Una fecha futura convierte el cierre de caja de hoy en algo que no cierra
  // hasta pasado mañana. Es siempre un error de quien llama.
  if (fecha > hoy) {
    throw badRequest('La fecha del pago no puede ser futura.', { codigo: 'DATOS_INVALIDOS' })
  }

  /**
   * Cómo se comprobó el pago. Solo puede BAJAR la confianza, nunca subirla:
   * quién puede acreditar sin verificación lo decide la llave. Ver
   * `registrarPago`.
   *
   * El CRM lo manda como `verificado_por`; adentro se guarda en
   * `metodo_verificacion`, porque `pagos_reportados.verificado_por` ya existe
   * desde la migración 173 y es otra cosa: el UUID de la PERSONA que lo
   * verificó. Una es "cómo" y la otra es "quién".
   */
  const verificado = String(datos.verificado_por ?? datos.metodo_verificacion ?? '')
    .toLowerCase()
    .trim()
  if (verificado && !METODOS.includes(verificado)) {
    throw badRequest(`verificado_por desconocido: ${verificado}`, {
      codigo: 'DATOS_INVALIDOS',
      hint: `Los válidos son: ${METODOS.join(', ')}.`,
    })
  }

  const texto = (v, largo) => String(v ?? '').trim().slice(0, largo) || null

  return {
    monto: Number(monto.toFixed(2)),
    forma_pago: forma,
    fecha_pago: fecha,
    // El riel crudo, para quien concilia: una transferencia por app y un
    // depósito en corresponsal aparecen distinto en el extracto del banco.
    origen: texto(datos.origen ?? (riel === forma ? null : riel.toUpperCase()), 30),
    n_transaccion: texto(datos.n_transaccion ?? datos.num_comprobante ?? datos.numero_comprobante, 60),
    referencia_externa: texto(datos.referencia_externa ?? datos.external_ref, 120),
    comprobante_url: texto(datos.comprobante_url ?? datos.adjunto_url, 2000),
    notas: texto(datos.notas ?? datos.observacion ?? datos.observaciones, 1000),
    banco_origen: texto(datos.banco_origen ?? datos.banco, 80),
    depositante: texto(datos.depositante, 150),
    hash_qr: texto(datos.hash_qr, 128),
    uuid_transaccion: texto(datos.uuid_transaccion, 80),
    metodo_verificacion: verificado || null,
  }
}

/**
 * La fecha del pago, en el día que fue acá.
 *
 * ── El error que esto evita ──
 *
 * El CRM manda `2026-08-17 05:00:00` o un ISO con `Z`. Cortar los diez primeros
 * caracteres de un ISO en UTC pone del lado equivocado del día a todo pago
 * hecho después de las 19:00 hora de Ecuador: se registran mañana, y el cierre
 * de caja de hoy no cuadra con lo que hay en el cajón.
 *
 * Con hora, se convierte a la hora local antes de quedarse con el día. Sin hora
 * —`2026-08-17` pelado— se toma tal cual: ahí ya dijeron un día, no un instante.
 */
function fechaLocal(valor, hoy) {
  const crudo = String(valor ?? '').trim()
  if (!crudo) return hoy

  /**
   * Tiene que empezar por el año. Sin excepciones.
   *
   * ── Por qué no se acepta `15/08/2026` ──
   *
   * Porque `08/15/2026` también llegaría, y JavaScript lo lee como 15 de agosto
   * mientras que quien lo escribió pudo querer decir 8 de mayo. `01/02/2026` es
   * el caso venenoso: es válido en las dos lecturas y se registra un mes
   * corrido, sin error y sin que nadie lo note hasta que la caja de febrero no
   * cierra.
   *
   * Rechazarlo obliga al proveedor a mandar ISO, que no es ambiguo. Es una
   * molestia de una vez contra un error silencioso para siempre.
   */
  const empieza = crudo.match(/^(\d{4}-\d{2}-\d{2})/)
  if (!empieza) return null

  // Un día pelado es un día: no se reinterpreta como medianoche UTC.
  if (crudo.length === 10) return empieza[1]

  // "2026-08-17 05:00:00" sin zona: es hora local de quien lo mandó, y el día
  // es el que dice. Convertirlo sería inventarle un huso.
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(crudo)) return empieza[1]

  const d = new Date(crudo)
  if (Number.isNaN(d.getTime())) return null

  // Con zona explícita sí se convierte: `2026-08-17T02:00:00Z` es el 16 acá, y
  // registrarlo el 17 descuadra el cierre de caja de los dos días.
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Registra un pago que viene de afuera.
 *
 * ── Los dos caminos, y por qué ──
 *
 * Lo que decide no es el endpoint sino QUIÉN afirma que la plata entró, y eso
 * está guardado en la llave (`confirma_pagos`):
 *
 *   * La llave del webhook de la pasarela lo confirma: quien avisa es el que
 *     recibió el dinero. El cobro se aplica en el acto, igual que en ventanilla.
 *   * La llave del bot no: lo que llega es la palabra del abonado por chat, con
 *     una captura que se edita en treinta segundos. Queda REPORTADO y cobranza
 *     lo verifica contra el extracto.
 *
 * Se resuelve por llave y no por un campo del pedido a propósito: si el sistema
 * externo pudiera mandar `confirmado: true`, la diferencia entre las dos cosas
 * la decidiría quien llama, y entonces no existe.
 *
 * ── La idempotencia no es un detalle ──
 *
 * `referencia_externa` es la clave del lado de afuera. Un bot reintenta cuando
 * se cae el enlace, y una pasarela reintenta su webhook hasta que le contestes
 * 200. Sin esta clave, cada reintento es un cobro más: el abonado termina con
 * saldo a favor que nadie le debe y la caja del día no cuadra. Con ella, el
 * segundo intento devuelve el mismo resultado que el primero.
 */
/**
 * ¿Este pago ya lo teníamos?
 *
 * ── Las tres claves, y por qué son tres ──
 *
 * `referencia_externa` es interna del CRM: la deduplicación es POR LLAVE,
 * porque dos sistemas distintos pueden usar el número "1024" para cosas
 * distintas.
 *
 * `hash_qr` y `uuid_transaccion` son otra cosa: identifican una transferencia
 * del mundo real. El mismo comprobante reportado por el bot y por el panel del
 * CRM es el mismo pago, y tiene que chocar aunque vengan por llaves distintas.
 * Por eso esos dos se buscan sin filtrar por llave.
 *
 * `hash_qr` es además la única de las tres que el CRM no tiene que acordarse de
 * mandar: es la huella de la imagen. Es la que atrapa al abonado que reenvía el
 * comprobante de su vecino.
 */
async function buscarReporteRepetido(llave, limpio, clienteId = null) {
  const buscar = async (consulta) => {
    // `.limit(1)` y no `.maybeSingle()` a secas: si en la base YA quedaron dos
    // filas del mismo comprobante —que es exactamente lo que pasa cuando este
    // control falló alguna vez— `maybeSingle` devuelve error en vez de fila, el
    // repetido no se detecta, y cada reintento agrega uno más. El control
    // antiduplicados no puede depender de que nunca haya habido duplicados.
    const { data } = await consulta.limit(1).maybeSingle()
    if (!data) return null
    return {
      repetido: true,
      reporte_id: data.id,
      estado: data.estado,
      pago_id: data.pago_id,
      mensaje: 'Ese pago ya estaba registrado. No se duplicó.',
    }
  }

  const columnas = 'id, estado, pago_id'

  if (limpio.hash_qr) {
    const r = await buscar(
      db().from('pagos_reportados').select(columnas)
        .eq('hash_qr', limpio.hash_qr).neq('estado', 'rechazado'),
    )
    if (r) return { ...r, mensaje: 'Ese comprobante ya estaba registrado. No se duplicó.' }
  }

  if (limpio.uuid_transaccion) {
    const r = await buscar(
      db().from('pagos_reportados').select(columnas)
        .eq('uuid_transaccion', limpio.uuid_transaccion).neq('estado', 'rechazado'),
    )
    if (r) return r
  }

  if (limpio.referencia_externa) {
    const r = await buscar(
      db().from('pagos_reportados').select(columnas)
        .eq('llave_id', llave.id).eq('referencia_externa', limpio.referencia_externa),
    )
    if (r) return r
  }

  /**
   * Último recurso: el número de comprobante del mismo abonado.
   *
   * ── Por qué no alcanzaba con los tres de arriba ──
   *
   * Los tres dependen de que la fila YA GUARDADA tenga ese dato. Y el primer
   * intento de un CRM muchas veces no lo trae: manda el número de comprobante y
   * nada más. Cuando el reintento llega ya con `hash_qr`, se busca por hash, no
   * lo encuentra —porque la fila vieja lo tiene en NULL— y entra un duplicado.
   *
   * Paso exactamente eso con el comprobante 81808263: quedaron dos filas, una
   * pendiente sin hash y una confirmada con hash. La segunda cobró bien; la
   * primera quedó esperando que alguien la confirmara y cobrara dos veces.
   *
   * Va acotado al abonado y no global a propósito: dos bancos distintos pueden
   * emitir el mismo número, y rechazar el pago de otro abonado por coincidencia
   * de numeración sería peor que el duplicado que evita.
   *
   * Es la evidencia más débil de las cuatro —un número se puede tipear mal— y
   * por eso va última: solo decide cuando ninguna de las otras tres pudo.
   */
  if (limpio.n_transaccion && clienteId) {
    const r = await buscar(
      db().from('pagos_reportados').select(columnas)
        .eq('client_id', clienteId)
        .eq('n_transaccion', limpio.n_transaccion)
        .neq('estado', 'rechazado'),
    )
    if (r) return { ...r, mensaje: 'Ese comprobante ya estaba registrado. No se duplicó.' }
  }

  return null
}

/**
 * La factura que dijo el CRM, si de verdad es de este abonado.
 *
 * Se valida en vez de confiar: `aplicar_cobro` salda primero la factura que se
 * le pase, y un id equivocado —un error de mapeo del proveedor, un id de otro
 * sistema— saldaría la factura de otra persona con la plata de esta. Cuando no
 * corresponde se ignora y el cobro se reparte por antigüedad, que es el
 * comportamiento correcto por omisión.
 */
async function facturaDelCliente(facturaId, clienteId) {
  if (!facturaId) return null

  // El `.then()` antes del `.catch()` no es adorno: lo que devuelve Supabase es
  // un builder «thenable», no una Promise. Tiene `.then` pero no `.catch`, así
  // que encadenarle el `.catch` directo revienta con "catch is not a function"
  // —y revienta SIEMPRE que se manda `factura_id`, no solo cuando la consulta
  // falla, porque el error es de la cadena y no del resultado. El `.then`
  // convierte el builder en una Promise de verdad, y recién ahí hay `.catch`.
  const id = await db()
    .from('facturas')
    .select('id')
    .eq('id', facturaId)
    .eq('client_id', clienteId)
    .eq('anulada', false)
    .maybeSingle()
    .then((r) => r.data?.id ?? null)
    .catch(() => null)

  return id
}

/**
 * ¿Este comprobante ya está registrado?
 *
 * ── Para qué sirve ──
 *
 * El CRM lo pregunta ANTES de registrar, para poder decírselo al abonado en la
 * pantalla: "este comprobante ya lo recibimos". Sin esto, la única forma de
 * saberlo es intentar registrarlo y mirar `repetido` — que funciona, pero deja
 * al bot contestando "recibimos tu pago" por algo que ya estaba.
 *
 * ── Lo que NO devuelve, y por qué ──
 *
 * Si el comprobante está registrado a nombre de OTRO abonado, se dice que está
 * registrado y no de quién. Ese es exactamente el caso del que reenvía el
 * comprobante del vecino: decirle "ya lo usó María Pérez" le confirma un dato
 * de otra persona que no tenía. El ISP lo ve completo en su bandeja; el chat, no.
 *
 * ── El rechazado no bloquea ──
 *
 * Un comprobante que cobranza rechazó por ilegible tiene que poder reenviarse
 * con una foto mejor. Por eso viaja `puede_reenviar`: es la diferencia entre
 * "ya está, no insistas" y "mandalo de nuevo".
 */
export async function consultarComprobante(datos = {}) {
  const hash = String(datos.hash_qr ?? '').trim() || null
  const uuid = String(datos.uuid_transaccion ?? '').trim() || null
  const numero =
    String(datos.num_comprobante ?? datos.numero_comprobante ?? datos.n_transaccion ?? '').trim() ||
    null

  if (!hash && !uuid && !numero) {
    throw badRequest('Decí qué comprobante querés consultar.', {
      codigo: 'DATOS_INVALIDOS',
      hint: 'Mandá hash_qr, uuid_transaccion o num_comprobante. El hash es el más confiable.',
    })
  }

  /**
   * Se busca por la clave más fuerte primero.
   *
   * `num_comprobante` va último y a propósito: no es único en el mundo real
   * —dos bancos distintos pueden emitir el mismo número— así que encontrarlo
   * por ahí es una pista, no una certeza. Los otros dos identifican una
   * transferencia concreta.
   */
  const intentos = [
    hash && { campo: 'hash_qr', valor: hash, fuerte: true },
    uuid && { campo: 'uuid_transaccion', valor: uuid, fuerte: true },
    numero && { campo: 'n_transaccion', valor: numero, fuerte: false },
  ].filter(Boolean)

  let encontrado = null
  let porDonde = null

  for (const { campo, valor, fuerte } of intentos) {
    const { data } = await db()
      .from('pagos_reportados')
      .select('id, client_id, estado, monto, fecha_pago, created_at, banco_origen, pago_id')
      .eq(campo, valor)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (data) {
      encontrado = data
      porDonde = { campo, fuerte }
      break
    }
  }

  if (!encontrado) {
    return {
      registrado: false,
      puede_registrar: true,
      mensaje: 'Este comprobante todavía no está registrado.',
    }
  }

  // Si dijeron de quién es, se compara. Sin identificador no se compara nada:
  // no es un error, es que preguntaron solo por el comprobante.
  let delMismo = null
  const quien = datos.cedula ?? datos.identificacion ?? datos.documento
  if (quien || datos.cliente_id || datos.telefono) {
    const cliente = await clientePor({
      cedula: quien,
      telefono: datos.telefono,
      cliente_id: datos.cliente_id,
    }).catch(() => null)

    if (cliente) delMismo = cliente.id === encontrado.client_id
  }

  const rechazado = encontrado.estado === 'rechazado'

  return {
    registrado: true,
    estado: encontrado.estado,
    reporte_id: encontrado.id,
    pago_id: encontrado.pago_id ?? null,
    monto: Number(encontrado.monto),
    fecha_pago: encontrado.fecha_pago,
    registrado_el: encontrado.created_at,
    banco_origen: encontrado.banco_origen ?? null,
    // `null` = no se preguntó por ningún abonado.
    del_mismo_abonado: delMismo,
    // Lo único que decide si tiene sentido volver a mandarlo.
    puede_reenviar: rechazado,
    // Se avisa cuando la coincidencia es por número de comprobante, que no es
    // único: puede ser el mismo número de otro banco y no el mismo pago.
    coincidencia: porDonde.fuerte ? 'exacta' : 'por número de comprobante',
    mensaje: mensajeDeComprobante(encontrado.estado, delMismo, porDonde.fuerte),
  }
}

/**
 * El texto que el bot le muestra al abonado.
 *
 * Va armado acá y no del lado del CRM por lo mismo que el resto de los
 * `mensaje` de esta API: si cada integración redacta el suyo, terminan diciendo
 * cosas distintas sobre el mismo hecho — y una de ellas va a decir "ya se
 * acreditó" sobre un comprobante que todavía está en revisión.
 */
export function mensajeDeComprobante(estado, delMismoAbonado, coincidenciaFuerte = true) {
  if (delMismoAbonado === false) {
    // No se dice a nombre de quién: ver el comentario de `consultarComprobante`.
    return 'Este comprobante ya figura registrado a nombre de otro abonado. Si creés que es un error, escribinos.'
  }

  if (estado === 'confirmado') {
    return 'Este comprobante ya fue registrado y acreditado. No hace falta enviarlo de nuevo.'
  }
  if (estado === 'rechazado') {
    return 'Este comprobante fue revisado y no se pudo validar. Si tenés una foto más clara, mandala.'
  }

  return coincidenciaFuerte
    ? 'Este comprobante ya lo recibimos y lo estamos validando. Te avisamos en cuanto se acredite.'
    : 'Ya tenemos registrado un pago con ese número de comprobante y lo estamos validando.'
}

/**
 * La cuenta a la que el bot leyó que entró la plata.
 *
 * ── Por qué se recibe el NÚMERO y no nuestro id ──
 *
 * Porque el bot lo lee del comprobante, y en el comprobante está el número de
 * cuenta del banco, no el UUID de nuestra tabla. Pedirle que conozca nuestros
 * ids lo obligaría a mantener una copia de nuestra configuración, y el día que
 * el ISP agregue una cuenta habría que avisarle al proveedor.
 *
 * ── Por qué un número que no reconocemos es un RECHAZO ──
 *
 * Si el bot dice que la transferencia entró a una cuenta que no es del ISP, no
 * hay nada que acreditar: esa plata está en otro lado. Puede ser un comprobante
 * de un pago a un tercero, o la cuenta vieja que alguien dejó copiada en un
 * chat. Aceptarlo saldaría una factura con dinero que nunca llegó, y el faltante
 * recién aparecería en la conciliación del mes.
 *
 * Se comparan solo los dígitos: en un comprobante el número puede venir con
 * guiones, espacios o puntos según el banco.
 */
async function cuentaDelComprobante(datos) {
  const crudo = String(
    datos.cuenta_destino ?? datos.numero_cuenta ?? datos.cuenta ?? '',
  ).trim()

  if (!crudo) return { cuenta_id: null }

  const soloNumeros = crudo.replace(/\D/g, '')
  if (!soloNumeros) return { cuenta_id: null }

  const { data } = await db()
    .from('cuentas_pago')
    .select('id, nombre, numero')
    .eq('activa', true)
    .not('numero', 'is', null)

  const encontrada = (data ?? []).find(
    (c) => String(c.numero).replace(/\D/g, '') === soloNumeros,
  )

  if (!encontrada) {
    throw badRequest(
      `La cuenta ${crudo} no es una cuenta de cobro de este ISP.`,
      {
        codigo: 'CUENTA_DESCONOCIDA',
        hint: 'Si el comprobante dice que la transferencia fue a esa cuenta, la plata no entró acá. No se registra.',
      },
    )
  }

  return { cuenta_id: encontrada.id, cuenta: encontrada.nombre }
}

export async function registrarPago(llave, datos = {}) {
  const cliente = await clientePor({
    cedula: datos.identificacion ?? datos.cedula ?? datos.documento,
    telefono: datos.telefono,
    cliente_id: datos.cliente_id,
  })
  const limpio = normalizarPago(datos)

  // --- El reintento se contesta con lo de la primera vez -----------------------
  const yaEstaba = await buscarReporteRepetido(llave, limpio, cliente.id)
  if (yaEstaba) return yaEstaba

  // A qué cuenta entró. Si el bot informa una que no es del ISP, esto lanza:
  // no hay nada que acreditar con plata que fue a otro lado.
  const { cuenta_id, cuenta } = await cuentaDelComprobante(datos)

  const fila = {
    client_id: cliente.id,
    cliente_nombre: cliente.nombre,
    identificacion: cliente.identificacion,
    llave_id: llave.id,
    llave_nombre: llave.nombre,
    cuenta_id,
    // La factura contra la que el abonado dijo estar pagando. Se valida que sea
    // suya: sin eso, un id equivocado saldaría la factura de otro abonado.
    factura_id: await facturaDelCliente(datos.factura_id, cliente.id),
    ...limpio,
  }

  const { data: reporte, error } = await db()
    .from('pagos_reportados')
    .insert(fila)
    .select('id')
    .single()

  if (error) {
    // 23505 = otro pedido con la misma evidencia entró primero. Es el reintento
    // que llegó mientras el original todavía se estaba guardando; contestarle un
    // error haría que el CRM lo intente una tercera vez.
    if (error.code === '23505') {
      const previo = await buscarReporteRepetido(llave, limpio)
      if (previo) return previo
    }
    throw new AppError(`No se pudo registrar el pago: ${error.message}`, { status: 502 })
  }

  // --- ¿Se acredita solo, o espera verificación? ------------------------------
  //
  // Dos condiciones, y las dos tienen que darse. La llave fija el TECHO —quién
  // tiene permiso de acreditar sin que lo mire una persona— y `verificado_por`
  // solo puede bajarlo.
  //
  // Al revés no: si `verificado_por` pudiera SUBIR la confianza, alcanzaría con
  // que el sistema externo mandara "human" para saltarse la verificación, y
  // entonces la verificación no existiría. La palabra de quien llama no puede
  // ser la que decide si su propia palabra alcanza.
  const evidenciaAlcanza = limpio.metodo_verificacion
    ? METODOS_SUFICIENTES.includes(limpio.metodo_verificacion)
    : true

  /**
   * ── La tercera condición: saber a qué cuenta entró ──
   *
   * `aplicar_cobro` acepta un cobro sin cuenta: queda registrado, salda la
   * factura y no aparece en ninguna caja. La conciliación del mes lo ve como
   * plata que entró de la nada, y para entonces ya está en el cierre y en el
   * reporte de ARCOTEL.
   *
   * Antes esto se prevenía obligando a fijar una cuenta en la llave. Estaba mal:
   * el ISP tiene dos cuentas y el abonado transfiere a la que quiere, así que la
   * fija archivaba mal la mitad. Ahora la garantía vive acá, que es donde se
   * sabe de verdad — con la cuenta del comprobante o, si no vino, con la de la
   * llave.
   *
   * Sin ninguna de las dos NO se rechaza el pago: se deja en la bandeja. El
   * abonado pagó de verdad y perder ese reporte sería peor que archivarlo mal.
   * Quien confirme elige la cuenta mirando el extracto.
   */
  const cuentaResuelta = cuenta_id ?? llave.cuenta_id ?? null

  if (!llave.confirma_pagos || !evidenciaAlcanza || !cuentaResuelta) {
    return {
      repetido: false,
      reporte_id: reporte.id,
      estado: 'pendiente',
      confirmado: false,
      motivo_pendiente: !llave.confirma_pagos
        ? 'esta llave no acredita pagos sin verificación'
        : !evidenciaAlcanza
          ? `el método "${limpio.metodo_verificacion}" no alcanza para acreditar sin revisión`
          : 'no se sabe a qué cuenta entró la plata: mandá `cuenta_destino` o fijá una cuenta por defecto en la llave',
      mensaje:
        'Recibimos el reporte del pago. Lo verificamos y se acredita apenas se confirme.',
    }
  }

  // --- Camino 2: la pasarela ya cobró, se aplica -------------------------------
  const { data: resultado, error: errAplicar } = await db().rpc('confirmar_pago_reportado', {
    p_id: reporte.id,
    p_usuario: null,
    // `null` a propósito: la función ya elige entre la cuenta que informó el bot
    // y la fija de la llave. Mandarla desde acá pisaría la del comprobante.
    p_cuenta_id: null,
  })

  if (errAplicar) {
    /**
     * 23505 = la base frenó un cobro que ya estaba.
     *
     * `idx_pagos_transaccion_unica` es la última defensa: aunque el control de
     * repetidos de más arriba no lo haya visto, el libro no admite dos veces la
     * misma transacción. Contestar ERROR_INTERNO acá sería mentir dos veces —
     * el sistema funcionó, y encima la documentación le dice al CRM que
     * reintente con espera creciente, o sea que lo empuja a insistir con algo
     * que nunca va a entrar.
     */
    if (errAplicar.code === '23505') {
      return {
        repetido: true,
        reporte_id: reporte.id,
        estado: 'pendiente',
        confirmado: false,
        acreditado: false,
        mensaje: 'Ese pago ya estaba cobrado. No se duplicó.',
      }
    }

    /**
     * El reporte queda guardado y pendiente, a propósito.
     *
     * Si acá se borrara la fila, la plata que la pasarela ya cobró
     * desaparecería del sistema y nadie se enteraría hasta la conciliación. Con
     * el reporte en la bandeja, cobranza lo ve al día siguiente y lo confirma a
     * mano: el error se convierte en una demora, no en un faltante.
     */
    throw new AppError(`El pago quedó reportado pero no se pudo aplicar: ${errAplicar.message}`, {
      status: 502,
      hint: 'Queda en Cobros → Pagos reportados para confirmarlo a mano.',
      reporte_id: reporte.id,
    })
  }

  const cobro = resultado?.cobro ?? {}
  const salida = {
    repetido: false,
    reporte_id: reporte.id,
    estado: 'confirmado',
    confirmado: true,
    pago_id: cobro.pago_id ?? null,
    facturas_saldadas: cobro.facturas ?? [],
    saldo_a_favor: Number(cobro.excedente ?? 0),
    cuenta: cuenta ?? null,
    mensaje: 'Pago acreditado.',
  }

  // --- La reactivación, solo si la llave la tiene habilitada -------------------
  if (llave.reactiva_servicio) {
    salida.reactivacion = await reactivarServicio(cliente.id, {
      motivo: `Pago confirmado vía ${llave.nombre}`,
    })
  }

  return salida
}

/**
 * El abonado pide cambiar la clave de su WiFi desde el chat.
 *
 * Delega en el portal, que ya sabe intentarlo contra el equipo por TR-069 y
 * dejarlo pedido si el ACS no está o no lo alcanza. Lo importante es que la
 * respuesta distingue las dos cosas: el bot no puede decir "listo" cuando lo
 * que pasó fue "queda anotado para que alguien lo haga".
 */
export async function cambiarWifi(identificacion, { ssid, clave } = {}) {
  const cliente = await clientePorIdentificacion(identificacion)
  const r = await pedirCambioWifi(cliente.id, { ssid, clave })
  return { cliente: { nombre: cliente.nombre, identificacion: cliente.identificacion }, ...r }
}

/**
 * Un reclamo abierto desde el chat. Mismo circuito que el del portal.
 *
 * ── El caso que descarga el canal de soporte ──
 *
 * Si el abonado está adentro de una avería que YA conocemos y lo que reporta es
 * que no tiene internet, no se abre ticket: se le contesta la avería. Es
 * exactamente el mensaje que multiplicado por ciento ochenta tapa la bandeja, y
 * cada uno de esos tickets manda a alguien a revisar una falla que ya tiene
 * dueño y técnico asignado.
 *
 * Se contesta 409 y no 200: el bot tiene que poder distinguir "tu reclamo quedó
 * abierto" de "ya lo sabemos", porque son dos respuestas distintas para el
 * abonado. Y solo se bloquean los tipos de falla que la avería explica — quien
 * escribe por un cambio de clave durante un corte de fibra sigue siendo
 * atendido.
 */
const EXPLICADOS_POR_AVERIA = ['sin_internet', 'intermitente', 'lento']

export async function crearTicket(identificacion, { tipo, descripcion } = {}) {
  const cliente = await clientePorIdentificacion(identificacion)

  if (EXPLICADOS_POR_AVERIA.includes(tipo)) {
    const incidencia = await incidenciaActivaDe(cliente.id).catch(() => null)
    if (incidencia) {
      throw new AppError('Ya conocemos esta falla: hay una avería abierta en su sector.', {
        status: 409,
        hint: 'Contestale con el mensaje de la incidencia. No hace falta abrir un reclamo.',
        incidencia,
        ticket_creado: false,
      })
    }
  }

  const t = await abrirTicket(cliente.id, { tipo, descripcion })
  return {
    cliente: { nombre: cliente.nombre, identificacion: cliente.identificacion },
    ticket: t,
  }
}
