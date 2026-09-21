import test from 'node:test'
import assert from 'node:assert/strict'

import * as servicio from '../src/services/mikrotikService.js'
import * as binaria from '../src/drivers/mikrotikApi.js'
import * as rest from '../src/drivers/mikrotik.js'

/**
 * Los dos drivers de MikroTik tienen que ser intercambiables: el servicio elige
 * uno u otro según el router, y las rutas no se enteran. Si alguien agrega una
 * función a un driver y se olvida del otro, esto lo detecta.
 */

const FUNCIONES = [
  'probarConexion',
  'listarPools',
  'crearPool',
  'borrarPool',
  'listarDirecciones',
  'crearDireccion',
  'borrarDireccion',
  'listarInterfaces',
  'listarBloqueos',
  'bloquearIp',
  'desbloquear',
  'listarReglasFilter',
  'listarReglasNat',
  'asegurarReglaCorte',
  'asegurarRedireccionPago',
  'listarSimpleQueues',
  'crearSimpleQueue',
]

test('los dos drivers exponen la misma interfaz', () => {
  for (const nombre of FUNCIONES) {
    assert.equal(typeof binaria[nombre], 'function', `falta ${nombre} en el driver binario`)
    assert.equal(typeof rest[nombre], 'function', `falta ${nombre} en el driver REST`)
  }
})

test('el servicio reexporta todas las operaciones', () => {
  for (const nombre of FUNCIONES) {
    assert.equal(typeof servicio[nombre], 'function', `el servicio no expone ${nombre}`)
  }
  assert.equal(servicio.LISTA_MOROSOS, 'CORTE_MOROSOS')
})

test('modo_api explícito manda sobre el puerto', () => {
  assert.equal(servicio.modoDe({ modo_api: 'binaria', puerto_api: 80 }), 'binaria')
  assert.equal(servicio.modoDe({ modo_api: 'rest', puerto_api: 8728 }), 'rest')
})

test('sin modo_api, el puerto decide (routers cargados antes de la columna)', () => {
  // 80 y 443 solo tienen sentido para REST; el resto es la API binaria.
  assert.equal(servicio.modoDe({ puerto_api: 80 }), 'rest')
  assert.equal(servicio.modoDe({ puerto_api: 443 }), 'rest')
  assert.equal(servicio.modoDe({ puerto_api: 8728 }), 'binaria')
  assert.equal(servicio.modoDe({ puerto_api: 8729 }), 'binaria')
  assert.equal(servicio.modoDe({ puerto_api: 9999 }), 'binaria')
})

test('el modo por defecto es la API binaria', () => {
  assert.equal(servicio.modoDe({}), 'binaria')
})

test('un error sin mensaje no llega vacío al usuario', async () => {
  // node-routeros a veces rechaza sin texto. El usuario tiene que recibir algo
  // accionable igual, no "Error contra 127.0.0.1: ".
  await assert.rejects(
    servicio.probarConexion({
      ip_host: '127.0.0.1',
      modo_api: 'binaria',
      puerto_api: 1,
      usuario: 'u',
      password: 'p',
    }),
    (err) => {
      assert.ok(err.message.length > 20, `mensaje demasiado escueto: "${err.message}"`)
      assert.ok(err.hint, 'todo error debería traer una pista de qué hacer')
      return true
    },
  )
})
