import { Router } from 'express'
import { asyncHandler, badRequest } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { porMetodo } from '../lib/permisos.js'
import { cargarOlt, db } from '../lib/db.js'
import { config } from '../config.js'
import { cerrarTodasSsh, sesionesSshAbiertas } from '../lib/sshSession.js'
import * as olts from '../services/oltService.js'
import * as ficha from '../services/oltFicha.js'
import * as optica from '../services/opticaProgramada.js'
import * as esperandoProg from '../services/esperandoProgramado.js'
import * as preaut from '../services/preautorizacion.js'
import * as trafico from '../services/traficoOnu.js'
import * as resync from '../services/resyncMasivo.js'
import * as naps from '../services/cajasNap.js'
import * as planes from '../services/planesOlt.js'
import * as vlans from '../services/vlansOlt.js'
import * as esquema from '../services/esquemaPorPuerto.js'
import * as pools from '../services/poolsOnu.js'
import { UMBRAL_RX_DBM } from '../lib/optica.js'
import { parseAutofindPorPuerto } from '../parsers/huaweiPuertoParser.js'

const router = Router()
// Leer y operar se separan: el técnico necesita ver la potencia de la ONU que
// está instalando, y no tiene por qué poder reiniciar un puerto PON.
router.use(
  requireAuth,
  porMetodo({
    lectura: ['red.olts_ver', 'red.onus_ver'],
    escritura: ['red.olts_gestionar', 'red.onus_aprovisionar', 'red.cortes'],
  }),
)

/** Umbral de alerta de señal óptica del taller (Fase 4). */
// Se re-exporta para no romper lo que ya lo importaba desde acá. La constante
// vive en lib/optica.js: la usan rutas, tareas programadas y vistas, y
// duplicarla sería garantizar que un día se cambie en un solo lado.
export { UMBRAL_RX_DBM }

/** Carga la OLT de Supabase y la deja en req.equipo (credenciales descifradas). */
const conOlt = asyncHandler(async (req, _res, next) => {
  req.equipo = await cargarOlt(req.params.id)
  next()
})

/** Lee frame/slot/puerto de la query o el body, con los defaults del taller. */
function ubicacion(req) {
  const src = { ...req.query, ...req.body }
  const n = (v, def) => {
    const x = Number.parseInt(v, 10)
    return Number.isFinite(x) ? x : def
  }
  return {
    frame: n(src.frame, 0),
    slot: n(src.slot, 0),
    puerto: n(src.puerto, undefined),
    onuId: src.onuId != null ? n(src.onuId, undefined) : undefined,
  }
}

// --- Salud ------------------------------------------------------------------

router.get(
  '/:id/test',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await olts.probarConexion(req.equipo))
  }),
)

/**
 * Estado del equipo: temperatura, placas, consumo y puertos PON.
 *
 * Todo se lee en vivo y en una sola sesión. No se cachea a propósito: un
 * tablero de salud que muestra la temperatura de hace media hora es peor que
 * uno que tarda cinco segundos en contestar.
 */
router.get(
  '/:id/salud',
  conOlt,
  asyncHandler(async (req, res) => {
    const salud = await olts.leerSalud(req.equipo)

    // El resumen se arma acá para que la pantalla no tenga que decidir qué es
    // grave: la regla de cuándo una OLT está sana es una sola y vive en un
    // lugar.
    const placasMal = (salud.placas ?? []).filter((p) => !p.ok)
    const puertos = (salud.tarjetas ?? []).flatMap((t) => t.puertos ?? [])
    const puertosMal = puertos.filter((p) => !p.ok)
    const temperaturas = (salud.temperaturas ?? []).map((t) => t.celsius)

    res.json({
      ...salud,
      resumen: {
        // 60 °C es donde estos equipos empiezan a sufrir; 70 es donde se apagan
        // placas. Se avisa antes, no cuando ya pasó.
        temperatura_max: temperaturas.length ? Math.max(...temperaturas) : null,
        temperatura_alta: temperaturas.some((c) => c >= 60),
        placas: (salud.placas ?? []).length,
        placas_con_falla: placasMal.length,
        puertos_pon: puertos.length,
        puertos_caidos: puertosMal.length,
        // El reloj corrido no rompe nada hoy, pero deja los eventos del equipo
        // sin poder cruzarse con los del resto del sistema.
        reloj_desfasado: Math.abs(salud.hora?.desfase_segundos ?? 0) > 120,
        sano: placasMal.length === 0 && puertosMal.length === 0 && !temperaturas.some((c) => c >= 60),
      },
      // Lo que este modelo no sabe contestar. Decirlo explícitamente evita que
      // un hueco en la pantalla se lea como "está en cero".
      no_reportado: [
        !salud.potencia && 'consumo',
        !(salud.temperaturas ?? []).length && 'temperatura',
        !salud.uptime && 'tiempo encendido',
        'ventiladores',
        'CPU y memoria',
        'voltaje de entrada',
      ].filter(Boolean),
    })
  }),
)

/**
 * Cuántas sesiones SSH mantiene abiertas el middleware.
 *
 * Sirve para descartar lo primero que uno sospecha cuando la OLT dice "exceed
 * max sessions": si acá dice 1 y el equipo igual rechaza, las sesiones colgadas
 * son de otro lado —un PuTTY olvidado, otro operador— y no de este sistema.
 */
router.get(
  '/sesiones',
  asyncHandler(async (_req, res) => {
    res.json({
      abiertas: sesionesSshAbiertas(),
      persistente: config.ssh.sesionPersistente,
      idle_ms: config.ssh.sesionIdleMs,
      nota: config.ssh.sesionPersistente
        ? 'La sesión se reutiliza entre operaciones y se cierra sola tras el tiempo de inactividad.'
        : 'Cada operación abre y cierra su propia sesión (SSH_SESION_PERSISTENTE=false).',
    })
  }),
)

/**
 * Suelta la sesión que el middleware tenga abierta contra las OLTs.
 *
 * Es el botón de "liberá la ranura ahora": después de trabajar, para que el
 * equipo quede con sus sesiones libres sin esperar el tiempo de inactividad.
 */
router.post(
  '/sesiones/cerrar',
  asyncHandler(async (_req, res) => {
    const antes = sesionesSshAbiertas()
    await cerrarTodasSsh()
    res.json({
      cerradas: antes,
      mensaje: antes
        ? `Se cerraron ${antes} sesiones. Las que el equipo siga reportando son de otro cliente SSH.`
        : 'El middleware no tenía ninguna sesión abierta.',
    })
  }),
)

// --- Alcance, versiones e inventario ----------------------------------------

/**
 * Refresca el puntito verde de todas las OLTs.
 *
 * Es un TCP contra el puerto de gestión, no una sesión: el listado necesita
 * saber si el equipo contesta, no hablar con él. Abrir tres sesiones SSH para
 * pintar tres círculos consumiría las pocas ranuras que tienen estos equipos.
 */
router.post(
  '/estados',
  asyncHandler(async (_req, res) => {
    res.json({ olts: await ficha.refrescarEstados() })
  }),
)

/**
 * Auditoría de coherencia entre la base y los equipos.
 *
 * Sin `profundo` solo consulta la base y contesta al instante. Con `profundo=1`
 * además abre una sesión contra cada OLT, que es caro y por eso no es lo que
 * corre por defecto.
 */
router.get(
  '/inconsistencias',
  asyncHandler(async (req, res) => {
    const profundo = req.query.profundo === '1' || req.query.profundo === 'true'
    res.json(await ficha.buscarInconsistencias({ profundo }))
  }),
)

/**
 * Estado de la lectura óptica automática, y disparo manual de una pasada.
 *
 * Van ANTES que las rutas con `:id`. Express resuelve por orden de declaración,
 * así que declaradas después, `/optica/estado` la atendería `/:id/estado` con
 * "optica" haciendo de identificador — y el error que se ve es que "optica" no
 * es un UUID válido, que no apunta a ningún lado.
 */
router.get(
  '/optica/estado',
  asyncHandler(async (_req, res) => {
    res.json(optica.estadoOptica())
  }),
)

router.post(
  '/optica/leer',
  asyncHandler(async (_req, res) => {
    res.json(await optica.leerTodas())
  }),
)

/** Barrido de ONTs esperando autorización, a pedido. */
router.post(
  '/esperando/escanear',
  asyncHandler(async (_req, res) => {
    res.json(await esperandoProg.escanearTodas())
  }),
)

router.get(
  '/esperando/estado',
  asyncHandler(async (_req, res) => {
    res.json(esperandoProg.estadoEsperando())
  }),
)

/**
 * Cómo va el barrido que relee la ficha de todas las ONUs.
 *
 * Va ANTES que las rutas con `:id`, como /optica/estado: declarada después, la
 * atendería `/:id/...` con "resync-masivo" haciendo de identificador.
 */
router.get(
  '/resync-masivo/estado',
  asyncHandler(async (_req, res) => {
    res.json(resync.estadoResync())
  }),
)

router.post(
  '/resync-masivo/detener',
  asyncHandler(async (_req, res) => {
    res.json(resync.detenerResync())
  }),
)

// --- VLANs -------------------------------------------------------------------

/**
 * Las VLANs de la OLT: las que tiene el equipo más lo que sabemos de ellas.
 *
 * La existencia la dice el equipo; para qué se usa y de qué puerto PON es la
 * predeterminada, no puede saberlo — eso es una convención del ISP.
 */
router.get(
  '/:id/vlans',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await vlans.listarVlans(req.equipo.id))
  }),
)

/** Crea una o varias. Acepta "201-215, 300". */
router.post(
  '/:id/vlans',
  conOlt,
  asyncHandler(async (req, res) => {
    res.status(201).json(await vlans.crearVlans(req.equipo.id, req.body ?? {}))
  }),
)

/**
 * Borra una o varias.
 *
 * Se niega si tienen abonados: quitarlas los deja sin salida en el mismo
 * segundo y desde el lado GPON no se ve nada raro, las ONTs siguen online.
 */
router.post(
  '/:id/vlans/borrar',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await vlans.borrarVlans(req.equipo.id, req.body ?? {}))
  }),
)

/**
 * La misma información al revés: los puertos PON de cada placa con su VLAN.
 *
 * Existe aparte de `/vlans` porque responde otra pregunta —"¿qué le falta al
 * 6/12?" en vez de "¿dónde se usa la 200?"— y es la vista con la que se
 * configura el esquema.
 */
router.get(
  '/:id/vlans/puertos',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await vlans.listarPuertosConVlan(req.equipo.id))
  }),
)

/**
 * Le pregunta al equipo cómo está armado y guarda el resultado.
 *
 * Es la parte cara —treinta segundos— y por eso es un botón y no algo que pase
 * al abrir la pantalla. Casi todo ese tiempo se va en leer qué placas hay y
 * cuántos puertos tiene cada una, que no cambia salvo que alguien cambie una
 * tarjeta.
 */
router.post(
  '/:id/vlans/puertos/relevar',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await vlans.relevarPuertos(req.equipo.id))
  }),
)

/**
 * Trae al sistema la VLAN que cada puerto ya usa, leída del equipo.
 *
 * `aplicar=false` solo propone. No escribe nada en la OLT en ningún caso: lo
 * único que toca son nuestras anotaciones.
 */
router.post(
  '/:id/vlans/importar',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await vlans.importarVlansDePuertos(req.equipo.id, req.body ?? {}))
  }),
)

/** Qué VLAN usa un puerto PON por defecto. No toca el equipo. */
router.put(
  '/:id/puertos/:slot/:puerto',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(
      await vlans.asignarPuerto(req.equipo.id, {
        slot: req.params.slot,
        puerto: req.params.puerto,
        ...(req.body ?? {}),
      }),
    )
  }),
)

/** Le quita a un puerto su VLAN predeterminada. No borra la VLAN ni toca el equipo. */
router.delete(
  '/:id/puertos/:slot/:puerto',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(
      await vlans.desasignarPuerto(req.equipo.id, {
        slot: req.params.slot,
        puerto: req.params.puerto,
      }),
    )
  }),
)

/** Para qué sirve una VLAN y de qué puerto es la predeterminada. No toca el equipo. */
router.put(
  '/:id/vlans/:vlan',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await vlans.anotarVlan(req.equipo.id, req.params.vlan, req.body ?? {}))
  }),
)

/** Asigna VLANs correlativas a los puertos de una placa: 201 al 1, 202 al 2… */
router.post(
  '/:id/vlans/correlativas',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await vlans.asignarCorrelativas(req.equipo.id, req.body ?? {}))
  }),
)

/**
 * El esquema completo por puerto: una VLAN y un bloque de IP para cada PON.
 *
 * Va en dos pasos a propósito. El primero calcula y contrasta contra lo que ya
 * existe sin tocar nada; el segundo crea. Dieciséis subredes y dieciséis VLANs
 * salidas de un solo botón son demasiadas para no verlas antes.
 */
router.post(
  '/:id/vlans/esquema/simular',
  conOlt,
  asyncHandler(async (req, res) => {
    const plan = esquema.planificarEsquemaPorPuerto({
      ...(req.body ?? {}),
      olt: req.body?.olt ?? req.equipo.nombre,
    })
    res.json(await esquema.revisarEsquema(req.equipo.id, plan, { routerId: req.body?.routerId }))
  }),
)

/**
 * Deshace el esquema: el bloque, el pool y la VLAN del puerto, de una.
 *
 * Existe porque crear son tres cosas y deshacerlas eran tres pantallas. Quien
 * iba a dos quedaba con el generador bloqueado sin entender por qué.
 */
router.post(
  '/:id/vlans/esquema/deshacer',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await esquema.deshacerEsquema(req.equipo.id, req.body ?? {}))
  }),
)

router.post(
  '/:id/vlans/esquema/aplicar',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await esquema.aplicarEsquema(req.equipo.id, req.body ?? {}))
  }),
)

// --- Pools de IP para las ONUs ----------------------------------------------
//
// Las direcciones con las que se administra cada ONT (TR069) y las estáticas de
// su WAN. Nada de esto toca el equipo: es el registro de qué direcciones hay y
// cuáles están libres, que hoy se resuelve mirando la OLT a mano.

router.get(
  '/:id/pools-ip',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await pools.listarPools(req.equipo.id, { proposito: req.query.proposito }))
  }),
)

/** Qué abarcaría el rango, sin crear nada. Es lo que valida el formulario. */
router.post(
  '/:id/pools-ip/revisar',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(pools.revisarRango(req.body ?? {}))
  }),
)

router.post(
  '/:id/pools-ip',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await pools.crearPool(req.equipo.id, req.body ?? {}))
  }),
)

router.get(
  '/:id/pools-ip/:subredId/ips',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(
      await pools.listarIps(req.params.subredId, {
        estado: req.query.estado,
        limite: Number(req.query.limite) || 500,
        desde: Number(req.query.desde) || 0,
      }),
    )
  }),
)

router.put(
  '/:id/pools-ip/:subredId',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await pools.editarPool(req.params.subredId, req.body ?? {}))
  }),
)

router.post(
  '/:id/pools-ip/:subredId/ampliar',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await pools.ampliarPool(req.params.subredId, req.body ?? {}))
  }),
)

router.delete(
  '/:id/pools-ip/:subredId',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(
      await pools.borrarPool(req.params.subredId, {
        forzar: req.query.forzar === 'true' || req.query.forzar === '1',
      }),
    )
  }),
)

/**
 * Trae al sistema las IPs de gestión que las ONTs ya tienen puestas.
 *
 * Es el paso de una migración desde otro sistema: sin esto, las direcciones que
 * están en los equipos figuran libres acá y el primer alta entrega una repetida.
 */
router.post(
  '/:id/pools-ip/importar',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await pools.importarIpsDeGestion(req.equipo.id, req.body ?? {}))
  }),
)

/**
 * Un perfil PPP por VLAN, cada uno con su propia puerta de enlace.
 *
 * Hace falta cuando el esquema usa un gateway por bloque: reservar el .1 de
 * cada /25 no sirve de nada si todos los abonados siguen recibiendo el mismo
 * local-address.
 */
router.post(
  '/:id/perfiles-por-vlan',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await pools.crearPerfilesPorVlan(req.equipo.id, req.body ?? {}))
  }),
)

/** La siguiente libre, con su gateway, DNS y VLAN. */
router.get(
  '/:id/pools-ip/:subredId/siguiente',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await pools.siguienteLibre(req.params.subredId))
  }),
)

/** Qué segmento de red le toca a una ONT según en qué puerto apareció. */
router.get(
  '/:id/vlans/segmento/:slot/:puerto',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(
      await vlans.segmentoDePuerto(req.equipo.id, {
        slot: req.params.slot,
        puerto: req.params.puerto,
      }),
    )
  }),
)

// --- Perfiles de velocidad (traffic tables) ---------------------------------
// Van con las rutas literales: son de varias OLTs a la vez, no de una.

/**
 * Las traffic tables de las OLTs que se pidan.
 *
 * Se consulta cada equipo por separado: el índice 12 de una OLT no tiene por
 * qué ser la misma velocidad que el 12 de otra, y ver eso antes de crear nada
 * es medio trabajo hecho.
 */
router.get(
  '/velocidades',
  asyncHandler(async (req, res) => {
    const ids = String(req.query.olt_ids ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)

    if (!ids.length) {
      const { data } = await db().from('olts').select('id').eq('activo', true).order('numero')
      ids.push(...(data ?? []).map((o) => o.id))
    }
    const lista = await planes.listarTablasDeOlts(ids)
    // Emparejadas: el equipo las guarda de a una pero el negocio las usa de a
    // dos, y quien las cargó ya las nombró así (-UP / -DOWN).
    res.json(
      lista.map((x) => ({
        ...x,
        ...(x.tablas ? planes.emparejar(x.tablas) : { pares: [], sueltas: [] }),
      })),
    )
  }),
)

/**
 * Crea un par de traffic tables —bajada y subida— en las OLTs elegidas.
 *
 * El par y no una sola: el equipo aplica una tabla por sentido. Y con los
 * MISMOS índices en todos los equipos, para que un plan comercial pueda guardar
 * un solo par de números y valga para toda la red.
 */
router.post(
  '/velocidades',
  asyncHandler(async (req, res) => {
    const { olt_ids, nombre, bajada_kbps, subida_kbps, priority } = req.body ?? {}
    res.status(201).json(
      await planes.crearParDeTablas(olt_ids, {
        nombre,
        bajada_kbps: Number(bajada_kbps),
        subida_kbps: Number(subida_kbps),
        priority: priority ?? 0,
      }),
    )
  }),
)

/**
 * Crea un plan comercial a partir de un par de traffic tables que ya existe.
 *
 * Es el camino que faltaba: en una red que ya está andando, las tablas existen
 * desde hace años y lo único que falta es ponerles nombre y precio.
 */
router.post(
  '/:id/velocidades/plan',
  conOlt,
  asyncHandler(async (req, res) => {
    res.status(201).json(await planes.crearPlanDesdeTablas(req.equipo.id, req.body ?? {}))
  }),
)

router.delete(
  '/velocidades/:index',
  asyncHandler(async (req, res) => {
    const ids = String(req.query.olt_ids ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    res.json(await planes.borrarTabla(ids, Number(req.params.index)))
  }),
)

// --- Planes y velocidad real ------------------------------------------------

/**
 * Comprueba los planes contra las traffic tables del equipo.
 *
 * Contesta dos preguntas distintas: si los índices existen, y si aplican la
 * velocidad que el plan dice vender. La segunda importa igual — un plan llamado
 * "100M" que apunta a una tabla de 1 Gbps no limita nada, y desde el nombre no
 * se nota.
 */
router.get(
  '/:id/planes/verificar',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await planes.verificarPlanes(req.equipo.id, { guardar: req.query.guardar === '1' }))
  }),
)

/** Guarda los dos índices de un plan, comprobándolos antes contra el equipo. */
router.put(
  '/:id/planes/:planId/tablas',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(
      await planes.guardarTablasDePlan(req.equipo.id, req.params.planId, {
        subida: req.body?.subida,
        bajada: req.body?.bajada,
      }),
    )
  }),
)

/** Las traffic tables cargadas en el equipo, con su velocidad real. */
router.get(
  '/:id/traffic-tables',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await olts.leerTrafficTables(req.equipo))
  }),
)

// --- Cajas NAP --------------------------------------------------------------
// Antes que las rutas con `:id`, como el resto de las literales.

/** Las cajas cargadas, con cuántas bocas les quedan. */
router.get(
  '/naps',
  asyncHandler(async (req, res) => {
    res.json(await naps.listarCajas(req.query.olt_id))
  }),
)

router.patch(
  '/naps/:napId',
  asyncHandler(async (req, res) => {
    res.json(await naps.actualizarCaja(req.params.napId, req.body ?? {}))
  }),
)

router.delete(
  '/naps/:napId',
  asyncHandler(async (req, res) => {
    res.json(await naps.borrarCaja(req.params.napId))
  }),
)

/** Cuelga ONUs de una caja, o las saca. */
router.post(
  '/naps/:napId/onus',
  asyncHandler(async (req, res) => {
    res.json({
      asignadas: await naps.asignarOnus(req.params.napId, req.body?.onu_ids ?? [], {
        verificada: req.body?.verificada === true,
      }),
    })
  }),
)

router.post(
  '/naps/desasignar',
  asyncHandler(async (req, res) => {
    res.json({ desasignadas: await naps.desasignarOnus(req.body?.onu_ids ?? []) })
  }),
)

// --- Plantillas de autorización ---------------------------------------------
// Van antes de las rutas con `:id` para que "presets" no se lea como el id de
// una OLT. Ya pasó con /optica/estado.

router.get(
  '/presets',
  asyncHandler(async (req, res) => {
    res.json(await preaut.listarPresets(req.query.olt_id))
  }),
)

router.post(
  '/presets',
  asyncHandler(async (req, res) => {
    res.json(await preaut.guardarPreset(req.body ?? {}))
  }),
)

router.delete(
  '/presets/:presetId',
  asyncHandler(async (req, res) => {
    res.json(await preaut.borrarPreset(req.params.presetId))
  }),
)

// --- ONTs cargadas por adelantado -------------------------------------------

router.get(
  '/preautorizadas',
  asyncHandler(async (req, res) => {
    res.json(await preaut.listarPreautorizadas(req.query))
  }),
)

router.delete(
  '/preautorizadas/:preId',
  asyncHandler(async (req, res) => {
    res.json(await preaut.borrarPreautorizada(req.params.preId))
  }),
)

/** Vuelve a dejarla esperando después de un fallo, para reintentar. */
router.post(
  '/preautorizadas/:preId/reactivar',
  asyncHandler(async (req, res) => {
    res.json(await preaut.reactivarPreautorizada(req.params.preId))
  }),
)

/** Alcance de una sola OLT. No descifra credenciales: no le hace falta. */
router.get(
  '/:id/estado',
  asyncHandler(async (req, res) => {
    const { data, error } = await db()
      .from('olts')
      .select('id, nombre, ip_host, puerto_ssh')
      .eq('id', req.params.id)
      .maybeSingle()

    if (error) throw badRequest(`No se pudo leer la OLT: ${error.message}`)
    if (!data) throw badRequest(`No existe una OLT con id ${req.params.id}`)

    res.json(await ficha.refrescarEstado(data))
  }),
)

/** Lee modelo, firmware y tipos PON del equipo y los deja guardados en la ficha. */
router.post(
  '/:id/versiones',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await ficha.sincronizarVersiones(req.equipo))
  }),
)

/** Placas del chasis con su temperatura. */
router.get(
  '/:id/cards',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json({ placas: await olts.leerPlacas(req.equipo) })
  }),
)

/**
 * Puertos de subida, con las VLANs que pasan por cada uno.
 *
 * Es lo que hace falta para armar un troncal: sin saber qué VLANs llegan al
 * router, un abonado nuevo puede quedar con la ONT online y sin navegar, y el
 * síntoma manda a buscar el problema del lado equivocado.
 */
router.get(
  '/:id/uplinks',
  conOlt,
  asyncHandler(async (req, res) => {
    const slots = String(req.query.slots ?? '')
      .split(',')
      .map((s) => Number.parseInt(s, 10))
      .filter(Number.isFinite)

    res.json(await olts.leerUplinks(req.equipo, { slots }))
  }),
)

/**
 * Agrega o quita VLANs de puertos de subida.
 *
 * Es la operación más disruptiva del sistema: quitar una VLAN con abonados los
 * deja sin salida a todos en el mismo segundo, y desde el lado GPON no se ve
 * nada raro porque las ONTs siguen online. Por eso el middleware se niega salvo
 * que se insista con `forzar`, y siempre dice cuántos son.
 */
router.post(
  '/:id/uplinks/vlans',
  conOlt,
  asyncHandler(async (req, res) => {
    const { slot, puertos, vlans, quitar, forzar, crear } = req.body ?? {}

    if (req.body?.confirmar !== true) {
      throw badRequest('Falta la confirmación explícita', {
        hint: 'Mandá { "confirmar": true }. Esto cambia el troncal de la OLT.',
      })
    }

    const aNumeros = (v) =>
      (Array.isArray(v) ? v : [v]).map(Number).filter((n) => Number.isFinite(n))

    res.json(
      await olts.cambiarVlansDeUplink(req.equipo, {
        slot: Number(slot),
        puertos: aNumeros(puertos),
        vlans: aNumeros(vlans),
        quitar: quitar === true,
        forzar: forzar === true,
        crear: crear === true,
      }),
    )
  }),
)

/**
 * Estado detallado de los puertos PON de una placa.
 *
 * Un comando por puerto: dieciséis puertos son un minuto y medio. Va bajo
 * demanda —el botón "Actualizar info"— porque lo barato (cuántas ONTs y su
 * señal) ya sale de la base al instante.
 */
router.get(
  '/:id/pon-ports/estado',
  conOlt,
  asyncHandler(async (req, res) => {
    const slot = Number.parseInt(req.query.slot, 10)
    if (!Number.isFinite(slot)) throw badRequest('Falta el slot')

    const puertos = Number.parseInt(req.query.puertos, 10) || 16
    const r = await olts.leerEstadoPuertos(req.equipo, { slot, puertos })

    // El auto-find no tiene un `display` propio en este modelo: vive en la
    // configuración corriente. Se saca del último respaldo en vez de volver a
    // pedirla — son ochocientas líneas que además dejarían la sesión
    // inservible para los comandos siguientes.
    let autofind = new Map()
    let autofindDe = null
    const { data: respaldo } = await db()
      .from('olt_backups')
      .select('contenido, created_at')
      .eq('olt_id', req.equipo.id)
      .order('created_at', { ascending: false })
      .limit(1)

    if (respaldo?.[0]) {
      autofind = parseAutofindPorPuerto(respaldo[0].contenido)
      autofindDe = respaldo[0].created_at
    }

    res.json({
      slot,
      puertos: r.puertos.map((p) => ({ ...p, autofind: autofind.get(p.puerto) ?? null })),
      fallos: r.fallos,
      // De cuándo es el dato del auto-find: si el respaldo es viejo, puede no
      // reflejar un cambio reciente.
      autofind_de: autofindDe,
    })
  }),
)

/**
 * Acciones masivas sobre todos los puertos de una placa.
 *
 * Escriben en el equipo. `reiniciar_onts` además corta el servicio de TODOS los
 * abonados de la placa, así que la confirmación explícita no es burocracia.
 */
router.post(
  '/:id/pon-ports/acciones',
  conOlt,
  asyncHandler(async (req, res) => {
    const { accion, slot, puertos } = req.body ?? {}

    if (req.body?.confirmar !== true) {
      throw badRequest('Falta la confirmación explícita', {
        hint: 'Mandá { "confirmar": true }. Estas acciones escriben en el equipo.',
      })
    }
    if (!Number.isFinite(Number(slot))) throw badRequest('Falta el slot')

    res.json(
      await olts.aplicarAPuertos(req.equipo, {
        slot: Number(slot),
        puertos: Number(puertos) || 16,
        accion,
      }),
    )
  }),
)

/**
 * Reinicia las ONTs de un puerto.
 *
 * DEJA SIN SERVICIO a todos los abonados de ese puerto por uno o dos minutos.
 * Por eso pide confirmación explícita en el cuerpo: un POST suelto no alcanza
 * para algo que se nota en las casas de la gente.
 */
router.post(
  '/:id/pon-ports/:slot/:puerto/reiniciar',
  conOlt,
  asyncHandler(async (req, res) => {
    if (req.body?.confirmar !== true) {
      throw badRequest('Falta la confirmación explícita', {
        hint: 'Mandá { "confirmar": true }. Esto corta el servicio de todos los abonados del puerto.',
      })
    }

    res.json(
      await olts.reiniciarOnts(req.equipo, {
        slot: Number.parseInt(req.params.slot, 10),
        puerto: Number.parseInt(req.params.puerto, 10),
        ontId: req.body?.ontId ?? null,
        // Le avisa a la ONT antes de tirarla. Se puede desactivar, pero el
        // valor por defecto es el que corresponde cuando del otro lado hay
        // alguien mirando una película.
        graceful: req.body?.graceful !== false,
      }),
    )
  }),
)

/** Puertos PON. Con ?slot=N pregunta por una sola placa. */
router.get(
  '/:id/pon-ports',
  conOlt,
  asyncHandler(async (req, res) => {
    const slot = req.query.slot != null ? Number.parseInt(req.query.slot, 10) : undefined
    res.json({ tarjetas: await olts.leerPuertosPon(req.equipo, { slot }) })
  }),
)

/**
 * Le pregunta al equipo qué comandos de un área entiende, y devuelve la salida
 * cruda.
 *
 * Es el paso previo a escribir un parser, no un reemplazo. Escribir parsers
 * contra la documentación en vez de contra la salida real es exactamente lo que
 * ya costó horas en este proyecto.
 */
router.post(
  '/:id/relevar/:area',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await ficha.relevarArea(req.equipo, req.params.area))
  }),
)

/** Qué áreas se pueden relevar y con qué comandos candidatos. */
router.get(
  '/areas',
  asyncHandler(async (_req, res) => {
    res.json({
      areas: Object.entries(ficha.AREAS).map(([clave, a]) => ({
        clave,
        titulo: a.titulo,
        ayuda: a.ayuda,
        comandos: a.comandos,
      })),
    })
  }),
)

/**
 * ONTs conectadas a la fibra que todavía nadie autorizó.
 *
 * Se barren solo los slots donde ya hay ONUs registradas, sacados de la base.
 * Barrer los dieciséis slots posibles de un chasis serían más de doscientos
 * comandos por la CLI para mirar dos placas que son las únicas con fibra.
 *
 * Va bajo demanda y no en cada carga del tablero: son varios comandos contra el
 * equipo y consumen su sesión.
 */
router.get(
  '/:id/esperando',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await ficha.esperandoAutorizacion(req.equipo))
  }),
)

/**
 * Relee del equipo la ficha de TODAS las ONUs de esta OLT.
 *
 * Arranca y contesta enseguida: son varios minutos. El avance se consulta en
 * /resync-masivo/estado.
 *
 * Solo lee. No se le manda ningún comando de escritura a ninguna ONT.
 */
router.post(
  '/:id/resync-masivo',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await resync.arrancarResync(req.equipo.id, { todas: req.body?.todas === true }))
  }),
)

/**
 * Cajas NAP candidatas, cruzando puerto, dirección y distancia.
 *
 * Son PROPUESTAS para revisar. El sistema no puede saber de qué caja cuelga un
 * abonado —los splitters son pasivos— así que cada grupo viene con la evidencia
 * a la vista y con qué tan creíble es.
 */
router.get(
  '/:id/naps/proponer',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(
      await naps.proponerCajas(req.equipo.id, {
        saltoMetros: Number(req.query.salto) || undefined,
      }),
    )
  }),
)

/** Crea una caja y le cuelga los abonados elegidos. */
router.post(
  '/:id/naps',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await naps.crearCaja(req.equipo.id, req.body ?? {}))
  }),
)

/**
 * Los perfiles de línea y de servicio que tiene cargados el equipo.
 *
 * Existe aparte de /autorizar/datos porque el editor de plantillas los necesita
 * sin tener todavía ninguna ONT en la mano.
 */
router.get(
  '/:id/perfiles',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await olts.listarPerfilesOnt(req.equipo))
  }),
)

/**
 * Carga una ONT que todavía no está conectada, para que se autorice sola cuando
 * el técnico la conecte.
 *
 * Va con `:id` porque los perfiles de la plantilla se resuelven contra ESTA OLT:
 * el perfil 2 de una no es el perfil 2 de otra.
 */
router.post(
  '/:id/preautorizar',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await preaut.cargarPreautorizada(req.equipo, req.body ?? {}))
  }),
)

/**
 * Ficha de una ONT que todavía nadie autorizó: quién es, desde cuándo está y si
 * ya figura en una orden de instalación o en otra OLT.
 */
router.get(
  '/:id/esperando/:sn',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await ficha.detalleEsperando(req.equipo, req.params.sn))
  }),
)

/**
 * Vuelve a preguntarle al equipo por UNA ONT de la cola.
 *
 * Es POST y no GET porque puede sacarla de la cola: si el equipo ya no la ve,
 * se borra la fila en vez de dejar esperando algo que no existe.
 */
router.post(
  '/:id/esperando/:sn/resync',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await ficha.resincronizarEsperando(req.equipo, req.params.sn))
  }),
)

/**
 * Todo lo necesario para llenar el formulario de autorización: la orden de
 * instalación que coincide con esa serie, los perfiles del equipo, los planes y
 * qué proponer en cada campo.
 */
router.get(
  '/:id/autorizar/datos',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await ficha.datosAutorizacion(req.equipo, req.query.sn))
  }),
)

/**
 * Autoriza la ONT: la registra y le crea su service-port.
 *
 * Escribe en la OLT de producción y le da servicio a un abonado real.
 */
router.post(
  '/:id/autorizar',
  conOlt,
  asyncHandler(async (req, res) => {
    res.status(201).json(await ficha.autorizarOnt(req.equipo, req.body ?? {}))
  }),
)

// --- Operaciones sobre una ONT instalada ------------------------------------

/**
 * Cambia el plan de una ONT.
 *
 * No corta el servicio: se modifican las traffic-tables de sus service-ports
 * existentes en vez de rehacerlos.
 */
router.post(
  '/:id/onus/:onuId/plan',
  conOlt,
  asyncHandler(async (req, res) => {
    const planId = req.body?.plan_id
    if (!planId) throw badRequest('Falta plan_id')
    res.json(await ficha.cambiarPlan(req.equipo, { onuId: req.params.onuId, planId }))
  }),
)

/**
 * Suspende o reactiva una ONT.
 *
 * Es lo que corresponde para un corte por falta de pago: la configuración queda
 * intacta y vuelve con un comando.
 */
router.post(
  '/:id/onus/:onuId/suspender',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(
      await ficha.suspenderOnt(req.equipo, {
        onuId: req.params.onuId,
        activar: req.body?.activar === true,
      }),
    )
  }),
)

/**
 * Mueve una ONT a otro puerto PON.
 *
 * Es borrar y recrear: el abonado queda sin servicio unos segundos, y si algo
 * falla en el medio queda sin servicio y sin configuración. La respuesta trae
 * siempre la foto de cómo estaba, para poder rehacerla a mano.
 */
/**
 * Ficha completa de una ONU: lo guardado y lo que dice el equipo ahora.
 *
 * Los dos bloques van separados a propósito. Mezclados sería imposible
 * contestar la pregunta que importa cuando algo no cuadra: ¿esto lo tiene
 * configurado el equipo, o es lo que nosotros creemos que tiene?
 */
router.get(
  '/:id/onus/:onuId/ficha',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await ficha.fichaOnu(req.equipo, req.params.onuId))
  }),
)

/**
 * Relee del equipo lo que tenemos guardado de esta ONU y lo actualiza.
 *
 * Solo LEE del equipo: corrige nuestra copia. No confundir con /reprovisionar,
 * que sí le escribe a la ONT.
 */
router.post(
  '/:id/onus/:onuId/actualizar-ficha',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await ficha.actualizarFichaOnu(req.equipo, req.params.onuId))
  }),
)

/**
 * Le vuelve a ENVIAR la configuración a la ONT.
 *
 * Para cuando la configuración por TR069 no se aplicó: la ONT está online, el
 * sistema dice que está todo bien y el abonado no tiene servicio.
 *
 * Escribe en el equipo y corta el servicio unos segundos, por eso pide
 * confirmación.
 */
/** Cómo sale a internet esta ONT, y los perfiles de WAN que tiene la OLT. */
router.get(
  '/:id/onus/:onuId/wan',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await ficha.leerWanOnu(req.equipo, req.params.onuId))
  }),
)

/**
 * Configura —o saca— la WAN de una ONT.
 *
 * Pide confirmación porque cambia por dónde sale a internet el abonado: una ONT
 * que pasa de puente a enrutada deja de entregar la IP que entregaba.
 */
router.post(
  '/:id/onus/:onuId/wan',
  conOlt,
  asyncHandler(async (req, res) => {
    if (req.body?.confirmar !== true) {
      throw badRequest('Falta confirmar', {
        hint: 'Cambia cómo sale a internet el abonado y puede dejarlo sin servicio.',
      })
    }
    res.json(
      await ficha.configurarWanOnu(req.equipo, req.params.onuId, {
        sacar: req.body?.sacar === true,
        ipIndex: req.body?.ip_index == null ? 1 : Number(req.body.ip_index),
        profileId: req.body?.profile_id == null ? null : Number(req.body.profile_id),
        perfil: req.body?.perfil ?? null,
      }),
    )
  }),
)

/**
 * La WAN de la ONT tal como la reporta por TR-069, y el pedido de cambiarla.
 *
 * ── Por qué es una ruta aparte de `/wan` ──
 *
 * `/wan` configura el PERFIL de la OLT —modo enrutado o puente, y NAT—, por
 * SSH. Esto escribe adentro del equipo, por GenieACS: el usuario de PPPoE, la
 * IP fija, o el DHCP. Son dos transportes distintos y mezclarlos escondería
 * cuál de los dos falló.
 */
router.post(
  '/:id/onus/:onuId/wan/tr069',
  conOlt,
  asyncHandler(async (req, res) => {
    if (req.body?.confirmar !== true) {
      throw badRequest('Falta confirmar', {
        hint: 'Cambia cómo sale a internet el abonado y puede dejarlo sin servicio.',
      })
    }
    const { modo, usuario, clave, ip, mascara, puerta, dns, vlan } = req.body ?? {}
    res.json(
      await ficha.configurarWanTr069Onu(req.equipo, req.params.onuId, {
        modo,
        usuario,
        clave,
        ip,
        mascara,
        puerta,
        dns,
        vlan: vlan == null ? null : Number(vlan),
      }),
    )
  }),
)

/**
 * La gestión remota de una ONT: perfil TR-069 y su IP de gestión.
 *
 * ── Por qué los dos en la misma llamada ──
 *
 * Porque no sirven por separado. Un perfil TR-069 apuntando a un ACS no hace
 * nada si la ONT no tiene una IP con la que llegar hasta él, y una IP de
 * gestión sin perfil deja a la ONT alcanzable y sin nadie que la configure.
 *
 * Ponerlos en dos botones distintos garantiza que alguien haga la mitad y se
 * vaya creyendo que terminó — que es exactamente el estado en el que se
 * descubre el problema tres semanas después.
 *
 * Cada mitad es opcional: se puede cambiar solo el perfil, o solo la IP.
 */
router.post(
  '/:id/onus/:onuId/gestion',
  conOlt,
  asyncHandler(async (req, res) => {
    const { profile_id, modo, ip, vlan, mascara, gateway, dns1, dns2 } = req.body ?? {}
    if (profile_id == null && !ip && modo !== 'dhcp' && modo !== 'inactive') {
      throw badRequest('No se indicó nada que cambiar', {
        hint: 'Elegí un perfil TR-069, un modo de IP de gestión (estática, DHCP o inactiva), o las dos cosas.',
      })
    }
    res.json(
      await ficha.configurarGestionOnu(req.equipo, req.params.onuId, {
        profileId: profile_id ?? null,
        modo: modo ?? null,
        ip: ip ?? null,
        vlan: vlan == null ? null : Number(vlan),
        mascara: mascara ?? null,
        gateway: gateway ?? null,
        dns1: dns1 ?? null,
        dns2: dns2 ?? null,
      }),
    )
  }),
)

/**
 * Cambia los perfiles de una ONT ya autorizada.
 *
 * Escribe en el equipo y la ONT se reaprovisiona: unos segundos sin servicio.
 * Por eso pide confirmación, igual que el re-registro.
 */
router.post(
  '/:id/onus/:onuId/perfiles',
  conOlt,
  asyncHandler(async (req, res) => {
    if (req.body?.confirmar !== true) {
      throw badRequest('Falta confirmar', {
        hint: 'La ONT se reaprovisiona y el abonado pierde el servicio unos segundos.',
      })
    }

    const srv = req.body?.srv_profile_id
    const line = req.body?.line_profile_id
    if (srv == null && line == null) {
      throw badRequest('No se indicó ningún perfil', {
        hint: 'Elegí el de servicio, el de línea, o los dos.',
      })
    }

    res.json(
      await ficha.cambiarPerfilesOnu(req.equipo, req.params.onuId, {
        srvProfileId: srv == null ? null : Number(srv),
        lineProfileId: line == null ? null : Number(line),
      }),
    )
  }),
)

router.post(
  '/:id/onus/:onuId/reprovisionar',
  conOlt,
  asyncHandler(async (req, res) => {
    if (req.body?.confirmar !== true) {
      throw badRequest('Falta confirmar', {
        hint: 'La ONT se reasocia y el abonado pierde el servicio unos segundos.',
      })
    }
    res.json(await ficha.reprovisionarOnu(req.equipo, req.params.onuId))
  }),
)

/**
 * Devuelve la ONT a fábrica.
 *
 * Borra el wifi y todo lo que haya configurado el abonado adentro del equipo.
 * El internet vuelve solo; su wifi no.
 */
router.post(
  '/:id/onus/:onuId/restaurar-fabrica',
  conOlt,
  asyncHandler(async (req, res) => {
    if (req.body?.confirmar !== true) {
      throw badRequest('Falta confirmar', {
        hint: 'Se pierde el nombre y la clave del wifi del abonado, y todo lo que haya configurado.',
      })
    }
    res.json(
      await ficha.restaurarFabricaOnu(req.equipo, req.params.onuId, {
        completamente: req.body?.completamente === true,
      }),
    )
  }),
)

/** La configuración que el equipo tiene en ejecución para esta ONT. */
router.get(
  '/:id/onus/:onuId/config-activa',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await ficha.configActivaOnu(req.equipo, req.params.onuId))
  }),
)

/**
 * Los puertos de adentro de la ONT: ethernet de la casa y teléfono.
 *
 * Es lo primero que hay que mirar ante un "no me anda internet" con la fibra
 * perfecta.
 */
router.get(
  '/:id/onus/:onuId/puertos',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await ficha.puertosOnu(req.equipo, req.params.onuId))
  }),
)

/** Modelo exacto, firmware y fabricante, leídos en vivo. */
router.get(
  '/:id/onus/:onuId/software',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await ficha.softwareOnu(req.equipo, req.params.onuId))
  }),
)

/**
 * Velocidad en vivo del abonado.
 *
 * Se consulta repetidamente desde la pantalla: la primera respuesta no trae
 * Mbps porque el equipo informa bytes acumulados y hacen falta dos lecturas
 * para poder restar.
 */
router.get(
  '/:id/onus/:onuId/trafico',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await trafico.traficoOnu(req.equipo, req.params.onuId))
  }),
)

/**
 * Reinicia UNA ONT. Deja al abonado sin servicio un par de minutos.
 *
 * Exige `confirmar` igual que el reinicio masivo: el equipo no pregunta nada y
 * el corte lo nota una persona del otro lado.
 */
router.post(
  '/:id/onus/:onuId/reiniciar',
  conOlt,
  asyncHandler(async (req, res) => {
    if (req.body?.confirmar !== true) {
      throw badRequest('Falta confirmar el reinicio', {
        hint: 'Deja al abonado sin servicio un par de minutos. Mandá confirmar: true.',
      })
    }
    res.json(await ficha.reiniciarOnu(req.equipo, req.params.onuId))
  }),
)

router.post(
  '/:id/onus/:onuId/mover',
  conOlt,
  asyncHandler(async (req, res) => {
    if (req.body?.confirmar !== true) {
      throw badRequest('Falta la confirmación explícita', {
        hint: 'Mandá { "confirmar": true }. Mover una ONT la borra y la recrea: corta el servicio.',
      })
    }

    res.json(
      await ficha.moverOnt(req.equipo, {
        onuId: req.params.onuId,
        nuevoSlot: req.body?.slot,
        nuevoPuerto: req.body?.puerto,
      }),
    )
  }),
)

/**
 * La configuración completa de una ONT tal como está en el equipo.
 *
 * Sirve para mirar antes de mover, y como respaldo puntual de un abonado.
 */
router.get(
  '/:id/onus/:onuId/config',
  conOlt,
  asyncHandler(async (req, res) => {
    const { data } = await db()
      .from('onus')
      .select('frame, slot, puerto, onu_index')
      .eq('id', req.params.onuId)
      .eq('olt_id', req.equipo.id)
      .maybeSingle()

    if (!data) throw badRequest('Esa ONU no existe en esta OLT')

    res.json(
      await olts.leerConfigCompletaOnt(req.equipo, {
        frame: data.frame ?? 0,
        slot: data.slot,
        puerto: data.puerto,
        ontId: data.onu_index,
      }),
    )
  }),
)

/**
 * Da de baja una ONT: la borra del equipo y de la base.
 *
 * IRREVERSIBLE del lado del equipo. Pide confirmación explícita — para un corte
 * temporal lo que corresponde es suspenderla.
 */
router.delete(
  '/:id/onus/:onuId/baja',
  conOlt,
  asyncHandler(async (req, res) => {
    if (req.query.confirmar !== 'true') {
      throw badRequest('Falta la confirmación explícita', {
        hint: 'Agregá ?confirmar=true. Para un corte temporal usá suspender, que es reversible.',
      })
    }
    res.json(await ficha.darDeBajaOnt(req.equipo, { onuId: req.params.onuId }))
  }),
)

// --- SNMP: lectura masiva ---------------------------------------------------

/**
 * Le pregunta la comunidad SNMP al propio equipo y la guarda cifrada.
 *
 * Nunca devuelve el valor: solo cuántos caracteres tiene, que alcanza para
 * confirmar que se guardó algo. Va del equipo a la base sin pasar por ninguna
 * pantalla.
 */
router.post(
  '/:id/snmp/detectar',
  conOlt,
  asyncHandler(async (req, res) => {
    const escritura = req.body?.escritura === true
    res.json(await ficha.detectarComunidad(req.equipo, { escritura }))
  }),
)

/**
 * Potencia óptica de TODAS las ONTs de la OLT, de una sola vez.
 *
 * Es la razón de ser de SNMP acá: por CLI habría que abrir una conversación por
 * abonado, y con mil ONTs eso no termina nunca ni deja sesiones libres para
 * nadie más.
 *
 * Con `?guardar=1` además actualiza las ONUs que ya estén en la base. Las que
 * el equipo tiene y la base no, se devuelven igual y se cuentan aparte: son las
 * que se dieron de alta por la CLI y nunca se importaron.
 */
router.get(
  '/:id/potencias',
  conOlt,
  asyncHandler(async (req, res) => {
    // `completo` agrega temperatura, voltaje y corriente del láser. Cuesta
    // cinco recorridos en vez de uno: con mil ONTs son seis minutos contra uno.
    const completo = req.query.completo === '1' || req.query.completo === 'true'
    const guardar = req.query.guardar === '1' || req.query.guardar === 'true'

    // Guardar y no guardar son dos caminos distintos a propósito: mirar la
    // óptica sin escribir nada tiene que seguir siendo posible.
    if (guardar) {
      return res.json(await optica.leerYGuardar(req.equipo, { completo }))
    }

    const lectura = await ficha.leerPotencias(req.equipo, { completo })
    const conAlerta = lectura.onts.filter((o) => o.rx_dbm != null && o.rx_dbm < UMBRAL_RX_DBM)

    res.json({
      ...lectura,
      umbral_dbm: UMBRAL_RX_DBM,
      con_alerta: conAlerta.length,
      alertas: conAlerta.map((o) => ({
        slot: o.slot,
        puerto: o.puerto,
        ont: o.ontId,
        rx_dbm: o.rx_dbm,
      })),
    })
  }),
)


/**
 * Trae las ONTs del equipo a la base.
 *
 * En GET es una vista previa que no escribe nada: dice qué se va a insertar, qué
 * cambió de puerto y qué hay en la base que el equipo ya no tiene. En POST lo
 * aplica.
 *
 * Lo que NUNCA hace, ni siquiera en POST, es borrar. Una ONT que hoy no aparece
 * puede ser un abonado que desenchufó el equipo, y con la fila se iría su ficha
 * entera. Se informan para que decida una persona.
 */
router.get(
  '/:id/inventario',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await ficha.importarOnus(req.equipo, { aplicar: false }))
  }),
)

router.post(
  '/:id/inventario',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await ficha.importarOnus(req.equipo, { aplicar: true }))
  }),
)

/**
 * Enlaza las ONTs con sus abonados.
 *
 * GET es vista previa. POST aplica, y `crear: true` además da de alta las fichas
 * que faltan — es una decisión aparte porque enlazar es reversible y crear
 * ochenta abonados no lo es.
 *
 * Lo ambiguo nunca se resuelve solo. Elegir entre dos homónimos significa que la
 * señal de uno aparece en la ficha del otro y que un corte le cae al vecino.
 */
router.get(
  '/:id/abonados',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await ficha.emparejarAbonados(req.equipo, { aplicar: false }))
  }),
)

router.post(
  '/:id/abonados',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(
      await ficha.emparejarAbonados(req.equipo, {
        aplicar: true,
        crear: req.body?.crear === true,
      }),
    )
  }),
)

// --- Historial y respaldos --------------------------------------------------

router.get(
  '/:id/historial',
  asyncHandler(async (req, res) => {
    const { data, error } = await db()
      .from('olt_historial')
      .select('*')
      .eq('olt_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(Number.parseInt(req.query.limite, 10) || 200)

    if (error) throw badRequest(`No se pudo leer el historial: ${error.message}`)
    res.json({ eventos: data ?? [] })
  }),
)

router.get(
  '/:id/backups',
  asyncHandler(async (req, res) => {
    // Sin `contenido`: son decenas de KB por fila y el listado solo necesita
    // saber qué respaldos hay.
    const { data, error } = await db()
      .from('olt_backups')
      .select('id, nombre, comando, quien, bytes, created_at')
      .eq('olt_id', req.params.id)
      .order('created_at', { ascending: false })

    if (error) throw badRequest(`No se pudieron leer los respaldos: ${error.message}`)
    res.json({ backups: data ?? [] })
  }),
)

/** Baja la configuración del equipo y la guarda. */
router.post(
  '/:id/backups',
  conOlt,
  asyncHandler(async (req, res) => {
    const resultado = await ficha.respaldarConfig(req.equipo, {
      quien: req.usuario?.email ?? null,
      nombre: req.body?.nombre ?? null,
    })
    res.status(201).json(resultado)
  }),
)

router.get(
  '/:id/backups/:backupId',
  asyncHandler(async (req, res) => {
    const { data, error } = await db()
      .from('olt_backups')
      .select('*')
      .eq('id', req.params.backupId)
      .eq('olt_id', req.params.id)
      .maybeSingle()

    if (error) throw badRequest(`No se pudo leer el respaldo: ${error.message}`)
    if (!data) throw badRequest('Ese respaldo no existe')
    res.json(data)
  }),
)

router.delete(
  '/:id/backups/:backupId',
  asyncHandler(async (req, res) => {
    const { error } = await db()
      .from('olt_backups')
      .delete()
      .eq('id', req.params.backupId)
      .eq('olt_id', req.params.id)

    if (error) throw badRequest(`No se pudo borrar el respaldo: ${error.message}`)
    res.json({ ok: true })
  }),
)

// NOTA: no hay endpoint para revelar contraseñas, y es a propósito.
//
// crypto.routes.js cifra en un solo sentido: el navegador puede guardar una
// credencial pero nunca leerla de vuelta. Agregar el inverso significaría que
// cualquiera con una sesión válida —una laptop abierta, un técnico con acceso al
// sistema, un token copiado— se lleva las claves de todas las OLTs y entra por
// SSH a tirar el servicio. La ficha muestra si el campo está cargado o vacío,
// que es lo que hace falta para operar, y nada más.

// --- Descubrimiento ---------------------------------------------------------

router.get(
  '/:id/onus',
  conOlt,
  asyncHandler(async (req, res) => {
    const { frame, slot, puerto } = ubicacion(req)
    if (puerto == null) throw badRequest('Falta el parámetro puerto')
    res.json(await olts.listarOnus(req.equipo, { frame, slot, puerto }))
  }),
)

/** ONUs detectadas y sin registrar. Sin `puerto` barre todos los puertos del slot. */
router.get(
  '/:id/autofind',
  conOlt,
  asyncHandler(async (req, res) => {
    const { frame, slot, puerto } = ubicacion(req)
    if (puerto == null) {
      const puertos = Number.parseInt(req.query.puertos, 10) || 8
      return res.json(await olts.escanearAutofind(req.equipo, { frame, slot, puertos }))
    }
    res.json(await olts.listarAutofind(req.equipo, { frame, slot, puerto }))
  }),
)

// --- Aprovisionamiento ------------------------------------------------------

/**
 * Registra la ONU en la OLT y, si sale bien, la guarda en Supabase.
 *
 * El orden importa: primero el equipo, después la base. Si la OLT rechaza el
 * registro no queremos una fila fantasma en Supabase que no existe en la fibra.
 */
router.post(
  '/:id/onus',
  conOlt,
  asyncHandler(async (req, res) => {
    const { frame, slot, puerto, onuId } = ubicacion(req)
    const { sn, nombre_cliente, descripcion, tipo_ont_id, line_profile_id, plan_id, lineProfile } =
      req.body ?? {}

    if (puerto == null) throw badRequest('Falta el puerto PON')

    const resultado = await olts.registrarOnu(req.equipo, {
      frame,
      slot,
      puerto,
      onuId,
      sn,
      descripcion: descripcion ?? nombre_cliente,
      lineProfile,
    })

    // V-SOL confirma la cola de auto-find y no devuelve un ONT-ID puntual, así que
    // solo persistimos cuando sabemos exactamente qué ONU quedó registrada.
    let fila = null
    if (sn) {
      let plan_velocidad = null
      if (plan_id) {
        const { data } = await db()
          .from('planes_velocidad')
          .select('nombre')
          .eq('id', plan_id)
          .maybeSingle()
        plan_velocidad = data?.nombre ?? null
      }

      const { data, error } = await db()
        .from('onus')
        .upsert(
          {
            olt_id: req.equipo.id,
            sn: sn.toUpperCase(),
            nombre_cliente: nombre_cliente ?? null,
            frame,
            slot,
            puerto,
            onu_index: resultado.ontId ?? onuId ?? 0,
            tipo_ont_id: tipo_ont_id ?? null,
            line_profile_id: line_profile_id ?? null,
            plan_id: plan_id ?? null,
            plan_velocidad,
            estado: 'offline',
          },
          { onConflict: 'olt_id,sn' },
        )
        .select()
        .single()

      if (error) {
        // La ONU YA quedó registrada en la OLT. Devolver un error seco haría pensar
        // que no se hizo nada, así que se reporta el éxito parcial.
        return res.status(207).json({
          ok: true,
          registradaEnOlt: resultado,
          guardadaEnBase: false,
          error: `La ONU quedó registrada en la OLT pero no se pudo guardar en la base: ${error.message}`,
        })
      }
      fila = data
    }

    res.status(201).json({ ok: true, registradaEnOlt: resultado, guardadaEnBase: Boolean(fila), onu: fila })
  }),
)

/** Asigna VLAN/servicio a una ONU ya registrada (secuencia tcont/gemport/service-port). */
router.post(
  '/:id/onus/servicio',
  conOlt,
  asyncHandler(async (req, res) => {
    const { puerto, onuId } = ubicacion(req)
    const { vlan, tcontId, gemportId, servicePortId } = req.body ?? {}
    res.json(
      await olts.configurarServicio(req.equipo, {
        puerto,
        onuId,
        vlan,
        tcontId,
        gemportId,
        servicePortId,
      }),
    )
  }),
)

/** Elimina la ONU de la OLT y, si estaba, la borra de Supabase. */
router.delete(
  '/:id/onus/:onuId',
  conOlt,
  asyncHandler(async (req, res) => {
    const { frame, slot, puerto } = ubicacion(req)
    const onuId = Number.parseInt(req.params.onuId, 10)
    if (puerto == null) throw badRequest('Falta el puerto PON')

    const resultado = await olts.eliminarOnu(req.equipo, { frame, slot, puerto, onuId })

    await db()
      .from('onus')
      .delete()
      .eq('olt_id', req.equipo.id)
      .eq('puerto', puerto)
      .eq('onu_index', onuId)

    res.json({ ok: true, ...resultado })
  }),
)

// --- Telemetría (Fase 4) ----------------------------------------------------

/**
 * Lectura óptica en vivo. Cachea el resultado en la fila de la ONU para que el
 * Dashboard pueda mostrar el último valor conocido sin volver a golpear la OLT.
 */
router.get(
  '/:id/onus/:onuId/metricas',
  conOlt,
  asyncHandler(async (req, res) => {
    const { frame, slot, puerto } = ubicacion(req)
    const onuId = Number.parseInt(req.params.onuId, 10)
    if (puerto == null) throw badRequest('Falta el parámetro puerto')

    const metricas = await olts.leerMetricas(req.equipo, { frame, slot, puerto, onuId })

    const rx = metricas.rxPowerDbm ?? null
    const alerta = rx != null && rx < UMBRAL_RX_DBM

    // Se guarda también cuando está caída: saber POR QUÉ se cayó es lo que
    // decide si hay que mandar un técnico a la fibra o llamar al abonado a
    // preguntarle si tiene luz.
    const cambios = {
      causa_caida: metricas.causa ?? null,
      causa_caida_cruda: metricas.causaCruda ?? null,
      ultima_caida: metricas.ultimaCaida ?? null,
      ultima_lectura: new Date().toISOString(),
    }

    if (metricas.online) {
      Object.assign(cambios, {
        estado: 'online',
        rx_power_dbm: rx,
        tx_power_dbm: metricas.txPowerDbm ?? null,
        // Lo que la OLT recibe DESDE la ONT. Es el otro sentido del enlace y se
        // leía en cada medición sin tener dónde guardarse: sin él, un láser
        // flojo del lado del abonado solo se ve yendo al domicilio.
        olt_rx_power_dbm: metricas.olrRxPowerDbm ?? null,
        temperatura_c: metricas.temperaturaC ?? null,
        distancia_m: metricas.distanciaM ?? null,
      })
    } else {
      // La causa manda sobre el estado: sin ella solo se sabe que no responde.
      cambios.estado =
        metricas.causa === 'power_off' ? 'power_off' : metricas.causa === 'los' ? 'los' : 'offline'
    }

    await db()
      .from('onus')
      .update(cambios)
      .eq('olt_id', req.equipo.id)
      .eq('puerto', puerto)
      .eq('onu_index', onuId)

    res.json({
      ...metricas,
      umbralDbm: UMBRAL_RX_DBM,
      alerta,
      ...(alerta
        ? { mensajeAlerta: `Señal baja: ${rx} dBm está por debajo de ${UMBRAL_RX_DBM} dBm` }
        : {}),
    })
  }),
)

// --- Perfiles y planes ------------------------------------------------------

/** Crea el line profile en la OLT y lo guarda en Supabase. */
router.post(
  '/:id/line-profiles',
  conOlt,
  asyncHandler(async (req, res) => {
    const { nombre, vlan, gemport = 1, profile_id_olt } = req.body ?? {}
    if (!nombre || !vlan) throw badRequest('Faltan nombre o vlan')

    const resultado = await olts.crearLineProfile(req.equipo, { nombre, vlan, gemport })

    const { data, error } = await db()
      .from('line_profiles')
      .upsert(
        {
          olt_id: req.equipo.id,
          nombre,
          vlan_id: Number(vlan),
          gemport_id: Number(gemport),
          profile_id_olt: Number(profile_id_olt ?? vlan),
        },
        { onConflict: 'olt_id,nombre' },
      )
      .select()
      .single()

    if (error) {
      return res.status(207).json({
        ok: true,
        creadoEnOlt: resultado,
        guardadoEnBase: false,
        error: `El perfil se creó en la OLT pero no se pudo guardar en la base: ${error.message}`,
      })
    }

    res.status(201).json({ ok: true, creadoEnOlt: resultado, lineProfile: data })
  }),
)

/**
 * Aplica un plan de velocidad de la base como traffic table en la OLT.
 * cir = subida garantizada, pir = bajada máxima (así se cargó en el taller).
 */
router.post(
  '/:id/traffic-tables',
  conOlt,
  asyncHandler(async (req, res) => {
    const { plan_id, index, priority = 6 } = req.body ?? {}
    if (!plan_id) throw badRequest('Falta plan_id')

    const { data: plan, error } = await db()
      .from('planes_velocidad')
      .select('*')
      .eq('id', plan_id)
      .maybeSingle()
    if (error) throw badRequest(`No se pudo leer el plan: ${error.message}`)
    if (!plan) throw badRequest(`No existe el plan ${plan_id}`)

    const indiceFinal = index ?? plan.traffic_table_index
    if (indiceFinal == null) {
      throw badRequest('El plan no tiene traffic_table_index y no se pasó index')
    }

    const resultado = await olts.crearTrafficTable(req.equipo, {
      index: indiceFinal,
      nombre: plan.nombre,
      cir: plan.subida_kbps,
      pir: plan.bajada_kbps,
      priority,
    })

    if (plan.traffic_table_index !== indiceFinal) {
      await db()
        .from('planes_velocidad')
        .update({ traffic_table_index: indiceFinal })
        .eq('id', plan.id)
    }

    res.status(201).json({ ok: true, ...resultado, plan: plan.nombre })
  }),
)

// --- TR-069 -----------------------------------------------------------------
//
// Todo lo de acá le pregunta al equipo en vivo. No hay copia en la base a
// propósito: el perfil TR-069 se puede cambiar desde la consola de la OLT, y una
// pantalla que muestre nuestra copia diría "apunta a GenieACS" sobre una ONT que
// alguien mudó a mano hace un mes.

/** Perfiles, ONT apuntadas y ONT con IP de gestión. */
router.get(
  '/:id/tr069',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json(await olts.resumenTr069(req.equipo))
  }),
)

/**
 * Los perfiles TR-069 de esta OLT, y nada más.
 *
 * ── Por qué existe además de `/:id/tr069` ──
 *
 * Aquel devuelve el resumen completo —perfiles, cuántas ONTs tiene cada uno,
 * cuántas tienen IP de gestión— y para eso corre TRES `display
 * current-configuration | include ...`, que en un Huawei recorren la
 * configuración entera. Medido contra un MA5800-X7: 15 segundos.
 *
 * Para llenar un desplegable hace falta una sola de esas consultas. El resumen
 * sigue estando para la pantalla que lo necesita.
 */
router.get(
  '/:id/tr069/perfiles',
  conOlt,
  asyncHandler(async (req, res) => {
    res.json({ perfiles: await olts.listarPerfilesTr069(req.equipo) })
  }),
)

/**
 * Crea un perfil TR-069.
 *
 * Pide permiso de escritura como cualquier cambio en el equipo: un perfil mal
 * hecho no rompe nada solo, pero apuntar ONTs a él las manda a hablar con un
 * servidor que no existe.
 */
router.post(
  '/:id/tr069/perfiles',
  conOlt,
  asyncHandler(async (req, res) => {
    res.status(201).json(await olts.crearPerfilTr069(req.equipo, req.body ?? {}))
  }),
)

/** El estado TR-069 de una ONT puntual, leído del equipo. */
router.get(
  '/:id/tr069/ont',
  conOlt,
  asyncHandler(async (req, res) => {
    const { frame, slot, puerto, onuId } = ubicacion(req)
    if (puerto == null || onuId == null) {
      throw badRequest('Hacen falta el puerto y el ONT-ID')
    }
    res.json(await olts.leerTr069DeOnt(req.equipo, { frame, slot, puerto, ontId: onuId }))
  }),
)

/**
 * Apunta una ONT a otro perfil.
 *
 * Una ONT habla con un ACS a la vez: esto la saca del anterior. La respuesta
 * trae `perfilAnterior` justamente para poder deshacerlo sin depender de que
 * alguien se haya anotado de dónde venía.
 */
router.post(
  '/:id/tr069/ont',
  conOlt,
  asyncHandler(async (req, res) => {
    const { frame, slot, puerto, onuId } = ubicacion(req)
    const { profileId } = req.body ?? {}
    if (puerto == null || onuId == null) {
      throw badRequest('Hacen falta el puerto y el ONT-ID')
    }
    res.json(
      await olts.asignarPerfilTr069(req.equipo, {
        frame,
        slot,
        puerto,
        ontId: onuId,
        profileId,
      }),
    )
  }),
)

// --- Escotilla de escape ----------------------------------------------------

/** Ejecuta comandos crudos. Útil en el taller para probar antes de codificar. */
router.post(
  '/:id/cli',
  conOlt,
  asyncHandler(async (req, res) => {
    const { comandos } = req.body ?? {}
    if (!Array.isArray(comandos) || comandos.length === 0) {
      throw badRequest('Mandá un array "comandos" con al menos un comando')
    }
    res.json({ resultados: await olts.ejecutarCrudo(req.equipo, comandos) })
  }),
)

export default router
