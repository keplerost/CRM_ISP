import test from 'node:test'
import assert from 'node:assert/strict'

import { detectarFallo } from '../src/parsers/vsolOnuParser.js'

/**
 * El enable rechazado de la V-SOL.
 *
 * Encontrado contra el equipo de producción, y explica una cadena entera de
 * síntomas que apuntaban al lado equivocado:
 *
 *   1. La OLT no tenía cargada la contraseña de enable, así que el código
 *      probaba con la de login.
 *   2. El equipo la rechazaba con "Bad UserName or Bad Password , Login
 *      Failed." — un mensaje que no contiene ninguna de las palabras que se
 *      buscaban (incorrect, denied, invalid), así que pasaba de largo.
 *   3. Tras el rechazo, este firmware devuelve la sesión al prompt de LOGIN. A
 *      partir de ahí cada comando se interpretaba como un intento de usuario y
 *      contraseña, hasta que el equipo cerraba la sesión.
 *   4. Lo que se veía era "la OLT cortó la sesión SSH durante la operación",
 *      que hace pensar en límites de sesiones simultáneas y no en la
 *      contraseña.
 */

/** La salida real del equipo, tal cual llegó. */
const RECHAZO_REAL = `
Bad UserName or Bad Password , Login Failed.

Please retry

Login: `

// Las mismas expresiones que usa el driver. Se prueban acá porque son la
// diferencia entre detectar el problema y perseguir un síntoma.
const RECHAZO_ENABLE =
  /bad\s+user\s*name|bad\s+password|login\s+failed|authentication\s+failed|incorrect|denied|invalid\s+password/i
const VOLVIO_AL_LOGIN = /(^|\n)\s*(login|username)\s*:\s*$/im

test('se reconoce el rechazo real del equipo', () => {
  assert.ok(RECHAZO_ENABLE.test(RECHAZO_REAL))
})

test('y también que la sesión volvió al prompt de login', () => {
  assert.ok(VOLVIO_AL_LOGIN.test(RECHAZO_REAL))
})

test('detectarFallo NO alcanzaba para esto', () => {
  // Es la razón por la que el fallo pasó de largo: solo busca los errores de
  // comando —%, Invalid input, Unknown command, Error:— y un rechazo de
  // autenticación no se parece a ninguno.
  assert.equal(
    detectarFallo(RECHAZO_REAL),
    null,
    'si algún día lo detecta, el driver puede simplificarse',
  )
})

test('los errores de comando se siguen detectando', () => {
  assert.match(detectarFallo('% Invalid input detected'), /Invalid input/)
  assert.match(detectarFallo('Unknown command'), /Unknown command/)
})

test('una salida normal no se confunde con un rechazo', () => {
  const buena = `
V1600G-1 Software, Version 1.2.3
Copyright (c) V-SOL
OLT(config)# `
  assert.ok(!RECHAZO_ENABLE.test(buena))
  assert.ok(!VOLVIO_AL_LOGIN.test(buena))
})

// --- El rechazo silencioso del enable ---------------------------------------

const PIDE_PASSWORD = /password\s*:\s*$/i

test('volver a pedir la contraseña ES el rechazo', () => {
  // Este equipo no dice "incorrecta": reimprime `Password:` y espera otro
  // intento. Sin detectarlo, los comandos siguientes se consumen como más
  // intentos hasta que corta la sesión — y el síntoma apunta a otro lado.
  assert.ok(PIDE_PASSWORD.test('\nPassword: '))
})

test('una salida real de show version no parece un prompt', () => {
  assert.ok(!PIDE_PASSWORD.test('V1600G-1 Software, Version 1.2.3\nOLT# '))
})

test('la versión nunca puede ser un prompt', () => {
  // Con el equipo esperando contraseña, `show version` se consume como otro
  // intento y su "salida" es el prompt. La prueba de conexión reportaba
  // version: "Password:" y daba verde.
  const esPrompt = (v) => /^(password|login|username):?$/i.test(v)
  assert.ok(esPrompt('Password:'))
  assert.ok(esPrompt('Login:'))
  assert.ok(!esPrompt('1.2.3'))
  assert.ok(!esPrompt('V1600G-1'))
})

test('un prompt de login en medio del texto no cuenta', () => {
  // Solo importa si la sesión QUEDÓ esperando el login, o sea al final.
  const texto = 'Login: admin\nOLT> enable\nPassword:\nOLT# '
  assert.ok(!VOLVIO_AL_LOGIN.test(texto))
})
