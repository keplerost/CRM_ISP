import test from 'node:test'
import assert from 'node:assert/strict'

import { esIpv4, mismaRed, parametros, revisar, leerWan, esHuawei, aplicar, MODOS } from '../src/drivers/genieacsWan.js'
import { config } from '../src/config.js'

/**
 * El aprovisionamiento de la WAN por TR-069.
 *
 * ── Por qué esto se prueba tanto ──
 *
 * Porque un pedido mal armado NO falla. La ONT acepta los parámetros que
 * entiende, ignora los que no, y queda con media configuración: el abonado sin
 * internet y el ACS informando que el cambio se aplicó. No hay excepción que
 * atrapar ni error que leer — solo un teléfono que suena.
 *
 * Y a diferencia del WiFi, un cambio de WAN puede dejar al equipo sin camino de
 * vuelta al ACS. Ahí ya no se arregla a distancia: hay que ir.
 */

test('los tres modos, y nada más', () => {
  assert.deepEqual(MODOS, ['pppoe', 'dhcp', 'estatica'])
  assert.deepEqual(revisar({ modo: 'bridge' }).length, 1)
  assert.match(revisar({ modo: 'bridge' })[0], /Modo desconocido/)
})

test('PPPoE sin credenciales no se manda', () => {
  /**
   * Es el caso que deja la conexión creada y sin levantar: la ONT arma el enlace
   * con usuario vacío, el BRAS lo rechaza, y desde el ACS la WAN figura
   * habilitada.
   */
  const p = revisar({ modo: 'pppoe' })
  assert.ok(p.some((x) => /usuario/i.test(x)))
  assert.ok(p.some((x) => /clave/i.test(x)))

  assert.deepEqual(revisar({ modo: 'pppoe', usuario: 'juan@isp', clave: 'x' }), [])
})

test('la IP fija se revisa entera, no de a un campo', () => {
  // Quien está cargando una WAN quiere ver todo lo que le falta de una vez.
  const p = revisar({ modo: 'estatica', ip: 'no-es-ip', mascara: '', puerta: '' })
  assert.equal(p.length, 3, `esperaba tres problemas, dio ${p.length}: ${p.join(' · ')}`)
})

test('la puerta de enlace tiene que estar en la misma red', () => {
  /**
   * El error más común al cargar a mano —un dígito de más en el tercer octeto— y
   * el más caro: la conexión levanta, la ONT toma la IP, y no sale nada. Desde el
   * ACS se ve todo bien.
   */
  const mal = revisar({
    modo: 'estatica', ip: '181.198.20.10', mascara: '255.255.255.0', puerta: '181.198.21.1',
  })
  assert.ok(mal.some((x) => /misma red/i.test(x)), `no lo detectó: ${mal.join(' · ')}`)

  const bien = revisar({
    modo: 'estatica', ip: '181.198.20.10', mascara: '255.255.255.0', puerta: '181.198.20.1',
  })
  assert.deepEqual(bien, [])
})

test('la máscara /30 de un enlace punto a punto también vale', () => {
  // Los enlaces corporativos usan /30 y una validación que solo entienda /24
  // rechazaría al cliente que más paga.
  assert.ok(mismaRed('190.15.140.6', '190.15.140.5', '255.255.255.252'))
  assert.ok(!mismaRed('190.15.140.6', '190.15.140.9', '255.255.255.252'))
})

test('una VLAN fuera de rango no se escribe', () => {
  assert.deepEqual(revisar({ modo: 'dhcp', vlan: 100 }), [])
  assert.ok(revisar({ modo: 'dhcp', vlan: 0 }).length)
  assert.ok(revisar({ modo: 'dhcp', vlan: 4095 }).length)
  assert.ok(revisar({ modo: 'dhcp', vlan: 'ochenta' }).length)
})

test('una dirección con octetos de más no pasa', () => {
  assert.ok(esIpv4('10.0.0.1'))
  assert.ok(esIpv4('255.255.255.255'))
  assert.ok(!esIpv4('10.0.0'))
  assert.ok(!esIpv4('10.0.0.256'))
  assert.ok(!esIpv4('10.0.0.1.5'))
  assert.ok(!esIpv4(''))
})

test('PPPoE en TR-098 va al objeto de PPP, no al de IP', () => {
  /**
   * Son dos objetos distintos del estándar y elegir el modo es elegir cuál. Poner
   * el usuario de PPPoE dentro de `WANIPConnection` no da error: se escribe un
   * parámetro que el equipo ignora.
   */
  const { ruta, objeto, escribir } = parametros({
    modelo: 'tr098', modo: 'pppoe', usuario: 'juan@isp.ec', clave: 'secreta',
  })

  assert.equal(objeto, 'WANPPPConnection')
  assert.match(ruta, /WANPPPConnection\.1$/)

  const nombres = escribir.map(([n]) => n)
  assert.ok(nombres.some((n) => n.endsWith('.Username')))
  assert.ok(nombres.some((n) => n.endsWith('.Password')))
  assert.ok(!nombres.some((n) => n.includes('WANIPConnection')))
})

test('la IP fija va al objeto de IP y con su direccionamiento', () => {
  const { objeto, escribir } = parametros({
    modelo: 'tr098', modo: 'estatica',
    ip: '181.198.20.10', mascara: '255.255.255.0', puerta: '181.198.20.1', dns: '8.8.8.8, 1.1.1.1',
  })

  assert.equal(objeto, 'WANIPConnection')

  const como = Object.fromEntries(escribir.map(([n, v]) => [n.split('.').pop(), v]))
  assert.equal(como.AddressingType, 'Static')
  assert.equal(como.ExternalIPAddress, '181.198.20.10')
  assert.equal(como.DefaultGateway, '181.198.20.1')
  // Los DNS se limpian de espacios: "8.8.8.8, 1.1.1.1" con espacio rompe en
  // algunos firmwares que parten la cadena por coma sin recortar.
  assert.equal(como.DNSServers, '8.8.8.8,1.1.1.1')
})

test('DHCP no escribe IP, máscara ni puerta', () => {
  /**
   * Mandarlas "por si acaso" es lo que deja un equipo con direccionamiento DHCP y
   * una IP fija escrita debajo: según el firmware, gana cualquiera de las dos.
   */
  const { escribir } = parametros({ modelo: 'tr098', modo: 'dhcp' })
  const nombres = escribir.map(([n]) => n)

  assert.ok(!nombres.some((n) => n.endsWith('.ExternalIPAddress')))
  assert.ok(!nombres.some((n) => n.endsWith('.SubnetMask')))
  assert.ok(!nombres.some((n) => n.endsWith('.DefaultGateway')))
  assert.ok(nombres.some((n) => n.endsWith('.AddressingType')))
})

test('el NAT se enciende siempre', () => {
  // Sin NAT la WAN toma IP y ningún equipo de la casa navega. Es el síntoma que
  // más se confunde con "no hay servicio".
  for (const modo of ['pppoe', 'dhcp']) {
    const { escribir } = parametros({
      modelo: 'tr098', modo, usuario: 'u', clave: 'c',
    })
    assert.ok(
      escribir.some(([n, v]) => n.endsWith('.NATEnabled') && v === '1'),
      `${modo} quedó sin NAT`,
    )
  }
})

test('a las Huawei se les escribe la lista de servicios', () => {
  /**
   * Es el parámetro que más cuesta descubrir: la conexión se crea, el enlace
   * levanta, y el abonado sigue sin internet porque la ONT no sabe que esa WAN es
   * para el servicio de datos.
   */
  const { escribir } = parametros({
    modelo: 'tr098', modo: 'pppoe', usuario: 'u', clave: 'c', vlan: 100, esHuawei: true,
  })

  const como = Object.fromEntries(escribir.map(([n, v]) => [n.split('.').pop(), v]))
  assert.equal(como.X_HW_SERVICELIST, 'INTERNET')
  assert.equal(como.X_HW_VLAN, '100')
})

test('a las que no son Huawei no se les inventan parámetros', () => {
  const { escribir } = parametros({
    modelo: 'tr098', modo: 'dhcp', vlan: 100, esHuawei: false,
  })
  assert.ok(!escribir.some(([n]) => n.includes('X_HW')))
})

test('sin modelo de datos no se escribe nada', () => {
  /**
   * Un equipo que todavía no informó no tiene árbol de parámetros. Adivinar
   * dónde escribir es lo que deja la mitad de la configuración puesta.
   */
  assert.throws(
    () => parametros({ modelo: null, modo: 'dhcp' }),
    /modelo de datos conocido/,
  )
})

test('un pedido inválido no llega a armar parámetros', () => {
  assert.throws(
    () => parametros({ modelo: 'tr098', modo: 'estatica', ip: 'mal' }),
    /No se puede aprovisionar/,
  )
})

test('la clave de PPPoE nunca se devuelve al leer', () => {
  /**
   * Esta pantalla la ven el técnico y la oficina. Una clave de PPPoE a la vista
   * es una credencial de red regalada, y encima suele ser la misma para todo el
   * padrón.
   */
  const equipo = {
    InternetGatewayDevice: {
      WANDevice: {
        1: {
          WANConnectionDevice: {
            1: {
              WANPPPConnection: {
                1: {
                  Enable: { _value: true },
                  Username: { _value: 'juan@isp.ec' },
                  Password: { _value: 'la-clave-secreta' },
                  ConnectionStatus: { _value: 'Connected' },
                },
              },
            },
          },
        },
      },
    },
  }

  const wan = leerWan(equipo, { modelo: 'tr098' })

  assert.equal(wan.modo, 'pppoe')
  assert.equal(wan.usuario, 'juan@isp.ec')
  assert.equal(wan.estado, 'Connected')
  assert.ok(!('clave' in wan), 'la clave no puede viajar al frente')
  assert.ok(!JSON.stringify(wan).includes('la-clave-secreta'))
})

test('con PPPoE y una IP a la vez, gana la PPPoE', () => {
  /**
   * Un equipo puede tener las dos: la PPPoE para internet y una DHCP para que el
   * ACS lo alcance. Mirar solo una haría decir "está en DHCP" sobre un abonado
   * que navega por PPPoE — y el técnico cambiaría la que no era.
   */
  const equipo = {
    InternetGatewayDevice: {
      WANDevice: {
        1: {
          WANConnectionDevice: {
            1: {
              WANPPPConnection: { 1: { Enable: { _value: true }, Username: { _value: 'juan' } } },
              WANIPConnection: { 1: { Enable: { _value: true }, AddressingType: { _value: 'DHCP' } } },
            },
          },
        },
      },
    },
  }

  assert.equal(leerWan(equipo, { modelo: 'tr098' }).modo, 'pppoe')
})

test('si la PPPoE existe pero está apagada, gana la que sí está activa', () => {
  /**
   * Encontrado probando esto contra un ACS real: una ONT a la que alguna vez
   * se le cambió el modo se queda con el objeto viejo, deshabilitado, al lado
   * del nuevo. Devolver "pppoe" solo porque el objeto EXISTE —sin mirar si
   * está prendido— hacía decir "está en PPPoE" sobre un abonado que navega
   * por DHCP.
   */
  const equipo = {
    InternetGatewayDevice: {
      WANDevice: {
        1: {
          WANConnectionDevice: {
            1: {
              WANPPPConnection: { 1: { Enable: { _value: false }, Username: { _value: 'viejo@isp.ec' } } },
              WANIPConnection: { 1: { Enable: { _value: true }, AddressingType: { _value: 'DHCP' } } },
            },
          },
        },
      },
    },
  }

  const wan = leerWan(equipo, { modelo: 'tr098' })
  assert.equal(wan.modo, 'dhcp')
  assert.equal(wan.habilitada, true)
})

test('si las dos están apagadas, se muestra la primera antes que nada', () => {
  const equipo = {
    InternetGatewayDevice: {
      WANDevice: {
        1: {
          WANConnectionDevice: {
            1: {
              WANPPPConnection: { 1: { Enable: { _value: false } } },
              WANIPConnection: { 1: { Enable: { _value: false }, AddressingType: { _value: 'DHCP' } } },
            },
          },
        },
      },
    },
  }

  const wan = leerWan(equipo, { modelo: 'tr098' })
  assert.equal(wan.modo, 'pppoe')
  assert.equal(wan.habilitada, false)
})

// --- aplicar: lo que de verdad manda algo al equipo ------------------------

/** Reemplaza fetch para devolver una respuesta fija durante `fn`. */
function conFetchSimulado(respuesta, fn) {
  const original = globalThis.fetch
  globalThis.fetch = respuesta instanceof Error
    ? async () => { throw respuesta }
    : async () => new Response(JSON.stringify(respuesta), { status: 200 })
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

const equipoConIp = {
  _id: 'huawei-1',
  _deviceId: { _Manufacturer: 'HUAWEI TECHNOLOGIES CO.,LTD' },
  InternetGatewayDevice: {
    WANDevice: {
      1: {
        WANConnectionDevice: {
          1: {
            WANIPConnection: { 1: { Enable: { _value: true }, AddressingType: { _value: 'DHCP' } } },
          },
        },
      },
    },
  },
}

test('esHuawei se lee del fabricante que reportó el equipo', () => {
  assert.ok(esHuawei(equipoConIp))
  assert.ok(!esHuawei({ _deviceId: { _Manufacturer: 'ZTE' } }))
  assert.ok(!esHuawei({}))
})

test('aplicar no deja escribir sobre una conexión que la ONT no tiene creada', async () => {
  config.genieacs.url = 'http://acs-de-prueba.local:7557'
  await assert.rejects(
    () => aplicar(equipoConIp, { modo: 'pppoe', usuario: 'juan', clave: 'secreta' }),
    /no tiene creada la conexión WANPPPConnection/,
  )
})

test('aplicar escribe sobre la conexión que sí existe, y avisa si el equipo no contesta', async () => {
  config.genieacs.url = 'http://acs-de-prueba.local:7557'

  const ok = await conFetchSimulado({}, () => aplicar(equipoConIp, { modo: 'dhcp' }))
  assert.equal(ok.aplicado, true)
  assert.match(ok.ruta, /WANIPConnection\.1$/)

  const encolado = await conFetchSimulado(
    new Error('fetch failed'),
    () => aplicar(equipoConIp, { modo: 'dhcp' }),
  )
  assert.equal(encolado.aplicado, false)
  assert.ok(encolado.encolado)
})

test('aplicar valida antes de tocar la red: un pedido inválido no llega a llamar a fetch', async () => {
  config.genieacs.url = 'http://acs-de-prueba.local:7557'
  let llamadoFetch = false
  const original = globalThis.fetch
  globalThis.fetch = async () => { llamadoFetch = true; throw new Error('no debería llamarse') }
  try {
    await assert.rejects(
      () => aplicar(equipoConIp, { modo: 'estatica', ip: 'mal' }),
      /No se puede aprovisionar/,
    )
    assert.ok(!llamadoFetch)
  } finally {
    globalThis.fetch = original
  }
})
