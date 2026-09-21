import test from 'node:test'
import assert from 'node:assert/strict'

// La clave se lee del entorno al primer uso, así que hay que definirla antes de
// importar el módulo.
process.env.CREDENTIALS_KEY = 'frase-de-prueba-del-taller'
const { encrypt, decrypt } = await import('../src/lib/crypto.js')

test('el cifrado es reversible', () => {
  assert.equal(decrypt(encrypt('Admin123!')), 'Admin123!')
})

test('el ciphertext no contiene la contraseña en claro', () => {
  assert.ok(!encrypt('Admin123!').includes('Admin123!'))
})

test('dos cifrados de lo mismo dan distinto (IV aleatorio)', () => {
  assert.notEqual(encrypt('x'), encrypt('x'))
})

test('un payload manipulado no se descifra', () => {
  const valido = encrypt('secreto')
  const partes = valido.split(':')
  partes[3] = Buffer.from('otra cosa').toString('base64')
  assert.throws(() => decrypt(partes.join(':')), /No se pudo descifrar/)
})

test('un formato desconocido da un error claro', () => {
  assert.throws(() => decrypt('texto-plano-viejo'), /formato esperado/)
})
