import test from 'node:test'
import assert from 'node:assert/strict'

import { SIN_SERVICIO, esBaja, sinServicio } from '../src/lib/estados.js'

/**
 * Quién tiene que estar bloqueado en el router.
 *
 * ── Qué se protege ──
 *
 * El corte y la reparación miraban solo `cortado`. Para ellos `suspendido` era
 * "está al día", así que a un abonado suspendido cuya IP estuviera en la lista
 * lo DESBLOQUEABAN: le devolvían el internet entendiendo que no debía nada.
 *
 * No se veía porque ninguna pantalla produce `suspendido` —el botón "Suspender
 * servicio" deja al abonado en `cortado`— pero aparece en cuanto se importa un
 * sector donde haya secrets deshabilitados en el equipo.
 */

test('cortado y suspendido cuentan igual: los dos sin servicio', () => {
  assert.equal(sinServicio('cortado'), true)
  assert.equal(sinServicio('suspendido'), true)
})

test('un activo no va a la lista de corte', () => {
  assert.equal(sinServicio('activo'), false)
})

test('una baja TAMPOCO va a la lista', () => {
  // No es un bloqueado: es alguien que ya no está. Su IP vuelve al pozo y puede
  // ser de otro mañana — dejarla en la lista le cortaría el servicio al que
  // venga después, y nadie relacionaría una cosa con la otra.
  assert.equal(sinServicio('baja'), false)
  assert.equal(esBaja('baja'), true)
  assert.equal(esBaja('cortado'), false)
})

test('no se cae con un estado vacío o desconocido', () => {
  // Una fila importada puede traer cualquier cosa en esa columna.
  for (const raro of ['', null, undefined, 'pendiente', 'moroso']) {
    assert.equal(sinServicio(raro), false, `${JSON.stringify(raro)} no debería contar`)
  }
})

test('se compara sin importar mayúsculas ni espacios', () => {
  assert.equal(sinServicio(' CORTADO '), true)
  assert.equal(sinServicio('Suspendido'), true)
})

test('la lista no crece sin querer', () => {
  // Si alguien agrega un estado acá, que sea una decisión: cada uno que entra
  // deja sin internet a quien lo tenga.
  assert.deepEqual([...SIN_SERVICIO].sort(), ['cortado', 'suspendido'])
})
