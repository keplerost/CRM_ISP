import test from 'node:test'
import assert from 'node:assert/strict'

import { diasDesde, programarPausasVencidas } from '../src/services/pausasVencidas.js'

/**
 * El aviso de las pausas vencidas.
 *
 * ── Qué se protege ──
 *
 * Que el aviso salga UNA vez al día y a la hora acordada. Es una lista de a
 * quién llamar: si sale de madrugada nadie la ve, y si sale varias veces la
 * campana se vuelve ilegible justo por avisar de más.
 */

test('cuenta los días desde que venció', () => {
  assert.equal(diasDesde('2026-09-22', '2026-09-23'), 1)
  assert.equal(diasDesde('2026-09-22', '2026-09-24'), 2)
  assert.equal(diasDesde('2026-08-31', '2026-09-01'), 1, 'tiene que cruzar el fin de mes')
})

test('una fecha futura no da días negativos', () => {
  // No debería llegar acá —solo se miran las vencidas— pero un número negativo
  // en el aviso quedaría como "venció hace -3 días".
  assert.equal(diasDesde('2026-09-30', '2026-09-24'), 0)
})

test('apagada no programa nada', () => {
  let corrio = false
  const parar = programarPausasVencidas({ activo: false, ejecutar: async () => { corrio = true } })
  assert.equal(parar, null)
  assert.equal(corrio, false)
})

test('no corre antes de la hora', async () => {
  let veces = 0
  const parar = programarPausasVencidas({
    activo: true,
    // Una hora que ya no puede haber pasado hoy.
    hora: '23:59',
    intervaloMs: 10_000,
    ejecutar: async () => { veces++ },
  })
  await new Promise((r) => setTimeout(r, 30))
  parar?.()
  // Si son exactamente las 23:59 o más, corre: el test no puede afirmar 0.
  const ahora = new Date()
  if (ahora.getHours() * 60 + ahora.getMinutes() < 23 * 60 + 59) assert.equal(veces, 0)
})

test('corre una sola vez aunque el reloj vuelva a sonar', async () => {
  // Es la propiedad que evita repetir el aviso: la tarea revisa cada pocos
  // minutos y tiene que reconocer que hoy ya corrió.
  let veces = 0
  const parar = programarPausasVencidas({
    activo: true,
    hora: '00:00',
    intervaloMs: 5,
    ejecutar: async () => { veces++ },
  })
  await new Promise((r) => setTimeout(r, 60))
  parar?.()
  assert.equal(veces, 1, `corrió ${veces} veces`)
})
