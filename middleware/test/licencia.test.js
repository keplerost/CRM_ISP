import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { abrirToken } from '../src/services/licencia.js'

/**
 * La verificación de la licencia.
 *
 * Es lo único que separa a un cliente que paga de uno que no, así que se prueba
 * cada forma conocida de intentar saltearla. Todas tienen que fallar por el
 * mismo motivo: sin la clave privada del vendedor no se puede firmar nada.
 */

const par = generateKeyPairSync('ed25519')
const CLAVE = par.publicKey.export({ type: 'spki', format: 'pem' }).toString()

const b64url = (b) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Emite una licencia como lo haría el vendedor con su clave privada. */
function emitir(contenido, privada = par.privateKey) {
  const payload = b64url(JSON.stringify(contenido))
  return `${payload}.${b64url(sign(null, Buffer.from(payload), privada))}`
}

const CONTENIDO = {
  instalacion: '11111111-1111-1111-1111-111111111111',
  isp: 'Fibra del Valle',
  clientes_max: 500,
  vence: '2030-01-01T00:00:00.000Z',
}

test('una licencia firmada por el vendedor se abre y trae sus datos', () => {
  const r = abrirToken(emitir(CONTENIDO), { clavePublica: CLAVE })
  assert.equal(r.ok, true)
  assert.equal(r.contenido.clientes_max, 500)
  assert.equal(r.contenido.isp, 'Fibra del Valle')
})

test('sin licencia cargada no habilita', () => {
  assert.equal(abrirToken(null, { clavePublica: CLAVE }).ok, false)
  assert.equal(abrirToken('', { clavePublica: CLAVE }).ok, false)
})

test('un código inventado no habilita', () => {
  assert.equal(abrirToken('cualquier-cosa', { clavePublica: CLAVE }).ok, false)
  assert.equal(abrirToken('a.b', { clavePublica: CLAVE }).ok, false)
})

/**
 * El intento obvio: abrir la licencia, correr la fecha de vencimiento y volver
 * a armarla. La firma es del contenido original, así que deja de coincidir.
 */
test('correr la fecha de vencimiento a mano invalida la firma', () => {
  const original = emitir(CONTENIDO)
  const [payload, firma] = original.split('.')

  const editado = JSON.parse(Buffer.from(payload, 'base64url').toString())
  editado.vence = '2099-01-01T00:00:00.000Z'

  const falsificada = `${b64url(JSON.stringify(editado))}.${firma}`
  const r = abrirToken(falsificada, { clavePublica: CLAVE })

  assert.equal(r.ok, false)
  assert.match(r.motivo, /firma/i)
})

/** Lo mismo con el límite de abonados: pagar por 100 y usar 5000. */
test('subir el límite de abonados a mano invalida la firma', () => {
  const [payload, firma] = emitir(CONTENIDO).split('.')
  const editado = { ...JSON.parse(Buffer.from(payload, 'base64url').toString()), clientes_max: 99999 }

  const r = abrirToken(`${b64url(JSON.stringify(editado))}.${firma}`, { clavePublica: CLAVE })
  assert.equal(r.ok, false)
})

/**
 * Generarse un par de claves propio y firmarse la licencia uno mismo. Falla
 * porque la instalación verifica contra la clave del vendedor, no contra la que
 * venga con el token.
 */
test('una licencia firmada con otra clave no habilita', () => {
  const impostor = generateKeyPairSync('ed25519')
  const r = abrirToken(emitir(CONTENIDO, impostor.privateKey), { clavePublica: CLAVE })

  assert.equal(r.ok, false)
  assert.match(r.motivo, /firma/i)
})

/**
 * Sin clave pública configurada NO se habilita.
 *
 * Es la trampa clásica: si "no puedo verificar" se tratara como "está bien",
 * bastaría con borrar una línea del .env para tener el sistema gratis para
 * siempre.
 */
test('sin clave de verificación no habilita, aunque el token sea legítimo', () => {
  const r = abrirToken(emitir(CONTENIDO), { clavePublica: '' })
  assert.equal(r.ok, false)
})

test('un token con espacios o saltos de línea pegados igual se lee', () => {
  const r = abrirToken(`\n  ${emitir(CONTENIDO)}  \n`, { clavePublica: CLAVE })
  assert.equal(r.ok, true)
})

/**
 * El interruptor general del licenciamiento.
 *
 * Esto ya rompió una vez: el guardián se activó en la instalación del propio
 * proveedor —que no tiene licencia ni la necesita— y bloqueó el sistema entero
 * hasta que se le puso el interruptor. Cualquier instalación existente que
 * actualice a esta versión se habría bloqueado igual.
 *
 * La regla: sin clave pública cargada, no hay nada que verificar y no se
 * bloquea nada.
 */
test('sin clave del proveedor, la instalación no está bajo licencia', async () => {
  const { bajoLicencia } = await import('../src/services/licencia.js')
  const { config } = await import('../src/config.js')

  const original = config.licencia.clavePublica
  try {
    config.licencia.clavePublica = ''
    assert.equal(bajoLicencia(), false, 'sin clave NO debe exigir licencia')

    config.licencia.clavePublica = CLAVE
    assert.equal(bajoLicencia(), true, 'con clave SÍ debe exigirla')
  } finally {
    config.licencia.clavePublica = original
  }
})
