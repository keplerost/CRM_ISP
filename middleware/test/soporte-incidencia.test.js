import test from 'node:test'
import assert from 'node:assert/strict'
import { etiquetaIncidencia } from '../../web/src/lib/soporte.js'

test('etiquetaIncidencia: "Otro" con el detalle de cuál (migración 221)', () => {
  assert.equal(etiquetaIncidencia('otro', 'cambio de router'), 'Otro: cambio de router')
  assert.equal(etiquetaIncidencia('otro', '  '), 'Otro', 'un detalle vacío no deja "Otro: "')
  assert.equal(etiquetaIncidencia('otro'), 'Otro')
  // El detalle solo vale con "Otro": un tipo de la lista se nombra solo.
  assert.equal(etiquetaIncidencia('lentitud', 'algo viejo'), 'Lentitud')
  assert.equal(etiquetaIncidencia(null), '—')
})
