import { db } from '../lib/db.js'
import { canalesPara } from './avisosPago.js'
import { enviar, seEntrego } from './mensajeria.js'
import { correoDePago } from './correoPago.js'

/**
 * Los avisos que dispara la base.
 *
 * Hoy hay uno: la confirmación de pago. Va acá y no en la pantalla de cobro
 * porque se cobra desde varios lugares —la ficha, la caja, el buscador— y cada
 * uno que se olvide de avisar deja a un abonado sin acuse de recibo. Ese olvido
 * no da error: simplemente no llega nada, y el abonado llama preguntando si el
 * pago entró. O peor, vuelve a pagar.
 *
 * Con la cola da igual desde dónde se cobre.
 */

/** Qué plantilla usa cada tipo de aviso, según el canal. */
const PLANTILLAS = {
  pago_confirmado: { email: 'mail_pago_confirmado', corta: 'sms_pago_confirmado' },
  corte_servicio: { email: 'mail_corte_servicio', corta: 'sms_corte_servicio' },
  bienvenida: { email: 'mail_bienvenida', corta: 'sms_bienvenida' },
  ticket_abierto: { email: 'mail_ticket_abierto', corta: 'sms_ticket_abierto' },
  ticket_asignado: { email: 'mail_ticket_asignado', corta: 'sms_ticket_asignado' },
  ticket_respuesta: { email: 'mail_ticket_respuesta', corta: 'sms_ticket_respuesta' },
}

/** El dinero como lo lee una persona, no como lo guarda la base. */
const dinero = (n) => `$${Number(n ?? 0).toFixed(2)}`

/**
 * Manda un aviso a un abonado, por el primer canal que se pueda.
 *
 * Devuelve qué pasó en vez de lanzar: quien llama está en medio de otra cosa
 * —cortando abonados, drenando una cola— y un mensaje que no sale no puede
 * interrumpir ese trabajo.
 */
export async function avisarAlAbonado({ cliente, tipo, variables = {}, factura_id = null }) {
  try {
    const claves = PLANTILLAS[tipo]
    if (!claves) return { enviado: false, motivo: `tipo de aviso desconocido: ${tipo}` }

    /**
     * El identificador, se llame como se llame.
     *
     * Las vistas de cola devuelven `cliente_id` —porque también traen un
     * `aviso_id` y dos columnas no pueden llamarse igual— y una ficha devuelve
     * `id`. Quien llama no debería tener que acordarse de cuál le tocó.
     *
     * Esto costó un error real: la cola pasaba su fila tal cual y `enviar`
     * recibía `undefined`, así que contestaba "No existe ese cliente" sobre un
     * abonado que estaba perfectamente en la base.
     */
    const clienteId = cliente?.id ?? cliente?.cliente_id
    if (!clienteId) return { enviado: false, motivo: 'el aviso no dice de qué abonado es' }

    // El que pidió que no lo molesten no recibe ni esto. Es su decisión, y vale
    // también para el aviso de que se le cortó.
    if (cliente.avisos_activos === false) {
      return { enviado: false, motivo: 'el abonado pidió no recibir avisos' }
    }

    const { data: plantillas } = await db()
      .from('plantillas_mensaje')
      .select('clave, id, asunto, cuerpo')
      .in('clave', [claves.email, claves.corta])
      .eq('activa', true)

    const porClave = new Map((plantillas ?? []).map((p) => [p.clave, p]))
    if (!porClave.size) {
      return { enviado: false, motivo: 'no hay plantilla activa para este aviso' }
    }

    let ultimoError = null
    /**
     * El canal que quedó preparado para mandar a mano, si hubo alguno.
     *
     * No corta el recorrido: WhatsApp en modo manual no entregó nada, así que hay
     * que seguir probando el correo. Pero se recuerda, porque si NINGÚN canal
     * entregó, dejar el aviso en la cola lo haría reintentar y cada reintento
     * prepararía otro WhatsApp a mano para el mismo pago.
     */
    let preparado = null

    for (const canal of canalesPara(cliente)) {
      // La larga para el correo, la corta para el teléfono: mismo criterio que
      // los avisos de pago.
      const plantilla = porClave.get(canal === 'email' ? claves.email : claves.corta)
      if (!plantilla) continue

      /**
       * Por correo va la tarjeta; por el teléfono, el texto.
       *
       * El acuse de pago salía con el cuerpo crudo de la plantilla, así que el
       * abonado leía las etiquetas: "<p>Estimado/a Juan:</p>". Lo que el ISP
       * escribe —el tono del mensaje— sigue viniendo de la plantilla; lo que no
       * debería tener que escribir es una tabla que se vea bien en Outlook.
       *
       * Si el armado falla se manda la plantilla tal cual: un acuse simple es
       * mucho mejor que ninguno.
       */
      let conFormato = null
      if (canal === 'email' && tipo === 'pago_confirmado') {
        try {
          conFormato = await correoDePago({ pago: cliente, cliente, plantilla })
        } catch {
          // Se cae al texto de la plantilla.
        }
      }

      try {
        const r = await enviar({
          client_id: clienteId,
          canal,
          asunto: conFormato?.asunto ?? plantilla.asunto,
          cuerpo: conFormato?.texto ?? plantilla.cuerpo,
          html: conFormato?.html ?? null,
          adjuntos: conFormato?.adjuntos ?? [],
          plantilla_id: plantilla.id,
          factura_id: factura_id ?? cliente.factura_id ?? null,
          automatico: true,
          variables,
        })

        if (!seEntrego(r)) {
          preparado = preparado ?? canal
          continue
        }

        return { enviado: true, canal }
      } catch (e) {
        ultimoError = e.message
      }
    }

    /**
     * Nada llegó, pero algo quedó listo para mandar a mano.
     *
     * Se devuelve `enviado` para que la cola se cierre —el mensaje ya está escrito
     * y esperando en Comunicaciones— y `pendiente` para que quien informe pueda
     * decir la verdad: "whatsapp (pendiente)", no "enviado por whatsapp".
     */
    if (preparado) return { enviado: true, canal: preparado, pendiente: true }

    return { enviado: false, motivo: ultimoError ?? 'sin canal utilizable' }
  } catch (e) {
    return { enviado: false, motivo: e.message }
  }
}

/**
 * Atiende la cola.
 *
 * Corre junto con la de reconexiones y por la misma razón: el abonado que acaba
 * de pagar espera el acuse mientras todavía está en la ventanilla.
 */
export async function drenarAvisos() {
  const { data, error } = await db().from('v_avisos_a_enviar').select('*').limit(100)

  if (error) {
    // Sin la migración corrida, esto no existe todavía. No es un fallo del
    // sistema: es que la función no está instalada.
    if (/does not exist/i.test(error.message)) return { enviados: 0, fallidos: [] }
    throw new Error(`No se pudo leer la cola de avisos: ${error.message}`)
  }

  if (!data?.length) return { enviados: 0, fallidos: [] }

  const enviados = []
  const fallidos = []

  for (const a of data) {
    const r = await avisarAlAbonado({
      cliente: a,
      tipo: a.tipo,
      /**
       * Todo lo que las plantillas de estos avisos pueden usar.
       *
       * Se mandan todas juntas y no las de cada tipo: una plantilla la edita el
       * ISP, y bien puede querer meter el plan en el mensaje de bienvenida o el
       * técnico en la respuesta de un ticket. Filtrarlas por tipo obligaría a
       * volver acá cada vez que alguien agrega un marcador.
       */
      variables: {
        monto: dinero(a.monto),
        saldo: dinero(a.saldo),
        fecha: a.fecha_pago
          ? new Date(`${a.fecha_pago}T12:00:00`).toLocaleDateString('es-EC')
          : '',
        forma_pago: a.forma_pago ?? '',
        /**
         * La factura que se pagó y el número de cuenta del abonado.
         *
         * Los ofrece el editor de plantillas, así que tienen que llegar: un
         * marcador que la pantalla propone y el sistema no reemplaza sale tal cual
         * en el mensaje —"su factura N° {{factura}}"— y eso solo se descubre
         * leyendo un correo ya enviado.
         */
        factura: a.factura_numero != null ? String(a.factura_numero) : '',
        codigo: a.codigo != null ? String(a.codigo) : '',
        plan: a.plan ?? '',
        dia_pago: a.dia_pago != null ? String(a.dia_pago) : '',
        ticket: a.ticket != null ? String(a.ticket) : '',
        motivo: a.motivo ?? '',
        tecnico: a.tecnico ?? 'nuestro técnico',
        // "a coordinar" y no una fecha vacía: el abonado tiene que entender que
        // todavía no hay día, no leer un renglón cortado.
        fecha_visita: a.fecha_visita
          ? new Date(`${a.fecha_visita}T12:00:00`).toLocaleDateString('es-EC')
          : 'a coordinar',
        respuesta: a.respuesta ?? '',
      },
    })

    if (r.enviado) {
      await db()
        .from('avisos_pendientes')
        .update({ procesado_en: new Date().toISOString() })
        .eq('id', a.aviso_id)
      // El `(pendiente)` importa: es la diferencia entre "le llegó" y "quedó
      // escrito esperando que alguien lo mande desde WhatsApp".
      enviados.push({
        cliente: a.nombre,
        tipo: a.tipo,
        canal: r.pendiente ? `${r.canal} (pendiente)` : r.canal,
      })
      continue
    }

    /**
     * Lo que no se pudo mandar se cierra igual después de tres intentos.
     *
     * Un abonado sin correo ni celular no va a tener uno mañana, y su aviso
     * quedaría en la cola para siempre haciendo ruido. Se cierra con el motivo
     * escrito, que es lo que permite ir a pedirle el número.
     */
    const intentos = (a.intentos ?? 0) + 1
    await db()
      .from('avisos_pendientes')
      .update({
        intentos,
        error: r.motivo,
        ...(intentos >= 3 ? { procesado_en: new Date().toISOString() } : {}),
      })
      .eq('id', a.aviso_id)

    fallidos.push({ cliente: a.nombre, tipo: a.tipo, motivo: r.motivo, intentos })
  }

  return { enviados: enviados.length, detalle: enviados, fallidos }
}
