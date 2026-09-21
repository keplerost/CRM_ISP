/**
 * WhatsApp por Twilio, que revende la API oficial.
 *
 * Los números llevan el prefijo `whatsapp:` de los dos lados: es la única
 * diferencia con un SMS por la misma cuenta.
 */
export async function enviar({ config, numero, texto }) {
  if (!config.sid || !config.token || !config.desde) {
    return { ok: false, error: 'Falta el SID, el token o el número de origen de Twilio' }
  }

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${config.sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.sid}:${config.token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: `whatsapp:+${numero}`,
          From: `whatsapp:${config.desde}`,
          Body: texto,
        }),
        signal: AbortSignal.timeout(15000),
      },
    )

    const json = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, error: json?.message ?? `Twilio devolvió ${res.status}` }
    return { ok: true, id: json?.sid ?? null }
  } catch (err) {
    return { ok: false, error: `No se pudo hablar con Twilio: ${err.message}` }
  }
}

export async function estado({ config }) {
  return config.sid && config.token && config.desde
    ? { conectado: true, detalle: `Twilio · ${config.desde}` }
    : { conectado: false, detalle: 'Sin credenciales completas' }
}
