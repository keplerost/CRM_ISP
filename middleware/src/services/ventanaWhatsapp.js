import { db } from '../lib/db.js'

/**
 * La ventana de 24 horas de WhatsApp.
 *
 * ── Qué es ──
 *
 * WhatsApp deja mandar texto libre solo durante las 24 horas siguientes al
 * último mensaje que escribió EL ABONADO. Pasado ese plazo, únicamente pasan
 * plantillas aprobadas por Meta.
 *
 * Sin webhook de entrada no había forma de saber si la ventana estaba abierta,
 * así que el sistema asumía que no —lo seguro— y exigía plantilla para todo. Eso
 * está bien para los avisos automáticos, que efectivamente caen fuera. Pero deja
 * de aprovecharla justo cuando existe: cuando el abonado acaba de escribir
 * pidiendo ayuda y alguien le está por contestar.
 *
 * ── Por qué la ventana no reemplaza a las plantillas ──
 *
 * Porque es del abonado, no nuestra: se abre cuando él quiere y se cierra sola.
 * Un aviso de corte no puede depender de que el abonado haya escrito en el día.
 * La ventana sirve para conversar; las plantillas, para avisar.
 */

/** Solo dígitos, formato internacional, como lo manda Meta. */
export const normalizar = (telefono) => {
  const d = String(telefono ?? '').replace(/\D/g, '')
  if (!d) return null
  return d.startsWith('593') ? d : `593${d.replace(/^0+/, '')}`
}

/**
 * ¿Se le puede escribir texto libre a este número ahora?
 *
 * Devuelve `false` ante cualquier duda —número ilegible, tabla que todavía no
 * existe, error de lectura—. Equivocarse hacia "cerrada" cuesta una plantilla;
 * equivocarse hacia "abierta" hace que el mensaje no salga y nadie se entere.
 */
export async function ventanaAbierta(telefono) {
  const numero = normalizar(telefono)
  if (!numero) return false

  try {
    const { data, error } = await db()
      .from('ventanas_whatsapp')
      .select('ultimo_entrante')
      .eq('telefono', numero)
      .maybeSingle()

    if (error || !data?.ultimo_entrante) return false

    return Date.now() - new Date(data.ultimo_entrante).getTime() < 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}

/**
 * Busca al abonado por su teléfono, sin fallar si no lo encuentra.
 *
 * Es la versión blanda de `clientePor` de la API: acá quien escribe puede no ser
 * cliente —un prospecto, alguien equivocado— y eso no es un error. La ventana se
 * anota igual: sirve para poder contestarle.
 *
 * Si el número está en la ficha de dos abonados no se elige ninguno. Adivinar
 * dejaría el mensaje entrante colgado del historial de la persona equivocada.
 */
export async function clientePorTelefono(numero) {
  const cola = String(numero ?? '').slice(-9)
  if (cola.length < 9) return null

  try {
    const { data } = await db()
      .from('clientes')
      .select('id, nombre, avisos_activos')
      .or(`telefono.ilike.%${cola},telefono_movil.ilike.%${cola}`)
      .neq('estado', 'baja')
      .limit(2)

    return data?.length === 1 ? data[0] : null
  } catch {
    return null
  }
}

/** Deja anotado que este número escribió, y abre su ventana. */
export async function anotarEntrante({ telefono, texto, cuando, clientId = null }) {
  const numero = normalizar(telefono)
  if (!numero) return null

  const { data, error } = await db().rpc('anotar_entrante_whatsapp', {
    p_telefono: numero,
    p_texto: texto ?? null,
    p_client_id: clientId,
    p_cuando: cuando ?? new Date().toISOString(),
  })

  if (error) {
    // Sin la migración corrida esto todavía no existe. Que no se pueda anotar la
    // ventana no puede hacer fallar el webhook: Meta reintenta el aviso entero.
    if (!/does not exist/i.test(error.message)) {
      console.error('[whatsapp] no se pudo anotar el entrante:', error.message)
    }
    return null
  }
  return data
}

/**
 * Las palabras con las que alguien pide que no le escriban más.
 *
 * ── Por qué el mensaje tiene que ser SOLO la palabra ──
 *
 * Porque "no quiero que me dejen de molestar con el ruido de la calle" contiene
 * "molestar", y dar de baja a alguien por eso es peor que no tener la función:
 * deja de recibir el aviso de corte y no entiende por qué.
 *
 * Se compara el mensaje entero, sin tildes, sin signos y sin mayúsculas.
 */
const BAJAS = new Set([
  'baja', 'darme de baja', 'dar de baja', 'darse de baja',
  'stop', 'unsubscribe', 'cancelar', 'cancelar suscripcion',
  'no molestar', 'no escribir', 'no mas mensajes', 'eliminar',
])

export function pideLaBaja(texto) {
  const limpio = String(texto ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return BAJAS.has(limpio)
}

/**
 * Apaga los avisos de un abonado porque lo pidió él.
 *
 * ── Por qué esto protege el número ──
 *
 * Quien pide la baja y sigue recibiendo mensajes bloquea o reporta. Los bloqueos
 * son lo que le baja a Meta la calificación de calidad del número, y con la
 * calificación en rojo Meta recorta el límite de envíos y termina pausando
 * plantillas. O sea que ignorar una baja es, a la vuelta, lo que hace que
 * después no salgan los avisos de corte para todos los demás.
 */
export async function darDeBaja(clientId, texto) {
  const { error } = await db()
    .from('clientes')
    .update({
      avisos_activos: false,
      avisos_baja_at: new Date().toISOString(),
      avisos_baja_texto: String(texto ?? '').slice(0, 200),
    })
    .eq('id', clientId)

  if (error) {
    console.error('[whatsapp] no se pudo registrar la baja:', error.message)
    return false
  }
  return true
}
