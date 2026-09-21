import { badRequest } from './errors.js'

/**
 * Aritmética de IPv4 para asignar direcciones libres.
 *
 * Vive aparte de las rutas porque es la parte del alta que no se puede probar
 * contra el equipo: si la cuenta se equivoca, el abonado sale con una IP que ya
 * tiene el vecino y los dos se quedan sin internet de forma intermitente. Es un
 * problema que aparece dos días después y cuesta horas encontrar.
 */

/** 10.0.0.1 → 167772161. Devuelve null si no es una IPv4 válida. */
export function aEntero(ip) {
  const partes = String(ip ?? '').trim().split('.')
  if (partes.length !== 4) return null

  let n = 0
  for (const p of partes) {
    if (!/^\d{1,3}$/.test(p)) return null
    const octeto = Number(p)
    if (octeto > 255) return null
    n = n * 256 + octeto
  }
  return n
}

/** 167772161 → "10.0.0.1" */
export const aIp = (n) =>
  [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')

/**
 * El rango utilizable de un CIDR.
 *
 * Se descartan la dirección de red y la de broadcast: dárselas a un abonado es
 * un ticket asegurado. En /31 y /32 no hay ninguna de las dos —son enlaces
 * punto a punto— y se devuelve el bloque entero.
 */
export function rangoDeCidr(cidr) {
  const [dir, bitsTexto] = String(cidr ?? '').trim().split('/')
  const base = aEntero(dir)
  const bits = Number(bitsTexto)

  if (base == null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw badRequest(`"${cidr}" no es una red válida. Se espera algo como 10.20.30.0/24.`)
  }

  const mascara = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  const red = (base & mascara) >>> 0
  const broadcast = (red | (~mascara >>> 0)) >>> 0

  if (bits >= 31) return { desde: red, hasta: broadcast }
  return { desde: red + 1, hasta: broadcast - 1 }
}

/**
 * Los rangos de un pool de RouterOS: "10.0.0.10-10.0.0.200,10.0.0.240-10.0.0.250".
 *
 * Acepta también una dirección suelta y un CIDR, que es como se escriben los
 * pools de una sola IP y los segmentos que se cargan a mano en la ficha.
 */
export function rangosDeTexto(texto) {
  const trozos = String(texto ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  if (!trozos.length) throw badRequest('No se indicó ningún rango de direcciones')

  return trozos.map((trozo) => {
    if (trozo.includes('/')) return rangoDeCidr(trozo)

    const [desde, hasta] = trozo.split('-').map((t) => t.trim())
    const a = aEntero(desde)
    const b = hasta ? aEntero(hasta) : a

    if (a == null || b == null || b < a) {
      throw badRequest(`"${trozo}" no es un rango de direcciones válido`)
    }
    return { desde: a, hasta: b }
  })
}

/**
 * La primera dirección de los rangos que no esté ocupada.
 *
 * `ocupadas` puede traer basura —comentarios del router, IPs con máscara, texto
 * vacío—: se filtra acá en vez de en cada llamador, porque cada fuente de
 * ocupación (la base, las leases, los secrets, las direcciones del router) trae
 * el dato en un formato distinto y todas terminan en la misma cuenta.
 */
export function primeraLibre(rangos, ocupadas = []) {
  const usadas = new Set()
  for (const o of ocupadas) {
    // "10.0.0.5/24" y "10.0.0.5" son la misma dirección ocupada.
    const n = aEntero(String(o ?? '').split('/')[0])
    if (n != null) usadas.add(n)
  }

  for (const { desde, hasta } of rangos) {
    for (let n = desde; n <= hasta; n++) {
      if (!usadas.has(n)) return { ip: aIp(n), entero: n }
    }
  }

  return null
}

/** Cuántas direcciones abarcan los rangos. Sirve para decir "quedan 12 de 240". */
export const totalDeRangos = (rangos) =>
  rangos.reduce((s, { desde, hasta }) => s + (hasta - desde + 1), 0)
