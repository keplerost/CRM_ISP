import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseOntVersion, parseAutofind } from '../src/parsers/huaweiOntParser.js'

/**
 * El modelo de una ONT sale de dos comandos distintos, y el equipo lo llama
 * distinto en cada uno. Conocer una sola forma dejaba la columna "Modelo" vacía
 * justo para las ONTs ya autorizadas — o sea, para todas.
 */

// display ont version 0 4 — con guiones
const VERSION = `  F/S/P                    : 0/6/0
  ONT-ID                   : 4
  Vendor-ID                : HWTC
  ONT Version              : 2C6D.A
  Product-ID               : 2c6
  Equipment-ID             : HG8145X6-10
  Main Software Version    : V5R022C00S294
  Standby Software Version : V5R022C00S294
  Ont MAC                  : 6CD1-E578-C92F
  Ont Equipment SN         : 2150087432AGQ8006653`

// display ont autofind 9 — sin guiones
const AUTOFIND = `   F/S/P               : 0/6/9
   Ont SN              : 534B5957B800528F (SKYW-B800528F)
   VendorID            : SKYW
   Ont Version         : V1.0
   Ont SoftwareVersion : V2.2.0.10
   Ont EquipmentID     : GN256VH
   Ont autofind time   : 2026-08-03 23:27:12-05:00`

describe('el modelo, escrito de las dos formas', () => {
  test('"Equipment-ID" con guion, de display ont version', () => {
    const v = parseOntVersion(VERSION)
    assert.equal(v.modelo, 'HG8145X6-10')
    assert.equal(v.vendorId, 'HWTC')
    assert.equal(v.versionSoftware, 'V5R022C00S294')
  })

  test('"Ont EquipmentID" sin guion, de display ont autofind', () => {
    const [a] = parseAutofind(AUTOFIND)
    assert.equal(a.equipmentId, 'GN256VH')
    assert.equal(a.vendorId, 'SKYW')
  })

  test('la MAC y la serie del fabricante también se leen', () => {
    // El equipo las tiene y no las estábamos guardando. La MAC es lo que se
    // busca cuando aparece un equipo en la red y no se sabe de quién es.
    const v = parseOntVersion(VERSION)
    assert.equal(v.mac, '6CD1-E578-C92F')
    assert.equal(v.equipoSn, '2150087432AGQ8006653')
  })

  test('una salida vacía no inventa un modelo', () => {
    assert.equal(parseOntVersion('')?.modelo ?? null, null)
  })
})

/**
 * El Equipment-ID recortado.
 *
 * Un HG8310M con firmware V3R015 devuelve su Equipment-ID como "310M"; el mismo
 * aparato con V3R017 lo devuelve entero. Sin corregirlo quedan dos modelos en el
 * catálogo para un solo equipo, y a uno de los dos hay que cargarle la foto y
 * los puertos otra vez — con la mitad de los abonados mostrando datos de un
 * equipo que no es el suyo.
 *
 * Salidas reales de la OLT de este ISP.
 */
describe('cuando el equipo recorta el modelo', () => {
  const recortado = `
  F/S/P                    : 0/6/0
  ONT-ID                   : 21
  Vendor-ID                : HWTC
  ONT Version              : 6A5.A
  Product-ID               : 6a
  Equipment-ID             : 310M
  Main Software Version    : V3R015C10S106
  OntProductDescription    : HG8310M GPON/EPON Terminal (CLASS C+/PX20+/PRODUCT ID:xxx)
`

  const entero = `
  F/S/P                    : 0/6/4
  ONT-ID                   : 16
  Vendor-ID                : HWTC
  Equipment-ID             : HG8310M
  Main Software Version    : V3R017C00S100
  OntProductDescription    : EchoLife HG8310M GPON/EPON Terminal (CLASS C+/PX20+)
`

  test('lo completa con el nombre de la descripción', () => {
    assert.equal(parseOntVersion(recortado).modelo, 'HG8310M')
  })

  test('deja constancia de lo que dijo el equipo', () => {
    // Sin esto, alguien que compare contra la CLI vería "HG8310M" donde el
    // equipo dice "310M" y no sabría de dónde salió la diferencia.
    assert.equal(parseOntVersion(recortado).modelo_declarado, '310M')
  })

  test('las dos formas del mismo aparato terminan en el mismo modelo', () => {
    // Es todo el punto: que no queden dos tipos para un solo equipo.
    assert.equal(parseOntVersion(recortado).modelo, parseOntVersion(entero).modelo)
  })

  test('cuando ya está entero no lo toca ni deja constancia de nada', () => {
    const r = parseOntVersion(entero)
    assert.equal(r.modelo, 'HG8310M')
    assert.equal(r.modelo_declarado, undefined)
  })

  test('no reemplaza un modelo por otro que se le parezca', () => {
    // La regla exige que la palabra TERMINE con lo declarado. "HG8145X6-13" no
    // termina en "HG8310M", así que una descripción de otro equipo no lo pisa.
    const cruzado = `
  Equipment-ID             : HG8310M
  OntProductDescription    : OptiXstar HG8145X6-13 GPON Terminal
`
    assert.equal(parseOntVersion(cruzado).modelo, 'HG8310M')
  })

  test('sin descripción se queda con lo declarado', () => {
    const solo = `
  Equipment-ID             : 310M
  Vendor-ID                : HWTC
`
    assert.equal(parseOntVersion(solo).modelo, '310M')
  })
})
