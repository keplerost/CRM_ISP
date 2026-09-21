import { Router } from 'express'
import { asyncHandler } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import * as migracion from '../services/migracionAbonados.js'
import * as plantilla from '../services/plantillaPadron.js'

/**
 * Traer la base de abonados de otro sistema.
 *
 * Va en dos pasos SIEMPRE: primero se revisa y se muestra qué va a pasar con
 * cada fila, y recién después se escribe. Una base de abonados es lo más caro
 * que tiene un ISP, e importarla mal se descubre en la primera facturación.
 *
 * El archivo se lee acá y no en el navegador. Es donde se lo puede probar
 * contra lo que rompe de verdad —el punto y coma de Excel en español, los
 * acentos en Latin-1, las comas adentro de una dirección, las fechas de un
 * .xlsx— y donde esas pruebas quedan escritas. El navegador no puede leer un
 * Excel sin cargarse media librería, y esto es lo más caro que tiene el ISP.
 *
 * Llega como `{ archivo: { nombre, base64 } }`. El límite del cuerpo para esta
 * ruta está subido en server.js: un padrón entero no entra en 1 MB.
 */
const router = Router()
router.use(requireAuth)

/** Lo que se puede elegir al armar la plantilla: routers y planes de verdad. */
router.get(
  '/abonados/opciones',
  asyncHandler(async (req, res) => {
    res.json(await plantilla.opciones())
  }),
)

/**
 * La plantilla, con el router adentro.
 *
 * Se devuelve el .xlsx directo y no un enlace: el archivo se arma en el momento
 * con las opciones que se acaban de elegir, así que guardarlo en algún lado para
 * después solo agregaría un archivo viejo que alguien puede bajar por error.
 */
router.post(
  '/abonados/plantilla',
  asyncHandler(async (req, res) => {
    const { buffer, nombre } = await plantilla.generar(req.body ?? {})
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`)
    res.send(buffer)
  }),
)

router.post(
  '/abonados/revisar',
  asyncHandler(async (req, res) => {
    res.json(await migracion.revisar(req.body ?? {}))
  }),
)

router.post(
  '/abonados/importar',
  asyncHandler(async (req, res) => {
    res.json(await migracion.importar(req.body ?? {}))
  }),
)

export default router
