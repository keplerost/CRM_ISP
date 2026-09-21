import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Guardar y verificar contraseñas.
 *
 * scrypt, que viene en Node y no necesita instalar nada. Está diseñado para ser
 * LENTO y para castigar el hardware especializado: si esta base se filtra, cada
 * intento de adivinar una contraseña le cuesta al atacante lo mismo que a
 * nosotros verificar una — que es exactamente lo que hace inviable probar
 * millones.
 *
 * Nunca un hash simple. sha256 de una contraseña se rompe con una tabla
 * precalculada; el sueldo de una tarde de GPU alcanza para todas las
 * contraseñas comunes que existen.
 */

// El costo. 2^15 tarda unos 100 ms: imperceptible al entrar, carísimo al
// intentar un millón de veces.
const COSTO = 32768
const LARGO = 32

/**
 * Cuánta memoria se le permite usar.
 *
 * scrypt con N=32768 y r=8 necesita 128·N·r = 32 MB exactos, y el tope por
 * defecto de Node es justo 32 MB: se pasa por un byte y falla con un error que
 * no dice nada útil ("memory limit exceeded"). Se le da el doble.
 *
 * Ese uso de memoria no es un costo: es el punto. Es lo que impide atacar la
 * base con miles de GPUs en paralelo, porque cada intento necesita su propia
 * memoria.
 */
const MEMORIA = 64 * 1024 * 1024

export function hashear(clave) {
  const sal = randomBytes(16).toString('hex')
  const hash = scryptSync(String(clave), sal, LARGO, {
    N: COSTO,
    r: 8,
    p: 1,
    maxmem: MEMORIA,
  }).toString('hex')
  return `scrypt$${COSTO}$${sal}$${hash}`
}

/**
 * ¿Coincide?
 *
 * La comparación es de tiempo constante: comparar con === va terminando apenas
 * encuentra una diferencia, y esa diferencia de microsegundos alcanza para
 * adivinar el hash carácter por carácter.
 */
export function verificar(clave, guardado) {
  if (!guardado || !clave) return false

  const [algo, costo, sal, hash] = String(guardado).split('$')
  if (algo !== 'scrypt' || !sal || !hash) return false

  try {
    const calculado = scryptSync(String(clave), sal, hash.length / 2, {
      N: Number(costo),
      r: 8,
      p: 1,
      maxmem: MEMORIA,
    })
    const esperado = Buffer.from(hash, 'hex')
    return calculado.length === esperado.length && timingSafeEqual(calculado, esperado)
  } catch {
    return false
  }
}

/**
 * Una contraseña para entregarle a un cliente nuevo.
 *
 * Sin caracteres que se confundan al dictarla por teléfono: ni l, ni I, ni 1,
 * ni O, ni 0. Es la diferencia entre "no me funciona" y que entre a la primera.
 */
const LEGIBLES = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'

export function claveLegible(largo = 10) {
  const bytes = randomBytes(largo)
  return Array.from(bytes, (b) => LEGIBLES[b % LEGIBLES.length]).join('')
}

/**
 * Lo mínimo que se le exige a una contraseña elegida por el usuario.
 *
 * Solo largo. Las reglas de "una mayúscula, un número y un símbolo" producen
 * Password1! en todas las cuentas del mundo: una contraseña larga y fácil de
 * recordar es mejor que una corta y retorcida que termina en un papel pegado al
 * monitor.
 */
export function revisarClave(clave) {
  const c = String(clave ?? '')
  if (c.length < 8) return 'La contraseña tiene que tener al menos 8 caracteres.'
  if (c.length > 200) return 'Esa contraseña es demasiado larga.'
  return null
}
