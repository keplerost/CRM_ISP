import { Router } from 'express'
import { asyncHandler, AppError } from '../lib/errors.js'
import {
  cambiarClave,
  cambiarServicio,
  serviciosDeLaSesion,
  cerrarLasDemas,
  clienteDeLaSesion,
  entrar,
  entrarConClave,
  pedirCodigo,
  salir,
} from '../services/portalAuth.js'
import {
  abrirTicket,
  actualizarContacto,
  miConsumo,
  miCuenta,
  miSolicitudWifi,
  misFacturas,
  misTickets,
  miWifi,
  pedirCambioWifi,
} from '../services/portal.js'

/**
 * El portal del abonado.
 *
 * Separado del resto del API a propósito. Todo lo demás lo usa el personal del
 * ISP, con sesión de Supabase; esto lo usa el abonado, con su propia sesión y
 * desde su celular. Mezclarlos haría que un error de permisos en un lado abra
 * una puerta en el otro.
 *
 * NINGUNA ruta de acá recibe un id de cliente. El id sale de la sesión y solo
 * de ahí. Si una ruta lo aceptara por parámetro, alcanzaría con cambiar un
 * número para ver la cuenta del vecino — que es exactamente cómo se filtran
 * estos portales.
 */
const router = Router()

/** Saca el token del header. Bearer, como todo el resto. */
const tokenDe = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || null

/**
 * De acá para abajo hace falta sesión de abonado.
 *
 * Deja `req.clienteId` y nada más: las rutas no tienen forma de pedir otro.
 */
async function conSesion(req, res, next) {
  const clienteId = await clienteDeLaSesion(tokenDe(req))
  if (!clienteId) {
    return res.status(401).json({
      error: 'Tu sesión venció. Volvé a entrar con tu cédula.',
      sesion_vencida: true,
    })
  }
  req.clienteId = clienteId
  next()
}

// --- Entrada (sin sesión) ----------------------------------------------------

router.post(
  '/codigo',
  asyncHandler(async (req, res) => {
    res.json(await pedirCodigo({ identificacion: req.body?.identificacion }))
  }),
)

router.post(
  '/entrar',
  asyncHandler(async (req, res) => {
    const r = await entrar({
      identificacion: req.body?.identificacion,
      codigo: req.body?.codigo,
      agente: req.headers['user-agent'],
    })
    res.json(r)
  }),
)

/** Con contraseña, para el que ya la definió. */
router.post(
  '/entrar-clave',
  asyncHandler(async (req, res) => {
    res.json(
      await entrarConClave({
        identificacion: req.body?.identificacion,
        clave: req.body?.clave,
        agente: req.headers['user-agent'],
      }),
    )
  }),
)

router.post(
  '/salir',
  asyncHandler(async (req, res) => {
    await salir(tokenDe(req))
    res.json({ ok: true })
  }),
)

// --- Con sesión --------------------------------------------------------------

router.use(conSesion)

router.get(
  '/mi-cuenta',
  asyncHandler(async (req, res) => {
    // Los servicios van acá y no solo en la respuesta del ingreso: al recargar
    // la página esa respuesta ya no existe, y el selector tiene que seguir
    // estando. El portal se abre en un celular y se recarga todo el tiempo.
    const [cuenta, servicios] = await Promise.all([
      miCuenta(req.clienteId),
      serviciosDeLaSesion(req.clienteId),
    ])
    res.json({ ...cuenta, servicios })
  }),
)

router.get(
  '/facturas',
  asyncHandler(async (req, res) => {
    res.json(await misFacturas(req.clienteId))
  }),
)

router.get(
  '/consumo',
  asyncHandler(async (req, res) => {
    res.json(await miConsumo(req.clienteId, { dias: Math.min(90, Number(req.query.dias) || 30) }))
  }),
)

router.get(
  '/tickets',
  asyncHandler(async (req, res) => {
    res.json(await misTickets(req.clienteId))
  }),
)

router.post(
  '/tickets',
  asyncHandler(async (req, res) => {
    res.json(await abrirTicket(req.clienteId, req.body ?? {}))
  }),
)

router.put(
  '/contacto',
  asyncHandler(async (req, res) => {
    res.json(await actualizarContacto(req.clienteId, req.body ?? {}))
  }),
)

/**
 * Definir o cambiar la contraseña.
 *
 * Va con sesión: para llegar acá ya entró, sea por código o por contraseña. Si
 * ya tenía una, igual hay que dar la anterior — es lo que impide que alguien
 * que agarró el teléfono desbloqueado se quede con la cuenta.
 */
router.post(
  '/clave',
  asyncHandler(async (req, res) => {
    const r = await cambiarClave(req.clienteId, req.body ?? {})

    // Las demás sesiones se cierran, la actual no: quien acaba de cambiarla
    // desde su celular no tiene por qué volver a entrar, pero cualquier otro
    // dispositivo sí.
    await cerrarLasDemas(req.clienteId, tokenDe(req))
    res.json(r)
  }),
)

/**
 * Pasar la sesión a otro servicio de la misma persona.
 *
 * El token no cambia: se mueve la sesión, no se abre otra. Así el portal no
 * tiene que volver a guardar nada y no quedan sesiones sueltas cada vez que
 * alguien mira su otro servicio.
 */
router.post(
  '/servicio',
  asyncHandler(async (req, res) => {
    res.json(await cambiarServicio(tokenDe(req), req.body?.clienteId))
  }),
)

/** Lo que la ONT reportó de su WiFi, más el historial de pedidos. */
router.get(
  '/wifi',
  asyncHandler(async (req, res) => {
    const [equipo, pedidos] = await Promise.all([
      miWifi(req.clienteId),
      miSolicitudWifi(req.clienteId),
    ])
    res.json({ equipo, pedidos })
  }),
)

router.post(
  '/wifi',
  asyncHandler(async (req, res) => {
    res.json(await pedirCambioWifi(req.clienteId, req.body ?? {}))
  }),
)

export default router
