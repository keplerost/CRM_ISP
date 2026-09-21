import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseTrafficTables } from '../src/parsers/huaweiPerfilParser.js'
import { emparejar } from '../src/services/planesOlt.js'

/**
 * Las traffic tables son las que fijan la velocidad real del abonado.
 *
 * Hasta ahora el índice se cargaba a mano en cada plan y nadie comprobaba nada.
 * Dos de los tres planes de este ISP apuntaban a las tablas 30 y 50 —escritas
 * con el número del plan en vez del índice— y no se notaba: el error solo
 * aparece al dar de alta a alguien, cuando el equipo rechaza el service-port y
 * la ONT queda registrada sin pasar tráfico.
 *
 * Salida literal del MA5800-X7.
 */
const SALIDA = `  ---------------------------------------------------------------------------
  TID CIR      CBS        PIR      PBS        Pri Copy-policy     Pri-Policy
      (kbps)   (bytes)    (kbps)   (bytes)
  ---------------------------------------------------------------------------
   4  64       4048       128      8096         4 -                  tag-pri
   6  off      off        off      off          0 -                  tag-pri
   9  2048     67536      10432    335824       2 -                local-pri
   10 1048064  33540048   1048064  33540048     0 -                local-pri
   12 51200    640000     51200    640000       0 -                local-pri
  ---------------------------------------------------------------------------
  Total Num : 5`

describe('traffic tables del equipo', () => {
  const t = parseTrafficTables(SALIDA)

  test('lee todas con su índice', () => {
    assert.deepEqual(t.map((x) => x.index), [4, 6, 9, 10, 12])
  })

  test('convierte a los megas que se ven en la calle', () => {
    assert.equal(t.find((x) => x.index === 12).mbps, 51.2)
    assert.equal(t.find((x) => x.index === 10).mbps, 1048.1)
  })

  test('la tabla de 1 Gbps se distingue de una de 50 megas', () => {
    // Es la confusión que dejó a los 91 abonados sin límite en la OLT: el plan
    // decía "100M" y apuntaba a la tabla de 1 Gbps.
    const g = t.find((x) => x.index === 10)
    const m = t.find((x) => x.index === 12)
    assert.ok(g.mbps > 1000)
    assert.ok(m.mbps < 100)
  })

  test('"off" es SIN LÍMITE, no cero', () => {
    // Un cero se leería como "no pasa nada" y es exactamente lo contrario.
    const libre = t.find((x) => x.index === 6)
    assert.equal(libre.sin_limite, true)
    assert.equal(libre.pir_kbps, null)
    assert.equal(libre.mbps, null)
  })

  test('distingue el caudal garantizado del máximo', () => {
    // La tabla 9 da 2 Mbps garantizados y hasta 10. Un plan "de 10 megas" con
    // esa tabla no es lo mismo que uno con 10 garantizados, y desde el nombre
    // del plan no se ve la diferencia.
    const g = t.find((x) => x.index === 9)
    assert.equal(g.cir_kbps, 2048)
    assert.equal(g.pir_kbps, 10432)
    assert.notEqual(g.cir_kbps, g.pir_kbps)
  })

  test('el encabezado y los totales no se cuelan', () => {
    for (const x of t) assert.ok(Number.isFinite(x.index))
    assert.equal(t.length, 5)
  })

  test('una salida vacía no inventa tablas', () => {
    assert.deepEqual(parseTrafficTables(''), [])
    assert.deepEqual(parseTrafficTables('Failure: The traffic table does not exist'), [])
  })
})

/**
 * Emparejar las tablas es lo que convierte "índice 14, 153.6 Mbps" en
 * "PLAN_HOME, 153/153, ponele precio".
 *
 * Los nombres son los reales del X7.
 */
const t = (index, nombre, mbps) => ({
  index,
  nombre,
  mbps,
  pir_kbps: mbps * 1000,
  cir_kbps: mbps * 1000,
  en_uso: false,
})

describe('perfiles vendibles', () => {
  test('junta las que comparten nombre y difieren en el sentido', () => {
    const { pares } = emparejar([
      t(12, 'SMARTOLT-PLAN_BASICO-DOWN', 51.2),
      t(13, 'SMARTOLT-PLAN_BASICO-UP', 51.2),
    ])
    assert.equal(pares.length, 1)
    assert.equal(pares[0].nombre, 'SMARTOLT-PLAN_BASICO')
    assert.equal(pares[0].traffic_table_bajada, 12)
    assert.equal(pares[0].traffic_table_subida, 13)
  })

  test('no le importa en qué orden estén los índices', () => {
    // En el equipo real PLAN_HOME tiene el UP en el 14 y el DOWN en el 15.
    // Suponer que el menor es la bajada le daría la velocidad al revés.
    const { pares } = emparejar([
      t(14, 'SMARTOLT-PLAN_HOME-UP', 153.6),
      t(15, 'SMARTOLT-PLAN_HOME-DOWN', 153.6),
    ])
    assert.equal(pares[0].traffic_table_bajada, 15)
    assert.equal(pares[0].traffic_table_subida, 14)
  })

  test('media pareja NO se vende', () => {
    // Sin la otra mitad, ese sentido queda sin límite y el abonado tiene un
    // plan distinto del que pagó. Va a las sueltas, no a los vendibles.
    const { pares, sueltas } = emparejar([t(30, 'SOLO-UP', 100)])
    assert.equal(pares.length, 0)
    assert.equal(sueltas.length, 1)
  })

  test('las que no siguen la convención quedan sueltas, no se pierden', () => {
    // Una tabla suelta puede ser justo lo que alguien quiere usar. Esconderla
    // sería decidir por él.
    const { pares, sueltas } = emparejar([t(9, 'SMARTOLT-VOIPMNG-10M', 10.4)])
    assert.equal(pares.length, 0)
    assert.deepEqual(sueltas.map((x) => x.index), [9])
  })

  test('marca el par como en uso si cualquiera de las dos lo está', () => {
    const { pares } = emparejar([
      { ...t(10, 'SMARTOLT-1G-UP', 1048), en_uso: true },
      t(11, 'SMARTOLT-1G-DOWN', 1048),
    ])
    assert.equal(pares[0].en_uso, true)
  })
})
