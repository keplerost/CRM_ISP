import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Guardar y verificar contraseñas de personas.
 *
 * Distinto de `crypto.js`, que cifra credenciales de equipos: aquellas hay que
 * poder recuperarlas para mandárselas a un MikroTik, y por eso van cifradas.
 * Una contraseña de persona NO se recupera nunca — se compara. Guardarla de
 * forma reversible sería poder leerla, y nadie debería poder.
 *
 * scrypt, que viene en Node. Está diseñado para ser lento y para necesitar
 * mucha memoria: si esta base se filtra, cada intento de adivinar le cuesta al
 * atacante lo mismo que a nosotros verificar uno, y eso es lo que hace
 * inviable probar millones con GPUs en paralelo.
 */

const COSTO = 32768
const LARGO = 32

// scrypt con N=32768 y r=8 necesita 128·N·r = 32 MB exactos, y el tope por
// defecto de Node es justo 32 MB: se pasa por un byte y falla con un error que
// no dice nada útil. Se le da el doble.
const MEMORIA = 64 * 1024 * 1024

export function hashearClave(clave) {
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
 * Comparación de tiempo constante: con `===` la comparación termina apenas
 * encuentra una diferencia, y esa demora distinta alcanza para ir adivinando.
 */
export function verificarClave(clave, guardado) {
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
 * Una contraseña que se pueda dictar por teléfono.
 *
 * ── Por qué este alfabeto ──
 *
 * Sin `l`, `1`, `I`, `0`, `O`, `5` ni `S`. Son los pares que se confunden al
 * leerlos en voz alta o al copiarlos de un papel, y cada confusión termina en
 * una llamada más. Todo en minúscula por lo mismo: "¿mayúscula o minúscula?"
 * es la otra pregunta que sobra.
 *
 * ── Por qué diez caracteres ──
 *
 * Porque esta clave se guarda en claro para poder dictarla, y lo que se guarda
 * en claro conviene que sea largo. Con este alfabeto, diez caracteres son unos
 * 49 bits: no se adivinan a mano ni por fuerza bruta contra el portal, que
 * además limita los intentos. Y `revisarClave` exige ocho como mínimo.
 *
 * `randomInt` y no `Math.random()`: esta clave abre la cuenta de una persona y
 * el generador de Math no es criptográfico.
 */
const ALFABETO = 'abcdefghjkmnpqrtuvwxyz23467889'

export function generarClaveLegible(largo = 10) {
  let clave = ''
  for (let i = 0; i < largo; i++) clave += ALFABETO[randomInt(ALFABETO.length)]
  return clave
}

/**
 * Lo mínimo que se le exige a una contraseña.
 *
 * Solo largo. Las reglas de "una mayúscula, un número y un símbolo" producen
 * Password1! en todas las cuentas del mundo, y encima empujan a anotarla. Una
 * contraseña larga y fácil de recordar es mejor que una corta y retorcida.
 */
export function revisarClave(clave) {
  const c = String(clave ?? '')
  if (c.length < 8) return 'La contraseña tiene que tener al menos 8 caracteres.'
  if (c.length > 200) return 'Esa contraseña es demasiado larga.'
  return null
}
