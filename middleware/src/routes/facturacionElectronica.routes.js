import { Router } from 'express'
import { asyncHandler, badRequest, notFound, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { exigePermiso } from '../lib/permisos.js'
import { db } from '../lib/db.js'
import { encrypt } from '../lib/crypto.js'
import { paisDelIsp } from '../lib/paisIsp.js'
import { armarDatos, proveedorDe, proveedoresDe } from '../lib/proveedoresFactura.js'

/**
 * La factura electrónica de cada país: con qué proveedor y con qué datos.
 *
 * Solo el país del ISP. Un ISP de Chile no tiene nada que hacer con los
 * proveedores de México, y mostrárselos —como hace MikroWisp con diez
 * pestañas— solo agrega lugares donde equivocarse.
 *
 * Mismo permiso que la configuración del SRI: es la misma decisión, hecha en
 * otro país.
 */
const router = Router()
router.use(requireAuth, exigePermiso('config.facturacion'))

const SIN_TABLA = 'Si dice que no existe la tabla factura_proveedores, falta correr la migración 200.'

/** Lo guardado, sin los secretos: de cada uno solo se dice si tiene valor. */
function aPantalla(fila) {
  if (!fila) return null
  return {
    activo: fila.activo,
    modo_prueba: fila.modo_prueba,
    datos: fila.datos ?? {},
    secretos: Object.fromEntries(Object.keys(fila.secretos_cifrados ?? {}).map((k) => [k, true])),
    actualizado_en: fila.actualizado_en,
  }
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const pais = await paisDelIsp()
    const catalogo = proveedoresDe(pais.codigo)

    const { data, error } = await db().from('factura_proveedores').select('*').eq('pais', pais.codigo)
    // Sin la tabla se muestra el catálogo igual: es lo que sirve para enseñarle
    // a un ISP dónde va a cargar sus datos, aunque todavía no se puedan guardar.
    if (error) console.warn('[factura electrónica] no se pudo leer lo guardado:', error.message)
    const guardados = new Map((data ?? []).map((f) => [f.proveedor, f]))

    res.json({
      pais: { codigo: pais.codigo, nombre: pais.nombre, ente: pais.ente },
      sinTabla: Boolean(error),
      proveedores: catalogo.map((p) => ({ ...p, guardado: aPantalla(guardados.get(p.id)) })),
    })
  }),
)

router.put(
  '/:proveedor',
  asyncHandler(async (req, res) => {
    const pais = await paisDelIsp()
    const proveedor = proveedorDe(pais.codigo, req.params.proveedor)
    if (!proveedor) throw notFound(`${req.params.proveedor} no es un proveedor de ${pais.nombre}.`)
    if (proveedor.configuraEn) {
      throw badRequest(`${proveedor.nombre} se configura en otra pantalla.`, { hint: proveedor.configuraEn })
    }

    const activo = Boolean(req.body?.activo)
    const { data: previa, error: errPrevia } = await db()
      .from('factura_proveedores')
      .select('*')
      .eq('pais', pais.codigo)
      .eq('proveedor', proveedor.id)
      .maybeSingle()
    if (errPrevia) throw new AppError(`No se pudo leer lo guardado: ${errPrevia.message}`, { status: 502, hint: SIN_TABLA })

    const cifradosPrevios = previa?.secretos_cifrados ?? {}
    const { datos, secretos, faltan } = armarDatos(proveedor, req.body?.valores ?? {}, {
      activo,
      guardados: Object.fromEntries(Object.keys(cifradosPrevios).map((k) => [k, true])),
    })
    if (faltan.length) {
      throw badRequest(`Para activarlo faltan: ${faltan.join(', ')}.`, {
        hint: 'Se puede guardar sin activar, y completarlo después.',
      })
    }

    // Activar uno apaga los demás del país: uno solo emite.
    if (activo) {
      const { error } = await db()
        .from('factura_proveedores')
        .update({ activo: false })
        .eq('pais', pais.codigo)
        .neq('proveedor', proveedor.id)
      if (error) throw new AppError(`No se pudo desactivar el proveedor anterior: ${error.message}`, { status: 502 })
    }

    const cifrados = { ...cifradosPrevios }
    for (const [k, v] of Object.entries(secretos)) cifrados[k] = encrypt(v)

    const { data, error } = await db()
      .from('factura_proveedores')
      .upsert(
        {
          pais: pais.codigo,
          proveedor: proveedor.id,
          activo,
          modo_prueba: req.body?.valores?.modo_prueba !== false,
          datos,
          secretos_cifrados: cifrados,
          actualizado_en: new Date().toISOString(),
        },
        { onConflict: 'pais,proveedor' },
      )
      .select()
      .single()
    if (error) throw new AppError(`No se pudo guardar: ${error.message}`, { status: 502, hint: SIN_TABLA })

    res.json({ ...proveedor, guardado: aPantalla(data) })
  }),
)

/**
 * Probar la conexión.
 *
 * Mientras un proveedor no está integrado lo dice tal cual, en vez de fingir un
 * "conexión correcta" que no se comprobó.
 */
router.post(
  '/:proveedor/probar',
  asyncHandler(async (req, res) => {
    const pais = await paisDelIsp()
    const proveedor = proveedorDe(pais.codigo, req.params.proveedor)
    if (!proveedor) throw notFound(`${req.params.proveedor} no es un proveedor de ${pais.nombre}.`)

    if (!proveedor.integrado) {
      return res.json({
        ok: false,
        integrado: false,
        mensaje: `Los datos de ${proveedor.nombre} quedan guardados, pero la conexión todavía no está programada: se programa al habilitar la facturación electrónica en ${pais.nombre}.`,
      })
    }
    res.json({ ok: true, integrado: true, mensaje: `${proveedor.nombre} se prueba desde su propia pantalla.` })
  }),
)

export default router
