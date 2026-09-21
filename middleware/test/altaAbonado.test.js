import test from 'node:test'
import assert from 'node:assert/strict'

import { buscarPorNombre, buscarPorMac } from '../src/drivers/mikrotikApi.js'

/**
 * Regresión del bug que colgaba el alta en campo — el mismo que ya había
 * tumbado los bloqueos (ver bloqueos.test.js).
 *
 * `asegurarPppSecret` preguntaba con la consulta del lado de RouterOS
 * (`/ppp/secret/print ?name=juan`). Cuando ese nombre no existía, el equipo
 * respondía `!empty` —una respuesta que node-routeros no reconoce— y lanzaba
 * una excepción ASÍNCRONA, fuera del try/catch. La petición del técnico quedaba
 * colgada para siempre, sin error y sin timeout.
 *
 * Lo peor es dónde caía: "ese usuario todavía no existe" es el caso NORMAL de
 * un alta. O sea que fallaba siempre en el alta de un abonado nuevo, y andaba
 * bien al reintentar sobre uno que ya estaba.
 *
 * Se detectó probando contra un MikroTik de verdad; ningún test lo había visto
 * porque el equipo simulado devolvía una lista vacía y no `!empty`.
 *
 * Ahora se trae la tabla entera y se filtra acá. Estas son esas funciones.
 */

const SECRETS = [
  { '.id': '*1', name: 'jefferson.ona', password: 'ABC123', service: 'pppoe' },
  { '.id': '*2', name: 'maria.chavez', password: 'XYZ789', service: 'pppoe' },
  { '.id': '*3', name: 'jefferson.ona.2', password: 'QWE456', service: 'pppoe' },
]

test('encuentra el secret de un abonado que ya existe', () => {
  const r = buscarPorNombre(SECRETS, 'jefferson.ona')
  assert.equal(r.length, 1)
  assert.equal(r[0]['.id'], '*1')
})

test('un usuario que no existe devuelve vacío, no rompe', () => {
  // Este es exactamente el caso que colgaba el alta: el abonado nuevo.
  assert.deepEqual(buscarPorNombre(SECRETS, 'abonado.nuevo'), [])
})

test('no confunde un nombre con otro que lo contiene', () => {
  // Si esto fallara, un alta nueva pisaría el secret de otro abonado.
  const r = buscarPorNombre(SECRETS, 'jefferson.ona')
  assert.equal(r.length, 1)
  assert.equal(r[0].name, 'jefferson.ona')
})

test('un router sin ningún secret no rompe', () => {
  assert.deepEqual(buscarPorNombre([], 'quien.sea'), [])
})

test('una respuesta que no es lista tampoco rompe', () => {
  // El equipo puede contestar algo inesperado; no puede tumbar el alta.
  assert.deepEqual(buscarPorNombre(null, 'x'), [])
  assert.deepEqual(buscarPorNombre(undefined, 'x'), [])
})

const LEASES = [
  { '.id': '*1', address: '10.0.0.5', 'mac-address': '00:1A:2B:3C:4D:5E', dynamic: 'false' },
  { '.id': '*2', address: '10.0.0.9', 'mac-address': 'AA:BB:CC:DD:EE:FF', dynamic: 'true' },
]

test('encuentra la lease por MAC', () => {
  const r = buscarPorMac(LEASES, '00:1A:2B:3C:4D:5E')
  assert.equal(r.length, 1)
  assert.equal(r[0].address, '10.0.0.5')
})

test('la MAC se compara sin distinguir mayúsculas', () => {
  // El técnico la escribe en minúsculas y RouterOS la guarda en mayúsculas.
  assert.equal(buscarPorMac(LEASES, '00:1a:2b:3c:4d:5e').length, 1)
  assert.equal(buscarPorMac(LEASES, 'aa:bb:cc:dd:ee:ff').length, 1)
})

test('una MAC sin reserva devuelve vacío', () => {
  assert.deepEqual(buscarPorMac(LEASES, '11:22:33:44:55:66'), [])
})

test('leases sin MAC no hacen fallar la búsqueda', () => {
  assert.deepEqual(buscarPorMac([{ '.id': '*9', address: '10.0.0.1' }], '00:1A:2B:3C:4D:5E'), [])
})
