import test from 'node:test'
import assert from 'node:assert/strict'

import { cuantoFalta, urgencia } from '../../web/src/lib/mantenimiento.js'

/**
 * Cuándo hay que llevar el vehículo al taller.
 *
 * ── Qué se protege ──
 *
 * Que un vehículo sin registro NO se muestre como vencido, y que uno vencido
 * de verdad no se pierda entre los que nunca se registraron. Es la diferencia
 * entre una pantalla que se mira y una que se ignora: el día que se estrena,
 * ningún vehículo tiene historial, y si todos salieran en rojo nadie volvería
 * a abrirla.
 *
 * ── Y que gane el peor de los dos criterios ──
 *
 * El aceite va por kilómetros y por meses. Un vehículo parado tres meses no
 * sumó kilómetros pero el aceite igual se degradó; uno que hizo diez mil en un
 * mes está pasado aunque el calendario diga que falta. Mirar solo uno deja
 * pasar la mitad de los casos.
 *
 * Se prueba desde acá porque `mantenimiento.js` no importa nada — el mismo
 * motivo por el que `abonados.js` también se prueba con este runner.
 */

/** Un servicio al que le falta mucho por los dos lados. */
const sano = {
  sin_registro: false,
  km_restantes: 3000,
  dias_restantes: 120,
}

test('sin registro no es lo mismo que vencido', () => {
  const nunca = { sin_registro: true, km_restantes: null, dias_restantes: null }

  assert.equal(urgencia(nunca), 'sin_registro')
  assert.notEqual(urgencia(nunca), 'vencido')
  assert.equal(cuantoFalta(nunca), 'Nunca se registró')
})

test('al día cuando falta de sobra por los dos criterios', () => {
  assert.equal(urgencia(sano), 'ok')
})

test('vence el que llegue primero: los kilómetros', () => {
  // Parado no sumó días, pero hizo los kilómetros.
  assert.equal(urgencia({ ...sano, km_restantes: -200 }), 'vencido')
  assert.equal(urgencia({ ...sano, km_restantes: 300 }), 'pronto')
})

test('vence el que llegue primero: la fecha', () => {
  // La camioneta que estuvo parada: no sumó kilómetros y el aceite venció igual.
  assert.equal(urgencia({ ...sano, dias_restantes: -5 }), 'vencido')
  assert.equal(urgencia({ ...sano, dias_restantes: 10 }), 'pronto')
})

test('un criterio vencido gana aunque el otro esté holgado', () => {
  assert.equal(urgencia({ sin_registro: false, km_restantes: 4800, dias_restantes: -1 }), 'vencido')
  assert.equal(urgencia({ sin_registro: false, km_restantes: -1, dias_restantes: 300 }), 'vencido')
})

test('el que va por un solo criterio se juzga por ese', () => {
  // La matrícula: solo fecha.
  assert.equal(urgencia({ sin_registro: false, km_restantes: null, dias_restantes: 200 }), 'ok')
  assert.equal(urgencia({ sin_registro: false, km_restantes: null, dias_restantes: -3 }), 'vencido')

  // Los filtros de un vehículo al que no se le anota odómetro: solo km.
  assert.equal(urgencia({ sin_registro: false, km_restantes: 20, dias_restantes: null }), 'pronto')
})

test('con intervalo pero sin nada medible no se acusa a nadie', () => {
  /**
   * El caso: el tipo va por kilómetros y el último servicio se anotó sin
   * odómetro. Hay registro —así que no es `sin_registro`— pero no hay contra
   * qué contar. Tiene que salir `sin_dato` y NO `vencido`: nadie hizo nada mal,
   * falta un número.
   */
  const s = { sin_registro: false, km_restantes: null, dias_restantes: null }

  assert.equal(urgencia(s), 'sin_dato')
  assert.equal(cuantoFalta(s), 'Sin datos para calcular')
})

test('el texto dice ambos criterios cuando los dos aplican', () => {
  const t = cuantoFalta({ sin_registro: false, km_restantes: 1200, dias_restantes: 45 })

  assert.match(t, /1\.200 km/)
  assert.match(t, /45 días/)
})

test('lo pasado se dice en positivo, no en negativo', () => {
  // "faltan -200 km" no lo entiende nadie.
  const t = cuantoFalta({ sin_registro: false, km_restantes: -200, dias_restantes: -3 })

  assert.match(t, /200 km pasado/)
  assert.match(t, /3 días vencido/)
  assert.doesNotMatch(t, /-/)
})

test('el borde exacto: cero es vencido, no "pronto"', () => {
  // Llegó justo al intervalo. Ya toca.
  assert.equal(urgencia({ sin_registro: false, km_restantes: 0, dias_restantes: 100 }), 'vencido')
  assert.equal(urgencia({ sin_registro: false, km_restantes: 5000, dias_restantes: 0 }), 'vencido')
})
