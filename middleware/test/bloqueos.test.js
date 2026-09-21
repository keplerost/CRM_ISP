import test from 'node:test'
import assert from 'node:assert/strict'

import { filtrarPorLista, LISTA_MOROSOS } from '../src/drivers/mikrotikApi.js'

/**
 * Regresión de un bug que tumbaba el middleware entero.
 *
 * listarBloqueos usaba la consulta del lado de RouterOS (`?list=CORTE_MOROSOS`).
 * Cuando esa consulta no encontraba nada, el equipo respondía `!empty` —una
 * respuesta que node-routeros no reconoce— y lanzaba una excepción ASÍNCRONA,
 * fuera del try/catch. El proceso de Node moría, y en la interfaz aparecía
 * "no se puede contactar al middleware", sin ninguna pista de la causa real.
 *
 * Ahora se trae la lista completa y se filtra acá. Esta función es la que
 * reemplazó a la consulta, así que se prueba directo.
 */

const ENTRADAS = [
  { '.id': '*1', list: 'CORTE_MOROSOS', address: '10.0.0.55', comment: 'Factura 0234' },
  { '.id': '*2', list: 'permitidos', address: '10.0.0.2' },
  { '.id': '*3', list: 'CORTE_MOROSOS', address: '10.0.0.90' },
  { '.id': '*4', list: 'blacklist', address: '1.2.3.4' },
]

test('devuelve solo las entradas de la lista pedida', () => {
  const r = filtrarPorLista(ENTRADAS, LISTA_MOROSOS)
  assert.equal(r.length, 2)
  assert.deepEqual(
    r.map((e) => e.address),
    ['10.0.0.55', '10.0.0.90'],
  )
})

test('una lista sin coincidencias devuelve vacío, no rompe', () => {
  // Este es exactamente el caso que antes mataba el proceso.
  assert.deepEqual(filtrarPorLista(ENTRADAS, 'LISTA_QUE_NO_EXISTE'), [])
})

test('un router sin ninguna entrada devuelve vacío', () => {
  assert.deepEqual(filtrarPorLista([], LISTA_MOROSOS), [])
})

test('una respuesta que no es un array no rompe', () => {
  // Defensa por si el equipo contesta algo inesperado.
  assert.deepEqual(filtrarPorLista(null, LISTA_MOROSOS), [])
  assert.deepEqual(filtrarPorLista(undefined, LISTA_MOROSOS), [])
  assert.deepEqual(filtrarPorLista({ mensaje: 'raro' }, LISTA_MOROSOS), [])
})

test('no confunde listas con nombres parecidos', () => {
  const entradas = [
    { list: 'CORTE_MOROSOS', address: '10.0.0.1' },
    { list: 'CORTE_MOROSOS_2', address: '10.0.0.2' },
    { list: 'corte_morosos', address: '10.0.0.3' },
  ]
  const r = filtrarPorLista(entradas, 'CORTE_MOROSOS')
  assert.equal(r.length, 1)
  assert.equal(r[0].address, '10.0.0.1')
})
