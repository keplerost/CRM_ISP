import test from 'node:test'
import assert from 'node:assert/strict'
import { sumarMeses } from '../src/db.js'

/**
 * La cuenta de hasta cuándo vale un pago.
 *
 * Es la aritmética que decide el día exacto en que a un cliente se le bloquea
 * el sistema. Un error de un día acá es una llamada enojada; un error de un mes
 * es plata regalada o un ISP volteado sin motivo.
 */

test('un mes es un mes', () => {
  assert.equal(sumarMeses('2026-01-15', 1), '2026-02-15')
  assert.equal(sumarMeses('2026-03-10', 3), '2026-06-10')
})

/**
 * El 31 de enero más un mes no existe. JavaScript lo desborda solo al 3 de
 * marzo, que le regalaría tres días a todo el que pague un 29, 30 o 31.
 */
test('los meses cortos no desbordan al mes siguiente', () => {
  assert.equal(sumarMeses('2026-01-31', 1), '2026-02-28')
  assert.equal(sumarMeses('2026-01-30', 1), '2026-02-28')
  assert.equal(sumarMeses('2026-03-31', 1), '2026-04-30')
})

test('febrero de un año bisiesto llega hasta el 29', () => {
  assert.equal(sumarMeses('2028-01-31', 1), '2028-02-29')
})

test('cruzar el año no pierde el mes', () => {
  assert.equal(sumarMeses('2026-12-15', 1), '2027-01-15')
  assert.equal(sumarMeses('2026-11-30', 12), '2027-11-30')
})
