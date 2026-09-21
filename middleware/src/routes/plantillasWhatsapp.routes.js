import { Router } from 'express'

import { asyncHandler, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { actorDe } from '../lib/auditoria.js'
import { tienePermiso } from '../../../web/src/lib/permisos.js'
import {
  guardar,
  listar,
  revisarCuerpo,
  verificarCoherencia,
} from '../services/plantillasWhatsapp.js'

/**
 * Las plantillas aprobadas de WhatsApp.
 *
 * Va con `config.mensajeria` —el mismo permiso que configurar por dónde salen
 * los mensajes— porque es lo mismo: una plantilla mal registrada no manda un
 * mensaje feo, no manda NADA, y el abonado no se entera de que le van a cortar.
 */

const router = Router()
router.use(requireAuth)

async function exigir(req, permiso) {
  const actor = await actorDe(req)

  if (!actor) {
    throw new AppError('Tu usuario no tiene un legajo de personal asociado', { status: 403 })
  }
  if (!actor.activo) throw new AppError('Tu usuario está desactivado', { status: 403 })
  if (permiso && !tienePermiso(actor, permiso)) {
    throw new AppError('No tenés permiso para esto', {
      status: 403,
      hint: `Hace falta el permiso "${permiso}".`,
    })
  }
  return actor
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    await exigir(req, 'config.mensajeria')
    res.json(await listar())
  }),
)

/**
 * Revisa un texto contra las reglas de Meta, sin guardarlo.
 *
 * Es lo que permite escribir la plantilla y saber si la van a rechazar ANTES de
 * ir a cargarla al Administrador de WhatsApp. Descubrirlo allá cuesta una vuelta
 * entera: se pega el texto, se manda, y la respuesta tarda.
 */
router.post(
  '/revisar',
  asyncHandler(async (req, res) => {
    await exigir(req, 'config.mensajeria')

    const { cuerpo_meta, variables } = req.body ?? {}
    const { variables: enCuerpo } = revisarCuerpo(cuerpo_meta)
    const coherencia = verificarCoherencia({ cuerpo_meta, variables })

    res.json({
      ok: coherencia.ok,
      variables_en_el_texto: enCuerpo,
      ...(coherencia.ok ? {} : { motivo: coherencia.motivo }),
    })
  }),
)

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    await exigir(req, 'config.mensajeria')
    res.json(await guardar(req.params.id, req.body ?? {}))
  }),
)

export default router
