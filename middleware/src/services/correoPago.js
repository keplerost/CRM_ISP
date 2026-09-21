import { db } from '../lib/db.js'
import { correoConFormato, logoDe } from './correoHtml.js'
import {
  comoAvisarYEntrar,
  cuentasParaPagar,
  partirEnParrafos,
  pdfDeLaFactura,
} from './correoFactura.js'
import { dinero, fechaCorta } from './variablesAviso.js'

/**
 * El acuse de recibo del pago, como tarjeta.
 *
 * ── Por qué existe este archivo ──
 *
 * El acuse salía como texto plano con las etiquetas a la vista: el abonado leía
 * literalmente `<p>Estimado/a Juan:</p>`. Los avisos de factura ya salían como
 * tarjeta —logo, resumen, PDF adjunto— porque pasan por `correoDeFactura`; este
 * se mandaba con el cuerpo crudo de la plantilla.
 *
 * ── Qué decide el ISP y qué decide el sistema ──
 *
 * El ISP escribe el TEXTO en Ajustes → Editor de plantillas → Correos, igual que
 * los avisos de pago: su tono, si tutea, qué agradece.
 *
 * El sistema arma la TARJETA: el logo, el resumen del pago, el botón y el pie.
 * Eso implica tablas HTML que se vean bien en Outlook, y no es trabajo de quien
 * administra un ISP. Es la misma división que ya usan la factura y el RIDE.
 *
 * ── Por qué el resumen va en tabla y no en el texto ──
 *
 * Porque son los datos que el abonado busca con la vista —cuánto, cuándo, qué
 * factura— y en medio de un párrafo se pierden. Además, escritos en el texto
 * habría que mantener los marcadores a mano; acá salen del pago que ocurrió.
 */

/**
 * Arma el correo de una confirmación de pago.
 *
 * `pago` es la fila de la cola de avisos: trae el monto, la fecha, la factura que
 * se saldó y el número de cuenta del abonado.
 */
export async function correoDePago({ pago = {}, cliente = {}, plantilla = null }) {
  const [emisor, contacto, cuentas] = await Promise.all([
    db().from('sri_config').select('*').limit(1).maybeSingle().then((r) => r.data ?? {}),
    comoAvisarYEntrar(),
    cuentasParaPagar(),
  ])

  const monto = Number(pago.monto ?? 0)
  const saldo = Number(pago.saldo ?? 0)
  const alDia = saldo <= 0.005

  /**
   * El texto de fábrica, por si la plantilla está vacía o desactivada.
   *
   * Un acuse con el texto de fábrica es mucho mejor que uno en blanco — y mucho
   * mejor que ninguno, porque el abonado que no recibe acuse llama, o vuelve a
   * pagar.
   */
  const respaldo = [
    'Confirmamos que hemos procesado exitosamente el pago correspondiente a su factura de servicio de internet.',
    pago.factura_id ? 'Adjunto a este correo encontrará su comprobante en formato PDF.' : null,
    alDia
      ? 'Su cuenta queda al día. Gracias por su preferencia y confianza en nuestros servicios.'
      : `Queda un saldo pendiente de <b>${dinero(saldo)}</b>.`,
  ]

  const propio = partirEnParrafos(plantilla?.cuerpo)

  const titulo = plantilla?.asunto?.trim()
    || (alDia
      ? 'Confirmación de pago recibido — Su servicio está al día'
      : 'Confirmación de pago recibido')

  const adjunto = pago.factura_id ? await pdfDeLaFactura(pago.factura_id) : null

  const armado = correoConFormato({
    empresa: emisor,
    titulo,
    saludo: `Estimado/a ${cliente.nombre ?? pago.nombre ?? ''}:`,
    parrafos: propio.length ? propio : respaldo,
    datos: [
      ['Cliente', cliente.nombre ?? pago.nombre ?? null],
      // El número de cuenta es el que el abonado dice por teléfono y el que pone
      // en la transferencia: es como se reconoce.
      ['N° de cuenta', pago.codigo != null ? String(pago.codigo) : null],
      ['Factura N°', pago.factura_numero != null ? String(pago.factura_numero) : null],
      ['Monto pagado', dinero(monto)],
      ['Forma de pago', pago.forma_pago ?? null],
      ['Fecha de pago', fechaCorta(pago.fecha_pago)],
      /**
       * El saldo, solo si quedó algo.
       *
       * "Saldo pendiente: $0.00" en un acuse de pago es una línea que hace dudar:
       * el abonado la lee dos veces para asegurarse de que no debe nada. El
       * estado de arriba ya lo dice mejor.
       */
      ...(alDia ? [['Estado', 'AL DÍA']] : [['Saldo pendiente', dinero(saldo)]]),
    ],
    /**
     * Las cuentas para pagar, solo si todavía debe.
     *
     * En un acuse de pago completo serían una invitación a pagar dos veces — que
     * es exactamente el problema que este correo viene a evitar.
     */
    cuentasPago: alDia ? [] : cuentas,
    whatsappPagos: alDia ? null : contacto.whatsapp,
    telefonoPagos: alDia ? null : contacto.telefono,
    botonTexto: 'Ingresar a mi cuenta',
    botonUrl: contacto.portal,
    cierre: null,
    logo: logoDe(emisor),
    adjuntos: adjunto ? [adjunto] : [],
  })

  return { asunto: titulo, ...armado }
}
