import test from 'node:test'
import assert from 'node:assert/strict'

import {
  mensajeCoordinacion,
  mensajeLlegue,
  mensajeReprogramar,
  primerNombre,
  saludo,
} from '../../web/src/lib/mensajesRetiro.js'

/**
 * Lo que se le escribe al abonado para coordinar el retiro.
 *
 * Lo va a leer alguien a quien se le cortó el servicio y ahora le tocan la
 * puerta para llevarse el equipo. El tono importa tanto como el dato.
 */

const MANANA = new Date('2026-08-14T09:00:00')
const TARDE = new Date('2026-08-14T15:00:00')
const NOCHE = new Date('2026-08-14T21:00:00')

test('se saluda como corresponde a la hora de quien escribe', () => {
  assert.equal(saludo(MANANA), 'Buenos días')
  assert.equal(saludo(TARDE), 'Buenas tardes')
  assert.equal(saludo(NOCHE), 'Buenas noches')
})

test('se usa el primer nombre, no el nombre completo en mayúsculas', () => {
  // Los abonados importados vienen así del sistema viejo.
  assert.equal(primerNombre('JEFFERSON FABIAN OÑA RIERA'), 'Jefferson')
  assert.equal(primerNombre('  ana maría  '), 'Ana')
  assert.equal(primerNombre(''), '')
  assert.equal(primerNombre(null), '')
})

test('sin cita se pregunta si está en el domicilio', () => {
  const m = mensajeCoordinacion({ cliente: 'Ana Pérez', empresa: 'HL Fibra' }, MANANA)
  assert.match(m, /^Buenos días Ana, le escribimos de HL Fibra\./)
  assert.match(m, /¿Se encuentra en el domicilio\?/)
})

test('con cita se confirma esa cita, no se vuelve a preguntar', () => {
  // Preguntarle "¿está en su casa?" al que ya acordó un horario le dice que
  // nadie anotó lo que habló la vez anterior.
  const m = mensajeCoordinacion(
    { cliente: 'Ana', empresa: 'HL Fibra', agendadoPara: '2026-08-20T15:00:00' },
    MANANA,
  )
  assert.match(m, /20\/08 a las 15:00/)
  assert.match(m, /¿Nos confirma que va a estar\?/)
  assert.doesNotMatch(m, /¿Se encuentra en el domicilio\?/)
})

test('sin empresa cargada el mensaje sigue teniendo sentido', () => {
  const m = mensajeCoordinacion({ cliente: 'Ana' }, TARDE)
  assert.match(m, /^Buenas tardes Ana, le escribimos\./)
  assert.doesNotMatch(m, /de undefined/)
})

test('sin nombre no queda un saludo colgado', () => {
  const m = mensajeCoordinacion({ empresa: 'HL Fibra' }, MANANA)
  assert.match(m, /^Buenos días, le escribimos de HL Fibra\./)
})

test('ninguna plantilla menciona la deuda', () => {
  // Quien va a retirar el equipo no es quien cobra. Mezclarlo convierte una
  // coordinación en una discusión en la puerta de la casa.
  const datos = { cliente: 'Ana', empresa: 'HL Fibra' }
  for (const m of [mensajeCoordinacion(datos), mensajeLlegue(datos), mensajeReprogramar(datos)]) {
    assert.doesNotMatch(m, /deuda|debe|pago|mora|corte/i)
  }
})

test('el de "no había nadie" pide horario en vez de reclamar', () => {
  const m = mensajeReprogramar({ cliente: 'Ana' }, TARDE)
  assert.match(m, /no lo encontramos/i)
  assert.match(m, /¿Qué día y hora le queda mejor/i)
})
