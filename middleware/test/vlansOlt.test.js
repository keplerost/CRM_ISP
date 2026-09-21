import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizarLista } from '../src/services/vlansOlt.js'

/**
 * Escribir dieciséis VLANs una por una es donde aparece el número repetido o el
 * salteado, y ninguno de los dos se nota hasta que un abonado queda en el
 * segmento de otro. Por eso se aceptan rangos.
 */
describe('la lista de VLANs que escribe una persona', () => {
  test('un rango se expande', () => {
    assert.deepEqual(normalizarLista('201-205'), [201, 202, 203, 204, 205])
  })

  test('mezcla de sueltas y rangos', () => {
    assert.deepEqual(normalizarLista('200, 202-204, 300'), [200, 202, 203, 204, 300])
  })

  test('un rango al revés se ordena, no se descarta', () => {
    // "215-201" es un tipeo, no una orden de no hacer nada. Devolver vacío en
    // silencio haría que el operador crea que creó quince VLANs y no creó
    // ninguna.
    assert.deepEqual(normalizarLista('205-201'), [201, 202, 203, 204, 205])
  })

  test('los repetidos se cuentan una sola vez', () => {
    assert.deepEqual(normalizarLista('200, 200, 201'), [200, 201])
    assert.deepEqual(normalizarLista('200-202, 201'), [200, 201, 202])
  })

  test('acepta espacios, comas o las dos cosas', () => {
    assert.deepEqual(normalizarLista('200 201,202'), [200, 201, 202])
  })

  test('descarta lo que no es una VLAN válida', () => {
    // Fuera del rango 1-4094 el equipo lo rechazaría de todos modos, pero acá
    // el operador se entera antes de que la mitad de su lista falle.
    assert.deepEqual(normalizarLista('0, 200, 4095, 9999'), [200])
  })

  test('vacío es vacío, no un rango entero', () => {
    assert.deepEqual(normalizarLista(''), [])
    assert.deepEqual(normalizarLista(null), [])
    assert.deepEqual(normalizarLista('   '), [])
  })

  test('un array también vale, y se limpia igual', () => {
    assert.deepEqual(normalizarLista([203, 201, 201, 99999]), [201, 203])
  })

  test('siempre sale ordenada', () => {
    // El orden importa para leer el resultado: "creadas 205, 201, 203" obliga a
    // ordenar mentalmente para ver si falta alguna.
    assert.deepEqual(normalizarLista('300, 200, 250'), [200, 250, 300])
  })
})
