import test from 'node:test'
import assert from 'node:assert/strict'

import { canalesPara, canalesUtiles, plantillaDe } from '../src/services/avisosPago.js'

/**
 * Los tres avisos de pago.
 *
 * QUIÉN recibe cuál lo decide la vista `v_avisos_pago_pendientes` en la base, y
 * eso se prueba en el arnés de migraciones con fechas de verdad. Acá se prueba
 * lo que decide este archivo: por dónde se le escribe a cada abonado.
 *
 * No es un detalle. Un aviso que sale por el canal equivocado es un aviso que no
 * llegó, y la deuda sigue creciendo mientras el sistema informa "42 enviados".
 */

const COMPLETO = {
  nombre: 'OÑA RIERA JOSÉ',
  canal_preferido: 'whatsapp',
  email: 'jose@correo.com',
  telefono_movil: '0998877665',
  telefono: '032345678',
  telegram_chat_id: '1259488007',
}

test('el canal que eligió el abonado va primero', () => {
  // Al que pidió WhatsApp mandarle un correo es no haberle preguntado.
  assert.equal(canalesPara(COMPLETO)[0], 'whatsapp')
  assert.equal(canalesPara({ ...COMPLETO, canal_preferido: 'email' })[0], 'email')
  assert.equal(canalesPara({ ...COMPLETO, canal_preferido: 'telegram' })[0], 'telegram')
})

test('los demás quedan como respaldo, sin repetirse', () => {
  /**
   * Un aviso que sale por el canal equivocado sigue siendo mejor que uno que no
   * sale: la deuda no se entera de nuestras preferencias.
   */
  const canales = canalesPara(COMPLETO)
  assert.equal(canales[0], 'whatsapp')
  assert.ok(canales.length > 1, 'tiene que haber respaldo')
  assert.equal(new Set(canales).size, canales.length, 'el preferido no puede aparecer dos veces')
})

test('un canal sin dirección no se ofrece', () => {
  // Mandarle un correo al que no tiene correo es no mandarle nada, y encima
  // contarlo como enviado.
  const sinCorreo = { ...COMPLETO, email: null }
  assert.ok(!canalesPara(sinCorreo).includes('email'))

  const sinTelegram = { ...COMPLETO, telegram_chat_id: null }
  assert.ok(!canalesPara(sinTelegram).includes('telegram'))
})

test('el abonado sin ninguna forma de contacto no tiene canales', () => {
  /**
   * Devolver una lista vacía es lo correcto: el servicio lo cuenta aparte, en
   * `sin_canal`, en vez de anotarlo como fallido. Son dos problemas distintos —
   * uno se arregla pidiéndole el número al abonado y el otro revisando el
   * servidor de correo.
   */
  const mudo = {
    nombre: 'SIN CONTACTO',
    canal_preferido: 'whatsapp',
    email: null,
    telefono_movil: null,
    telefono: null,
    telegram_chat_id: null,
  }
  assert.deepEqual(canalesPara(mudo), [])
})

test('si el ISP fija un canal, no se usa ningún otro', () => {
  /**
   * Es una decisión deliberada del ISP —"todo por correo"— y respetarla importa
   * más que entregar el mensaje: puede haber un costo por SMS de por medio, o un
   * número de WhatsApp que no quiere usar para cobranza.
   */
  assert.deepEqual(canalesPara(COMPLETO, 'email'), ['email'])
  assert.deepEqual(canalesPara({ ...COMPLETO, email: null }, 'email'), [])
})

test('sin canal preferido cargado igual se le escribe', () => {
  // La columna admite nulo y media base migrada lo va a tener así.
  const canales = canalesPara({ ...COMPLETO, canal_preferido: null })
  assert.ok(canales.length > 0)
})

// --- Lo que pidió el abonado ------------------------------------------------

test('el abonado que eligió canales manda sobre el resto', () => {
  /**
   * Si pidió que le escriban solo por WhatsApp, mandarle un correo es desoírlo
   * — y desoírlo es la razón por la que después pide que lo saquen de todo.
   */
  const soloWhatsapp = { ...COMPLETO, avisos_canales: ['whatsapp'] }
  assert.deepEqual(canalesPara(soloWhatsapp), ['whatsapp'])
})

test('su elección gana incluso sobre el canal que fijó el ISP', () => {
  // El ISP puede preferir el correo por costo, pero el abonado pidió otra cosa
  // y esa es la que evita el reclamo.
  const soloWhatsapp = { ...COMPLETO, avisos_canales: ['whatsapp'] }
  assert.deepEqual(canalesPara(soloWhatsapp, 'email'), [])
})

test('una lista vacía es "por ninguno"', () => {
  // Distinto de no haber elegido: alguien la dejó así a propósito.
  assert.deepEqual(canalesPara({ ...COMPLETO, avisos_canales: [] }), [])
})

test('sin elegir nada se sigue usando lo que se pueda', () => {
  // `null` es como venía funcionando, y es lo que va a tener toda la base
  // migrada.
  assert.ok(canalesPara({ ...COMPLETO, avisos_canales: null }).length > 1)
})

test('elegir un canal del que no se tiene el dato no lo inventa', () => {
  // Marcar Telegram sin chat_id deja al abonado sin aviso: hacen falta las dos
  // cosas, que lo acepte y que se lo pueda alcanzar.
  const sinDato = { ...COMPLETO, telegram_chat_id: null, avisos_canales: ['telegram'] }
  assert.deepEqual(canalesPara(sinDato), [])
})

// --- Cada canal con su plantilla --------------------------------------------

const CON_PLANTILLAS = { ...COMPLETO, plantilla_email_id: 'mail-1', plantilla_corta_id: 'sms-1' }

test('el correo usa la plantilla larga y los demás la corta', () => {
  /**
   * El largo cambia todo. Un correo bien escrito —con saludo, párrafo de
   * cortesía y despedida— es un pésimo SMS: pasa los 160 caracteres, se cobra
   * como dos mensajes y llega partido, con el segundo pedazo sin contexto. Y si
   * lleva HTML, el abonado recibe las etiquetas.
   */
  assert.equal(plantillaDe('email', CON_PLANTILLAS), 'mail-1')
  assert.equal(plantillaDe('sms', CON_PLANTILLAS), 'sms-1')
  assert.equal(plantillaDe('whatsapp', CON_PLANTILLAS), 'sms-1')
  assert.equal(plantillaDe('telegram', CON_PLANTILLAS), 'sms-1')
})

test('un canal sin plantilla activa no se usa', () => {
  /**
   * No se cae a la del otro formato a propósito: desactivar la plantilla corta
   * es decir "este aviso solo por correo", y mandarlo igual por WhatsApp con el
   * texto del correo sería desobedecer esa decisión.
   */
  const soloCorreo = { ...CON_PLANTILLAS, plantilla_corta_id: null }
  assert.deepEqual(canalesUtiles(soloCorreo), ['email'])

  const soloCorta = { ...CON_PLANTILLAS, plantilla_email_id: null }
  assert.ok(!canalesUtiles(soloCorta).includes('email'))
  assert.ok(canalesUtiles(soloCorta).includes('whatsapp'))
})

test('tener el dato de contacto no alcanza si no hay plantilla', () => {
  /**
   * Hacen falta las dos cosas. Contar un canal como disponible sin plantilla
   * haría que la vista previa prometa un envío que no va a ocurrir — y eso es
   * peor que no prometer nada, porque nadie va a ir a revisar por qué faltó.
   */
  const sinNinguna = { ...COMPLETO, plantilla_email_id: null, plantilla_corta_id: null }
  assert.ok(canalesPara(sinNinguna).length > 0, 'tiene correo y celular cargados')
  assert.deepEqual(canalesUtiles(sinNinguna), [], 'pero no hay con qué escribirle')
})
