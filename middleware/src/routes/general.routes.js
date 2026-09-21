import { Router } from 'express'
import { asyncHandler, badRequest, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { db } from '../lib/db.js'

/**
 * La marca del sistema: lo que se ve en pantalla.
 *
 * Es distinto de los datos de la empresa. Aquellos salen impresos en la factura
 * y los valida el SRI; esto es el nombre y el logo que ve el técnico al entrar,
 * y puede ser otra cosa — el nombre comercial, o el que le pusieron adentro.
 *
 * Leer NO exige sesión: el login tiene que mostrar el nombre y el logo, y ahí
 * todavía no hay usuario. No hay nada secreto en esto — es justamente lo que
 * cualquiera ve al abrir el sistema.
 */
const router = Router()

const POR_DEFECTO = {
  nombre_sistema: 'Taller SmartOLT',
  lema: 'Gestión de OLTs y MikroTik',
  logo_b64: null,
  moneda_simbolo: '$',
  moneda_codigo: 'USD',
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const { data, error } = await db().from('config_general').select('*').eq('id', 1).maybeSingle()

    // Que falte la tabla no puede dejar el login en blanco: se cae a los
    // valores por defecto, que es exactamente lo que había antes.
    if (error) {
      console.warn('[general] no se pudo leer la configuración:', error.message)
      return res.json(POR_DEFECTO)
    }

    res.json({
      nombre_sistema: data?.nombre_sistema || POR_DEFECTO.nombre_sistema,
      lema: data?.lema ?? POR_DEFECTO.lema,
      logo_b64: data?.logo_b64 ?? null,
      moneda_simbolo: data?.moneda_simbolo || POR_DEFECTO.moneda_simbolo,
      moneda_codigo: data?.moneda_codigo || POR_DEFECTO.moneda_codigo,
    })
  }),
)

const CAMPOS = ['nombre_sistema', 'lema', 'logo_b64', 'moneda_simbolo', 'moneda_codigo']

router.put(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const fila = {}
    for (const campo of CAMPOS) {
      if (campo in req.body) fila[campo] = req.body[campo] === '' ? null : req.body[campo]
    }

    // Sin símbolo, cada monto del sistema saldría pelado y nadie sabría si son
    // dólares o soles. Vacío se lee como "no lo cambies".
    if ('moneda_simbolo' in fila && !fila.moneda_simbolo) delete fila.moneda_simbolo
    if (fila.moneda_simbolo && String(fila.moneda_simbolo).length > 5) {
      throw badRequest('El símbolo de la moneda no puede tener más de 5 caracteres.')
    }

    // Un logo grande viaja en cada carga del login, y el login lo abre gente
    // desde el celular en la calle.
    if (fila.logo_b64 && fila.logo_b64.length > 550_000) {
      throw badRequest('El logo pesa demasiado. Usá una versión más chica: con 400×200 alcanza.')
    }

    if (Object.keys(fila).length) {
      fila.actualizado_en = new Date().toISOString()
      const { error } = await db().from('config_general').update(fila).eq('id', 1)
      if (error) {
        throw new AppError(`No se pudo guardar: ${error.message}`, {
          status: 502,
          hint: 'Si dice que no existe la tabla, falta correr la migración 63.',
        })
      }
    }

    const { data } = await db().from('config_general').select('*').eq('id', 1).maybeSingle()
    res.json({ ...POR_DEFECTO, ...(data ?? {}) })
  }),
)

export default router
