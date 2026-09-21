import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { aAsciiParaEquipo, normalizarNombre } from '../src/lib/nombres.js'

/**
 * Lo que se le escribe a una ONT como nombre del abonado.
 *
 * El equipo solo guarda ASCII, y los caracteres que no lo son no los convierte:
 * los pierde. Se descubrió al dar de alta a José Luis Oña Riera y ver qué había
 * quedado escrito en su ONT.
 */
describe('nombres que viajan al equipo', () => {
  test('el caso que lo destapó', () => {
    // Sin transliterar, el equipo guardó "Jos_Luis_Oa_Riera": se comió la é y la
    // ñ enteras. "Oa" no es un apellido que alguien pueda buscar ni reconocer.
    assert.equal(aAsciiParaEquipo('José Luis Oña Riera'), 'Jose Luis Ona Riera')
  })

  test('mayúsculas y minúsculas se respetan', () => {
    assert.equal(aAsciiParaEquipo('PEÑA Ángel'), 'PENA Angel')
    assert.equal(aAsciiParaEquipo('MUÑOZ'), 'MUNOZ')
  })

  test('todos los acentos del castellano', () => {
    assert.equal(aAsciiParaEquipo('áéíóú ÁÉÍÓÚ üÜ'), 'aeiou AEIOU uU')
  })

  test('lo que no se puede convertir queda como guion bajo, no desaparece', () => {
    // Una letra que se borra acorta la palabra sin avisar; un guion bajo se ve.
    assert.equal(aAsciiParaEquipo('Wang 王 Li'), 'Wang _ Li')
  })

  test('un texto que ya era ASCII no se toca', () => {
    assert.equal(aAsciiParaEquipo('HERRERA GUAMANI ENMA BEATRIZ'), 'HERRERA GUAMANI ENMA BEATRIZ')
  })

  test('vacío y nulo no explotan', () => {
    assert.equal(aAsciiParaEquipo(null), '')
    assert.equal(aAsciiParaEquipo(''), '')
  })
})

describe('la otra normalización, la de comparar personas, sigue protegiendo la Ñ', () => {
  test('PEÑA no se convierte en PENA al comparar', () => {
    // Son dos apellidos distintos y dos personas distintas. Acá sí importa, y
    // por eso son dos funciones y no una: el equipo no admite la Ñ y hay que
    // convertirla; comparar dos abonados entre sí no tiene esa limitación.
    assert.notEqual(normalizarNombre('PEÑA'), normalizarNombre('PENA'))
  })

  test('y los acentos sí se sacan, porque no cambian de persona', () => {
    assert.equal(normalizarNombre('José'), normalizarNombre('JOSE'))
  })
})
