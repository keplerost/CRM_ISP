import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseNtp } from '../src/parsers/huaweiSaludParser.js'

/**
 * Lector del reloj de una OLT Huawei.
 *
 * La salida de abajo es literal: la devolvió el MA5800-X7 de LA MANÁ el
 * 2026-08-03. Está copiada tal cual, con el eco del comando y el hint de
 * autocompletado incluidos, porque es lo que el parser va a recibir de verdad.
 */

const REAL_SINCRONIZADA = `display ntp-service status
{ <cr>||<K> }:


  Command:
          display ntp-service status
 clock status: synchronized
 clock stratum: 2
 reference clock ID: 216.239.35.4
 nominal frequency: 100.0000 Hz
 actual frequency: 100.0000 Hz
 clock precision: 2^16
 clock offset: -0.8441 ms
 root delay: 83.75 ms
 root dispersion: 10.54 ms
 peer dispersion: 0.09 ms
 reference time: 03:59:18.984 UTC Aug 3 2026(EE1A9096.FBF8B9BA)
 synchronization state: clock synchronized

MA5800-X7(config)#`

describe('reloj de una OLT Huawei', () => {
  test('lee la salida real del X7 de LA MANÁ', () => {
    const r = parseNtp(REAL_SINCRONIZADA)

    assert.equal(r.sincronizado, true)
    assert.equal(r.estrato, 2)
    assert.equal(r.referencia, '216.239.35.4')
    assert.equal(r.desfase_ms, -0.8441)
    assert.equal(r.sin_referencia, false)
  })

  test('un equipo sin sincronizar se detecta', () => {
    const r = parseNtp(`
  clock status: unsynchronized
  clock stratum: 16
  reference clock ID: none
`)
    assert.equal(r.sincronizado, false)
    assert.equal(r.estado, 'unsynchronized')
    // Estrato 16 es "no tengo referencia".
    assert.equal(r.sin_referencia, true)
  })

  test('estrato 16 es sospechoso aunque diga que está sincronizado', () => {
    // Se ha visto equipos que reportan "synchronized" contra su propio reloj
    // interno. Confiar en el estado solo dejaría pasar justamente ese caso.
    const r = parseNtp('clock status: synchronized\nclock stratum: 16')
    assert.equal(r.sincronizado, true)
    assert.equal(r.sin_referencia, true)
  })

  test('un desfase positivo se lee con su signo', () => {
    const r = parseNtp('clock status: synchronized\nclock stratum: 3\nclock offset: 12.5 ms')
    assert.equal(r.desfase_ms, 12.5)
  })

  test('si el comando no se pudo leer devuelve null, no un reloj en cero', () => {
    // Un desfase de 0 ms es una lectura buenísima; "no sé" es otra cosa.
    // Confundirlas haría que un equipo sin respuesta pase por perfecto.
    assert.equal(parseNtp('% Unknown command'), null)
    assert.equal(parseNtp(''), null)
    assert.equal(parseNtp(null), null)
  })

  test('los códigos de terminal no rompen la lectura', () => {
    const r = parseNtp('\x1b[2K clock status: synchronized\r\n\x1b[1;1H clock stratum: 4')
    assert.equal(r.sincronizado, true)
    assert.equal(r.estrato, 4)
  })
})
