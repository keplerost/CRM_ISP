import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { correspondeRegistrar, filasAGuardar } from '../src/lib/optica.js'

/**
 * Cuándo se guarda una lectura óptica en el historial.
 *
 * Es una decisión de escala: con mil ONTs leídas cada quince minutos, guardar
 * todo son cien mil filas por día y en un mes la tabla no se puede ni consultar.
 * Guardar de menos pierde la pendiente, que es lo único que se viene a ver.
 */

const HORA = 60 * 60 * 1000
const AHORA = new Date('2026-08-03T12:00:00Z').getTime()
const haceHoras = (h) => new Date(AHORA - h * HORA).toISOString()

describe('cuándo corresponde registrar', () => {
  test('la primera lectura siempre se guarda', () => {
    assert.equal(correspondeRegistrar(null, -18.5, null, AHORA), true)
  })

  test('una variación chica NO genera fila', () => {
    // Un enlace sano se mueve unas décimas entre lecturas. Guardar eso llenaría
    // la tabla de ruido y taparía los movimientos que sí importan.
    assert.equal(correspondeRegistrar(-18.5, -18.7, haceHoras(1), AHORA), false)
    assert.equal(correspondeRegistrar(-18.5, -18.2, haceHoras(1), AHORA), false)
  })

  test('un salto de medio dB o más SÍ genera fila', () => {
    assert.equal(correspondeRegistrar(-18.5, -19.0, haceHoras(1), AHORA), true)
    assert.equal(correspondeRegistrar(-18.5, -18.0, haceHoras(1), AHORA), true)
  })

  test('un salto grande se guarda aunque acabe de registrarse', () => {
    // Es justo el caso que no se puede perder: la caída brusca de una fibra
    // dañada. Si se descartara por "recién guardé", el gráfico mostraría una
    // línea plana en el momento del corte.
    assert.equal(correspondeRegistrar(-18.5, -26.0, haceHoras(0.05), AHORA), true)
  })

  test('sin movimiento se guarda igual cada tantas horas', () => {
    // Deja constancia de que se midió y estaba bien. Sin esto, un tramo estable
    // se ve idéntico a un tramo en el que nadie miró.
    assert.equal(correspondeRegistrar(-18.5, -18.5, haceHoras(3), AHORA), false)
    assert.equal(correspondeRegistrar(-18.5, -18.5, haceHoras(7), AHORA), true)
  })

  test('una ONT sin lectura no ensucia la serie', () => {
    // "No reportó" es un dato de estado, no una medición. Metido en la serie
    // rompería cualquier promedio y cualquier pendiente.
    assert.equal(correspondeRegistrar(-18.5, null, haceHoras(10), AHORA), false)
    assert.equal(correspondeRegistrar(null, null, null, AHORA), false)
    assert.equal(correspondeRegistrar(-18.5, undefined, haceHoras(10), AHORA), false)
  })
})

describe('filas a guardar de una lectura masiva', () => {
  const enBase = [
    { id: 'a', slot: 6, puerto: 0, onu_index: 1, rx_power_dbm: -18.5, optica_registrada_at: haceHoras(1) },
    { id: 'b', slot: 6, puerto: 0, onu_index: 2, rx_power_dbm: -20.0, optica_registrada_at: haceHoras(1) },
    { id: 'c', slot: 6, puerto: 1, onu_index: 0, rx_power_dbm: -17.0, optica_registrada_at: haceHoras(9) },
  ]

  test('solo guarda las que se movieron o llevan mucho sin registrar', () => {
    const lecturas = [
      { slot: 6, puerto: 0, onu_index: 1, ontId: 1, rx_dbm: -18.6 }, // apenas se movió
      { slot: 6, puerto: 0, onu_index: 2, ontId: 2, rx_dbm: -23.4 }, // se desplomó
      { slot: 6, puerto: 1, onu_index: 0, ontId: 0, rx_dbm: -17.0 }, // igual, pero vieja
    ]

    const filas = filasAGuardar(lecturas, enBase, AHORA)
    assert.deepEqual(
      filas.map((f) => f.onu_id).sort(),
      ['b', 'c'],
    )
  })

  test('arrastra TX y temperatura cuando se leyeron', () => {
    const filas = filasAGuardar(
      [{ slot: 6, puerto: 0, onu_index: 2, ontId: 2, rx_dbm: -25, tx_dbm: 2.3, temperatura_c: 41 }],
      enBase,
      AHORA,
    )
    assert.equal(filas[0].tx_dbm, 2.3)
    assert.equal(filas[0].temperatura_c, 41)
  })

  test('en modo solo-RX no inventa un TX en cero', () => {
    // El modo por defecto no lee TX. Guardar 0 haría creer que el láser de la
    // ONT está apagado.
    const filas = filasAGuardar(
      [{ slot: 6, puerto: 0, onu_index: 2, ontId: 2, rx_dbm: -25 }],
      enBase,
      AHORA,
    )
    assert.equal(filas[0].tx_dbm, null)
    assert.equal(filas[0].temperatura_c, null)
  })

  test('una ONT que no está en la base no genera fila huérfana', () => {
    const filas = filasAGuardar(
      [{ slot: 9, puerto: 9, onu_index: 9, ontId: 9, rx_dbm: -19 }],
      enBase,
      AHORA,
    )
    assert.equal(filas.length, 0)
  })

  test('una lectura completa de ONTs estables no genera nada', () => {
    // El caso normal del día a día: si esto generara filas, la tabla crecería
    // sin aportar información.
    const lecturas = enBase.map((u) => ({
      slot: u.slot,
      puerto: u.puerto,
      onu_index: u.onu_index,
      ontId: u.onu_index,
      rx_dbm: u.rx_power_dbm,
    }))
    // Se mira una hora después de la última escritura, no nueve.
    const recientes = enBase.map((u) => ({ ...u, optica_registrada_at: haceHoras(1) }))
    assert.equal(filasAGuardar(lecturas, recientes, AHORA).length, 0)
  })
})
