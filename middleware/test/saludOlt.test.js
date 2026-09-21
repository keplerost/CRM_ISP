import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseVersion,
  parseUptime,
  parseHora,
  parseTemperaturas,
  parsePotencia,
  parsePlacas,
  parseFrame,
  parsePuertosPon,
} from '../src/parsers/huaweiSaludParser.js'

/**
 * Salud de la OLT, contra salidas REALES.
 *
 * Todas las cadenas de este archivo salieron de un MA5800-X7 con firmware
 * MA5800V100R018C00, capturadas preguntándole al equipo qué comandos entendía.
 * Escribirlas de memoria fue lo que costó horas en los drivers de ONU; acá se
 * fijan tal cual llegaron.
 */

test('lee el modelo y el firmware', () => {
  const r = parseVersion(`
  VERSION : MA5800V100R018C00
  PATCH   : SPH613
  PRODUCT : MA5800-X7`)

  assert.equal(r.modelo, 'MA5800-X7')
  assert.equal(r.firmware, 'MA5800V100R018C00')
  assert.equal(r.parche, 'SPH613')
})

test('una salida que no es de version devuelve null', () => {
  assert.equal(parseVersion('% Unknown command'), null)
})

// --- Tiempo encendido --------------------------------------------------------

test('lee el tiempo encendido real', () => {
  const r = parseUptime('  System up time: 42 day 21 hour 29 minute 41 second ')

  assert.equal(r.dias, 42)
  assert.equal(r.horas, 21)
  assert.equal(r.total_segundos, 42 * 86400 + 21 * 3600 + 29 * 60 + 41)
  assert.equal(r.texto, '42 d 21 h')
})

test('un equipo recién arrancado se lee sin días', () => {
  const r = parseUptime('System up time: 0 day 0 hour 7 minute 3 second')
  assert.equal(r.dias, 0)
  assert.equal(r.texto, '0 h 7 min')
})

test('sin uptime devuelve null, no cero', () => {
  // Cero se leería como "recién reiniciada", que es una alarma. No saberlo es
  // otra cosa.
  assert.equal(parseUptime('% Unknown command'), null)
})

// --- Hora --------------------------------------------------------------------

test('lee la hora con su huso', () => {
  const r = parseHora('  2026-08-02 21:48:12-05:00')
  assert.equal(r.texto, '2026-08-02 21:48:12-05:00')
  assert.ok(typeof r.desfase_segundos === 'number')
})

test('el desfase contra el reloj propio se calcula', () => {
  // Es lo que importa del dato: una OLT con el reloj corrido registra eventos
  // que después no se pueden cruzar con nada.
  const hace2h = new Date(Date.now() - 7200_000).toISOString().slice(0, 19).replace('T', ' ')
  const r = parseHora(`${hace2h}+00:00`)
  assert.ok(r.desfase_segundos > 7000 && r.desfase_segundos < 7400, `dio ${r.desfase_segundos}`)
})

// --- Temperatura -------------------------------------------------------------

test('lee la temperatura de cada placa', () => {
  const r = parseTemperaturas(`
  SlotID:  6      BoardName: H901GPHF       Temperature:   36C(  96F)
  SlotID:  7      BoardName: H901GPHF       Temperature:   37C(  98F)
  SlotID:  8      BoardName: H905MPLB       Temperature:   32C(  89F)
  SlotID:  9      BoardName: H905MPLB       Temperature:   34C(  93F)`)

  assert.equal(r.length, 4)
  assert.deepEqual(r[0], { slot: 6, placa: 'H901GPHF', celsius: 36 })
  assert.equal(Math.max(...r.map((x) => x.celsius)), 37)
})

test('una temperatura bajo cero se lee con su signo', () => {
  const r = parseTemperaturas('SlotID:  1      BoardName: X       Temperature:   -5C(  23F)')
  assert.equal(r[0].celsius, -5)
})

// --- Consumo -----------------------------------------------------------------

test('lee el consumo en watts', () => {
  const r = parsePotencia(`
  ------------------------------
  FrameID  Power(unit:Watt)
  ------------------------------
  0        551
  ------------------------------
  Note:Indicates the maximum power`)

  assert.equal(r.watts, 551)
  assert.equal(r.frame, 0)
})

// --- Placas ------------------------------------------------------------------

test('lee el inventario de placas y saltea los slots vacíos', () => {
  const r = parsePlacas(`
  SlotID  BoardName  Status          SubType0 SubType1    Online/Offline
  0
  1
  6       H901GPHF   Normal
  7       H901GPHF   Normal
  8       H905MPLB   Standby_normal
  9       H905MPLB   Active_normal
  10      H903PILA   Normal                           `)

  assert.equal(r.length, 5, 'los slots vacíos no son una falla')
  assert.deepEqual(r.map((p) => p.slot), [6, 7, 8, 9, 10])
  assert.ok(r.every((p) => p.ok))
})

test('la placa en reserva no es una falla', () => {
  // El par de control de un MA5800 trabaja en activo/reserva: marcar la de
  // reserva en rojo sería alarmar por lo que es correcto.
  const r = parsePlacas('  8       H905MPLB   Standby_normal')
  assert.equal(r[0].ok, true)
  assert.equal(r[0].reserva, true)
})

test('una placa fallada se detecta', () => {
  const r = parsePlacas('  6       H901GPHF   Failed')
  assert.equal(r[0].ok, false)
})

// --- Backplane ---------------------------------------------------------------

test('lee el estado del bastidor', () => {
  const r = parseFrame(`
  Type:           H901BPMB
  State:          Normal
  Desc:           H901BPMB_0
  EMU ID:         0   Subnode:1   State:Communications normal`)

  assert.equal(r.tipo, 'H901BPMB')
  assert.equal(r.ok, true)
  assert.match(r.emu, /Communications normal/)
})

// --- Puertos PON -------------------------------------------------------------

const PLACA_REAL = `
  ---------------------------------------
  Board Name          : H901GPHF
  Board Status        : Normal
  ---------------------------------------
  Power Status      Power-off cause                    Power-off Time
  POWER-ON          -                                  -
  -------------------------------------------------------------
    Port   Port   min-distance   max-distance   Optical-module
           type       (km)           (km)           status
  -------------------------------------------------------------
    0     GPON        0              20             Online
    1     GPON        0              20             Online
    2     GPON        0              20             Offline
                                     8     GPON        0              20             Online
   15     GPON        0              20             Online`

test('lee los puertos PON de una placa', () => {
  const r = parsePuertosPon(PLACA_REAL)

  assert.equal(r.placa, 'H901GPHF')
  assert.equal(r.estado, 'Normal')
  assert.equal(r.alimentacion, 'POWER-ON')
  assert.equal(r.puertos.length, 5)
})

test('un módulo óptico caído se detecta', () => {
  // Es lo que avisa de un SFP muerto: los abonados de ese puerto caen todos
  // juntos y desde la ficha de cada uno parece un problema distinto.
  const r = parsePuertosPon(PLACA_REAL)
  const caidos = r.puertos.filter((p) => !p.ok)

  assert.equal(caidos.length, 1)
  assert.equal(caidos[0].puerto, 2)
})

test('una línea corrida por la CLI se lee igual', () => {
  // La consola alinea con códigos de cursor y a veces deja una fila indentada
  // de más. Parsear por posición de columna la perdería.
  const r = parsePuertosPon(PLACA_REAL)
  assert.ok(r.puertos.some((p) => p.puerto === 8), 'el puerto 8 venía corrido')
})

test('sin puertos no se inventa una lista', () => {
  const r = parsePuertosPon('% Unknown command')
  assert.deepEqual(r.puertos, [])
})
