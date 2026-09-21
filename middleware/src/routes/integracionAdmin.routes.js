import { Router } from 'express'

import { asyncHandler, AppError, badRequest, notFound } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { db } from '../lib/db.js'
import { actorDe, auditar } from '../lib/auditoria.js'
import { permisosDeRol, tienePermiso } from '../../../web/src/lib/permisos.js'
import { generarLlave } from '../lib/apiKey.js'
import { reactivarServicio } from '../services/reactivacion.js'

/**
 * La administración de las integraciones, para el personal del ISP.
 *
 * Va en un router aparte del que usa el CRM, por lo mismo que el portal del
 * abonado tiene su `portalAdmin`: una ruta de administración colgada del router
 * del bot quedaría alcanzable con la llave del bot. Y la llave del bot la tiene
 * una empresa de afuera.
 *
 * Acá vive también la bandeja de pagos reportados: es una cola de trabajo de
 * cobranza, no una integración.
 */

const router = Router()
router.use(requireAuth)

/** Quién pide, y si le alcanza el permiso. Mismo criterio que en `pagos`. */
async function exigir(req, permiso) {
  const actor = await actorDe(req)

  if (!actor) {
    throw new AppError('Tu usuario no tiene un legajo de personal asociado', {
      status: 403,
      hint: 'Pedile a un Super Administrador que te cree el usuario en Ajustes → Gestión de personal.',
    })
  }
  if (!actor.activo) throw new AppError('Tu usuario está desactivado', { status: 403 })

  if (permiso && !tienePermiso(actor, permiso)) {
    throw new AppError('No tenés permiso para esto', {
      status: 403,
      hint: `Hace falta el permiso "${permiso}". Se otorga en Ajustes → Gestión de personal.`,
    })
  }

  return actor
}

// =============================================================================
// Llaves
// =============================================================================

/**
 * Las llaves emitidas.
 *
 * La huella no sale nunca, ni siquiera para el Super Administrador: no sirve
 * para entrar, pero tampoco sirve para nada más que para probar candidatas
 * offline. Lo que se ve es el prefijo, que alcanza para saber cuál es cuál.
 */
router.get(
  '/llaves',
  asyncHandler(async (req, res) => {
    await exigir(req, 'config.integraciones')

    const { data, error } = await db()
      .from('api_llaves')
      .select(
        'id, nombre, prefijo, permisos, ips_permitidas, cuenta_id, confirma_pagos, reactiva_servicio, activa, notas, created_at, ultimo_uso, revocada_at, motivo_revocacion, generada_desde_nombre',
      )
      .order('created_at', { ascending: false })

    if (error) throw new AppError(`No se pudieron leer las llaves: ${error.message}`, { status: 502 })
    res.json(data ?? [])
  }),
)

/**
 * Emite una llave.
 *
 * La respuesta trae la llave EN CLARO y es la única vez que va a existir fuera
 * de la cabeza de quien la copia. Se dice explícitamente en la respuesta para
 * que la pantalla lo pueda mostrar: quien la cierra sin copiarla tiene que
 * emitir otra, y es mejor que se entere ahí y no cuando el proveedor del CRM
 * la pida.
 */
router.post(
  '/llaves',
  asyncHandler(async (req, res) => {
    await exigir(req, 'config.integraciones')
    const b = req.body ?? {}

    const nombre = String(b.nombre ?? '').trim()
    if (!nombre) throw badRequest('Ponele un nombre: "Bot de WhatsApp", "Webhook Cuentadigital".')
    if (nombre.length > 80) throw badRequest('El nombre no puede pasar de 80 caracteres.')

    const permisos = Array.isArray(b.permisos)
      ? [...new Set(b.permisos.map((p) => String(p).trim()).filter(Boolean))]
      : []

    if (!permisos.length) {
      throw badRequest('Una llave sin permisos no sirve para nada: marcá al menos uno.')
    }

    /**
     * La cuenta es OPCIONAL, y eso es deliberado.
     *
     * Antes se exigía al encender la acreditación automática. Estaba mal: el
     * ISP tiene dos cuentas del Pichincha y el abonado transfiere a la que
     * quiere, así que obligar a elegir una fija archivaba mal la mitad de los
     * cobros. Lo que manda es lo que dice el comprobante — el bot manda
     * `cuenta_destino` y el sistema lo resuelve.
     *
     * La de acá es solo la red por si un pago llega sin decir a dónde entró.
     * Y si no hay ninguna de las dos, la garantía sigue en pie: el pago NO se
     * acredita, queda en la bandeja para que alguien elija la cuenta. Ver
     * `registrarPago`.
     */

    const { llave, prefijo, huella } = generarLlave()

    const { data, error } = await db()
      .from('api_llaves')
      .insert({
        nombre,
        prefijo,
        huella,
        permisos,
        ips_permitidas: Array.isArray(b.ips_permitidas)
          ? b.ips_permitidas.map((i) => String(i).trim()).filter(Boolean)
          : [],
        cuenta_id: b.cuenta_id || null,
        confirma_pagos: Boolean(b.confirma_pagos),
        reactiva_servicio: Boolean(b.reactiva_servicio),
        notas: String(b.notas ?? '').trim() || null,
        // El uid de Auth, no el id del legajo: es lo que guardan el resto de
        // las columnas de autoría del sistema (`pagos.created_by` apunta a
        // `auth.users`), y tener dos vocabularios de "quién" en la misma base
        // hace que un JOIN devuelva vacío sin decir por qué.
        creada_por: req.usuario?.id ?? null,
      })
      .select('id, nombre, prefijo, permisos, confirma_pagos, reactiva_servicio, created_at')
      .single()

    if (error) throw new AppError(`No se pudo crear la llave: ${error.message}`, { status: 502 })

    res.status(201).json({
      ...data,
      llave,
      aviso:
        'Copiala ahora: no se guarda en ningún lado y no se puede volver a ver. Si se pierde, se revoca y se emite otra.',
    })
  }),
)

/**
 * Lo que tiene sentido que haga un programa de afuera.
 *
 * Es un subconjunto a propósito del catálogo del personal. Aunque el usuario del
 * que se copia sea Super Administrador, la llave nunca sale con `clientes.eliminar`
 * ni con `pagos.anular`: nada que se opere desde un chat tiene por qué poder
 * borrar un abonado o revertir un cobro.
 *
 * Que el tope viva acá y no en la pantalla es lo que lo hace un tope: esconder
 * una casilla no impide que alguien mande el permiso en el cuerpo del pedido.
 */
const HABILITABLES_POR_API = [
  'clientes.ver',
  'facturacion.ver',
  'pagos.registrar',
  'red.diagnostico',
  'red.wifi',
  'soporte.crear',
  'ventas.cobertura',
  'ventas.planes',
  'ventas.solicitudes',
]

/** Los permisos efectivos de un legajo: los suyos, o los de su rol si no tiene. */
const efectivosDe = (u) => ({
  ...u,
  permisos: u?.permisos?.length ? u.permisos : permisosDeRol(u?.rol),
})

/**
 * Genera una llave copiando los permisos de un usuario.
 *
 * ── Es una FOTO, no un vínculo ──
 *
 * Se copian los permisos que ese usuario tiene HOY y ahí termina la relación.
 * Si mañana le agregan `pagos.anular`, la llave no lo gana; si renuncia y se lo
 * desactiva, la llave no se apaga. Lo que la llave puede hacer se cambia en un
 * solo lugar: editando la llave.
 *
 * Un vínculo vivo sería más cómodo y peor: cambiarle un permiso a un empleado
 * cambiaría en silencio lo que puede hacer el bot de WhatsApp, y nadie que esté
 * editando la pantalla de personal está pensando en el bot.
 *
 * ── Dos topes, y los dos hacen falta ──
 *
 * 1. Solo lo que un programa de afuera puede hacer (`HABILITABLES_POR_API`).
 * 2. Solo lo que TAMBIÉN tiene quien la genera. Sin esto, un Administrador
 *    podría generar una llave desde el legajo de un Super Administrador y
 *    quedarse con una credencial más poderosa que él mismo — que es la escalada
 *    clásica, y encima queda escrita como algo rutinario.
 */
router.post(
  '/llaves/desde-usuario',
  asyncHandler(async (req, res) => {
    const actor = await exigir(req, 'config.integraciones')
    const b = req.body ?? {}

    if (!b.usuario_id) throw badRequest('Elegí de qué usuario copiar los permisos.')

    const { data: destino, error } = await db()
      .from('usuarios_sistema')
      .select('id, nombre, apellido, rol, activo, permisos')
      .eq('id', b.usuario_id)
      .maybeSingle()

    if (error) throw new AppError(`No se pudo leer el legajo: ${error.message}`, { status: 502 })
    if (!destino) throw notFound('No existe ese usuario.')

    const suyos = efectivosDe(destino)
    const mios = efectivosDe(actor)

    const permisos = HABILITABLES_POR_API.filter(
      (p) => tienePermiso({ ...suyos, activo: true }, p) && tienePermiso({ ...mios, activo: true }, p),
    )

    if (!permisos.length) {
      throw badRequest(
        `${destino.nombre} no tiene ningún permiso que se pueda usar desde una API.`,
        {
          hint: 'Las llaves solo pueden consultar abonados y facturas, registrar pagos, diagnosticar, cambiar WiFi, abrir tickets y vender. Elegí a alguien con alguno de esos, o creá la llave a mano en Ajustes → Integraciones.',
        },
      )
    }

    const nombreCompleto = `${destino.nombre} ${destino.apellido ?? ''}`.trim()

    const { llave, prefijo, huella } = generarLlave()

    const { data, error: errCrear } = await db()
      .from('api_llaves')
      .insert({
        nombre: String(b.nombre ?? '').trim().slice(0, 80) || `API de ${nombreCompleto}`,
        prefijo,
        huella,
        permisos,
        ips_permitidas: Array.isArray(b.ips_permitidas)
          ? b.ips_permitidas.map((i) => String(i).trim()).filter(Boolean)
          : [],
        cuenta_id: b.cuenta_id || null,
        confirma_pagos: Boolean(b.confirma_pagos),
        reactiva_servicio: Boolean(b.reactiva_servicio),
        notas: String(b.notas ?? '').trim() || null,
        creada_por: req.usuario?.id ?? null,
        // Rastro de dónde salió la copia. No es un vínculo: ver arriba.
        generada_desde: destino.id,
        generada_desde_nombre: nombreCompleto,
      })
      .select('id, nombre, prefijo, permisos, confirma_pagos, reactiva_servicio, created_at')
      .single()

    if (errCrear) {
      throw new AppError(`No se pudo crear la llave: ${errCrear.message}`, { status: 502 })
    }

    await auditar(req, actor, {
      accion: 'api_llave_generar',
      descripcion: `Generó una llave de API copiando los permisos de ${nombreCompleto}: ${permisos.join(', ')}`,
      entidad: 'api_llaves',
      entidadId: data.id,
      datos: { desde: destino.id, permisos },
    })

    res.status(201).json({
      ...data,
      llave,
      copiada_de: nombreCompleto,
      // Lo que el usuario tenía y la llave NO se lleva. Se dice para que quien
      // la genera no crea que la entregó más completa de lo que es.
      descartados: HABILITABLES_POR_API.filter((p) => !permisos.includes(p)),
      aviso:
        'Copiala ahora: no se guarda en ningún lado y no se puede volver a ver. Los permisos son una foto de los que tiene ' +
        `${nombreCompleto} hoy: si mañana cambian los suyos, esta llave no cambia.`,
    })
  }),
)

/** Cambia lo que se puede cambiar de una llave. La llave en sí, nunca. */
router.put(
  '/llaves/:id',
  asyncHandler(async (req, res) => {
    await exigir(req, 'config.integraciones')
    const b = req.body ?? {}
    const fila = {}

    if ('nombre' in b) {
      const n = String(b.nombre ?? '').trim()
      if (!n) throw badRequest('El nombre no puede quedar vacío.')
      fila.nombre = n.slice(0, 80)
    }
    if ('permisos' in b) {
      const p = Array.isArray(b.permisos)
        ? [...new Set(b.permisos.map((x) => String(x).trim()).filter(Boolean))]
        : []
      if (!p.length) throw badRequest('Una llave sin permisos no sirve para nada.')
      fila.permisos = p
    }
    if ('ips_permitidas' in b) {
      fila.ips_permitidas = Array.isArray(b.ips_permitidas)
        ? b.ips_permitidas.map((i) => String(i).trim()).filter(Boolean)
        : []
    }
    if ('cuenta_id' in b) fila.cuenta_id = b.cuenta_id || null
    if ('confirma_pagos' in b) fila.confirma_pagos = Boolean(b.confirma_pagos)
    if ('reactiva_servicio' in b) fila.reactiva_servicio = Boolean(b.reactiva_servicio)
    if ('activa' in b) fila.activa = Boolean(b.activa)
    if ('notas' in b) fila.notas = String(b.notas ?? '').trim() || null

    // La misma regla que al crear, y hay que repetirla: encender "acredita sola"
    // sobre una llave vieja sin cuenta es exactamente el caso que se cuela.
    const { data: previa } = await db()
      .from('api_llaves')
      .select('confirma_pagos, cuenta_id')
      .eq('id', req.params.id)
      .maybeSingle()

    if (!previa) throw notFound('No existe esa llave.')

    const { data, error } = await db()
      .from('api_llaves')
      .update(fila)
      .eq('id', req.params.id)
      .select('id, nombre, prefijo, permisos, ips_permitidas, cuenta_id, confirma_pagos, reactiva_servicio, activa, notas')
      .single()

    if (error) throw new AppError(`No se pudo guardar: ${error.message}`, { status: 502 })
    res.json(data)
  }),
)

/**
 * Revoca la llave.
 *
 * No se borra la fila: el rastro de `api_llamadas` cuelga de ella, y un pago
 * que aparezca cuestionado dentro de seis meses tiene que poder decir con qué
 * llave entró y quién la había revocado.
 */
router.delete(
  '/llaves/:id',
  asyncHandler(async (req, res) => {
    await exigir(req, 'config.integraciones')
    const motivo = String(req.body?.motivo ?? '').trim() || null

    const { error } = await db()
      .from('api_llaves')
      .update({
        activa: false,
        revocada_at: new Date().toISOString(),
        revocada_por: req.usuario?.id ?? null,
        motivo_revocacion: motivo,
      })
      .eq('id', req.params.id)

    if (error) throw new AppError(`No se pudo revocar: ${error.message}`, { status: 502 })
    res.json({ ok: true, aviso: 'La llave dejó de funcionar en el acto.' })
  }),
)

/** Lo que pidió una llave. Es el rastro que contesta "¿quién consultó esto?". */
router.get(
  '/llamadas',
  asyncHandler(async (req, res) => {
    await exigir(req, 'config.integraciones')

    let q = db()
      .from('api_llamadas')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(Math.min(500, Number(req.query.limite) || 200))

    if (req.query.llave) q = q.eq('llave_id', req.query.llave)
    if (req.query.identificacion) q = q.eq('identificacion', String(req.query.identificacion).trim())
    if (req.query.solo_errores === 'true') q = q.gte('status', 400)

    const { data, error } = await q
    if (error) throw new AppError(`No se pudo leer el registro: ${error.message}`, { status: 502 })
    res.json(data ?? [])
  }),
)

// =============================================================================
// La bandeja de pagos reportados
// =============================================================================

router.get(
  '/pagos-reportados',
  asyncHandler(async (req, res) => {
    await exigir(req, 'pagos.ver')

    let q = db()
      .from('v_pagos_reportados')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(Math.min(500, Number(req.query.limite) || 100))

    // Por defecto, lo que hay para hacer. El historial se pide a propósito.
    const estado = req.query.estado ?? 'pendiente'
    if (estado !== 'todos') q = q.eq('estado', estado)

    const { data, error } = await q
    if (error) throw new AppError(`No se pudo leer la bandeja: ${error.message}`, { status: 502 })
    res.json(data ?? [])
  }),
)

/**
 * Confirma un pago reportado: recién acá es un cobro.
 *
 * Exige `pagos.registrar` y no `pagos.ver` a propósito — quien confirma está
 * metiendo plata en la caja del día, que es exactamente lo que hace quien cobra
 * en ventanilla.
 *
 * La reactivación va DESPUÉS de que el cobro está aplicado y nunca antes: si el
 * router no contesta, el abonado queda con su deuda saldada y sin servicio, que
 * se arregla con una llamada. Al revés —reactivar y que falle el cobro— queda
 * navegando sin haber pagado, y de eso nadie se entera.
 */
router.post(
  '/pagos-reportados/:id/confirmar',
  asyncHandler(async (req, res) => {
    const actor = await exigir(req, 'pagos.registrar')

    const { data: reporte } = await db()
      .from('pagos_reportados')
      .select('id, client_id, llave_id, monto')
      .eq('id', req.params.id)
      .maybeSingle()

    if (!reporte) throw notFound('No existe ese pago reportado.')

    const { data, error } = await db().rpc('confirmar_pago_reportado', {
      p_id: req.params.id,
      // El uid de Auth: `aplicar_cobro` lo escribe en `pagos.created_by`, que
      // referencia `auth.users`. Mandar el id del legajo haría fallar el FK.
      p_usuario: req.usuario?.id ?? null,
      p_cuenta_id: req.body?.cuenta_id || null,
    })

    if (error) {
      /**
       * El caso que esta bandeja hace frecuente: el mismo cobro ya se cargó a
       * mano en ventanilla, y el número de transacción es único en `pagos`.
       *
       * El mensaje crudo de Postgres —"duplicate key value violates unique
       * constraint"— manda a quien cobra a buscar un problema técnico. Lo que
       * pasó es lo contrario: el pago ya está, y lo que corresponde es rechazar
       * el reporte, no insistir.
       */
      const repetido = error.code === '23505' || /duplicate key|ya está registrado/i.test(error.message)

      throw new AppError(
        repetido
          ? `El N° de transacción de este reporte ya está registrado en otro cobro.`
          : error.message,
        {
          status: 400,
          ...(repetido
            ? { hint: 'Buscalo en Cobros → Pagos registrados. Si es el mismo, rechazá este reporte indicando que ya estaba cobrado.' }
            : {}),
        },
      )
    }

    const salida = { ...data }

    /**
     * Reactivar es opcional y por pedido de quien confirma.
     *
     * Se ofrece marcado cuando la llave lo tiene habilitado, pero la decisión
     * final es de la persona: es la que está mirando si el abonado saldó todo o
     * trajo una parte.
     */
    const quiere =
      'reactivar' in (req.body ?? {})
        ? Boolean(req.body.reactivar)
        : Boolean(
            (
              await db()
                .from('api_llaves')
                .select('reactiva_servicio')
                .eq('id', reporte.llave_id)
                .maybeSingle()
            ).data?.reactiva_servicio,
          )

    if (quiere && reporte.client_id) {
      salida.reactivacion = await reactivarServicio(reporte.client_id, {
        motivo: `Pago reportado confirmado por ${actor.nombre ?? 'el personal'}`,
      })
    }

    res.json(salida)
  }),
)

/** Lo rechaza. El motivo es obligatorio: es lo que el abonado va a preguntar. */
router.post(
  '/pagos-reportados/:id/rechazar',
  asyncHandler(async (req, res) => {
    await exigir(req, 'pagos.registrar')

    const { error } = await db().rpc('rechazar_pago_reportado', {
      p_id: req.params.id,
      p_motivo: String(req.body?.motivo ?? ''),
      // El uid de Auth: `aplicar_cobro` lo escribe en `pagos.created_by`, que
      // referencia `auth.users`. Mandar el id del legajo haría fallar el FK.
      p_usuario: req.usuario?.id ?? null,
    })

    if (error) throw new AppError(error.message, { status: 400 })
    res.json({ ok: true })
  }),
)

export default router
