import { Router } from 'express'
import { asyncHandler, badRequest, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { db } from '../lib/db.js'
import { actorDe, auditar, ipDe } from '../lib/auditoria.js'
import {
  CLAVES_PERMISO,
  CLAVES_SOLO_SUPER,
  TODO,
  nombreRol,
  permisosDeRol,
  puedeEditarA,
  puedeGestionarRol,
  tienePermiso,
} from '../../../web/src/lib/permisos.js'

/**
 * Gestión de personal: crear usuarios, asignarles rol y afinar sus permisos.
 *
 * ── Por qué esto no lo hace el navegador ──
 *
 * Leer el personal sí lo hace: la pantalla consulta Supabase directo y RLS deja
 * leer. Escribir no, por tres razones que no se arreglan con RLS:
 *
 * 1. Crear la credencial exige la service_role key, que nunca sale del backend.
 * 2. La regla de que un Administrador no puede crear otro Administrador es una
 *    decisión sobre quién pide, no sobre qué fila se toca. En el navegador se
 *    saltea con la consola abierta; acá no.
 * 3. La auditoría tiene que escribirla alguien a quien el auditado no pueda
 *    editarle el renglón.
 */
const router = Router()

router.use(requireAuth)

const CAMPOS = `
  id, auth_id, nombre, apellido, usuario, email, celular, rol, activo,
  todas_las_zonas, dos_factores, permisos, tecnico_id, creado_por,
  ultimo_acceso, creado_en, actualizado_en
`

const nombreCompleto = (u) => `${u.nombre} ${u.apellido || ''}`.trim()

/**
 * Quién pide, y si tiene derecho a estar acá.
 *
 * El legajo faltante NO es "sin permisos": es un usuario de Auth que quedó
 * huérfano, y dejarlo pasar como anónimo sería exactamente el agujero que este
 * módulo viene a cerrar.
 */
async function exigirActor(req, permiso) {
  const actor = await actorDe(req)
  if (!actor) {
    throw new AppError('Tu usuario no tiene un legajo de personal asociado', {
      status: 403,
      hint: 'Pedile a un Super Administrador que te cree el usuario en Ajustes → Gestión de personal.',
    })
  }
  if (!actor.activo) throw new AppError('Tu usuario está desactivado', { status: 403 })
  if (permiso && !tienePermiso(actor, permiso)) {
    throw new AppError('No tenés permiso para esta acción', {
      status: 403,
      hint: `Hace falta el permiso "${permiso}".`,
    })
  }
  return actor
}

/**
 * Filtra la lista de permisos que llegó del navegador.
 *
 * Se descarta lo que no existe en el catálogo —una clave inventada guardada en
 * la base es una puerta que después alguien puede aprender a abrir— y lo que
 * está reservado al Super Administrador. Que la pantalla no ofrezca esos
 * checkboxes no alcanza: el pedido se arma a mano en dos minutos.
 */
function sanearPermisos(lista, rolObjetivo, actor) {
  if (!Array.isArray(lista)) return []

  // El comodín es del Super Administrador y solo lo otorga un Super
  // Administrador. Es la llave maestra: no se reparte por checkbox.
  if (lista.includes(TODO)) {
    if (rolObjetivo === 'super_admin' && actor.rol === 'super_admin') return [TODO]
    return []
  }

  const permitidas = new Set(
    actor.rol === 'super_admin'
      ? CLAVES_PERMISO
      : CLAVES_PERMISO.filter((c) => !CLAVES_SOLO_SUPER.includes(c)),
  )
  return [...new Set(lista.filter((c) => permitidas.has(c)))]
}

/** Diferencia entre dos listas de permisos, para que la auditoría diga qué cambió. */
function cambioDePermisos(antes = [], despues = []) {
  const a = new Set(antes)
  const d = new Set(despues)
  const agregados = despues.filter((c) => !a.has(c))
  const quitados = antes.filter((c) => !d.has(c))
  return agregados.length || quitados.length ? { agregados, quitados } : null
}

const limpiar = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined)

function validarAlta(cuerpo) {
  const nombre = limpiar(cuerpo.nombre, 60)
  const usuario = limpiar(cuerpo.usuario, 40)
  const email = limpiar(cuerpo.email, 120)

  if (!nombre) throw badRequest('Falta el nombre')
  if (!usuario) throw badRequest('Falta el nombre de usuario')
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw badRequest('El correo electrónico no es válido')
  }
  return { nombre, usuario, email: email.toLowerCase() }
}

// -----------------------------------------------------------------------------
// Quién soy
// -----------------------------------------------------------------------------
// La app lo pide al entrar para saber qué menú dibujar. No exige permiso: es
// sobre uno mismo, y negarlo dejaría al usuario sin poder ver ni su propia
// pantalla.
router.get(
  '/yo',
  asyncHandler(async (req, res) => {
    const actor = await actorDe(req)
    res.json({ usuario: actor })
  }),
)

/**
 * Sella el último acceso.
 *
 * Se llama al entrar. Sirve para la columna "último acceso" de la pantalla, que
 * es lo que responde la pregunta de si una cuenta sigue en uso o quedó abierta
 * de alguien que ya no está.
 */
router.post(
  '/acceso',
  asyncHandler(async (req, res) => {
    const actor = await actorDe(req)
    if (!actor) return res.json({ ok: false })

    await db()
      .from('usuarios_sistema')
      .update({ ultimo_acceso: new Date().toISOString() })
      .eq('id', actor.id)

    // ── Desde dónde entró ──
    //
    // Esto solo lo puede hacer el middleware: es el único que ve la IP real
    // —el navegador no la conoce y no se le puede preguntar—. Registrarlo es lo
    // que después permite responder "¿entró desde otro lado?".
    const ip = ipDe(req)
    let esNueva = false

    if (ip) {
      const { data: conocido } = await db()
        .from('usuario_dispositivos')
        .select('id, accesos')
        .eq('usuario_id', actor.id)
        .eq('ip', ip)
        .maybeSingle()

      if (conocido) {
        await db()
          .from('usuario_dispositivos')
          .update({ ultima_vez: new Date().toISOString(), accesos: conocido.accesos + 1 })
          .eq('id', conocido.id)
      } else {
        esNueva = true
        await db().from('usuario_dispositivos').insert({
          usuario_id: actor.id,
          ip,
          user_agent: (req.headers['user-agent'] || '').slice(0, 500) || null,
        })
      }
    }

    await auditar(req, actor, {
      // Una IP nueva es una acción distinta, no una nota al pie del inicio de
      // sesión: así se puede filtrar la auditoría por ella y encontrar los tres
      // casos del mes en vez de leer mil renglones iguales.
      accion: esNueva ? 'sesion.ip_nueva' : 'sesion.iniciar',
      descripcion: esNueva
        ? `${nombreRol(actor.rol)} ${nombreCompleto(actor)} entró desde una IP nueva (${ip})`
        : `${nombreRol(actor.rol)} ${nombreCompleto(actor)} inició sesión`,
      entidad: 'usuario',
      entidadId: actor.id,
    })

    res.json({ ok: true, ip_nueva: esNueva })
  }),
)

// -----------------------------------------------------------------------------
// Crear
// -----------------------------------------------------------------------------
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const actor = await exigirActor(req, 'usuarios.crear')
    const { nombre, usuario, email } = validarAlta(req.body || {})
    const rol = req.body.rol || 'tecnico'
    const clave = req.body.clave || ''

    if (rol === 'super_admin') {
      throw new AppError('El Super Administrador no se crea desde el sistema', {
        status: 403,
        hint: 'Es el dueño de la instalación y ya existe. Sumar un segundo es una operación deliberada en la base — está documentada al pie de la migración 66.',
      })
    }
    if (!puedeGestionarRol(actor.rol, rol)) {
      throw new AppError(`Un ${nombreRol(actor.rol)} no puede crear un ${nombreRol(rol)}`, {
        status: 403,
        hint: 'Solo el Super Administrador puede crear Administradores.',
      })
    }
    if (clave.length < 8) throw badRequest('La contraseña necesita al menos 8 caracteres')

    const permisos = sanearPermisos(
      Array.isArray(req.body.permisos) ? req.body.permisos : permisosDeRol(rol),
      rol,
      actor,
    )

    // La credencial primero. Si falla —correo repetido, clave débil— no queda
    // un legajo suelto que no puede entrar y que después alguien tiene que
    // descubrir por qué no funciona.
    const { data: creado, error: errAuth } = await db().auth.admin.createUser({
      email,
      password: clave,
      email_confirm: true,
      user_metadata: { full_name: `${nombre} ${limpiar(req.body.apellido, 60) || ''}`.trim() },
    })
    if (errAuth) {
      const repetido = /already|registered|exists/i.test(errAuth.message || '')
      throw new AppError(
        repetido ? `Ya hay un usuario con el correo ${email}` : `No se pudo crear la credencial: ${errAuth.message}`,
        { status: repetido ? 409 : 502 },
      )
    }

    const fila = {
      auth_id: creado.user.id,
      nombre,
      apellido: limpiar(req.body.apellido, 60) || '',
      usuario,
      email,
      celular: limpiar(req.body.celular, 30) || null,
      rol,
      activo: req.body.activo !== false,
      todas_las_zonas: req.body.todas_las_zonas === true,
      dos_factores: req.body.dos_factores === true,
      permisos,
      tecnico_id: req.body.tecnico_id || null,
      creado_por: actor.id,
    }

    const { data, error } = await db().from('usuarios_sistema').insert(fila).select(CAMPOS).single()

    if (error) {
      // El legajo no entró pero la credencial sí. Sin esta limpieza queda un
      // usuario de Auth que puede iniciar sesión y al que el sistema no le
      // reconoce ningún rol: entra a la nada, y no aparece en ninguna lista
      // donde alguien pueda verlo para borrarlo.
      await db().auth.admin.deleteUser(creado.user.id).catch(() => {})
      const repetido = error.code === '23505'
      throw new AppError(
        repetido ? `Ya existe un usuario "${usuario}" o con ese correo` : `No se pudo guardar el usuario: ${error.message}`,
        { status: repetido ? 409 : 502 },
      )
    }

    await auditar(req, actor, {
      accion: 'usuario.crear',
      descripcion: `${nombreRol(actor.rol)} creó usuario ${nombreRol(rol)} ${nombreCompleto(data)}`,
      entidad: 'usuario',
      entidadId: data.id,
      datos: { rol, permisos },
    })

    res.status(201).json({ usuario: data })
  }),
)

// -----------------------------------------------------------------------------
// Editar
// -----------------------------------------------------------------------------
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const actor = await exigirActor(req, 'usuarios.editar')

    const { data: previo } = await db()
      .from('usuarios_sistema')
      .select(CAMPOS)
      .eq('id', req.params.id)
      .maybeSingle()
    if (!previo) throw new AppError('No existe ese usuario', { status: 404 })

    const esUnoMismo = previo.id === actor.id

    // Se verifica contra el rol que TIENE y contra el que va a tener. Sin lo
    // primero, un Administrador podría reetiquetar a un Super Administrador
    // como técnico y quedarse con el sistema; sin lo segundo, ascender a un
    // técnico cualquiera a Administrador y entrar con él.
    if (!puedeEditarA(actor, previo)) {
      throw new AppError(`Un ${nombreRol(actor.rol)} no puede modificar a un ${nombreRol(previo.rol)}`, {
        status: 403,
        hint:
          previo.rol === 'super_admin'
            ? 'Al Super Administrador solo lo edita él mismo: es el dueño de la instalación.'
            : undefined,
      })
    }
    const rol = esUnoMismo ? previo.rol : (req.body.rol ?? previo.rol)
    if (rol !== previo.rol && !puedeGestionarRol(actor.rol, rol)) {
      throw new AppError(`Un ${nombreRol(actor.rol)} no puede asignar el rol ${nombreRol(rol)}`, {
        status: 403,
      })
    }

    const cambios = { rol, actualizado_en: new Date().toISOString() }
    for (const [campo, max] of [['nombre', 60], ['apellido', 60], ['usuario', 40], ['celular', 30]]) {
      if (req.body[campo] !== undefined) cambios[campo] = limpiar(req.body[campo], max) || (campo === 'celular' ? null : previo[campo])
    }
    if (req.body.email !== undefined) {
      const { email } = validarAlta({ ...previo, ...req.body })
      cambios.email = email
    }
    for (const bandera of ['activo', 'todas_las_zonas', 'dos_factores']) {
      if (req.body[bandera] !== undefined) cambios[bandera] = req.body[bandera] === true
    }
    if (req.body.tecnico_id !== undefined) cambios.tecnico_id = req.body.tecnico_id || null

    if (req.body.permisos !== undefined && !esUnoMismo) {
      if (!tienePermiso(actor, 'usuarios.permisos')) {
        throw new AppError('No tenés permiso para cambiar permisos', { status: 403 })
      }
      cambios.permisos = sanearPermisos(req.body.permisos, rol, actor)
    }

    // Nadie se amplía, se degrada ni se desactiva a sí mismo.
    //
    // El legajo propio se toca para los datos —nombre, celular, correo—, nunca
    // para los poderes. Sin esta línea, cualquier Administrador con
    // `usuarios.permisos` se marcaría los checkboxes que le falten y el escalón
    // entre roles sería decorativo. Y desactivarse solo es la forma más común
    // de dejar un sistema sin nadie que administre y con la puerta cerrada por
    // dentro.
    if (esUnoMismo) {
      if (cambios.activo === false) throw badRequest('No podés desactivar tu propio usuario')
      if (req.body.rol && req.body.rol !== previo.rol) {
        throw badRequest('No podés cambiarte el rol a vos mismo')
      }
      delete cambios.permisos
      delete cambios.todas_las_zonas
    }

    const { data, error } = await db()
      .from('usuarios_sistema')
      .update(cambios)
      .eq('id', previo.id)
      .select(CAMPOS)
      .single()
    if (error) {
      const repetido = error.code === '23505'
      throw new AppError(repetido ? 'Ya hay otro usuario con ese nombre de usuario o correo' : error.message, {
        status: repetido ? 409 : 502,
      })
    }

    // El correo es la credencial: si cambia acá y no en Auth, la persona sigue
    // entrando con el viejo y la pantalla muestra otro. Dos verdades distintas
    // sobre lo mismo.
    if (cambios.email && cambios.email !== previo.email && previo.auth_id) {
      await db().auth.admin.updateUserById(previo.auth_id, { email: cambios.email }).catch((err) => {
        console.warn('[personal] el correo cambió en el legajo pero no en Auth:', err.message)
      })
    }

    const diff = cambioDePermisos(previo.permisos, data.permisos)
    const partes = []
    if (data.rol !== previo.rol) partes.push(`rol ${nombreRol(previo.rol)} → ${nombreRol(data.rol)}`)
    if (data.activo !== previo.activo) partes.push(data.activo ? 'reactivado' : 'desactivado')
    if (diff) partes.push(`permisos: +${diff.agregados.length} / −${diff.quitados.length}`)

    await auditar(req, actor, {
      accion: diff && partes.length === 1 ? 'usuario.permisos' : 'usuario.editar',
      descripcion: `${nombreRol(actor.rol)} editó al usuario ${nombreCompleto(data)}${
        partes.length ? ` (${partes.join(', ')})` : ''
      }`,
      entidad: 'usuario',
      entidadId: data.id,
      datos: { antes: { rol: previo.rol, activo: previo.activo }, permisos: diff },
    })

    res.json({ usuario: data })
  }),
)

// -----------------------------------------------------------------------------
// Cambiar la contraseña
// -----------------------------------------------------------------------------
router.post(
  '/:id/clave',
  asyncHandler(async (req, res) => {
    const actor = await exigirActor(req, 'usuarios.editar')
    const clave = req.body?.clave || ''
    if (clave.length < 8) throw badRequest('La contraseña necesita al menos 8 caracteres')

    const { data: destino } = await db()
      .from('usuarios_sistema')
      .select('id, auth_id, nombre, apellido, rol')
      .eq('id', req.params.id)
      .maybeSingle()
    if (!destino) throw new AppError('No existe ese usuario', { status: 404 })
    // `puedeEditarA` y no `puedeGestionarRol`: el Super Administrador ya no es
    // gestionable por nadie, pero tiene que poder cambiarse su propia clave sin
    // depender de otro. Es la primera cosa que hace quien sospecha que alguien
    // le usó la sesión.
    if (!puedeEditarA(actor, destino)) {
      throw new AppError(`Un ${nombreRol(actor.rol)} no puede cambiarle la clave a un ${nombreRol(destino.rol)}`, {
        status: 403,
        hint:
          destino.rol === 'super_admin'
            ? 'La clave del Super Administrador la cambia él mismo, o se recupera por correo desde el login.'
            : undefined,
      })
    }
    if (!destino.auth_id) throw badRequest('Ese usuario todavía no tiene credencial de acceso')

    const { error } = await db().auth.admin.updateUserById(destino.auth_id, { password: clave })
    if (error) throw new AppError(`No se pudo cambiar la contraseña: ${error.message}`, { status: 502 })

    // La contraseña NO se registra, ni cifrada ni truncada. Lo que se audita es
    // que alguien la cambió, que es la pregunta que se hace después.
    await auditar(req, actor, {
      accion: 'usuario.clave',
      descripcion: `${nombreRol(actor.rol)} cambió la contraseña de ${nombreCompleto(destino)}`,
      entidad: 'usuario',
      entidadId: destino.id,
    })

    res.json({ ok: true })
  }),
)

// -----------------------------------------------------------------------------
// Eliminar
// -----------------------------------------------------------------------------
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const actor = await exigirActor(req, 'usuarios.eliminar')

    const { data: destino } = await db()
      .from('usuarios_sistema')
      .select('id, auth_id, nombre, apellido, rol')
      .eq('id', req.params.id)
      .maybeSingle()
    if (!destino) throw new AppError('No existe ese usuario', { status: 404 })
    if (destino.id === actor.id) throw badRequest('No podés eliminar tu propio usuario')

    // El Super Administrador no se elimina desde el sistema, y como tampoco se
    // puede crear uno nuevo, no hace falta contar cuántos quedan: siempre está
    // el que instaló el sistema. Esta línea y la de crear son las dos mitades
    // de la misma garantía — sin las dos, alcanza con fabricarse un segundo
    // dueño para borrar al primero.
    if (destino.rol === 'super_admin') {
      throw new AppError('El Super Administrador no se puede eliminar', {
        status: 403,
        hint: 'Es el dueño de la instalación. Transferir esa cuenta es una operación deliberada en la base — está documentada al pie de la migración 66.',
      })
    }
    if (!puedeGestionarRol(actor.rol, destino.rol)) {
      throw new AppError(`Un ${nombreRol(actor.rol)} no puede eliminar a un ${nombreRol(destino.rol)}`, {
        status: 403,
      })
    }

    const { error } = await db().from('usuarios_sistema').delete().eq('id', destino.id)
    if (error) throw new AppError(`No se pudo eliminar: ${error.message}`, { status: 502 })

    // La credencial después del legajo: si quedara al revés y fallara el
    // borrado del legajo, habría una fila que dice que alguien puede entrar
    // cuando ya no puede.
    if (destino.auth_id) {
      await db().auth.admin.deleteUser(destino.auth_id).catch((err) => {
        console.warn('[personal] quedó la credencial huérfana en Auth:', err.message)
      })
    }

    await auditar(req, actor, {
      accion: 'usuario.eliminar',
      descripcion: `${nombreRol(actor.rol)} eliminó al usuario ${nombreRol(destino.rol)} ${nombreCompleto(destino)}`,
      entidad: 'usuario',
      entidadId: destino.id,
    })

    res.json({ ok: true })
  }),
)

// -----------------------------------------------------------------------------
// Registrar un hecho desde la app
// -----------------------------------------------------------------------------
// Para que el resto de las pantallas puedan auditar sin que cada una tenga que
// abrirse su propia ruta.
router.post(
  '/auditoria',
  asyncHandler(async (req, res) => {
    const actor = await actorDe(req)
    const { accion, descripcion } = req.body || {}
    if (!accion || !descripcion) throw badRequest('Falta la acción o la descripción')

    await auditar(req, actor, {
      accion: String(accion).slice(0, 60),
      descripcion: String(descripcion).slice(0, 500),
      entidad: req.body.entidad,
      entidadId: req.body.entidad_id,
      datos: req.body.datos,
    })

    res.json({ ok: true })
  }),
)

export default router
