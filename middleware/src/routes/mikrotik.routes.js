import { Router } from 'express'
import * as reparar from '../services/repararRouter.js'
import * as configurar from '../services/configurarRouter.js'
import * as ipv6 from '../services/ipv6Router.js'
import { asyncHandler, badRequest } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { exigePermiso } from '../lib/permisos.js'
import { cargarRouter, db } from '../lib/db.js'
import * as mt from '../services/mikrotikService.js'
import { normalizarEscaneo, planificarSincronizacion, FUENTES } from '../services/importador.js'

const router = Router()
// Todo MikroTik, incluso leer, pide el permiso de routers: la lectura ya
// devuelve la topología —interfaces, colas, secretos PPPoE por nombre— que es
// el mapa de la red. Un técnico de campo no lo necesita para instalar.
router.use(requireAuth, exigePermiso('red.routers'))

/** Carga el router de Supabase y lo deja en req.equipo (credenciales descifradas). */
const conRouter = asyncHandler(async (req, _res, next) => {
  req.equipo = await cargarRouter(req.params.id)
  next()
})

// --- Salud ------------------------------------------------------------------

router.get(
  '/:id/test',
  conRouter,
  asyncHandler(async (req, res) => {
    res.json(await mt.probarConexion(req.equipo))
  }),
)

// --- IP Pools ---------------------------------------------------------------

router.get(
  '/:id/pools',
  conRouter,
  asyncHandler(async (req, res) => {
    res.json(await mt.listarPools(req.equipo))
  }),
)

router.post(
  '/:id/pools',
  conRouter,
  asyncHandler(async (req, res) => {
    const { name, ranges, comment } = req.body ?? {}
    if (!name || !ranges) throw badRequest('Faltan name o ranges del pool')
    await mt.crearPool(req.equipo, { name, ranges, comment })
    res.status(201).json({ ok: true, pools: await mt.listarPools(req.equipo) })
  }),
)

router.delete(
  '/:id/pools/:poolId',
  conRouter,
  asyncHandler(async (req, res) => {
    await mt.borrarPool(req.equipo, req.params.poolId)
    res.json({ ok: true })
  }),
)

// --- IP Addresses e interfaces ----------------------------------------------

router.get(
  '/:id/interfaces',
  conRouter,
  asyncHandler(async (req, res) => {
    const interfaces = await mt.listarInterfaces(req.equipo)
    res.json(
      (Array.isArray(interfaces) ? interfaces : []).map((i) => ({
        id: i['.id'],
        nombre: i.name,
        tipo: i.type,
        running: i.running === 'true' || i.running === true,
        disabled: i.disabled === 'true' || i.disabled === true,
      })),
    )
  }),
)

router.get(
  '/:id/addresses',
  conRouter,
  asyncHandler(async (req, res) => {
    res.json(await mt.listarDirecciones(req.equipo))
  }),
)

router.post(
  '/:id/addresses',
  conRouter,
  asyncHandler(async (req, res) => {
    const { address, interfaz, comment } = req.body ?? {}
    if (!address || !interfaz) throw badRequest('Faltan address o interfaz')
    await mt.crearDireccion(req.equipo, { address, interface: interfaz, comment })
    res.status(201).json({ ok: true, addresses: await mt.listarDirecciones(req.equipo) })
  }),
)

router.delete(
  '/:id/addresses/:addressId',
  conRouter,
  asyncHandler(async (req, res) => {
    await mt.borrarDireccion(req.equipo, req.params.addressId)
    res.json({ ok: true })
  }),
)

// --- Bloqueos / corte de servicio -------------------------------------------

router.get(
  '/:id/bloqueos',
  conRouter,
  asyncHandler(async (req, res) => {
    const lista = req.query.lista || mt.LISTA_MOROSOS
    const entradas = await mt.listarBloqueos(req.equipo, lista)
    res.json(
      (Array.isArray(entradas) ? entradas : []).map((e) => ({
        id: e['.id'],
        address: e.address,
        lista: e.list,
        comment: e.comment ?? null,
        dynamic: e.dynamic === 'true' || e.dynamic === true,
      })),
    )
  }),
)

router.post(
  '/:id/bloqueos',
  conRouter,
  asyncHandler(async (req, res) => {
    const { address, comment, lista } = req.body ?? {}
    if (!address) throw badRequest('Falta la IP a bloquear')

    // La entrada del address-list por sí sola no corta nada: hace falta la regla
    // de filter que dropea el forward de esa lista. La aseguramos acá para que
    // el corte funcione desde el primer cliente bloqueado.
    const regla = await mt.asegurarReglaCorte(req.equipo, lista)
    await mt.bloquearIp(req.equipo, { address, comment, lista })

    res.status(201).json({ ok: true, regla })
  }),
)

router.delete(
  '/:id/bloqueos/:entradaId',
  conRouter,
  asyncHandler(async (req, res) => {
    await mt.desbloquear(req.equipo, req.params.entradaId)
    res.json({ ok: true })
  }),
)

router.post(
  '/:id/redireccion-pago',
  conRouter,
  asyncHandler(async (req, res) => {
    const { destino, puerto, lista } = req.body ?? {}
    if (!destino) throw badRequest('Falta la IP destino de la página de aviso de pago')

    /**
     * La lista sale de la ficha del router si no la mandan.
     *
     * Antes caía a la constante `CORTE_MOROSOS`, y ahora cada router puede tener
     * la suya —el de La Maná corta con `Moroso`—. Con la constante, la regla se
     * crearía apuntando a una lista vacía: el cortado no vería la página y nadie
     * entendería por qué, porque la regla se creó sin error.
     */
    res.json(
      await mt.asegurarRedireccionPago(req.equipo, {
        destino,
        puerto,
        lista: lista || req.equipo.lista_morosos || undefined,
      }),
    )
  }),
)

// --- Firewall (solo lectura) ------------------------------------------------

router.get(
  '/:id/firewall/filter',
  conRouter,
  asyncHandler(async (req, res) => {
    res.json(await mt.listarReglasFilter(req.equipo))
  }),
)

router.get(
  '/:id/firewall/nat',
  conRouter,
  asyncHandler(async (req, res) => {
    res.json(await mt.listarReglasNat(req.equipo))
  }),
)

// --- Perfiles PPP (planes de velocidad en PPPoE) -----------------------------

/**
 * Los perfiles PPP del equipo, para poder asociarlos a un plan.
 *
 * Se devuelve solo lo que hace falta elegir —nombre y los límites que aplica—:
 * un perfil de RouterOS trae treinta campos y ninguno de los otros ayuda a
 * decidir cuál corresponde a "PLAN_100M".
 */
router.get(
  '/:id/ppp-profiles',
  conRouter,
  asyncHandler(async (req, res) => {
    const perfiles = await mt.listarPppProfiles(req.equipo)
    res.json(
      (Array.isArray(perfiles) ? perfiles : []).map((p) => ({
        nombre: p.name,
        limites: p['rate-limit'] || null,
        red_local: p['local-address'] || null,
        pool_remoto: p['remote-address'] || null,
        por_defecto: p.default === 'true' || p.default === true,
      })),
    )
  }),
)

// --- Simple Queues (planes de velocidad) ------------------------------------

router.get(
  '/:id/queues',
  conRouter,
  asyncHandler(async (req, res) => {
    res.json(await mt.listarSimpleQueues(req.equipo))
  }),
)

router.post(
  '/:id/queues',
  conRouter,
  asyncHandler(async (req, res) => {
    const { name, target, bajadaKbps, subidaKbps, comment } = req.body ?? {}
    if (!name || !target || !bajadaKbps || !subidaKbps) {
      throw badRequest('Faltan name, target, bajadaKbps o subidaKbps')
    }
    await mt.crearSimpleQueue(req.equipo, { name, target, bajadaKbps, subidaKbps, comment })
    res.status(201).json({ ok: true })
  }),
)

// --- Importación de clientes ------------------------------------------------

/**
 * Lee el router y devuelve los clientes que se podrían importar.
 * Es de SOLO LECTURA: no toca el equipo ni la base. La UI muestra esto como
 * vista previa para que se revise antes de confirmar.
 */
router.get(
  '/:id/escaneo',
  conRouter,
  asyncHandler(async (req, res) => {
    const lista = req.query.lista || req.equipo.lista_morosos || mt.LISTA_MOROSOS
    // Cada RB administra a sus clientes distinto: unos con PPPoE, otros con
    // colas simples. Sin filtro se usan todas las fuentes.
    const fuentes = req.query.fuentes ? String(req.query.fuentes).split(',') : FUENTES

    const crudo = await mt.escanear(req.equipo)
    res.json({
      ...normalizarEscaneo(crudo, { listaMorosos: lista, fuentes }),
      listaMorosos: lista,
      fuentes,
    })
  }),
)

/**
 * Guarda en la base los clientes elegidos.
 *
 * Reimportar no duplica: si ya existe un cliente con esa IP (o ese usuario
 * PPPoE) en el mismo router, se actualiza. Así se puede volver a escanear
 * después de cambios en el MikroTik.
 */
router.post(
  '/:id/importar',
  conRouter,
  asyncHandler(async (req, res) => {
    const { clientes } = req.body ?? {}
    if (!Array.isArray(clientes) || clientes.length === 0) {
      throw badRequest('Mandá un array "clientes" con al menos uno')
    }

    const routerId = req.equipo.id

    const { data: existentes, error: errLectura } = await db()
      .from('clientes')
      .select('id, ip, usuario_ppp')
      .eq('router_id', routerId)
    if (errLectura) throw badRequest(`No se pudieron leer los clientes: ${errLectura.message}`)

    const porIp = new Map((existentes ?? []).filter((c) => c.ip).map((c) => [c.ip, c.id]))
    const porPpp = new Map(
      (existentes ?? []).filter((c) => c.usuario_ppp).map((c) => [c.usuario_ppp, c.id]),
    )

    const nuevos = []
    const actualizados = []

    for (const c of clientes) {
      const fila = {
        router_id: routerId,
        nombre: c.nombre ?? c.ip ?? c.usuario_ppp,
        ip: c.ip ?? null,
        mac_address: c.mac_address ?? null,
        usuario_ppp: c.usuario_ppp ?? null,
        velocidad_cruda: c.velocidad_cruda ?? null,
        comentario: c.comentario ?? null,
        estado: c.estado ?? 'activo',
        origen: c.origen ?? 'manual',
      }

      const id = (c.ip && porIp.get(c.ip)) || (c.usuario_ppp && porPpp.get(c.usuario_ppp)) || null
      if (id) actualizados.push({ id, fila })
      else nuevos.push(fila)
    }

    const errores = []

    if (nuevos.length) {
      const { error } = await db().from('clientes').insert(nuevos)
      if (error) errores.push(`altas: ${error.message}`)
    }

    for (const { id, fila } of actualizados) {
      const { error } = await db().from('clientes').update(fila).eq('id', id)
      if (error) errores.push(`${fila.nombre}: ${error.message}`)
    }

    res.status(errores.length ? 207 : 201).json({
      ok: errores.length === 0,
      creados: nuevos.length,
      actualizados: actualizados.length,
      ...(errores.length ? { errores } : {}),
    })
  }),
)

/**
 * Copia una address-list del router a otra.
 *
 * Sirve para migrar los cortes del sistema anterior sin desarmar lo que ya
 * funciona: la lista vieja queda intacta, así que se puede verificar la nueva
 * antes de cambiar las reglas de firewall que la referencian.
 */
router.post(
  '/:id/migrar-lista',
  conRouter,
  asyncHandler(async (req, res) => {
    const { origen, destino } = req.body ?? {}
    if (!origen || !destino) throw badRequest('Faltan "origen" y "destino"')
    if (origen === destino) throw badRequest('El origen y el destino no pueden ser la misma lista')

    const resultado = await mt.copiarLista(req.equipo, { origen, destino })

    // Se deja constancia en la base para poder revertir con exactitud.
    if (resultado.copiadas.length) {
      const filas = resultado.copiadas.map((address) => ({
        router_id: req.equipo.id,
        cliente_ip: address,
        tipo_accion: 'CORTAR_SERVICIO',
        lista: destino,
        comentario: `Migrado desde la lista "${origen}"`,
        activo: true,
      }))
      const { error } = await db().from('firewall_bloqueos').insert(filas)
      if (error) {
        return res.status(207).json({
          ...resultado,
          guardadoEnBase: false,
          error: `Se copiaron en el router pero no se registraron en la base: ${error.message}`,
        })
      }
    }

    res.json({ ...resultado, guardadoEnBase: true })
  }),
)

// --- Exportación hacia el router --------------------------------------------

/**
 * Crea en el router las colas simples (o los PPPoE secrets) de los clientes
 * del sistema. Lo que ya existe se saltea, así que se puede reejecutar.
 */
router.post(
  '/:id/exportar',
  conRouter,
  asyncHandler(async (req, res) => {
    const { modo = 'simple-queue', clienteIds } = req.body ?? {}

    let consulta = db().from('clientes').select('*').eq('router_id', req.equipo.id)
    if (Array.isArray(clienteIds) && clienteIds.length) {
      consulta = consulta.in('id', clienteIds)
    }

    const { data: clientes, error } = await consulta
    if (error) throw badRequest(`No se pudieron leer los clientes: ${error.message}`)
    if (!clientes?.length) throw badRequest('No hay clientes de este router para exportar')

    res.json(await mt.exportarClientes(req.equipo, { clientes, modo }))
  }),
)

// --- Sincronización de morosos ----------------------------------------------

/**
 * Compara los clientes cortados del sistema con el address-list del router.
 *
 * Sin `aplicar: true` devuelve solo el PLAN. Es deliberado: quitar una entrada
 * de la lista le restaura el servicio a alguien, y eso tiene que verse y
 * confirmarse, no ocurrir por apretar un botón.
 */
router.post(
  '/:id/sincronizar-morosos',
  conRouter,
  asyncHandler(async (req, res) => {
    const { aplicar = false, quitarDesconocidos = false } = req.body ?? {}
    const lista = req.body?.lista || req.equipo.lista_morosos || mt.LISTA_MOROSOS

    const { data: clientes, error } = await db()
      .from('clientes')
      .select('id, nombre, ip, estado')
      .eq('router_id', req.equipo.id)
    if (error) throw badRequest(`No se pudieron leer los clientes: ${error.message}`)

    const entradas = await mt.listarTodasLasEntradas(req.equipo)
    const plan = planificarSincronizacion(clientes ?? [], entradas ?? [], lista)

    if (!aplicar) return res.json({ plan, aplicado: false })

    // Los bloqueos que no corresponden a ningún cliente conocido no se tocan
    // salvo pedido explícito: suelen ser cortes puestos a mano.
    const quitar = quitarDesconocidos ? plan.quitar : plan.quitar.filter((q) => q.conocido)

    const resultado = await mt.aplicarSincronizacion(req.equipo, {
      lista,
      agregar: plan.agregar,
      quitar,
    })

    res.json({
      plan,
      aplicado: true,
      resultado,
      ...(quitar.length < plan.quitar.length
        ? {
            aviso: `Se dejaron sin tocar ${plan.quitar.length - quitar.length} bloqueo(s) que no corresponden a ningún cliente del sistema.`,
          }
        : {}),
    })
  }),
)

/**
 * Deja el router igual a lo que dice el sistema.
 *
 * Sirve para dos cosas: después de migrar desde otro sistema, y todos los días
 * —cuando se cobra un pago con el router caído, el abonado queda en la lista de
 * morosos aunque ya no deba, y nadie lo ve hasta que llama.
 *
 * Siempre en dos pasos: se muestra qué está distinto y recién después se toca.
 */
/**
 * Dejar el router listo para cortar en IPv6.
 *
 * En dos pasos como el resto: el GET dice qué falta y devuelve el script
 * equivalente para poder leerlo; el POST lo aplica.
 *
 * Sirve igual para fibra y para radioenlace: son reglas de capa 3, no miran la
 * OLT ni el tipo de conexión del abonado.
 */
router.get(
  '/:id/ipv6',
  asyncHandler(async (req, res) => {
    res.json(await ipv6.revisar(req.params.id))
  }),
)

router.post(
  '/:id/ipv6',
  asyncHandler(async (req, res) => {
    res.json(await ipv6.preparar(req.params.id, { encender: req.body?.encender !== false }))
  }),
)

router.delete(
  '/:id/ipv6',
  asyncHandler(async (req, res) => {
    res.json(await ipv6.apagar(req.params.id))
  }),
)

/**
 * Dejar un equipo recién dado de alta listo para operar.
 *
 * `GET` informa qué le falta sin tocar nada; `POST` lo aplica. La separación es
 * la misma que en `reparar`, y por el mismo motivo: en un router con abonados,
 * ver el plan antes es lo que permite apretar el botón sin miedo.
 */
router.get(
  '/:id/configurar',
  asyncHandler(async (req, res) => {
    res.json(await configurar.revisar(req.params.id, { red: req.query?.red }))
  }),
)

router.post(
  '/:id/configurar',
  asyncHandler(async (req, res) => {
    res.json(
      await configurar.configurar(req.params.id, {
        red: req.body?.red,
        pasos: req.body?.pasos,
        destinoAviso: req.body?.destinoAviso,
        forzarApi: req.body?.forzarApi === true,
      }),
    )
  }),
)

router.get(
  '/:id/reparar',
  asyncHandler(async (req, res) => {
    res.json(await reparar.revisar(req.params.id))
  }),
)

router.post(
  '/:id/reparar',
  asyncHandler(async (req, res) => {
    res.json(
      await reparar.reparar(req.params.id, {
        borrarDesconocidos: req.body?.borrarDesconocidos === true,
      }),
    )
  }),
)

export default router
