/**
 * El correo con formato: logo, datos, cuentas y botón.
 *
 * ── Por qué se arma con TABLAS y estilos pegados a cada etiqueta ──
 *
 * Porque un correo no es una página web. Gmail borra la etiqueta `<style>` del
 * encabezado, Outlook usa el motor de Word para maquetar, y ninguno de los dos
 * entiende flexbox ni grid. Lo único que se ve igual en todos desde veinte años
 * es una tabla con `style` en cada celda.
 *
 * Escribirlo con CSS moderno haría un correo que se ve perfecto en la pantalla
 * de quien lo programó y descuadrado en el teléfono del abonado, que es el
 * único lugar donde importa.
 *
 * ── Por qué el logo va como adjunto y no como enlace ──
 *
 * Gmail y Outlook bloquean las imágenes remotas hasta que el lector aprieta
 * "mostrar imágenes", y la mayoría no lo aprieta: el correo llegaría sin logo.
 * Como adjunto embebido —`cid:`— se ve siempre, sin pedir permiso.
 *
 * Tampoco sirve `data:` en el `src`: Gmail lo descarta directamente.
 */

import { iconoWhatsapp } from './iconoPng.js'

const ANCHO = 600

// Los colores se repiten en cada celda porque no hay hoja de estilos que valga.
const C = {
  texto: '#1f2937',
  suave: '#6b7280',
  borde: '#e5e7eb',
  fondo: '#f3f4f6',
  papel: '#ffffff',
  acento: '#0284c7',
  alerta: '#b45309',
  alertaFondo: '#fffbeb',
  // El verde de WhatsApp. Es el que la gente reconoce sin leer.
  whatsapp: '#25D366',
}

const escapar = (t) =>
  String(t ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c])

/** Una fila de dato: etiqueta en negrita y valor al lado. */
function dato(etiqueta, valor) {
  if (valor == null || valor === '') return ''
  return `
      <tr>
        <td style="padding:3px 12px 3px 0;font:600 14px/1.5 Arial,Helvetica,sans-serif;color:${C.texto};white-space:nowrap">${escapar(etiqueta)}</td>
        <td style="padding:3px 0;font:14px/1.5 Arial,Helvetica,sans-serif;color:${C.texto}">${escapar(valor)}</td>
      </tr>`
}

/**
 * Las cuentas donde depositar.
 *
 * Van en el cuerpo del correo y no detrás de un enlace porque es lo que el
 * abonado necesita tener a mano justo cuando abre el mensaje: si tiene que
 * entrar a un sitio para averiguar a dónde pagar, no paga.
 */
function cuentas(lista) {
  if (!lista?.length) return ''

  const filas = lista
    .map(
      (c) => `
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid ${C.borde};font:14px/1.4 Arial,Helvetica,sans-serif;color:${C.texto}">
            <b>${escapar(c.banco || c.nombre)}</b>${c.tipo && c.tipo !== 'banco' ? ` · ${escapar(c.tipo)}` : ''}<br>
            <span style="font:13px/1.6 Arial,Helvetica,sans-serif;color:${C.suave}">
              Cuenta <b style="color:${C.texto}">${escapar(c.numero)}</b>${c.titular ? `<br>${escapar(c.titular)}` : ''}${c.identificacion ? ` · ${escapar(c.identificacion)}` : ''}
            </span>
          </td>
        </tr>`,
    )
    .join('')

  return `
    <tr><td style="padding:22px 28px 0">
      <p style="margin:0 0 8px;font:600 14px/1.5 Arial,Helvetica,sans-serif;color:${C.texto}">
        Dónde puede pagar
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="border:1px solid ${C.borde};border-radius:6px;border-collapse:separate">
        ${filas}
      </table>
    </td></tr>`
}

/**
 * A dónde mandar el comprobante.
 *
 * Es la mitad que suele faltar: el abonado deposita y nadie se entera, así que
 * sigue figurando como impago y se lo termina cortando habiendo pagado.
 */
function avisarElPago(whatsapp, telefono, mensajeWa = null) {
  const numero = whatsapp || telefono
  if (!numero) return ''

  const soloDigitos = String(numero).replace(/\D/g, '')
  const internacional = soloDigitos.startsWith('593')
    ? soloDigitos
    : `593${soloDigitos.replace(/^0+/, '')}`

  /**
   * El enlace lleva el mensaje ya escrito.
   *
   * El abonado toca, se le abre WhatsApp con "Adjunto el comprobante de la
   * factura N° 36" listo, y solo tiene que agregar la foto. Sin eso escribe lo
   * que se le ocurre, y del otro lado hay que adivinar de qué factura habla.
   */
  const conTexto = mensajeWa
    ? `https://wa.me/${internacional}?text=${encodeURIComponent(mensajeWa)}`
    : `https://wa.me/${internacional}`

  // El botón de WhatsApp. Verde de la marca, y con el ícono dibujado con
  // caracteres para que no dependa de ninguna imagen: un botón que se ve
  // siempre vale más que uno bonito que a veces no carga.
  const botonWa = whatsapp
    ? `
        <tr><td align="center" style="padding:12px 0 2px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr><td align="center" bgcolor="${C.whatsapp}" style="border-radius:24px">
              <a href="${conTexto}"
                 style="display:inline-block;padding:12px 26px;font:600 15px/1 Arial,Helvetica,sans-serif;color:#ffffff;text-decoration:none">
                <img src="cid:icono-whatsapp" width="18" height="18" alt=""
                     style="display:inline-block;vertical-align:middle;border:0;margin-right:8px">
                Enviar comprobante por WhatsApp
              </a>
            </td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:0 0 4px;font:13px/1.6 Arial,Helvetica,sans-serif;color:${C.alerta}">
          ${escapar(numero)}
        </td></tr>`
    : `
        <tr><td align="center" style="padding:8px 0;font:600 15px/1.6 Arial,Helvetica,sans-serif;color:${C.alerta}">
          ${escapar(numero)}
        </td></tr>`

  return `
    <tr><td style="padding:18px 28px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:${C.alertaFondo};border:1px solid #fde68a;border-radius:6px">
        <tr><td style="padding:14px 14px 4px;font:14px/1.6 Arial,Helvetica,sans-serif;color:${C.alerta};text-align:center">
          <b>Después de pagar, envíenos el comprobante</b><br>
          <span style="font-size:13px">Es lo que nos permite registrar su pago y evitar la suspensión.</span>
        </td></tr>
        ${botonWa}
        <tr><td style="padding:0 14px 12px"></td></tr>
      </table>
    </td></tr>`
}

/**
 * El botón.
 *
 * Se dibuja con una tabla y un fondo en la celda, no con un `<a>` estilizado:
 * Outlook ignora `padding` en los enlaces y el botón sale como texto suelto.
 */
function boton(texto, url) {
  if (!url) return ''
  return `
    <tr><td style="padding:24px 28px 0" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr><td align="center" bgcolor="${C.acento}" style="border-radius:6px">
          <a href="${escapar(url)}"
             style="display:inline-block;padding:12px 28px;font:600 15px/1 Arial,Helvetica,sans-serif;color:#ffffff;text-decoration:none">
            ${escapar(texto)}
          </a>
        </td></tr>
      </table>
    </td></tr>`
}

/**
 * Arma el correo completo.
 *
 * Devuelve el HTML, el texto plano y los adjuntos. El texto plano no es un
 * adorno: hay clientes que lo muestran, y los filtros de spam desconfían de un
 * correo que solo trae HTML.
 */
export function correoConFormato({
  empresa = {},
  titulo,
  saludo,
  parrafos = [],
  datos = [],
  cuentasPago = [],
  whatsappPagos = null,
  telefonoPagos = null,
  /** El texto que ya viene escrito al abrir WhatsApp. */
  mensajeWhatsapp = null,
  botonTexto = null,
  botonUrl = null,
  cierre = null,
  logo = null,
  adjuntos = [],
}) {
  const nombreEmpresa = empresa.nombre_comercial || empresa.razon_social || ''

  const encabezado = logo
    ? `<img src="cid:logo-isp" alt="${escapar(nombreEmpresa)}" width="180"
            style="display:block;border:0;max-width:180px;height:auto">`
    : `<span style="font:700 22px/1.2 Arial,Helvetica,sans-serif;color:${C.texto}">${escapar(nombreEmpresa)}</span>`

  const cuerpoParrafos = parrafos
    .filter(Boolean)
    .map(
      (p) => `
      <p style="margin:0 0 12px;font:14px/1.6 Arial,Helvetica,sans-serif;color:${C.texto}">${p}</p>`,
    )
    .join('')

  const tablaDatos = datos.length
    ? `
    <tr><td style="padding:6px 28px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        ${datos.map(([e, v]) => dato(e, v)).join('')}
      </table>
    </td></tr>`
    : ''

  const html = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapar(titulo ?? nombreEmpresa)}</title></head>
<body style="margin:0;padding:0;background:${C.fondo}">
  <!-- El preheader: lo que se lee en la lista de correos antes de abrirlo. Sin
       esto, el cliente muestra el principio del HTML y se ve basura. -->
  <div style="display:none;max-height:0;overflow:hidden">${escapar(titulo ?? '')}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.fondo}">
    <tr><td align="center" style="padding:24px 12px">

      <table role="presentation" width="${ANCHO}" cellpadding="0" cellspacing="0" border="0"
             style="width:100%;max-width:${ANCHO}px;background:${C.papel};border:1px solid ${C.borde};border-radius:8px">

        <tr><td style="padding:24px 28px;border-bottom:1px solid ${C.borde}">${encabezado}</td></tr>

        <tr><td style="padding:24px 28px 0">
          ${saludo ? `<p style="margin:0 0 14px;font:600 15px/1.5 Arial,Helvetica,sans-serif;color:${C.texto}">${escapar(saludo)}</p>` : ''}
          ${cuerpoParrafos}
        </td></tr>

        ${tablaDatos}
        ${cuentas(cuentasPago)}
        ${avisarElPago(whatsappPagos, telefonoPagos, mensajeWhatsapp)}
        ${boton(botonTexto, botonUrl)}

        ${cierre
          ? `<tr><td style="padding:22px 28px 0">
               <p style="margin:0;font:14px/1.6 Arial,Helvetica,sans-serif;color:${C.suave}">${cierre}</p>
             </td></tr>`
          : ''}

        <tr><td style="padding:24px 28px 26px">
          <p style="margin:0;font:13px/1.6 Arial,Helvetica,sans-serif;color:${C.suave}">
            ${escapar(nombreEmpresa)}${empresa.telefono ? ` · ${escapar(empresa.telefono)}` : ''}${empresa.email ? ` · ${escapar(empresa.email)}` : ''}${
              /**
               * El sitio web, si el ISP lo tiene cargado.
               *
               * Va sin enlace a propósito: un `<a>` más en el pie le da a los
               * filtros de correo una razón más para mirar el mensaje con
               * desconfianza, y el que quiere entrar ya tiene el botón de arriba.
               */
              empresa.web ? ` · ${escapar(empresa.web)}` : ''
            }
          </p>
        </td></tr>
      </table>

      <p style="margin:14px 0 0;font:12px/1.5 Arial,Helvetica,sans-serif;color:${C.suave}">
        Este mensaje se envió automáticamente. Si ya realizó el pago, puede ignorarlo.
      </p>

    </td></tr>
  </table>
</body>
</html>`

  // ── El mismo mensaje en texto plano ──
  const lineas = [
    nombreEmpresa,
    '',
    saludo ?? '',
    '',
    ...parrafos.map((p) => p.replace(/<[^>]+>/g, '')),
    '',
    ...datos.filter(([, v]) => v != null && v !== '').map(([e, v]) => `${e} ${v}`),
  ]

  if (cuentasPago?.length) {
    lineas.push('', 'Dónde puede pagar:')
    for (const c of cuentasPago) {
      lineas.push(`  ${c.banco || c.nombre} — cuenta ${c.numero}${c.titular ? ` (${c.titular})` : ''}`)
    }
  }

  const numeroAviso = whatsappPagos || telefonoPagos
  if (numeroAviso) {
    lineas.push('', `Después de pagar, envíenos el comprobante al ${numeroAviso}.`)
  }

  if (botonUrl) lineas.push('', `${botonTexto ?? 'Ver más'}: ${botonUrl}`)
  if (cierre) lineas.push('', cierre.replace(/<[^>]+>/g, ''))

  const todos = [...adjuntos]

  // El ícono viaja con el correo, como el logo: una imagen enlazada se ve rota
  // el día que cambie la ruta, en todos los correos ya enviados.
  if (whatsappPagos) {
    todos.push({ filename: 'whatsapp.png', content: iconoWhatsapp(), cid: 'icono-whatsapp' })
  }

  if (logo) {
    todos.push({
      filename: 'logo.png',
      content: logo,
      // El `cid` es lo que ata el adjunto al `<img src="cid:logo-isp">`.
      cid: 'logo-isp',
    })
  }

  return { html, texto: lineas.join('\n').replace(/\n{3,}/g, '\n\n'), adjuntos: todos }
}

/** Decodifica un logo guardado como data URL o base64 pelado. */
export function logoDe(config) {
  if (!config?.logo_b64) return null
  try {
    const limpio = String(config.logo_b64)
      .replace(/^data:[^;]+;base64,/, '')
      .replace(/\s/g, '')
    return limpio ? Buffer.from(limpio, 'base64') : null
  } catch {
    return null
  }
}
