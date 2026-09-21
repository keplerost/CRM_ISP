import { Router } from 'express'

import { asyncHandler, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { db } from '../lib/db.js'
import { actorDe, auditar } from '../lib/auditoria.js'
import { tienePermiso } from '../../../web/src/lib/permisos.js'
import {
  abrir,
  cancelar,
  crear,
  drenarIncidencias,
  listar,
  previsualizar,
  resolver,
} from '../services/incidencias.js'

/**
 * Cortes masivos y mantenimientos programados.
 *
 * ── Por qué abrir una incidencia se audita como una acción sensible ──
 *
 * Porque manda un mensaje a cientos de personas y no se puede desenviar. Es de
 * la misma familia que cortar el servicio: reversible en el sistema, no en la
 * vida real. Quien la abrió y a cuántos alcanzó tiene que poder consultarse
 * después, sin depender de que alguien se acuerde.
 */

const router = Router()
router.use(requireAuth)

async function exigir(req, permiso) {
  const actor = await actorDe(req)

  if (!actor) {
    throw new AppError('Tu usuario no tiene un legajo de personal asociado', {
      status: 403,
      hint: 'Pedile a un Super Administrador que te cree el usuario en Ajustes → Gestión de personal.',
    })
  }
  if (!actor.activo) throw new AppError('Tu usuario está desactivado', { status: 403 })

  if (permiso && !tienePermiso(actor, permiso)) {
    throw new AppError('No tenés permiso para esto', {
      status: 403,
      hint: `Hace falta el permiso "${permiso}". Se otorga en Ajustes → Gestión de personal.`,
    })
  }

  return actor
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    await exigir(req, 'red.monitoreo_ver')
    res.json(await listar({ estado: req.query.estado, limite: Number(req.query.limite) || 100 }))
  }),
)

/**
 * A cuántos alcanzaría, antes de crear nada.
 *
 * Es la pantalla más importante de todo esto. "Esta zona son 12 abonados" y
 * "esta zona son 340" se deciden distinto, y el número tiene que estar sobre la
 * mesa ANTES de que exista algo que se pueda abrir de un clic.
 */
router.post(
  '/previsualizar',
  asyncHandler(async (req, res) => {
    await exigir(req, 'red.monitoreo_ver')
    res.json(await previsualizar(req.body ?? {}))
  }),
)

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const actor = await exigir(req, 'red.incidencias')
    const creada = await crear(req.body ?? {}, req.usuario?.id ?? null)

    await auditar(req, actor, {
      accion: 'incidencia_crear',
      descripcion: `Creó la incidencia "${creada.titulo}" (${creada.afectados} abonados alcanzados)`,
      entidad: 'incidencias_masivas',
      entidadId: creada.id,
      datos: { alcance: creada.alcance, tipo: creada.tipo },
    })

    res.status(201).json(creada)
  }),
)

/**
 * Abrir: es el botón que manda los mensajes.
 *
 * Va con su propio permiso —`red.incidencias`— y no con el de ver el monitoreo.
 * Mirar qué nodos están caídos es una cosa; escribirle a trescientas personas
 * en nombre del ISP es otra, y no se delegan juntas.
 */
router.post(
  '/:id/abrir',
  asyncHandler(async (req, res) => {
    const actor = await exigir(req, 'red.incidencias')
    const r = await abrir(req.params.id, req.usuario?.id ?? null)

    await auditar(req, actor, {
      accion: 'incidencia_abrir',
      descripcion: `Abrió una incidencia masiva: se encolaron ${r.encolados} avisos para ${r.afectados} abonados`,
      entidad: 'incidencias_masivas',
      entidadId: req.params.id,
      datos: r,
    })

    res.json(r)
  }),
)

router.post(
  '/:id/resolver',
  asyncHandler(async (req, res) => {
    const actor = await exigir(req, 'red.incidencias')
    const r = await resolver(req.params.id, req.usuario?.id ?? null)

    await auditar(req, actor, {
      accion: 'incidencia_resolver',
      descripcion: `Resolvió una incidencia masiva: ${r.encolados} avisos de restablecimiento`,
      entidad: 'incidencias_masivas',
      entidadId: req.params.id,
    })

    res.json(r)
  }),
)

/** Para la que se abrió sobre la zona equivocada. Frena lo que no salió. */
router.post(
  '/:id/cancelar',
  asyncHandler(async (req, res) => {
    const actor = await exigir(req, 'red.incidencias')
    const r = await cancelar(req.params.id, req.body?.motivo ?? null)

    await auditar(req, actor, {
      accion: 'incidencia_cancelar',
      descripcion: `Canceló una incidencia masiva: se frenaron ${r.frenados} avisos que no habían salido`,
      entidad: 'incidencias_masivas',
      entidadId: req.params.id,
      datos: { motivo: req.body?.motivo ?? null },
    })

    res.json(r)
  }),
)

/** A quién se le avisó y con qué resultado. */
router.get(
  '/:id/avisos',
  asyncHandler(async (req, res) => {
    await exigir(req, 'red.monitoreo_ver')

    const { data, error } = await db()
      .from('incidencia_avisos')
      .select('id, momento, estado, canal, motivo, enviado_en, clientes(nombre, identificacion, zona)')
      .eq('incidencia_id', req.params.id)
      .order('id')
      .limit(2000)

    if (error) throw new AppError(`No se pudieron leer los avisos: ${error.message}`, { status: 502 })
    res.json(data ?? [])
  }),
)

/**
 * Manda ahora lo que esté en la cola, sin esperar al latido.
 *
 * Existe porque el primer corte grande que use esto va a tener a alguien
 * mirando la pantalla, y esperar noventa segundos a que salga el primer lote
 * mientras suena el teléfono se siente como que no funcionó.
 */
router.post(
  '/enviar-pendientes',
  asyncHandler(async (req, res) => {
    await exigir(req, 'red.incidencias')
    res.json(await drenarIncidencias({ lote: Math.min(200, Number(req.body?.lote) || 40) }))
  }),
)

export default router
