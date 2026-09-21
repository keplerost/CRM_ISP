import { db } from '../lib/db.js'
import { crearTransporte, remitente, faltantesSmtp } from '../sri/email.js'
import { decrypt } from '../lib/crypto.js'
import { credenciales } from './configMensajeria.js'
import * as meta from '../drivers/whatsapp/meta.js'
import * as crm from '../drivers/whatsapp/crm.js'
import { plantillaAprobadaDe } from './plantillasWhatsapp.js'
import { ventanaAbierta } from './ventanaWhatsapp.js'

/**
 * Envío de mensajes por los cuatro canales.
 *
 * Cada canal tiene una honestidad distinta sobre lo que puede prometer, y el
 * módulo la respeta en vez de aparentar que son todos iguales:
 *
 *   email     Sale de verdad por el servidor de correo del sistema. El
 *             SMTP confirma que lo aceptó, no que lo leyeron.
 *   telegram  Sale de verdad por la API del bot, que además confirma la
 *             entrega. Necesita que el abonado le haya escrito primero.
 *   whatsapp  Depende de lo que haya: con la API de Meta o de Twilio sale solo
 *             y hay acuse; sin proveedor, se prepara el enlace para que una
 *             persona lo mande, y el estado dice justamente eso.
 *   sms       Igual que WhatsApp: sin proveedor no hay envío, y se dice.
 *
 * Marcar como "entregado" algo que solo se abrió en una pestaña sería mentirle
 * al que después reclama que nunca le avisaron.
 */

/** Reemplaza {{marcador}} por su valor. Lo que no se conoce queda como está. */
export function aplicarPlantilla(texto, datos = {}) {
  return String(texto ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (original, clave) =>
    datos[clave] != null ? String(datos[clave]) : original,
  )
}

/** Los datos del abonado que puede usar cualquier plantilla. */
export function variablesDe(cliente = {}, extra = {}) {
  const dinero = (n) => `$${(Number(n) || 0).toFixed(2)}`
  return {
    nombre: cliente.nombre ?? '',
    primer_nombre: String(cliente.nombre ?? '').split(' ')[0],
    identificacion: cliente.identificacion ?? '',
    saldo: dinero(cliente.saldo),
    plan: cliente.plan ?? '',
    ip: cliente.ip ?? '',
    fecha: new Date().toLocaleDateString('es-EC'),
    ...extra,
  }
}

/** Un número ecuatoriano en formato internacional, sin el cero inicial. */
export function aInternacional(telefono) {
  const limpio = String(telefono ?? '').replace(/\D/g, '')
  if (!limpio) return null
  if (limpio.startsWith('593')) return limpio
  return `593${limpio.replace(/^0+/, '')}`
}

// --- Canales ----------------------------------------------------------------

async function porEmail({ config, destino, asunto, cuerpo, html = null, adjuntos = [] }) {
  const faltan = faltantesSmtp(config)
  if (faltan.length) {
    throw new Error(`Falta configurar ${faltan.join(', ')} en Facturación → Correo`)
  }
  if (!destino) throw new Error('El abonado no tiene correo cargado')

  const password = decrypt(config.smtp_pass_encrypted)
  const transporte = crearTransporte(config, password)

  const info = await transporte.sendMail({
    from: remitente(config),
    to: destino,
    subject: asunto || 'Mensaje de su proveedor de internet',
    text: cuerpo,
    /**
     * El HTML con formato si lo hay; si no, el mismo texto envuelto.
     *
     * Nunca solo HTML: hay clientes que muestran el texto plano, y los filtros
     * de spam desconfían de un correo que no lo trae.
     */
    html: html
      || `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${
        String(cuerpo).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])
      }</div>`,
    ...(adjuntos?.length ? { attachments: adjuntos } : {}),
  })

  return { estado: 'enviado', proveedor_id: info.messageId, entregado: false }
}

/**
 * Telegram, por la API del bot.
 *
 * El bot no puede iniciar una conversación: el abonado tiene que escribirle
 * primero. Por eso el error explica qué hacer en vez de decir "chat not found".
 */
async function porTelegram({ destino, cuerpo }) {
  const { telegram } = await credenciales()
  const token = telegram.token
  if (!token) throw new Error('Falta el token del bot de Telegram en Ajustes → Mensajería')
  if (!destino) {
    throw new Error(
      'El abonado no tiene chat de Telegram. Pedile que le escriba /start al bot y cargá el chat_id en su ficha.',
    )
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: destino, text: cuerpo }),
  })

  const json = await res.json()
  if (!json.ok) throw new Error(json.description || 'Telegram rechazó el mensaje')

  // Telegram confirma que lo entregó al dispositivo, no que lo leyeron.
  return { estado: 'entregado', proveedor_id: String(json.result?.message_id ?? ''), entregado: true }
}

/**
 * WhatsApp.
 *
 * Con la API de Meta configurada sale solo. Sin ella se devuelve el enlace
 * `wa.me` para que una persona lo mande, y el mensaje queda como "pendiente":
 * es la verdad, nadie lo envió todavía.
 */
/**
 * WhatsApp.
 *
 * ── La regla de la ventana de 24 horas ──
 *
 * La API oficial —Meta y Twilio— solo acepta texto libre dentro de las 24 horas
 * siguientes al último mensaje que escribió el ABONADO. Nuestros avisos
 * automáticos van siempre al revés: nadie le escribe al ISP para que le avisen
 * que se le vence la factura.
 *
 * Entonces, cuando el mensaje es automático y la vía es oficial, hace falta una
 * plantilla aprobada. Si no la hay, esto NO intenta igual: devuelve `pendiente`
 * con el motivo, y quien llama se cae al canal siguiente —SMS, correo— que sí
 * va a llegar. Intentarlo devolvería el error 131047 de Meta, el abonado no
 * recibiría nada, y el sistema contaría el intento como si WhatsApp hubiera
 * sido el canal utilizable.
 *
 * Un mensaje que escribe una persona desde Comunicaciones sí puede ir como
 * texto: ahí casi siempre se está contestando, o sea adentro de la ventana.
 */
async function porWhatsapp({ destino, cuerpo, plantilla = null, automatico = false }) {
  const numero = aInternacional(destino)
  if (!numero) throw new Error('El abonado no tiene celular cargado')

  const { whatsapp, twilio } = await credenciales()

  /**
   * El CRM externo entrega por su propio número.
   *
   * Va antes que todo lo demás porque no comparte nada con las otras vías: no
   * usa nuestras plantillas de Meta ni nuestro token, solo necesita saber cómo
   * se llama el aviso del lado de ellos.
   */
  if (whatsapp.via === 'crm') {
    if (automatico && !plantilla?.crm?.purpose) {
      throw new Error(
        `Este aviso no tiene nombre del lado de ${whatsapp.crm.nombre || 'el CRM'}. ` +
          'Cargalo en Ajustes → Plantillas de WhatsApp. Mientras tanto sale por otro canal.',
      )
    }

    const r = await crm.enviar({
      config: whatsapp.crm,
      numero,
      texto: cuerpo,
      plantilla: plantilla?.crm ?? null,
    })

    if (!r.ok) throw new Error(r.error || 'El CRM rechazó el mensaje')
    return { estado: 'enviado', proveedor_id: r.id ?? null }
  }

  const viaOficial = whatsapp.via === 'meta' || whatsapp.via === 'twilio'

  /**
   * La ventana de 24 horas, cuando no hay plantilla.
   *
   * ── El orden importa ──
   *
   * Si hay plantilla aprobada se usa esa, siempre: funciona dentro y fuera de la
   * ventana, y es lo que Meta espera de un aviso que inicia la empresa.
   *
   * La ventana es el plan B, y solo sirve si el abonado escribió en las últimas
   * 24 horas. Cubre el caso que antes se perdía: alguien escribe pidiendo ayuda,
   * el sistema le manda algo automático —el acuse de su pago, el aviso de que su
   * avería se resolvió— y no había plantilla todavía. Ahí sale como texto, que
   * es exactamente lo que WhatsApp permite en ese momento.
   */
  const hayVentana =
    automatico && viaOficial && (!plantilla || plantilla.bloqueada)
      ? await ventanaAbierta(destino).catch(() => false)
      : false

  /**
   * Sin plantilla aprobada, este aviso no puede salir por acá.
   *
   * ── Por qué LANZA en vez de devolver `pendiente` ──
   *
   * Porque `pendiente` significa otra cosa en este sistema: "quedó escrito y una
   * persona lo manda desde WhatsApp". Eso vale para la vía manual, que además
   * devuelve el enlace. Acá no hay nada preparado para nadie.
   *
   * Y la diferencia se paga: quien llama trata `pendiente` como canal utilizable
   * y cierra el aviso, así que si el correo también fallaba, el abonado no
   * recibía nada y la cola quedaba marcada como atendida.
   *
   * Lanzando, queda una comunicación fallida con el motivo escrito —que es la
   * verdad— y el recorrido sigue con el canal siguiente, que sí va a llegar.
   */
  if (automatico && viaOficial && (!plantilla || plantilla.bloqueada) && !hayVentana) {
    throw new Error(motivoSinPlantilla(plantilla))
  }

  // Twilio revende la misma API de WhatsApp por otra vía. Se respeta lo que se
  // eligió en la pantalla en vez de adivinar por qué campos están llenos: quien
  // probó los dos y dejó datos viejos no entendería por qué sale por donde sale.
  if (whatsapp.via === 'twilio') {
    return porTwilio({
      numero: `whatsapp:+${numero}`,
      desde: whatsapp.desde ? `whatsapp:${whatsapp.desde}` : null,
      cuerpo,
      twilio,
      queFalta: 'WhatsApp por Twilio',
      // Twilio no usa el nombre de la plantilla de Meta: usa un ContentSid
      // propio, creado en su panel sobre el mismo texto aprobado.
      plantilla: plantilla?.sid_twilio ? plantilla : null,
    })
  }

  const token = whatsapp.token
  const phoneId = whatsapp.phoneId

  if (whatsapp.via === 'manual' || !token || !phoneId) {
    return {
      estado: 'pendiente',
      manual: true,
      enlace: `https://wa.me/${numero}?text=${encodeURIComponent(cuerpo)}`,
      aviso:
        'Sin proveedor configurado: el mensaje queda preparado para enviarlo a mano desde WhatsApp.',
    }
  }

  // El driver oficial sabe armar los dos cuerpos —texto y plantilla— y traducir
  // los errores de Meta a algo accionable. Tenerlo en un solo lugar evita que se
  // arreglen del lado del driver y queden mal acá.
  const r = await meta.enviar({
    config: { token, phoneId },
    numero,
    texto: cuerpo,
    plantilla: plantilla?.bloqueada ? null : plantilla,
  })

  if (!r.ok) throw new Error(r.error || 'WhatsApp rechazó el mensaje')

  // El acuse real llega después por webhook: acá solo se sabe que lo aceptaron.
  return { estado: 'enviado', proveedor_id: r.id ?? null }
}

/** Por qué este aviso no puede salir por WhatsApp, dicho para poder actuar. */
function motivoSinPlantilla(plantilla) {
  if (!plantilla) {
    return 'Este aviso no tiene plantilla de WhatsApp registrada. Fuera de la ventana de 24 h, Meta solo entrega plantillas aprobadas: cargala en Ajustes → Plantillas de WhatsApp. Mientras tanto sale por otro canal.'
  }
  if (plantilla.falta) {
    return `La plantilla "${plantilla.nombre}" necesita el valor de {{${plantilla.falta}}} y llegó vacío. Sin eso Meta rechaza el envío entero.`
  }
  const comoEsta = {
    borrador: 'todavía no se registró en Meta',
    enviada: 'está en revisión de Meta',
    rechazada: 'Meta la rechazó',
    pausada: 'Meta la pausó por calificación de calidad',
  }[plantilla.estado] ?? `está en estado "${plantilla.estado}"`

  return `La plantilla "${plantilla.nombre}" ${comoEsta}, así que este aviso no puede salir por WhatsApp. Mientras tanto sale por otro canal.`
}

/**
 * El envío por Twilio, que sirve para SMS y para WhatsApp.
 *
 * Es la misma llamada con otro prefijo en los números: `whatsapp:+593…` para
 * WhatsApp, `+593…` pelado para SMS. Tenerlo una sola vez evita que se
 * arreglen errores en uno y queden en el otro.
 */
async function porTwilio({ numero, desde, cuerpo, twilio, queFalta, plantilla = null }) {
  if (!twilio.sid || !twilio.token || !desde) {
    throw new Error(`No hay proveedor configurado para ${queFalta}. Cargalo en Ajustes → Mensajería.`)
  }

  /**
   * Con plantilla, Twilio no manda `Body`: manda el ContentSid y sus variables.
   *
   * Y las numera desde 1, igual que Meta, pero en un objeto JSON en vez de un
   * arreglo. Es la misma plantilla aprobada, con otro identificador y otra forma
   * de pasarle los valores.
   */
  const campos = plantilla?.sid_twilio
    ? {
        To: numero,
        From: desde,
        ContentSid: plantilla.sid_twilio,
        ContentVariables: JSON.stringify(
          Object.fromEntries((plantilla.parametros ?? []).map((v, i) => [String(i + 1), String(v)])),
        ),
      }
    : { To: numero, From: desde, Body: cuerpo }

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilio.sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${twilio.sid}:${twilio.token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(campos),
  })

  const json = await res.json()
  if (json.error_message || res.status >= 400) {
    throw new Error(json.error_message || `El proveedor devolvió ${res.status}`)
  }

  return { estado: 'enviado', proveedor_id: json.sid ?? null }
}

async function porSms({ destino, cuerpo }) {
  const { twilio } = await credenciales()

  const numero = aInternacional(destino)
  if (!numero) throw new Error('El abonado no tiene celular cargado')

  return porTwilio({
    numero: `+${numero}`,
    desde: twilio.desde,
    cuerpo,
    twilio,
    queFalta: 'SMS',
  })
}

const CANALES = { email: porEmail, telegram: porTelegram, whatsapp: porWhatsapp, sms: porSms }

/**
 * Manda un mensaje a alguien que no es un abonado.
 *
 * `enviar` está atado a la ficha de un cliente: busca sus datos, aplica sus
 * variables y deja la fila en `comunicaciones`. Eso está bien para hablarle a
 * un abonado, pero una alerta de red va a un técnico, y un técnico no tiene
 * ficha de cliente ni historial de comunicaciones que ensuciar con avisos de
 * equipos.
 *
 * Acá el mensaje sale por el mismo canal y con la misma honestidad sobre lo
 * que se pudo prometer, pero quien llama decide dónde queda registrado.
 */
export async function enviarCrudo({
  canal,
  destino,
  asunto = null,
  cuerpo,
  /**
   * El correo con formato y sus adjuntos.
   *
   * ── Por qué esto estaba faltando ──
   *
   * Esta función se escribió para las alertas de red, que son texto suelto a un
   * técnico. Cuando después se le pasó un correo con formato, `html` y
   * `adjuntos` se descartaban en silencio: el mensaje salía igual, pero en texto
   * plano y sin el PDF.
   *
   * No fallaba nada. Solo llegaba un correo peor que el que se había armado, y
   * eso únicamente se ve abriendo la casilla.
   */
  html = null,
  adjuntos = [],
}) {
  const enviarPor = CANALES[canal]
  if (!enviarPor) throw new Error(`Canal desconocido: ${canal}`)
  if (!destino) throw new Error(`Falta a dónde mandar el mensaje por ${canal}`)

  const { data: config } = await db().from('sri_config').select('*').limit(1).maybeSingle()
  return enviarPor({ config: config ?? {}, destino, asunto, cuerpo, html, adjuntos })
}

/** A qué dirección o número va cada canal, según la ficha del abonado. */
export function destinoDe(canal, cliente = {}) {
  if (canal === 'email') return cliente.email ?? null
  if (canal === 'telegram') return cliente.telegram_chat_id ?? null
  return cliente.telefono_movil || cliente.telefono || null
}

/**
 * ¿El mensaje LLEGÓ, o solo quedó preparado?
 *
 * ── El error que esto viene a impedir ──
 *
 * `enviar` no lanza cuando WhatsApp está en modo manual: devuelve la fila con
 * estado `pendiente` y el enlace de wa.me para que alguien lo mande a mano. Eso
 * está bien —es el modo de trabajo del ISP que todavía no tiene proveedor— pero
 * NO es una entrega.
 *
 * Los tres avisadores del sistema recorren los canales "hasta el primero que
 * funcione", y los tres tomaban ese `pendiente` como éxito y cortaban ahí. Con
 * WhatsApp como canal preferido y sin proveedor configurado, el resultado era el
 * peor posible: el sistema informaba "enviado por whatsapp", el correo no se
 * mandaba nunca, y al abonado no le llegaba nada.
 *
 * Se vio en una corrida de facturación de verdad: tres facturas creadas, las tres
 * con `aviso: whatsapp`, y ni un correo en la casilla.
 */
export function seEntrego(resultado) {
  if (!resultado) return false
  // `fallido` tampoco entregó, pero ese camino ya lanza y no llega hasta acá.
  return resultado.estado !== 'pendiente' && resultado.estado !== 'fallido'
}

/**
 * Manda un mensaje y lo deja escrito.
 *
 * El registro se guarda pase lo que pase: un envío que falló también es parte
 * del historial —es la diferencia entre "no le avisamos" y "no se pudo"—.
 */
export async function enviar({
  client_id,
  canal,
  cuerpo,
  asunto = null,
  destino = null,
  plantilla_id = null,
  ticket_id = null,
  factura_id = null,
  automatico = false,
  created_by = null,
  /**
   * Lo que la plantilla necesita y no está en la ficha.
   *
   * `variablesDe` trae lo del abonado —su nombre, su saldo, su plan—, que es lo
   * que sirve para casi todo. Pero un aviso de pago tiene que decir CUÁNTO se
   * recibió, y ese monto no vive en la ficha: vive en el pago que acaba de
   * ocurrir. Sin esta puerta, la plantilla mostraría "{{monto}}" tal cual.
   */
  variables = {},

  /**
   * El correo con formato, cuando lo hay.
   *
   * ── Por qué convive con `cuerpo` en vez de reemplazarlo ──
   *
   * Porque `cuerpo` es el mismo mensaje para los cuatro canales, y por SMS o
   * Telegram no se puede mandar HTML. El correo usa `html` si viene, y el resto
   * sigue usando el texto — que además es lo que queda escrito en el historial,
   * donde nadie quiere leer etiquetas.
   */
  html = null,
  adjuntos = [],
}) {
  const enviarPor = CANALES[canal]
  if (!enviarPor) throw new Error(`Canal desconocido: ${canal}`)

  const { data: cliente } = await db()
    .from('v_clientes_ficha')
    .select('id, nombre, identificacion, email, telefono, telefono_movil, telegram_chat_id, saldo, plan, ip')
    .eq('id', client_id)
    .maybeSingle()

  if (!cliente) throw new Error('No existe ese cliente')

  const aDonde = destino || destinoDe(canal, cliente)

  /**
   * La ficha de la empresa se lee ANTES de armar el texto.
   *
   * Muchas plantillas empiezan con "{{empresa}}: ..." —es lo que hace que un SMS
   * se entienda sin remitente— y ese dato no está en el abonado. Antes se leía
   * después de aplicar la plantilla, así que el marcador salía crudo: el abonado
   * recibía "{{empresa}}: recibimos su pago".
   */
  const { data: config } = await db().from('sri_config').select('*').limit(1).maybeSingle()

  const datos = variablesDe(cliente, {
    empresa: config?.nombre_comercial || config?.razon_social || '',
    ruc: config?.ruc ?? '',
    telefono: config?.telefono ?? '',
    // Lo que manda quien llama pisa a lo de la empresa: un aviso puede querer
    // dar otro número de contacto que el general.
    ...variables,
  })

  const texto = aplicarPlantilla(cuerpo, datos)
  const titulo = asunto ? aplicarPlantilla(asunto, datos) : null

  /**
   * La plantilla aprobada de WhatsApp, si este mensaje tiene una.
   *
   * Se resuelve acá y no adentro del canal porque necesita las variables YA
   * resueltas: Meta recibe los valores en orden —`{{1}}`, `{{2}}`— y eso solo
   * se puede armar después de aplicar la plantilla interna.
   *
   * Devuelve `{ bloqueada: true, ... }` cuando existe pero no está aprobada o
   * le falta un valor. `porWhatsapp` lo usa para NO intentar el envío y dejar
   * que el aviso se caiga al canal siguiente, que sí va a llegar.
   */
  const plantillaWa =
    canal === 'whatsapp' ? await plantillaAprobadaDe(plantilla_id, datos).catch(() => null) : null

  let resultado
  let error = null

  try {
    resultado = await enviarPor({
      config: config ?? {},
      destino: aDonde,
      asunto: titulo,
      cuerpo: texto,
      // Solo los usa WhatsApp; el resto de los canales los ignora, igual que
      // ignoran `html` y `adjuntos`.
      plantilla: plantillaWa,
      automatico,
      // Los canales que no son correo los ignoran: su firma solo declara lo
      // que usan.
      html: html ? aplicarPlantilla(html, datos) : null,
      adjuntos,
    })
  } catch (err) {
    error = err.message
    resultado = { estado: 'fallido' }
  }

  const { data: fila } = await db()
    .from('comunicaciones')
    .insert({
      client_id,
      ticket_id,
      factura_id,
      canal,
      direccion: 'saliente',
      destino: aDonde,
      asunto: titulo,
      cuerpo: texto,
      plantilla_id,
      automatico,
      estado: resultado.estado,
      proveedor_id: resultado.proveedor_id ?? null,
      error,
      enviado_at: resultado.estado === 'fallido' || resultado.manual ? null : new Date().toISOString(),
      entregado_at: resultado.entregado ? new Date().toISOString() : null,
      created_by,
    })
    .select()
    .single()

  if (error) {
    const err = new Error(error)
    err.comunicacion = fila
    throw err
  }

  return { ...fila, enlace: resultado.enlace ?? null, aviso: resultado.aviso ?? null }
}

/** Qué canales pueden usarse hoy, con el motivo cuando no. */
export async function canalesDisponibles() {
  const { telegram, whatsapp, twilio } = await credenciales()
  const twilioListo = Boolean(twilio.sid && twilio.token && twilio.desde)

  return {
    email: {
      listo: true,
      nota: 'Usa el servidor de correo del sistema (Ajustes → Servidor de correo)',
    },
    telegram: {
      listo: Boolean(telegram.token),
      nota: telegram.token
        ? 'Bot configurado. El abonado tiene que escribirle primero'
        : 'Falta el token del bot',
    },
    whatsapp: whatsappDisponible(whatsapp, twilioListo),
    sms: {
      listo: twilioListo,
      nota: twilioListo ? 'Twilio configurado' : 'Falta configurar el proveedor de SMS',
    },
  }
}

/**
 * WhatsApp tiene tres estados y no dos.
 *
 * "Manual" no es una falla: el mensaje se prepara y lo manda una persona, que
 * para un ISP chico alcanza. Marcarlo como error empujaría a contratar un
 * proveedor que quizás no necesita.
 */
function whatsappDisponible(whatsapp, twilioListo) {
  if (whatsapp.via === 'meta') {
    const listo = Boolean(whatsapp.token && whatsapp.phoneId)
    return {
      listo,
      manual: false,
      nota: listo ? 'API de Meta configurada' : 'Falta el token o el ID del teléfono de Meta',
    }
  }

  if (whatsapp.via === 'twilio') {
    const listo = twilioListo && Boolean(whatsapp.desde)
    return {
      listo,
      manual: false,
      nota: listo ? 'Por Twilio' : 'Falta completar Twilio o el número emisor de WhatsApp',
    }
  }

  return {
    listo: false,
    manual: true,
    nota: 'Envío manual: el mensaje se prepara y lo manda una persona',
  }
}

