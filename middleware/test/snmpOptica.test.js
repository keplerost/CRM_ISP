import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { armarFilas } from '../src/drivers/huaweiSnmp.js'
import { decodificarIfIndex, codificarIfIndex, valor, NO_DISPONIBLE } from '../src/lib/snmp.js'

/**
 * Lectura óptica masiva por SNMP.
 *
 * Los valores son los que devolvió el MA5800-X7 de LA MANÁ, contrastados uno a
 * uno contra `display ont optical-info` de las mismas ONTs. Es la parte donde un
 * error no se ve: una potencia mal escalada da -1.7 dBm en vez de -17.28, que
 * parece una señal excelente y haría cerrar como resueltos reclamos que son
 * reales.
 */

const DDM = '1.3.6.1.4.1.2011.6.128.1.1.2.51.1'

describe('ifIndex de un puerto GPON Huawei', () => {
  test('decodifica el índice real del equipo', () => {
    // 4194353152 fue el primer ifIndex del recorrido, y la CLI confirmó que esa
    // ONT vive en slot 6 puerto 0.
    assert.deepEqual(decodificarIfIndex(4194353152), { slot: 6, puerto: 0 })
    assert.deepEqual(decodificarIfIndex(4194353408), { slot: 6, puerto: 1 })
  })

  test('ida y vuelta para todos los slots y puertos del chasis', () => {
    for (const slot of [0, 6, 7, 8, 15]) {
      for (const puerto of [0, 1, 7, 8, 15]) {
        const ifIndex = codificarIfIndex(slot, puerto)
        assert.deepEqual(decodificarIfIndex(ifIndex), { slot, puerto }, `slot ${slot} puerto ${puerto}`)
      }
    }
  })

  test('un índice que no es GPON no se inventa una ubicación', () => {
    // Devolver { slot: 0, puerto: 0 } para una interfaz de gestión pondría
    // lecturas de otro lado dentro de un puerto PON real.
    assert.equal(decodificarIfIndex(6291456), null)
    assert.equal(decodificarIfIndex(0), null)
    assert.equal(decodificarIfIndex('abc'), null)
  })
})

describe('valores crudos de SNMP', () => {
  test('el centinela de "no disponible" no es una medición', () => {
    // El equipo devuelve 2147483647 para una ONT que no reporta óptica. Tomarlo
    // como número la dejaría con una potencia absurda en vez de sin dato.
    assert.equal(valor(NO_DISPONIBLE), null)
    assert.equal(valor(-1), null)
    assert.equal(valor(null), null)
  })

  test('un cero sí es una medición', () => {
    assert.equal(valor(0), 0)
  })
})

describe('armado de las filas por ONT', () => {
  // Valores exactos del X7 para la ONT 0 del slot 6 puerto 0, cuya CLI dijo:
  //   Rx: -17.28 dBm · Tx: 2.35 dBm · Temp: 38 C · Voltaje: 3.280 V · Bias: 12 mA
  const REAL = [
    { oid: `${DDM}.1.4194353152.0`, valor: 38 },
    { oid: `${DDM}.2.4194353152.0`, valor: 12 },
    { oid: `${DDM}.3.4194353152.0`, valor: 233 },
    { oid: `${DDM}.4.4194353152.0`, valor: -1728 },
    { oid: `${DDM}.5.4194353152.0`, valor: 3280 },
  ]

  test('reproduce lo que dice la CLI para la misma ONT', () => {
    const [ont] = armarFilas(REAL)

    assert.equal(ont.slot, 6)
    assert.equal(ont.puerto, 0)
    assert.equal(ont.ontId, 0)

    assert.equal(ont.rx_dbm, -17.28)
    assert.equal(ont.tx_dbm, 2.33)
    assert.equal(ont.temperatura_c, 38)
    assert.equal(ont.voltaje_v, 3.28)
    assert.equal(ont.bias_ma, 12)
  })

  test('la potencia va en centésimas de dBm, no en décimas', () => {
    // El error que este test existe para atrapar: /10 daría -172.8 (absurdo, se
    // nota) pero también convierte un -1.7 en algo creíble en el otro sentido.
    const [ont] = armarFilas([{ oid: `${DDM}.4.4194353152.0`, valor: -2398 }])
    assert.equal(ont.rx_dbm, -23.98)
  })

  test('una ONT sin lectura queda en null, no en cero', () => {
    const [ont] = armarFilas([
      { oid: `${DDM}.4.4194353152.6`, valor: NO_DISPONIBLE },
      { oid: `${DDM}.3.4194353152.6`, valor: NO_DISPONIBLE },
    ])
    assert.equal(ont.rx_dbm, null)
    assert.equal(ont.tx_dbm, null)
    // Pero la ONT aparece igual: la posición existe y eso ya es información.
    assert.equal(ont.ontId, 6)
  })

  test('junta las columnas de una misma ONT aunque vengan separadas', () => {
    // El recorrido va columna por columna, así que los valores de una ONT
    // llegan repartidos a lo largo de todo el resultado.
    const filas = armarFilas([
      { oid: `${DDM}.4.4194353152.0`, valor: -1728 },
      { oid: `${DDM}.4.4194353152.1`, valor: -1939 },
      { oid: `${DDM}.3.4194353152.0`, valor: 233 },
      { oid: `${DDM}.3.4194353152.1`, valor: 243 },
    ])

    assert.equal(filas.length, 2)
    assert.deepEqual(
      filas.map((f) => [f.ontId, f.rx_dbm, f.tx_dbm]),
      [
        [0, -17.28, 2.33],
        [1, -19.39, 2.43],
      ],
    )
  })

  test('vienen ordenadas por slot, puerto y ONT', () => {
    const filas = armarFilas([
      { oid: `${DDM}.4.${codificarIfIndex(7, 3)}.5`, valor: -1600 },
      { oid: `${DDM}.4.${codificarIfIndex(6, 0)}.9`, valor: -1600 },
      { oid: `${DDM}.4.${codificarIfIndex(6, 0)}.2`, valor: -1600 },
      { oid: `${DDM}.4.${codificarIfIndex(6, 1)}.0`, valor: -1600 },
    ])

    assert.deepEqual(
      filas.map((f) => `${f.slot}/${f.puerto}/${f.ontId}`),
      ['6/0/2', '6/0/9', '6/1/0', '7/3/5'],
    )
  })

  test('ignora columnas que no fueron identificadas contra el equipo', () => {
    // La tabla tiene una sexta columna cuyo significado no se pudo confirmar.
    // Una columna con nombre inventado es peor que una ausente: alguien la va a
    // usar para decidir si manda un técnico.
    const filas = armarFilas([{ oid: `${DDM}.6.4194353152.0`, valor: 7838 }])
    assert.equal(filas.length, 0)
  })

  test('una ONT de una interfaz que no es GPON no entra', () => {
    const filas = armarFilas([{ oid: `${DDM}.4.6291456.0`, valor: -1600 }])
    assert.equal(filas.length, 0)
  })
})
