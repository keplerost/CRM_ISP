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

// --- Orden automático (plazos + cercanía) ------------------------------------

import { ordenarRutaAutomatica } from '../../web/src/lib/ruta.js'

/**
 * Un pueblo en línea: la oficina en 0, un sector al norte (0.01–0.012) y otro
 * al sur (-0.02). Una centésima de grado son ~1,1 km.
 */
const Q = (id, lat, extra = {}) => ({ tipo: 'ticket', id, latitud: lat, longitud: -79.3, ...extra })
const AHORA_R = new Date('2026-11-09T14:00:00Z')

test('los del mismo sector quedan seguidos, sin cruzar dos veces', () => {
  const r = ordenarRutaAutomatica(
    [Q('norte1', 0.01), Q('sur', -0.02), Q('norte2', 0.011), Q('norte3', 0.012)],
    { desde: { lat: 0, lng: -79.3 }, ahora: AHORA_R },
  )
  const ids = r.map((i) => i.id)
  const norte = ids.filter((x) => x.startsWith('norte')).map((x) => ids.indexOf(x))
  assert.equal(Math.max(...norte) - Math.min(...norte), 2, 'los tres del norte tienen que ir juntos')
})

test('lo urgente va primero aunque esté lejos: plazo por vencer o prioridad alta', () => {
  const vence = (i) => (i.id === 'lejos_vence' ? new Date(AHORA_R.getTime() + 30 * 60000) : null)
  const r = ordenarRutaAutomatica(
    [Q('cerca', 0.001), Q('lejos_vence', -0.05), Q('alta', 0.03, { prioridad: 'alta' })],
    { vence, desde: { lat: 0, lng: -79.3 }, ahora: AHORA_R },
  )
  assert.deepEqual(new Set(r.slice(0, 2).map((i) => i.id)), new Set(['lejos_vence', 'alta']))
  assert.equal(r[2].id, 'cerca')
})

test('lo que está en curso no se mueve, y la franja de la tarde va al final', () => {
  const r = ordenarRutaAutomatica(
    [Q('tarde', 0.001, { franja: 'tarde' }), Q('curso', 0.05, { en_curso: true }), Q('libre', 0.002)],
    { desde: { lat: 0, lng: -79.3 }, ahora: AHORA_R },
  )
  assert.deepEqual(r.map((i) => i.id), ['curso', 'libre', 'tarde'])
})

test('una cita temprana no queda detrás de trabajos sueltos ni de urgentes', () => {
  // El caso de TROOPER: la reconexión de las 08:30 salía en el puesto 14.
  const sueltos = Array.from({ length: 6 }, (_, k) => Q(`s${k}`, 0.001 * (k + 1), { franja: 'manana' }))
  const r = ordenarRutaAutomatica(
    [...sueltos, Q('alta', 0.002, { prioridad: 'alta' }), Q('cita', 0.05, { franja: 'exacta', hora: '08:30:00' })],
    { desde: { lat: 0, lng: -79.3 }, ahora: AHORA_R },
  )
  assert.equal(r[0].id, 'cita')
})

test('una cita a las 10:00 tiene delante a lo sumo las paradas que entran antes', () => {
  const sueltos = Array.from({ length: 6 }, (_, k) => Q(`s${k}`, 0.001 * (k + 1)))
  const r = ordenarRutaAutomatica([...sueltos, Q('cita', 0.05, { franja: 'exacta', hora: '10:00' })], {
    desde: { lat: 0, lng: -79.3 },
    ahora: AHORA_R,
  })
  // 08:00 + 2 × 45 min = 09:30: entran dos antes, la tercera ya no.
  assert.ok(r.findIndex((i) => i.id === 'cita') <= 2)
})

test('lo que está en curso sigue primero, aun con una cita temprana', () => {
  const r = ordenarRutaAutomatica(
    [Q('cita', 0.05, { franja: 'exacta', hora: '08:30' }), Q('curso', 0.01, { en_curso: true }), Q('libre', 0.002)],
    { desde: { lat: 0, lng: -79.3 }, ahora: AHORA_R },
  )
  assert.deepEqual(r.map((i) => i.id), ['curso', 'cita', 'libre'])
})

test('prioridad alta para la tarde no pasa adelante de la mañana: va primera en la tarde', () => {
  // El caso del N° 47: alta, "visitar después del medio día", salía primera a las 9.
  const r = ordenarRutaAutomatica(
    [
      Q('m1', 0.01, { franja: 'manana' }),
      Q('t1', 0.002, { franja: 'tarde' }),
      Q('alta_tarde', 0.05, { franja: 'tarde', prioridad: 'alta' }),
      Q('m2', 0.02, { franja: 'manana' }),
    ],
    { desde: { lat: 0, lng: -79.3 }, ahora: AHORA_R },
  )
  assert.deepEqual(r.map((i) => i.id).slice(2), ['alta_tarde', 't1'])
  assert.deepEqual(new Set(r.slice(0, 2).map((i) => i.id)), new Set(['m1', 'm2']))
})

test('una cita "exacta" de la tarde va con la tarde, no con la mañana', () => {
  const r = ordenarRutaAutomatica(
    [Q('cita', 0.001, { franja: 'exacta', hora: '16:00' }), Q('m1', 0.01, { franja: 'manana' }), Q('m2', 0.02, { franja: 'manana' })],
    { desde: { lat: 0, lng: -79.3 }, ahora: AHORA_R },
  )
  assert.equal(r.at(-1).id, 'cita')
})

test('las citas nunca se bajan, y entre ellas conservan su hora', async () => {
  const { respetarHoras } = await import('../../web/src/lib/ruta.js')
  const r = respetarHoras([{ id: 'a' }, { id: 'b' }, { id: 'c9', hora: '09:00' }, { id: 'c8', hora: '08:20' }, { id: 'd' }])
  assert.deepEqual(r.map((o) => o.id), ['c8', 'c9', 'a', 'b', 'd'])
  const tarde = respetarHoras([{ id: 'c', hora: '15:00' }, { id: 'a' }])
  assert.deepEqual(tarde.map((o) => o.id), ['c', 'a'])
})

test('los que no tienen coordenadas quedan al final de su tramo, no se inventan', () => {
  const r = ordenarRutaAutomatica([{ tipo: 'ticket', id: 'sin' }, Q('con', 0.01)], { ahora: AHORA_R })
  assert.deepEqual(r.map((i) => i.id), ['con', 'sin'])
})

test('coordenadas pegadas: como MikroWISP, con espacio o desde Google Maps', async () => {
  const { coordenadasDeTexto } = await import('../../web/src/lib/ruta.js')
  assert.deepEqual(coordenadasDeTexto('-0.815962, -79.281162'), { lat: '-0.815962', lng: '-79.281162' })
  assert.deepEqual(coordenadasDeTexto('-0.815962 -79.281162'), { lat: '-0.815962', lng: '-79.281162' })
  assert.deepEqual(
    coordenadasDeTexto('https://www.google.com/maps?q=-0.8159,-79.2811'),
    { lat: '-0.8159', lng: '-79.2811' },
  )
  assert.deepEqual(
    coordenadasDeTexto('https://www.google.com/maps/@-0.8159,-79.2811,17z'),
    { lat: '-0.8159', lng: '-79.2811' },
  )
  assert.equal(coordenadasDeTexto('-0.815962'), null)
  assert.equal(coordenadasDeTexto('Av. Principal 123'), null)
})

import { MAX_PARADAS_GOOGLE, enlaceRutaGoogle } from '../../web/src/lib/ruta.js'

test('enlaceRutaGoogle: las paradas en orden, la última como destino', () => {
  const r = enlaceRutaGoogle([
    { latitud: -0.94, longitud: -79.23 },
    { latitud: null, longitud: null }, // sin ubicación: se salta
    { latitud: -0.95, longitud: -79.24 },
    { latitud: -0.96, longitud: -79.25 },
  ])
  assert.equal(r.incluidas, 3)
  assert.equal(r.total, 3)
  assert.match(r.url, /destination=-0\.96,-79\.25/)
  assert.match(r.url, new RegExp(`waypoints=${encodeURIComponent('-0.94,-79.23|-0.95,-79.24')}`))
  assert.doesNotMatch(r.url, /origin=/, 'arranca desde donde está el teléfono')
})

test('enlaceRutaGoogle: con más de las que acepta Google, el primer tramo', () => {
  const muchas = Array.from({ length: 16 }, (_, i) => ({ latitud: -0.9 - i / 100, longitud: -79.2 }))
  const r = enlaceRutaGoogle(muchas)
  assert.equal(r.incluidas, MAX_PARADAS_GOOGLE)
  assert.equal(r.total, 16)
  assert.equal(enlaceRutaGoogle([{ latitud: null, longitud: null }]), null)
  assert.equal(enlaceRutaGoogle([{ latitud: '', longitud: '' }]), null)
})

import { esCoordenada } from '../../web/src/lib/ruta.js'

test('esCoordenada: null y vacío no son el punto 0,0', () => {
  assert.equal(esCoordenada(null), false)
  assert.equal(esCoordenada(undefined), false)
  assert.equal(esCoordenada(''), false)
  assert.equal(esCoordenada('abc'), false)
  assert.equal(esCoordenada(-0.94), true)
  assert.equal(esCoordenada('-79.24'), true)
  // Un tramo con una parada sin ubicación no suma kilómetros hasta el 0,0.
  const { metros } = largoDeRuta([
    { latitud: -0.94, longitud: -79.23 },
    { latitud: '', longitud: '' },
    { latitud: -0.95, longitud: -79.24 },
  ])
  assert.ok(metros < 5000, `${metros} m`)
})

import { trabajosCercanos } from '../../web/src/lib/ruta.js'

test('trabajosCercanos: los de la zona, del más cercano al más lejano, sin el propio', () => {
  const aqui = { latitud: -0.94, longitud: -79.24 }
  const lista = [
    { id: 'lejos', latitud: -0.80, longitud: -79.28 }, // ~15 km
    { id: 'cerca', latitud: -0.941, longitud: -79.241 }, // ~150 m
    { id: 'medio', latitud: -0.95, longitud: -79.245 }, // ~1.2 km
    { id: 'yo', latitud: -0.94, longitud: -79.24 },
    { id: 'sin', latitud: null, longitud: null },
  ]
  const r = trabajosCercanos(aqui, lista, { excluir: 'yo' })
  assert.deepEqual(r.map((t) => t.id), ['cerca', 'medio'])
  assert.ok(r[0].metros < 300)
  assert.deepEqual(trabajosCercanos({ latitud: '', longitud: '' }, lista), [], 'sin ubicación no busca')
})

import { agruparPorLugar } from '../../web/src/lib/ruta.js'

test('agruparPorLugar: dos tickets del mismo abonado son una sola marca "4·6"', () => {
  const l = agruparPorLugar([
    { n: 3, lat: -0.95, lng: -79.25 },
    { n: 4, lat: -0.966208, lng: -79.258549 },
    { n: 5, lat: null, lng: null },
    { n: 6, lat: '-0.966208', lng: '-79.258549' },
  ])
  assert.equal(l.length, 2)
  assert.deepEqual(l.map((x) => x.numeros), [[3], [4, 6]])
  assert.equal(l[1].puntos.length, 2)
})
