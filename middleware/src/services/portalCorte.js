import { readFileSync } from 'node:fs'

import { config } from '../config.js'
import { badRequest } from '../lib/errors.js'
import { MARCA, comentario, esNuestra } from '../lib/marcaReglas.js'
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
 * ── Las tres del aviso previo, solo si el router tiene `lista_aviso` ──
 *
 *   avisoRedireccion  dstnat: el HTTP del que está por vencer va a la página
 *   avisoVisto        dstnat accept: el que tocó "Entendido" navega libre unas
 *                     horas. Va delante de avisoRedireccion
 *   avisoSinNat       srcnat accept hacia la página, por lo mismo que portalSinNat
 *
 * El del aviso todavía tiene servicio: no hace falta ningún permiso en forward.
 *
 * Hay un orden más, y es el que no se ve. `avisoVisto` es un accept del puerto
 * 80 para una lista que dura horas: si al abonado se lo corta en ese rato y esa
 * regla está delante de la redirección del corte, el accept le gana y el
 * cortado no ve su página. Por eso la del corte va siempre delante de avisoVisto.
 *
 * ── Lo que queda fuera del router ──
 *
 * El servidor tiene que poder contestarle al abonado. Si el router llega por el
 * túnel, eso es una ruta de vuelta a la red de los abonados por ese túnel (el
 * `iroute` de OpenVPN). Eso no se puede hacer desde la API del router.
 */

/**
 * La lista de los que ya vieron el aviso. Es nuestra y no del router: nadie más
 * escribe en ella, y cada entrada se borra sola con su timeout.
 */
export const LISTA_AVISO_VISTO = `${MARCA}-aviso-visto`

const PRIVADA_TUNEL =/^10\.66\.(\d{1,3})\.(\d{1,3})$/
const ENV_TUNEL = '/etc/openvpn/smartolt.env'

const aEntero = (ip) => {
  const o = String(ip).split('.').map(Number)
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]
}

/**
 * La red del túnel, como la dejó `openvpn-server.sh` en este mismo VPS.
 *
 * Se lee en cada consulta y no una vez al arrancar: `cambiar-red-vpn.sh` la
 * puede cambiar con el middleware andando. Si el archivo no está —desarrollo,
 * u otro servidor—, null.
 */
export function leerTunel(texto) {
  let contenido = texto
  if (contenido == null) {
    try {
      contenido = readFileSync(ENV_TUNEL, 'utf8')
    } catch {
      return null
    }
  }
  const v = Object.fromEntries(
    contenido
      .split(/\r?\n/)
      .map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => [m[1], m[2].trim()]),
  )
  if (!v.RED_VPN) return null
  const prefijo = Number(v.PREFIJO) || 24
  const red = aEntero(v.RED_VPN)
  if (red == null) return null
  const ipVps = v.IP_VPS || v.RED_VPN.replace(/\.\d+$/, (x) => `.${Number(x.slice(1)) + 1}`)
  return { red, prefijo, ipVps }
}

/**
 * A qué dirección mandar al cortado de este router.
 *
 * Lo configurado gana. Si no hay nada y el router está en la red del túnel de
 * este VPS, es la IP del VPS en ese túnel. Sin el archivo del túnel, se cae a
 * la regla de siempre (10.66.x.y → 10.66.x.1). Deducir en cualquier otra red
 * sería adivinar, y una redirección a una IP equivocada falla sin que nadie se
 * entere hasta que llama un abonado.
 */
export function destinoSugerido(router, configurado = config.portalCorteDestino, tunel = leerTunel()) {
  if (configurado) return configurado
  const ip = String(router?.ip_host ?? '').trim()

  if (tunel) {
    const n = aEntero(ip)
    const mascara = (0xffffffff << (32 - tunel.prefijo)) >>> 0
    if (n != null && ((n & mascara) >>> 0) === ((tunel.red & mascara) >>> 0) && ip !== tunel.ipVps) {
      return tunel.ipVps
    }
  }

  const m = PRIVADA_TUNEL.exec(ip)
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
export function camposDe(clave, { destino, puerto, lista, listaAviso }) {
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
    case 'avisoRedireccion':
      return {
        chain: 'dstnat',
        protocol: 'tcp',
        'dst-port': '80',
        'src-address-list': listaAviso,
        action: 'dst-nat',
        'to-addresses': destino,
        'to-ports': String(puerto),
        comment: comentario('avisoRedireccion'),
      }
    case 'avisoVisto':
      // Solo el 80: es lo único que avisoRedireccion le toma. Un accept más
      // amplio saltearía cualquier otra regla de dstnat que tenga el router.
      return {
        chain: 'dstnat',
        protocol: 'tcp',
        'dst-port': '80',
        'src-address-list': LISTA_AVISO_VISTO,
        action: 'accept',
        comment: comentario('avisoVisto'),
      }
    case 'avisoSinNat':
      return {
        chain: 'srcnat',
        'src-address-list': listaAviso,
        'dst-address': destino,
        action: 'accept',
        comment: comentario('avisoSinNat'),
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
  avisoRedireccion: ['to-addresses', 'to-ports', 'src-address-list'],
  avisoVisto: ['src-address-list', 'dst-port'],
  avisoSinNat: ['dst-address', 'src-address-list'],
}

const SIN_NAT = ['portalSinNat', 'avisoSinNat']

/**
 * Qué hay que hacer, sin tocar nada.
 *
 * Devuelve una acción por pieza: 'ok', 'crear', 'corregir' (está pero apunta a
 * otro lado) o 'mover' (está pero detrás del drop o del masquerade, donde no
 * sirve de nada). El orden de la lista es el orden en que hay que aplicarlas.
 */
export function planear({ filter = [], nat = [], destino, puerto = config.portalCorte, lista, listaAviso = null }) {
  const valores = { destino, puerto, lista, listaAviso }
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
  // masquerade, y en srcnat gana el que está más arriba. Las dos excepciones
  // nuestras no cuentan: si cada una se anclara en la otra, se moverían
  // alternadamente en cada pasada sin terminar nunca.
  const primerSrcnat = () =>
    nat.find((r) => r.chain === 'srcnat' && !SIN_NAT.some((c) => esNuestra(r.comment, c))) ?? null
  const nuestraNat = (clave) => nat.find((r) => esNuestra(r.comment, clave)) ?? null

  // Con aviso previo, la redirección del corte va delante del "ya lo vio".
  evaluar('redireccion', 'nat', nat, listaAviso ? () => nuestraNat('avisoVisto') : null)
  evaluar('portalSinNat', 'nat', nat, primerSrcnat)
  evaluar('portalPagina', 'filter', filter, () => reglaDelCorte(filter, lista))
  evaluar('portalDns', 'filter', filter, () => reglaDelCorte(filter, lista))

  if (listaAviso) {
    /**
     * La redirección del aviso, delante de la de otro sistema.
     *
     * Un router que viene de WispHub ya redirige su lista de aviso a su propio
     * proxy. Si la nuestra queda detrás, el abonado ve el aviso de ellos —y el
     * día que ese sistema se apaga, una página que no carga—.
     */
    const avisoAjeno = () =>
      nat.find(
        (r) =>
          encendida(r) &&
          r.chain === 'dstnat' &&
          ['redirect', 'dst-nat'].includes(r.action) &&
          mismaLista(r['src-address-list'], listaAviso) &&
          !esNuestra(r.comment, 'avisoRedireccion'),
      ) ?? null

    evaluar('avisoRedireccion', 'nat', nat, avisoAjeno)
    evaluar('avisoVisto', 'nat', nat, () => nuestraNat('avisoRedireccion'))
    evaluar('avisoSinNat', 'nat', nat, primerSrcnat)
  }

  return acciones
}

const TITULOS = {
  redireccion: 'redirección al puerto de la página',
  portalPagina: 'permiso para llegar a la página',
  portalDns: 'permiso de DNS',
  portalSinNat: 'excepción al masquerade',
  avisoRedireccion: 'redirección del aviso previo',
  avisoVisto: 'pausa del aviso para el que ya lo vio',
  avisoSinNat: 'excepción al masquerade del aviso',
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
export async function aplicar(equipo, { destino, puerto = config.portalCorte, lista, listaAviso = null }) {
  // La confusión más natural: en el campo "IP del servidor" se pone la del
  // router, que es la que uno tiene a mano. El router se redirige a sí mismo y
  // el cortado ve una página que no carga, sin ningún error en ningún lado.
  if (String(destino).trim() === String(equipo?.ip_host ?? '').trim()) {
    const sugerido = destinoSugerido(equipo)
    throw badRequest(`${destino} es la IP del propio router, no la del servidor.`, {
      hint: sugerido
        ? `La del servidor, vista desde este router, es ${sugerido}.`
        : 'Va la dirección donde este router alcanza al servidor del sistema.',
    })
  }

  /**
   * Una acción por vez, volviendo a leer el router entre una y otra.
   *
   * Algunas piezas se anclan en otras que todavía no existen: el "ya lo vio" va
   * delante de la redirección del aviso, y la del corte delante del "ya lo vio".
   * Planeado de una sola vez, la pieza nueva no tiene `.id` todavía y la que se
   * ancla en ella quedaría al final de la cadena, donde no sirve.
   *
   * El tope es por si dos reglas se disputaran el mismo lugar: mejor cortar y
   * decirlo que dejar al router moviendo reglas sin fin.
   */
  const hechas = []
  for (let vuelta = 0; ; vuelta++) {
    const [filter, nat] = await Promise.all([mt.listarReglasFilter(equipo), mt.listarReglasNat(equipo)])
    const a = planear({ filter: filter ?? [], nat: nat ?? [], destino, puerto, lista, listaAviso }).find(
      (x) => x.accion !== 'ok',
    )
    if (!a) break
    if (vuelta >= 15) {
      throw new Error(`Las reglas no terminan de acomodarse: sigue pendiente ${TITULOS[a.clave]}.`)
    }

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

  // Dicho siempre: "ya estaba todo" sin esto se lee como que el aviso también
  // quedó puesto, cuando ni se miró.
  const sobreAviso = listaAviso
    ? ` Aviso previo con la lista ${listaAviso}.`
    : ' Sin lista de aviso previo: ese aviso no se configuró.'

  return {
    cambio: hechas.length > 0,
    mensaje: hechas.length
      ? `Hecho: ${hechas.map((a) => `${a.accion} ${TITULOS[a.clave]}`).join(' · ')}. Destino ${destino}:${puerto}.${sobreAviso}`
      : `Ya estaba todo, apuntando a ${destino}:${puerto}.${sobreAviso}`,
  }
}
