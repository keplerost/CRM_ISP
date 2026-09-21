import test from 'node:test'
import assert from 'node:assert/strict'

import { leyendaDe } from '../src/services/correoFactura.js'

/**
 * El mensaje que el ISP escribe y que sale impreso en el comprobante.
 *
 * ── Por qué hace falta limpiarlo ──
 *
 * Las plantillas se escriben con HTML —el editor ofrece negrita, párrafos— y un
 * PDF no lo interpreta: imprimiría las etiquetas tal cual, y el cliente se
 * llevaría un papel que dice "<p>Gracias por su pago</p>".
 */

test('el HTML de la plantilla no llega al papel', () => {
  assert.equal(
    leyendaDe('<p>Gracias por su pago. Su factura fue cancelada.</p>'),
    'Gracias por su pago. Su factura fue cancelada.',
  )
  assert.equal(leyendaDe('<b>Gracias</b> por su pago'), 'Gracias por su pago')
})

test('dos párrafos no quedan pegados', () => {
  /**
   * Sacar las etiquetas sin más convierte "</p><p>" en nada y pega la última
   * palabra con la primera del párrafo siguiente: "canceladaGracias".
   */
  assert.equal(
    leyendaDe('<p>Su factura fue cancelada.</p><p>Gracias por su preferencia.</p>'),
    'Su factura fue cancelada. Gracias por su preferencia.',
  )
  assert.equal(leyendaDe('Primera línea<br>Segunda línea'), 'Primera línea Segunda línea')
})

test('un marcador sin reemplazar se saca, no se imprime', () => {
  /**
   * Un papel que dice "Gracias {{nombre}}" es peor que uno que dice "Gracias":
   * el primero parece un sistema roto, el segundo parece una decisión.
   */
  assert.equal(leyendaDe('Gracias {{nombre}} por su pago'), 'Gracias por su pago')
  assert.equal(leyendaDe('{{empresa}} agradece su pago'), 'agradece su pago')
})

test('sin texto no se imprime una línea vacía', () => {
  /**
   * `null` y no cadena vacía: el generador del PDF decide con eso si dibuja el
   * renglón. Una cadena vacía dibujaría un espacio en blanco donde debería no
   * haber nada.
   */
  assert.equal(leyendaDe(''), null)
  assert.equal(leyendaDe(null), null)
  assert.equal(leyendaDe('   '), null)
  assert.equal(leyendaDe('<p></p>'), null)
})

test('los espacios de más se juntan', () => {
  // El editor deja saltos de línea e indentación que en una sola línea se ven
  // como huecos.
  assert.equal(
    leyendaDe('  Gracias   por\n  su    pago  '),
    'Gracias por su pago',
  )
})

test('las entidades HTML se leen como el símbolo', () => {
  assert.equal(leyendaDe('Pagos&nbsp;y&nbsp;servicios'), 'Pagos y servicios')
  assert.equal(leyendaDe('Internet &amp; TV'), 'Internet & TV')
})
