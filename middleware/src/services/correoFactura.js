import { db } from '../lib/db.js'
import { correoConFormato, logoDe } from './correoHtml.js'
import { dinero, fechaCorta, periodoDe } from './variablesAviso.js'
import { generarFacturaPdf } from '../pagos/facturaPdf.js'

/**
 * El correo de una factura: con formato, con las cuentas y con el PDF adjunto.
 *
 * ── Qué PDF va y cuál NO ──
 *
 * Va el estado de cuenta que arma el sistema: qué se le cobra, qué pagó y qué
 * debe. Ese lo recibe TODO el mundo.
 *
 * NO va el comprobante del SRI. Ese existe solo para quien pidió factura
 * electrónica, y recién cuando pagó el mes completo: mandarlo con la factura
 * sería entregar un comprobante fiscal de algo que todavía no se cobró.
 */

/**
 * El cuerpo de la plantilla, partido en los párrafos de la tarjeta.
 *
 * Las plantillas se escriben con `<p>` o con saltos de línea, según quién las
 * haya tocado. Se aceptan las dos formas: obligar a una sería que el ISP
 * descubra la regla equivocándose, y el precio del error es un correo que sale
 * todo pegado en un renglón.
 *
 * Se conserva el `<b>` y el `<a>` que haya escrito —son los que le dan énfasis a
 * un monto o a una fecha— y se descarta el resto de las etiquetas, que dentro de
 * la tarjeta romperían la maqueta.
 */
/**
 * El texto de una plantilla, como una sola línea para imprimir.
 *
 * ── Por qué no se puede usar el cuerpo tal cual ──
 *
 * Porque las plantillas se escriben con HTML —`<p>`, `<b>`, saltos de línea— y
 * un PDF no lo interpreta: imprimiría las etiquetas. Se limpian y se junta todo
 * en un renglón, que es lo que entra en el pie de la hoja.
 *
 * Los marcadores `{{...}}` se quitan en vez de dejarse: un papel que dice
 * "Gracias {{nombre}}" es peor que uno que dice "Gracias".
 */
export function leyendaDe(cuerpo) {
  if (!cuerpo) return null

  const texto = String(cuerpo)
    // Los saltos de párrafo se vuelven espacios antes de sacar las etiquetas,
    // si no, dos párrafos quedan pegados como una sola palabra.
    .replace(/<\/(p|div|li|h\d)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

  return texto || null
}

export function partirEnParrafos(cuerpo) {
  if (!cuerpo) return []

  const texto = String(cuerpo)
    // `<br>` y `</p>` valen como fin de párrafo.
    .replace(/<\/p\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    // Lo que queda: solo negrita, cursiva y enlaces.
    .replace(/<(?!\/?(b|strong|i|em|a)\b)[^>]+>/gi, '')

  return texto
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
}

/** Las cuentas que el ISP muestra para recibir pagos. */
export async function cuentasParaPagar() {
  const { data } = await db()
    .from('cuentas_pago')
    .select('nombre, tipo, banco, numero, titular, identificacion')
    .eq('activa', true)
    .eq('mostrar_en_corte', true)
    .order('nombre')

  return data ?? []
}

/** Adónde mandar el comprobante, y a qué portal entra el abonado. */
export async function comoAvisarYEntrar() {
  const { data } = await db()
    .from('config_corte')
    .select('whatsapp_pagos, telefono_pagos')
    .eq('id', 1)
    .maybeSingle()

  return {
    whatsapp: data?.whatsapp_pagos ?? null,
    telefono: data?.telefono_pagos ?? null,
    /**
     * El portal se arma con la URL pública del sistema.
     *
     * Sin `PORTAL_URL` en el entorno no se dibuja el botón. Un botón que lleva a
     * `localhost` es peor que ninguno: el abonado lo toca, no pasa nada, y deja
     * de confiar en el resto del correo.
     */
    portal: process.env.PORTAL_URL || null,
  }
}

/**
 * El PDF del estado de cuenta.
 *
 * Se arma con lo mismo que la pantalla de facturas, así que el papel que recibe
 * el abonado dice exactamente lo que ve la oficina. Si falla, el correo sale
 * igual sin adjunto: un aviso sin PDF es mucho mejor que ningún aviso.
 */
export async function pdfDeLaFactura(facturaId) {
  try {
    const { data: factura } = await db()
      .from('v_facturas').select('*').eq('id', facturaId).maybeSingle()
    if (!factura) return null

    const { data: pagos } = await db()
      .from('v_pagos').select('*').eq('factura_id', facturaId).order('fecha_pago')

    const { data: emisor } = await db().from('sri_config').select('*').limit(1).maybeSingle()

    let cliente = null
    if (factura.client_id) {
      const { data } = await db()
        .from('clientes')
        .select('nombre, identificacion, direccion, telefono')
        .eq('id', factura.client_id)
        .maybeSingle()
      cliente = data ?? null
    }

    /**
     * La leyenda que el ISP escribe en el editor de plantillas.
     *
     * Es la misma en el PDF que se adjunta al correo y en el que se imprime al
     * cobrar: son el mismo documento, y que digan cosas distintas según por dónde
     * salieron sería exactamente el problema que el editor viene a resolver.
     */
    const { data: plantillaRecibo } = await db()
      .from('plantillas_mensaje').select('cuerpo').eq('clave', 'doc_recibo')
      .eq('activa', true).maybeSingle()

    const pdf = await generarFacturaPdf({
      leyenda: leyendaDe(plantillaRecibo?.cuerpo),
      emisor: emisor ?? {},
      factura,
      pagos: pagos ?? [],
      cliente,
      logo: logoDe(emisor),
    })

    return {
      filename: `factura-${String(factura.numero ?? '').padStart(8, '0')}.pdf`,
      content: pdf,
      contentType: 'application/pdf',
    }
  } catch {
    // El adjunto es un extra. Que falle no puede impedir el aviso.
    return null
  }
}

/**
 * Arma el correo de una factura.
 *
 * `tipo` cambia el tono y nada más: los datos, las cuentas y el botón son los
 * mismos. Al abonado le sirve lo mismo el día que se emite la factura que el día
 * que está por cortársele — lo que cambia es la urgencia.
 */
export async function correoDeFactura({
  factura,
  cliente,
  tipo = 'nueva',
  fechaCorte = null,
  /**
   * El texto que escribió el ISP en el editor de plantillas.
   *
   * ── Por qué el texto viene de afuera y la tarjeta no ──
   *
   * Porque son dos cosas distintas. QUÉ dice el aviso lo decide el ISP: su tono,
   * su forma de tratar al abonado, si tutea o no. CÓMO se ve —el logo arriba, la
   * tabla de datos, las cuentas, el botón— no debería tener que escribirlo,
   * porque implica una tabla HTML que se vea bien en Outlook y eso no es trabajo
   * de quien administra un ISP.
   *
   * Sin esta puerta, editar la plantilla no cambiaba nada del correo y el editor
   * mentía: es el mismo error que se evitó con el RIDE.
   */
  plantilla = null,
}) {
  const [emisor, cuentas, contacto] = await Promise.all([
    db().from('sri_config').select('*').limit(1).maybeSingle().then((r) => r.data ?? {}),
    cuentasParaPagar(),
    comoAvisarYEntrar(),
  ])

  const total = Number(factura.total ?? factura.importe_total ?? 0)
  const saldo = Number(factura.saldo ?? total)
  const periodo = periodoDe(factura.concepto, factura.fecha_vencimiento)
  const vence = fechaCorta(factura.fecha_vencimiento)

  const TONOS = {
    nueva: {
      titulo: `Su factura de ${periodo}`,
      parrafos: [
        `Emitimos su factura de <b>${periodo}</b>. Adjuntamos el detalle en PDF.`,
      ],
      cierre: null,
    },
    recordatorio: {
      titulo: `Su factura de ${periodo} vence pronto`,
      parrafos: [`Le recordamos que su factura de <b>${periodo}</b> vence el <b>${vence}</b>.`],
      cierre: 'Si ya realizó el pago, le pedimos disculpas y puede ignorar este mensaje.',
    },
    vencida: {
      titulo: `Su factura de ${periodo} está vencida`,
      parrafos: [
        `Su factura de <b>${periodo}</b> venció el <b>${vence}</b> y figura pendiente de pago.`,
        fechaCorte
          ? `Puede regularizarla hasta el <b>${fechaCorte}</b> para evitar la suspensión del servicio.`
          : null,
      ],
      cierre: 'Si ya realizó el pago, le pedimos disculpas y puede ignorar este mensaje.',
    },
    ultimo: {
      titulo: 'Último aviso antes de la suspensión',
      parrafos: [
        fechaCorte
          ? `Su servicio será suspendido el <b>${fechaCorte}</b> por un saldo pendiente de <b>${dinero(saldo)}</b>.`
          : `Su servicio será suspendido por un saldo pendiente de <b>${dinero(saldo)}</b>.`,
        'Apenas registremos su pago, el servicio se reactiva automáticamente.',
      ],
      cierre: 'Si ya realizó el pago, escríbanos para regularizar su cuenta.',
    },
  }

  /**
   * Manda lo que escribió el ISP; los textos de arriba son el respaldo.
   *
   * El respaldo importa: si alguien desactiva la plantilla o la deja vacía, el
   * aviso tiene que salir igual. Un correo con el texto de fábrica es mucho
   * mejor que un correo en blanco — o que ninguno.
   */
  const base = TONOS[tipo] ?? TONOS.nueva
  const propio = partirEnParrafos(plantilla?.cuerpo)

  const t = {
    titulo: plantilla?.asunto?.trim() || base.titulo,
    parrafos: propio.length ? propio : base.parrafos,
    // El cierre solo va con el texto de fábrica: si el ISP escribió el suyo, ya
    // dijo todo lo que quería decir y agregarle una línea sería contradecirlo.
    cierre: propio.length ? null : base.cierre,
  }

  const adjunto = factura.id ? await pdfDeLaFactura(factura.id) : null

  const armado = correoConFormato({
    empresa: emisor,
    titulo: t.titulo,
    saludo: `Estimado/a ${cliente?.nombre ?? ''}:`,
    parrafos: t.parrafos,
    datos: [
      ['Factura N°', factura.numero != null ? String(factura.numero) : null],
      ['Emitida el', fechaCorta(factura.fecha_emision)],
      ['Vence el', vence],
      ['Período', periodo],
      ['Total', dinero(total)],
      // El saldo solo cuando difiere del total: repetir el mismo número dos
      // veces hace dudar de cuál hay que pagar.
      ...(Math.abs(saldo - total) > 0.005 ? [['Saldo pendiente', dinero(saldo)]] : []),
      ['Estado', saldo > 0.005 ? 'PENDIENTE' : 'PAGADA'],
    ],
    // Las cuentas solo si hay algo que cobrar. En una factura ya pagada serían
    // una invitación a pagar dos veces.
    cuentasPago: saldo > 0.005 ? cuentas : [],
    whatsappPagos: saldo > 0.005 ? contacto.whatsapp : null,
    telefonoPagos: saldo > 0.005 ? contacto.telefono : null,
    botonTexto: 'Ingresar a mi cuenta',
    botonUrl: contacto.portal,
    cierre: t.cierre,
    logo: logoDe(emisor),
    adjuntos: adjunto ? [adjunto] : [],
  })

  return { asunto: t.titulo, ...armado }
}
