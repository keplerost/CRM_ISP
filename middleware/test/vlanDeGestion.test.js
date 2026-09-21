import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

/**
 * De qué VLANs puede salir la dirección de un abonado.
 *
 * En esta OLT cada ONT está en DOS VLANs: la 200, que lleva su tráfico, y la
 * 999, que es la de gestión. Las dos aparecen en sus service-ports y las dos se
 * ven igual de legítimas si uno solo mira el número.
 *
 * Darle a un cliente una dirección de la de gestión es el peor de los errores
 * posibles: queda sin servicio Y con acceso a la red de administración de las
 * ONTs. Por eso `uso` no es una etiqueta decorativa — decide.
 */

/** La misma regla que aplica `vlansOlt`, aislada. */
const esDeServicio = (uso) => {
  if (uso == null) return null
  return uso === 'internet' || uso === 'iptv' || uso === 'otra'
}

describe('qué VLANs pueden dar una IP de abonado', () => {
  test('internet sí', () => {
    assert.equal(esDeServicio('internet'), true)
  })

  test('iptv sí: lleva tráfico de cliente', () => {
    assert.equal(esDeServicio('iptv'), true)
  })

  test('gestión no', () => {
    assert.equal(esDeServicio('gestion'), false)
  })

  test('voip no', () => {
    assert.equal(esDeServicio('voip'), false)
  })
})

describe('la diferencia entre "no" y "no sé"', () => {
  test('sin declarar devuelve null, no false', () => {
    // No es un detalle de estilo. Si "sin declarar" contara como "no lleva
    // abonados", cada VLAN que nadie tuvo tiempo de clasificar dejaría al
    // técnico trabado arriba de una escalera por un dato administrativo.
    assert.equal(esDeServicio(null), null)
    assert.equal(esDeServicio(undefined), null)
  })

  test('solo se bloquea cuando ES false, nunca cuando es null', () => {
    const bloquea = (uso) => esDeServicio(uso) === false

    assert.equal(bloquea('gestion'), true)
    assert.equal(bloquea('voip'), true)
    assert.equal(bloquea(null), false, 'una VLAN sin declarar no puede trabar un alta')
    assert.equal(bloquea('internet'), false)
  })
})

describe('el caso real de esta OLT', () => {
  // Cada ONT tiene service-ports en la 200 y en la 999.
  const delEquipo = [
    { vlan: 200, uso: 'internet' },
    { vlan: 999, uso: 'gestion' },
  ]

  test('de las dos que tiene la ONT, solo una puede dar la IP', () => {
    const sirven = delEquipo.filter((v) => esDeServicio(v.uso) !== false)
    assert.equal(sirven.length, 1)
    assert.equal(sirven[0].vlan, 200)
  })

  test('antes de declarar la 999, las dos parecían iguales', () => {
    // Es lo que pasaba hasta ahora: sin `uso`, nada distinguía la de gestión, y
    // el sistema podía proponer un segmento de la 999 con total naturalidad.
    const sinDeclarar = delEquipo.map((v) => ({ ...v, uso: null }))
    assert.equal(sinDeclarar.filter((v) => esDeServicio(v.uso) !== false).length, 2)
  })
})
