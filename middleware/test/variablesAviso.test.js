import test from 'node:test'
import assert from 'node:assert/strict'

import { dinero, fechaCorta, periodoDe, sumarDias } from '../src/services/variablesAviso.js'

/**
 * Los datos que las plantillas de aviso nombran.
 *
 * ── Por qué merecen pruebas propias ──
 *
 * Porque un marcador sin dato NO rompe nada: se deja tal cual para no perder el
 * resto del mensaje. Eso es lo correcto, y también es lo que hace que el error
 * sea invisible — el abonado recibe "Su servicio será suspendido el
 * {{fecha_corte}}" y del lado del ISP figura todo como enviado.
 *
 * Lo encontró un correo de prueba mandado de verdad, no una lectura del código:
 * los tres avisos de pago salían con los marcadores crudos porque el servicio
 * llamaba a `enviar` sin pasarle nada de la factura.
 */

test('la fecha no se corre un día', () => {
  /**
   * `new Date('2026-09-05')` es medianoche UTC, que en Ecuador es el 4 a las
   * 19:00. Un aviso de corte con la fecha corrida un día es peor que ninguno:
   * el abonado paga el día que le dijeron y lo encuentra cortado.
   */
  assert.equal(fechaCorta('2026-09-05'), '05/09/2026')
  assert.equal(fechaCorta('2026-01-01'), '01/01/2026')
  assert.equal(fechaCorta('2026-12-31T00:00:00Z'), '31/12/2026')
})

test('sumar días cruza meses y años', () => {
  assert.equal(sumarDias('2026-09-28', 5), '2026-10-03')
  assert.equal(sumarDias('2026-12-30', 5), '2027-01-04')
  // Y febrero, que es donde fallan las cuentas hechas a mano.
  assert.equal(sumarDias('2028-02-26', 5), '2028-03-02', '2028 es bisiesto')
  assert.equal(sumarDias('2026-02-26', 5), '2026-03-03', '2026 no lo es')
})

test('sumar cero días no mueve nada', () => {
  assert.equal(sumarDias('2026-09-05', 0), '2026-09-05')
})

test('el período se lee del concepto cuando lo trae', () => {
  // Es lo que el ISP escribió en la factura: si dice el mes, se respeta.
  assert.equal(periodoDe('Plan 30M · septiembre 2026', '2026-10-05'), 'septiembre 2026')
  assert.equal(periodoDe('Internet marzo de 2027', '2027-04-05'), 'marzo 2027')
})

test('y si no, del mes del vencimiento', () => {
  assert.equal(periodoDe('Servicio de internet', '2026-09-05'), 'septiembre 2026')
  assert.equal(periodoDe(null, '2026-01-20'), 'enero 2026')
})

test('el período nunca sale vacío si hay algo que decir', () => {
  /**
   * "Su factura está por vencer" sin decir cuál no sirve de nada cuando el
   * abonado debe tres.
   */
  assert.equal(periodoDe('Reconexión', null), 'Reconexión')
  assert.equal(periodoDe(null, null), '')
})

test('el dinero sale con dos decimales, siempre', () => {
  // "Su saldo pendiente de $20.1" se lee como un error del sistema.
  assert.equal(dinero(20.1), '$20.10')
  assert.equal(dinero(0), '$0.00')
  assert.equal(dinero(null), '$0.00')
  assert.equal(dinero('23.456'), '$23.46')
})

test('lo que no se entiende no rompe el aviso', () => {
  // Un dato raro es preferible a un mensaje que no sale.
  assert.equal(fechaCorta(null), '')
  assert.equal(fechaCorta('cuando sea'), 'cuando sea')
  assert.equal(sumarDias(null, 5), '')
})

/**
 * El texto de la plantilla dentro de la tarjeta.
 *
 * Es lo que hace que el editor no mienta: si editar la plantilla no cambiara el
 * correo, el ISP escribiría media hora un texto que nadie va a leer.
 */

test('el cuerpo de la plantilla se parte en párrafos', async () => {
  const { partirEnParrafos } = await import('../src/services/correoFactura.js')

  // Las plantillas están escritas con <p>, con <br> o con saltos, según quién
  // las haya tocado. Las tres formas tienen que funcionar.
  assert.deepEqual(partirEnParrafos('<p>Uno</p><p>Dos</p>'), ['Uno', 'Dos'])
  assert.deepEqual(partirEnParrafos('Uno<br>Dos'), ['Uno', 'Dos'])
  assert.deepEqual(partirEnParrafos('Uno\nDos'), ['Uno', 'Dos'])
})

test('se conserva el énfasis y se descarta lo que rompe la maqueta', async () => {
  const { partirEnParrafos } = await import('../src/services/correoFactura.js')

  // La negrita en un monto o una fecha es lo que hace que se lea de un vistazo.
  assert.deepEqual(
    partirEnParrafos('<p>Debe <b>$30.00</b> hasta el <b>25/08</b></p>'),
    ['Debe <b>$30.00</b> hasta el <b>25/08</b>'],
  )

  // Una tabla o un div dentro de la tarjeta la parten al medio.
  assert.deepEqual(
    partirEnParrafos('<div style="width:900px"><table><tr><td>Hola</td></tr></table></div>'),
    ['Hola'],
  )
})

test('una plantilla vacía no deja el correo en blanco', async () => {
  const { partirEnParrafos } = await import('../src/services/correoFactura.js')

  // Devuelve una lista vacía, y con eso el armador se cae al texto de fábrica:
  // un correo con el texto de siempre es mucho mejor que uno sin cuerpo.
  assert.deepEqual(partirEnParrafos(''), [])
  assert.deepEqual(partirEnParrafos(null), [])
  assert.deepEqual(partirEnParrafos('<p></p><p>   </p>'), [])
})
