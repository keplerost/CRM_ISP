import { Router } from 'express'
import { asyncHandler } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { ejecutarAlertas, probarDestino } from '../services/alertas.js'
import { estadoAlertas } from '../services/alertasProgramadas.js'
import { credenciales } from '../services/configMensajeria.js'
import { estadoWhatsapp, VIAS, automatico } from '../drivers/whatsapp/index.js'

/**
 * Las alertas, desde la oficina.
 *
 * Todo lo que sea leer o editar reglas y destinos va directo a Supabase con RLS:
 * es CRUD y no necesita al middleware. Acá viven las tres cosas que sí lo
 * necesitan, porque tocan credenciales o proveedores externos.
 */
const router = Router()
router.use(requireAuth)

/** Por dónde sale WhatsApp hoy y si está conectado. Sin exponer el token. */
router.get(
  '/estado',
  asyncHandler(async (_req, res) => {
    const { whatsapp } = await credenciales()
    const conexion = await estadoWhatsapp({ via: whatsapp.via, config: whatsapp })

    res.json({
      via: whatsapp.via,
      automatico: automatico(whatsapp.via),
      vias: VIAS,
      conexion,
      tarea: {
        encendida: estadoAlertas.automaticas,
        cada_minutos: estadoAlertas.cada,
        ultima_corrida: estadoAlertas.ultimaCorrida,
        ultimo_resultado: estadoAlertas.ultimoResultado,
      },
    })
  }),
)

/** Un mensaje de prueba. Es lo único que evita descubrir el número mal el día del corte. */
router.post(
  '/destinos/:id/probar',
  asyncHandler(async (req, res) => {
    res.json(await probarDestino(req.params.id))
  }),
)

/** Correr la detección a mano, sin esperar a la tarea. */
router.post(
  '/correr',
  asyncHandler(async (_req, res) => {
    res.json(await ejecutarAlertas({ ahora: new Date() }))
  }),
)

export default router
