import { Router } from 'express'
import { asyncHandler, badRequest } from '../lib/errors.js'
import { activar, estado, renovar } from '../services/licencia.js'

/**
 * La licencia de esta instalación.
 *
 * Estas rutas quedan FUERA del bloqueo por licencia vencida y fuera del
 * requisito de sesión. Tiene que ser así: la pantalla de login necesita saber
 * si la licencia venció para poder decirlo, y el cliente que quedó afuera tiene
 * que poder pegar el código nuevo sin poder entrar primero. Una licencia que
 * solo se puede renovar estando adentro es una puerta cerrada con la llave del
 * otro lado.
 *
 * Lo que se expone es el estado, no un secreto: hasta cuándo vale, cuántos
 * abonados hay y el identificador de la instalación — que es justamente lo que
 * hay que informarle al proveedor para que emita el permiso.
 */
const router = Router()

router.get(
  '/estado',
  asyncHandler(async (_req, res) => {
    res.json(await estado())
  }),
)

router.post(
  '/activar',
  asyncHandler(async (req, res) => {
    const token = req.body?.token
    if (!token || typeof token !== 'string') {
      throw badRequest('Pegá el código de licencia que te pasó el proveedor.')
    }
    res.json(await activar(token))
  }),
)

/** Reintento manual, para no esperar a la renovación de mañana tras pagar. */
router.post(
  '/renovar',
  asyncHandler(async (_req, res) => {
    const r = await renovar()
    res.json({ ...r, estado: await estado() })
  }),
)

export default router
