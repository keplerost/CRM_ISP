import test from 'node:test'
import assert from 'node:assert/strict'

import { RESULTADOS_LLAMADA, etiquetaLlamada, llamadasDeHoy } from '../../web/src/lib/confirmaciones.js'

const local = (d, h) => new Date(`${d}T${h}:00`).toISOString()

test('la llamada de hoy de cada ticket: la última, y nunca la de ayer', () => {
  const m = llamadasDeHoy(
    [
      { ticket_id: 'a', resultado: 'no_contesta', creado_at: local('2026-11-10', '08:10') },
      { ticket_id: 'a', resultado: 'esta', creado_at: local('2026-11-10', '08:40') },
      { ticket_id: 'b', resultado: 'esta', creado_at: local('2026-11-09', '16:00') },
    ],
    '2026-11-10',
  )
  assert.equal(m.get('a').resultado, 'esta')
  assert.equal(m.has('b'), false, 'que estuviera ayer no dice nada de hoy')
})

test('solo "está en casa" deja el ticket en la ruta; las demás lo postergan', () => {
  assert.deepEqual(RESULTADOS_LLAMADA.filter((r) => !r.posterga).map((r) => r.valor), ['esta'])
  assert.equal(etiquetaLlamada('no_esta'), 'No está en casa')
})

test('para la ruta de mañana sirve la llamada de hoy; el orden para llamar sigue el día', async () => {
  const { diaAnterior, llamadasDesde, ordenParaLlamar } = await import('../../web/src/lib/confirmaciones.js')
  assert.equal(diaAnterior('2026-11-11'), '2026-11-10')
  assert.equal(diaAnterior('2026-12-01'), '2026-11-30')
  const m = llamadasDesde(
    [
      { ticket_id: 'a', resultado: 'esta', creado_at: local('2026-11-10', '16:00') },
      { ticket_id: 'b', resultado: 'esta', creado_at: local('2026-11-09', '16:00') },
    ],
    '2026-11-10',
  )
  assert.equal(m.has('a'), true)
  assert.equal(m.has('b'), false)
  const orden = [
    { id: 'tarde', franja: 'tarde' },
    { id: 'suelto' },
    { id: 'cita11', franja: 'exacta', hora: '11:00:00' },
    { id: 'manana', franja: 'manana' },
    { id: 'cita0830', franja: 'exacta', hora: '08:30' },
  ].sort(ordenParaLlamar)
  assert.deepEqual(orden.map((x) => x.id), ['cita0830', 'cita11', 'manana', 'suelto', 'tarde'])
})
