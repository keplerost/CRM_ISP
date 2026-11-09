import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MOTIVOS_DEMORA,
  estadoPlazo,
  horasDePlazo,
  pideJustificacion,
  tipoDeInstalacion,
  venceEl,
} from '../../web/src/lib/plazos.js'

/**
 * El plazo que ve el técnico en su app (migración 219).
 *
 * Tiene que dar lo mismo que `v_plazos_trabajo` en la base: si la app dice
 * "faltan 20 minutos" y el tablero lo cuenta fuera de plazo, el técnico deja de
 * creerle a la app.
 */

const PLAZOS = [
  { clave: 'sin_internet', horas: 4 },
  { clave: 'lentitud', horas: 24 },
  { clave: 'instalacion', horas: 72 },
  { clave: 'otro', horas: 48 },
]

test('el vencimiento es registrado + horas del tipo', () => {
  const t = { created_at: '2026-11-09T08:00:00Z', tipo_incidencia: 'sin_internet' }
  assert.equal(venceEl(t, PLAZOS, 'ticket').toISOString(), '2026-11-09T12:00:00.000Z')
})

test('las instalaciones usan su tipo: nueva es instalación, lo demás "otro"', () => {
  assert.equal(tipoDeInstalacion('nueva'), 'instalacion')
  assert.equal(tipoDeInstalacion('traslado'), 'traslado')
  assert.equal(tipoDeInstalacion('revision'), 'otro')

  const o = { created_at: '2026-11-09T08:00:00Z', tipo: 'nueva' }
  assert.equal(venceEl(o, PLAZOS, 'instalacion').toISOString(), '2026-11-12T08:00:00.000Z')
})

test('un tipo sin plazo usa el de "otro", y sin "otro" un día', () => {
  assert.equal(horasDePlazo('cambio_clave', PLAZOS), 48)
  assert.equal(horasDePlazo('cambio_clave', []), 24)
})

test('sin fecha de registro no hay vencimiento ni se pide justificar', () => {
  assert.equal(venceEl({ tipo_incidencia: 'lentitud' }, PLAZOS), null)
  assert.equal(pideJustificacion(null), false)
})

test('estado del plazo: ok, cerca (≤ 1 h) y vencido', () => {
  const ahora = new Date('2026-11-09T10:00:00Z')
  assert.equal(estadoPlazo('2026-11-09T12:00:00Z', ahora).nivel, 'ok')
  assert.equal(estadoPlazo('2026-11-09T10:45:00Z', ahora).nivel, 'cerca')
  const v = estadoPlazo('2026-11-09T09:30:00Z', ahora)
  assert.equal(v.nivel, 'vencido')
  assert.equal(v.min, -30)
})

test('se pide justificar solo si se llega después del vencimiento', () => {
  const vence = new Date('2026-11-09T12:00:00Z')
  assert.equal(pideJustificacion(vence, new Date('2026-11-09T11:59:00Z')), false)
  assert.equal(pideJustificacion(vence, new Date('2026-11-09T12:01:00Z')), true)
})

test('los motivos son los mismos que admite la base', () => {
  const sql = MOTIVOS_DEMORA.map((m) => m.valor).sort()
  assert.deepEqual(sql, ['asignado_tarde', 'cliente', 'clima', 'material', 'otro', 'trabajo_anterior', 'vehiculo'])
})

test('el desglose dice de quién fue el atraso', async () => {
  const { desgloseFuera } = await import('../../web/src/lib/plazos.js')
  assert.equal(desgloseFuera({ fuera_plazo: 0 }), null)
  assert.equal(
    desgloseFuera({ fuera_plazo: 4, motivos: { cliente: 1, asignado_tarde: 2 }, sin_justificar: 1, esperando: 0 }),
    '4 fuera: 2 asignado tarde · 1 por el cliente · 1 sin justificar',
  )
})
