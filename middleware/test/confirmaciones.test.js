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
