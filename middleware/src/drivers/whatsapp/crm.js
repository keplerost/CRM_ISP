/**
 * WhatsApp entregado por un CRM externo.
 *
 * ── Qué hace y qué no ──
 *
 * El sistema sigue decidiendo QUÉ avisar y CUÁNDO —eso lo sabe él, porque tiene
 * las facturas, los cortes y las averías—. Lo que delega es la ENTREGA: el CRM
 * lo manda por el número que ya usa para hablar con el abonado.
 *
 * ── Por qué eso importa más de lo que parece ──
 *
 * Si el bot del CRM le escribe al cliente desde un número y el aviso de corte
 * sale desde otro, el abonado recibe mensajes de dos números que dicen ser el
 * mismo proveedor. Eso confunde, y lo que la gente hace cuando se confunde es
 * bloquear. Los bloqueos bajan la calificación de calidad del número, y con la
 * calificación en rojo Meta recorta los envíos — o sea que termina afectando
 * justo a los avisos de cobranza que sostienen la caja.
 *
 * ── Por qué es genérico ──
 *
 * Este sistema se vende, y el ISP que lo compra puede tener cualquier CRM. Así
 * que acá no hay ningún proveedor nombrado: hay un CONTRATO —a dónde, con qué
 * llave, y con qué forma— y cada CRM se adapta. Está documentado en
 * `docs/salida-whatsapp-crm.md`.
 *
 * ── Por qué no se manda el texto ya armado ──
 *
 * Porque fuera de la ventana de 24 horas WhatsApp solo entrega plantillas
 * aprobadas por Meta, y las plantillas aprobadas del CRM son las del CRM. Si le
 * mandáramos el texto listo, esos avisos no se podrían enviar nunca: el
 * proveedor tendría que adivinar a qué plantilla suya corresponde.
 *
 * Por eso viaja `purpose` —cómo se llama ese aviso del lado de ellos— más las
 * variables por nombre. El CRM elige la plantilla y rellena.
 */

/**
 * Entrega un aviso al CRM.
 *
 * @param config.url      endpoint al que se hace POST
 * @param config.llave    la credencial que dio el CRM
 * @param config.header   con qué cabecera viaja (`X-API-Key`, `Authorization`…)
 * @param config.nombre   cómo se llama, solo para los mensajes de error
 * @param plantilla       `{ purpose, variables }` — sin esto no se puede mandar
 * @param texto           el mensaje ya armado. Viaja como respaldo: si la
 *                        conversación está abierta, el CRM puede usarlo tal cual
 */
export async function enviar({ config, numero, texto, plantilla = null, referencia = null }) {
  // 'tu CRM' y no 'el CRM': encaja en las cuatro frases donde se usa. Con 'el'
  // salía "Falta la URL o la llave de el CRM".
  const quien = config.nombre || 'tu CRM'

  if (!config.url || !config.llave) {
    return { ok: false, error: `Falta la URL o la llave de ${quien}. Cargalas en Ajustes → Mensajería.` }
  }

  /**
   * Sin `purpose` no se manda.
   *
   * Es el equivalente de no tener plantilla aprobada en Meta: el CRM no va a
   * saber con qué plantilla suya entregarlo, y fuera de la ventana de 24 horas
   * el texto libre no pasa. Se avisa acá para que el aviso se caiga al SMS o al
   * correo, que sí van a llegar, en vez de darse por enviado.
   */
  if (!plantilla?.purpose) {
    return {
      ok: false,
      error: `Este aviso no tiene nombre del lado de ${quien}. Cargalo en Ajustes → Plantillas de WhatsApp, en el campo del CRM.`,
    }
  }

  const cuerpo = {
    phone: numero,
    purpose: plantilla.purpose,
    // Por nombre y no por posición: es lo que evita que el saldo termine en el
    // lugar de la fecha el día que alguien reordene una plantilla.
    variables: plantilla.variables ?? {},
    // El texto ya armado, por si la conversación está abierta y el CRM prefiere
    // mandarlo tal cual. Es opcional para él.
    text: texto ?? undefined,
    // Nuestra referencia, para poder conciliar después qué salió y qué no.
    external_ref: referencia ?? undefined,
  }

  const cabecera = config.header || 'X-API-Key'
  const valor =
    /^authorization$/i.test(cabecera) && !/^bearer\s/i.test(config.llave)
      ? `Bearer ${config.llave}`
      : config.llave

  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: { [cabecera]: valor, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(15000),
    })

    const json = await res.json().catch(() => null)

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `${quien} rechazó la llave. Revisala en Ajustes → Mensajería.` }
    }
    if (!res.ok) {
      return { ok: false, error: `${quien} devolvió ${res.status}${json?.error ? `: ${json.error}` : ''}` }
    }

    /**
     * Un 200 no siempre es un envío.
     *
     * Los CRM que aceptan lotes contestan 200 y detallan por mensaje: uno que
     * falle no puede tumbar los otros 499. Así que hay que mirar adentro —
     * `queued: false` con su motivo es un rechazo, aunque el HTTP diga que sí.
     */
    const detalle = Array.isArray(json?.results) ? json.results[0] : json

    if (detalle && detalle.queued === false) {
      return { ok: false, error: detalle.reason || `${quien} no pudo encolar el mensaje` }
    }

    return { ok: true, id: detalle?.queue_id ?? detalle?.id ?? json?.id ?? null }
  } catch (err) {
    return { ok: false, error: `No se pudo hablar con ${quien}: ${err.message}` }
  }
}

export async function estado({ config }) {
  const quien = config.nombre || 'CRM externo'
  return config.url && config.llave
    ? { conectado: true, detalle: `${quien} · ${config.url}` }
    : { conectado: false, detalle: 'Falta la URL o la llave del CRM' }
}

/**
 * Esta vía exige que el aviso tenga nombre del lado del CRM.
 *
 * No es una plantilla aprobada por nosotros —esa la aprueba el proveedor— pero
 * el efecto es el mismo: sin ella el aviso no sale por acá.
 */
export const exigePlantilla = true
