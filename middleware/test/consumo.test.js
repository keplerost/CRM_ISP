import test from 'node:test'
import assert from 'node:assert/strict'

import { repartir, emparejar, partirBytes, estadoDe } from '../src/services/consumoDiario.js'

/**
 * El consumo es la diferencia entre dos lecturas de un contador que se
 * reinicia solo. Equivocarse acá no da un error visible: da un número creíble
 * pero falso, y el abonado se entera cuando le facturan de más o cuando le
 * dicen que no consumió nada el mes que reclamó.
 */

test('la primera lectura no cuenta como consumo', () => {
  // El contador venía acumulando desde que se instaló el servicio. Tomarlo como
  // consumo de hoy le cargaría meses de tráfico en un día.
  const [c] = repartir([{ client_id: 'a', origen: 'q1', subida: 8_000_000_000, bajada: 40_000_000_000 }], {})

  assert.equal(c.subida, 0)
  assert.equal(c.bajada, 0)
  assert.equal(c.arranque, true)
})

test('con lectura previa, el consumo es la diferencia', () => {
  const [c] = repartir(
    [{ client_id: 'a', origen: 'q1', subida: 1_500, bajada: 9_000 }],
    { a: { origen: 'q1', subida_bytes: 1_000, bajada_bytes: 5_000 } },
  )

  assert.equal(c.subida, 500)
  assert.equal(c.bajada, 4_000)
  assert.equal(c.reinicio, false)
})

test('un contador reiniciado no da consumo negativo', () => {
  // Se reinició el router: la cola arrancó de cero y ahora marca menos que
  // antes. Lo consumido desde el reinicio es lo que marca ahora.
  const [c] = repartir(
    [{ client_id: 'a', origen: 'q1', subida: 300, bajada: 900 }],
    { a: { origen: 'q1', subida_bytes: 5_000, bajada_bytes: 90_000 } },
  )

  assert.equal(c.reinicio, true)
  assert.equal(c.subida, 300)
  assert.equal(c.bajada, 900)
  assert.ok(c.subida >= 0 && c.bajada >= 0)
})

test('si la cola se recreó con otro nombre, no se resta contra la anterior', () => {
  // Las colas dinámicas de PPPoE se recrean en cada reconexión. Restar contra
  // la lectura de la cola vieja mezclaría dos contadores distintos.
  const [c] = repartir(
    [{ client_id: 'a', origen: '<pppoe-juan-2>', subida: 700, bajada: 2_400 }],
    { a: { origen: '<pppoe-juan-1>', subida_bytes: 900_000, bajada_bytes: 4_000_000 } },
  )

  assert.equal(c.reinicio, true)
  assert.equal(c.subida, 700)
  assert.equal(c.bajada, 2_400)
})

test('sin tráfico entre dos lecturas, el consumo es cero', () => {
  const [c] = repartir(
    [{ client_id: 'a', origen: 'q1', subida: 1_000, bajada: 5_000 }],
    { a: { origen: 'q1', subida_bytes: 1_000, bajada_bytes: 5_000 } },
  )

  assert.equal(c.subida, 0)
  assert.equal(c.bajada, 0)
})

test('los bytes de RouterOS vienen como "subida/bajada"', () => {
  assert.deepEqual(partirBytes('1234/56789'), { rx: 1234, tx: 56789 })
  assert.deepEqual(partirBytes('0/0'), { rx: 0, tx: 0 })
  assert.deepEqual(partirBytes(null), { rx: 0, tx: 0 })
  assert.deepEqual(partirBytes('  12 / 34 '), { rx: 12, tx: 34 })
})

test('las colas se emparejan por IP del abonado', () => {
  const lecturas = emparejar(
    [
      { name: 'JEFFERSON', target: '192.168.25.5/32', bytes: '1000/9000' },
      { name: 'otra-cosa', target: '10.9.9.9/32', bytes: '5/5' },
    ],
    [{ id: 'a', nombre: 'JEFFERSON', ip: '192.168.25.5' }],
  )

  assert.equal(lecturas.length, 1, 'la cola de otro no se cuenta')
  assert.equal(lecturas[0].client_id, 'a')
  assert.equal(lecturas[0].subida, 1000)
  assert.equal(lecturas[0].bajada, 9000)
})

test('las colas dinámicas se emparejan por el usuario PPPoE del nombre', () => {
  const lecturas = emparejar(
    [{ name: '<pppoe-juan>', target: '10.20.0.44/32', bytes: '2000/8000' }],
    [{ id: 'b', nombre: 'JUAN', usuario_ppp: 'JUAN' }],
  )

  assert.equal(lecturas.length, 1)
  assert.equal(lecturas[0].client_id, 'b')
  assert.equal(lecturas[0].origen, '<pppoe-juan>')
})

test('una cola sin abonado que la reclame se ignora', () => {
  // En el router hay colas de infraestructura y de pruebas. Adjudicárselas a
  // alguien inventaría consumo.
  assert.equal(emparejar([{ name: 'backbone', target: '10.0.0.0/8', bytes: '9/9' }], []).length, 0)
})

test('el estado del día distingue promesa de corte', () => {
  assert.equal(estadoDe({ estado: 'activo' }, false), 'activo')
  assert.equal(estadoDe({ estado: 'activo' }, true), 'promesa')
  assert.equal(estadoDe({ estado: 'cortado' }, false), 'cortado')
  // Cortado con promesa sigue siendo corte: la promesa todavía no lo reactivó.
  assert.equal(estadoDe({ estado: 'cortado' }, true), 'cortado')
  assert.equal(estadoDe({ estado: 'baja' }, false), 'suspendido')
})

test('los bytes salen enteros: las columnas son BIGINT y un decimal las rompe', () => {
  // Una lectura con coma hacía fallar el guardado del día entero, y el error se
  // perdía sin que nadie se enterara de que ese abonado dejó de medirse.
  const [c] = repartir(
    [{ client_id: 'a', origen: 'q1', subida: 2469606195.2, bajada: 21582008320.7 }],
    { a: { origen: 'q1', subida_bytes: 2147483648, bajada_bytes: 19327352832 } },
  )

  assert.ok(Number.isInteger(c.subida), `subida entera, llegó ${c.subida}`)
  assert.ok(Number.isInteger(c.bajada), `bajada entera, llegó ${c.bajada}`)

  assert.deepEqual(partirBytes('1234.6/5678.2'), { rx: 1235, tx: 5678 })
})

test('varios abonados se calculan de forma independiente', () => {
  const consumos = repartir(
    [
      { client_id: 'a', origen: 'q1', subida: 200, bajada: 800 },
      { client_id: 'b', origen: 'q2', subida: 50, bajada: 100 },
      { client_id: 'c', origen: 'q3', subida: 10, bajada: 20 },
    ],
    {
      a: { origen: 'q1', subida_bytes: 100, bajada_bytes: 300 },
      b: { origen: 'q2', subida_bytes: 900, bajada_bytes: 9_000 },
      // 'c' no tiene lectura previa
    },
  )

  assert.deepEqual(
    consumos.map((c) => [c.subida, c.bajada]),
    [
      [100, 500],  // diferencia normal
      [50, 100],   // contador reiniciado
      [0, 0],      // primera lectura
    ],
  )
})
