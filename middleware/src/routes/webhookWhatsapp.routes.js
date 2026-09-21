import crypto from 'node:crypto'
import { Router } from 'express'

import { db } from '../lib/db.js'
import { credenciales } from '../services/configMensajeria.js'
import {
  anotarEntrante,
  clientePorTelefono,
  darDeBaja,
  normalizar,
  pideLaBaja,
} from '../services/ventanaWhatsapp.js'

/**
 * El webhook de WhatsApp: lo que Meta nos manda a nosotros.
 *
 * ── Dónde va montado y por qué ──
 *
 * Afuera del guardia de sesión y afuera del guardián de licencia, igual que el
 * aviso del proveedor de firma. Quien golpea es el servidor de Meta: no tiene
 * sesión de Supabase, no sabe nada de nuestra licencia, y si le contestamos
 * cualquier cosa que no sea 200 reintenta — y después de varios reintentos
 * fallidos DA DE BAJA la suscripción, que es la forma de quedarse sin acuses de
 * entrega sin que nadie lo note.
 *
 * Por eso todo acá contesta 200 salvo que la firma no valide. Un error nuestro
 * procesando un mensaje no puede hacer que Meta deje de mandarnos los demás.
 *
 * ── Qué trae ──
 *
 *   messages[]  lo que escribió el abonado. Abre su ventana de 24 horas.
 *   statuses[]  el acuse de cada mensaje que mandamos: entregado, leído, falló.
 */

const router = Router()

/**
 * El saludo de alta.
 *
 * Meta pega una vez con `hub.challenge` y espera que le devolvamos ese mismo
 * valor si el `hub.verify_token` coincide con el que cargó el ISP. Es lo que le
 * prueba que la URL es de quien dice ser.
 */
router.get('/whatsapp', async (req, res) => {
  const modo = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const desafio = req.query['hub.challenge']

  try {
    const { whatsapp } = await credenciales()

    if (modo === 'subscribe' && token && token === whatsapp.verifyToken) {
      // Texto plano y el valor pelado: Meta compara la respuesta tal cual.
      return res.status(200).type('text/plain').send(String(desafio ?? ''))
    }
  } catch (err) {
    console.error('[whatsapp] no se pudo leer la configuración para verificar:', err.message)
  }

  // Sin detalle: decirle a quien prueba si falló el token o el modo es decirle
  // por dónde seguir probando.
  res.sendStatus(403)
})

/**
 * ¿Este aviso lo mandó Meta de verdad?
 *
 * La firma es HMAC-SHA256 del cuerpo CRUDO con el App Secret. Tiene que ser el
 * cuerpo tal cual llegó: si se compara contra el JSON vuelto a serializar, un
 * espacio de diferencia hace que nunca valide.
 */
function firmaValida(req, appSecret) {
  const enviada = req.headers['x-hub-signature-256']
  if (!enviada || !appSecret || !req.rawBody) return false

  const esperada =
    'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex')

  const a = Buffer.from(String(enviada))
  const b = Buffer.from(esperada)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

router.post('/whatsapp', async (req, res) => {
  let appSecret = null
  try {
    appSecret = (await credenciales()).whatsapp.appSecret
  } catch {
    // Se sigue: sin secreto se procesa lo inofensivo. Ver abajo.
  }

  /**
   * Sin App Secret cargado se acepta, pero a medias.
   *
   * ── Por qué no se rechaza directamente ──
   *
   * Porque el webhook hay que darlo de alta antes de terminar de configurar
   * todo, y una URL que rechaza todo no se puede dar de alta.
   *
   * ── Y por qué no se acepta del todo ──
   *
   * Porque sin firma, cualquiera que descubra la URL puede inventar mensajes
   * entrantes. Abrir una ventana de 24 horas para un número ajeno casi no hace
   * daño —el mensaje llegaría igual, solo que como texto libre—. Pero mandar
   * una "BAJA" falsa apaga los avisos de un abonado real, y ese se queda sin
   * enterarse de que le van a cortar.
   *
   * Así que lo que solo LEE se procesa; lo que APAGA algo, no.
   */
  const verificado = firmaValida(req, appSecret)

  if (appSecret && !verificado) {
    console.warn('[whatsapp] webhook con firma inválida: se descarta')
    return res.sendStatus(401)
  }
  if (!appSecret) {
    console.warn(
      '[whatsapp] webhook sin App Secret configurado: las bajas por chat no se van a aplicar. Cargalo en Ajustes → Mensajería.',
    )
  }

  /**
   * Se contesta ANTES de procesar.
   *
   * Meta espera el 200 en pocos segundos y reintenta si tarda. Un lote con
   * cincuenta acuses que hay que buscar en la base tarda más que eso, y el
   * reintento traería los mismos cincuenta otra vez.
   */
  res.sendStatus(200)

  try {
    await procesar(req.body, { verificado })
  } catch (err) {
    console.error('[whatsapp] error procesando el webhook:', err.message)
  }
})

async function procesar(cuerpo, { verificado }) {
  for (const entrada of cuerpo?.entry ?? []) {
    for (const cambio of entrada?.changes ?? []) {
      const valor = cambio?.value
      if (!valor) continue

      for (const mensaje of valor.messages ?? []) {
        await entrante(mensaje, valor, { verificado })
      }
      for (const acuse of valor.statuses ?? []) {
        await estadoDeEnvio(acuse)
      }
    }
  }
}

/** Lo que escribió el abonado. */
async function entrante(mensaje, valor, { verificado }) {
  const telefono = normalizar(mensaje.from)
  if (!telefono) return

  // Solo el texto sirve para decidir una baja. De una foto o un audio se anota
  // la ventana igual —escribió, la ventana se abre— pero no se interpreta.
  const texto = mensaje.text?.body ?? mensaje.button?.text ?? null

  const cuando = mensaje.timestamp
    ? new Date(Number(mensaje.timestamp) * 1000).toISOString()
    : new Date().toISOString()

  const cliente = await clientePorTelefono(telefono)

  await anotarEntrante({ telefono, texto, cuando, clientId: cliente?.id ?? null })

  /**
   * Queda en el historial del abonado, si se lo reconoció.
   *
   * Es lo que hace que en su ficha se vea la conversación completa y no solo lo
   * que le mandamos nosotros. Sin cliente no se guarda: `comunicaciones` cuelga
   * de una ficha, y una fila suelta no la vería nadie.
   */
  if (cliente?.id) {
    await db()
      .from('comunicaciones')
      .insert({
        client_id: cliente.id,
        canal: 'whatsapp',
        direccion: 'entrante',
        destino: telefono,
        cuerpo: texto ?? `[${mensaje.type ?? 'mensaje'}]`,
        estado: 'recibido',
        proveedor_id: mensaje.id ?? null,
        automatico: false,
      })
      .then(({ error }) => error && console.error('[whatsapp] no se guardó el entrante:', error.message))
  }

  // --- La baja -------------------------------------------------------------
  if (!texto || !pideLaBaja(texto)) return

  if (!verificado) {
    console.warn(
      `[whatsapp] ${telefono} pidió la baja pero el webhook no está firmado: no se aplica. Cargá el App Secret.`,
    )
    return
  }
  if (!cliente?.id) return

  if (await darDeBaja(cliente.id, texto)) {
    console.log(`[whatsapp] ${cliente.nombre} pidió no recibir más avisos ("${texto.trim()}")`)
  }
}

/** Cómo le fue a un mensaje que mandamos nosotros. */
const ESTADOS = { sent: 'enviado', delivered: 'entregado', read: 'leido', failed: 'fallido' }

async function estadoDeEnvio(acuse) {
  const nuevo = ESTADOS[acuse?.status]
  if (!nuevo || !acuse.id) return

  const fila = { estado: nuevo }
  const cuando = acuse.timestamp
    ? new Date(Number(acuse.timestamp) * 1000).toISOString()
    : new Date().toISOString()

  if (nuevo === 'entregado') fila.entregado_at = cuando
  if (nuevo === 'leido') {
    fila.leido_at = cuando
    // Leído implica entregado. Sin esto, un mensaje que se lee tan rápido que
    // los dos acuses llegan juntos puede quedar leído y sin fecha de entrega.
    fila.entregado_at = cuando
  }
  if (nuevo === 'fallido') {
    fila.error = acuse.errors?.[0]?.title ?? acuse.errors?.[0]?.message ?? 'Meta no lo pudo entregar'
  }

  /**
   * No se pisa hacia atrás.
   *
   * Los acuses llegan fuera de orden: el de "entregado" puede aparecer después
   * del de "leído". Sin este filtro, un mensaje que el abonado ya leyó volvería
   * a figurar como apenas entregado.
   */
  const orden = ['pendiente', 'enviado', 'entregado', 'leido']
  const { data: previa } = await db()
    .from('comunicaciones')
    .select('id, estado')
    .eq('proveedor_id', acuse.id)
    .maybeSingle()

  if (!previa) return
  if (nuevo !== 'fallido' && orden.indexOf(nuevo) <= orden.indexOf(previa.estado)) return

  await db()
    .from('comunicaciones')
    .update(fila)
    .eq('id', previa.id)
    .then(({ error }) => error && console.error('[whatsapp] no se actualizó el acuse:', error.message))
}

export default router
