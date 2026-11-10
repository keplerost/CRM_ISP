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

import { grupoDeCampo, hoyLocal } from '../../web/src/lib/soporte.js'

test('grupoDeCampo: "para hoy" es lo mismo que la ruta del día; lo de otro día va aparte', () => {
  const HOY = '2026-11-10'
  assert.equal(grupoDeCampo({ estado: 'asignado', fecha_visita: '2026-11-10' }, HOY), 'hoy')
  assert.equal(grupoDeCampo({ estado: 'asignado', fecha_visita: '2026-11-08' }, HOY), 'hoy', 'atrasado: es para hoy')
  assert.equal(grupoDeCampo({ estado: 'asignado', fecha_visita: null }, HOY), 'hoy', 'sin fecha: es para hoy')
  assert.equal(grupoDeCampo({ estado: 'asignado', fecha_visita: '2026-11-12' }, HOY), 'proximos')
  assert.equal(
    grupoDeCampo({ estado: 'asignado', fecha_visita: null, reprogramar_desde: '2026-11-09T15:00:00Z' }, HOY),
    'proximos',
    'esperando fecha nueva: no está en la ruta de hoy',
  )
  // En curso aunque la fecha sea otra: si ya salió, es lo de ahora.
  assert.equal(grupoDeCampo({ estado: 'en_ruta', fecha_visita: '2026-11-12' }, HOY), 'curso')
  assert.equal(grupoDeCampo({ estado: 'resuelto' }, HOY), 'cerrados')
  assert.equal(grupoDeCampo({ estado: 'abierto' }, HOY), null, 'sin asignar no es del técnico')
})

test('hoyLocal: la fecha del teléfono, no la de UTC', () => {
  // 22:30 del 9 en Ecuador ya es el 10 en UTC.
  const tarde = new Date(2026, 10, 9, 22, 30)
  assert.equal(hoyLocal(tarde), '2026-11-09')
})
