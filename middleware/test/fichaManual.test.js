import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { claveLegible, ssidSugerido } from '../src/services/fichaManual.js'

/**
 * La ficha que se le da al técnico cuando la ONT no acepta TR069.
 *
 * Lo que se prueba acá no es "que devuelva algo": es que lo que devuelva se
 * pueda escribir en un equipo y dictar por teléfono. Una clave con una "l" y un
 * "1" significa una llamada más al soporte, y un SSID con una "ñ" significa un
 * abonado que no ve su red.
 */

describe('la clave del WiFi', () => {
  test('no trae caracteres que se confundan al dictarla', () => {
    // El soporte dicta estas claves todo el día por teléfono. l/I/1 y O/0 son
    // el motivo de la mitad de las llamadas repetidas.
    const prohibidos = /[lI1O0]/
    for (let i = 0; i < 200; i++) {
      const c = claveLegible(12)
      assert.ok(!prohibidos.test(c), `"${c}" tiene un carácter ambiguo`)
    }
  })

  test('tiene el largo pedido', () => {
    assert.equal(claveLegible(8).length, 8)
    assert.equal(claveLegible(16).length, 16)
  })

  test('llega al mínimo que exige el WiFi', () => {
    // WPA2 no acepta menos de ocho. Una clave de seis se guarda en el sistema y
    // el equipo la rechaza recién al aplicarla, con el técnico ya en la calle.
    assert.ok(claveLegible().length >= 8)
  })

  test('no repite la misma dos veces', () => {
    const vistas = new Set()
    for (let i = 0; i < 100; i++) vistas.add(claveLegible())
    assert.equal(vistas.size, 100)
  })
})

describe('el nombre de la red', () => {
  test('usa el nombre del abonado', () => {
    assert.equal(ssidSugerido({ marca: 'HOMELINK', nombre: 'Jose Perez' }), 'HOMELINK_JOSE_PEREZ')
  })

  test('saca los acentos y las eñes', () => {
    // Varios modelos de ONT los rechazan o los guardan mal, y el abonado ve una
    // red con signos raros que no puede escribir en el celular.
    const r = ssidSugerido({ marca: 'HOMELINK', nombre: 'José Luis Oña' })
    assert.match(r, /^[\x20-\x7E]+$/)
    assert.ok(!/[ÑñÉé]/.test(r))
    assert.equal(r, 'HOMELINK_JOSE_LUIS')
  })

  test('se queda con dos nombres, no con los cuatro', () => {
    const r = ssidSugerido({ marca: 'W', nombre: 'Maria Del Carmen Rodriguez Perez' })
    assert.equal(r, 'W_MARIA_DEL')
  })

  test('sin nombre, usa los últimos del serial', () => {
    // Feo pero único. Una red llamada solo "WIFI" en un barrio donde hay veinte
    // iguales no le sirve a nadie.
    assert.equal(ssidSugerido({ marca: 'WIFI', sn: 'HWTC44E5139B' }), 'WIFI_139B')
  })

  test('no se pasa de 32 caracteres', () => {
    // Es el máximo que admite el estándar. Uno más largo lo trunca el equipo, y
    // lo trunca distinto en cada modelo.
    const r = ssidSugerido({
      marca: 'UNPROVEEDORCONNOMBRELARGUISIMO',
      nombre: 'Maria Del Carmen Rodriguez',
    })
    assert.ok(r.length <= 32, `${r.length} caracteres`)
  })
})
