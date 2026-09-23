import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compararColas,
  compararLeases,
  normalizarVelocidad,
  soloIp,
} from '../src/lib/comparaRouter.js'

/**
 * Comparar el sistema contra el MikroTik.
 *
 * ── Qué se protege ──
 *
 * El caso que nadie ve: se le cambia la IP a un abonado justo cuando el túnel
 * está caído. El sistema guarda la nueva, el router se queda con la vieja, y en
 * la pantalla todo se ve bien.
 *
 * El abonado sigue navegando —su cola vieja lo limita igual— así que no
 * reclama. Y el día que hay que cortarlo, el corte agrega a la lista la IP
 * NUEVA, que en el router no es de nadie: se corta a nadie. Navega gratis hasta
 * que alguien lo nota de casualidad.
 *
 * Lo segundo que se protege es que la comparación NO encuentre diferencias
 * donde no las hay: si las encontrara, reparar reescribiría las veintisiete
 * colas en cada pasada y el informe dejaría de significar algo.
 */

const cola = (extra = {}) => ({
  '.id': '*1',
  name: 'JUAN PEREZ',
  target: '10.10.7.9/32',
  'max-limit': '150M/150M',
  'limit-at': '12M/12M',
  ...extra,
})

const esperado = new Map([
  ['plan-home', { 'max-limit': '150000k/150000k', 'limit-at': '12000k/12000k' }],
])

const cliente = (extra = {}) => ({ id: 'c1', nombre: 'JUAN PEREZ', ip: '10.10.7.9', plan_id: 'plan-home', ...extra })

// ── normalizarVelocidad ──────────────────────────────────────────────────────

test('150M y 150000k son la misma velocidad', () => {
  // El sistema escribe en kbps y RouterOS devuelve lo más corto. Sin esto, cada
  // revisión encontraría diferencias en todos los abonados.
  assert.equal(normalizarVelocidad('150M/150M'), normalizarVelocidad('150000k/150000k'))
  assert.equal(normalizarVelocidad('12M/12M'), normalizarVelocidad('12000k/12000k'))
})

test('distintas velocidades siguen siendo distintas', () => {
  assert.notEqual(normalizarVelocidad('150M/150M'), normalizarVelocidad('300M/300M'))
  assert.notEqual(normalizarVelocidad('12M/12M'), normalizarVelocidad('0/0'))
})

test('un valor sin sufijo se lee como bits', () => {
  // RouterOS devuelve "0/0" para lo que no está configurado.
  assert.equal(normalizarVelocidad('0/0'), '0/0')
})

// ── soloIp ───────────────────────────────────────────────────────────────────

test('la máscara no cuenta al comparar', () => {
  assert.equal(soloIp('10.10.7.9/32'), '10.10.7.9')
  assert.equal(soloIp(' 10.10.7.9 '), '10.10.7.9')
  assert.equal(soloIp(null), '')
})

// ── compararColas ────────────────────────────────────────────────────────────

test('una cola que coincide no genera ruido', () => {
  const r = compararColas({ clientes: [cliente()], colas: [cola()], esperadoPorPlan: esperado })
  assert.deepEqual([r.faltan.length, r.corregir.length, r.duplicadas.length], [0, 0, 0])
})

test('detecta al abonado que quedó sin cola', () => {
  // Navega sin límite: recibe lo que dé el puerto aunque pague 150.
  const r = compararColas({ clientes: [cliente()], colas: [], esperadoPorPlan: esperado })
  assert.equal(r.faltan.length, 1)
  assert.match(r.faltan[0].motivo, /sin límite/)
})

test('EL CASO: le cambiaron la IP con el router caído', () => {
  // La cola del router apunta a la vieja; el sistema ya tiene la nueva.
  // Para el abonado no cambia nada —sigue limitado por la cola vieja— pero el
  // corte iría a una IP que en el router no es de nadie.
  const r = compararColas({
    clientes: [cliente({ ip: '10.10.7.50' })],
    colas: [cola({ target: '10.10.7.9/32' })],
    esperadoPorPlan: esperado,
  })

  assert.equal(r.faltan.length, 1, 'el abonado tiene que salir como sin cola en su IP nueva')
  assert.equal(r.faltan[0].ip, '10.10.7.50')
  assert.equal(r.desconocidas.length, 1, 'y la cola vieja tiene que salir como no reconocida')
  assert.equal(r.desconocidas[0].target, '10.10.7.9/32')
})

test('detecta una cola con la velocidad de otro plan', () => {
  // Pasa al cambiarle el plan a alguien sin volver a sincronizar.
  const r = compararColas({
    clientes: [cliente()],
    colas: [cola({ 'max-limit': '300M/300M' })],
    esperadoPorPlan: esperado,
  })
  assert.equal(r.corregir.length, 1)
  assert.equal(r.corregir[0].diferencias[0].campo, 'max-limit')
})

test('detecta el garantizado en cero', () => {
  const r = compararColas({
    clientes: [cliente()],
    colas: [cola({ 'limit-at': '0/0' })],
    esperadoPorPlan: esperado,
  })
  assert.equal(r.corregir.length, 1)
  assert.equal(r.corregir[0].diferencias[0].campo, 'limit-at')
})

test('dos colas para el mismo abonado se informan', () => {
  // Manda la primera; la otra puede estar limitando de más y nadie la mira.
  const r = compararColas({
    clientes: [cliente()],
    colas: [cola(), cola({ '.id': '*2' })],
    esperadoPorPlan: esperado,
  })
  assert.equal(r.duplicadas.length, 1)
  assert.equal(r.duplicadas[0].cuantas, 2)
})

test('una cola con varios objetivos cuenta para todos', () => {
  // RouterOS admite "ip1,ip2" en un mismo target.
  const r = compararColas({
    clientes: [cliente({ id: 'a', ip: '10.10.7.9' }), cliente({ id: 'b', ip: '10.10.7.10' })],
    colas: [cola({ target: '10.10.7.9/32,10.10.7.10/32' })],
    esperadoPorPlan: esperado,
  })
  assert.equal(r.faltan.length, 0)
  assert.equal(r.desconocidas.length, 0)
})

test('un abonado sin IP no se reclama', () => {
  // No es una falla del router: falta cargarle la dirección en su ficha.
  const r = compararColas({ clientes: [cliente({ ip: null })], colas: [], esperadoPorPlan: esperado })
  assert.equal(r.faltan.length, 0)
})

test('sin plan no se compara la velocidad, pero sí que exista la cola', () => {
  const r = compararColas({
    clientes: [cliente({ plan_id: null })],
    colas: [cola({ 'max-limit': '999M/999M' })],
    esperadoPorPlan: esperado,
  })
  assert.equal(r.corregir.length, 0)
  assert.equal(r.faltan.length, 0)
})

// ── compararLeases ───────────────────────────────────────────────────────────

const lease = (extra = {}) => ({ '.id': '*9', 'mac-address': 'AA:BB:CC:DD:EE:FF', address: '10.10.7.9', ...extra })

test('la lease que coincide no genera ruido', () => {
  const r = compararLeases({
    clientes: [cliente({ mac_address: 'aa:bb:cc:dd:ee:ff' })],
    leases: [lease()],
  })
  assert.deepEqual([r.faltan.length, r.corregir.length], [0, 0])
})

test('la otra mitad del cambio de IP: la lease entrega la vieja', () => {
  // Sin corregirla, el equipo del abonado sigue pidiendo y recibiendo la
  // dirección vieja, así que la cola nueva nunca lo alcanza.
  const r = compararLeases({
    clientes: [cliente({ ip: '10.10.7.50', mac_address: 'AA:BB:CC:DD:EE:FF' })],
    leases: [lease({ address: '10.10.7.9' })],
  })
  assert.equal(r.corregir.length, 1)
  assert.equal(r.corregir[0].router, '10.10.7.9')
  assert.equal(r.corregir[0].ip, '10.10.7.50')
})

test('la MAC se compara sin importar mayúsculas', () => {
  const r = compararLeases({
    clientes: [cliente({ mac_address: 'aa:bb:cc:dd:ee:ff' })],
    leases: [lease({ 'mac-address': 'AA:BB:CC:DD:EE:FF' })],
  })
  assert.equal(r.corregir.length, 0)
})

test('sin MAC cargada no se reclama una lease', () => {
  // No hay a qué atarla; no es algo que reparar pueda resolver.
  const r = compararLeases({ clientes: [cliente({ mac_address: null })], leases: [] })
  assert.deepEqual([r.faltan.length, r.corregir.length], [0, 0])
})
