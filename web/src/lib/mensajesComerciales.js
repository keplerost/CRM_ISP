import { supabase } from './supabaseClient'
import { aWhatsApp, enlaceWhatsApp } from './telefono'

/**
 * Los mensajes que el vendedor le manda al prospecto.
 *
 * ── El único lugar donde se decide cómo sale un mensaje ──
 *
 * Hoy sale de dos maneras y mañana de tres, así que toda pantalla que quiera
 * escribirle a alguien pasa por acá. Si el enlace `wa.me` se arma suelto en
 * cada página —que es como estaba— el día que se conecte la API de Meta hay que
 * ir a buscar cinco lugares, y el que se olvide sigue mandando sin registrar.
 *
 * ── Lo que este módulo NO afirma ──
 *
 * En modo manual el mensaje sale del teléfono del vendedor, fuera del sistema.
 * Se registra que se PREPARÓ. No que se envió: él puede cerrar WhatsApp sin
 * apretar enviar, y no hay forma de saberlo desde acá. El estado lo dice tal
 * cual, y las pantallas tienen que decirlo igual — «preparado», no «enviado».
 */

// La conversión del número vive en `telefono.js`, que es de donde la toman
// también cobranza, soporte y el tablero. Se reexporta para no obligar a las
// pantallas de ventas a importar de dos lados.
export { aWhatsApp } from './telefono'

/**
 * La firma del vendedor al pie del mensaje.
 *
 * Va porque el mensaje sale de un número que el cliente no tiene agendado. Sin
 * nombre es un desconocido mandando precios, y así se responde: no se responde.
 *
 * El teléfono sale del legajo (`celular`). Si no está cargado, se firma igual
 * con el nombre —mejor eso que nada— y la pantalla avisa que falta.
 */
export function firma(perfil) {
  if (!perfil?.nombre) return null
  const nombre = `${perfil.nombre} ${perfil.apellido ?? ''}`.trim()
  const tel = perfil.celular ? String(perfil.celular).trim() : null
  return tel
    ? `Soy ${nombre}. Cualquier cosa me escribís al ${tel}.`
    : `Soy ${nombre}, quedo atento.`
}

/** El texto con la firma pegada al final, sin duplicarla si ya está. */
export const conFirma = (cuerpo, perfil) => {
  const f = firma(perfil)
  if (!f || cuerpo.includes(f)) return cuerpo
  return `${cuerpo}\n\n${f}`
}

/**
 * Deja registrado el mensaje y devuelve cómo mandarlo.
 *
 * Devuelve `{ enlace, registro, via }`. En manual, `enlace` es el `wa.me` que la
 * pantalla tiene que abrir; el día que haya API va a venir en null porque el
 * envío ya ocurrió del lado del servidor.
 *
 * El registro se hace ANTES de abrir el chat, no después. Si se hiciera después
 * dependería de que la pantalla no se cierre en el medio, y justo los mensajes
 * que más importan son los que se mandan apurado y cerrando todo.
 *
 * Si el registro falla, el mensaje se manda igual. Perder la venta porque no se
 * pudo escribir una fila de auditoría sería el peor intercambio posible; el
 * error se devuelve para que la pantalla lo muestre.
 */
export async function prepararWhatsApp({
  telefono,
  cuerpo,
  perfil,
  prospecto_id = null,
  cotizacion_id = null,
  firmar = true,
}) {
  const numero = aWhatsApp(telefono)
  if (!numero) throw new Error('No hay teléfono al que escribir')

  const texto = firmar ? conFirma(cuerpo, perfil) : cuerpo

  // ── Acá se bifurca el día que se contrate el número de empresa ──
  //
  // La API de Meta se llama desde el middleware, nunca desde el navegador: el
  // token permanente de WhatsApp en el bundle de la web es el token en manos de
  // cualquiera que abra las herramientas de desarrollador.
  //
  // Cuando exista, esta función va a preguntarle al middleware por dónde sale y
  // en el caso `meta` va a devolver `{ enlace: null, via: 'meta' }`. Las
  // pantallas ya están escritas para eso: si no hay enlace, no abren nada.
  const via = 'manual'

  let registro = null
  let error = null
  try {
    const { data, error: err } = await supabase
      .from('mensajes_comerciales')
      .insert({
        prospecto_id,
        cotizacion_id,
        canal: 'whatsapp',
        destino: numero,
        cuerpo: texto,
        // `preparado`, no `enviado`. Ver el comentario de arriba.
        estado: 'preparado',
        via,
        vendedor_id: perfil?.id ?? null,
      })
      .select()
      .single()
    if (err) throw err
    registro = data
  } catch (err) {
    error = err
  }

  return {
    via,
    registro,
    error,
    enlace: enlaceWhatsApp(numero, texto),
  }
}

/**
 * Los últimos mensajes.
 *
 * RLS decide qué devuelve sin que la pantalla haga nada: el vendedor ve los
 * suyos, quien maneja la cartera ve los de todos. Es la misma consulta.
 */
export async function ultimosMensajes(limite = 20) {
  const { data, error } = await supabase
    .from('v_mensajes_comerciales')
    .select('*')
    .order('creado_en', { ascending: false })
    .limit(limite)
  if (error) throw error
  return data ?? []
}

/** El historial de un prospecto, para la ficha. */
export async function mensajesDe(prospectoId) {
  const { data, error } = await supabase
    .from('v_mensajes_comerciales')
    .select('*')
    .eq('prospecto_id', prospectoId)
    .order('creado_en', { ascending: false })
  if (error) throw error
  return data ?? []
}
