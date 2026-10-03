import { Router } from 'express'
import { AppError, asyncHandler, badRequest } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { db } from '../lib/db.js'
import { exigir } from '../lib/permisos.js'
import { nombreMes } from '../../../web/src/lib/crecimientoRouters.js'
import { generarCrecimientoExcel, generarCrecimientoPdf } from '../services/reporteCrecimiento.js'

/**
 * Reportes de gestión que se bajan como archivo.
 *
 * La pantalla lee los mismos datos directo de la base; acá solo se arma el
 * papel, que necesita el logo y los datos de la empresa.
 */
const router = Router()
router.use(requireAuth)

const FECHA = /^\d{4}-\d{2}-\d{2}$/

function logoDe(config) {
  if (!config?.logo_b64) return null
  try {
    return Buffer.from(
      String(config.logo_b64).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, ''),
      'base64',
    )
  } catch {
    return null
  }
}

/**
 * Crecimiento por router: altas, bajas, total y la foto mensual de morosos.
 *
 * GET /api/reportes/crecimiento-routers?desde=AAAA-MM-DD&hasta=AAAA-MM-DD
 *     [&router=<uuid>|sin-router][&formato=excel|pdf]
 */
router.get(
  '/crecimiento-routers',
  asyncHandler(async (req, res) => {
    await exigir(req, ['reportes.exportar', 'finanzas.exportar'])

    const { desde, hasta, router: soloRouter, formato = 'excel' } = req.query
    if (!FECHA.test(desde ?? '') || !FECHA.test(hasta ?? '')) {
      throw badRequest('Indicá desde y hasta como AAAA-MM-DD')
    }
    if (desde > hasta) throw badRequest('"desde" no puede ser posterior a "hasta"')

    const { data, error } = await db().rpc('reporte_crecimiento_routers', {
      p_desde: desde,
      p_hasta: hasta,
    })
    if (error) {
      throw new AppError(
        /does not exist|could not find/i.test(error.message)
          ? 'Falta la función del reporte. Corré supabase/migracion-203-el-crecimiento-por-router.sql'
          : `No se pudo armar el reporte: ${error.message}`,
        { status: 502 },
      )
    }

    const filas = (data ?? []).filter((f) =>
      !soloRouter ? true : soloRouter === 'sin-router' ? f.router_id == null : f.router_id === soloRouter,
    )

    const { data: empresa } = await db().from('sri_config').select('*').limit(1).maybeSingle()
    const periodo =
      desde.slice(0, 7) === hasta.slice(0, 7)
        ? nombreMes(desde)
        : `${nombreMes(desde)} a ${nombreMes(hasta)}`
    const nombreRouter = soloRouter ? filas[0]?.router : null
    const base = `crecimiento-routers-${desde.slice(0, 7)}_${hasta.slice(0, 7)}`
    const titulo = nombreRouter ? `${periodo} · ${nombreRouter}` : periodo

    if (formato === 'pdf') {
      const pdf = await generarCrecimientoPdf({
        filas,
        empresa: empresa ?? {},
        periodo: titulo,
        logo: logoDe(empresa),
      })
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Length', pdf.length)
      res.setHeader('Content-Disposition', `inline; filename="${base}.pdf"`)
      return res.send(pdf)
    }

    const xlsx = await generarCrecimientoExcel({ filas, empresa: empresa ?? {}, periodo: titulo })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Length', xlsx.length)
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`)
    res.send(xlsx)
  }),
)

export default router
