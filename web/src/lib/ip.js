/**
 * Aritmética de IPv4 para el navegador.
 *
 * ── Por qué está duplicada ──
 *
 * El middleware tiene su propia versión en `middleware/src/lib/ip.js`, más
 * completa —maneja pools de RouterOS y rangos sueltos—. No se puede importar
 * desde acá porque arrastra `errors.js`, que es del servidor.
 *
 * Lo que sigue son veinte líneas de aritmética pura: entra un CIDR, salen
 * números. Duplicar eso es preferible a que el formulario de alta dependa de
 * que el middleware esté vivo — y ya vimos que puede no estarlo.
 *
 * Si algún día hay que tocar la cuenta, son los dos archivos.
 */

/** 10.0.0.1 → 167772161. `null` si no es una IPv4 válida. */
export function aEntero(ip) {
  const partes = String(ip ?? '').trim().split('.')
  if (partes.length !== 4) return null

  let n = 0
  for (const p of partes) {
    if (!/^\d{1,3}$/.test(p)) return null
    const b = Number(p)
    if (b > 255) return null
    n = n * 256 + b
  }
  return n >>> 0
}

/** 167772161 → "10.0.0.1" */
export const aIp = (n) =>
  [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')

/**
 * Las direcciones utilizables de una red: sin la de red ni la de broadcast.
 *
 * Devuelve `null` en vez de lanzar: el CIDR sale de un desplegable, pero
 * mientras el usuario no eligió nada llega vacío, y eso no es un error.
 */
export function rangoDeCidr(cidr) {
  const [dir, bitsTexto] = String(cidr ?? '').trim().split('/')
  const base = aEntero(dir)
  const bits = Number(bitsTexto)

  if (base == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null

  const mascara = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  const red = (base & mascara) >>> 0
  const broadcast = (red | (~mascara >>> 0)) >>> 0

  // En /31 y /32 no hay direcciones de red ni de broadcast que reservar.
  if (bits >= 31) return { desde: red, hasta: broadcast }
  return { desde: red + 1, hasta: broadcast - 1 }
}

/** ¿Esta dirección cae adentro de esta red? */
export function perteneceA(ip, cidr) {
  const r = rangoDeCidr(cidr)
  const n = aEntero(ip)
  if (!r || n == null) return null
  return n >= r.desde && n <= r.hasta
}

/**
 * Las direcciones libres de una red.
 *
 * `tope` existe porque un /16 tiene sesenta y cinco mil direcciones y el
 * desplegable no puede dibujarlas: con las primeras que haya alcanza para
 * elegir, y para eso está también el botón que propone la siguiente.
 */
export function libresDe(cidr, ocupadas = [], tope = 250) {
  const r = rangoDeCidr(cidr)
  if (!r) return []

  const usadas = new Set()
  for (const o of ocupadas) {
    // "10.0.0.5/24" y "10.0.0.5" son la misma dirección ocupada.
    const n = aEntero(String(o ?? '').split('/')[0])
    if (n != null) usadas.add(n)
  }

  const libres = []
  for (let n = r.desde; n <= r.hasta && libres.length < tope; n++) {
    if (!usadas.has(n)) libres.push(aIp(n))
  }
  return libres
}
