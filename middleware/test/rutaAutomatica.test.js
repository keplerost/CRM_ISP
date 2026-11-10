import test from 'node:test'
import assert from 'node:assert/strict'

import { ordenarRutas, planDeRuta } from '../src/services/rutaAutomatica.js'

// Tres paradas en una línea norte-sur, cargadas en zigzag: A (sur), C (norte), B (medio).
const A = { tipo: 'ticket', id: 'a', latitud: -0.96, longitud: -79.25, franja: 'manana', prioridad: 'media' }
const B = { tipo: 'ticket', id: 'b', latitud: -0.93, longitud: -79.25, franja: 'manana', prioridad: 'media' }
const C = { tipo: 'ticket', id: 'c', latitud: -0.88, longitud: -79.25, franja: 'manana', prioridad: 'media' }

test('planDeRuta: el zigzag sale ordenado por cercanía', () => {
  const plan = planDeRuta([A, C, B])
  const ids = plan.map((p) => p.id)
  // B queda entre A y C, en cualquiera de los dos sentidos.
  assert.equal(ids[1], 'b', ids.join(' '))
  assert.deepEqual(plan[0], { tipo: 'ticket', id: ids[0] })
})

test('planDeRuta: da el mismo orden venga como venga la lista (no se da vuelta entre pasadas)', () => {
  const uno = planDeRuta([A, C, B]).map((p) => p.id)
  const otro = planDeRuta([C, B, A]).map((p) => p.id)
  const tercero = planDeRuta([B, A, C]).map((p) => p.id)
  assert.deepEqual(uno, otro)
  assert.deepEqual(uno, tercero)
})

test('planDeRuta: si ya está en ese orden y fijada, no se reescribe', () => {
  const fijados = planDeRuta([A, C, B]).map((p) => ({ ...[A, B, C].find((x) => x.id === p.id), orden_fijado: true }))
  assert.equal(planDeRuta(fijados), null)
  // El mismo orden pero sin fijar: se guarda, para que la base lo tenga.
  assert.ok(planDeRuta(fijados.map((i) => ({ ...i, orden_fijado: false }))))
  assert.equal(planDeRuta([]), null)
})

test('planDeRuta: lo que está en curso sigue primero, aunque quede lejos', () => {
  const plan = planDeRuta([{ ...C, en_curso: true }, A, B])
  assert.equal(plan[0].id, 'c')
  assert.equal(plan[1].id, 'b', 'desde C, lo más cerca es B')
})

/** Una base de mentira: lo justo que usa `ordenarRutas`. */
function base({ grupos, items, plazos = [] }) {
  const guardados = []
  return {
    guardados,
    rpc: async (fn, args) => {
      if (fn === 'rutas_a_ordenar') return { data: grupos, error: null }
      if (fn === 'items_de_ruta') return { data: items[args.p_cuadrillas[0] ?? args.p_tecnicos[0]] ?? [], error: null }
      if (fn === 'ordenar_ruta_auto') {
        guardados.push(args.p_items)
        return { data: args.p_items.length, error: null }
      }
      return { data: null, error: { message: `no existe ${fn}` } }
    },
    from: () => ({ select: () => ({ in: async () => ({ data: plazos, error: null }) }) }),
  }
}

test('ordenarRutas: ordena las rutas automáticas y deja quietas las manuales', async () => {
  const cliente = base({
    grupos: [
      { clase: 'cuadrilla', id: 'cu1', nombre: 'TROOPER', hoy: '2026-11-10', tecnicos: ['t1'], cuadrillas: ['cu1'], manual: false },
      { clase: 'cuadrilla', id: 'cu2', nombre: 'MAZDA', hoy: '2026-11-10', tecnicos: ['t2'], cuadrillas: ['cu2'], manual: true },
    ],
    items: { cu1: [A, C, B], cu2: [A, C, B] },
  })
  const r = await ordenarRutas({ cliente })
  assert.deepEqual(r.manuales, ['MAZDA'])
  assert.equal(r.ordenadas.length, 1)
  assert.equal(cliente.guardados.length, 1, 'la manual no se guarda')
  assert.equal(cliente.guardados[0][1].id, 'b')
})

test('ordenarRutas: lo que vence pronto pasa adelante aunque quede lejos', async () => {
  const ahora = new Date('2026-11-10T15:00:00Z')
  const cliente = base({
    grupos: [{ clase: 'tecnico', id: 't1', nombre: 'Byron', hoy: '2026-11-10', tecnicos: ['t1'], cuadrillas: [], manual: false }],
    items: { t1: [A, B, C] },
    plazos: [{ id: 'c', vence_at: '2026-11-10T15:30:00Z' }],
  })
  await ordenarRutas({ cliente, ahora })
  assert.equal(cliente.guardados[0][0].id, 'c')
})

test('ordenarRutas: un error en una ruta no frena las otras', async () => {
  const cliente = base({
    grupos: [
      { clase: 'tecnico', id: 'x', nombre: 'Rota', hoy: '2026-11-10', tecnicos: ['x'], cuadrillas: [], manual: false },
      { clase: 'tecnico', id: 't1', nombre: 'Byron', hoy: '2026-11-10', tecnicos: ['t1'], cuadrillas: [], manual: false },
    ],
    items: { t1: [A, C, B] },
  })
  const rpc = cliente.rpc
  cliente.rpc = async (fn, args) =>
    fn === 'items_de_ruta' && args.p_tecnicos[0] === 'x' ? { data: null, error: { message: 'falló' } } : rpc(fn, args)
  const r = await ordenarRutas({ cliente })
  assert.equal(r.errores.length, 1)
  assert.equal(r.ordenadas.length, 1)
})
