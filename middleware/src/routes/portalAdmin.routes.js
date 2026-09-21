import { Router } from 'express'
import { asyncHandler } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import {
  buscar,
  cerrarSesiones,
  fijarClave,
  marcarSolicitud,
  resetearAcceso,
  resumen,
  solicitudes,
} from '../services/portalAdmin.js'

/**
 * El portal del abonado, administrado desde la oficina.
 *
 * Separado de `/api/portal`, que es lo que usa el abonado con su propia sesión.
 * Acá entra el personal del ISP, con sesión de Supabase — y por eso lleva
 * requireAuth, que aquel no puede tener.
 *
 * Mezclarlos sería el error grave: una ruta de administración colgada del
 * router del abonado quedaría abierta a cualquiera que tenga una cuenta de
 * abonado, que son todos los clientes del ISP.
 */
const router = Router()
router.use(requireAuth)

router.get(
  '/resumen',
  asyncHandler(async (_req, res) => {
    res.json(await resumen())
  }),
)

router.get(
  '/buscar',
  asyncHandler(async (req, res) => {
    res.json(await buscar(req.query.q))
  }),
)

router.post(
  '/abonados/:id/resetear',
  asyncHandler(async (req, res) => {
    res.json(await resetearAcceso(req.params.id))
  }),
)

router.post(
  '/abonados/:id/clave',
  asyncHandler(async (req, res) => {
    res.json(await fijarClave(req.params.id))
  }),
)

router.post(
  '/abonados/:id/cerrar-sesiones',
  asyncHandler(async (req, res) => {
    res.json(await cerrarSesiones(req.params.id))
  }),
)

router.get(
  '/solicitudes',
  asyncHandler(async (req, res) => {
    res.json(await solicitudes({ estado: req.query.estado ?? 'pendiente' }))
  }),
)

router.post(
  '/solicitudes/:id',
  asyncHandler(async (req, res) => {
    res.json(await marcarSolicitud(req.params.id, req.body?.estado))
  }),
)

export default router
