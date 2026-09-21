import { Router } from 'express'
import { asyncHandler, notFound } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { db } from '../lib/db.js'
import { generarActaRetiro, generarActaEntrega } from '../pagos/actasPdf.js'

/**
 * Las actas firmadas, en PDF.
 *
 * ── Por qué pasan por el middleware y no se arman en el navegador ──
 *
 * Porque son el respaldo de que algo pasó, y tienen que salir iguales desde
 * cualquier pantalla y cualquier teléfono. Un PDF armado en el navegador
 * depende de qué navegador sea.
 *
 * ── Sobre el permiso ──
 *
 * Alcanza con estar autenticado: quien puede ver la orden puede imprimir su
 * acta. La orden ya está protegida por RLS —el técnico ve las suyas, el
 * vendedor las de sus clientes, la oficina todas— pero acá se lee con la clave
 * de servicio, así que el filtro de RLS no aplica. Es una concesión consciente:
 * el acta no expone nada que no esté en la pantalla desde la que se llega, y
 * hace falta que el técnico pueda imprimir la suya sin permisos de oficina.
 */
const router = Router()
router.use(requireAuth)

const enviar = (res, pdf, nombre, descargar) => {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Length', pdf.length)
  res.setHeader(
    'Content-Disposition',
    `${descargar ? 'attachment' : 'inline'}; filename="${nombre}"`,
  )
  res.send(pdf)
}

const empresa = async () =>
  (await db().from('config_general').select('nombre_sistema, logo_b64').maybeSingle()).data ?? {}

/** El acta de lo que pasó en la casa del abonado. */
router.get(
  '/retiro/:id',
  asyncHandler(async (req, res) => {
    const { data: retiro } = await db()
      .from('v_retiros_equipo')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle()

    if (!retiro) throw notFound('No existe esa orden de retiro')

    const [{ data: cliente }, { data: visitas }] = await Promise.all([
      db()
        .from('clientes')
        .select('codigo, nombre, identificacion, direccion, telefono, telefono_movil')
        .eq('id', retiro.cliente_id)
        .maybeSingle(),
      db()
        .from('retiro_intentos')
        .select('resultado, observacion, creado_en')
        .eq('retiro_id', retiro.id)
        .order('creado_en'),
    ])

    const pdf = await generarActaRetiro({
      empresa: await empresa(),
      retiro,
      cliente,
      visitas: visitas ?? [],
    })

    const quien = String(cliente?.nombre ?? 'abonado').split(' ')[0].toLowerCase()
    enviar(res, pdf, `acta-retiro-${quien}.pdf`, req.query.descargar === '1')
  }),
)

/** El acta de la entrega del técnico a la oficina. */
router.get(
  '/entrega/:id',
  asyncHandler(async (req, res) => {
    const { data: acta } = await db()
      .from('v_entregas_inventario')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle()

    if (!acta) throw notFound('No existe esa acta')

    // Las firmas no están en la vista: se leen de la tabla, que es donde viven.
    const { data: fila } = await db()
      .from('entregas_inventario')
      .select('firma_b64, firma_entrega_b64')
      .eq('id', req.params.id)
      .maybeSingle()

    const { data: items } = await db()
      .from('entrega_items')
      .select('serie, modelo, estado_fisico, observacion')
      .eq('entrega_id', req.params.id)

    const pdf = await generarActaEntrega({
      empresa: await empresa(),
      acta: {
        ...acta,
        firma_b64: fila?.firma_b64 ?? null,
        firma_entrega_b64: fila?.firma_entrega_b64 ?? null,
      },
      items: items ?? [],
    })

    enviar(res, pdf, `acta-entrega-${acta.numero}.pdf`, req.query.descargar === '1')
  }),
)

export default router
