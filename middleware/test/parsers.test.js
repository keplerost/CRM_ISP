import test from 'node:test'
import assert from 'node:assert/strict'

import { parseOnuState, parseAutoFind } from '../src/parsers/vsolOnuParser.js'
import {
  parseOntInfoAll,
  parseAutofind,
  parseOpticalInfo,
} from '../src/parsers/huaweiOntParser.js'

/**
 * Tests de los parsers con salidas representativas de los equipos reales.
 *
 * Correr con:  npm test
 *
 * El caso importante es el de V-SOL: las columnas van separadas por ESC[<n>C
 * (mover cursor), no por espacios. Estos tests fallan si alguien "simplifica" el
 * parser a un split por espacios.
 */

const ESC = '\x1b'

test('V-SOL: parsea el estado de las ONUs alineado con códigos ANSI de cursor', () => {
  const salida =
    `show onu state all\n` +
    `OnuIndex${ESC}[12CAdmin State${ESC}[6COMCC State${ESC}[7CPhase State${ESC}[5CChannel\n` +
    `-----------------------------------------------------------------\n` +
    `1${ESC}[19Cenable${ESC}[11Cenable${ESC}[12Cworking${ESC}[9C1\n` +
    `18${ESC}[18Cenable${ESC}[11Cdisable${ESC}[11Clos${ESC}[13C1\n`

  const onus = parseOnuState(salida, 1)

  assert.equal(onus.length, 2)
  assert.deepEqual(
    { onuIndex: onus[0].onuIndex, estado: onus[0].estado, adminState: onus[0].adminState },
    { onuIndex: 1, estado: 'online', adminState: 'enable' },
  )
  assert.equal(onus[1].onuIndex, 18)
  assert.equal(onus[1].estado, 'los')
})

test('V-SOL: detecta el SN en auto-find', () => {
  const salida =
    `show onu auto-find\n` +
    `OnuIndex${ESC}[8CSN${ESC}[10CModel\n` +
    `2${ESC}[14CGPON00112233${ESC}[4CV2801RH\n`

  const nuevas = parseAutoFind(salida, 1)

  assert.equal(nuevas.length, 1)
  assert.equal(nuevas[0].sn, 'GPON00112233')
  assert.equal(nuevas[0].puerto, 1)
})

test('Huawei: parsea la tabla de ONTs registradas', () => {
  const salida = `
  -----------------------------------------------------------------------------
  F/S/P   ONT     SN            Control     Run      Config   Match    Protect
          ID                    flag        state    state    state    side
  -----------------------------------------------------------------------------
  0/ 1/0    0    485754431A2B3C4D   active   online   normal   match    no
  0/ 1/0    1    485754439ABCDEF0   active   offline  initial  initial  no
  -----------------------------------------------------------------------------
`
  const onts = parseOntInfoAll(salida)

  assert.equal(onts.length, 2)
  assert.equal(onts[0].ontId, 0)
  // La CLI imprime los ocho bytes en hexadecimal, pero lo que está pegado en la
  // etiqueta del equipo —y lo que un técnico lee por teléfono— es "HWTC" más
  // los cuatro últimos. El propio equipo muestra las dos formas juntas en el
  // autofind: "485754439ABCDEF0 (HWTC-9ABCDEF0)". Se guarda la de la etiqueta.
  assert.equal(onts[0].sn, 'HWTC1A2B3C4D')
  assert.equal(onts[1].sn, 'HWTC9ABCDEF0')
  assert.equal(onts[0].estado, 'online')
  assert.equal(onts[1].estado, 'offline')
})

test('Huawei: "do not exist" no es un error, es una lista vacía', () => {
  assert.deepEqual(parseAutofind('Failure: The automatically found ONTs do not exist'), [])
  assert.deepEqual(parseOntInfoAll('Failure: The required ONT does not exist'), [])
})

test('Huawei: parsea el bloque clave:valor de autofind', () => {
  const salida = `
   Number             : 1
   F/S/P              : 0/1/0
   Ont SN             : 485754439ABCDEF0 (HWTC-9ABCDEF0)
   VendorID           : HWTC
   Ont EquipmentID    : HG8310M
  ----------------------------------------------------------------------------
`
  const [ont] = parseAutofind(salida)

  assert.equal(ont.sn, '485754439ABCDEF0')
  assert.equal(ont.equipmentId, 'HG8310M')
  assert.equal(ont.puerto, 0)
})

test('Huawei: la potencia óptica conserva el signo negativo', () => {
  const optica = parseOpticalInfo(`
  Rx optical power(dBm)          : -28.45
  Tx optical power(dBm)          : 2.31
  Temperature(C)                 : 45
`)

  assert.equal(optica.rxPowerDbm, -28.45)
  assert.equal(optica.txPowerDbm, 2.31)
  assert.equal(optica.temperaturaC, 45)
  // Umbral de alerta del taller
  assert.ok(optica.rxPowerDbm < -27)
})

test('Huawei: sin lectura óptica devuelve null (ONT offline)', () => {
  assert.equal(parseOpticalInfo('The ONT is offline'), null)
})
