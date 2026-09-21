import { db } from '../lib/db.js'
import { encrypt } from '../lib/crypto.js'
import { AppError, badRequest, notFound } from '../lib/errors.js'
import { buscarPorSerie, cambiarWifi as aplicarEnElEquipo, hayAcs, leerWifi } from '../drivers/genieacs.js'

/**
 * Lo que el abonado ve y hace en su portal.
 *
 * ── La regla ──
 *
 * Cada función de este archivo recibe `clienteId` como PRIMER argumento, y ese
 * id sale siempre de la sesión — nunca de algo que mandó el navegador. Toda
 * consulta filtra por él.
 *
 * Es deliberado que ninguna función acepte un id de factura, de ticket o de lo
 * que sea sin acompañarlo del cliente: así, "traeme la factura 500" no puede
 * devolver la factura de otro. La falla clásica de estos portales es cambiar un
 * número en la URL y ver la cuenta del vecino, y no se evita recordándolo: se
 * evita haciendo que la consulta sin el filtro no exista.
 */

const enBase = (error, que) => {
  if (error) throw new AppError(`No se pudo ${que}: ${error.message}`, { status: 502 })
}

/**
 * El resumen: quién es, qué tiene contratado y cómo está su servicio.
 *
 * Es la primera pantalla y contesta la pregunta con la que el abonado entra:
 * "¿por qué no tengo internet?". Si está cortado por deuda, se lo dice — con
 * cuánto debe y hasta cuándo tenía para pagar. Un "servicio suspendido" a secas
 * termina igual en una llamada.
 */
export async function miCuenta(clienteId) {
  const { data: cliente, error } = await db()
    .from('clientes')
    .select(
      'id, nombre, identificacion, email, telefono, telefono_movil, direccion, estado, ip, usuario_ppp, plan_id, onu_id, portal_clave_puesta',
    )
    .eq('id', clienteId)
    .maybeSingle()

  enBase(error, 'leer tu cuenta')
  if (!cliente) throw notFound('No encontramos tu cuenta.')

  const [plan, onu, saldo] = await Promise.all([
    cliente.plan_id
      ? db()
          .from('planes_velocidad')
          .select('nombre, bajada_kbps, subida_kbps, precio')
          .eq('id', cliente.plan_id)
          .maybeSingle()
          .then((r) => r.data)
      : null,

    cliente.onu_id
      ? db()
          .from('onus')
          .select('sn, modelo, estado, rx_power_dbm, ultima_lectura, ssid')
          .eq('id', cliente.onu_id)
          .maybeSingle()
          .then((r) => r.data)
      : null,

    db()
      .from('v_saldo_clientes')
      .select('saldo, facturas_pendientes')
      .eq('client_id', clienteId)
      .maybeSingle()
      .then((r) => r.data)
      .catch(() => null),
  ])

  return {
    nombre: cliente.nombre,
    identificacion: cliente.identificacion,
    // Si ya definió contraseña. Se manda el booleano y NUNCA el hash: la
    // pantalla solo necesita saber si dice "crear" o "cambiar".
    tiene_clave: Boolean(cliente.portal_clave_puesta),
    contacto: {
      email: cliente.email,
      telefono: cliente.telefono,
      telefono_movil: cliente.telefono_movil,
      direccion: cliente.direccion,
    },
    servicio: {
      estado: cliente.estado,
      plan: plan?.nombre ?? null,
      // En megas, que es como se vende y como lo entiende el abonado.
      bajada_mbps: plan?.bajada_kbps ? Math.round(plan.bajada_kbps / 1000) : null,
      subida_mbps: plan?.subida_kbps ? Math.round(plan.subida_kbps / 1000) : null,
      precio: plan?.precio ?? null,
    },
    equipo: onu
      ? {
          modelo: onu.modelo,
          // El serial NO se manda entero: identifica al equipo y no le sirve de
          // nada al abonado, pero sí a quien quiera hacerse pasar por él.
          serial_corto: onu.sn ? `····${String(onu.sn).slice(-4)}` : null,
          en_linea: onu.estado === 'online',
          // La señal se traduce a palabras. "−24.7 dBm" no le dice nada a nadie
          // que no sea técnico, y el que sí es técnico igual la ve en la ficha.
          senal: calidadDeSenal(onu.rx_power_dbm),
          ssid: onu.ssid,
          ultima_lectura: onu.ultima_lectura,
        }
      : null,
    cuenta: {
      saldo: saldo?.saldo ?? 0,
      facturas_pendientes: saldo?.facturas_pendientes ?? 0,
    },
  }
}

/**
 * La potencia óptica, en palabras.
 *
 * Los cortes son los de siempre en GPON: por encima de −25 dBm está bien, entre
 * −25 y −28 empieza a costar, más abajo la conexión se cae sola.
 */
function calidadDeSenal(dbm) {
  if (dbm == null) return null
  const n = Number(dbm)
  if (!Number.isFinite(n)) return null
  if (n >= -25) return { nivel: 'buena', texto: 'Tu señal está bien' }
  if (n >= -28) return { nivel: 'regular', texto: 'Tu señal está algo baja' }
  return { nivel: 'mala', texto: 'Tu señal está muy baja: conviene una revisión' }
}

/** Las facturas del abonado. Solo las suyas, y nunca las anuladas. */
export async function misFacturas(clienteId) {
  const { data, error } = await db()
    .from('facturas')
    .select('id, numero, concepto, periodo_desde, periodo_hasta, fecha_emision, fecha_vencimiento, total, document_id')
    .eq('client_id', clienteId)
    .eq('anulada', false)
    .order('fecha_emision', { ascending: false })
    .limit(36)

  enBase(error, 'leer tus facturas')

  const ids = (data ?? []).map((f) => f.id)
  if (!ids.length) return []

  // Cuánto se pagó de cada una. Se calcula acá y no se confía en un campo
  // "pagada": el estado de una factura es la suma de sus pagos.
  const { data: pagos } = await db()
    .from('pagos')
    .select('factura_id, monto')
    .in('factura_id', ids)

  const pagado = {}
  for (const p of pagos ?? []) {
    pagado[p.factura_id] = (pagado[p.factura_id] ?? 0) + Number(p.monto || 0)
  }

  const hoy = new Date().toISOString().slice(0, 10)

  return data.map((f) => {
    const abonado = pagado[f.id] ?? 0
    const pendiente = Math.max(0, Number(f.total) - abonado)
    return {
      id: f.id,
      numero: f.numero,
      concepto: f.concepto,
      periodo: f.periodo_desde,
      emision: f.fecha_emision,
      vencimiento: f.fecha_vencimiento,
      total: Number(f.total),
      pagado: abonado,
      pendiente,
      estado: pendiente <= 0.005 ? 'pagada' : f.fecha_vencimiento < hoy ? 'vencida' : 'pendiente',
      tiene_comprobante: Boolean(f.document_id),
    }
  })
}

/** El consumo de los últimos días. */
export async function miConsumo(clienteId, { dias = 30 } = {}) {
  const desde = new Date(Date.now() - dias * 86400_000).toISOString().slice(0, 10)

  const { data, error } = await db()
    .from('consumo_diario')
    .select('fecha, subida_bytes, bajada_bytes')
    .eq('client_id', clienteId)
    .gte('fecha', desde)
    .order('fecha')

  enBase(error, 'leer tu consumo')

  const aGb = (b) => Number((Number(b || 0) / 1024 ** 3).toFixed(2))

  return {
    dias: (data ?? []).map((d) => ({
      fecha: d.fecha,
      subida_gb: aGb(d.subida_bytes),
      bajada_gb: aGb(d.bajada_bytes),
    })),
    total_gb: aGb((data ?? []).reduce((s, d) => s + Number(d.subida_bytes || 0) + Number(d.bajada_bytes || 0), 0)),
  }
}

/** Los reclamos del abonado. */
export async function misTickets(clienteId) {
  const { data, error } = await db()
    .from('tickets')
    .select('id, numero, tipo_incidencia, descripcion, estado, prioridad, fecha_visita, franja, created_at')
    .eq('client_id', clienteId)
    .order('created_at', { ascending: false })
    .limit(20)

  enBase(error, 'leer tus reclamos')
  return data ?? []
}

const INCIDENCIAS = ['sin_internet', 'lento', 'intermitente', 'cambio_clave', 'otro']

/**
 * Un reclamo nuevo, hecho por el abonado.
 *
 * Los datos de contacto y ubicación se copian de su ficha, no se le piden: ya
 * los tenemos, y un formulario largo en el celular es un reclamo que no se
 * hace y termina en una llamada.
 */
export async function abrirTicket(clienteId, { tipo, descripcion } = {}) {
  if (!INCIDENCIAS.includes(tipo)) throw badRequest('Elegí qué te está pasando.')
  if (!String(descripcion ?? '').trim()) {
    throw badRequest('Contanos brevemente qué pasa, para que el técnico vaya preparado.')
  }

  // Solo columnas que existen de verdad en `clientes`. El sector y el cantón
  // viven en el ticket, no en la ficha del abonado: se dejan vacíos y los
  // completa quien atiende, en vez de inventar un JOIN que no aporta.
  const { data: cliente, error } = await db()
    .from('clientes')
    .select('id, nombre, identificacion, telefono, telefono_movil, direccion, latitud, longitud, nap_id, onu_id')
    .eq('id', clienteId)
    .maybeSingle()

  enBase(error, 'leer tu ficha')
  if (!cliente) throw notFound('No encontramos tu cuenta.')

  // Un abonado con un reclamo abierto del mismo tipo no abre otro: duplicar
  // reclamos hace que dos técnicos vayan a la misma casa.
  const { data: abiertos } = await db()
    .from('tickets')
    .select('id, numero')
    .eq('client_id', clienteId)
    .eq('tipo_incidencia', tipo)
    .not('estado', 'in', '(resuelto,cancelado)')
    .limit(1)

  if (abiertos?.length) {
    throw badRequest(`Ya tenés un reclamo abierto por lo mismo: el N° ${abiertos[0].numero}.`, {
      hint: 'Lo estamos atendiendo. Si querés agregar algo, escribinos.',
    })
  }

  const { data: creado, error: errCrear } = await db()
    .from('tickets')
    .insert({
      client_id: cliente.id,
      identificacion: cliente.identificacion,
      nombre: cliente.nombre,
      telefono: cliente.telefono,
      telefono_whatsapp: cliente.telefono_movil,
      direccion: cliente.direccion,
      latitud: cliente.latitud,
      longitud: cliente.longitud,
      // La caja de la que cuelga: es lo primero que mira el técnico al salir.
      nap_id: cliente.nap_id,
      tecnologia: cliente.onu_id ? 'ftth' : 'wireless',
      tipo_incidencia: tipo,
      descripcion: String(descripcion).trim().slice(0, 2000),
      // Sin internet es urgente; lo demás espera. Que lo decida el abonado
      // haría que todo sea alta prioridad en una semana.
      prioridad: tipo === 'sin_internet' ? 'alta' : 'media',
      estado: 'abierto',
    })
    .select('id, numero')
    .single()

  if (errCrear) {
    throw new AppError(`No se pudo registrar tu reclamo: ${errCrear.message}`, { status: 502 })
  }

  return creado
}

/**
 * El abonado corrige sus datos de contacto.
 *
 * Solo teléfono, correo y dirección. El nombre y la cédula NO: van impresos en
 * la factura y el SRI los valida contra el RUC. Dejar que se editen solos sería
 * dejar que alguien se emita facturas a otro nombre.
 */
export async function actualizarContacto(clienteId, datos = {}) {
  const fila = {}
  for (const campo of ['email', 'telefono', 'telefono_movil', 'direccion']) {
    if (campo in datos) fila[campo] = String(datos[campo] ?? '').trim() || null
  }

  if (fila.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fila.email)) {
    throw badRequest('Ese correo no parece válido.')
  }

  // Se le avisa: si cambia el celular y se equivoca, el próximo código de
  // acceso va a otro número y se queda afuera de su propio portal.
  if (!Object.keys(fila).length) return { cambios: 0 }

  const { error } = await db().from('clientes').update(fila).eq('id', clienteId)
  enBase(error, 'guardar tus datos')

  return { cambios: Object.keys(fila).length }
}

/**
 * Lo que el abonado ve de su WiFi.
 *
 * Sale de lo que la ONT reportó la última vez al ACS, no de consultarla ahora:
 * para mostrar el nombre de su red no hace falta despertar el equipo, y hacerlo
 * cada vez que alguien abre la pantalla sería castigarlo por una curiosidad.
 *
 * Nunca se devuelve la clave, solo si hay una puesta. Mostrarla convertiría el
 * portal en una forma de averiguar el WiFi de un vecino sabiendo su cédula.
 */
export async function miWifi(clienteId) {
  const { data: cliente } = await db()
    .from('clientes')
    .select('id, onu_id')
    .eq('id', clienteId)
    .maybeSingle()

  if (!cliente?.onu_id) return { gestionable: false, motivo: 'sin_equipo' }
  if (!hayAcs()) return { gestionable: false, motivo: 'sin_acs' }

  const { data: onu } = await db()
    .from('onus')
    .select('sn, ssid')
    .eq('id', cliente.onu_id)
    .maybeSingle()

  if (!onu?.sn) return { gestionable: false, motivo: 'sin_equipo' }

  let equipo = null
  try {
    equipo = await buscarPorSerie(onu.sn)
  } catch {
    // El ACS no contesta. No es un error del abonado: se cae al modo pedido,
    // que igual funciona.
    return { gestionable: false, motivo: 'acs_no_responde', ssid: onu.ssid }
  }

  // El equipo nunca habló con el ACS. Pasa cuando la ONT no tiene camino de red
  // hasta él, que es justo lo que falta resolver en esta instalación.
  if (!equipo) return { gestionable: false, motivo: 'equipo_desconocido', ssid: onu.ssid }

  const wifi = leerWifi(equipo)
  return {
    gestionable: true,
    ultimo_contacto: wifi?.ultimo_contacto ?? null,
    redes: wifi?.redes ?? [],
  }
}

/**
 * El abonado cambia su clave de WiFi.
 *
 * Se INTENTA aplicar de verdad, contra el equipo, por TR-069. Si sale, se le
 * dice que está hecho. Si no, queda pedido y se le dice eso — nunca al revés.
 *
 * Esa distinción es todo el asunto. Decirle "listo" sin haberlo hecho lo deja
 * sin WiFi: se desconecta para reconectar con la clave nueva y no entra ni con
 * una ni con la otra, en su casa, un domingo.
 *
 * Los tres motivos por los que puede no aplicarse en el momento:
 *
 *   El ACS no tiene camino hasta la ONT. Se arregla con red.
 *   La ONT está apagada. No lo arregla ninguna configuración: el abonado sin
 *     luz no recibe nada, y ahí el pedido tiene que esperar.
 *   El equipo no habla TR-069. Ahí lo hace una persona.
 */
export async function pedirCambioWifi(clienteId, { clave, ssid } = {}) {
  const nueva = String(clave ?? '')

  if (nueva && nueva.length < 8) {
    // No es un capricho: WPA2 no acepta menos de 8, y el equipo rechazaría el
    // cambio después, cuando el abonado ya se olvidó de que lo pidió.
    throw badRequest('La clave del WiFi tiene que tener al menos 8 caracteres.')
  }
  if (nueva.length > 63) throw badRequest('La clave del WiFi no puede pasar de 63 caracteres.')
  if (!nueva && !ssid) throw badRequest('Escribí la clave nueva.')

  const { data: cliente } = await db()
    .from('clientes')
    .select('id, onu_id')
    .eq('id', clienteId)
    .maybeSingle()

  if (!cliente?.onu_id) {
    throw badRequest('Tu equipo no admite el cambio de clave desde acá.', {
      hint: 'Escribinos y lo hacemos nosotros.',
    })
  }

  const nombreRed = ssid ? String(ssid).trim().slice(0, 32) : null

  // --- Primero, el intento de verdad ---
  let aplicado = false
  let motivo = null

  if (hayAcs()) {
    try {
      const { data: onu } = await db()
        .from('onus')
        .select('sn')
        .eq('id', cliente.onu_id)
        .maybeSingle()

      const equipo = onu?.sn ? await buscarPorSerie(onu.sn) : null

      if (equipo) {
        const r = await aplicarEnElEquipo(equipo, { ssid: nombreRed, clave: nueva || null })
        aplicado = r.aplicado
        motivo = r.motivo ?? null
      } else {
        motivo = 'El equipo todavía no se reportó al servidor de gestión.'
      }
    } catch (err) {
      motivo = err.message
    }
  } else {
    motivo = 'No hay servidor TR-069 configurado.'
  }

  // Un pedido pendiente se reemplaza en vez de acumularse: lo que vale es el
  // último, y una cola de cinco claves distintas del mismo abonado solo puede
  // terminar aplicando la equivocada.
  await db()
    .from('portal_solicitudes')
    .update({ estado: 'cancelada' })
    .eq('cliente_id', clienteId)
    .eq('estado', 'pendiente')

  const pedidos = []
  if (nueva) pedidos.push({ tipo: 'clave_wifi', valor: nueva })
  if (nombreRed) pedidos.push({ tipo: 'nombre_wifi', valor: nombreRed })

  // Queda constancia igual cuando se aplicó: es el historial de quién cambió
  // qué, y lo que permite reconstruir por qué un abonado se quedó afuera de su
  // propia red.
  const { error } = await db()
    .from('portal_solicitudes')
    .insert(
      pedidos.map((p) => ({
        cliente_id: clienteId,
        tipo: p.tipo,
        // Cifrada: una clave de WiFi en claro en la base es una clave de WiFi
        // en claro en cada respaldo que se haga de ahora en adelante.
        valor_encrypted: encrypt(p.valor),
        estado: aplicado ? 'aplicada' : 'pendiente',
        ultimo_error: aplicado ? null : motivo,
        aplicada_en: aplicado ? new Date().toISOString() : null,
      })),
    )

  enBase(error, 'registrar tu pedido')

  // El SSID que sabemos de la ONT se actualiza solo si de verdad se aplicó.
  if (aplicado && nombreRed) {
    await db().from('onus').update({ ssid: nombreRed }).eq('id', cliente.onu_id)
  }

  return aplicado
    ? {
        estado: 'aplicada',
        mensaje:
          'Listo, ya está cambiada. Tus dispositivos te van a pedir la clave nueva al reconectarse.',
      }
    : {
        estado: 'pendiente',
        mensaje:
          'Anotamos el cambio. Se aplica cuando tu equipo esté disponible; hasta entonces seguí usando la clave actual.',
      }
}

/** En qué quedó lo último que pidió. */
export async function miSolicitudWifi(clienteId) {
  const { data } = await db()
    .from('portal_solicitudes')
    .select('tipo, estado, ultimo_error, creada_en, aplicada_en')
    .eq('cliente_id', clienteId)
    .order('creada_en', { ascending: false })
    .limit(4)

  return data ?? []
}
