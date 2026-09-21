import test from 'node:test'
import assert from 'node:assert/strict'

import { parseCausaCaida } from '../src/parsers/huaweiOntParser.js'

/**
 * La causa de la última caída es lo único que distingue un corte de luz en la
 * casa del abonado de una fibra cortada: las dos llegan a la OLT como pérdida
 * de señal.
 *
 * Si esto se lee mal, el técnico sale a buscar un empalme roto que no existe —o
 * peor, nadie va a ver una fibra que sí está cortada porque el sistema dijo que
 * era un corte de luz.
 */

/** Salida representativa de `display ont info <puerto> <ont>` en un MA5800. */
const infoOnt = (causa, fecha = '2026-07-31 03:12:44') => `
  display ont info 0 5
  ---------------------------------------------------------------
  F/S/P                   : 0/1/0
  ONT-ID                  : 5
  Control flag            : active
  Run state               : offline
  Config state            : normal
  Match state             : initial
  DBA type                : SR
  ONT distance(m)         : 1832
  ONT battery state       : not support
  Authentic type          : SN-auth
  Management mode         : OMCI
  Last down cause         : ${causa}
  Last up time            : 2026-07-30 18:02:11
  Last down time          : ${fecha}
  ONT online duration     : 9 hour(s) 10 minute(s)
  ---------------------------------------------------------------
`

test('el dying gasp se lee como corte de energía', () => {
  // Es el último aviso que manda la ONT cuando se le va la luz.
  const r = parseCausaCaida(infoOnt('dying-gasp'))

  assert.equal(r.causa, 'power_off')
  assert.equal(r.causaCruda, 'dying-gasp')
  assert.equal(r.ultimaCaida, '2026-07-31 03:12:44')
})

test('los nombres cambian entre versiones de VRP y todos valen', () => {
  // Las mismas OLTs escriben esto de tres formas distintas según la versión.
  for (const texto of ['dying gasp', 'DyingGasp', 'power off', 'Power-Off']) {
    assert.equal(parseCausaCaida(infoOnt(texto)).causa, 'power_off', texto)
  }
})

test('la pérdida de señal se lee como problema de fibra', () => {
  for (const texto of ['LOS', 'LOSi', 'loss of signal']) {
    assert.equal(parseCausaCaida(infoOnt(texto)).causa, 'los', texto)
  }
})

test('distingue una baja hecha a propósito de una caída', () => {
  assert.equal(parseCausaCaida(infoOnt('deactive succ')).causa, 'desactivada')
  assert.equal(parseCausaCaida(infoOnt('ONT reboot')).causa, 'reinicio')
})

test('una causa que no se reconoce se reporta como otra, sin perder el texto', () => {
  // Preferible "otra" con el texto crudo que inventar una categoría: alguien
  // puede leerlo y decidir.
  const r = parseCausaCaida(infoOnt('omci mismatch'))

  assert.equal(r.causa, 'otra')
  assert.equal(r.causaCruda, 'omci mismatch')
})

test('una ONT que nunca se cayó no reporta causa', () => {
  const r = parseCausaCaida(infoOnt('-', '-'))

  assert.equal(r.causa, null)
  assert.equal(r.causaCruda, null)
  assert.equal(r.ultimaCaida, null)
})

test('una salida sin el campo no rompe', () => {
  const r = parseCausaCaida('display ont info 0 5\n  Run state : online\n')

  assert.equal(r.causa, null)
  assert.equal(r.ultimaCaida, null)
})

test('sobrevive a la salida cruda de la sesión SSH', () => {
  // La OLT pagina con "---- More ----" y mete retornos de carro: el parser
  // normaliza antes de buscar.
  const conRuido =
    'MA5800(config-if-gpon-0/1)#display ont info 0 5\r\n' +
    '  { <cr>||<K> }:\r\n' +
    '  Last down cause         : dying-gasp\r\n' +
    '  ---- More ( Press \'Q\' to break ) ----\r\n' +
    '  Last down time          : 2026-07-31 03:12:44\r\n'

  const r = parseCausaCaida(conRuido)
  assert.equal(r.causa, 'power_off')
  assert.equal(r.ultimaCaida, '2026-07-31 03:12:44')
})
