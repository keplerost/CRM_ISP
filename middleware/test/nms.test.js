import test from 'node:test'
import assert from 'node:assert/strict'

import { ordenarPorJerarquia, evaluar, mensajeDe } from '../src/services/nms.js'

/**
 * La lógica que decide si algo está caído y a quién se le avisa.
 *
 * Es la parte del monitoreo que no se puede probar contra la red: para ver el
 * caso que importa —una torre que cae y arrastra veinte antenas— habría que
 * cortarle la fibra a una torre de verdad.
 */

// --- Orden del árbol ---------------------------------------------------------

const TORRE = { id: 't', nombre: 'Torre Centro', padre_id: null }
const SECTOR = { id: 's', nombre: 'Sector Norte', padre_id: 't' }
const CPE = { id: 'c', nombre: 'CPE 42', padre_id: 's' }
const SUELTO = { id: 'x', nombre: 'Enlace PTP', padre_id: null }

test('los padres se sondean antes que los hijos', () => {
  // Si el hijo se evalúa primero, el padre todavía figura arriba y la caída del
  // hijo se reporta como propia: veinte alertas por un solo corte de fibra.
  const orden = ordenarPorJerarquia([CPE, TORRE, SECTOR]).map((n) => n.id)
  assert.deepEqual(orden, ['t', 's', 'c'])
})

test('los nodos del mismo nivel salen por nombre', () => {
  const orden = ordenarPorJerarquia([SUELTO, TORRE]).map((n) => n.nombre)
  assert.deepEqual(orden, ['Enlace PTP', 'Torre Centro'])
})

test('un ciclo de carga no cuelga el sondeo', () => {
  // "A es padre de B y B es padre de A" es un error de carga que la base no
  // puede prohibir sin un disparador recursivo. Acá no puede colgar el bucle.
  const a = { id: 'a', nombre: 'A', padre_id: 'b' }
  const b = { id: 'b', nombre: 'B', padre_id: 'a' }
  const r = ordenarPorJerarquia([a, b])
  assert.equal(r.length, 2)
})

test('un padre que no existe no rompe el orden', () => {
  // Pasa al borrar un nodo: el hijo queda apuntando a nada.
  const huerfano = { id: 'h', nombre: 'Huérfano', padre_id: 'no-existe' }
  const r = ordenarPorJerarquia([huerfano, TORRE])
  assert.equal(r.length, 2)
})

test('una lista vacía devuelve una lista vacía', () => {
  assert.deepEqual(ordenarPorJerarquia([]), [])
})

// --- Evaluación de una medición ----------------------------------------------

const NODO = { latencia_warning_ms: 150, perdida_warning_pct: 20 }

test('todo responde y rápido: up', () => {
  const r = evaluar({ enviados: 4, recibidos: 4, latencia_ms: 12 }, NODO)
  assert.equal(r.estado, 'up')
  assert.equal(r.perdida_pct, 0)
})

test('nada responde: down', () => {
  const r = evaluar({ enviados: 4, recibidos: 0, latencia_ms: null }, NODO)
  assert.equal(r.estado, 'down')
  assert.equal(r.perdida_pct, 100)
})

test('responde pero con pérdida alta: warning, no down', () => {
  // El enlace está. Decir "caído" mandaría un técnico a buscar un corte que no
  // existe.
  const r = evaluar({ enviados: 4, recibidos: 3, latencia_ms: 20 }, NODO)
  assert.equal(r.estado, 'warning')
  assert.equal(r.perdida_pct, 25)
})

test('responde pero lento: warning', () => {
  const r = evaluar({ enviados: 4, recibidos: 4, latencia_ms: 300 }, NODO)
  assert.equal(r.estado, 'warning')
})

test('cada nodo tiene su propio umbral', () => {
  // Un PTP de 60 GHz a 2 ms y una sectorial saturada a 120 ms son las dos cosas
  // normales. Con un umbral único habría que elegir cuál ignorar.
  const medicion = { enviados: 4, recibidos: 4, latencia_ms: 120 }
  assert.equal(evaluar(medicion, { latencia_warning_ms: 50, perdida_warning_pct: 20 }).estado, 'warning')
  assert.equal(evaluar(medicion, { latencia_warning_ms: 200, perdida_warning_pct: 20 }).estado, 'up')
})

test('no haber podido preguntar no es estar caído', () => {
  // Si el router intermedio no contestó, no se sabe nada del nodo. Reportarlo
  // como caído mandaría un técnico a una torre que está perfecta.
  const r = evaluar({ enviados: 0, recibidos: 0, latencia_ms: null }, NODO)
  assert.equal(r.estado, 'desconocido')
  assert.equal(r.perdida_pct, null)
})

// --- El aviso ----------------------------------------------------------------

const CUANDO = '2026-08-02T14:35:20.000Z'

test('el aviso de caída dice qué, dónde y desde cuándo', () => {
  const t = mensajeDe({ nombre: 'Torre Centro', ip: '10.0.0.1', punto: 'Cerro Alto' }, 'down', CUANDO)
  assert.match(t, /CAÍDO/)
  assert.match(t, /Torre Centro/)
  assert.match(t, /Cerro Alto/)
  assert.match(t, /10\.0\.0\.1/)
  assert.match(t, /Desde:/)
})

test('el de recuperación dice cuánto estuvo caído', () => {
  const t = mensajeDe({ nombre: 'Torre Centro', ip: '10.0.0.1' }, 'up', CUANDO, 47)
  assert.match(t, /RECUPERADO/)
  assert.match(t, /47 min/)
})

test('un nodo sin punto cargado no deja un separador suelto', () => {
  const t = mensajeDe({ nombre: 'PTP Norte', ip: '10.0.0.9' }, 'down', CUANDO)
  assert.ok(!t.includes(' · \n'), t)
  assert.match(t, /10\.0\.0\.9/)
})
