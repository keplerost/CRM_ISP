import { Router } from 'express'

import { asyncHandler, badRequest, notFound } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { db } from '../lib/db.js'
import { armar, html } from '../services/paginaCorte.js'

/**
 * Ver la página del cortado como la vería un abonado.
 *
 * ── Por qué hace falta una vista previa con sesión ──
 *
 * Porque la página de verdad identifica al abonado por la IP DEL PEDIDO, y esa
 * es la única forma honesta de hacerlo: no hay contraseña de por medio. La
 * consecuencia es que desde la oficina no se puede ver lo que ve un abonado —
 * el pedido sale de otra IP y la página contesta "no te reconocí".
 *
 * Sin esto, la única manera de probarla sería cortarle el internet a alguien de
 * verdad y pedirle que cuente qué ve.
 *
 * ── Por qué esto NO es un agujero ──
 *
 * Porque exige sesión. La página pública sigue mirando solo el socket y no
 * acepta que nadie le diga de quién es la conexión: si aceptara una IP por
 * parámetro, cualquiera vería el nombre y la deuda de cualquiera escribiendo
 * una dirección.
 */
const router = Router()
router.use(requireAuth)

router.get(
  '/vista-previa',
  asyncHandler(async (req, res) => {
    const ip = String(req.query.ip ?? '').trim()
    if (!ip) throw badRequest('Falta la IP del abonado que se quiere previsualizar')

    const [rConf, rCuentas, rEmpresa, rAbonado] = await Promise.all([
      db().from('config_corte').select('*').eq('id', 1).maybeSingle(),
      db().from('cuentas_pago').select('*').eq('mostrar_en_corte', true),
      db().from('sri_config')
        .select('ruc, razon_social, nombre_comercial, telefono, logo_b64')
        .limit(1).maybeSingle(),
      db().from('v_corte_abonado').select('*').eq('ip', ip).maybeSingle(),
    ])

    if (rConf.error && /does not exist/i.test(rConf.error.message)) {
      throw badRequest('Falta la migración de la página de corte', {
        hint: 'Corré supabase/migracion-124-la-pagina-que-ve-el-cortado.sql',
      })
    }

    if (!rAbonado.data) {
      throw notFound(`Ningún abonado tiene la IP ${ip}`, {
        hint: 'Probá con la IP tal como está cargada en la ficha del abonado.',
      })
    }

    const datos = armar({
      abonado: rAbonado.data,
      config: rConf.data ?? {},
      cuentas: rCuentas.data ?? [],
      empresa: rEmpresa.data ?? {},
    })

    /**
     * Se devuelve la página ENTERA, no un resumen en JSON.
     *
     * Lo que hay que revisar antes de mandar a alguien a depositar es cómo se
     * ve el número de cuenta y si el monto se entiende, y eso no se comprueba
     * leyendo campos: se comprueba mirando.
     */
    if (req.query.formato === 'json') {
      return res.json({ ip, ...datos })
    }

    res.set('Cache-Control', 'no-store').type('html').send(html(datos))
  }),
)

export default router
