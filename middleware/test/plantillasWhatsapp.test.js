import test from 'node:test'
import assert from 'node:assert/strict'

import { revisarCuerpo, verificarCoherencia } from '../src/services/plantillasWhatsapp.js'

/**
 * Las reglas por las que Meta rechaza una plantilla.
 *
 * Todas se cometen igual, porque son las que uno no ve al escribir un texto que
 * suena perfecto. Y descubrirlas del otro lado cuesta una vuelta entera: se
 * pega el texto en el Administrador de WhatsApp, se manda, y la respuesta tarda.
 *
 * El costo de no tenerlas: la plantilla no se aprueba, y el aviso de corte no
 * sale por WhatsApp el día que hace falta.
 */

// --- Lo que Meta rechaza ----------------------------------------------------

test('un cuerpo que empieza con variable se rechaza', () => {
  /**
   * Es el error más común, porque casi todas nuestras plantillas internas
   * empiezan con `{{empresa}}`. La solución no es moverla: es sacarla. WhatsApp
   * ya muestra el nombre del negocio arriba del mensaje.
   */
  assert.throws(
    () => revisarCuerpo('{{1}}: su factura de {{2}} está disponible.'),
    /EMPIECE con una variable/,
  )
})

test('un cuerpo que termina con variable se rechaza', () => {
  assert.throws(
    () => revisarCuerpo('Su servicio fue suspendido. Consultas al {{1}}'),
    /TERMINE con una variable/,
  )
})

test('dos variables pegadas se rechazan', () => {
  assert.throws(() => revisarCuerpo('Su factura de {{1}}{{2}} venció.'), /dos variables seguidas/)
  // Con texto en el medio sí pasa, aunque sea un espacio y un guion.
  assert.doesNotThrow(() => revisarCuerpo('Su factura de {{1}} - {{2}} venció.'))
})

test('las posiciones tienen que ir 1, 2, 3 sin saltos', () => {
  /**
   * `{{1}}` y `{{3}}` sin `{{2}}` es el resultado típico de borrar una variable
   * del medio. Meta lo rechaza, y si no lo hiciera sería peor: mandaríamos dos
   * parámetros para tres posiciones y el mensaje saldría corrido.
   */
  assert.throws(() => revisarCuerpo('Debe {{1}} desde el {{3}} de este mes.'), /sin saltos/)
  assert.throws(() => revisarCuerpo('Debe {{2}} desde el {{3}} de este mes.'), /sin saltos/)
})

test('una variable repetida se rechaza', () => {
  // Meta espera un parámetro por posición: repetir {{1}} pide dos valores para
  // la misma y el conteo deja de cerrar.
  assert.throws(() => revisarCuerpo('Su saldo es {{1}} y vence {{1}} del mes.'), /sin saltos/)
})

test('un cuerpo vacío o larguísimo se rechaza', () => {
  assert.throws(() => revisarCuerpo(''), /no puede estar vacío/)
  assert.throws(() => revisarCuerpo('   '), /no puede estar vacío/)
  assert.throws(() => revisarCuerpo('x'.repeat(1025)), /1024/)
})

// --- Lo que Meta acepta -----------------------------------------------------

test('las plantillas del sistema pasan las reglas', () => {
  /**
   * Son los textos que siembra la migración 176. Si alguno dejara de cumplir,
   * el ISP se enteraría recién al intentar registrarlo en Meta — y para
   * entonces ya contaba con que el aviso de corte salía por WhatsApp.
   */
  const DEL_SISTEMA = [
    'Su factura de {{1}} por {{2}} ya está disponible. Vence el {{3}}. Puede consultarla o pagarla cuando guste.',
    'Le recordamos que su factura de {{1}} por {{2}} vence el {{3}}. Si ya realizó el pago, puede ignorar este mensaje.',
    'Su factura de {{1}} se encuentra vencida. Saldo pendiente: {{2}}. Puede regularizarla hasta el {{3}} para mantener su servicio activo.',
    'Su servicio será suspendido el {{1}} por un saldo pendiente de {{2}}. Si ya realizó el pago, por favor comuníquese con nosotros para regularizarlo.',
    'Su servicio fue suspendido por un saldo pendiente de {{1}}. Al registrarse su pago se reactiva automáticamente. Para cualquier consulta puede comunicarse al {{2}}, con gusto lo atendemos.',
    'Recibimos su pago de {{1}}. Su saldo actual es {{2}}. Gracias por su preferencia.',
    'Estamos atendiendo una avería que afecta el servicio en su sector: {{1}}. {{2}} No es necesario que reinicie su equipo; le avisaremos apenas quede restablecido.',
    'Le informamos que la avería que afectaba el servicio en su sector quedó solucionada y su conexión está restablecida. Si continúa sin servicio, escríbanos.',
    'Realizaremos un mantenimiento programado que puede interrumpir su servicio el {{1}}. Motivo: {{2}}. Disculpe las molestias que esto pueda ocasionar.',
    'Le damos la bienvenida. Su servicio de internet ya se encuentra activo. Ante cualquier consulta puede escribirnos por este mismo medio.',
  ]

  for (const cuerpo of DEL_SISTEMA) {
    assert.doesNotThrow(() => revisarCuerpo(cuerpo), `debería pasar: ${cuerpo.slice(0, 40)}…`)
  }
})

test('una plantilla sin variables es válida', () => {
  // La de "avería solucionada" no lleva ninguna, a propósito: menos partes
  // móviles, aprobación más rápida y nada que pueda llegar vacío.
  const r = revisarCuerpo('La avería en su sector quedó solucionada. Si sigue sin servicio, escríbanos.')
  assert.equal(r.variables, 0)
})

test('cuenta cuántas variables usa el texto', () => {
  assert.equal(revisarCuerpo('Debe {{1}} y vence el {{2}} próximo.').variables, 2)
})

// --- El orden de las variables ----------------------------------------------

test('el texto y los nombres cargados tienen que ser la misma cantidad', () => {
  /**
   * Es lo que conecta `{{saldo}}` con `{{2}}`. Con un nombre de menos se manda
   * un parámetro de menos, Meta rechaza el envío entero, y el aviso no sale
   * para nadie — no para uno: para toda la corrida.
   */
  const malo = verificarCoherencia({
    cuerpo_meta: 'Su factura de {{1}} por {{2}} vence el {{3}}.',
    variables: ['periodo', 'total'],
  })

  assert.equal(malo.ok, false)
  assert.match(malo.motivo, /3 variable/)
  assert.match(malo.motivo, /2 nombre/)
})

test('con la misma cantidad, pasa', () => {
  const bueno = verificarCoherencia({
    cuerpo_meta: 'Su factura de {{1}} por {{2}} vence el {{3}}.',
    variables: ['periodo', 'total', 'fecha_vencimiento'],
  })
  assert.equal(bueno.ok, true)
})

test('sin variables en el texto no hace falta cargar ninguna', () => {
  const bueno = verificarCoherencia({
    cuerpo_meta: 'La avería en su sector quedó solucionada.',
    variables: [],
  })
  assert.equal(bueno.ok, true)
})
