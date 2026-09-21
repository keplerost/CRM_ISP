import { db } from '../lib/db.js'
import { credenciales } from './configMensajeria.js'
import { enviarWhatsapp, automatico } from '../drivers/whatsapp/index.js'
import { textoAlerta, leCorresponde } from '../../../web/src/lib/alertas.js'
import { aWhatsApp } from '../../../web/src/lib/telefono.js'

/**
 * Las alertas: detectar, decidir a quién y mandar.
 *
 * ── El reparto de trabajo con la base ──
 *
 * `detectar_alertas()` mira la red y abre o cierra eventos. No manda nada. Acá
 * se toman los eventos que ya cumplieron su espera y se despachan.
 *
 * Están separados a propósito: la detección tiene que funcionar aunque no haya
 * ningún proveedor de WhatsApp configurado —los eventos quedan anotados y se
 * ven en la pantalla— y el envío tiene que poder reintentarse sin volver a
 * mirar la red.
 *
 * ── Por qué el texto viene de `web/src/lib/alertas.js` ──
 *
 * Porque es el mismo que muestra la pantalla al previsualizar una alerta. Si
 * estuviera escrito dos veces, el mensaje que se prueba y el que llega al
 * teléfono a las tres de la mañana serían distintos, y nadie se enteraría hasta
 * la primera noche mala.
 */

/** Cuántos mensajes como mucho por corrida. El tope contra la noche de tormenta. */
const TOPE_POR_CORRIDA = 20

export async function ejecutarAlertas({ ahora = new Date() } = {}) {
  const resultado = { detectados: null, enviados: 0, fallidos: 0, omitidos: 0, aviso: null }

  const avisar = (t) => {
    resultado.aviso = resultado.aviso ? `${resultado.aviso} · ${t}` : t
  }

  // ── 1. Mirar la red ──
  const { data: det, error: eDet } = await db().rpc('detectar_alertas')
  if (eDet) {
    avisar(`La detección falló: ${eDet.message}`)
  } else {
    resultado.detectados = det?.[0] ?? det
  }

  // ── 2. Qué hay para avisar ──
  const { data: eventos, error: eEv } = await db().rpc('alertas_por_enviar')
  if (eEv) {
    avisar(`No se pudieron leer los eventos: ${eEv.message}`)
    return resultado
  }
  if (!eventos?.length) return resultado

  const { data: destinos } = await db()
    .from('alerta_destinos')
    .select('*')
    .eq('activo', true)

  if (!destinos?.length) {
    avisar('Hay alertas para mandar pero no hay ningún destino cargado.')
    return resultado
  }

  const { whatsapp } = await credenciales()

  // ── 3. Mandar ──
  for (const evento of eventos.slice(0, TOPE_POR_CORRIDA)) {
    const texto = textoAlerta(evento, ahora)
    let alguno = false

    for (const destino of destinos) {
      if (!leCorresponde(destino, evento, ahora)) {
        resultado.omitidos += 1
        continue
      }

      const salida = await despachar({ destino, texto, whatsapp })
      alguno = alguno || salida.ok

      await db()
        .from('alerta_envios')
        .insert({
          evento_id: evento.id,
          destino_id: destino.id,
          canal: destino.canal,
          destino: destino.destino,
          texto,
          estado: salida.ok ? 'enviado' : 'fallido',
          respuesta: salida.ok ? (salida.id ?? null) : (salida.error ?? null),
        })

      if (salida.ok) resultado.enviados += 1
      else resultado.fallidos += 1
    }

    /*
     * Se marca como avisado aunque hayan fallado todos.
     *
     * Reintentar indefinidamente un evento cuyo destino está mal cargado
     * llenaría el historial con el mismo error cada cinco minutos y taparía las
     * alertas que sí importan. El fallo queda registrado en `alerta_envios`,
     * que es donde se mira cuando alguien dice "no me llegó nada".
     */
    const campo = evento.resuelto ? 'resuelto_avisado_en' : 'avisado_en'
    await db()
      .from('alerta_eventos')
      .update({ [campo]: new Date().toISOString() })
      .eq('id', evento.id)
  }

  if (eventos.length > TOPE_POR_CORRIDA) {
    avisar(`${eventos.length - TOPE_POR_CORRIDA} alertas quedaron para la próxima corrida (tope de ${TOPE_POR_CORRIDA}).`)
  }

  return resultado
}

/**
 * Manda por el canal del destino.
 *
 * WhatsApp por la vía elegida; Telegram por el bot que ya existe. El correo y el
 * SMS quedan declarados y devuelven un error explícito en vez de fallar raro:
 * decir "todavía no está" es más útil que un `undefined`.
 */
async function despachar({ destino, texto, whatsapp }) {
  if (destino.canal === 'whatsapp') {
    if (!automatico(whatsapp.via)) {
      return {
        ok: false,
        error: `La vía de WhatsApp es "${whatsapp.via}", que no envía sola. Elegí Evolution API, Meta o Twilio en Ajustes → Mensajería.`,
      }
    }

    const numero = aWhatsApp(destino.destino)
    if (!numero) return { ok: false, error: 'El número del destino no es utilizable' }

    return enviarWhatsapp({ via: whatsapp.via, config: whatsapp, numero, texto })
  }

  if (destino.canal === 'telegram') {
    return enviarTelegram({ chatId: destino.destino, texto })
  }

  return { ok: false, error: `El canal "${destino.canal}" todavía no está implementado para alertas` }
}

/** Telegram, que ya está configurado y es gratis: sirve mientras no haya WhatsApp. */
async function enviarTelegram({ chatId, texto }) {
  const { telegram } = await credenciales()
  if (!telegram.token) return { ok: false, error: 'Falta el token del bot de Telegram' }

  try {
    const res = await fetch(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto }),
      signal: AbortSignal.timeout(10000),
    })
    const json = await res.json().catch(() => null)
    if (!json?.ok) return { ok: false, error: json?.description ?? `Telegram devolvió ${res.status}` }
    return { ok: true, id: String(json.result?.message_id ?? '') }
  } catch (err) {
    return { ok: false, error: `No se pudo hablar con Telegram: ${err.message}` }
  }
}

/**
 * Un mensaje de prueba a un destino.
 *
 * Es lo único que evita descubrir que el número estaba mal el día del primer
 * corte. Deja el resultado anotado en el destino para que la pantalla lo muestre.
 */
export async function probarDestino(destinoId) {
  const { data: destino } = await db()
    .from('alerta_destinos')
    .select('*')
    .eq('id', destinoId)
    .maybeSingle()

  if (!destino) throw new Error('No existe ese destino')

  const { whatsapp } = await credenciales()
  const texto =
    '✅ Prueba de alertas\n' +
    'Si estás leyendo esto, los avisos del sistema van a llegar a este número.'

  const salida = await despachar({ destino, texto, whatsapp })

  await db()
    .from('alerta_destinos')
    .update({ probado_en: new Date().toISOString(), probado_ok: salida.ok })
    .eq('id', destinoId)

  await db().from('alerta_envios').insert({
    destino_id: destinoId,
    canal: destino.canal,
    destino: destino.destino,
    texto,
    estado: salida.ok ? 'enviado' : 'fallido',
    respuesta: salida.ok ? (salida.id ?? null) : (salida.error ?? null),
  })

  return { ok: salida.ok, error: salida.error ?? null, enlace: salida.enlace ?? null }
}
