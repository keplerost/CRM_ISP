import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { revisarRango } from '../src/services/poolsOnu.js'

/**
 * La validación de un pool de gestión.
 *
 * Es la parte que decide cuántas filas se van a crear y cuáles. Un error acá no
 * se ve al guardar: se ve cuando una ONT recibe una dirección de otra red y no
 * llega a ningún lado, o cuando alguien le entrega a un abonado la dirección
 * del gateway y rompe el segmento entero.
 */

describe('el rango dentro del bloque', () => {
  test('sin rango explícito, se toma el bloque entero utilizable', () => {
    const r = revisarRango({ cidr: '192.168.240.0/24' })
    assert.equal(r.desde, '192.168.240.1')
    assert.equal(r.hasta, '192.168.240.254')
    assert.equal(r.total, 254)
  })

  test('la red y el broadcast quedan afuera solos', () => {
    const r = revisarRango({ cidr: '10.100.0.0/20' })
    assert.equal(r.desde, '10.100.0.1')
    assert.equal(r.hasta, '10.100.15.254')
  })

  test('un rango más chico que el bloque es válido', () => {
    // De un /20 se puede querer entregar solo una parte y dejar el resto para
    // equipos propios.
    const r = revisarRango({ cidr: '10.100.0.0/20', desde: '10.100.0.2', hasta: '10.100.0.254' })
    assert.equal(r.total, 253)
  })
})

describe('el gateway', () => {
  test('no se reparte: se descuenta de las que se van a crear', () => {
    // Entregárselo a una ONU la deja sin salida Y rompe a todas las demás del
    // segmento, que dejan de tener router.
    const r = revisarRango({
      cidr: '192.168.240.0/24',
      desde: '192.168.240.1',
      hasta: '192.168.240.254',
      gateway: '192.168.240.1',
    })
    assert.equal(r.total, 254)
    assert.equal(r.a_crear, 253)
  })

  test('si cae fuera del rango, no se descuenta nada', () => {
    const r = revisarRango({
      cidr: '192.168.240.0/24',
      desde: '192.168.240.10',
      hasta: '192.168.240.20',
      gateway: '192.168.240.1',
    })
    assert.equal(r.a_crear, 11)
  })

  test('un gateway de otra red se rechaza', () => {
    assert.throws(
      () => revisarRango({ cidr: '192.168.240.0/24', gateway: '10.0.0.1' }),
      /no pertenece/,
    )
  })
})

describe('lo que se rechaza en vez de crear mal', () => {
  test('un rango que se sale del bloque', () => {
    // No se recorta en silencio: recortar dejaría un pool distinto del que la
    // persona creyó estar creando.
    assert.throws(
      () => revisarRango({ cidr: '192.168.240.0/24', desde: '192.168.240.1', hasta: '192.168.241.50' }),
      /se sale de/,
    )
  })

  test('y dice cuál es el rango bueno', () => {
    try {
      revisarRango({ cidr: '192.168.240.0/24', hasta: '192.168.241.50' })
      assert.fail('tenía que rechazarlo')
    } catch (e) {
      assert.match(e.hint ?? '', /192\.168\.240\.1 a 192\.168\.240\.254/)
    }
  })

  test('el rango al revés', () => {
    assert.throws(
      () => revisarRango({ cidr: '10.0.0.0/24', desde: '10.0.0.200', hasta: '10.0.0.10' }),
      /mayor que la final/,
    )
  })

  test('un CIDR que no es un CIDR', () => {
    assert.throws(() => revisarRango({ cidr: 'la red de arriba' }), /no es una red válida/)
  })

  test('un bloque demasiado grande', () => {
    // Un /8 son dieciséis millones de filas. El límite existe para que el error
    // sea un mensaje y no una petición que nunca termina.
    assert.throws(() => revisarRango({ cidr: '10.0.0.0/8' }), /máximo por pool/)
  })
})

describe('lo que se informa para poder decidir', () => {
  test('trae el bloque completo además del rango elegido', () => {
    // Es lo que permite ofrecer "agregar todas las del CIDR" sin que la
    // pantalla tenga que recalcularlo por su cuenta y llegar a otro número.
    const r = revisarRango({ cidr: '10.100.0.0/20', desde: '10.100.0.2', hasta: '10.100.0.10' })
    assert.equal(r.total, 9)
    assert.equal(r.bloque.desde, '10.100.0.1')
    assert.equal(r.bloque.hasta, '10.100.15.254')
    assert.equal(r.bloque.total, 4094)
  })
})
