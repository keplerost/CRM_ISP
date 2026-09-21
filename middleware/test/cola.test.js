import test from 'node:test'
import assert from 'node:assert/strict'

import { enCola, colasActivas } from '../src/lib/cola.js'

/**
 * La OLT del taller admite muy pocas sesiones SSH simultáneas: al pasarse
 * contesta "exceed max sessions" y rechaza TODO —incluso conexiones nuevas—
 * hasta que se liberen. Dos clics seguidos en la UI alcanzaban para llegar al
 * tope y dejar el equipo inaccesible por varios minutos.
 *
 * conSesionSsh serializa por host usando esta cola.
 */

const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

test('dos tareas con la misma clave no se solapan', async () => {
  const eventos = []

  const tarea = (nombre, ms) => async () => {
    eventos.push(`inicia ${nombre}`)
    await esperar(ms)
    eventos.push(`termina ${nombre}`)
  }

  // La primera tarda más que la segunda: si se solaparan, B terminaría antes que A.
  await Promise.all([enCola('olt-1', tarea('A', 60)), enCola('olt-1', tarea('B', 10))])

  assert.deepEqual(eventos, ['inicia A', 'termina A', 'inicia B', 'termina B'])
})

test('respeta el orden de llegada', async () => {
  const orden = []
  await Promise.all(
    ['A', 'B', 'C', 'D'].map((n) =>
      enCola('olt-2', async () => {
        orden.push(n)
        await esperar(5)
      }),
    ),
  )
  assert.deepEqual(orden, ['A', 'B', 'C', 'D'])
})

test('claves distintas corren en paralelo', async () => {
  const t0 = Date.now()

  await Promise.all([
    enCola('olt-A', () => esperar(120)),
    enCola('olt-B', () => esperar(120)),
    enCola('olt-C', () => esperar(120)),
  ])

  // En paralelo ~120 ms; serializadas serían ~360 ms.
  assert.ok(Date.now() - t0 < 250, 'los equipos distintos no deben bloquearse entre sí')
})

test('un error no deja la cola trabada', async () => {
  await assert.rejects(
    enCola('olt-3', async () => {
      throw new Error('falla a propósito')
    }),
  )

  let corrio = false
  await enCola('olt-3', async () => {
    corrio = true
  })

  assert.equal(corrio, true, 'la tarea siguiente debe correr aunque la anterior falle')
})

test('el error se propaga a quien encoló, no a los demás', async () => {
  const resultados = await Promise.allSettled([
    enCola('olt-4', async () => {
      throw new Error('solo esta falla')
    }),
    enCola('olt-4', async () => 'ok'),
  ])

  assert.equal(resultados[0].status, 'rejected')
  assert.equal(resultados[1].status, 'fulfilled')
  assert.equal(resultados[1].value, 'ok')
})

test('las claves terminadas se sacan del registro', async () => {
  await enCola('olt-efimera', async () => 'listo')
  await esperar(20)
  assert.equal(colasActivas(), 0, 'no debe acumular claves de trabajos ya terminados')
})
