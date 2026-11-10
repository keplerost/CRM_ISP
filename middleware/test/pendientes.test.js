import test from 'node:test'
import assert from 'node:assert/strict'

import {
  esDelMismoAbonado,
  estadoPendiente,
  etiquetaPendiente,
  ordenarPendientes,
  pareceAdministrativo,
} from '../../web/src/lib/pendientes.js'

const HOY = '2026-11-10'

test('estadoPendiente: hecho, vencido, hoy, próximo y sin fecha', () => {
  assert.equal(estadoPendiente({ hecho_at: '2026-11-09T10:00:00Z', vence_el: '2026-11-01' }, HOY), 'hecho')
  assert.equal(estadoPendiente({ vence_el: '2026-11-09' }, HOY), 'vencido')
  assert.equal(estadoPendiente({ vence_el: '2026-11-10' }, HOY), 'hoy')
  assert.equal(estadoPendiente({ vence_el: '2026-11-12' }, HOY), 'proximo')
  assert.equal(estadoPendiente({ vence_el: null }, HOY), 'sin_fecha')
})

test('ordenarPendientes: lo vencido arriba, lo hecho abajo', () => {
  const r = ordenarPendientes(
    [
      { id: 'hecho', hecho_at: '2026-11-09T10:00:00Z' },
      { id: 'sin', vence_el: null },
      { id: 'prox', vence_el: '2026-11-15' },
      { id: 'venc', vence_el: '2026-11-01' },
      { id: 'hoy', vence_el: HOY },
    ],
    HOY,
  )
  assert.deepEqual(r.map((p) => p.id), ['venc', 'hoy', 'prox', 'sin', 'hecho'])
})

test('esDelMismoAbonado: por ficha, por cédula o por nombre sin tildes', () => {
  assert.ok(esDelMismoAbonado({ client_id: 'c1' }, { client_id: 'c1' }))
  assert.ok(!esDelMismoAbonado({ client_id: 'c1', nombre: 'Ana' }, { client_id: 'c2', nombre: 'Ana' }), 'fichas distintas mandan')
  assert.ok(esDelMismoAbonado({ identificacion: '1250579925', nombre: 'X' }, { identificacion: '125057992-5', nombre: 'Y' }))
  assert.ok(esDelMismoAbonado({ nombre: 'JOEL ALEXANDER DELGADO QUIJIJE' }, { nombre: 'Joel  Alexander Delgado Quijije' }))
  assert.ok(esDelMismoAbonado({ nombre: 'José Acosta' }, { nombre: 'JOSE ACOSTA' }))
  assert.ok(!esDelMismoAbonado({ nombre: 'Joel Delgado' }, { nombre: 'Joel Delgado Quijije' }), 'nombre parcial no alcanza')
  assert.ok(!esDelMismoAbonado({ nombre: '' }, { nombre: '' }))
})

test('pareceAdministrativo: los tickets de la base que no eran soporte', () => {
  assert.ok(pareceAdministrativo({ descripcion: 'cambiar a $23.10' }))
  assert.ok(pareceAdministrativo({ descripcion: 'RECONEXION MAÑANA 8:30 AM' }))
  assert.ok(pareceAdministrativo({ descripcion: 'Hacer firmar el contrato' }))
  assert.ok(pareceAdministrativo({ descripcion: 'pedir copia de cédula' }))
  assert.ok(pareceAdministrativo({ incidencia_otro: 'Cambio de plan a 100 Mb' }))
  // Lo que sí es soporte, no.
  assert.ok(!pareceAdministrativo({ descripcion: 'No Tiene Internet' }))
  assert.ok(!pareceAdministrativo({ descripcion: 'Cambio De Contraseña En Router Wifi' }))
  assert.ok(!pareceAdministrativo({ descripcion: 'RETIRO DE EQUIPO' }))
  assert.equal(etiquetaPendiente('firma_contrato'), 'Firma del contrato')
})

test('etiquetaPendiente: "Otro" con lo que se escribió', () => {
  assert.equal(etiquetaPendiente('otro', 'entregar factura impresa'), 'Otro: entregar factura impresa')
  assert.equal(etiquetaPendiente('otro', '  '), 'Otro')
  assert.equal(etiquetaPendiente('otro'), 'Otro')
  assert.equal(etiquetaPendiente('cobro', 'algo viejo'), 'Cobro', 'solo con "Otro"')
})
