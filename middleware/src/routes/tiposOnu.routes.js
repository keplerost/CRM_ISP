import { Router } from 'express'
import { asyncHandler } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import * as tipos from '../services/tiposOnu.js'

/**
 * Tipos de ONU — el catálogo de modelos de equipo.
 *
 * Va fuera de `/api/olt/:id` a propósito: un modelo de ONT es el mismo en todas
 * las OLTs, y colgarlo de una obligaría a cargarlo tantas veces como equipos
 * haya, con el riesgo de que las copias digan cosas distintas.
 */
const router = Router()
router.use(requireAuth)

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await tipos.listar())
  }),
)

router.post(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await tipos.crear(req.body ?? {}))
  }),
)

/**
 * Crea los tipos de los modelos que las ONUs ya reportaron.
 *
 * Va antes que `/:id` — Express resuelve por orden de declaración y si no,
 * "importar" se tomaría por un identificador.
 */
router.post(
  '/importar',
  asyncHandler(async (req, res) => {
    res.json(await tipos.importarDeLasOnus(req.body ?? {}))
  }),
)

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await tipos.editar(req.params.id, req.body ?? {}))
  }),
)

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(
      await tipos.borrar(req.params.id, {
        forzar: req.query.forzar === 'true' || req.query.forzar === '1',
      }),
    )
  }),
)

export default router
