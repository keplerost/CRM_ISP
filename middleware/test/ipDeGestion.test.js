import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseOntIpconfig } from '../src/parsers/huaweiOntParser.js'

/**
 * La IP de gestión de una ONT.
 *
 * Es la dirección por la que el ACS le habla para configurarle el usuario y la
 * clave PPPoE. Sin ella la ONT está online, pasa tráfico, y es inadministrable:
 * no se le puede empujar la configuración ni leerle el WiFi.
 *
 * Se relee después de escribirla porque el equipo acepta el comando aunque el
 * modelo no soporte configuración estática, y en ese caso la deja en blanco. Si
 * la lectura no distinguiera ese caso, el alta diría "listo" sobre una ONT que
 * quedó incomunicada.
 */

const REAL = `
  Command:
          display ont ipconfig 0 0
  --------------------------------------------------------------------
  ONT IP host index        : 0
  ONT config type          : Static config
  ONT IP                   : 192.168.240.225
  ONT subnet mask          : 255.255.255.0
  ONT gateway              : 192.168.240.1
  ONT primary DNS          : 8.8.8.8
  ONT slave DNS            : 8.8.4.4
  ONT manage VLAN          : 999
  ONT manage priority      : 2
  Dscp mapping table index : 0
  --------------------------------------------------------------------
`

describe('la salida real del equipo', () => {
  const r = parseOntIpconfig(REAL)

  test('la dirección', () => {
    assert.equal(r.ip, '192.168.240.225')
  })

  test('la máscara, que es la que hay que repetir al escribir', () => {
    assert.equal(r.mascara, '255.255.255.0')
  })

  test('el gateway y los DNS', () => {
    assert.equal(r.gateway, '192.168.240.1')
    assert.equal(r.dns1, '8.8.8.8')
    assert.equal(r.dns2, '8.8.4.4')
  })

  test('la VLAN de gestión, como número', () => {
    // Como texto, compararla contra la del pool daría falso: "999" !== 999.
    assert.equal(r.vlan, 999)
    assert.equal(typeof r.vlan, 'number')
  })

  test('reconoce que es estática', () => {
    assert.equal(r.estatica, true)
  })
})

describe('los casos que hay que distinguir', () => {
  test('una ONT en DHCP no se confunde con una estática', () => {
    const r = parseOntIpconfig(`
  ONT config type          : DHCP config
  ONT IP                   : 192.168.240.30
  ONT manage VLAN          : 999
`)
    assert.equal(r.estatica, false)
    assert.equal(r.ip, '192.168.240.30')
  })

  test('una ONT sin IP devuelve null en la dirección, no un guion', () => {
    // El equipo escribe "-" cuando el campo está vacío. Devolverlo como texto
    // haría que la comparación contra la IP pedida pasara por válida y el alta
    // diera por buena una ONT incomunicada.
    const r = parseOntIpconfig(`
  ONT config type          : Static config
  ONT IP                   : -
  ONT subnet mask          : -
  ONT manage VLAN          : 999
`)
    assert.equal(r.ip, null)
    assert.equal(r.mascara, null)
  })

  test('una salida que no habla de ipconfig devuelve null entero', () => {
    // Un objeto lleno de nulos se leería como "la ONT no tiene IP"; null dice
    // "no se pudo leer", que es otra cosa.
    assert.equal(parseOntIpconfig('% Parameter error'), null)
    assert.equal(parseOntIpconfig(''), null)
  })
})

describe('la máscara a partir del prefijo', () => {
  // La sintaxis del equipo pide la máscara en notación larga y los pools se
  // cargan en CIDR. Convertir mal reparte direcciones de otra red.
  const mascaraDeCidr = (cidr) => {
    const bits = Number(String(cidr ?? '').split('/')[1])
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return '255.255.255.0'
    const m = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return [(m >>> 24) & 255, (m >>> 16) & 255, (m >>> 8) & 255, m & 255].join('.')
  }

  test('/24', () => assert.equal(mascaraDeCidr('192.168.240.0/24'), '255.255.255.0'))
  test('/25', () => assert.equal(mascaraDeCidr('172.16.16.0/25'), '255.255.255.128'))
  test('/20', () => assert.equal(mascaraDeCidr('10.100.0.0/20'), '255.255.240.0'))
  test('/30', () => assert.equal(mascaraDeCidr('10.0.0.0/30'), '255.255.255.252'))

  test('sin prefijo cae en la más común en vez de romper', () => {
    // Es un dato que viene de la base y podría estar mal cargado. Un /24 es la
    // suposición menos dañina: una máscara inválida haría fallar el alta entera.
    assert.equal(mascaraDeCidr('192.168.240.0'), '255.255.255.0')
    assert.equal(mascaraDeCidr(null), '255.255.255.0')
  })
})
