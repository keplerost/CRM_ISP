import test from 'node:test'
import assert from 'node:assert/strict'

import { redDeGestion } from '../src/services/configurarRouter.js'

/**
 * De qué red le habla el sistema a un router.
 *
 * ── Qué se protege ──
 *
 * Este valor termina escrito en `/ip service address=` del MikroTik, que es la
 * lista de orígenes a los que la API le contesta. Equivocarlo tiene dos formas
 * de salir mal, y las dos son caras:
 *
 *   De más. Poner una red que no corresponde no rompe nada visible hoy, pero
 *   deja permitido un origen que no es el nuestro.
 *
 *   De menos. Deducir una red equivocada y escribirla hace que el sistema se
 *   quede afuera de un equipo al que llegaba — y el síntoma es el peor de
 *   todos: el puerto sigue abierto, la conexión TCP se acepta, y la sesión se
 *   cierra sin una sola línea de error. Es exactamente lo que costó media tarde
 *   en la puesta en marcha del primer router del piloto.
 *
 * Por eso ante la duda no devuelve nada: el paso se marca "no aplica" y no se
 * toca el equipo. Adivinar mal acá es peor que no hacer nada.
 */

test('deduce la red de gestión de la IP del túnel', () => {
  assert.equal(redDeGestion({ ip_host: '10.66.0.11' }), '10.66.0.0/24')
})

test('respeta el tercer octeto, no asume que sea cero', () => {
  // `openvpn-server.sh` reparte un /24, pero la red elegida puede ser
  // 10.66.7.0/24. Truncar al segundo octeto permitiría un /16 entero.
  assert.equal(redDeGestion({ ip_host: '10.66.7.250' }), '10.66.7.0/24')
})

test('reconoce los tres rangos privados', () => {
  assert.equal(redDeGestion({ ip_host: '192.168.88.1' }), '192.168.88.0/24')
  assert.equal(redDeGestion({ ip_host: '172.16.5.9' }), '172.16.5.0/24')
  assert.equal(redDeGestion({ ip_host: '172.31.5.9' }), '172.31.5.0/24')
})

test('172.15 y 172.32 no son privadas y no se deducen', () => {
  // Los bordes del bloque 172.16/12. Una expresión que mire solo "172." daría
  // por privada una dirección de internet.
  assert.equal(redDeGestion({ ip_host: '172.15.0.1' }), null)
  assert.equal(redDeGestion({ ip_host: '172.32.0.1' }), null)
})

test('con IP pública no deduce nada', () => {
  // Un router con IP pública no está detrás de un túnel. Restringir su API a
  // "la /24 de su propia IP pública" sería a la vez inútil y peligroso.
  assert.equal(redDeGestion({ ip_host: '181.119.227.177' }), null)
})

test('sin IP, o con una que no lo es, devuelve null en vez de inventar', () => {
  assert.equal(redDeGestion({}), null)
  assert.equal(redDeGestion({ ip_host: '' }), null)
  assert.equal(redDeGestion({ ip_host: 'router.casa.lan' }), null)
  assert.equal(redDeGestion({ ip_host: '10.66.0' }), null)
})

test('una red indicada a mano gana sobre la deducción', () => {
  // El /24 es lo que arma el script, pero nadie obliga a usarlo: si el operador
  // dice otra cosa, manda él.
  assert.equal(redDeGestion({ ip_host: '10.66.0.11' }, '10.66.0.0/16'), '10.66.0.0/16')
})

test('una red indicada a mano se valida antes de aceptarla', () => {
  // Va directo a la configuración del equipo: si se cuela basura, RouterOS
  // puede aceptarla y dejar la lista en un estado que nadie quiso.
  for (const mala of ['10.66.0.0', 'diez punto algo', '10.66.0.0/', '/24', '10.66.0.0-24']) {
    assert.throws(() => redDeGestion({ ip_host: '10.66.0.11' }, mala), /no es una red válida/)
  }
})

test('la red indicada se respeta aunque el router tenga IP pública', () => {
  // El caso del piloto al revés: un equipo con IP pública al que igual se le
  // quiere permitir la red del túnel porque también se lo alcanza por ahí.
  assert.equal(redDeGestion({ ip_host: '181.119.227.177' }, '10.66.0.0/24'), '10.66.0.0/24')
})
