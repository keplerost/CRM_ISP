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

// --- Personal en campo (panel) ----------------------------------------------

import { personalEnCampo } from '../../web/src/lib/soporte.js'

test('personal en campo: cuenta tickets propios, de su cuadrilla e instalaciones', () => {
  const tecnicos = [
    { id: 'byron', nombre: 'Byron' },
    { id: 'david', nombre: 'David' },
    { id: 'john', nombre: 'John' },
    { id: 'adonis', nombre: 'Adonis' },
  ]
  const miembros = [
    { cuadrilla_id: 'trooper', tecnico_id: 'byron' },
    { cuadrilla_id: 'trooper', tecnico_id: 'david' },
  ]
  const tickets = [
    { estado: 'asignado', tecnico_id: null, cuadrilla_id: 'trooper', nombre: 'A' },
    { estado: 'en_proceso', tecnico_id: 'byron', cuadrilla_id: null, nombre: 'Roddy' },
    { estado: 'resuelto', tecnico_id: null, cuadrilla_id: 'trooper', nombre: 'B' },
    { estado: 'cancelado', tecnico_id: 'john', nombre: 'X' },
  ]
  const instalaciones = [{ estado: 'en_ruta', tecnico_id: 'john', cliente: 'Nueva' }]

  const r = personalEnCampo(tecnicos, { tickets, instalaciones, miembros })
  const de = Object.fromEntries(r.map((p) => [p.id, p]))

  assert.equal(de.byron.estado, 'en_sitio')
  assert.equal(de.byron.actual, 'Roddy')
  assert.equal(de.byron.total, 3)
  // David no tiene el de Byron, pero sí los de la cuadrilla.
  assert.equal(de.david.estado, 'con_ruta')
  assert.deepEqual([de.david.total, de.david.hechas, de.david.pendientes], [2, 1, 1])
  assert.equal(de.john.estado, 'en_camino')
  assert.equal(de.john.total, 1, 'el cancelado no cuenta')
  assert.equal(de.adonis.estado, 'libre')
  assert.deepEqual(r.map((p) => p.id), ['byron', 'john', 'david', 'adonis'])
})

test('personal en campo: la ausencia, el medio día, la jornada cerrada y el que no ingresó', () => {
  const tecnicos = [
    { id: 'adonis', nombre: 'Adonis' },
    { id: 'byron', nombre: 'Byron', horario: 'manana' },
    { id: 'david', nombre: 'David' },
    { id: 'edu', nombre: 'Edu' },
  ]
  const miembros = ['adonis', 'byron', 'david', 'edu'].map((t) => ({ cuadrilla_id: 'trooper', tecnico_id: t }))
  const tickets = [{ estado: 'en_proceso', tecnico_id: null, cuadrilla_id: 'trooper', nombre: 'Guido' }]
  const ausencias = [{ tecnico_id: 'david', tipo: 'descanso_medico', hasta: '2026-11-15' }]
  const jornadas = [
    { tecnico_id: 'adonis', inicio_at: '2026-11-10T13:10:00Z', fin_at: null },
    { tecnico_id: 'byron', inicio_at: '2026-11-10T13:10:00Z', fin_at: null },
  ]
  const datos = { tickets, miembros, ausencias, jornadas }

  // A las 10: Byron trabaja, David en reposo, Edu no ingresó con su cuadrilla.
  let de = Object.fromEntries(
    personalEnCampo(tecnicos, { ...datos, ahora: new Date(2026, 10, 10, 10, 0) }).map((p) => [p.id, p]),
  )
  assert.equal(de.adonis.estado, 'en_sitio')
  assert.equal(de.byron.estado, 'en_sitio')
  assert.equal(de.david.estado, 'ausente')
  assert.match(de.david.detalle, /Descanso médico hasta el 15\/11/)
  assert.equal(de.edu.estado, 'sin_ingreso')

  // A las 14: Byron, de medio día, ya no está.
  de = Object.fromEntries(
    personalEnCampo(tecnicos, { ...datos, ahora: new Date(2026, 10, 10, 14, 0) }).map((p) => [p.id, p]),
  )
  assert.equal(de.byron.estado, 'fuera_horario')
  assert.equal(de.byron.detalle, 'Solo mañana')

  // Si cerró la jornada, "Terminó"; y si tiene algo a su nombre en curso, se muestra igual.
  const r = personalEnCampo(tecnicos, {
    ...datos,
    jornadas: [...jornadas.slice(0, 1), { tecnico_id: 'byron', inicio_at: '2026-11-10T13:10:00Z', fin_at: '2026-11-10T18:00:00Z' }],
    tickets: [...tickets, { estado: 'en_ruta', tecnico_id: 'edu', nombre: 'Suyo' }],
    ahora: new Date(2026, 10, 10, 12, 0),
  })
  de = Object.fromEntries(r.map((p) => [p.id, p]))
  assert.equal(de.byron.estado, 'termino')
  assert.equal(de.edu.estado, 'en_camino')
  assert.equal(r.at(-1).id, 'david', 'el ausente va al final')
})
