import { AppError } from './errors.js'
import { actorDe } from './auditoria.js'
// El catálogo de permisos vive en el frontend y se importa desde acá a
// propósito: tener dos listas —una para la pantalla y otra para el servidor— es
// cómo se llega a que la pantalla oculte un botón que el servidor sigue
// aceptando. Una sola lista, dos lectores.
import { tienePermiso } from '../../../web/src/lib/permisos.js'

/**
 * Verificación de permisos para las rutas del middleware.
 *
 * ── El agujero que esto cierra ──
 *
 * Hasta acá todas las rutas usaban solamente `requireAuth`, que responde una
 * pregunta: ¿este token es válido? Nunca la otra: ¿este usuario tiene derecho a
 * pedir esto?
 *
 * En la práctica eso significaba que cualquiera con sesión —un técnico, un
 * vendedor— podía llamar a `/api/mikrotik/*` o `/api/olt/*` desde la consola del
 * navegador y ejecutar acciones sobre los equipos. Las credenciales nunca se
 * filtraron —eso estaba bien resuelto, el navegador no habla con los equipos—
 * pero las ACCIONES estaban abiertas. Reiniciar un puerto PON no requiere ver la
 * contraseña de la OLT.
 *
 * RLS no cubre este caso: el middleware usa la service_role key justamente para
 * saltearse RLS. Acá el único control posible es este.
 *
 * ── Por qué el legajo faltante NO pasa ──
 *
 * Un usuario de Auth sin fila en `usuarios_sistema` es un huérfano: quedó de una
 * instalación vieja, o alguien lo creó directo en Supabase. Tratarlo como "sin
 * permisos, pero adelante" sería la misma puerta por otro lado. Se rechaza y se
 * dice qué hacer.
 */

/**
 * Quién está pidiendo. Falla si no se puede responder con certeza.
 *
 * Devuelve el legajo completo, que las rutas usan además para auditar y para
 * filtrar por `tecnico_id`.
 */
export async function actorObligatorio(req) {
  // Se cachea en el request: una ruta que verifica permiso y después audita
  // haría dos consultas idénticas por cada llamada.
  if (req._actor) return req._actor

  const actor = await actorDe(req)
  if (!actor) {
    throw new AppError('Tu usuario no tiene un legajo de personal asociado', {
      status: 403,
      hint: 'Pedile a un Super Administrador que te cree el usuario en Ajustes → Gestión de personal.',
    })
  }
  if (!actor.activo) {
    throw new AppError('Tu usuario está desactivado', { status: 403 })
  }

  req._actor = actor
  return actor
}

/**
 * Middleware de Express: exige un permiso para toda una ruta o un router.
 *
 *     router.use(requireAuth, exigePermiso('red.routers'))
 *
 * Con un arreglo alcanza con tener uno, igual que en el frontend:
 *
 *     exigePermiso(['red.olts_ver', 'red.olts_operar'])
 */
export function exigePermiso(permiso) {
  const claves = Array.isArray(permiso) ? permiso : [permiso]

  return async function verificar(req, _res, next) {
    try {
      const actor = await actorObligatorio(req)
      if (!claves.some((c) => tienePermiso(actor, c))) {
        throw new AppError('No tenés permiso para esta acción', {
          status: 403,
          hint: `Hace falta ${claves.length > 1 ? 'alguno de estos permisos' : 'el permiso'}: ${claves.join(', ')}.`,
        })
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

/**
 * Un permiso para leer y otro para operar, sobre el mismo router.
 *
 * ── Por qué hace falta ──
 *
 * En la red las dos cosas viven en el mismo endpoint. `/api/olt/:id/onus` lista
 * las ONUs —que el técnico necesita para su trabajo— y `/api/olt/:id/onus/:x`
 * en POST la reinicia. Un único permiso para todo el router obliga a elegir
 * entre dejarle reiniciar la OLT o dejarlo sin ver la potencia de la ONU que
 * está instalando. Las dos opciones son malas.
 *
 * El método HTTP es el separador correcto acá y no una convención cómoda: GET
 * no cambia nada del equipo por definición. Cualquier ruta que sí cambie algo
 * con un GET está mal escrita, y esto la deja expuesta en vez de taparla.
 */
export function porMetodo({ lectura, escritura }) {
  const verLectura = exigePermiso(lectura)
  const verEscritura = exigePermiso(escritura)
  return (req, res, next) =>
    req.method === 'GET' ? verLectura(req, res, next) : verEscritura(req, res, next)
}

/**
 * La misma verificación, dentro del cuerpo de una ruta.
 *
 * Para cuando el permiso depende de lo que se pidió: leer un nodo es una cosa,
 * reiniciarlo es otra, y a veces las dos entran por el mismo endpoint.
 */
export async function exigir(req, permiso) {
  const actor = await actorObligatorio(req)
  const claves = Array.isArray(permiso) ? permiso : [permiso]
  if (permiso && !claves.some((c) => tienePermiso(actor, c))) {
    throw new AppError('No tenés permiso para esta acción', {
      status: 403,
      hint: `Hace falta ${claves.length > 1 ? 'alguno de estos permisos' : 'el permiso'}: ${claves.join(', ')}.`,
    })
  }
  return actor
}
