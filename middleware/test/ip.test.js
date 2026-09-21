import test from 'node:test'
import assert from 'node:assert/strict'

import { aEntero, aIp, rangoDeCidr, rangosDeTexto, primeraLibre, totalDeRangos } from '../src/lib/ip.js'

/**
 * La asignación automática de IP del alta en campo.
 *
 * Es la única parte del asistente que no se puede verificar mirando el equipo:
 * si la cuenta se equivoca, el abonado sale con una dirección que ya tiene otro
 * y los dos quedan con internet intermitente. El síntoma aparece dos días
 * después y no se parece en nada a la causa.
 */

test('convierte de ida y de vuelta', () => {
  assert.equal(aEntero('10.0.0.1'), 167772161)
  assert.equal(aIp(167772161), '10.0.0.1')
  assert.equal(aIp(aEntero('192.168.88.254')), '192.168.88.254')
  // El último /24 posible: acá es donde una cuenta con enteros con signo falla.
  assert.equal(aIp(aEntero('255.255.255.255')), '255.255.255.255')
})

test('rechaza lo que no es una IPv4', () => {
  assert.equal(aEntero('10.0.0'), null)
  assert.equal(aEntero('10.0.0.256'), null)
  assert.equal(aEntero('diez.cero.cero.uno'), null)
  assert.equal(aEntero(''), null)
  assert.equal(aEntero(null), null)
})

test('un /24 excluye la dirección de red y la de broadcast', () => {
  const { desde, hasta } = rangoDeCidr('10.20.30.0/24')
  assert.equal(aIp(desde), '10.20.30.1')
  assert.equal(aIp(hasta), '10.20.30.254')
})

test('el CIDR se normaliza aunque no venga la dirección de red', () => {
  // Alguien escribe la IP del gateway con la máscara. Tiene que dar el mismo
  // segmento y no un rango corrido.
  const { desde, hasta } = rangoDeCidr('10.20.30.77/24')
  assert.equal(aIp(desde), '10.20.30.1')
  assert.equal(aIp(hasta), '10.20.30.254')
})

test('un /30 deja las dos direcciones utilizables', () => {
  const { desde, hasta } = rangoDeCidr('172.16.0.0/30')
  assert.equal(aIp(desde), '172.16.0.1')
  assert.equal(aIp(hasta), '172.16.0.2')
})

test('un /32 es una sola dirección, sin descartar nada', () => {
  const { desde, hasta } = rangoDeCidr('190.90.1.5/32')
  assert.equal(aIp(desde), '190.90.1.5')
  assert.equal(aIp(hasta), '190.90.1.5')
})

test('lee los rangos de un pool de RouterOS', () => {
  const rangos = rangosDeTexto('10.0.0.10-10.0.0.20,10.0.0.40-10.0.0.45')
  assert.equal(rangos.length, 2)
  assert.equal(totalDeRangos(rangos), 11 + 6)
})

test('acepta una dirección suelta y un CIDR en el mismo texto', () => {
  const rangos = rangosDeTexto('10.0.0.7, 10.0.1.0/29')
  assert.equal(totalDeRangos(rangos), 1 + 6)
})

test('un rango al revés no se acepta en silencio', () => {
  assert.throws(() => rangosDeTexto('10.0.0.50-10.0.0.10'), /no es un rango/)
})

test('devuelve la primera libre salteando las ocupadas', () => {
  const rangos = rangosDeTexto('10.0.0.10-10.0.0.14')
  const libre = primeraLibre(rangos, ['10.0.0.10', '10.0.0.11', '10.0.0.13'])
  assert.equal(libre.ip, '10.0.0.12')
})

test('una IP ocupada con máscara cuenta igual que sin ella', () => {
  // Las direcciones del router vienen como "10.0.0.1/24" desde /ip/address. Si
  // no se normalizan, el gateway del nodo queda disponible para un abonado.
  const rangos = rangosDeTexto('10.0.0.1-10.0.0.3')
  const libre = primeraLibre(rangos, ['10.0.0.1/24', '10.0.0.2'])
  assert.equal(libre.ip, '10.0.0.3')
})

test('la basura entre las ocupadas no corre la asignación', () => {
  const rangos = rangosDeTexto('10.0.0.10-10.0.0.12')
  const libre = primeraLibre(rangos, [null, '', 'sin IP', undefined, '10.0.0.10'])
  assert.equal(libre.ip, '10.0.0.11')
})

test('sigue en el segundo rango cuando el primero está lleno', () => {
  const rangos = rangosDeTexto('10.0.0.10-10.0.0.11,10.0.0.90-10.0.0.91')
  const libre = primeraLibre(rangos, ['10.0.0.10', '10.0.0.11'])
  assert.equal(libre.ip, '10.0.0.90')
})

test('un pool agotado devuelve null y no una IP repetida', () => {
  const rangos = rangosDeTexto('10.0.0.10-10.0.0.11')
  assert.equal(primeraLibre(rangos, ['10.0.0.10', '10.0.0.11']), null)
})
