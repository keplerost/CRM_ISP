import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { config } from '../config.js'
import { db } from './db.js'
import { AppError } from './errors.js'

/**
 * Las llaves de API de los sistemas externos.
 *
 * Quién entra por acá: el CRM, el bot de WhatsApp, el webhook de la pasarela.
 * No son personas y por eso no pueden usar `requireAuth`, que valida la sesión
 * de Supabase de alguien del personal. Un bot con el usuario de un empleado
 * deja cada cosa que hace firmada por un humano que no la hizo — y el día que
 * ese empleado renuncia, el bot deja de funcionar.
 *
 * ── La llave no se guarda ──
 *
 * Se guarda su huella HMAC-SHA256 calculada con `CREDENTIALS_KEY`, la misma
 * regla que las sesiones del portal del abonado. Quien se lleve un volcado de
 * la base no se lleva las llaves: para probar candidatas contra la huella
 * necesita además el .env del servidor.
 *
 * El precio de esto es el que corresponde: la llave se muestra UNA vez, al
 * crearla. Si se pierde, no se recupera — se revoca y se emite otra.
 */

/** El prefijo que llevan todas. Sirve para reconocerlas de un vistazo en un log. */
const PREFIJO = 'sk_'

/** Cuántos caracteres del comienzo se guardan en claro para poder identificarla. */
const LARGO_PREFIJO = 12

const huellaDe = (valor) =>
  createHmac('sha256', config.credentialsKey || 'sin-llave').update(String(valor)).digest('hex')

/** Comparación en tiempo constante. Dos huellas hex siempre miden lo mismo. */
function igual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8')
  const y = Buffer.from(String(b ?? ''), 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Emite una llave nueva.
 *
 * Devuelve el texto en claro —que el llamador tiene que mostrar y olvidar— y la
 * huella con su prefijo, que es lo único que va a la base.
 */
export function generarLlave() {
  const llave = `${PREFIJO}${randomBytes(32).toString('base64url')}`
  return {
    llave,
    prefijo: llave.slice(0, LARGO_PREFIJO),
    huella: huellaDe(llave),
  }
}

/** Saca la llave del pedido. Se aceptan las dos formas que usa todo el mundo. */
function llaveDe(req) {
  const header = req.headers['x-api-key']
  if (header) return String(header).trim()

  const auth = req.headers.authorization || ''
  if (/^Bearer\s+/i.test(auth)) {
    const valor = auth.replace(/^Bearer\s+/i, '').trim()
    // Solo si parece una llave nuestra: el header Authorization también lo usa
    // el personal con su token de Supabase, y confundirlos haría que un token
    // vencido se lea como "llave inválida" y mande a buscar el problema al
    // proveedor del CRM.
    if (valor.startsWith(PREFIJO)) return valor
  }
  return null
}

/**
 * La IP desde la que llegó el pedido.
 *
 * Detrás de un proxy —y esto va a estar detrás de uno— `req.ip` es la del
 * proxy. Se mira primero `X-Forwarded-For`, que es lo que el proxy escribe.
 *
 * Ojo con esto: ese header lo puede FALSIFICAR quien llama si el pedido no pasa
 * realmente por un proxy de confianza. Por eso la lista de IPs permitidas es
 * una capa más y no la única: lo que autoriza es la llave.
 */
function ipDe(req) {
  const fwd = req.headers['x-forwarded-for']
  const primera = fwd ? String(fwd).split(',')[0].trim() : null
  const ip = primera || req.ip || req.socket?.remoteAddress || ''
  // ::ffff:1.2.3.4 → 1.2.3.4. Sin esto, una lista cargada con IPv4 nunca
  // coincide y la integración queda muerta sin decir por qué.
  return ip.replace(/^::ffff:/, '')
}

/**
 * Anota la llamada.
 *
 * Se hace sin `await` desde el middleware y con los errores tragados: que la
 * auditoría falle no puede tumbar la operación del abonado. Lo que sí importa
 * es que se anote también lo que salió bien — la pregunta que llega después es
 * "¿quién consultó esta cédula?", y un log de errores no la contesta.
 */
async function anotar(fila) {
  try {
    await db().from('api_llamadas').insert(fila)
  } catch {
    // Silencio a propósito: ver arriba.
  }
}

/**
 * Exige una llave válida y, si se pide, un permiso.
 *
 * Deja en `req.llave` la fila de la integración: quién es, qué puede, a qué
 * cuenta entra su plata y si sus pagos se aplican solos.
 *
 * @param permiso  nombre del catálogo de permisos (`pagos.registrar`, …), o una
 *                 lista: con lista alcanza CUALQUIERA de ellos.
 *
 *                 La lista existe porque hay rutas que una función u otra
 *                 justifican por igual. `consultar-deuda` devuelve el estado del
 *                 abonado y sus facturas: quien puede ver abonados y quien puede
 *                 ver facturación tienen los dos motivo para llamarla. Exigir
 *                 solo uno dejaba afuera a las llaves sacadas de un cobrador
 *                 —que tiene `facturacion.ver` y no `clientes.ver`— y esa es
 *                 justamente la llave de un bot que cobra.
 *
 *                 Sin permiso, alcanza con que la llave sea válida.
 */
export function requireApiKey(permiso = null) {
  return async function guardia(req, res, next) {
    const inicio = Date.now()
    const ip = ipDe(req)
    const llave = llaveDe(req)

    /** Cierra el pedido con un error y lo deja anotado. */
    const rechazar = (mensaje, { status = 401, hint, llaveFila = null } = {}) => {
      anotar({
        llave_id: llaveFila?.id ?? null,
        llave_nombre: llaveFila?.nombre ?? null,
        metodo: req.method,
        ruta: req.originalUrl.slice(0, 200),
        status,
        ms: Date.now() - inicio,
        ip,
        identificacion: identificacionDe(req),
        error: mensaje,
      })
      next(new AppError(mensaje, { status, hint }))
    }

    if (!llave) {
      return rechazar('Falta la llave de API', {
        hint: 'Mandá la llave en el header X-API-Key.',
      })
    }

    let fila
    try {
      const { data, error } = await db()
        .from('api_llaves')
        .select('*')
        .eq('huella', huellaDe(llave))
        .maybeSingle()

      if (error) {
        return next(new AppError(`No se pudo validar la llave: ${error.message}`, { status: 502 }))
      }
      fila = data
    } catch (err) {
      return next(err)
    }

    // Mismo mensaje para "no existe" y "está revocada": decirle a quien prueba
    // llaves cuál de las dos cosas pasó es decirle cuáles existieron.
    if (!fila || !igual(fila.huella, huellaDe(llave))) {
      return rechazar('La llave de API no es válida')
    }

    if (!fila.activa || fila.revocada_at) {
      return rechazar('La llave de API fue revocada', {
        status: 403,
        llaveFila: fila,
        hint: fila.motivo_revocacion || 'Pedí una llave nueva en Ajustes → Integraciones.',
      })
    }

    if (fila.ips_permitidas?.length && !fila.ips_permitidas.includes(ip)) {
      return rechazar(`La llave no está habilitada para la IP ${ip}`, {
        status: 403,
        llaveFila: fila,
        hint: 'Agregá esa IP en Ajustes → Integraciones, o dejá la lista vacía para permitir cualquiera.',
      })
    }

    const exigidos = permiso ? (Array.isArray(permiso) ? permiso : [permiso]) : []
    const tiene = (fila.permisos ?? []).some((p) => exigidos.includes(p))

    if (exigidos.length && !tiene) {
      return rechazar(
        exigidos.length === 1
          ? `Esta llave no tiene el permiso "${exigidos[0]}"`
          : `Esta llave necesita alguno de estos permisos: ${exigidos.join(', ')}`,
        {
          status: 403,
          llaveFila: fila,
          hint: 'Se otorgan en Ajustes → Integraciones, editando la llave.',
        },
      )
    }

    req.llave = fila

    // El uso se marca una vez por pedido y sin esperar: es un dato para la
    // pantalla ("esta llave no se usa hace tres meses"), no algo de lo que
    // dependa la respuesta.
    db().from('api_llaves').update({ ultimo_uso: new Date().toISOString() }).eq('id', fila.id)
      .then(() => {}, () => {})

    // La anotación del resultado va cuando la respuesta ya salió: recién ahí se
    // sabe el status y cuánto tardó.
    res.on('finish', () => {
      anotar({
        llave_id: fila.id,
        llave_nombre: fila.nombre,
        metodo: req.method,
        ruta: req.originalUrl.slice(0, 200),
        status: res.statusCode,
        ms: Date.now() - inicio,
        ip,
        identificacion: identificacionDe(req),
        error: res.statusCode >= 400 ? res.locals?.errorApi ?? null : null,
      })
    })

    next()
  }
}

/**
 * Con qué cédula se estaba trabajando.
 *
 * Es lo único del pedido que se guarda: reconstruir un caso empieza siempre por
 * "el abonado tal dice que…". El monto, el teléfono y el comprobante no se
 * anotan — quedan en la fila del pago, que es donde corresponde.
 */
function identificacionDe(req) {
  const v = req.query?.identificacion ?? req.body?.identificacion ?? req.params?.identificacion
  return v ? String(v).trim().slice(0, 20) : null
}

export { huellaDe, ipDe }
