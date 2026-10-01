import { config } from '../config.js'
import { comentario, esNuestra } from '../lib/marcaReglas.js'
import * as mt from './mikrotikService.js'

/**
 * Lo que el router necesita para que el cortado VEA su página.
 *
 * ── Por qué no alcanzaba con la redirección ──
 *
 * La regla de corte es un `drop` en forward sobre la lista de morosos, y se
 * aplica DESPUÉS del dst-nat. Así que el pedido redirigido a la página también
 * se descartaba: la redirección existía, y el abonado veía "no se puede acceder
 * a este sitio" igual que sin ella. Lo mismo con el DNS: sin resolver nombres,
 * el navegador ni siquiera llega a pedir una página que se pueda redirigir.
 *
 * Y había un tercer problema, más escondido. La página reconoce al abonado por
 * la IP de origen —es lo único que el abonado no puede falsificar—. Pero el
 * masquerade del router se la cambia por la suya antes de que salga, y la
 * página contestaba siempre la versión genérica, sin saldo ni nombre.
 *
 * ── Las cuatro piezas ──
 *
 *   redireccion   dstnat: el HTTP del moroso va al puerto de la página
 *   portalPagina  forward accept hacia la página, antes del drop del corte
 *   portalDns     forward accept del DNS, antes del drop del corte
 *   portalSinNat  srcnat accept hacia la página, antes de cualquier masquerade
 *
 * ── Lo que queda fuera del router ──
 *
 * El servidor tiene que poder contestarle al abonado. Si el router llega por el
 * túnel, eso es una ruta de vuelta a la red de los abonados por ese túnel (el
 * `iroute` de OpenVPN). Eso no se puede hacer desde la API del router.
 */

const PRIVADA_TUNEL = /^10\.66\.(\d{1,3})\.(\d{1,3})$/

/**
 * A qué dirección mandar al cortado de este router.
 *
 * Lo configurado gana. Si no hay nada, se deduce solo para los routers del
 * túnel de `openvpn-server.sh` (10.66.x.y), donde el servidor es siempre el .1:
 * deducir en cualquier otra red privada sería adivinar, y una redirección a una
 * IP equivocada falla sin que nadie se entere hasta que llama un abonado.
 */
export function destinoSugerido(router, configurado = config.portalCorteDestino) {
  if (configurado) return configurado
  const m = PRIVADA_TUNEL.exec(String(router?.ip_host ?? '').trim())
  if (!m || m[2] === '1') return null
  return `10.66.${m[1]}.1`
}

const encendida = (r) => String(r?.disabled ?? 'false') !== 'true'
const mismaLista = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()

/**
 * La regla que corta: el primer drop/reject de forward sobre la lista.
 *
 * No solo la nuestra: un router adoptado de MikroWisp corta con la suya, y los
 * permisos tienen que ir delante de la que de verdad descarta el tráfico.
 */
export function reglaDelCorte(filter = [], lista) {
  return (
    filter.find(
      (r) =>
        encendida(r) &&
        r.chain === 'forward' &&
        ['drop', 'reject'].includes(r.action) &&
        mismaLista(r['src-address-list'], lista),
    ) ?? null
  )
}

/** Lo que debería tener cada regla. El comentario es lo que la identifica después. */
export function camposDe(clave, { destino, puerto, lista }) {
  switch (clave) {
    case 'redireccion':
      return {
        chain: 'dstnat',
        protocol: 'tcp',
        'dst-port': '80',
        'src-address-list': lista,
        action: 'dst-nat',
        'to-addresses': destino,
        'to-ports': String(puerto),
        comment: comentario('redireccion'),
      }
    case 'portalPagina':
      return {
        chain: 'forward',
        protocol: 'tcp',
        'src-address-list': lista,
        'dst-address': destino,
        'dst-port': String(puerto),
        action: 'accept',
        comment: comentario('portalPagina'),
      }
    case 'portalDns':
      return {
        chain: 'forward',
        protocol: 'udp',
        'src-address-list': lista,
        'dst-port': '53',
        action: 'accept',
        comment: comentario('portalDns'),
      }
    case 'portalSinNat':
      return {
        chain: 'srcnat',
        'src-address-list': lista,
        'dst-address': destino,
        action: 'accept',
        comment: comentario('portalSinNat'),
      }
    default:
      throw new Error(`Pieza desconocida: ${clave}`)
  }
}

/** Los campos que, si difieren, hacen que la regla no sirva. */
const CLAVE_DE = {
  redireccion: ['to-addresses', 'to-ports', 'src-address-list'],
  portalPagina: ['dst-address', 'dst-port', 'src-address-list'],
  portalDns: ['src-address-list'],
  portalSinNat: ['dst-address', 'src-address-list'],
}

/**
 * Qué hay que hacer, sin tocar nada.
 *
 * Devuelve una acción por pieza: 'ok', 'crear', 'corregir' (está pero apunta a
 * otro lado) o 'mover' (está pero detrás del drop o del masquerade, donde no
 * sirve de nada). El orden de la lista es el orden en que hay que aplicarlas.
 */
export function planear({ filter = [], nat = [], destino, puerto = config.portalCorte, lista }) {
  const valores = { destino, puerto, lista }
  const acciones = []

  const evaluar = (clave, tipo, reglas, anclaFn) => {
    const deseada = camposDe(clave, valores)
    const idx = reglas.findIndex((r) => esNuestra(r.comment, clave))
    const actual = idx >= 0 ? reglas[idx] : null
    const ancla = anclaFn ? anclaFn() : null
    const idxAncla = ancla ? reglas.indexOf(ancla) : -1

    if (!actual) {
      acciones.push({ clave, tipo, accion: 'crear', campos: deseada, antesDe: ancla?.['.id'] ?? null })
      return
    }

    const distintos = CLAVE_DE[clave].filter((c) => String(actual[c] ?? '') !== String(deseada[c] ?? ''))
    if (distintos.length || !encendida(actual)) {
      const campos = Object.fromEntries(distintos.map((c) => [c, deseada[c]]))
      if (!encendida(actual)) campos.disabled = 'no'
      acciones.push({ clave, tipo, accion: 'corregir', id: actual['.id'], campos, distintos })
    }

    // Detrás del ancla no hace nada: el drop o el masquerade la ganan primero.
    if (idxAncla >= 0 && idx > idxAncla) {
      acciones.push({ clave, tipo, accion: 'mover', id: actual['.id'], antesDe: ancla['.id'] })
      return
    }

    if (!acciones.some((a) => a.clave === clave)) acciones.push({ clave, tipo, accion: 'ok' })
  }

  // El primer srcnat de la lista: el accept tiene que ganarle a cualquier
  // masquerade, y en srcnat gana el que está más arriba.
  const primerSrcnat = () =>
    nat.find((r) => r.chain === 'srcnat' && !esNuestra(r.comment, 'portalSinNat')) ?? null

  evaluar('redireccion', 'nat', nat, null)
  evaluar('portalSinNat', 'nat', nat, primerSrcnat)
  evaluar('portalPagina', 'filter', filter, () => reglaDelCorte(filter, lista))
  evaluar('portalDns', 'filter', filter, () => reglaDelCorte(filter, lista))

  return acciones
}

const TITULOS = {
  redireccion: 'redirección al puerto de la página',
  portalPagina: 'permiso para llegar a la página',
  portalDns: 'permiso de DNS',
  portalSinNat: 'excepción al masquerade',
}

/** Una línea legible de lo que falta, para la pantalla de revisión. */
export function resumir(acciones) {
  const pendientes = acciones.filter((a) => a.accion !== 'ok')
  if (!pendientes.length) return null
  return pendientes
    .map((a) => {
      const que = TITULOS[a.clave]
      if (a.accion === 'crear') return `falta ${que}`
      if (a.accion === 'mover') return `${que} está detrás del corte`
      return `${que} apunta a otro lado`
    })
    .join(' · ')
}

/** Lee el router, planea y aplica. Devuelve qué se hizo. */
export async function aplicar(equipo, { destino, puerto = config.portalCorte, lista }) {
  const [filter, nat] = await Promise.all([mt.listarReglasFilter(equipo), mt.listarReglasNat(equipo)])
  const acciones = planear({ filter: filter ?? [], nat: nat ?? [], destino, puerto, lista })

  const hechas = []
  for (const a of acciones) {
    if (a.accion === 'ok') continue
    if (a.accion === 'crear') {
      const campos = a.antesDe ? { ...a.campos, 'place-before': a.antesDe } : a.campos
      await mt.agregarRegla(equipo, { tipo: a.tipo, campos })
    } else if (a.accion === 'corregir') {
      await mt.editarRegla(equipo, { tipo: a.tipo, id: a.id, campos: a.campos })
    } else if (a.accion === 'mover') {
      await mt.moverRegla(equipo, { tipo: a.tipo, id: a.id, antesDe: a.antesDe })
    }
    hechas.push(a)
  }

  return {
    cambio: hechas.length > 0,
    mensaje: hechas.length
      ? `Hecho: ${hechas.map((a) => `${a.accion} ${TITULOS[a.clave]}`).join(' · ')}. Destino ${destino}:${puerto}.`
      : `Ya estaba todo, apuntando a ${destino}:${puerto}.`,
  }
}
