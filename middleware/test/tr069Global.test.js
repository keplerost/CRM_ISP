import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { alcanzable, puertoDeUrl } from '../src/services/tr069Global.js'

/**
 * Que al otro lado corten de golpe es lo NORMAL acá, no una falla.
 *
 * `alcanzable` solo comprueba si el puerto del ACS acepta conexiones, así que
 * en cuanto le contestan cierra de una: no le interesa la respuesta. Del lado
 * del servidor eso llega como ECONNRESET, y un socket sin oyente de `error`
 * convierte ese reset en una excepción del proceso entero.
 *
 * Corriendo este archivo solo, el reset llega antes de que la prueba termine y
 * no se nota. Con la suite entera —cien archivos peleando por el procesador—
 * llega después, cuando el runner ya cerró la prueba, y node lo reporta como
 * "actividad asincrónica después de que el test terminó": da el ARCHIVO por
 * fallado sin marcar ninguna prueba. Era exactamente lo que pasaba.
 *
 * Por lo mismo el cierre del servidor ahora se espera. `close()` sin esperar
 * devuelve enseguida y deja la escucha abierta un rato más.
 */
const noImporta = () => {}

test('saca host y puerto de la URL del ACS', () => {
  assert.deepEqual(puertoDeUrl('http://192.168.55.254:7547'), {
    host: '192.168.55.254',
    puerto: 7547,
  })
  // Los puertos por defecto no se escriben y hay que ponerlos igual: sin esto,
  // un ACS detrás de HTTPS sin puerto explícito se probaría contra el 0.
  assert.deepEqual(puertoDeUrl('https://acs.miisp.ec/cwmp'), {
    host: 'acs.miisp.ec',
    puerto: 443,
  })
  assert.deepEqual(puertoDeUrl('http://10.69.69.1:14501'), { host: '10.69.69.1', puerto: 14501 })
})

test('lo que no es una URL http no se prueba', () => {
  for (const mala of ['no-es-una-url', '', 'ftp://x.com', 'javascript:alert(1)']) {
    assert.equal(puertoDeUrl(mala), null, `debería rechazar ${JSON.stringify(mala)}`)
  }
})

test('un puerto que acepta conexiones se informa alcanzable', async () => {
  const servidor = net.createServer((socket) => socket.on('error', noImporta))
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r))
  const puerto = servidor.address().port

  try {
    const r = await alcanzable(`http://127.0.0.1:${puerto}`)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.puerto, puerto)
  } finally {
    await new Promise((r) => servidor.close(r))
  }
})

test('un servidor que contesta 405 sigue estando ALCANZABLE', async () => {
  /**
   * Es exactamente lo que hace el CWMP de GenieACS: a un GET contesta
   * "405 Método no permitido", porque solo acepta POST de las ONT. Es la
   * respuesta correcta de un ACS sano.
   *
   * Por eso esta comprobación es un TCP y no un pedido HTTP: más de una
   * herramienta lee ese 405 como "caído" y manda a revisar un servidor que
   * está perfecto.
   */
  const servidor = net.createServer((socket) => {
    socket.on('error', noImporta)
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n')
  })
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r))
  const puerto = servidor.address().port

  try {
    const r = await alcanzable(`http://127.0.0.1:${puerto}`)
    assert.equal(r.ok, true, 'un 405 es un ACS sano, no uno caído')
  } finally {
    await new Promise((r) => servidor.close(r))
  }
})

test('un puerto cerrado se informa caído, con el motivo', async () => {
  // Se toma un puerto, se anota y se cierra: así se garantiza que nadie lo
  // esté escuchando, en vez de apostar a que un número al azar esté libre.
  const servidor = net.createServer(() => {})
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r))
  const puerto = servidor.address().port
  await new Promise((r) => servidor.close(r))

  const r = await alcanzable(`http://127.0.0.1:${puerto}`)
  assert.equal(r.ok, false)
  assert.ok(r.motivo, 'tiene que decir por qué')
})

test('una dirección que no contesta corta por tiempo y no cuelga la pantalla', async () => {
  // 198.51.100.0/24 es rango de documentación: no existe en ninguna red real.
  const desde = Date.now()
  const r = await alcanzable('http://198.51.100.7:7547', { timeoutMs: 700 })

  assert.equal(r.ok, false)
  assert.ok(
    Date.now() - desde < 4000,
    'no puede quedarse esperando el timeout del sistema operativo',
  )
})
