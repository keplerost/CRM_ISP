import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizarEscaneo,
  usuarioDeColaPppoe,
  formatearVelocidad,
} from '../src/services/importador.js'

/**
 * Casos tomados de un router real de un ISP, con la forma exacta que devuelve
 * RouterOS. Los clientes se conectan por PPPoE y las colas de velocidad son
 * dinámicas: se llaman <pppoe-USUARIO> y apuntan a la interfaz, no a una IP.
 *
 * Sin esto, las 93 colas del equipo se importaban como clientes sueltos
 * llamados "<pppoe-0000000371>", separados del abonado real.
 */

// Recortes reales, con los campos que importan.
const COLA = {
  '.id': '*1211',
  name: '<pppoe-0000000371>',
  target: '<pppoe-0000000371>',
  'max-limit': '50000000/50000000',
  dynamic: 'true',
  disabled: 'false',
}

const ACTIVO = {
  '.id': '*8000004F',
  name: '0000000371',
  service: 'pppoe',
  'caller-id': '1C:E5:04:FC:F5:A3',
  address: '172.16.12.131',
  comment: 'Palma Romero Julyana Jazmin',
}

const SECRET = {
  '.id': '*45',
  name: '0000000371',
  service: 'pppoe',
  profile: 'PLAN PRO MAX 400Mbps',
  disabled: 'false',
}

test('usuarioDeColaPppoe extrae el usuario del nombre dinámico', () => {
  assert.equal(usuarioDeColaPppoe('<pppoe-0000000371>'), '0000000371')
  assert.equal(usuarioDeColaPppoe('<l2tp-tecnico>'), 'tecnico')
  // Una cola normal no tiene esa forma.
  assert.equal(usuarioDeColaPppoe('cola-cliente-5'), null)
  assert.equal(usuarioDeColaPppoe(undefined), null)
})

test('formatearVelocidad hace legibles los bits por segundo', () => {
  assert.equal(formatearVelocidad('50000000/50000000'), '50M/50M')
  assert.equal(formatearVelocidad('150000000/300000000'), '150M/300M')
  assert.equal(formatearVelocidad('512000/1000000'), '512k/1M')
})

test('la cola dinámica, el secret y la sesión activa son UN cliente', () => {
  const { clientes } = normalizarEscaneo({
    simpleQueues: [COLA],
    pppSecrets: [SECRET],
    pppActive: [ACTIVO],
  })

  assert.equal(clientes.length, 1, 'las tres fuentes describen al mismo abonado')

  const c = clientes[0]
  // El nombre sale del comentario de la sesión activa, no del "<pppoe-...>".
  assert.equal(c.nombre, 'Palma Romero Julyana Jazmin')
  assert.equal(c.usuario_ppp, '0000000371')
  assert.equal(c.ip, '172.16.12.131')
  assert.equal(c.mac_address, '1C:E5:04:FC:F5:A3', 'la MAC viene del caller-id')
  assert.equal(c.velocidad, '50M/50M')
  assert.equal(c.velocidad_cruda, '50000000/50000000', 'el crudo se conserva para reexportar')
  assert.equal(c.perfil, 'PLAN PRO MAX 400Mbps')
})

test('ningún cliente queda llamado "<pppoe-...>"', () => {
  const { clientes } = normalizarEscaneo({
    simpleQueues: [COLA, { name: '<pppoe-0000002205>', target: '<pppoe-0000002205>', 'max-limit': '150000000/150000000' }],
    pppActive: [ACTIVO],
  })

  for (const c of clientes) {
    assert.ok(!/^<pppoe-/.test(c.nombre), `quedó un nombre técnico: ${c.nombre}`)
  }
})

test('los accesos que no son de abonados quedan afuera', () => {
  // En el router real había un secret "tecnico" con servicio l2tp.
  const { clientes, noClientes } = normalizarEscaneo({
    pppSecrets: [
      SECRET,
      { name: 'tecnico', service: 'l2tp', 'remote-address': '172.16.10.2' },
      { name: 'vpn-oficina', service: 'sstp' },
    ],
    pppActive: [ACTIVO],
  })

  assert.equal(clientes.length, 1)
  assert.equal(noClientes.length, 2)
  assert.deepEqual(
    noClientes.map((n) => n.nombre).sort(),
    ['tecnico', 'vpn-oficina'],
  )
})

test('un cortado se detecta aunque el comentario traiga el código y no el nombre', () => {
  // En la lista Moroso real, unos comentarios son el código del abonado y
  // otros el nombre. Un cliente desconectado no tiene IP activa que matchear.
  const { clientes } = normalizarEscaneo(
    {
      pppSecrets: [SECRET],
      addressList: [{ list: 'Moroso', address: '172.16.99.99', comment: '0000000371' }],
    },
    { listaMorosos: 'Moroso' },
  )

  const cliente = clientes.find((c) => c.usuario_ppp === '0000000371')
  assert.equal(cliente.estado, 'cortado')
})

test('un cortado se detecta por IP cuando está conectado', () => {
  const { clientes } = normalizarEscaneo(
    {
      pppSecrets: [SECRET],
      pppActive: [ACTIVO],
      addressList: [{ list: 'Moroso', address: '172.16.12.131', comment: 'Palma Romero' }],
    },
    { listaMorosos: 'Moroso' },
  )

  assert.equal(clientes[0].estado, 'cortado')
})
