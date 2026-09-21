import test from 'node:test'
import assert from 'node:assert/strict'
import { armarFila } from '../src/services/configMensajeria.js'

/**
 * Qué se escribe cuando se guarda la configuración de mensajería.
 *
 * La regla peligrosa es la de los secretos vacíos. La pantalla NUNCA muestra un
 * token guardado, así que el formulario llega siempre con esos campos en
 * blanco. Si se tomaran al pie de la letra, entrar a corregir el número de
 * teléfono borraría el token del bot — y nadie lo notaría hasta que dejaran de
 * salir los avisos de corte.
 */

const cifrarDePrueba = (v) => `cifrado(${v})`

test('un token vacío NO borra el que ya está guardado', () => {
  const fila = armarFila({ telegram_token: '', whatsapp_token: undefined }, cifrarDePrueba)

  assert.ok(!('telegram_token_encrypted' in fila), 'no debe tocar el token de Telegram')
  assert.ok(!('whatsapp_token_encrypted' in fila), 'no debe tocar el de WhatsApp')
})

test('un token nuevo se guarda cifrado, nunca en claro', () => {
  const fila = armarFila({ telegram_token: '123456:ABC-DEF' }, cifrarDePrueba)

  assert.equal(fila.telegram_token_encrypted, 'cifrado(123456:ABC-DEF)')
  assert.ok(!JSON.stringify(fila).includes('ABC-DEF]'), 'el valor no puede quedar en claro')
})

test('los espacios pegados al copiar el token se recortan', () => {
  const fila = armarFila({ twilio_token: '  secreto  ' }, cifrarDePrueba)
  assert.equal(fila.twilio_token_encrypted, 'cifrado(secreto)')
})

/**
 * Para borrar de verdad hace falta decirlo. Es explícito y no puede pasar sin
 * querer, que es justo lo contrario de un campo vacío.
 */
test('BORRAR sí vacía el token', () => {
  const fila = armarFila({ telegram_token: 'BORRAR' }, cifrarDePrueba)
  assert.equal(fila.telegram_token_encrypted, null)
})

test('un campo de texto vacío sí se guarda como vacío', () => {
  // Acá el vacío es una intención legítima: borrar el destino de los avisos de
  // red es algo que alguien puede querer, y no hay ningún valor oculto que
  // proteger porque la pantalla siempre lo muestra.
  const fila = armarFila({ nms_destino: '' }, cifrarDePrueba)
  assert.equal(fila.nms_destino, null)
})

test('no se escribe nada que la pantalla no haya mandado', () => {
  const fila = armarFila({ nms_canal: 'email' }, cifrarDePrueba)
  assert.deepEqual(Object.keys(fila), ['nms_canal'])
})

test('los campos desconocidos se ignoran', () => {
  // Que la pantalla mande de más no puede convertirse en columnas inventadas:
  // el update fallaría entero y no se guardaría tampoco lo que sí era válido.
  const fila = armarFila({ nms_canal: 'sms', password: 'x', id: 99 }, cifrarDePrueba)
  assert.deepEqual(Object.keys(fila), ['nms_canal'])
})

// --- Evolution API ----------------------------------------------------------

test('la URL y la instancia de Evolution se guardan en claro', () => {
  // No son secretas y hacen falta a la vista para diagnosticar: "no llega nada"
  // se resuelve mirando si la URL apunta a donde uno cree.
  const fila = armarFila({
    whatsapp_via: 'evolution',
    whatsapp_evolution_url: 'http://localhost:8080',
    whatsapp_evolution_instancia: 'hlfibra',
  })

  assert.equal(fila.whatsapp_via, 'evolution')
  assert.equal(fila.whatsapp_evolution_url, 'http://localhost:8080')
  assert.equal(fila.whatsapp_evolution_instancia, 'hlfibra')
})

test('la API key de Evolution se cifra, como los demás secretos', () => {
  const fila = armarFila({ whatsapp_evolution_key: 'clave-secreta' }, (v) => `cifrado(${v})`)

  assert.equal(fila.whatsapp_evolution_key_encrypted, 'cifrado(clave-secreta)')
  // Y nunca queda el valor en claro en ninguna columna.
  assert.ok(!JSON.stringify(fila).includes('"clave-secreta"'))
})

test('guardar la pantalla sin tocar la clave no la borra', () => {
  // La pantalla nunca muestra el secreto, así que el formulario siempre llega
  // con ese campo vacío. Tomarlo al pie de la letra borraría la clave cada vez
  // que alguien entra a corregir la URL.
  const fila = armarFila({ whatsapp_evolution_url: 'http://otro:8080', whatsapp_evolution_key: '' })

  assert.equal(fila.whatsapp_evolution_url, 'http://otro:8080')
  assert.ok(!('whatsapp_evolution_key_encrypted' in fila))
})

test('BORRAR sí la borra, que es lo que la hace explícita', () => {
  const fila = armarFila({ whatsapp_evolution_key: 'BORRAR' })
  assert.equal(fila.whatsapp_evolution_key_encrypted, null)
})
