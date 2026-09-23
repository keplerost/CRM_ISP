import { cargarRouter } from '../lib/db.js'
import { badRequest } from '../lib/errors.js'
import * as mt from './mikrotikService.js'
import { esNuestra } from '../lib/marcaReglas.js'

/**
 * Dejar un router recién dado de alta listo para operar.
 *
 * ── Qué problema resuelve ──
 *
 * Cargar un MikroTik en el sistema no alcanza para que el sistema pueda hacer
 * su trabajo. Hace falta, además, que el equipo tenga la regla que corta a los
 * morosos, su equivalente en IPv6, la redirección a la página de aviso y —lo
 * que más cuesta descubrir— que su servicio de API acepte conexiones desde la
 * red por donde le hablamos.
 *
 * Todo eso se hacía a mano, pegando comandos en la terminal del router. En la
 * puesta en marcha del primer equipo del piloto llevó media tarde, y dos de los
 * errores fueron de tipeo en esos comandos.
 *
 * ── Por qué revisar y aplicar están separados ──
 *
 * Es el mismo patrón que `repararRouter`: primero se mira y se informa, después
 * se cambia. En un router con abonados, "mostrame qué vas a hacer" no es una
 * cortesía — es la diferencia entre un botón que se puede apretar tranquilo y
 * uno que da miedo.
 *
 * ── Lo que NO hace ──
 *
 * No levanta la VPN. El túnel tiene que existir antes: sin él no hay forma de
 * llegar al equipo para configurarlo. Eso se hace con los scripts de `deploy/`.
 */

/**
 * Las reglas se reconocen por su comentario y no por su contenido: el operador
 * puede haberle cambiado la cadena o el orden y seguiría siendo la nuestra.
 *
 * Quién decide si un comentario es nuestro vive en `lib/marcaReglas.js`, que es
 * también el que sabe reconocer la firma vieja. Tener acá una copia de esas
 * cadenas fue una mala idea que duró un día: al renombrar la marca, esta
 * pantalla habría seguido buscando las viejas y habría informado "falta" sobre
 * reglas que estaban puestas.
 */
const CLAVES_V6 = ['corteV6Salida', 'corteV6Entrada']

const PRIVADAS = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./]

/**
 * De qué red le hablamos a este router.
 *
 * Se deduce de su propia dirección: si lo alcanzamos en 10.66.0.11, la red de
 * gestión es 10.66.0.0/24. Es cierto en toda instalación armada con
 * `openvpn-server.sh`, que reparte un /24.
 *
 * Solo se deduce para direcciones privadas. Un router con IP pública no está
 * detrás de un túnel, y restringir su API a "la /24 de su propia IP pública"
 * sería a la vez inútil y peligroso.
 */
export function redDeGestion(router, red) {
  if (red) {
    if (!/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(red)) {
      throw badRequest(`"${red}" no es una red válida. Va como 10.66.0.0/24.`)
    }
    return red
  }

  const ip = String(router?.ip_host ?? '')
  if (!PRIVADAS.some((r) => r.test(ip))) return null

  const octetos = ip.split('.')
  if (octetos.length !== 4) return null
  return `${octetos[0]}.${octetos[1]}.${octetos[2]}.0/24`
}

const paso = (clave, titulo, estado, detalle, extra = {}) => ({
  clave,
  titulo,
  estado, // 'ok' | 'falta' | 'atencion' | 'no-aplica' | 'error'
  detalle,
  ...extra,
})

/** Qué le falta a este router, sin tocar nada. */
export async function revisar(routerId, { red } = {}) {
  const equipo = await cargarRouter(routerId)
  const redGestion = redDeGestion(equipo, red)

  const [conexion, filter, nat, api, ipv6] = await Promise.allSettled([
    mt.probarConexion(equipo),
    mt.listarReglasFilter(equipo),
    mt.listarReglasNat(equipo),
    mt.leerServicioApi(equipo),
    equipo.ipv6_activo ? mt.listarReglasFilterIpv6(equipo) : Promise.resolve(null),
  ])

  // Sin conexión no tiene sentido informar lo demás: todo aparecería como
  // "falta" y el operador saldría a arreglar cosas que quizá ya estaban.
  if (conexion.status === 'rejected') {
    throw conexion.reason
  }

  const pasos = []

  pasos.push(
    paso(
      'conexion',
      'Conexión con el equipo',
      'ok',
      `${conexion.value.identidad ?? 'sin nombre'} · RouterOS ${conexion.value.version ?? '?'}` +
        `${conexion.value.modelo ? ` · ${conexion.value.modelo}` : ''}`,
    ),
  )

  // ── La regla de corte ──
  const reglas = filter.status === 'fulfilled' ? (filter.value ?? []) : []
  const lista = equipo.lista_morosos || mt.LISTA_MOROSOS
  pasos.push(
    reglas.some((r) => esNuestra(r.comment, 'corte'))
      ? paso('corte_v4', 'Regla de corte por mora', 'ok', `Ya existe, sobre la lista "${lista}"`)
      : paso(
          'corte_v4',
          'Regla de corte por mora',
          'falta',
          `Sin ella, marcar a un abonado como moroso no le corta nada: la lista "${lista}" se llena y el tráfico sigue pasando.`,
        ),
  )

  // ── El corte en IPv6 ──
  if (!equipo.ipv6_activo) {
    pasos.push(
      paso('corte_v6', 'Corte en IPv6', 'no-aplica', 'Este router no tiene IPv6 activo en el sistema'),
    )
  } else if (ipv6.status === 'rejected') {
    pasos.push(paso('corte_v6', 'Corte en IPv6', 'error', 'No se pudo leer el firewall IPv6'))
  } else {
    const v6 = ipv6.value ?? []
    const faltan = CLAVES_V6.filter((clave) => !v6.some((r) => esNuestra(r.comment, clave)))
    pasos.push(
      faltan.length
        ? paso(
            'corte_v6',
            'Corte en IPv6',
            'falta',
            `Faltan ${faltan.length} de 2 reglas. Un cortado solo en IPv4 sigue navegando: Google, YouTube y Netflix responden por IPv6.`,
          )
        : paso('corte_v6', 'Corte en IPv6', 'ok', 'Las dos reglas ya existen'),
    )
  }

  // ── La API, desde dónde contesta ──
  const datosApi = api.status === 'fulfilled' ? api.value : null
  if (!datosApi?.encontrado) {
    pasos.push(
      paso('api', 'API restringida a la red de gestión', 'error', 'No se encontró el servicio de API en el equipo'),
    )
  } else if (!redGestion) {
    pasos.push(
      paso(
        'api',
        'API restringida a la red de gestión',
        'no-aplica',
        `Este router se alcanza en ${equipo.ip_host}, que no es una dirección privada: no está detrás de un túnel y no hay una red de gestión que agregar.`,
        { redes: datosApi.redes },
      ),
    )
  } else if (!datosApi.redes.length) {
    pasos.push(
      paso(
        'api',
        'API restringida a la red de gestión',
        'atencion',
        `Hoy la API responde a CUALQUIER origen. Agregar ${redGestion} no suma un permiso: deja afuera a todos los demás. Si algún otro sistema administra este router, antes hay que saber desde qué redes entra.`,
        { red: redGestion, redes: [], requiereConfirmacion: true },
      ),
    )
  } else if (datosApi.redes.includes(redGestion)) {
    pasos.push(
      paso('api', 'API restringida a la red de gestión', 'ok', `${redGestion} ya está permitida`, {
        red: redGestion,
        redes: datosApi.redes,
      }),
    )
  } else {
    pasos.push(
      paso(
        'api',
        'API restringida a la red de gestión',
        'falta',
        `La API solo contesta a ${datosApi.redes.join(', ')}. Falta ${redGestion}, que es desde donde le habla el sistema.`,
        { red: redGestion, redes: datosApi.redes },
      ),
    )
  }

  // ── La página que ve el cortado ──
  const nats = nat.status === 'fulfilled' ? (nat.value ?? []) : []
  pasos.push(
    nats.some((r) => esNuestra(r.comment, 'redireccion'))
      ? paso('redireccion', 'Página de aviso al cortado', 'ok', 'La redirección ya existe')
      : paso(
          'redireccion',
          'Página de aviso al cortado',
          'falta',
          'Sin esto, el abonado cortado ve páginas que no cargan y llama por teléfono. Hace falta indicar a qué dirección se lo manda.',
          { requiereDestino: true },
        ),
  )

  return { router: { id: equipo.id, nombre: equipo.nombre, ip: equipo.ip_host }, redGestion, pasos }
}

/**
 * Aplica lo que falta.
 *
 * `pasos` acota qué se toca. Sin él se hace todo lo que esté en condiciones de
 * hacerse, que es lo habitual en un equipo nuevo.
 */
export async function configurar(routerId, { red, pasos, destinoAviso, forzarApi = false } = {}) {
  const equipo = await cargarRouter(routerId)
  const redGestion = redDeGestion(equipo, red)
  const quiere = (clave) => !pasos?.length || pasos.includes(clave)

  const hechos = []
  const registrar = async (clave, titulo, fn) => {
    if (!quiere(clave)) return
    try {
      hechos.push({ clave, titulo, ok: true, ...(await fn()) })
    } catch (err) {
      // Un paso que falla no detiene a los demás: son independientes, y dejar
      // el router a medio configurar sin decir qué se hizo es peor que seguir.
      hechos.push({ clave, titulo, ok: false, mensaje: err?.message ?? 'Falló' })
    }
  }

  await registrar('corte_v4', 'Regla de corte por mora', async () => {
    const r = await mt.asegurarReglaCorte(equipo, equipo.lista_morosos || undefined)
    return { mensaje: r.mensaje, cambio: r.creada }
  })

  if (equipo.ipv6_activo) {
    await registrar('corte_v6', 'Corte en IPv6', async () => {
      const r = await mt.asegurarReglaCorteIpv6(equipo, equipo.ipv6_lista_morosos || undefined)
      return { mensaje: r.mensaje, cambio: r.creadas > 0 }
    })
  }

  if (redGestion) {
    await registrar('api', 'API restringida a la red de gestión', async () => {
      const r = await mt.asegurarApiPermitida(equipo, { red: redGestion, forzar: forzarApi })

      if (r.estado === 'abierta') {
        return {
          ok: true,
          cambio: false,
          mensaje:
            'No se tocó: la API responde a cualquier origen y restringirla ahora dejaría afuera a lo que hoy la usa. Se aplica solo si se confirma.',
        }
      }
      if (r.estado === 'no-aplico') {
        // El `set` se aceptó pero la lista quedó igual. Es el caso que costó
        // media tarde en el piloto, así que se reporta como falla y no como
        // éxito: dar por bueno lo que no se verificó es el error original.
        return { ok: false, cambio: false, mensaje: 'El equipo aceptó el cambio pero la lista quedó igual' }
      }
      return {
        cambio: r.cambiada,
        mensaje:
          r.estado === 'ya-estaba'
            ? `${redGestion} ya estaba permitida`
            : `Permitida ${redGestion} (ahora: ${r.despues.join(', ')})`,
      }
    })
  }

  if (destinoAviso) {
    await registrar('redireccion', 'Página de aviso al cortado', async () => {
      const r = await mt.asegurarRedireccionPago(equipo, {
        destino: destinoAviso,
        lista: equipo.lista_morosos || undefined,
      })
      return { mensaje: r.mensaje, cambio: r.creada }
    })
  }

  return { hechos, redGestion }
}
