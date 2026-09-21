import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizarEscaneo,
  extraerIp,
  esIp,
  normalizarMac,
  interpretarVelocidad,
  resumirListas,
  entradasDeLista,
} from '../src/services/importador.js'

/**
 * El importador fusiona cuatro fuentes del router en una lista de clientes.
 * Lo que más importa: que el MISMO abonado, apareciendo en varias fuentes, no
 * termine como tres filas distintas.
 */

test('extraerIp entiende los formatos de RouterOS', () => {
  assert.equal(extraerIp('10.0.0.5'), '10.0.0.5')
  assert.equal(extraerIp('10.0.0.5/32'), '10.0.0.5')
  assert.equal(extraerIp('10.0.0.5/32,10.0.0.6/32'), '10.0.0.5')
  // El target de una queue puede ser una interfaz en vez de una IP.
  assert.equal(extraerIp('ether1'), null)
  assert.equal(extraerIp(''), null)
  assert.equal(extraerIp(undefined), null)
})

test('esIp rechaza octetos fuera de rango', () => {
  assert.ok(esIp('192.168.1.1'))
  assert.ok(!esIp('999.1.1.1'))
  assert.ok(!esIp('10.0.0'))
})

test('normalizarMac unifica el formato', () => {
  assert.equal(normalizarMac('aa:bb:cc:dd:ee:ff'), 'AA:BB:CC:DD:EE:FF')
  assert.equal(normalizarMac('AA-BB-CC-DD-EE-FF'), 'AA:BB:CC:DD:EE:FF')
  assert.equal(normalizarMac('no-es-mac'), null)
})

test('interpretarVelocidad convierte a kbps', () => {
  assert.deepEqual(interpretarVelocidad('25M/50M'), {
    subidaKbps: 25000,
    bajadaKbps: 50000,
    crudo: '25M/50M',
  })
  assert.deepEqual(interpretarVelocidad('512k/1M'), {
    subidaKbps: 512,
    bajadaKbps: 1000,
    crudo: '512k/1M',
  })
  assert.equal(interpretarVelocidad('ilimitado'), null)
  assert.equal(interpretarVelocidad(undefined), null)
})

// ---------------------------------------------------------------------------

test('el mismo cliente en tres fuentes se importa UNA vez', () => {
  const { clientes } = normalizarEscaneo({
    pppSecrets: [{ name: 'jperez', 'remote-address': '10.0.0.5', comment: 'Juan Pérez' }],
    simpleQueues: [{ name: 'q-jperez', target: '10.0.0.5/32', 'max-limit': '25M/50M' }],
    dhcpLeases: [{ address: '10.0.0.5', 'mac-address': 'aa:bb:cc:dd:ee:ff' }],
  })

  assert.equal(clientes.length, 1)
  const c = clientes[0]
  assert.equal(c.ip, '10.0.0.5')
  assert.equal(c.usuario_ppp, 'jperez')
  assert.equal(c.nombre, 'Juan Pérez')
  assert.equal(c.mac_address, 'AA:BB:CC:DD:EE:FF')
  assert.equal(c.velocidad_cruda, '25M/50M')
  assert.equal(c.bajada_kbps, 50000)
  // Deja constancia de dónde salió cada dato.
  assert.equal(c.origenes.length, 3)
})

test('marca como cortados a los que están en la lista de morosos', () => {
  const { clientes, resumen } = normalizarEscaneo(
    {
      simpleQueues: [
        { name: 'Ana', target: '10.0.0.10/32', 'max-limit': '10M/20M' },
        { name: 'Beto', target: '10.0.0.11/32', 'max-limit': '10M/20M' },
      ],
      addressList: [
        { list: 'Moroso', address: '10.0.0.11', comment: 'factura vencida' },
        { list: 'otra-lista', address: '10.0.0.10' },
      ],
    },
    { listaMorosos: 'Moroso' },
  )

  const porNombre = Object.fromEntries(clientes.map((c) => [c.nombre, c]))
  assert.equal(porNombre['Ana'].estado, 'activo')
  assert.equal(porNombre['Beto'].estado, 'cortado')
  assert.equal(resumen.cortados, 1)
})

test('un cortado que no está en otra fuente igual se importa', () => {
  const { clientes } = normalizarEscaneo(
    { addressList: [{ list: 'Moroso', address: '10.0.0.99', comment: 'Cliente viejo' }] },
    { listaMorosos: 'Moroso' },
  )

  assert.equal(clientes.length, 1)
  assert.equal(clientes[0].ip, '10.0.0.99')
  assert.equal(clientes[0].nombre, 'Cliente viejo')
  assert.equal(clientes[0].estado, 'cortado')
})

test('prefiere el comentario sobre el nombre técnico de la queue', () => {
  const { clientes } = normalizarEscaneo({
    simpleQueues: [{ name: 'queue-0042', target: '10.0.0.7/32', comment: 'Panadería La Esquina' }],
  })
  assert.equal(clientes[0].nombre, 'Panadería La Esquina')
})

test('un PPPoE sin IP fija no se pierde', () => {
  const { clientes, resumen } = normalizarEscaneo({
    pppSecrets: [{ name: 'sinip', comment: 'Cliente sin IP fija' }],
  })
  assert.equal(clientes.length, 1)
  assert.equal(clientes[0].usuario_ppp, 'sinip')
  assert.equal(clientes[0].ip, null)
  assert.equal(resumen.sinIp, 1)
})

test('el activo aporta la IP que al secret le falta', () => {
  const { clientes } = normalizarEscaneo({
    pppSecrets: [{ name: 'dinamico', comment: 'Carlos' }],
    pppActive: [{ name: 'dinamico', address: '10.0.0.77' }],
  })

  assert.equal(clientes.length, 1, 'el secret y el activo son el mismo cliente')
  assert.equal(clientes[0].ip, '10.0.0.77')
  assert.equal(clientes[0].nombre, 'Carlos')
})

test('una queue deshabilitada queda como suspendida', () => {
  const { clientes } = normalizarEscaneo({
    simpleQueues: [{ name: 'Pausado', target: '10.0.0.20/32', disabled: 'true' }],
  })
  assert.equal(clientes[0].estado, 'suspendido')
})

test('un escaneo vacío no rompe', () => {
  const r = normalizarEscaneo({})
  assert.deepEqual(r.clientes, [])
  assert.equal(r.resumen.total, 0)
})

test('resume las address-list por cantidad', () => {
  const listas = resumirListas([
    { list: 'Moroso', address: '1.1.1.1' },
    { list: 'Moroso', address: '1.1.1.2' },
    { list: 'permitidos', address: '2.2.2.2' },
  ])
  assert.deepEqual(listas, [
    { nombre: 'Moroso', cantidad: 2 },
    { nombre: 'permitidos', cantidad: 1 },
  ])
})

test('entradasDeLista devuelve lo necesario para copiar a otra lista', () => {
  const e = entradasDeLista(
    [
      { list: 'Moroso', address: '10.0.0.1', comment: 'a' },
      { list: 'otra', address: '10.0.0.2' },
    ],
    'Moroso',
  )
  assert.deepEqual(e, [{ address: '10.0.0.1', comment: 'a' }])
})
