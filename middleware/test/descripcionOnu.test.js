import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parsearDescripcion } from '../src/drivers/huaweiSnmp.js'

/**
 * La descripción de la ONT es el único lugar donde el sistema anterior guardó
 * quién es el abonado, en qué zona está y desde cuándo. Todo eso viene en un
 * solo campo de texto separado por guiones bajos.
 */
const REAL = 'VERA_ARTEAGA_FLORENTINO_RAMON_zone_Zone_1_descr_Manguilita_Via_Selvalegre_authd_20251020'

describe('lo que trae la descripción del equipo', () => {
  const d = parsearDescripcion(REAL)

  test('separa nombre, zona, dirección y fecha', () => {
    assert.equal(d.nombre, 'VERA ARTEAGA FLORENTINO RAMON')
    assert.equal(d.zona, 'Zone 1')
    assert.equal(d.direccion, 'Manguilita Via Selvalegre')
    assert.equal(d.alta, '2025-10-20')
  })

  test('los guiones bajos se sacan en los TRES campos, no solo en el nombre', () => {
    // Cuando solo se limpiaba el nombre, la misma zona quedaba guardada como
    // "Zone 1" en unas ONUs y "Zone_1" en otras. El filtro las mostraba como dos
    // zonas distintas, y filtrar por una para ver a quiénes afectó un corte
    // devolvía 67 abonados dejando 8 afuera sin avisar.
    assert.doesNotMatch(d.zona, /_/)
    assert.doesNotMatch(d.direccion, /_/)
    assert.doesNotMatch(d.nombre, /_/)
  })

  test('la fecha queda ordenable', () => {
    // "20251020" no se puede ordenar ni comparar como fecha.
    assert.match(d.alta, /^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('descripciones que no tienen esa forma', () => {
  test('un texto libre se devuelve entero como nombre', () => {
    // Inventarle estructura a un texto libre es peor que dejarlo como está.
    const d = parsearDescripcion('CLIENTE INSTALACION DOMINGO')
    assert.equal(d.nombre, 'CLIENTE INSTALACION DOMINGO')
    assert.equal(d.zona, null)
    assert.equal(d.direccion, null)
  })

  test('vacía no explota y no inventa campos', () => {
    const d = parsearDescripcion('')
    assert.equal(d.nombre, null)
    assert.equal(d.zona, null)
  })

  test('sin zona pero con dirección', () => {
    const d = parsearDescripcion('JUAN PEREZ_descr_Calle_Larga_authd_20240101')
    assert.equal(d.nombre, 'JUAN PEREZ')
    assert.equal(d.zona, null)
    assert.equal(d.direccion, 'Calle Larga')
  })
})
