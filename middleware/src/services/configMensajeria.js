import { db } from '../lib/db.js'
import { config } from '../config.js'
import { decrypt, encrypt } from '../lib/crypto.js'
import { AppError } from '../lib/errors.js'

/**
 * De dónde salen las credenciales de los canales de aviso.
 *
 * Se leen de la base, y si ahí no hay nada, del archivo del servidor. Ese
 * orden importa:
 *
 *   LA BASE PRIMERO, porque es lo que el ISP puede editar desde una pantalla.
 *   Este sistema se vende: el que lo compra tiene su propio bot y su propio
 *   número de WhatsApp, y no puede necesitar una sesión SSH para cargarlos.
 *
 *   EL ARCHIVO DESPUÉS, porque es donde están hoy. Sin esa caída, correr la
 *   migración apagaría los avisos de todas las instalaciones que ya funcionan
 *   —incluida la del propio proveedor— hasta que alguien entre a recargarlos a
 *   mano. Ya pasó una vez con las licencias; no se repite.
 *
 * Cuando se guarda algo desde la pantalla, la base gana y el archivo queda como
 * lo que era: el valor de arranque.
 */

/** Un solo lugar donde se cachea: los tokens no cambian entre dos mensajes. */
let cache = null

export const olvidarCache = () => {
  cache = null
}

async function fila() {
  const { data, error } = await db().from('config_mensajeria').select('*').eq('id', 1).maybeSingle()

  // Que la tabla no exista todavía NO es un error fatal: es una instalación
  // que no corrió la migración. Se sigue con el archivo, como siempre.
  if (error) {
    console.warn('[mensajeria] no se pudo leer la configuración, se usa el .env:', error.message)
    return null
  }
  return data
}

const abrir = (cifrado) => {
  if (!cifrado) return null
  try {
    return decrypt(cifrado)
  } catch (err) {
    // Pasa al restaurar un respaldo en un servidor con otra CREDENTIALS_KEY.
    // Decirlo es mejor que "el bot no responde".
    console.error('[mensajeria] no se pudo descifrar una credencial:', err.message)
    return null
  }
}

/**
 * La configuración efectiva: lo que de verdad se va a usar para enviar.
 *
 * Cada valor cae al entorno por separado, no el bloque entero. Así el ISP que
 * cargó su bot de Telegram desde la pantalla pero todavía no tocó WhatsApp
 * sigue mandando WhatsApp con lo del archivo.
 */
export async function credenciales() {
  if (cache) return cache

  const f = (await fila()) ?? {}
  const env = process.env

  cache = {
    telegram: {
      token: abrir(f.telegram_token_encrypted) || env.TELEGRAM_BOT_TOKEN || null,
      bot: f.telegram_bot_usuario || null,
    },
    whatsapp: {
      via: f.whatsapp_via ?? (env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID ? 'meta' : 'manual'),
      token: abrir(f.whatsapp_token_encrypted) || env.WHATSAPP_TOKEN || null,
      phoneId: f.whatsapp_phone_id || env.WHATSAPP_PHONE_ID || null,
      desde: f.whatsapp_desde || null,
      // Evolution API: la vía gratuita. Cae al entorno igual que las demás,
      // para poder levantarla en un servidor nuevo sin entrar a la pantalla.
      url: f.whatsapp_evolution_url || env.EVOLUTION_URL || null,
      instancia: f.whatsapp_evolution_instancia || env.EVOLUTION_INSTANCIA || null,
      apiKey: abrir(f.whatsapp_evolution_key_encrypted) || env.EVOLUTION_API_KEY || null,

      /**
       * Lo que hace falta para RECIBIR de Meta, no para mandar.
       *
       * `verifyToken` lo inventa el ISP y lo escribe en los dos lados: Meta lo
       * manda una vez, al dar de alta el webhook. `appSecret` es el que firma
       * cada aviso que llega — sin él, la URL del webhook acepta lo que le
       * manden y una "BAJA" falsa deja a un abonado sin avisos.
       */
      verifyToken: f.whatsapp_verify_token || env.WHATSAPP_VERIFY_TOKEN || null,
      appSecret: abrir(f.whatsapp_app_secret_encrypted) || env.WHATSAPP_APP_SECRET || null,

      /**
       * El CRM que entrega los mensajes, cuando la vía es esa.
       *
       * Genérico a propósito: este sistema se vende y el ISP que lo compra puede
       * tener cualquier CRM. Lo que se guarda es a dónde mandar, con qué llave y
       * con qué cabecera — no un proveedor en particular.
       */
      crm: {
        nombre: f.whatsapp_crm_nombre || null,
        url: f.whatsapp_crm_url || env.WHATSAPP_CRM_URL || null,
        header: f.whatsapp_crm_header || 'X-API-Key',
        llave: abrir(f.whatsapp_crm_key_encrypted) || env.WHATSAPP_CRM_KEY || null,
      },
    },
    twilio: {
      sid: f.twilio_sid || env.TWILIO_SID || null,
      token: abrir(f.twilio_token_encrypted) || env.TWILIO_TOKEN || null,
      desde: f.twilio_desde || env.TWILIO_FROM || null,
    },
    nms: {
      canal: f.nms_canal || config.nms.canal || 'telegram',
      destino: f.nms_destino || config.nms.destino || null,
    },
  }
  return cache
}

/**
 * Lo mismo, pero para mostrar en pantalla: sin los secretos.
 *
 * Se dice SI hay una credencial cargada y DE DÓNDE viene, nunca su valor. Un
 * token que sale a la pantalla queda en el historial del navegador y en
 * cualquier captura que alguien mande por WhatsApp para pedir ayuda.
 */
export async function paraMostrar() {
  const f = (await fila()) ?? {}
  const c = await credenciales()
  const env = process.env

  /** De dónde salió cada credencial. Es lo primero que hay que saber al diagnosticar. */
  const origen = (enBase, enEnv) => (enBase ? 'base' : enEnv ? 'archivo' : null)

  return {
    // La franja horaria: no es de ningún canal, manda sobre todos.
    avisos_desde: f.avisos_desde ?? '08:00',
    avisos_hasta: f.avisos_hasta ?? '20:00',
    whatsapp_pausa_segundos: f.whatsapp_pausa_segundos ?? 0,
    telegram: {
      tiene_token: Boolean(c.telegram.token),
      origen: origen(f.telegram_token_encrypted, env.TELEGRAM_BOT_TOKEN),
      bot_usuario: c.telegram.bot,
    },
    whatsapp: {
      via: c.whatsapp.via,
      tiene_token: Boolean(c.whatsapp.token),
      origen: origen(f.whatsapp_token_encrypted, env.WHATSAPP_TOKEN),
      phone_id: c.whatsapp.phoneId,
      desde: c.whatsapp.desde,
      // Evolution: la URL y la instancia no son secretas —hacen falta para
      // diagnosticar— y la clave solo se dice si está o no.
      evolution_url: c.whatsapp.url,
      evolution_instancia: c.whatsapp.instancia,
      tiene_evolution_key: Boolean(c.whatsapp.apiKey),
      // Del webhook se dice si está listo, nunca el secreto. Es lo que permite
      // diagnosticar "los acuses no llegan" sin exponer nada.
      // El de verificación se muestra: hay que copiarlo igual en Meta, y no
      // poder verlo obliga a inventarlo de nuevo cada vez.
      verify_token: c.whatsapp.verifyToken,
      // El App Secret nunca: solo si está cargado.
      tiene_app_secret: Boolean(c.whatsapp.appSecret),
      // Del CRM se muestran la URL y el nombre —hacen falta para diagnosticar—
      // y de la llave solo si está.
      crm_nombre: c.whatsapp.crm.nombre,
      crm_url: c.whatsapp.crm.url,
      crm_header: c.whatsapp.crm.header,
      tiene_crm_key: Boolean(c.whatsapp.crm.llave),
      origen_evolution: origen(f.whatsapp_evolution_key_encrypted, env.EVOLUTION_API_KEY),
    },
    sms: {
      sid: c.twilio.sid,
      tiene_token: Boolean(c.twilio.token),
      origen: origen(f.twilio_token_encrypted, env.TWILIO_TOKEN),
      desde: c.twilio.desde,
    },
    nms: c.nms,
  }
}

const CAMPOS_CLAROS = [
  'telegram_bot_usuario',
  'whatsapp_via',
  'whatsapp_phone_id',
  'whatsapp_desde',
  'whatsapp_evolution_url',
  'whatsapp_evolution_instancia',
  // El del saludo de alta del webhook. No es un secreto fuerte —Meta lo manda
  // una sola vez para comprobar que la URL es nuestra— así que va en claro y se
  // puede ver en la pantalla: quien lo configura necesita copiarlo a los dos
  // lados y no poder verlo obliga a inventarlo de nuevo.
  'whatsapp_verify_token',
  'whatsapp_crm_nombre',
  'whatsapp_crm_url',
  'whatsapp_crm_header',
  'twilio_sid',
  'twilio_desde',
  'nms_canal',
  'nms_destino',
  // La franja en la que se le puede escribir a un abonado. Manda sobre todos
  // los canales, así que vive acá y no en cada uno.
  'avisos_desde',
  'avisos_hasta',
  // Cuánto esperar entre dos mensajes de WhatsApp. Es del canal, no de la
  // cola: el correo no lo necesita.
  'whatsapp_pausa_segundos',
]

/** Los secretos: qué campo del formulario va a qué columna cifrada. */
const CAMPOS_SECRETOS = {
  telegram_token: 'telegram_token_encrypted',
  whatsapp_token: 'whatsapp_token_encrypted',
  whatsapp_evolution_key: 'whatsapp_evolution_key_encrypted',
  // Este SÍ es secreto: con él se verifica la firma de cada webhook. Quien lo
  // tenga puede fabricar mensajes entrantes.
  whatsapp_app_secret: 'whatsapp_app_secret_encrypted',
  whatsapp_crm_key: 'whatsapp_crm_key_encrypted',
  twilio_token: 'twilio_token_encrypted',
}

/**
 * Guarda lo que llega de la pantalla.
 *
 * Un secreto que llega vacío NO borra el que hay. La pantalla nunca muestra el
 * valor guardado, así que el formulario siempre llega con esos campos en
 * blanco: tomarlos al pie de la letra borraría el token cada vez que alguien
 * entra a corregir el número de teléfono.
 *
 * Para borrar de verdad hay que mandar la palabra `BORRAR`, que es explícito y
 * no puede pasar sin querer.
 */
export function armarFila(datos = {}, cifrar = encrypt) {
  const fila = {}

  for (const campo of CAMPOS_CLAROS) {
    if (campo in datos) fila[campo] = datos[campo] === '' ? null : datos[campo]
  }

  for (const [entrada, columna] of Object.entries(CAMPOS_SECRETOS)) {
    const valor = datos[entrada]
    if (valor === 'BORRAR') fila[columna] = null
    else if (valor) fila[columna] = cifrar(String(valor).trim())
  }

  return fila
}

export async function guardar(datos = {}) {
  const fila = armarFila(datos)

  if (!Object.keys(fila).length) return paraMostrar()

  fila.actualizado_en = new Date().toISOString()

  const { error } = await db().from('config_mensajeria').update(fila).eq('id', 1)
  if (error) {
    /**
     * La pista se elige según el error, no se pega siempre la misma.
     *
     * Antes decía "si dice que no existe la tabla, falta correr la migración 61"
     * en TODOS los casos. Cuando el problema era otro —una vía que la
     * restricción no admite— esa línea mandaba a buscar donde no era.
     */
    const falta = /does not exist/i.test(error.message)
    const restriccion = /violates check constraint/i.test(error.message)

    throw new AppError(`No se pudo guardar la configuración: ${error.message}`, {
      status: 502,
      hint: falta
        ? 'Falta correr supabase/migracion-61-configuracion-de-mensajeria.sql'
        : restriccion
          ? 'La base no admite ese valor. Si acabás de elegir una vía nueva de WhatsApp, falta correr la migración que la habilita (la 180 para "CRM externo").'
          : undefined,
    })
  }

  olvidarCache()
  return paraMostrar()
}
