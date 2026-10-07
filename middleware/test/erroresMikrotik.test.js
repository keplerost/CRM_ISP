import test from 'node:test'
import assert from 'node:assert/strict'

import * as api from '../src/drivers/mikrotikApi.js'

/**
 * Los errores tienen que llegar traducidos a la UI, con una pista de qué hacer.
 *
 * Regresión concreta: node-routeros dice "Timed out after 10 seconds", sin la
 * palabra "timeout". La traducción buscaba /timeout/ y no lo tomaba, así que el
 * usuario veía el texto crudo de la librería en vez de la explicación de que en
 * RouterOS hay que habilitar el acceso en dos lugares distintos.
 */

const equipo = {
  ip_host: '192.0.2.1', // TEST-NET: los paquetes se descartan, da timeout
  modo_api: 'binaria',
  puerto_api: 8728,
  usuario: 'u',
  password: 'p',
}

test('un timeout llega traducido y con pista', async () => {
  await assert.rejects(api.probarConexion(equipo), (err) => {
    assert.match(err.message, /No hay respuesta de 192\.0\.2\.1:8728/)
    assert.ok(err.hint, 'debe traer una pista')
    assert.match(err.hint, /ip service/i)
    assert.match(err.hint, /ip firewall filter/i)
    // Lo importante del diagnóstico: hay que hacer las dos cosas.
    assert.match(err.hint, /DOS lugares/i)
    return true
  })
})

test('ningún error llega con el texto crudo de la librería', async () => {
  await assert.rejects(api.probarConexion(equipo), (err) => {
    assert.ok(
      !/Timed out after/i.test(err.message),
      `el mensaje de la librería se filtró a la UI: "${err.message}"`,
    )
    return true
  })
})

test('un puerto cerrado no devuelve un error vacío', async () => {
  // node-routeros rechaza sin código ni texto cuando el puerto está cerrado.
  // Ese caso tiene que producir igual algo que el usuario pueda accionar.
  await assert.rejects(
    api.probarConexion({ ...equipo, ip_host: '127.0.0.1', puerto_api: 9 }),
    (err) => {
      assert.ok(err.message.length > 20, `mensaje demasiado escueto: "${err.message}"`)
      assert.ok(err.hint, 'debe traer una pista')
      assert.match(`${err.message} ${err.hint}`, /API de RouterOS|8728/i)
      return true
    },
  )
})

/**
 * Un error del comando no tira la sesión; uno de la conexión, sí. Antes
 * cualquier error la cerraba, y un "no such item" reintentado cada cinco
 * segundos llenaba el log del MikroTik de "logged in / logged out".
 */
test('qué error descarta la sesión con el router', async () => {
  const { esFalloDeConexion } = await import('../src/drivers/mikrotikApi.js')
  for (const m of ['no such item (4)', 'failure: already have such entry', 'input does not match any value']) {
    assert.equal(esFalloDeConexion(new Error(m)), false, m)
  }
  for (const m of ['Timed out after 10 seconds', 'connect ECONNREFUSED 10.66.0.11:8728', 'socket hang up']) {
    assert.equal(esFalloDeConexion(new Error(m)), true, m)
  }
  assert.equal(esFalloDeConexion(Object.assign(new Error('x'), { errno: 'ECONNRESET' })), true)
})
