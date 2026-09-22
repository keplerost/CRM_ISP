import test from 'node:test'
import assert from 'node:assert/strict'

import { largoDeRuta, ordenarPorCercania } from '../../web/src/lib/ruta.js'

/**
 * El orden del día del técnico.
 *
 * ── Qué se protege ──
 *
 * Lo primero, y no es la optimización: que las órdenes CON HORA no se muevan.
 * Son compromisos con un abonado que está esperando. Un algoritmo que ahorre
 * tres kilómetros reordenando una cita pactada no ahorró nada — hizo llegar
 * tarde a alguien.
 *
 * Lo segundo, que las sueltas dejen de amontonarse al final. Ese era el
 * comportamiento viejo y es de donde sale el zigzag.
 *
 * ── Las coordenadas de las pruebas ──
 *
 * Están alrededor de La Maná, y separadas lo suficiente como para que el orden
 * correcto sea evidente a ojo. No se usan distancias reales de la ciudad: lo
 * que se verifica es la regla, no el mapa.
 */

// Un eje oeste→este, con ~1 km entre cada punto a esta latitud.
const P = (i) => ({ latitud: -0.94, longitud: -79.22 + i * 0.01 })

const orden = (id, extra = {}) => ({ id, ...extra })

test('las órdenes con hora conservan su orden, siempre', () => {
  const r = ordenarPorCercania([
    orden('c', { hora: '14:00', ...P(0) }),
    orden('a', { hora: '08:00', ...P(9) }),
    orden('b', { hora: '11:00', ...P(4) }),
  ])

  // Aunque el recorrido más corto sería 0 → 4 → 9, mandan las horas.
  assert.deepEqual(r.map((o) => o.id), ['a', 'b', 'c'])
})

test('las sueltas dejan de amontonarse al final', () => {
  /**
   * El caso que motivó todo: dos citas en los extremos y dos trabajos sueltos
   * en el medio. Antes salían al final —cruzar, volver, cruzar— y ahora se
   * insertan de paso.
   */
  const r = ordenarPorCercania([
    orden('cita_oeste', { hora: '09:00', ...P(0) }),
    orden('cita_este', { hora: '16:00', ...P(9) }),
    orden('suelta_3', P(3)),
    orden('suelta_6', P(6)),
  ])

  assert.deepEqual(r.map((o) => o.id), ['cita_oeste', 'suelta_3', 'suelta_6', 'cita_este'])
})

test('sin ninguna hora, se recorre de punta a punta y no en zigzag', () => {
  const desde = { lat: -0.94, lng: -79.22 }
  const r = ordenarPorCercania(
    [orden('lejos', P(8)), orden('cerca', P(1)), orden('medio', P(4))],
    { desde },
  )

  assert.deepEqual(r.map((o) => o.id), ['cerca', 'medio', 'lejos'])
})

test('el punto de partida cambia el orden, como corresponde', () => {
  const ordenes = [orden('oeste', P(0)), orden('este', P(9))]

  const desdeOeste = ordenarPorCercania(ordenes, { desde: { lat: -0.94, lng: -79.22 } })
  const desdeEste = ordenarPorCercania(ordenes, { desde: { lat: -0.94, lng: -79.13 } })

  assert.deepEqual(desdeOeste.map((o) => o.id), ['oeste', 'este'])
  assert.deepEqual(desdeEste.map((o) => o.id), ['este', 'oeste'])
})

test('una orden sin coordenada no se pierde ni se inventa dónde va', () => {
  const r = ordenarPorCercania([
    orden('ubicada', P(2)),
    orden('sin_gps', {}),
    orden('con_hora', { hora: '10:00', ...P(5) }),
  ])

  assert.equal(r.length, 3, 'no se pierde ninguna')
  // La que no se puede ubicar queda al final: meterla en el medio sería
  // inventarle una posición que nadie calculó.
  assert.equal(r.at(-1).id, 'sin_gps')
})

test('ninguna con coordenadas: no se rompe, manda la hora', () => {
  const r = ordenarPorCercania([
    orden('b', { hora: '12:00' }),
    orden('a', { hora: '08:00' }),
    orden('libre', {}),
  ])

  assert.deepEqual(r.map((o) => o.id), ['a', 'b', 'libre'])
})

test('lista vacía y nula no rompen', () => {
  assert.deepEqual(ordenarPorCercania([]), [])
  assert.deepEqual(ordenarPorCercania(null), [])
  assert.deepEqual(ordenarPorCercania(undefined), [])
})

test('no se pierde ni se duplica ninguna orden', () => {
  /**
   * La prueba aburrida y la más importante: el algoritmo hace `splice` sobre
   * el arreglo mientras lo recorre. Un error de índice ahí no se ve como un
   * error — se ve como un trabajo que desapareció de la lista del técnico.
   */
  const ordenes = [
    orden('a', { hora: '09:00', ...P(0) }),
    orden('b', P(7)),
    orden('c', { hora: '15:00', ...P(9) }),
    orden('d', P(2)),
    orden('e', {}),
    orden('f', P(5)),
  ]

  const r = ordenarPorCercania(ordenes, { desde: { lat: -0.94, lng: -79.22 } })

  assert.equal(r.length, ordenes.length)
  assert.deepEqual([...r.map((o) => o.id)].sort(), ['a', 'b', 'c', 'd', 'e', 'f'])
})

test('reordenar de verdad acorta el recorrido', () => {
  const desde = { lat: -0.94, lng: -79.22 }
  const ordenes = [
    orden('cita', { hora: '09:00', ...P(0) }),
    orden('lejana', P(9)),
    orden('cercana', P(1)),
  ]

  // Como salía antes: las sueltas al final, en el orden que vinieran.
  const viejo = largoDeRuta([ordenes[0], ordenes[1], ordenes[2]], { desde })
  const nuevo = largoDeRuta(ordenarPorCercania(ordenes, { desde }), { desde })

  assert.ok(
    nuevo.metros < viejo.metros,
    `el orden nuevo (${nuevo.metros} m) tiene que ser más corto que el viejo (${viejo.metros} m)`,
  )
})

test('el largo dice cuántos tramos pudo medir, no solo el total', () => {
  const desde = { lat: -0.94, lng: -79.22 }
  const r = largoDeRuta([orden('a', P(1)), orden('b', {}), orden('c', P(2))], { desde })

  // Tres paradas, dos medibles: decir "el recorrido son X metros" sin aclarar
  // cuántos tramos entraron daría una precisión que no existe.
  assert.equal(r.tramosMedidos, 2)
  assert.ok(r.metros > 0)
})
