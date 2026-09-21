import { AppError } from '../lib/errors.js'

/**
 * Cliente de los servicios web del SRI (Ecuador).
 *
 * El proceso es asíncrono y en dos pasos, y conviene entenderlo porque los
 * errores de cada uno significan cosas distintas:
 *
 *   1. recepcionComprobantes  → se entrega el XML firmado.
 *      Responde RECIBIDA (lo aceptó para procesar) o DEVUELTA (lo rechazó de
 *      entrada: estructura, firma o clave duplicada).
 *
 *   2. autorizacionComprobante → se consulta por la clave de acceso.
 *      Responde AUTORIZADO o NO AUTORIZADO. Puede tardar unos segundos en
 *      estar listo, así que una consulta inmediata puede devolver vacío sin
 *      que eso signifique que algo salió mal.
 */

const ENDPOINTS = {
  // Certificación: comprobantes sin validez tributaria.
  1: {
    recepcion: 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
    autorizacion:
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
    nombre: 'pruebas',
  },
  2: {
    recepcion: 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
    autorizacion:
      'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
    nombre: 'producción',
  },
}

const TIMEOUT_MS = 30000

export const endpointsDe = (ambiente) => ENDPOINTS[String(ambiente)] ?? ENDPOINTS['1']

/** Contenido de la primera etiqueta con ese nombre, ignorando el prefijo. */
function sacar(xml, etiqueta) {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${etiqueta}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${etiqueta}>`))
  return m ? m[1].trim() : null
}

/** Todos los bloques de una etiqueta repetida. */
function sacarTodos(xml, etiqueta) {
  const re = new RegExp(`<(?:\\w+:)?${etiqueta}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${etiqueta}>`, 'g')
  return [...xml.matchAll(re)].map((m) => m[1])
}

const quitarCdata = (t) =>
  t == null ? null : t.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim()

/**
 * Desenvuelve el comprobante autorizado que devuelve el SRI.
 *
 * Viene de dos formas según el servicio y el momento: dentro de un CDATA, o con
 * las etiquetas escapadas —`&lt;factura&gt;…`—. Guardarlo tal como llega deja un
 * archivo que no es XML: el comprador no puede procesarlo con su contador ni
 * con otro sistema, y de paso el RIDE no encuentra los campos adicionales.
 *
 * Es idempotente: un XML que ya está bien pasa sin tocarse, así que también
 * sirve para leer lo que se guardó mal antes.
 */
export function desenvolverComprobante(texto) {
  const limpio = quitarCdata(texto)
  if (!limpio || !limpio.includes('&lt;')) return limpio

  return limpio
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // El & va último: si no, desharía los escapes que acaba de resolver.
    .replace(/&amp;/g, '&')
}

// El SRI anida <mensaje> dentro de <mensaje>: el de afuera es el contenedor y
// el de adentro lleva el texto. Una expresión no ambiciosa cierra en la etiqueta
// interna y se pierde justo el motivo del rechazo. Se resuelve renombrando
// primero los <mensaje> HOJA —los que no contienen otras etiquetas— y recién
// después separando los contenedores.
const MENSAJE_HOJA = /<(?:\w+:)?mensaje>((?:<!\[CDATA\[[\s\S]*?\]\]>)|[^<]*)<\/(?:\w+:)?mensaje>/g

/**
 * Mensajes de error o advertencia del SRI.
 * Son lo único que explica un rechazo, así que se conservan enteros.
 */
function parsearMensajes(xml) {
  const contenedores = sacarTodos(xml, 'mensajes').join('')
  if (!contenedores.trim()) return []

  const renombrado = contenedores.replace(
    MENSAJE_HOJA,
    (_, texto) => `<textoMensaje>${texto}</textoMensaje>`,
  )

  return sacarTodos(renombrado, 'mensaje')
    .filter((b) => /<(?:\w+:)?identificador|<(?:\w+:)?tipo|<textoMensaje/.test(b))
    .map((b) => ({
      identificador: sacar(b, 'identificador'),
      mensaje: quitarCdata(sacar(b, 'textoMensaje')),
      informacionAdicional: quitarCdata(sacar(b, 'informacionAdicional')),
      tipo: sacar(b, 'tipo'),
    }))
}

async function llamarSoap(url, sobre, accion) {
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '',
      },
      body: sobre,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    const esTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    throw new AppError(
      esTimeout
        ? `El SRI no respondió en ${TIMEOUT_MS / 1000} segundos (${accion})`
        : `No se pudo contactar al SRI: ${err?.message ?? err}`,
      {
        status: 504,
        hint: 'Los servicios del SRI se caen con cierta frecuencia. Reintentá en unos minutos; el comprobante ya emitido sigue siendo válido.',
      },
    )
  }

  const texto = await res.text()

  if (!res.ok) {
    // Un fault de SOAP trae el motivo en faultstring.
    const fault = sacar(texto, 'faultstring')
    throw new AppError(`El SRI respondió con error en ${accion}: ${fault ?? `HTTP ${res.status}`}`, {
      status: 502,
      detalle: texto.slice(0, 500),
    })
  }

  return texto
}

/**
 * Paso 1: entregar el comprobante firmado.
 *
 * DEVUELTA no es un error de comunicación: el SRI recibió el XML y lo rechazó.
 * Por eso se devuelve como resultado normal, con sus mensajes, en vez de lanzar.
 */
export async function enviarComprobante(xmlFirmado, ambiente = '1') {
  if (!xmlFirmado) throw new AppError('No hay XML firmado para enviar', { status: 400 })

  const { recepcion, nombre } = endpointsDe(ambiente)
  const b64 = Buffer.from(xmlFirmado, 'utf8').toString('base64')

  const sobre =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.recepcion">' +
    '<soapenv:Header/>' +
    '<soapenv:Body>' +
    '<ec:validarComprobante>' +
    `<xml>${b64}</xml>` +
    '</ec:validarComprobante>' +
    '</soapenv:Body>' +
    '</soapenv:Envelope>'

  const respuesta = await llamarSoap(recepcion, sobre, 'recepción')
  const estado = sacar(respuesta, 'estado')
  const mensajes = parsearMensajes(respuesta)

  return {
    ambiente: nombre,
    estado: estado ?? 'DESCONOCIDO',
    recibida: estado === 'RECIBIDA',
    mensajes,
    // Solo se guarda el crudo cuando algo falla: no vale la pena si salió bien.
    respuestaCruda: estado === 'RECIBIDA' ? null : respuesta.slice(0, 4000),
  }
}

/**
 * Paso 2: consultar si ya fue autorizado.
 *
 * Que devuelva 0 comprobantes recién enviado el XML es normal: el SRI todavía
 * lo está procesando. No significa que se haya perdido.
 */
export async function consultarAutorizacion(claveAcceso, ambiente = '1') {
  if (!/^\d{49}$/.test(claveAcceso ?? '')) {
    throw new AppError('La clave de acceso debe tener 49 dígitos', { status: 400 })
  }

  const { autorizacion, nombre } = endpointsDe(ambiente)

  const sobre =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion">' +
    '<soapenv:Header/>' +
    '<soapenv:Body>' +
    '<ec:autorizacionComprobante>' +
    `<claveAccesoComprobante>${claveAcceso}</claveAccesoComprobante>` +
    '</ec:autorizacionComprobante>' +
    '</soapenv:Body>' +
    '</soapenv:Envelope>'

  const respuesta = await llamarSoap(autorizacion, sobre, 'autorización')

  const numero = Number(sacar(respuesta, 'numeroComprobantes') ?? 0)
  const bloques = sacarTodos(sacarTodos(respuesta, 'autorizaciones').join(''), 'autorizacion')

  if (!bloques.length) {
    return {
      ambiente: nombre,
      estado: 'EN_PROCESO',
      numeroComprobantes: numero,
      mensajes: [],
      pendiente: true,
      aviso: 'El SRI todavía no devolvió la autorización. Suele tardar unos segundos; volvé a consultar.',
    }
  }

  const a = bloques[0]
  const estado = sacar(a, 'estado')

  return {
    ambiente: nombre,
    estado: estado ?? 'DESCONOCIDO',
    autorizado: estado === 'AUTORIZADO',
    pendiente: false,
    numeroAutorizacion: sacar(a, 'numeroAutorizacion'),
    fechaAutorizacion: sacar(a, 'fechaAutorizacion'),
    numeroComprobantes: numero,
    // El XML autorizado es el que hay que entregarle al comprador y conservar.
    comprobante: desenvolverComprobante(sacar(a, 'comprobante')),
    mensajes: parsearMensajes(a),
    respuestaCruda: estado === 'AUTORIZADO' ? null : respuesta.slice(0, 4000),
  }
}

/** Un resumen legible de los mensajes, para mostrar en la interfaz. */
export function resumirMensajes(mensajes = []) {
  if (!mensajes.length) return null
  return mensajes
    .map((m) => {
      const partes = [m.identificador ? `[${m.identificador}]` : null, m.mensaje]
      if (m.informacionAdicional) partes.push(`— ${m.informacionAdicional}`)
      return partes.filter(Boolean).join(' ')
    })
    .join(' · ')
}
