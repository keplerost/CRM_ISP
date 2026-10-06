import test from 'node:test'
import assert from 'node:assert/strict'

import { aWhatsApp, enlaceLlamada, separarTelefonos } from '../../web/src/lib/telefono.js'

/**
 * Dos números en el mismo campo. Antes se juntaban todos los dígitos y
 * WhatsApp abría un chat con un número de veinte cifras que no existe.
 */
test('un número solo, escrito como sea', () => {
  for (const t of ['0990032123', '990032123', '+593 99 003 2123', '09-9003-2123', '593990032123']) {
    assert.equal(aWhatsApp(t), '593990032123', t)
  }
  assert.equal(aWhatsApp(''), null)
  assert.equal(aWhatsApp(null), null)
})

test('dos números en el campo: WhatsApp va al primer celular', () => {
  const casos = {
    '0991234567 / 0987654321': '593991234567',
    '0991234567, 0987654321': '593991234567',
    '0991234567 y 0987654321': '593991234567',
    '0991234567 0987654321': '593991234567',
    '0991234567-0987654321': '593991234567',
    '052345678 / 0987654321': '593987654321',
  }
  for (const [t, esperado] of Object.entries(casos)) assert.equal(aWhatsApp(t), esperado, t)
})

test('separa y marca cuál es celular', () => {
  assert.deepEqual(
    separarTelefonos('052345678 - 0991234567 / 0991234567').map((n) => [n.local, n.movil]),
    [['052345678', false], ['0991234567', true]],
  )
  assert.equal(enlaceLlamada('0991234567 / 0987654321'), 'tel:0991234567')
  assert.equal(enlaceLlamada(''), null)
})
