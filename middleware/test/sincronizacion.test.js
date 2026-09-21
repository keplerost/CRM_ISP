import test from 'node:test'
import assert from 'node:assert/strict'

import { planificarSincronizacion } from '../src/services/importador.js'

/**
 * La sincronización de morosos puede RESTAURARLE el servicio a alguien, así que
 * el planificador devuelve un plan y no ejecuta nada. Estos tests fijan que el
 * plan sea correcto y que los casos ambiguos queden marcados en vez de
 * resolverse solos.
 */

const LISTA = 'CORTE_MOROSOS'
const enLista = (address, extra = {}) => ({ list: LISTA, address, '.id': `*${address}`, ...extra })

test('propone agregar a los cortados que el router todavía no bloquea', () => {
  const plan = planificarSincronizacion(
    [
      { nombre: 'Ana', ip: '10.0.0.10', estado: 'cortado' },
      { nombre: 'Beto', ip: '10.0.0.11', estado: 'activo' },
    ],
    [],
    LISTA,
  )

  assert.equal(plan.agregar.length, 1)
  assert.equal(plan.agregar[0].address, '10.0.0.10')
  assert.equal(plan.agregar[0].nombre, 'Ana')
  assert.equal(plan.quitar.length, 0)
})

test('propone quitar a quien el sistema ya no tiene cortado', () => {
  const plan = planificarSincronizacion(
    [{ nombre: 'Ana', ip: '10.0.0.10', estado: 'activo' }],
    [enLista('10.0.0.10')],
    LISTA,
  )

  assert.equal(plan.quitar.length, 1)
  assert.equal(plan.quitar[0].address, '10.0.0.10')
  assert.equal(plan.quitar[0].conocido, true)
  assert.match(plan.quitar[0].motivo, /activo/)
})

test('marca como desconocidos los bloqueos que no corresponden a ningún cliente', () => {
  // Puede ser un bloqueo puesto a mano. Quitarlo a ciegas sería peligroso.
  const plan = planificarSincronizacion([], [enLista('192.168.99.99')], LISTA)

  assert.equal(plan.quitar.length, 1)
  assert.equal(plan.quitar[0].conocido, false)
  assert.match(plan.quitar[0].motivo, /no hay ningún cliente/i)
})

test('un cortado sin IP se reporta, no se ignora', () => {
  const plan = planificarSincronizacion(
    [{ nombre: 'Sin IP', ip: null, estado: 'cortado' }],
    [],
    LISTA,
  )

  assert.equal(plan.agregar.length, 0)
  assert.equal(plan.sinIp.length, 1)
  assert.equal(plan.sinIp[0].nombre, 'Sin IP')
})

test('cuando ya coinciden no propone nada', () => {
  const plan = planificarSincronizacion(
    [{ nombre: 'Ana', ip: '10.0.0.10', estado: 'cortado' }],
    [enLista('10.0.0.10')],
    LISTA,
  )

  assert.equal(plan.sinCambios, true)
  assert.equal(plan.yaCoinciden, 1)
  assert.equal(plan.agregar.length, 0)
  assert.equal(plan.quitar.length, 0)
})

test('ignora las entradas de otras listas', () => {
  const plan = planificarSincronizacion(
    [{ nombre: 'Ana', ip: '10.0.0.10', estado: 'cortado' }],
    [
      { list: 'otra-cosa', address: '10.0.0.10' },
      { list: 'permitidos', address: '10.0.0.99' },
    ],
    LISTA,
  )

  // La entrada en otra lista no cuenta como bloqueo: hay que agregarla igual.
  assert.equal(plan.agregar.length, 1)
  assert.equal(plan.quitar.length, 0)
})

test('entiende las direcciones con máscara', () => {
  const plan = planificarSincronizacion(
    [{ nombre: 'Ana', ip: '10.0.0.10', estado: 'cortado' }],
    [enLista('10.0.0.10/32')],
    LISTA,
  )
  assert.equal(plan.sinCambios, true)
})

test('un caso mixto se resuelve completo', () => {
  const plan = planificarSincronizacion(
    [
      { nombre: 'Ana', ip: '10.0.0.10', estado: 'cortado' }, // ya está: sin cambio
      { nombre: 'Beto', ip: '10.0.0.11', estado: 'cortado' }, // falta: agregar
      { nombre: 'Caro', ip: '10.0.0.12', estado: 'activo' }, // sobra: quitar
      { nombre: 'Dani', ip: null, estado: 'cortado' }, // sin IP: avisar
    ],
    [enLista('10.0.0.10'), enLista('10.0.0.12'), enLista('10.0.0.77')],
    LISTA,
  )

  assert.deepEqual(plan.agregar.map((a) => a.address), ['10.0.0.11'])
  assert.deepEqual(plan.quitar.map((q) => q.address), ['10.0.0.12', '10.0.0.77'])
  assert.equal(plan.quitar.find((q) => q.address === '10.0.0.77').conocido, false)
  assert.equal(plan.sinIp.length, 1)
  assert.equal(plan.yaCoinciden, 1)
  assert.equal(plan.sinCambios, false)
})
