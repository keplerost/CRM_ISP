import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { SshSession } from '../src/lib/sshSession.js'

/**
 * Regresión del bug que tiró la sesión contra la OLT real.
 *
 * `tienePaginador` miraba TODO el buffer acumulado. Como el texto "--More--"
 * quedaba ahí después de atenderlo, cada bloque de datos nuevo lo volvía a
 * detectar y se mandaba otro espacio. Con una salida larga eso son cientos de
 * espacios seguidos, y el equipo termina cortando la conexión ("Malformed
 * DISCONNECT packet").
 *
 * Un comando sin paginación tiene que mandar 0 espacios, y uno con N pantallas
 * exactamente N.
 */

/** Stream falso que registra lo que se le escribe y permite inyectar salida. */
function streamFalso() {
  const s = new EventEmitter()
  s.escrito = []
  s.write = (d) => {
    s.escrito.push(d)
    return true
  }
  s.end = () => {}
  return s
}

/** Arma una sesión ya "abierta" sobre un stream falso, sin tocar la red. */
function sesionFalsa() {
  const sesion = new SshSession({ host: 'test', username: 'u', password: 'p' })
  const stream = streamFalso()
  sesion.stream = stream
  stream.on('data', (d) => {
    sesion.buffer += d
  })
  return { sesion, stream }
}

const espacios = (stream) => stream.escrito.filter((d) => d === ' ').length

test('una salida sin paginador no manda ningún espacio', async () => {
  const { sesion, stream } = sesionFalsa()

  const promesa = sesion.run('show version')
  // Salida larga que llega en varios bloques, como en la vida real.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 120))
    stream.emit('data', `linea de salida numero ${i}\n`)
  }

  await promesa
  assert.equal(espacios(stream), 0)
})

test('un paginador se atiende UNA sola vez aunque sigan llegando datos', async () => {
  const { sesion, stream } = sesionFalsa()

  const promesa = sesion.run('show onu auto-find')

  await new Promise((r) => setTimeout(r, 120))
  stream.emit('data', 'ONU 1\nONU 2\n--More--')

  // Después del paginador siguen llegando muchos bloques. Con el bug, cada uno
  // de estos disparaba otro espacio.
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 120))
    stream.emit('data', `ONU ${i + 3}\n`)
  }

  await promesa
  assert.equal(espacios(stream), 1, 'debería mandarse exactamente un espacio por pantalla')
})

test('dos pantallas de paginación mandan dos espacios', async () => {
  const { sesion, stream } = sesionFalsa()

  const promesa = sesion.run('show onu info all')

  await new Promise((r) => setTimeout(r, 120))
  stream.emit('data', 'pagina 1\n--More--')
  await new Promise((r) => setTimeout(r, 120))
  stream.emit('data', 'pagina 2\n--More--')
  await new Promise((r) => setTimeout(r, 120))
  stream.emit('data', 'pagina 3 final\n')

  await promesa
  assert.equal(espacios(stream), 2)
})

test('el paginador de Huawei también se detecta', async () => {
  const { sesion, stream } = sesionFalsa()

  const promesa = sesion.run('display ont info 0 all')

  await new Promise((r) => setTimeout(r, 120))
  stream.emit('data', "F/S/P  ONT\n---- More ( Press 'Q' to break ) ----")
  await new Promise((r) => setTimeout(r, 120))
  stream.emit('data', '0/1/0  0\n')

  await promesa
  assert.equal(espacios(stream), 1)
})

test('el texto del comando queda en el buffer, el del paginador no', async () => {
  const { sesion, stream } = sesionFalsa()

  const promesa = sesion.run('show onu auto-find')
  await new Promise((r) => setTimeout(r, 120))
  stream.emit('data', 'GPON00112233\n--More--')
  await new Promise((r) => setTimeout(r, 120))
  stream.emit('data', 'GPON44556677\n')

  const salida = await promesa
  assert.ok(salida.includes('GPON00112233'))
  assert.ok(salida.includes('GPON44556677'))
  assert.ok(!salida.includes('--More--'), 'el prompt de paginación no debe ensuciar la salida')
})
