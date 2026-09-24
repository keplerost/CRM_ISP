import test from 'node:test'
import assert from 'node:assert/strict'

import {
  aMinutos,
  cuandoSePuede,
  dentroDeLaFranja,
  esperaLaFranja,
} from '../src/lib/horarioAvisos.js'

/**
 * La hora a la que se le puede escribir a un abonado.
 *
 * ── Qué se protege ──
 *
 * Que ningún aviso automático salga de madrugada. Una abonada pidió el retiro
 * del servicio por un mensaje a la 01:30 — no por la deuda, por el susto: a esa
 * hora un mensaje se lee como una emergencia familiar.
 *
 * Y lo contrario, que es igual de importante: que la franja NO detenga lo que
 * responde a algo que la persona acaba de hacer. Quien paga a las once de la
 * noche quiere su comprobante en el momento.
 */

const alas = (h, m = 0) => new Date(2026, 8, 24, h, m, 0)

test('la franja normal deja pasar el día y frena la madrugada', () => {
  const franja = { desde: '08:00', hasta: '20:00' }
  assert.equal(dentroDeLaFranja(alas(1, 30), franja), false, 'la 01:30 es cuando factura')
  assert.equal(dentroDeLaFranja(alas(5), franja), false, 'las 05:00 es cuando corta')
  assert.equal(dentroDeLaFranja(alas(8), franja), true)
  assert.equal(dentroDeLaFranja(alas(14), franja), true)
  assert.equal(dentroDeLaFranja(alas(19, 59), franja), true)
  assert.equal(dentroDeLaFranja(alas(20), franja), false, 'a las 20:00 ya cerró')
  assert.equal(dentroDeLaFranja(alas(23), franja), false)
})

test('lo generado de madrugada sale esa misma mañana', () => {
  // El caso de la factura: se crea a la 01:30 del día 1 y el aviso sale a las
  // 08:00 de ESE día, no del siguiente.
  const cuando = cuandoSePuede(alas(1, 30), { desde: '08:00', hasta: '20:00' })
  assert.equal(cuando.getDate(), 24)
  assert.equal(cuando.getHours(), 8)
  assert.equal(cuando.getMinutes(), 0)
})

test('lo generado de noche espera a la mañana siguiente', () => {
  const cuando = cuandoSePuede(alas(22), { desde: '08:00', hasta: '20:00' })
  assert.equal(cuando.getDate(), 25, 'tiene que ser el día siguiente')
  assert.equal(cuando.getHours(), 8)
})

test('dentro de la franja no se pospone nada', () => {
  // `null` y no "ahora": escribir una fecha que solo dice "ya" haría que la
  // cola tenga que compararla en cada pasada sin motivo.
  assert.equal(cuandoSePuede(alas(10), { desde: '08:00', hasta: '20:00' }), null)
})

test('una franja que cruza la medianoche se entiende', () => {
  // Nadie debería cargarla así, pero alguien lo va a hacer. Tratarla como vacía
  // dejaría todos los avisos detenidos para siempre sin que nada lo explique.
  const nocturna = { desde: '20:00', hasta: '08:00' }
  assert.equal(dentroDeLaFranja(alas(22), nocturna), true)
  assert.equal(dentroDeLaFranja(alas(3), nocturna), true)
  assert.equal(dentroDeLaFranja(alas(12), nocturna), false)
})

test('una franja vacía deja pasar todo', () => {
  // Es cómo se apaga la restricción sin agregar otro interruptor.
  assert.equal(dentroDeLaFranja(alas(3), { desde: '00:00', hasta: '00:00' }), true)
})

test('una hora mal escrita cae al valor por defecto en vez de romper', () => {
  assert.equal(aMinutos('8:00'), 480)
  assert.equal(aMinutos('25:00'), null)
  assert.equal(aMinutos('08:70'), null)
  assert.equal(aMinutos(''), null)
  assert.equal(aMinutos(null), null)
  // Y con basura, la franja se comporta como la de fábrica.
  assert.equal(dentroDeLaFranja(alas(3), { desde: 'cualquiera', hasta: 'cosa' }), false)
  assert.equal(dentroDeLaFranja(alas(10), { desde: 'cualquiera', hasta: 'cosa' }), true)
})

test('el comprobante de un pago NO espera a la franja', () => {
  // Quien paga a las once de la noche está esperando con el teléfono en la
  // mano. Hacerlo esperar a la mañana es peor que el mensaje de madrugada.
  assert.equal(esperaLaFranja('pago_confirmado'), false)
  assert.equal(esperaLaFranja('ticket_respuesta'), false)
})

test('la factura y el corte SÍ esperan', () => {
  assert.equal(esperaLaFranja('factura_nueva'), true)
  assert.equal(esperaLaFranja('corte_servicio'), true)
  assert.equal(esperaLaFranja('aviso_pago_1'), true)
})

test('un tipo desconocido no espera', () => {
  // Ante la duda, que salga: un aviso demorado para siempre es peor que uno a
  // deshora, porque nadie lo va a ir a buscar a la cola.
  assert.equal(esperaLaFranja('algo_nuevo'), false)
  assert.equal(esperaLaFranja(null), false)
})
