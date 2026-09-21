import { Router } from 'express'
import { AppError, asyncHandler } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { db } from '../lib/db.js'
import { estado, guardar } from '../services/tareas.js'
import { canalesUtiles, ejecutarAvisosPago } from '../services/avisosPago.js'
import { ejecutarCorteMora } from '../services/corteMora.js'

/**
 * Los automatismos: qué corre solo y cuándo.
 *
 * Guardar y reprogramar son la misma operación, nunca dos. Si se pudiera
 * guardar sin reprogramar, la pantalla diría una cosa y el servidor haría otra
 * hasta el próximo reinicio — y nadie sospecha de lo que la pantalla confirma.
 */
const router = Router()
router.use(requireAuth)

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await estado())
  }),
)

router.put(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await guardar(req.body ?? {}))
  }),
)

/**
 * Los avisos de pago, en seco.
 *
 * ── Por qué existe una corrida que no manda nada ──
 *
 * Porque un aviso mal redactado o una regla de días mal puesta sale para todos
 * los abonados a la vez, y no se puede desenviar. Esto contesta "¿a quién le
 * llegaría hoy y qué aviso?" sin escribirle a nadie.
 *
 * Es lo que permite encender la tarea sabiendo lo que va a pasar, en vez de
 * encenderla y averiguarlo por los reclamos.
 */
router.post(
  '/avisos-pago/simular',
  asyncHandler(async (_req, res) => {
    res.json(await ejecutarAvisosPago({ soloSimular: true }))
  }),
)

/** El detalle: quién, qué aviso y por qué factura. */
router.get(
  '/avisos-pago/pendientes',
  asyncHandler(async (_req, res) => {
    const { data, error } = await db()
      .from('v_avisos_pago_pendientes')
      .select('cliente_id, nombre, nivel, dias, saldo, factura_numero, fecha_vencimiento, canal_preferido, email, telefono_movil, telefono, telegram_chat_id, plantilla_email_id, plantilla_corta_id')
      .order('nivel', { ascending: false })
      .order('dias', { ascending: false })
      .limit(500)

    if (error) {
      throw new AppError(`No se pudieron leer los avisos pendientes: ${error.message}`, {
        status: 502,
        hint: 'Si dice que no existe la vista, corré supabase/migracion-127-los-tres-avisos-de-pago.sql',
      })
    }

    // Se marca a quién no se le puede escribir: es el hallazgo que importa de
    // esta lista, y el que no se ve mirando solo los totales.
    res.json(
      (data ?? []).map((a) => ({ ...a, canales: canalesUtiles(a) })),
    )
  }),
)

/**
 * El corte por mora, en seco.
 *
 * Es la tarea que deja gente sin internet. Contesta a quién se cortaría hoy y a
 * quién habría que devolverle el servicio, sin tocar el router.
 */
router.post(
  '/mora/simular',
  asyncHandler(async (_req, res) => {
    res.json(await ejecutarCorteMora({ simular: true }))
  }),
)

export default router
