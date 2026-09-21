import { Router } from 'express'
import { asyncHandler, notFound, badRequest, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { db } from '../lib/db.js'
import * as mk from '../services/mikrotikService.js'
import * as olt from '../services/oltService.js'

/**
 * Herramientas de control técnico sobre la ficha del abonado.
 *
 * Todo lo que hoy se hace entrando al Winbox o al SSH de la OLT: probar si
 * responde, mirarle la potencia, reiniciarle el equipo, bajarle la sesión.
 *
 * Dos reglas que valen para todas las rutas de este archivo:
 *
 * 1. **Cada ejecución queda escrita** en `comandos_ejecutados`, salga bien o
 *    mal. Cuando el abonado pregunte por qué se le cortó a las tres de la
 *    tarde, la respuesta tiene que ser un registro y no una suposición.
 *
 * 2. **El objetivo se deduce del cliente, no se recibe del navegador.** Si la
 *    pantalla mandara la IP, un id equivocado reiniciaría el router del vecino.
 *    Acá se lee la ficha y se usa lo que dice.
 */

const router = Router()
router.use(requireAuth)

/** Los datos del abonado y de su router, o el motivo por el que no se puede. */
async function contexto(clientId) {
  const { data: cliente, error } = await db()
    .from('v_clientes_ficha')
    .select(
      'id, nombre, ip, ip_administracion, usuario_ppp, router_id, onu_id, tipo_conexion, ' +
        'estado, nap_id, puerto_nap, onu_serial',
    )
    .eq('id', clientId)
    .maybeSingle()

  if (error) throw new AppError(`No se pudo leer el cliente: ${error.message}`, { status: 502 })
  if (!cliente) throw notFound('No existe ese cliente')

  let equipo = null
  if (cliente.router_id) {
    const { data } = await db()
      .from('routers_mikrotik')
      .select('*')
      .eq('id', cliente.router_id)
      .maybeSingle()
    equipo = data ?? null
  }

  return { cliente, equipo }
}

/**
 * Ejecuta y deja constancia.
 *
 * El registro se escribe siempre —incluso cuando el comando falla— porque un
 * intento fallido de reiniciar un equipo también explica lo que pasó esa tarde.
 */
async function registrando(req, { clientId, comando, parametros = {}, destino }, fn) {
  const arranque = Date.now()
  let salida = null
  let exito = true
  let error = null

  try {
    salida = await fn()
    return salida
  } catch (err) {
    exito = false
    error = err.message
    throw err
  } finally {
    await db()
      .from('comandos_ejecutados')
      .insert({
        client_id: clientId ?? null,
        destino_tipo: destino?.tipo ?? 'mikrotik',
        destino_id: destino?.id ?? null,
        destino_nombre: destino?.nombre ?? null,
        comando,
        parametros,
        // La salida cruda se recorta: un traceroute largo no aporta más por
        // guardarlo entero y la tabla se lee mucho.
        salida: salida ? JSON.stringify(salida).slice(0, 4000) : null,
        exito,
        error,
        duracion_ms: Date.now() - arranque,
        created_by: req.usuario?.id ?? null,
        ip_origen: (req.headers['x-forwarded-for'] ?? req.ip ?? '').split(',')[0].trim() || null,
      })
      // Que falle el registro no puede tumbar la operación que sí funcionó.
      .then(({ error: e }) => e && console.error('[herramientas] no se registró el comando:', e.message))
  }
}

/** El router del cliente, o un error que explica qué falta configurar. */
function exigirRouter(equipo, cliente) {
  if (!equipo) {
    throw badRequest(
      `${cliente.nombre} no tiene router MikroTik asignado en su ficha. Asignalo en la pestaña Servicio.`,
    )
  }
  return equipo
}

// --- Diagnóstico ------------------------------------------------------------

/**
 * Ping desde el router del abonado hacia su IP.
 *
 * Se pinguea desde el router y no desde el servidor: lo que interesa es si el
 * equipo del cliente responde dentro de la red, no si nuestro servidor llega
 * hasta él —que puede fallar por una ruta y no por el abonado—.
 */
router.post(
  '/:clientId/ping',
  asyncHandler(async (req, res) => {
    const { cliente, equipo } = await contexto(req.params.clientId)
    exigirRouter(equipo, cliente)

    const destino = req.body?.destino || cliente.ip || cliente.ip_administracion
    if (!destino) throw badRequest('El cliente no tiene IP cargada y no se indicó un destino')

    const salida = await registrando(
      req,
      {
        clientId: cliente.id,
        comando: 'ping',
        parametros: { destino },
        destino: { tipo: 'mikrotik', id: equipo.id, nombre: equipo.nombre },
      },
      () => mk.ping(equipo, { destino, cantidad: req.body?.cantidad ?? 4 }),
    )

    // RouterOS devuelve una fila por paquete. Se resume acá para que la
    // pantalla no tenga que entender el formato del equipo.
    const paquetes = (salida ?? []).filter((p) => p.time || p.status)
    const respondidos = paquetes.filter((p) => p.time)
    const tiempos = respondidos.map((p) => Number(String(p.time).replace(/[^\d.]/g, ''))).filter(Boolean)

    res.json({
      destino,
      enviados: paquetes.length,
      recibidos: respondidos.length,
      perdida: paquetes.length ? Math.round(((paquetes.length - respondidos.length) / paquetes.length) * 100) : null,
      ms_min: tiempos.length ? Math.min(...tiempos) : null,
      ms_max: tiempos.length ? Math.max(...tiempos) : null,
      ms_promedio: tiempos.length
        ? Math.round((tiempos.reduce((s, t) => s + t, 0) / tiempos.length) * 10) / 10
        : null,
      crudo: salida,
    })
  }),
)

router.post(
  '/:clientId/traceroute',
  asyncHandler(async (req, res) => {
    const { cliente, equipo } = await contexto(req.params.clientId)
    exigirRouter(equipo, cliente)

    const destino = req.body?.destino || cliente.ip || cliente.ip_administracion
    if (!destino) throw badRequest('El cliente no tiene IP cargada y no se indicó un destino')

    const salida = await registrando(
      req,
      {
        clientId: cliente.id,
        comando: 'traceroute',
        parametros: { destino },
        destino: { tipo: 'mikrotik', id: equipo.id, nombre: equipo.nombre },
      },
      () => mk.traceroute(equipo, { destino, saltos: req.body?.saltos ?? 12 }),
    )

    res.json({
      destino,
      saltos: (salida ?? []).map((s, i) => ({
        salto: Number(s.hops ?? i + 1),
        direccion: s.address ?? '*',
        ms: s['avg-rtt'] ?? s.time ?? null,
        perdida: s.loss ?? null,
      })),
      crudo: salida,
    })
  }),
)

/**
 * Potencia óptica o señal de radio, según cómo esté conectado el abonado.
 *
 * En fibra se le pregunta a la OLT, que es quien la mide de verdad. La lectura
 * guardada en `onus` puede tener horas: sirve para el listado, no para
 * diagnosticar una falla que está pasando ahora.
 */
router.post(
  '/:clientId/senal',
  asyncHandler(async (req, res) => {
    const { cliente, equipo } = await contexto(req.params.clientId)

    if (cliente.onu_id) {
      const { data: onu } = await db()
        .from('onus')
        .select('*, olts(*)')
        .eq('id', cliente.onu_id)
        .maybeSingle()

      if (!onu?.olts) throw badRequest('La ONU del cliente no tiene OLT asociada')

      const salida = await registrando(
        req,
        {
          clientId: cliente.id,
          comando: 'senal_optica',
          parametros: { sn: onu.sn },
          destino: { tipo: 'olt', id: onu.olts.id, nombre: onu.olts.nombre },
        },
        () =>
          olt.leerMetricas(onu.olts, {
            frame: onu.frame ?? 0,
            slot: onu.slot ?? 0,
            puerto: onu.puerto,
            // `onu_index`, no `onu_id`: esa columna no existe en `onus` y el
            // ONT-ID llegaba `undefined`, así que la lectura se pedía sin decir
            // de cuál de las sesenta ONTs del puerto. El resto del sistema
            // —`oltFicha`, `reemplazos`, `olt.routes`— ya usaba `onu_index`.
            onuId: onu.onu_index,
          }),
      )

      return res.json({ tipo: 'optica', onu: onu.sn, ...salida })
    }

    // Radio: la señal la reporta el CPE, y se llega a él por su IP de
    // administración desde el router que lo alimenta.
    exigirRouter(equipo, cliente)
    if (!cliente.ip_administracion) {
      throw badRequest('El cliente no tiene IP de administración del CPE cargada')
    }

    const salida = await registrando(
      req,
      {
        clientId: cliente.id,
        comando: 'senal_radio',
        parametros: { ip: cliente.ip_administracion },
        destino: { tipo: 'mikrotik', id: equipo.id, nombre: equipo.nombre },
      },
      () => mk.ping(equipo, { destino: cliente.ip_administracion, cantidad: 3 }),
    )

    res.json({
      tipo: 'radio',
      ip: cliente.ip_administracion,
      alcanzable: (salida ?? []).some((p) => p.time),
      aviso:
        'La lectura de señal del CPE necesita entrar al equipo del abonado. Por ahora se verifica que responda.',
      crudo: salida,
    })
  }),
)

router.post(
  '/:clientId/test-velocidad',
  asyncHandler(async (req, res) => {
    const { cliente, equipo } = await contexto(req.params.clientId)
    exigirRouter(equipo, cliente)

    const destino = req.body?.destino || cliente.ip
    if (!destino) throw badRequest('Falta la IP contra la que medir')

    const salida = await registrando(
      req,
      {
        clientId: cliente.id,
        comando: 'test_velocidad',
        parametros: { destino },
        destino: { tipo: 'mikrotik', id: equipo.id, nombre: equipo.nombre },
      },
      () => mk.testVelocidad(equipo, { destino, duracion: req.body?.duracion ?? 5 }),
    )

    const ultima = (salida ?? []).at(-1) ?? {}
    res.json({
      destino,
      subida: ultima['tx-current'] ?? ultima['tx-total-average'] ?? null,
      bajada: ultima['rx-current'] ?? ultima['rx-total-average'] ?? null,
      aviso: 'Mide el enlace hasta el abonado, no su salida a internet.',
      crudo: salida,
    })
  }),
)

// --- Control de equipos -----------------------------------------------------

router.post(
  '/:clientId/reiniciar',
  asyncHandler(async (req, res) => {
    const { cliente, equipo } = await contexto(req.params.clientId)
    exigirRouter(equipo, cliente)

    // Reiniciar el router de borde deja sin servicio a todos sus abonados. Se
    // exige decirlo explícitamente para que no pase por descuido.
    if (req.body?.confirmar !== true) {
      throw badRequest('Falta confirmar: reiniciar el equipo corta el servicio mientras arranca')
    }

    await registrando(
      req,
      {
        clientId: cliente.id,
        comando: 'reiniciar',
        parametros: {},
        destino: { tipo: 'mikrotik', id: equipo.id, nombre: equipo.nombre },
      },
      () => mk.reiniciar(equipo),
    )

    res.json({ ok: true, mensaje: `${equipo.nombre} está reiniciando. Tarda entre 30 y 90 segundos.` })
  }),
)

/**
 * Baja la sesión PPPoE del abonado para que reconecte.
 *
 * No es un corte: es la forma de que tome la configuración nueva sin esperar a
 * que se reinicie solo.
 */
router.post(
  '/:clientId/kick-ppp',
  asyncHandler(async (req, res) => {
    const { cliente, equipo } = await contexto(req.params.clientId)
    exigirRouter(equipo, cliente)

    if (!cliente.usuario_ppp) throw badRequest('El cliente no tiene usuario PPPoE cargado')

    const salida = await registrando(
      req,
      {
        clientId: cliente.id,
        comando: 'kick_ppp',
        parametros: { usuario: cliente.usuario_ppp },
        destino: { tipo: 'mikrotik', id: equipo.id, nombre: equipo.nombre },
      },
      () => mk.bajarSesionPpp(equipo, { usuario: cliente.usuario_ppp }),
    )

    res.json({
      ok: true,
      ...salida,
      mensaje: salida.bajadas
        ? `Se bajó la sesión de ${cliente.usuario_ppp}. Reconecta en unos segundos.`
        : 'No tenía sesión activa: el abonado ya estaba desconectado.',
    })
  }),
)

router.post(
  '/:clientId/wifi',
  asyncHandler(async (req, res) => {
    const { cliente, equipo } = await contexto(req.params.clientId)
    exigirRouter(equipo, cliente)

    const { ssid, clave } = req.body ?? {}
    if (!ssid && !clave) throw badRequest('Indicá el nombre de la red, la clave o ambos')
    if (clave && String(clave).length < 8) {
      throw badRequest('La clave WiFi tiene que tener al menos 8 caracteres')
    }

    const salida = await registrando(
      req,
      {
        clientId: cliente.id,
        comando: 'cambiar_wifi',
        // La clave no se guarda en el registro: quedaría en texto plano al
        // alcance de cualquiera que mire la bitácora.
        parametros: { ssid: ssid ?? null, clave: clave ? '(cambiada)' : null },
        destino: { tipo: 'mikrotik', id: equipo.id, nombre: equipo.nombre },
      },
      () => mk.cambiarWifi(equipo, { ssid, clave, perfil: req.body?.perfil }),
    )

    res.json({
      ok: true,
      ...salida,
      mensaje:
        'Los dispositivos conectados se van a desconectar y hay que reconectarlos con la clave nueva.',
    })
  }),
)

/**
 * Qué equipos tiene prendidos el abonado.
 *
 * Sale del ARP del router. No es la lista del WiFi de su casa —para eso hace
 * falta entrar al CPE por TR-069— pero contesta la pregunta de siempre: si son
 * tres aparatos o quince compartiendo la conexión.
 */
router.get(
  '/:clientId/dispositivos',
  asyncHandler(async (req, res) => {
    const { cliente, equipo } = await contexto(req.params.clientId)
    exigirRouter(equipo, cliente)

    const salida = await registrando(
      req,
      {
        clientId: cliente.id,
        comando: 'dispositivos',
        parametros: {},
        destino: { tipo: 'mikrotik', id: equipo.id, nombre: equipo.nombre },
      },
      () => mk.listarArp(equipo, {}),
    )

    // Solo lo que cuelga de la IP del abonado: el ARP del router trae toda la
    // red y mostrarla entera sería filtrar los equipos de los demás.
    const red = String(cliente.ip ?? '').split('.').slice(0, 3).join('.')
    const suyos = (salida ?? []).filter((a) => String(a.address ?? '').startsWith(red))

    res.json({
      total: suyos.length,
      dispositivos: suyos.map((a) => ({
        ip: a.address,
        mac: a['mac-address'],
        interfaz: a.interface,
        dinamico: a.dynamic === 'true',
      })),
      aviso: red
        ? null
        : 'El cliente no tiene IP cargada: se muestra el ARP completo del router.',
    })
  }),
)

export default router
