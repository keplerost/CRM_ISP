import { Router } from 'express'
import { asyncHandler, badRequest } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { enviar, canalesDisponibles, aplicarPlantilla, variablesDe, enviarCrudo } from '../services/mensajeria.js'
import { guardar, paraMostrar } from '../services/configMensajeria.js'
import { correoDeFactura } from '../services/correoFactura.js'
import { dinero, fechaCorta, periodoDe } from '../services/variablesAviso.js'
import { db } from '../lib/db.js'

/**
 * Envío de mensajes al abonado.
 *
 * La lectura del historial va directo a Supabase desde el navegador. Acá vive
 * el envío, que necesita credenciales de SMTP y tokens de proveedores — cosas
 * que no pueden estar en el navegador de nadie.
 */

const router = Router()
router.use(requireAuth)

/**
 * La configuración de los canales.
 *
 * Nunca devuelve un token, ni siquiera al que ya entró: solo si hay uno
 * cargado y de dónde salió. Un token en la pantalla queda en el historial del
 * navegador y en cualquier captura que alguien mande pidiendo ayuda.
 */
router.get(
  '/config',
  asyncHandler(async (_req, res) => {
    res.json(await paraMostrar())
  }),
)

router.put(
  '/config',
  asyncHandler(async (req, res) => {
    res.json(await guardar(req.body ?? {}))
  }),
)

/**
 * Prueba de envío real.
 *
 * Se manda un mensaje de verdad y no se validan credenciales: que un proveedor
 * acepte el token es una cosa y que el mensaje llegue es otra. La segunda es la
 * que falla —número no habilitado, plantilla no aprobada, el abonado que nunca
 * le escribió al bot— y solo se ve enviando.
 */
router.post(
  '/probar',
  asyncHandler(async (req, res) => {
    const { canal, destino } = req.body ?? {}
    if (!canal || !destino) throw badRequest('Elegí el canal y a dónde mandar la prueba.')

    const r = await enviarCrudo({
      canal,
      destino,
      asunto: 'Prueba de mensajería',
      cuerpo:
        'Esta es una prueba enviada desde tu sistema de gestión. Si la estás leyendo, el canal funciona.',
    })

    res.json(r)
  }),
)

/** Qué canales se pueden usar hoy y qué falta para los que no. */
router.get(
  '/canales',
  asyncHandler(async (_req, res) => {
    res.json(await canalesDisponibles())
  }),
)

/**
 * Cómo queda una plantilla para este abonado, antes de mandarla.
 *
 * Ver el texto con los datos reemplazados evita el mensaje que sale con
 * "{{nombre}}" adentro, que es lo que pasa cuando se manda a ciegas.
 */
router.post(
  '/vista-previa',
  asyncHandler(async (req, res) => {
    const { client_id, cuerpo, asunto } = req.body ?? {}
    if (!cuerpo) throw badRequest('Falta el texto del mensaje')

    const { data: cliente } = await db()
      .from('v_clientes_ficha')
      .select('id, nombre, identificacion, email, telefono, telefono_movil, telegram_chat_id, saldo, plan, ip')
      .eq('id', client_id)
      .maybeSingle()

    const vars = variablesDe(cliente ?? {})
    res.json({
      asunto: asunto ? aplicarPlantilla(asunto, vars) : null,
      cuerpo: aplicarPlantilla(cuerpo, vars),
      variables: vars,
    })
  }),
)

/**
 * El correo completo, como va a salir.
 *
 * ── Por qué no alcanza con la vista previa de texto ──
 *
 * Porque lo que el ISP escribe es una parte del correo: el resto —logo, tabla de
 * datos, cuentas, botón de WhatsApp, PDF— lo pone el sistema. Ver solo el texto
 * reemplazado no dice si el mensaje quedó bien: el párrafo puede leerse perfecto
 * y repetir un dato que la tabla ya muestra, o contradecir el botón.
 *
 * Acá se devuelve el HTML entero, armado con una factura de ejemplo y los datos
 * reales del ISP —su logo, sus cuentas, su WhatsApp— para que lo que se ve sea
 * lo que va a recibir el abonado.
 */
router.post(
  '/vista-previa-correo',
  asyncHandler(async (req, res) => {
    const { cuerpo, asunto, tipo = 'nueva', client_id = null } = req.body ?? {}

    const { data: cliente } = client_id
      ? await db().from('v_clientes_ficha').select('*').eq('id', client_id).maybeSingle()
      : await db().from('v_clientes_ficha').select('*').eq('estado', 'activo').limit(1).maybeSingle()

    /**
     * Una factura de ejemplo, no una de verdad.
     *
     * Se arma en memoria y no se guarda: una vista previa que crea una factura
     * dejaría basura en la cartera del ISP cada vez que alguien mira cómo quedó
     * un texto.
     */
    const monto = Number(cliente?.precio_mensual ?? 25)
    const hoy = new Date()
    const vence = new Date(hoy)
    vence.setDate(vence.getDate() + 5)

    const ejemplo = {
      // Sin `id`: es lo que le dice al armador que no busque el PDF en la base.
      numero: 1234,
      concepto: cliente?.plan ?? 'Servicio de internet',
      fecha_emision: hoy.toISOString().slice(0, 10),
      fecha_vencimiento: vence.toISOString().slice(0, 10),
      total: monto,
      saldo: monto,
    }

    const vars = variablesDe(cliente ?? {}, {
      periodo: periodoDe(ejemplo.concepto, ejemplo.fecha_vencimiento),
      total: dinero(monto),
      saldo: dinero(monto),
      fecha_vencimiento: fechaCorta(ejemplo.fecha_vencimiento),
      fecha_corte: fechaCorta(ejemplo.fecha_vencimiento),
      factura: '1234',
    })

    const armado = await correoDeFactura({
      factura: ejemplo,
      cliente: cliente ?? { nombre: 'Nombre del abonado' },
      tipo,
      fechaCorte: vars.fecha_corte,
      plantilla: cuerpo
        ? { asunto: aplicarPlantilla(asunto ?? '', vars), cuerpo: aplicarPlantilla(cuerpo, vars) }
        : null,
    })

    /**
     * Las imágenes embebidas se convierten para que el navegador las muestre.
     *
     * En el correo van como adjuntos con `cid:`, que el cliente de correo resuelve
     * solo. Un navegador no sabe qué es un `cid:`, así que en la vista previa
     * saldrían dos cuadritos roto — y quien mire va a pensar que el correo va sin
     * logo.
     */
    let html = armado.html
    for (const a of armado.adjuntos) {
      if (!a.cid) continue
      html = html.replaceAll(
        `cid:${a.cid}`,
        `data:${a.filename.endsWith('.png') ? 'image/png' : 'image/jpeg'};base64,${a.content.toString('base64')}`,
      )
    }

    res.json({
      asunto: armado.asunto,
      html,
      texto: armado.texto,
      // Lo que se adjunta de verdad, para que la pantalla lo pueda decir.
      adjuntos: armado.adjuntos
        .filter((a) => !a.cid)
        .map((a) => ({ nombre: a.filename, bytes: a.content?.length ?? 0 })),
      abonado: cliente?.nombre ?? null,
    })
  }),
)

router.post(
  '/enviar',
  asyncHandler(async (req, res) => {
    const { client_id, canal, cuerpo } = req.body ?? {}
    if (!client_id) throw badRequest('Falta el cliente')
    if (!canal) throw badRequest('Falta el canal')
    if (!cuerpo?.trim()) throw badRequest('El mensaje está vacío')

    try {
      const fila = await enviar({
        ...req.body,
        created_by: req.usuario?.id ?? null,
      })
      res.json(fila)
    } catch (err) {
      // El intento fallido ya quedó registrado: se devuelve junto al error para
      // que la pantalla pueda mostrarlo en el historial sin recargar.
      res.status(502).json({
        error: err.message,
        comunicacion: err.comunicacion ?? null,
        hint: 'El intento quedó registrado en el historial del abonado.',
      })
    }
  }),
)

/**
 * Marca como enviado un mensaje que se mandó a mano.
 *
 * Es el caso de WhatsApp sin API: el sistema prepara el texto, una persona lo
 * manda y vuelve a confirmar. Sin este paso el historial diría para siempre que
 * quedó pendiente.
 */
router.post(
  '/:id/marcar-enviado',
  asyncHandler(async (req, res) => {
    const { data, error } = await db()
      .from('comunicaciones')
      .update({ estado: 'enviado', enviado_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw badRequest(`No se pudo marcar: ${error.message}`)
    res.json(data)
  }),
)

export default router
