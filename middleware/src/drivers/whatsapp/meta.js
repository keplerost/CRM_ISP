/**
 * WhatsApp por la Cloud API de Meta: la oficial.
 *
 * Sin riesgo de que bloqueen el número y con entrega confiable. A cambio pide
 * una empresa verificada y —para los mensajes que inicia la empresa fuera de
 * una ventana de 24 horas— plantillas aprobadas de antemano.
 *
 * ── Y esa ventana casi nunca está abierta ──
 *
 * Se cuenta desde el último mensaje que escribió EL ABONADO. Nuestros avisos
 * automáticos son todos al revés: el abonado no le escribe al ISP para que le
 * avisen que se le vence la factura. Así que en la práctica, todo lo que sale
 * solo tiene que ir como plantilla.
 *
 * Mandar texto libre ahí devuelve el error 131047 y el mensaje NO SALE. Peor:
 * el abonado no se entera de que le van a cortar y el sistema lo cuenta como
 * intento. Por eso `enviar` recibe `plantilla` y, cuando la tiene, manda
 * `type: "template"`.
 */

/**
 * Los parámetros de una plantilla, como los acepta Meta.
 *
 * Tres reglas que rechazan el envío entero si no se cumplen, y que es más
 * barato arreglar acá que descubrir leyendo un log:
 *
 *   * Ningún parámetro puede tener saltos de línea ni tabulaciones.
 *   * Ninguno puede tener cuatro espacios seguidos.
 *   * Ninguno puede venir vacío.
 *
 * Los dos primeros se corrigen en silencio: un salto de línea de más en el
 * nombre de una empresa no es motivo para que el aviso de corte no salga. El
 * tercero no se corrige, se avisa: un "su saldo pendiente es de " sin número es
 * peor que no mandar nada.
 */
function parametrosDe(valores = []) {
  return valores.map((v, i) => {
    const limpio = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim()
    if (!limpio) {
      throw new Error(
        `La plantilla necesita el valor {{${i + 1}}} y llegó vacío. Revisá las variables del aviso.`,
      )
    }
    return { type: 'text', text: limpio }
  })
}

export async function enviar({ config, numero, texto, plantilla = null }) {
  if (!config.token || !config.phoneId) {
    return { ok: false, error: 'Falta el token o el phone_id de la Cloud API' }
  }

  let cuerpo
  try {
    cuerpo = plantilla
      ? {
          messaging_product: 'whatsapp',
          to: numero,
          type: 'template',
          template: {
            name: plantilla.nombre,
            language: { code: plantilla.idioma || 'es' },
            // Una plantilla sin variables no lleva `components`: mandarlo vacío
            // hace que Meta conteste que sobran parámetros.
            ...(plantilla.parametros?.length
              ? { components: [{ type: 'body', parameters: parametrosDe(plantilla.parametros) }] }
              : {}),
          },
        }
      : {
          messaging_product: 'whatsapp',
          to: numero,
          type: 'text',
          text: { body: texto },
        }
  } catch (err) {
    return { ok: false, error: err.message }
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${config.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(15000),
    })

    const json = await res.json().catch(() => null)
    if (json?.error) return { ok: false, error: explicar(json.error) }
    if (!res.ok) return { ok: false, error: `Meta devolvió ${res.status}` }

    // El acuse real llega después por webhook: acá solo se sabe que lo aceptaron.
    return { ok: true, id: json?.messages?.[0]?.id ?? null }
  } catch (err) {
    return { ok: false, error: `No se pudo hablar con Meta: ${err.message}` }
  }
}

/**
 * Los errores de Meta, dichos de forma que se pueda actuar.
 *
 * El mensaje crudo de la Cloud API describe la regla violada, no qué hacer.
 * "Message failed to send because more than 24 hours have passed" es correcto y
 * no le dice a nadie que lo que falta es aprobar una plantilla.
 */
function explicar(error) {
  const codigo = error?.code
  const detalle = error?.error_data?.details || error?.message || 'Meta rechazó el mensaje'

  if (codigo === 131047) {
    return 'Pasaron más de 24 horas desde el último mensaje del abonado: fuera de esa ventana solo se puede mandar una plantilla aprobada. Registrala en Ajustes → Plantillas de WhatsApp.'
  }
  if (codigo === 132001) {
    return `Esa plantilla no existe en Meta o está en otro idioma: ${detalle}`
  }
  if (codigo === 132000 || codigo === 132005) {
    return `La cantidad de variables no coincide con la plantilla aprobada: ${detalle}`
  }
  if (codigo === 132015 || codigo === 132007) {
    return `Meta pausó o rechazó esa plantilla por calidad: ${detalle}`
  }
  if (codigo === 131026) {
    return 'Ese número no tiene WhatsApp o no puede recibir mensajes.'
  }
  if (codigo === 130472) {
    return 'El abonado está en una experiencia donde Meta no entrega mensajes de marketing. Verificá que la plantilla esté registrada como UTILITY.'
  }
  if (codigo === 131048 || codigo === 130429) {
    return 'Se alcanzó el límite de envíos del número. Meta lo levanta solo a medida que sube la calificación de calidad.'
  }
  return detalle
}

export async function estado({ config }) {
  return config.token && config.phoneId
    ? { conectado: true, detalle: `Cloud API · phone_id ${config.phoneId}` }
    : { conectado: false, detalle: 'Sin token o sin phone_id' }
}

/** Esta vía exige plantilla aprobada para todo lo que sale solo. */
export const exigePlantilla = true
