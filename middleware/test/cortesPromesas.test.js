import test from 'node:test'
import assert from 'node:assert/strict'

import { decidirCortes, programarCortes, fechaLocal, estadoCortes } from '../src/services/cortesPromesas.js'

/**
 * Cortar solo es dejar a alguien sin internet sin que nadie lo revise. Cada
 * regla de acá existe para que eso no le pase a quien no corresponde: el que ya
 * pagó, el que no tiene IP conocida, o todos a la vez por una consulta que
 * salió mal.
 */

const PROMESA = {
  id: 'pr1',
  client_id: 'c1',
  cliente: 'JUAN PÉREZ',
  ip: '10.0.0.5',
  router_id: 'r1',
  fecha_promesa: '2026-07-20',
}

// --- A quién se corta -------------------------------------------------------

test('se corta a quien prometió, se le habilitó y sigue debiendo', () => {
  const { cortes, omitidos } = decidirCortes([PROMESA], new Map([['c1', 25.7]]))

  assert.equal(cortes.length, 1)
  assert.equal(cortes[0].saldo, 25.7)
  assert.equal(omitidos.length, 0)
})

test('no se corta a quien ya pagó', () => {
  // Pudo pagar sin que nadie cerrara la promesa a mano. La deuda manda.
  const { cortes, omitidos } = decidirCortes([PROMESA], new Map([['c1', 0]]))

  assert.equal(cortes.length, 0)
  assert.match(omitidos[0].motivo, /saldo/)
})

test('un cliente sin saldo conocido no se corta', () => {
  const { cortes, omitidos } = decidirCortes([PROMESA], new Map())

  assert.equal(cortes.length, 0)
  assert.equal(omitidos.length, 1)
})

test('sin IP o sin router queda para cortar a mano', () => {
  const saldos = new Map([['c1', 30]])

  const sinIp = decidirCortes([{ ...PROMESA, ip: null }], saldos)
  assert.equal(sinIp.cortes.length, 0)
  assert.match(sinIp.omitidos[0].motivo, /router o IP/)

  const sinRouter = decidirCortes([{ ...PROMESA, router_id: null }], saldos)
  assert.equal(sinRouter.cortes.length, 0)
})

test('el tope por corrida evita dejar sin internet a todos por un error', () => {
  const muchas = Array.from({ length: 10 }, (_, i) => ({ ...PROMESA, id: `pr${i}`, client_id: `c${i}` }))
  const saldos = new Map(muchas.map((p) => [p.client_id, 20]))

  const { cortes, omitidos } = decidirCortes(muchas, saldos, { limite: 3 })

  assert.equal(cortes.length, 3)
  assert.equal(omitidos.length, 7)
  assert.match(omitidos[0].motivo, /tope de 3/)
})

// --- Fecha ------------------------------------------------------------------

test('la fecha del día es la local, no la del huso UTC', () => {
  // A las 21:00 en Ecuador (UTC-5) ya es el día siguiente en UTC: usar
  // toISOString haría que la corrida de la noche se cuente como la de mañana.
  const nocheDelUltimoDia = new Date(2026, 6, 31, 21, 30)
  assert.equal(fechaLocal(nocheDelUltimoDia), '2026-07-31')
})

// --- Programador ------------------------------------------------------------

/** Espera a que el programador termine su primera revisión. */
const tick = () => new Promise((r) => setImmediate(r))

test('apagado no programa nada', () => {
  let corridas = 0
  const t = programarCortes({ activo: false, ejecutar: async () => ++corridas })

  assert.equal(t, null)
  assert.equal(corridas, 0)
  assert.equal(estadoCortes.automaticos, false)
})

test('corre una sola vez por día aunque se revise muchas veces', async () => {
  let corridas = 0
  estadoCortes.ultimaCorrida = null

  const t = programarCortes({
    activo: true,
    hora: '00:00',
    intervaloMs: 5,
    ejecutar: async () => {
      corridas++
      return { cortados: [], fallidos: [], omitidos: [] }
    },
  })

  await tick()
  await new Promise((r) => setTimeout(r, 30))
  clearInterval(t)

  assert.equal(corridas, 1, 'varios ticks, una sola corrida')
  assert.equal(estadoCortes.ultimaCorrida, fechaLocal())
})

test('antes de la hora no corta', async () => {
  let corridas = 0
  estadoCortes.ultimaCorrida = null

  const t = programarCortes({
    activo: true,
    hora: '23:59',
    intervaloMs: 5,
    ejecutar: async () => ++corridas,
  })

  await tick()
  clearInterval(t)

  // A las 23:59 pasa igual: el test se salta si corre a esa hora exacta.
  const ahora = new Date()
  if (ahora.getHours() !== 23) assert.equal(corridas, 0)
})

test('si la corrida falla se vuelve a intentar, no se pierde el día', async () => {
  estadoCortes.ultimaCorrida = null
  let intentos = 0

  const t = programarCortes({
    activo: true,
    hora: '00:00',
    intervaloMs: 5,
    ejecutar: async () => {
      intentos++
      throw new Error('el router no responde')
    },
  })

  await new Promise((r) => setTimeout(r, 30))
  clearInterval(t)

  assert.ok(intentos > 1, 'reintentó tras el error')
  assert.match(estadoCortes.ultimoResultado.error, /router/)
})
