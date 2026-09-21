import { Router } from 'express'
import { asyncHandler, notFound, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { porMetodo } from '../lib/permisos.js'
import { config } from '../config.js'
import { db, cargarRouter } from '../lib/db.js'
import { sondear, estadoNms, evaluar } from '../services/nms.js'
import { canalesDisponibles } from '../services/mensajeria.js'
import * as mk from '../services/mikrotikService.js'

/**
 * Monitoreo de red en tiempo real.
 *
 * El sondeo de fondo corre solo (`programarNms`); estas rutas son para verlo y
 * para forzarlo. Sondear a mano existe porque después de arreglar algo en la
 * torre nadie quiere esperar dos minutos para ver si volvió.
 */

const router = Router()
// El estado de la red lo puede MIRAR quien trabaja en campo: saber que el nodo
// de la zona está caído evita una hora revisando el domicilio equivocado.
// Forzar un sondeo o dar de alta un nodo ya es operar la red.
router.use(
  requireAuth,
  porMetodo({ lectura: ['red.monitoreo_ver', 'red.monitoreo'], escritura: 'red.monitoreo' }),
)

router.get(
  '/estado',
  asyncHandler(async (_req, res) => {
    const { data, error } = await db()
      .from('v_nodos_red')
      .select('estado, monitorear')

    if (error) throw new AppError(`No se pudieron leer los nodos: ${error.message}`, { status: 502 })

    const nodos = data ?? []
    const cuenta = (e) => nodos.filter((n) => n.estado === e).length

    res.json({
      ...estadoNms(),
      configurado: {
        automatico: config.nms.automatico,
        cada_minutos: config.nms.cada_minutos,
        paquetes: config.nms.paquetes,
        canal: config.nms.canal,
        // El destino no se devuelve entero: puede ser un número de teléfono.
        destino_configurado: Boolean(config.nms.destino),
      },
      canales: await canalesDisponibles(),
      total: nodos.length,
      monitoreados: nodos.filter((n) => n.monitorear).length,
      up: cuenta('up'),
      warning: cuenta('warning'),
      down: cuenta('down'),
      desconocido: cuenta('desconocido'),
    })
  }),
)

/** Fuerza una pasada completa. Es lo que se aprieta después de arreglar algo. */
router.post(
  '/sondear',
  asyncHandler(async (_req, res) => {
    res.json(await sondear())
  }),
)

/**
 * Sondea un solo nodo, sin registrar nada.
 *
 * Sirve para probar que la IP y el router están bien cargados al dar de alta el
 * nodo: si se registrara, un error de tipeo dejaría una caída falsa en el
 * historial y el uptime del nodo arrancaría mintiendo.
 */
router.post(
  '/nodos/:id/probar',
  asyncHandler(async (req, res) => {
    const { data: nodo, error } = await db()
      .from('v_nodos_red')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle()

    if (error) throw new AppError(`No se pudo leer el nodo: ${error.message}`, { status: 502 })
    if (!nodo) throw notFound('No existe ese nodo')

    if (!nodo.router_id) {
      return res.status(400).json({
        error: `${nodo.nombre} no tiene router desde el cual sondearlo`,
        hint: 'Elegí el MikroTik que tenga ruta hasta esa IP. El servidor casi nunca la tiene.',
      })
    }

    const equipo = await cargarRouter(nodo.router_id)
    const paquetes = await mk.ping(equipo, { destino: nodo.ip, cantidad: config.nms.paquetes })

    const enviados = (paquetes ?? []).filter((p) => p.time || p.status)
    const respondidos = enviados.filter((p) => p.time)
    const tiempos = respondidos
      .map((p) => Number(String(p.time).replace(/[^\d.]/g, '')))
      .filter(Boolean)

    const medicion = {
      enviados: enviados.length,
      recibidos: respondidos.length,
      latencia_ms: tiempos.length
        ? Math.round((tiempos.reduce((s, t) => s + t, 0) / tiempos.length) * 10) / 10
        : null,
    }

    const { estado, perdida_pct } = evaluar(medicion, nodo)

    res.json({
      nodo: nodo.nombre,
      ip: nodo.ip,
      router: equipo.nombre,
      ...medicion,
      perdida_pct,
      estado,
      umbrales: {
        latencia_ms: nodo.latencia_warning_ms,
        perdida_pct: nodo.perdida_warning_pct,
      },
      aviso: 'Prueba suelta: no se registró en el historial ni cambió el estado del nodo.',
    })
  }),
)

export default router
