import { config } from '../config.js'
import { db } from './db.js'
import { AppError } from './errors.js'

/**
 * Valida el access token de Supabase que manda el frontend.
 *
 * Sin esto, cualquiera que alcance el puerto del middleware puede operar las OLTs
 * y los routers — el middleware guarda la service_role key y las credenciales
 * descifradas de todos los equipos.
 */
export async function requireAuth(req, _res, next) {
  if (!config.requireAuth) return next()

  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null

  if (!token) {
    return next(
      new AppError('Falta el token de autenticación', {
        status: 401,
        hint: 'El frontend tiene que mandar el access token de Supabase en el header Authorization.',
      }),
    )
  }

  try {
    const { data, error } = await db().auth.getUser(token)
    if (error || !data?.user) {
      return next(new AppError('Sesión inválida o expirada', { status: 401 }))
    }
    req.usuario = data.user
    next()
  } catch (err) {
    next(err)
  }
}
