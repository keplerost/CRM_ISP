import test from 'node:test'
import assert from 'node:assert/strict'

import { claseDeNodo, mensajeDe, plantillaDe, variablesDeNodo } from '../src/services/nms.js'

/**
 * Los avisos de red, con el texto que se edita desde la pantalla.
 *
 * Estos mensajes los lee el equipo técnico a cualquier hora y en el celular. Lo
 * que se prueba acá es que el aviso salga SIEMPRE —con plantilla o sin ella— y
 * que diga de qué equipo se trata.
 */

const ANTENA = { nombre: 'AP GUAMANÍ', tipo: 'ptmp', ip: '10.0.0.5', punto: 'Torre Sur', activos: 23 }
const TORRE = { nombre: 'RB TORRE SUR', tipo: 'rb_torre', ip: '10.0.0.1', punto: 'Torre Sur', activos: 0 }
const CUANDO = '2026-08-16T14:30:00Z'

test('una antena es un emisor y una torre es infraestructura', () => {
  /**
   * De un emisor cuelgan abonados: quien lee el aviso quiere saber a cuántas
   * casas dejó sin servicio. De la torre cuelga la red, y ahí importa qué se
   * cayó y desde cuándo.
   */
  assert.equal(claseDeNodo(ANTENA), 'emisor')
  assert.equal(claseDeNodo({ tipo: 'ptp' }), 'emisor')
  assert.equal(claseDeNodo(TORRE), 'router')
  assert.equal(claseDeNodo({ tipo: 'olt' }), 'router')
  assert.equal(claseDeNodo({ tipo: 'switch' }), 'router')
})

test('cada situación busca su propia plantilla', () => {
  assert.equal(plantillaDe(ANTENA, 'down'), 'sms_emisor_caido')
  assert.equal(plantillaDe(ANTENA, 'up'), 'sms_emisor_conectado')
  assert.equal(plantillaDe(TORRE, 'down'), 'sms_router_caido')
  assert.equal(plantillaDe(TORRE, 'up'), 'sms_router_conectado')
})

test('el correo usa la plantilla larga', () => {
  // Un aviso de red por correo se lee en una pantalla grande y puede explicar
  // más; el del teléfono se lee de un vistazo entre otros mensajes.
  assert.equal(plantillaDe(ANTENA, 'down', 'email'), 'mail_emisor_caido')
  assert.equal(plantillaDe(TORRE, 'up', 'email'), 'mail_router_conectado')
})

test('los abonados afectados van en las variables', () => {
  /**
   * Es el dato que convierte "se cayó una antena" en "hay veintitrés casas sin
   * internet", que es lo que hace que alguien salga a la ruta a las once de la
   * noche en vez de dejarlo para mañana.
   */
  const v = variablesDeNodo(ANTENA, CUANDO, 42)
  assert.equal(v.afectados, '23')
  assert.equal(v.equipo, 'AP GUAMANÍ')
  assert.equal(v.zona, 'Torre Sur')
  assert.equal(v.duracion, '42 minutos')
})

test('la plantilla se aplica con los datos del nodo', () => {
  const texto = mensajeDe(ANTENA, 'down', CUANDO, null, {
    cuerpo: 'EMISOR CAÍDO: {{equipo}} en {{zona}}. Afectados: {{afectados}}',
  })
  assert.equal(texto, 'EMISOR CAÍDO: AP GUAMANÍ en Torre Sur. Afectados: 23')
})

test('sin plantilla el aviso sale igual', () => {
  /**
   * ── Por qué esto importa más que en cualquier otro aviso ──
   *
   * Un monitoreo que deja de avisar porque alguien desactivó una plantilla —o
   * porque la base no contestó— no es un monitoreo. La red se cae igual y nadie
   * se entera. El texto de fábrica tiene que seguir saliendo.
   */
  const texto = mensajeDe(ANTENA, 'down', CUANDO, null, null)
  assert.match(texto, /CAÍDO/)
  assert.match(texto, /AP GUAMANÍ/)
})

test('una plantilla vacía tampoco deja al aviso mudo', () => {
  // Alguien puede borrar el texto sin querer y guardar. El aviso sigue saliendo.
  const texto = mensajeDe(ANTENA, 'up', CUANDO, 10, { cuerpo: '' })
  assert.match(texto, /RECUPERADO/)
})

test('la recuperación dice cuánto estuvo caído', () => {
  // Es lo que permite saber si fue un parpadeo o una noche entera sin servicio.
  const texto = mensajeDe(TORRE, 'up', CUANDO, 125)
  assert.match(texto, /125 min/)
})
