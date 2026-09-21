import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePuertosPlaca,
  parseVlansDePuerto,
  comprimirRangos,
} from '../src/parsers/huaweiUplinkParser.js'

/**
 * Puertos de subida.
 *
 * Salidas literales del MA5800-X7. Es la pantalla que contesta "¿esta VLAN
 * llega al router?", y una lista incompleta mostrada como completa haría
 * concluir que una VLAN falta cuando en realidad el parser se la comió.
 */

const PLACA = `  ---------------------------------------
  Board Name          : H905MPLB
  Board Status        : Active normal
  ---------------------------------------
  ------------------------------------------------------------------------------
  Port  Port Optic   Native  MDI    Speed      Duplex    Flow-  Active   Link
        Type Status  VLAN           (Mbps)               Ctrl   State
  ------------------------------------------------------------------------------
     0  GE   mismatch     1  -      1000       full      off    active   online
     1  GE   absence      1  -      1000       full      off    active   offline
     2  GE   absence      1  -      1000       full      off    active   offline
     3  GE   absence      1  -      1000       full      off    active   offline
  ------------------------------------------------------------------------------`

const VLANS = `  Command:
          display port vlan 0/9/0
  ---------------------------------------
     1    200    201    202    203    204
   205    206    207    208    209    210
   211    212    213    214    215    216
   217    218    219    220    221    222
   223    224    225    226    227    228
   229    230    231    232    999
  ---------------------------------------
  Total: 35
  Native VLAN: 1`

describe('puertos de una placa de control', () => {
  const r = parsePuertosPlaca(PLACA)

  test('lee la placa y sus cuatro puertos', () => {
    assert.equal(r.placa, 'H905MPLB')
    assert.equal(r.puertos.length, 4)
  })

  test('distingue el puerto con enlace del resto', () => {
    assert.equal(r.puertos[0].online, true)
    assert.equal(r.puertos[1].online, false)
    assert.equal(r.puertos[0].velocidad_mbps, 1000)
    assert.equal(r.puertos[0].duplex, 'full')
  })

  test('"absence" es que no hay SFP puesto, no una falla', () => {
    // Un puerto libre no es un puerto roto. Confundirlos haría salir a buscar
    // un módulo que nunca estuvo.
    assert.equal(r.puertos[0].tiene_sfp, true)
    assert.equal(r.puertos[1].tiene_sfp, false)
    assert.equal(r.puertos[1].medio, 'cobre')
  })

  test('lee la VLAN nativa y el estado administrativo', () => {
    assert.equal(r.puertos[0].vlan_nativa, 1)
    assert.equal(r.puertos[0].habilitado, true)
  })
})

describe('VLANs de un puerto', () => {
  const r = parseVlansDePuerto(VLANS)

  test('lee las 35 que declara el equipo', () => {
    assert.equal(r.vlans.length, 35)
    assert.equal(r.total, 35)
    assert.equal(r.completa, true)
  })

  test('lee la VLAN nativa', () => {
    assert.equal(r.nativa, 1)
  })

  test('avisa si la lista quedó incompleta', () => {
    // Si el equipo dice 35 y se leyeron 30, mostrar la lista como completa
    // haría concluir que faltan VLANs en el troncal cuando el problema es el
    // parseo.
    const parcial = parseVlansDePuerto(`
  ---------------------------------------
     1    200    201
  ---------------------------------------
  Total: 35
  Native VLAN: 1`)
    assert.equal(parcial.vlans.length, 3)
    assert.equal(parcial.completa, false)
  })

  test('no toma el "Total" ni el "Native VLAN" como VLANs', () => {
    assert.ok(!parseVlansDePuerto(VLANS).vlans.includes(35))
  })

  test('un puerto sin VLANs no rompe', () => {
    const vacio = parseVlansDePuerto('  Command:\n  display port vlan 0/9/1\n')
    assert.deepEqual(vacio.vlans, [])
  })
})

describe('compresión en rangos', () => {
  test('agrupa lo consecutivo', () => {
    assert.equal(comprimirRangos([1, 200, 201, 202, 203, 999]), '1, 200-203, 999')
  })

  test('un rango partido se ve', () => {
    // Es el punto de mostrarlo así: en una lista plana de treinta números,
    // que falte el 216 no lo nota nadie.
    assert.equal(comprimirRangos([200, 201, 202, 204, 205]), '200-202, 204-205')
  })

  test('números sueltos quedan sueltos', () => {
    assert.equal(comprimirRangos([100, 500, 888]), '100, 500, 888')
  })

  test('desordenado y con repetidos igual sale bien', () => {
    assert.equal(comprimirRangos([203, 200, 202, 201, 200]), '200-203')
  })

  test('sin VLANs devuelve vacío', () => {
    assert.equal(comprimirRangos([]), '')
    assert.equal(comprimirRangos(null), '')
  })
})
