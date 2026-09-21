import { db } from '../lib/db.js'
import { canalesPara } from './avisosPago.js'
import { enviar, seEntrego } from './mensajeria.js'
import { dinero, fechaCorta, periodoDe } from './variablesAviso.js'
import { correoDeFactura } from './correoFactura.js'

/**
 * El aviso de que hay factura nueva.
 *
 * ── Por qué va aparte de los tres avisos de pago ──
 *
 * Porque no es cobranza. Los tres avisos recuerdan una DEUDA y hay abonados a
 * los que eso les molesta; este es informativo, se manda una vez cuando se emite
 * la factura, y es el que da inicio al plazo. Meterlo en el mismo interruptor
 * obligaría a elegir entre recibir los cuatro o ninguno.
 *
 * ── A quién se le manda ──
 *
 * A TODOS. Es la factura interna del negocio, la que se crea para cada abonado
 * exista o no comprobante fiscal. Que el abonado pida factura electrónica del
 * SRI no tiene nada que ver: eso se emite después, solo al cobrar y solo a quien
 * la pidió.
 *
 * La única excepción es el que pide expresamente que no le escriban, y esa
 * excepción vive en su ficha.
 */

/** Los canales por los que se le avisa la factura a este abonado. */
export function canalesDeFactura(cliente) {
  /**
   * El interruptor general manda sobre todo.
   *
   * Se comprueba acá y no solo en el momento de enviar. La comprobación al
   * enviar alcanza para que el mensaje no salga, pero esta función también la
   * usan las vistas previas: sin esto, la pantalla mostraría "se le avisa por
   * WhatsApp" de un abonado que pidió que no lo molesten, y alguien confiaría en
   * eso. Una función que contesta distinto según quién pregunte es una trampa.
   */
  if (cliente.avisos_activos === false) return []

  /**
   * `null` es "lo general", que para este aviso significa TODOS los canales que
   * se puedan usar. Es lo que hace que un abonado nuevo reciba su factura sin
   * que nadie tenga que configurarle nada.
   *
   * Una lista vacía es el abonado que pidió que no le avisen. Se distingue de
   * `null` a propósito: no es lo mismo "no lo configuré" que "me lo pidió".
   */
  if (Array.isArray(cliente.aviso_factura_canales)) {
    if (!cliente.aviso_factura_canales.length) return []
    return canalesPara({ ...cliente, avisos_canales: cliente.aviso_factura_canales })
  }

  return canalesPara({ ...cliente, avisos_canales: null })
}

/**
 * Avisa de una factura recién creada.
 *
 * Nunca lanza: que un aviso no salga no puede hacer fallar la facturación. La
 * factura ya existe y es lo que importa; el mensaje se puede reintentar y su
 * resultado queda en `comunicaciones` para poder verlo.
 */
export async function avisarFacturaNueva(factura, cliente) {
  try {
    if (!cliente?.id) return { enviado: false, motivo: 'sin abonado' }

    /**
     * Los datos de contacto y las preferencias se leen acá.
     *
     * Quien llama viene de `v_clientes_ficha` con las columnas que necesita para
     * facturar, que no son estas. Podría agregarlas a esa consulta, pero
     * entonces este archivo dependería de que otro se acuerde de pedirlas — y el
     * día que alguien las saque, los avisos dejan de salir sin ningún error.
     */
    const { data: ficha } = await db()
      .from('clientes')
      .select(
        'id, avisos_activos, aviso_factura_canales, canal_preferido, email, telefono_movil, telefono, telegram_chat_id',
      )
      .eq('id', cliente.id)
      .maybeSingle()

    if (!ficha) return { enviado: false, motivo: 'no se encontró la ficha del abonado' }

    // El que pidió que no lo molesten con NADA tampoco recibe esto.
    if (ficha.avisos_activos === false) {
      return { enviado: false, motivo: 'el abonado pidió no recibir avisos' }
    }

    const canales = canalesDeFactura(ficha)
    if (!canales.length) {
      return { enviado: false, motivo: 'sin canal disponible' }
    }

    const { data: plantillas } = await db()
      .from('plantillas_mensaje')
      .select('id, clave, asunto, cuerpo')
      .in('clave', ['mail_factura_generada', 'sms_factura_generada'])
      .eq('activa', true)

    const porClave = new Map((plantillas ?? []).map((p) => [p.clave, p]))

    /**
     * ¿Se manda por TODOS los canales, o por el primero que funcione?
     *
     * ── La distinción que faltaba ──
     *
     * Depende de quién los eligió, y la diferencia es de intención:
     *
     *   El ISP eligió "Correo + WhatsApp" en la ficha → quiere los DOS. La
     *   pantalla ofrece esas combinaciones de a pares justamente para eso;
     *   mandar por uno solo convierte una elección explícita en una sugerencia.
     *
     *   Nadie configuró nada (`null`) → "avisale por donde puedas". Ahí sí
     *   alcanza el primero que salga: mandarle el mismo aviso por correo, SMS y
     *   Telegram a alguien que no pidió nada es molestarlo tres veces y pagar
     *   tres veces.
     *
     * Sin esto, con el preferido en WhatsApp y WhatsApp en modo manual, el aviso
     * "salía" por WhatsApp —quedaba pendiente, sin lanzar error— y el correo no
     * se mandaba nunca. El abonado no recibía nada y el sistema decía enviado.
     */
    const porTodos = Array.isArray(ficha.aviso_factura_canales)
      && ficha.aviso_factura_canales.length > 1

    const salieron = []
    /**
     * Los canales que quedaron preparados para mandar a mano.
     *
     * WhatsApp en modo manual no entrega: deja el mensaje escrito con su enlace de
     * wa.me para que alguien lo mande. Antes eso contaba como envío y cortaba el
     * recorrido, así que con WhatsApp como canal preferido y sin proveedor el
     * correo NO se mandaba nunca y el sistema informaba "enviado por whatsapp".
     *
     * Se vio en una corrida de facturación de verdad: tres facturas creadas, las
     * tres con `aviso: whatsapp`, y ni un correo en la casilla.
     */
    const preparados = []
    let ultimoError = null

    for (const canal of canales) {
      // La larga para el correo, la corta para el teléfono: mismo criterio que
      // los avisos de pago.
      const plantilla = porClave.get(
        canal === 'email' ? 'mail_factura_generada' : 'sms_factura_generada',
      )
      if (!plantilla) continue

      /**
       * Por correo va la versión con formato; por el teléfono, el texto.
       *
       * ── Por qué el correo no usa la plantilla ──
       *
       * Porque el logo, la tabla de datos, las cuentas y el botón no caben en un
       * campo de texto: armarlos desde la plantilla obligaría al ISP a escribir
       * HTML a mano y a mantenerlo. Lo que el ISP escribe —el tono del mensaje—
       * sigue viniendo de acá, del armador; lo que no debería tener que escribir
       * es una tabla que se vea bien en Outlook.
       *
       * La plantilla se sigue usando para SMS, WhatsApp y Telegram, donde el
       * texto ES el mensaje.
       */
      let conFormato = null
      if (canal === 'email') {
        try {
          conFormato = await correoDeFactura({
            factura,
            cliente: ficha,
            tipo: 'nueva',
            // Lo que el ISP escribió en el editor. `enviar` le reemplaza los
            // marcadores después, con las variables de más abajo.
            plantilla,
          })
        } catch {
          // Si el armado falla se manda la plantilla de texto: un aviso simple
          // es mucho mejor que ninguno.
        }
      }

      try {
        const resultado = await enviar({
          client_id: ficha.id,
          canal,
          asunto: conFormato?.asunto ?? plantilla.asunto,
          cuerpo: conFormato?.texto ?? plantilla.cuerpo,
          html: conFormato?.html ?? null,
          adjuntos: conFormato?.adjuntos ?? [],
          plantilla_id: plantilla.id,
          factura_id: factura.id,
          automatico: true,
          /**
           * Lo que la plantilla nombra y no está en la ficha del abonado.
           *
           * `enviar` arma solo lo del abonado, así que todo lo que sale de la
           * FACTURA hay que pasárselo desde acá. Sin esto, el aviso de nueva
           * factura —el que va a TODOS los abonados— salía diciendo "su factura
           * de {{periodo}} por {{total}}".
           *
           * No fallaba: un marcador sin dato se deja tal cual para no perder el
           * resto del mensaje. Por eso el error solo se ve leyendo un correo ya
           * enviado.
           */
          variables: {
            periodo: periodoDe(factura.concepto, factura.fecha_vencimiento),
            total: dinero(factura.total ?? factura.importe_total),
            saldo: dinero(factura.saldo ?? factura.total ?? factura.importe_total),
            fecha_vencimiento: fechaCorta(factura.fecha_vencimiento),
            factura: factura.numero != null ? String(factura.numero) : '',
            concepto: factura.concepto ?? '',
          },
        })

        /**
         * Un mensaje que quedó pendiente no cuenta como salido.
         *
         * Sigue al canal siguiente aunque no se hayan pedido todos: "el primero
         * que funcione" tiene que significar el primero que ENTREGUE. Si no,
         * un canal sin proveedor se traga el aviso entero.
         */
        if (!seEntrego(resultado)) {
          preparados.push(canal)
          continue
        }

        salieron.push(canal)
        // Con un canal solo —o sin configurar— alcanza el primero que salga.
        if (!porTodos) break
      } catch (e) {
        // Se prueba el siguiente canal. El fallo ya quedó registrado en
        // `comunicaciones`, que es donde se mira después.
        ultimoError = e.message
      }
    }

    if (salieron.length) {
      return {
        enviado: true,
        canal: salieron[0],
        canales: salieron,
        // Si se pidieron dos y salió uno, hay que poder saberlo.
        falto: porTodos ? canales.filter((c) => !salieron.includes(c)) : [],
        // Y si además quedó uno esperando que alguien lo mande a mano.
        pendientes: preparados,
      }
    }

    /**
     * Nada llegó, pero algo quedó escrito para mandar a mano.
     *
     * Se informa como pendiente y no como enviado: la factura existe y el mensaje
     * está preparado en Comunicaciones con su enlace, pero nadie lo recibió
     * todavía. Decir "enviado" acá es la mentira que hizo falta arreglar.
     */
    if (preparados.length) {
      return {
        enviado: false,
        pendiente: true,
        canales: preparados,
        motivo: `quedó preparado para mandar a mano por ${preparados.join(' y ')}`,
      }
    }

    // El motivo del último fallo, no una frase genérica: "no salió por ningún
    // canal" no le dice a nadie si fue el SMTP, el número o la plantilla.
    return {
      enviado: false,
      motivo: ultimoError
        ? `no salió por ningún canal — ${ultimoError}`
        : 'no salió por ningún canal',
    }
  } catch (e) {
    return { enviado: false, motivo: e.message }
  }
}
