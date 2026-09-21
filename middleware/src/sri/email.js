/**
 * Envío del comprobante al comprador: el XML autorizado y el RIDE.
 *
 * El SRI obliga a entregarle al comprador el XML autorizado —no el PDF: el PDF
 * es la representación, el XML es el comprobante—. Por eso el correo lleva los
 * dos adjuntos y no un enlace: un enlace se cae, un adjunto queda en la casilla
 * del cliente aunque este sistema desaparezca.
 *
 * El armado del mensaje está separado del envío para poder probar el texto y
 * los adjuntos sin abrir una conexión SMTP.
 */

import nodemailer from 'nodemailer'

const numeroComprobante = (doc) =>
  `${doc.establecimiento ?? '001'}-${doc.punto_emision ?? '001'}-${String(doc.secuencial ?? '').padStart(9, '0')}`

/** dd/mm/aaaa, que es como se lee una fecha en una factura. */
function fechaLegible(valor) {
  const iso = String(valor ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return String(valor ?? '')
  const [a, m, d] = iso.split('-')
  return `${d}/${m}/${a}`
}

const dinero = (n) => `$${(Number(n) || 0).toFixed(2)}`

/** Escapa lo que va dentro del HTML del correo. */
function escaparHtml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Asunto y cuerpo del correo.
 *
 * El asunto lleva el número y el emisor porque es lo que el abonado ve en la
 * bandeja: "Factura" a secas no le dice de quién es cuando tiene servicios de
 * varios proveedores.
 */
export function armarCorreo({ emisor = {}, documento, campos = [] }) {
  const numero = numeroComprobante(documento)
  const nombreEmisor = emisor.nombre_comercial || emisor.razon_social || ''

  // El texto del período ya está resuelto dentro del comprobante: se reusa acá
  // en vez de recalcularlo, así el correo dice exactamente lo mismo que el RIDE.
  // Viene partido en varios campos porque el SRI corta en 300 caracteres, así
  // que se vuelve a unir para leerlo de corrido.
  const descripcion = campos
    .filter((c) => /descripci/i.test(c.nombre))
    .map((c) => c.valor)
    .join(' ')
    .trim()

  const asunto = `Factura ${numero} — ${nombreEmisor}`

  const lineas = [
    `Estimado/a ${documento.razon_social_comprador},`,
    '',
    `Adjuntamos su factura electrónica ${numero} por ${dinero(documento.importe_total)}, ` +
      `emitida el ${fechaLegible(documento.fecha_emision)} y autorizada por el SRI.`,
    '',
    `Clave de acceso: ${documento.clave_acceso}`,
    documento.numero_autorizacion ? `Autorización: ${documento.numero_autorizacion}` : '',
    '',
    descripcion,
    '',
    'Van dos archivos: el XML es el comprobante con validez tributaria y el PDF es su ' +
      'representación impresa.',
    '',
    nombreEmisor,
    emisor.telefono ? `Teléfono: ${emisor.telefono}` : '',
  ].filter((l) => l !== undefined)

  const texto = lineas.join('\n')

  const html = `<!doctype html>
<html lang="es"><body style="margin:0;background:#f4f5f7;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;border:1px solid #e5e7eb">
    <tr><td style="padding:22px 26px">
      <h1 style="margin:0 0 4px;font-size:17px">Factura ${escaparHtml(numero)}</h1>
      <p style="margin:0 0 18px;font-size:13px;color:#6b7280">${escaparHtml(nombreEmisor)}</p>

      <p style="margin:0 0 14px;font-size:14px">Estimado/a <b>${escaparHtml(documento.razon_social_comprador)}</b>,</p>
      <p style="margin:0 0 18px;font-size:14px">
        Adjuntamos su factura electrónica por <b>${dinero(documento.importe_total)}</b>,
        emitida el ${escaparHtml(fechaLegible(documento.fecha_emision))} y autorizada por el SRI.
      </p>

      <table role="presentation" width="100%" cellpadding="6" cellspacing="0" style="font-size:12px;background:#f9fafb;border-radius:8px">
        <tr><td style="color:#6b7280">Comprobante</td><td align="right"><b>${escaparHtml(numero)}</b></td></tr>
        <tr><td style="color:#6b7280">Fecha de emisión</td><td align="right">${escaparHtml(fechaLegible(documento.fecha_emision))}</td></tr>
        <tr><td style="color:#6b7280">Total</td><td align="right"><b>${dinero(documento.importe_total)}</b></td></tr>
        <tr><td style="color:#6b7280">Clave de acceso</td><td align="right" style="font-family:monospace;font-size:10px;word-break:break-all">${escaparHtml(documento.clave_acceso)}</td></tr>
      </table>

      ${descripcion ? `<p style="margin:18px 0 0;font-size:12px;color:#4b5563">${escaparHtml(descripcion)}</p>` : ''}

      <p style="margin:18px 0 0;font-size:12px;color:#6b7280">
        Se adjuntan dos archivos: el <b>XML</b> es el comprobante con validez tributaria y el
        <b>PDF</b> es su representación impresa (RIDE).
      </p>
    </td></tr>
    <tr><td style="padding:14px 26px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af">
      ${escaparHtml(nombreEmisor)}${emisor.telefono ? ` · ${escaparHtml(emisor.telefono)}` : ''}
      <br>Este correo se genera automáticamente al autorizarse el comprobante.
    </td></tr>
  </table>
</body></html>`

  return { asunto, texto, html }
}

/**
 * Adjuntos del correo.
 *
 * Los dos archivos se nombran con la clave de acceso: es el identificador que
 * usa el SRI, así que el cliente puede buscarlos por ese número cuando pide un
 * duplicado.
 */
export function adjuntosDe({ documento, xml, pdf }) {
  const adjuntos = []

  if (xml) {
    adjuntos.push({
      filename: `${documento.clave_acceso}.xml`,
      content: xml,
      contentType: 'application/xml; charset=utf-8',
    })
  }

  if (pdf) {
    adjuntos.push({
      filename: `${documento.clave_acceso}.pdf`,
      content: pdf,
      contentType: 'application/pdf',
    })
  }

  return adjuntos
}

/**
 * Qué falta para poder mandar un correo.
 * Se devuelve la lista completa en vez del primer problema: así se completa la
 * configuración de una vez y no de a un campo por intento.
 */
export function faltantesSmtp(config = {}) {
  const faltan = []
  if (!config.smtp_host) faltan.push('el servidor SMTP')
  if (!config.smtp_user) faltan.push('el usuario')
  if (!config.smtp_pass_encrypted) faltan.push('la contraseña')
  if (!config.email_from && !config.smtp_user) faltan.push('la dirección remitente')
  return faltan
}

/**
 * Qué cifrado corresponde a un puerto.
 *
 * ── Por qué el puerto manda sobre lo que diga la configuración ──
 *
 * Porque en los dos puertos que se usan de verdad no es una preferencia, es el
 * protocolo: el 465 es SMTPS y habla TLS desde el saludo; el 587 arranca en
 * claro y sube con STARTTLS. Un 465 sin TLS no existe.
 *
 * Antes se respetaba `smtp_secure` tal como estuviera guardado, y la columna
 * nace en `false` porque ninguna pantalla la muestra. Resultado: quien cargaba
 * Gmail en el 465 —lo más común— se topaba con "Greeting never received", que no
 * le dice nada a nadie. El servidor esperaba un saludo cifrado y recibía texto
 * plano, así que no contestaba nunca.
 *
 * Para cualquier otro puerto sí se respeta lo guardado: ahí no hay una respuesta
 * correcta y quien lo configuró sabe más que este código.
 */
export function cifradoDelPuerto(puerto, guardado = null) {
  if (puerto === 465) return true
  if (puerto === 587 || puerto === 25) return false
  return Boolean(guardado)
}

/**
 * Transporte SMTP a partir de la configuración del emisor.
 */
export function crearTransporte(config, password) {
  const puerto = Number(config.smtp_port) || 587
  const seguro = cifradoDelPuerto(puerto, config.smtp_secure)

  return nodemailer.createTransport({
    host: config.smtp_host,
    port: puerto,
    secure: Boolean(seguro),
    auth: { user: config.smtp_user, pass: password },
    // Un servidor que no contesta no puede dejar colgado el pedido del navegador.
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  })
}

/** Remitente con nombre visible, si está configurado. */
export function remitente(config) {
  const direccion = config.email_from || config.smtp_user
  return config.email_from_name ? `"${config.email_from_name}" <${direccion}>` : direccion
}

/**
 * Manda el comprobante.
 *
 * @returns {Promise<{ messageId: string, aceptados: string[], rechazados: string[] }>}
 */
export async function enviarComprobantePorEmail({
  config,
  password,
  documento,
  campos = [],
  xml,
  pdf,
  para,
  copia,
}) {
  const destino = para || documento.email_comprador
  if (!destino) throw new Error('No hay dirección de correo del comprador')

  const { asunto, texto, html } = armarCorreo({ emisor: config, documento, campos })
  const transporte = crearTransporte(config, password)

  try {
    const r = await transporte.sendMail({
      from: remitente(config),
      to: destino,
      ...(copia ? { cc: copia } : {}),
      subject: asunto,
      text: texto,
      html,
      attachments: adjuntosDe({ documento, xml, pdf }),
    })

    return {
      messageId: r.messageId,
      aceptados: r.accepted ?? [],
      rechazados: r.rejected ?? [],
      destino,
    }
  } finally {
    // El pool queda abierto y el proceso no termina si no se cierra.
    transporte.close()
  }
}
