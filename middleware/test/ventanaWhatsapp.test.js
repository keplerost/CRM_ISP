import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizar, pideLaBaja } from '../src/services/ventanaWhatsapp.js'

/**
 * El webhook de WhatsApp.
 *
 * Dos piezas puras y las dos delicadas por el mismo motivo: se equivocan en
 * silencio. Un número mal normalizado no encuentra la ventana y el mensaje sale
 * como plantilla cuando podía ser texto —barato—. Una baja mal detectada apaga
 * los avisos de alguien que no la pidió, y ese se queda sin enterarse de que le
 * van a cortar el servicio —caro—.
 */

// --- El número ---------------------------------------------------------------

test('un número ecuatoriano se normaliza igual venga como venga', () => {
  // Las tres formas en que la misma gente escribe el mismo teléfono.
  assert.equal(normalizar('0991234567'), '593991234567')
  assert.equal(normalizar('+593991234567'), '593991234567')
  assert.equal(normalizar('593991234567'), '593991234567')
})

test('los símbolos y espacios no cambian el número', () => {
  assert.equal(normalizar('099 123 4567'), '593991234567')
  assert.equal(normalizar('(099) 123-4567'), '593991234567')
  assert.equal(normalizar('+593 99 123 4567'), '593991234567')
})

test('sin número no se inventa uno', () => {
  // Un `null` que se convirtiera en "593" abriría una ventana para un número
  // que no existe, y peor: la misma para todos los que lleguen vacíos.
  assert.equal(normalizar(null), null)
  assert.equal(normalizar(''), null)
  assert.equal(normalizar('   '), null)
  assert.equal(normalizar('sin teléfono'), null)
})

// --- La baja -----------------------------------------------------------------

test('las palabras de baja se reconocen', () => {
  for (const palabra of ['BAJA', 'baja', 'Stop', 'CANCELAR', 'dar de baja', 'no molestar']) {
    assert.equal(pideLaBaja(palabra), true, `debería reconocer "${palabra}"`)
  }
})

test('se reconocen con tildes, signos y espacios de más', () => {
  assert.equal(pideLaBaja('  BAJA.  '), true)
  assert.equal(pideLaBaja('¡Baja!'), true)
  assert.equal(pideLaBaja('dar  de   baja'), true)
  assert.equal(pideLaBaja('cancelar suscripción'), true)
})

test('una frase que CONTIENE la palabra no es una baja', () => {
  /**
   * Es el caso que hace que esta función compare el mensaje entero y no busque
   * la palabra adentro. Dar de baja a alguien por escribir esto es peor que no
   * tener la función: deja de recibir el aviso de corte y no entiende por qué.
   */
  const NO_SON_BAJA = [
    'me dieron de baja el servicio sin avisar',
    'no me molesta esperar, gracias',
    'quiero cancelar mi visita técnica de mañana',
    'la señal se me baja mucho a la noche',
    'stop me dijeron pero no entiendo',
  ]

  for (const frase of NO_SON_BAJA) {
    assert.equal(pideLaBaja(frase), false, `NO debería ser baja: "${frase}"`)
  }
})

test('un mensaje cualquiera no es una baja', () => {
  assert.equal(pideLaBaja('hola, no tengo internet'), false)
  assert.equal(pideLaBaja('ya pagué, les mando el comprobante'), false)
  assert.equal(pideLaBaja(''), false)
  assert.equal(pideLaBaja(null), false)
})
