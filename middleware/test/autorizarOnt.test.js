import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePerfiles,
  parseIndicesServicePort,
  primerIndiceLibre,
} from '../src/parsers/huaweiPerfilParser.js'
import { aHexSn, normalizarSn } from '../src/lib/sn.js'

/**
 * Autorización de una ONT.
 *
 * Todo lo de acá sale del equipo real: los perfiles de `display ont-lineprofile
 * gpon all` y los service-ports del respaldo de configuración del X7, donde
 * están escritas sus 85 ONTs.
 *
 * Es la parte que ESCRIBE en producción. Un índice de service-port mal elegido
 * le pisa el servicio a otro abonado, y una serie mal convertida registra una
 * ONT que no existe.
 */

describe('serie para el comando de registro', () => {
  test('convierte a la forma que espera la CLI', () => {
    // `ont add ... sn-auth "48575443304D1BB2"`. Mandarle "HWTC304D1BB2" sería
    // mandarle otra cosa: el equipo no la reconocería.
    assert.equal(aHexSn('HWTC304D1BB2'), '48575443304D1BB2')
    assert.equal(aHexSn('SKYWB800528F'), '534B5957B800528F')
    assert.equal(aHexSn('RTEGC7085381'), '52544547C7085381')
  })

  test('un hexadecimal ya convertido se deja como está', () => {
    assert.equal(aHexSn('48575443304D1BB2'), '48575443304D1BB2')
  })

  test('ida y vuelta sin pérdida', () => {
    for (const sn of ['HWTC304D1BB2', 'SKYWB800528F', 'CMDCA4A59B9C', 'NBELB17EADD5']) {
      assert.equal(normalizarSn(aHexSn(sn)), sn, sn)
    }
  })
})

describe('perfiles del equipo', () => {
  // Salida literal de `display ont-lineprofile gpon all` en el X7.
  const REAL = `
  ------------------------------------------------------------------------------
  Profile-ID  Profile-name                                Binding times
  ------------------------------------------------------------------------------
  0           line-profile_default_0                      0
  1           LINE_PROFILE_200                            0
  2           SMARTOLT_FLEXIBLE_GPON                      76
  5           Generic_1_V200                              5
  8           SmartOLT_G                                  1
  ------------------------------------------------------------------------------
  Total: 11`

  test('lee id, nombre y cuántas ONTs lo usan', () => {
    const p = parsePerfiles(REAL)
    assert.equal(p.length, 5)
    assert.deepEqual(p[0], { id: 2, nombre: 'SMARTOLT_FLEXIBLE_GPON', usos: 76 })
  })

  test('vienen ordenados por uso: el primero es el que hay que proponer', () => {
    // El perfil que ya usan 76 abonados es casi seguro el correcto para el 77.
    const p = parsePerfiles(REAL)
    assert.deepEqual(
      p.map((x) => x.usos),
      [76, 5, 1, 0, 0],
    )
  })

  test('el encabezado y las líneas de guiones no se cuelan', () => {
    for (const p of parsePerfiles(REAL)) {
      assert.doesNotMatch(p.nombre, /^\d+$/, 'un perfil llamado con un número es basura parseada')
      assert.doesNotMatch(p.nombre, /^-+$/)
    }
  })

  test('una salida vacía no rompe', () => {
    assert.deepEqual(parsePerfiles(''), [])
    assert.deepEqual(parsePerfiles('% Unknown command'), [])
  })
})

describe('índices de service-port', () => {
  // Líneas reales del respaldo del X7.
  const REAL = `
   INDEX VLAN VLAN     PORT F/ S/ P VPI  VCI   FLOW  FLOW       RX   TX   STATE
         ID   ATTR     TYPE                    TYPE  PARA
   -----------------------------------------------------------------------------
        0  999 common   gpon 0/6 /0  1    2     vlan  999        9    9    up
        1  999 common   gpon 0/6 /1  0    2     vlan  999        9    9    up
        2  200 common   gpon 0/6 /0  16   1     vlan  200        11   10   up
        4  200 common   gpon 0/6 /0  1    1     vlan  200        11   10   up   `

  test('reconoce los índices ocupados', () => {
    const usados = parseIndicesServicePort(REAL)
    assert.deepEqual([...usados].sort((a, b) => a - b), [0, 1, 2, 4])
  })

  test('el encabezado no se cuenta como índice', () => {
    assert.ok(!parseIndicesServicePort(REAL).has(NaN))
  })

  test('elige el primer hueco, no el siguiente al último', () => {
    // Reusar uno ocupado le pisaría el servicio a otro abonado; saltar huecos
    // desperdicia índices en un equipo que tiene un tope.
    const usados = parseIndicesServicePort(REAL)
    assert.equal(primerIndiceLibre(usados), 3)
  })

  test('sin nada ocupado empieza en cero', () => {
    assert.equal(primerIndiceLibre(new Set()), 0)
  })

  test('con todo ocupado sigue después del último', () => {
    assert.equal(primerIndiceLibre(new Set([0, 1, 2, 3])), 4)
  })
})
