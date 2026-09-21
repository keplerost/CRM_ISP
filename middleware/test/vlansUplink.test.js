import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseVlansConUso, comprimirRangos } from '../src/parsers/huaweiUplinkParser.js'

/**
 * Cambio de VLANs en un troncal.
 *
 * Es la operación más disruptiva del sistema: quitar una VLAN con abonados los
 * deja sin salida a todos en el mismo segundo, y desde el lado GPON no se ve
 * nada raro porque las ONTs siguen online, con buena señal y su service-port
 * creado. Es de las averías que más tardan en diagnosticarse.
 *
 * Estos tests cubren el dato del que depende toda la protección: cuántos
 * abonados usa cada VLAN.
 */

// Salida literal del X7.
const REAL = `  -----------------------------------------------------------------------
  VLAN   Type      Attribute  STND-Port NUM   SERV-Port NUM  VLAN-Con NUM
  -----------------------------------------------------------------------
     1   smart     common                 8               0             -
   100   smart     common                 0               1             -
   115   smart     common                 0               0             -
   200   smart     common                 4              90             -
   201   smart     common                 1               0             -
   999   smart     common                 1              65             -
  -----------------------------------------------------------------------
  Total: 39`

describe('cuántos abonados usa cada VLAN', () => {
  const r = parseVlansConUso(REAL)

  test('lee las VLANs con su cantidad de abonados', () => {
    assert.equal(r.length, 6)
    assert.deepEqual(
      r.find((x) => x.vlan === 200),
      { vlan: 200, tipo: 'smart', puertos_estandar: 4, abonados: 90 },
    )
  })

  test('distingue la VLAN con noventa abonados de la que no tiene ninguno', () => {
    // Es LA distinción de la que depende la protección: quitar la 200 deja a
    // noventa clientes sin internet; quitar la 201, a nadie.
    assert.equal(r.find((x) => x.vlan === 200).abonados, 90)
    assert.equal(r.find((x) => x.vlan === 201).abonados, 0)
    assert.equal(r.find((x) => x.vlan === 999).abonados, 65)
  })

  test('no confunde puertos estándar con abonados', () => {
    // La VLAN 1 está en 8 puertos y no tiene NINGÚN abonado. Leer la columna
    // equivocada haría bloquear su quite por una razón inexistente — o peor,
    // permitir el de la 200 creyendo que no afecta a nadie.
    const uno = r.find((x) => x.vlan === 1)
    assert.equal(uno.puertos_estandar, 8)
    assert.equal(uno.abonados, 0)
  })

  test('el encabezado y los totales no se cuelan', () => {
    for (const x of r) {
      assert.ok(x.vlan >= 1 && x.vlan <= 4094, `VLAN inválida: ${x.vlan}`)
    }
    assert.ok(!r.some((x) => x.vlan === 39), 'el "Total: 39" se coló como VLAN')
  })

  test('una salida vacía no rompe', () => {
    assert.deepEqual(parseVlansConUso(''), [])
  })
})

describe('la lista que se le manda al equipo', () => {
  test('los rangos se compactan como espera el comando', () => {
    // `port vlan <lista> 0/9 <puertos>` acepta "2,5-8,10". Mandar treinta
    // números sueltos supera el largo máximo del parámetro.
    assert.equal(comprimirRangos([200, 201, 202, 203]).replace(/, /g, ','), '200-203')
    assert.equal(comprimirRangos([300]).replace(/, /g, ','), '300')
    assert.equal(comprimirRangos([1, 200, 999]).replace(/, /g, ','), '1,200,999')
  })

  test('la lista de puertos usa el mismo formato', () => {
    assert.equal(comprimirRangos([0, 1, 2, 3]).replace(/, /g, ','), '0-3')
    assert.equal(comprimirRangos([0, 2]).replace(/, /g, ','), '0,2')
  })
})
