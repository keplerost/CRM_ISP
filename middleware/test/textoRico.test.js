import test from 'node:test'
import assert from 'node:assert/strict'

import { aBloques, aTextoPlano } from '../src/pagos/textoRico.js'

/**
 * El HTML de una plantilla, convertido en bloques imprimibles.
 *
 * Lo que se prueba acá es que NO SE PIERDA TEXTO. Un documento al que le falta
 * una palabra es un problema; uno que descarta un párrafo entero en silencio es
 * peor, porque el que lo firma no sabe qué debería estar leyendo.
 */

test('los párrafos salen como párrafos', () => {
  const b = aBloques('<p>Primero</p><p>Segundo</p>')
  assert.deepEqual(b.map((x) => x.texto), ['Primero', 'Segundo'])
  assert.ok(b.every((x) => x.tipo === 'parrafo'))
})

test('los títulos conservan su nivel', () => {
  const b = aBloques('<h1>CONTRATO</h1><p>Entre las partes</p>')
  assert.equal(b[0].tipo, 'h1')
  assert.equal(b[0].texto, 'CONTRATO')
})

test('las listas salen como ítems', () => {
  const b = aBloques('<ul><li>Uno</li><li>Dos</li></ul>')
  assert.deepEqual(b.map((x) => x.tipo), ['item', 'item'])
  assert.deepEqual(b.map((x) => x.texto), ['Uno', 'Dos'])
})

test('el texto suelto entre etiquetas no se pierde', () => {
  /**
   * Es el error más probable de un parseo por expresiones regulares: partir por
   * <p>…</p> y tirar lo que quedó afuera. En un contrato eso puede ser la
   * cláusula que alguien pegó sin envolver.
   */
  const b = aBloques('<h1>Título</h1>Una cláusula suelta<p>Y otra</p>')
  const todo = b.map((x) => x.texto).join(' ')
  assert.match(todo, /Una cláusula suelta/)
  assert.match(todo, /Y otra/)
})

test('una etiqueta desconocida no se lleva su contenido', () => {
  // Alguien pega desde Word y aparecen <span>, <font>, <o:p>. El texto tiene
  // que llegar igual.
  const b = aBloques('<p><span style="x">Con formato raro</span></p>')
  assert.equal(b[0].texto, 'Con formato raro')
})

test('sin etiquetas, cada línea es un párrafo', () => {
  // Es como se escribe un contrato a mano en el editor, o una plantilla de SMS.
  const b = aBloques('Primera línea\nSegunda línea')
  assert.deepEqual(b.map((x) => x.texto), ['Primera línea', 'Segunda línea'])
})

test('los acentos escritos como entidad se leen bien', () => {
  // Un editor de correo los convierte solos, y "OA RIERA" en un contrato es un
  // nombre mal escrito en un papel que se firma.
  assert.equal(aBloques('<p>OÑA RIERA JOSÉ</p>')[0].texto, 'OÑA RIERA JOSÉ')
})

test('los saltos del código fuente no son espacios del documento', () => {
  const b = aBloques('<p>\n   Un párrafo\n   partido en el archivo\n</p>')
  assert.equal(b[0].texto, 'Un párrafo partido en el archivo')
})

test('el <br> corta el párrafo', () => {
  const b = aBloques('<p>Una línea<br>Otra línea</p>')
  assert.equal(b.length, 2)
})

test('la línea horizontal es un bloque propio', () => {
  // En un contrato separa las cláusulas de las firmas.
  const b = aBloques('<p>Arriba</p><hr><p>Abajo</p>')
  assert.deepEqual(b.map((x) => x.tipo), ['parrafo', 'linea', 'parrafo'])
})

test('el texto plano sirve para medir e imprimir en tirilla', () => {
  // Una tirilla de 58 mm no tiene títulos ni negritas.
  const t = aTextoPlano('<h1>RECIBO</h1><p>Gracias por su pago</p>')
  assert.equal(t, 'RECIBO\nGracias por su pago')
})

test('una plantilla vacía no rompe', () => {
  assert.deepEqual(aBloques(''), [])
  assert.deepEqual(aBloques(null), [])
  assert.equal(aTextoPlano(undefined), '')
})
