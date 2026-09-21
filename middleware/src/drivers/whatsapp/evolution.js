/**
 * WhatsApp por Evolution API.
 *
 * ── Qué es ──
 *
 * Un servicio aparte —normalmente un contenedor— que por dentro usa Baileys y
 * expone HTTP. Se le habla con `fetch` y él mantiene la sesión de WhatsApp.
 *
 * ── Por qué esta vía y no Baileys directo ──
 *
 * Porque la sesión vive FUERA de este proceso. Con Baileys embebido, cada
 * reinicio del middleware —un despliegue, un `npm install`— arrastra la conexión
 * de WhatsApp con él y hay que esperar a que reconecte, o peor, volver a
 * escanear el QR. Con Evolution, el middleware se puede reiniciar veinte veces
 * que WhatsApp sigue conectado del otro lado.
 *
 * Y trae panel propio para escanear el QR y ver el estado, que es exactamente lo
 * que no vale la pena programar de nuevo.
 *
 * ── Lo que hay que saber ──
 *
 * Por debajo es Baileys, así que NO es oficial: Meta puede bloquear el número si
 * detecta uso automatizado agresivo. Para avisos internos a los propios técnicos
 * el riesgo es bajo. Conviene usar un número aparte del que atiende clientes: si
 * ese se bloquea, no se cae la atención.
 */

/** Sin barra final: Evolution arma sus rutas pegando `/message/...`. */
const limpiarUrl = (u) => String(u ?? '').trim().replace(/\/+$/, '')

/**
 * Manda un texto.
 *
 * `numero` viene en formato internacional sin `+` —`593990032123`—, que es lo
 * que Evolution espera. Se deja tal cual: convertirlo acá duplicaría la lógica
 * que ya vive en `telefono.js`.
 */
export async function enviar({ config, numero, texto }) {
  const url = limpiarUrl(config.url)
  const instancia = String(config.instancia ?? '').trim()

  if (!url || !instancia || !config.apiKey) {
    return {
      ok: false,
      error: 'Evolution API está a medio configurar: falta la URL, la instancia o la clave.',
    }
  }

  let res
  try {
    res = await fetch(`${url}/message/sendText/${encodeURIComponent(instancia)}`, {
      method: 'POST',
      headers: { apikey: config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: numero, text: texto }),
      // Sin tope, un servidor caído deja el envío colgado y con él la tarea de
      // alertas entera. Diez segundos es de sobra para un POST local.
      signal: AbortSignal.timeout(10000),
    })
  } catch (err) {
    return {
      ok: false,
      error:
        err.name === 'TimeoutError'
          ? `Evolution API no respondió en 10 s (${url})`
          : `No se pudo hablar con Evolution API: ${err.message}`,
    }
  }

  const cuerpo = await res.text()
  let json = null
  try {
    json = JSON.parse(cuerpo)
  } catch {
    // Evolution devuelve JSON siempre; si no lo es, algo hay adelante —un proxy,
    // una página de error— y el texto crudo dice más que "respuesta inválida".
  }

  if (!res.ok) {
    return {
      ok: false,
      error: json?.message ?? json?.error ?? `Evolution API devolvió ${res.status}`,
      crudo: cuerpo.slice(0, 400),
    }
  }

  return { ok: true, id: json?.key?.id ?? json?.messageId ?? null, crudo: json }
}

/**
 * Si la instancia está conectada a WhatsApp.
 *
 * Es lo que hace que la pantalla pueda decir "conectado como +593 99…" en vez de
 * dejar a alguien adivinando por qué no llegan los avisos.
 */
export async function estado({ config }) {
  const url = limpiarUrl(config.url)
  const instancia = String(config.instancia ?? '').trim()

  if (!url || !instancia || !config.apiKey) {
    return { conectado: false, detalle: 'Sin configurar' }
  }

  try {
    const res = await fetch(
      `${url}/instance/connectionState/${encodeURIComponent(instancia)}`,
      { headers: { apikey: config.apiKey }, signal: AbortSignal.timeout(8000) },
    )
    const json = await res.json().catch(() => null)

    if (!res.ok) {
      return { conectado: false, detalle: json?.message ?? `Devolvió ${res.status}` }
    }

    // Evolution cambió la forma de esta respuesta entre versiones: en unas viene
    // `{instance:{state}}` y en otras `{state}`. Se aceptan las dos.
    const estadoInstancia = json?.instance?.state ?? json?.state ?? null

    return {
      conectado: estadoInstancia === 'open',
      como: json?.instance?.owner ?? json?.owner ?? null,
      detalle: estadoInstancia ?? 'desconocido',
    }
  } catch (err) {
    return { conectado: false, detalle: `No responde: ${err.message}` }
  }
}
