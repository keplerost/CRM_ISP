import { db } from './db.js'

/**
 * El registro de quién hizo qué.
 *
 * Está acá y no en cada ruta porque auditar tiene que ser una línea. Si
 * registrar un hecho costara cinco líneas y un try/catch, la mitad de las
 * acciones quedarían sin registrar — y una auditoría con agujeros es peor que
 * no tenerla: da la falsa impresión de que lo que no está no pasó.
 */

/**
 * Resuelve el legajo de quien manda el pedido, a partir de su usuario de Auth.
 *
 * Devuelve null cuando no hay sesión (el middleware puede correr con
 * REQUIRE_AUTH apagado en desarrollo) o cuando el usuario de Auth todavía no
 * tiene legajo. Quien llama decide si eso es un error o no: para auditar, no lo
 * es; para autorizar, siempre lo es.
 */
export async function actorDe(req) {
  const authId = req.usuario?.id
  if (!authId) return null

  const { data } = await db()
    .from('usuarios_sistema')
    .select('id, nombre, apellido, usuario, email, rol, activo, permisos, tecnico_id')
    .eq('auth_id', authId)
    .maybeSingle()

  return data ?? null
}

/**
 * La IP real de quien pidió.
 *
 * Casi siempre hay un nginx adelante, y ahí `req.ip` es la del propio nginx —
 * la misma para todos. Un registro de auditoría donde todos comparten IP no
 * sirve para lo que se lo consulta.
 */
export function ipDe(req) {
  const reenviada = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return (reenviada || req.ip || '').replace(/^::ffff:/, '').slice(0, 45) || null
}

/**
 * Deja el hecho registrado. Nunca lanza.
 *
 * Que falle la auditoría no puede hacer fallar la acción: si el técnico cerró
 * el ticket, el ticket está cerrado, y devolverle un error porque no se pudo
 * escribir el renglón lo llevaría a cerrarlo de nuevo. Se avisa por consola y
 * sigue.
 */
export async function auditar(req, actor, { accion, descripcion, entidad, entidadId, datos }) {
  try {
    await db()
      .from('auditoria_sistema')
      .insert({
        usuario_id: actor?.id ?? null,
        usuario_nombre: actor ? `${actor.nombre} ${actor.apellido}`.trim() : 'Sistema',
        usuario_rol: actor?.rol ?? null,
        accion,
        descripcion,
        entidad: entidad ?? null,
        entidad_id: entidadId ? String(entidadId) : null,
        datos: datos ?? null,
        ip: ipDe(req),
        user_agent: (req.headers['user-agent'] || '').slice(0, 500) || null,
      })
  } catch (err) {
    console.warn('[auditoria] no se pudo registrar:', err.message)
  }
}
