import { Router } from 'express'
import { asyncHandler, notFound, badRequest, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { db } from '../lib/db.js'
import { generarConsumoPdf } from '../pagos/consumoPdf.js'
import { recolectar, sincronizarSesiones, estadoConsumo } from '../services/consumoDiario.js'

/**
 * Consumo de los abonados.
 *
 * La lectura del consumo la hace el navegador directo contra Supabase —es una
 * consulta más—. Acá vive lo que el navegador no puede: hablarle al router para
 * medir, y armar el PDF que se le entrega al abonado que reclama.
 */

const router = Router()
router.use(requireAuth)

/** Qué mediría el proceso si corriera ahora, sin escribir nada. */
router.get(
  '/estado',
  asyncHandler(async (_req, res) => {
    res.json({
      automatico: estadoConsumo.automatico,
      cada_minutos: estadoConsumo.cada_minutos,
      ultimaCorrida: estadoConsumo.ultimaCorrida,
      ultimoResultado: estadoConsumo.ultimoResultado,
    })
  }),
)

/**
 * Mide ahora.
 *
 * Con `simular: true` devuelve lo que haría sin tocar la base: sirve para ver
 * si las colas del router se emparejan con los abonados antes de dejar el
 * proceso corriendo solo.
 */
router.post(
  '/recolectar',
  asyncHandler(async (req, res) => {
    res.json(await recolectar({ simular: req.body?.simular === true, fecha: req.body?.fecha ?? null }))
  }),
)

router.post(
  '/sesiones/sincronizar',
  asyncHandler(async (_req, res) => {
    res.json(await sincronizarSesiones())
  }),
)

/**
 * Reporte mensual de consumo, en PDF.
 *
 * `mes` va como YYYY-MM. Es lo que se manda por WhatsApp o por correo cuando el
 * abonado discute lo que consumió.
 */
router.get(
  '/:clientId/reporte',
  asyncHandler(async (req, res) => {
    const mes = String(req.query.mes ?? '').slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(mes)) throw badRequest('Indicá el mes como YYYY-MM')

    const { data: cliente, error } = await db()
      .from('clientes')
      .select('id, nombre, identificacion, direccion, ip, telefono, telefono_movil')
      .eq('id', req.params.clientId)
      .maybeSingle()

    if (error) throw new AppError(`No se pudo leer el cliente: ${error.message}`, { status: 502 })
    if (!cliente) throw notFound('No existe ese cliente')

    const [anio, m] = mes.split('-').map(Number)
    const desde = `${mes}-01`
    const hasta = `${anio}-${String(m).padStart(2, '0')}-${String(new Date(anio, m, 0).getDate()).padStart(2, '0')}`

    const { data: dias } = await db()
      .from('consumo_diario')
      .select('*')
      .eq('client_id', cliente.id)
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .order('fecha')

    const resumen = (dias ?? []).reduce(
      (acc, d) => ({
        subida_bytes: acc.subida_bytes + Number(d.subida_bytes),
        bajada_bytes: acc.bajada_bytes + Number(d.bajada_bytes),
      }),
      { subida_bytes: 0, bajada_bytes: 0 },
    )

    const { data: emisor } = await db().from('sri_config').select('*').limit(1).maybeSingle()

    const pdf = await generarConsumoPdf({
      emisor: emisor ?? {},
      cliente,
      mes,
      dias: dias ?? [],
      resumen,
    })

    const nombre = `consumo-${mes}-${String(cliente.nombre ?? '').split(' ')[0].toLowerCase()}.pdf`
    const disposicion = req.query.descargar === '1' ? 'attachment' : 'inline'

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Length', pdf.length)
    res.setHeader('Content-Disposition', `${disposicion}; filename="${nombre}"`)
    res.send(pdf)
  }),
)

export default router
