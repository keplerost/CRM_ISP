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

import { coincideTicket, deQuien } from '../../web/src/lib/soporte.js'

test('coincideTicket: por nombre sin tildes y en cualquier orden, por número y por cédula', () => {
  const t = {
    numero: 41, nombre: 'DORIAN SAUL MAYORGA JIMÉNEZ', identificacion: '1250579925',
    telefono: '0991234567', direccion: 'Barrio El Paraíso', cuadrilla: 'TROOPER',
  }
  assert.ok(coincideTicket(t, 'mayorga dorian'))
  assert.ok(coincideTicket(t, 'jimenez'), 'sin tilde encuentra con tilde')
  assert.ok(coincideTicket(t, 'paraiso'))
  assert.ok(coincideTicket(t, 'trooper'))
  assert.ok(coincideTicket(t, '41'))
  assert.ok(coincideTicket(t, '000041'))
  assert.ok(coincideTicket(t, '125057'), 'parte de la cédula')
  assert.ok(coincideTicket(t, '1234567'), 'parte del teléfono')
  assert.ok(coincideTicket(t, ''))
  assert.ok(!coincideTicket(t, '42'), 'otro número')
  assert.ok(!coincideTicket(t, '125'), 'tres cifras no buscan cédula: matchearía de todo')
  assert.ok(!coincideTicket(t, 'mayorga pedro'))
})

test('deQuien: lo asignado a mí es mío aunque tenga cuadrilla', () => {
  assert.equal(deQuien({ tecnico_id: 'yo', cuadrilla_id: 'c' }, 'yo'), 'mio')
  assert.equal(deQuien({ tecnico_id: null, cuadrilla_id: 'c' }, 'yo'), 'cuadrilla')
  assert.equal(deQuien({ tecnico_id: 'otro', cuadrilla_id: 'c' }, 'yo'), 'cuadrilla')
})
