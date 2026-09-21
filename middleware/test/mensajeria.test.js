import test from 'node:test'
import assert from 'node:assert/strict'

import { aplicarPlantilla, variablesDe, aInternacional, destinoDe } from '../src/services/mensajeria.js'

/**
 * Una plantilla mal reemplazada llega al abonado con "{{nombre}}" adentro y
 * queda como un mensaje automático mal hecho. Un número mal formado no llega a
 * ningún lado y nadie se entera hasta que el cliente reclama que no le avisaron.
 */

test('los marcadores se reemplazan por los datos del abonado', () => {
  const texto = aplicarPlantilla('Estimado/a {{nombre}}: debe {{saldo}} hasta el {{fecha}}.', {
    nombre: 'JEFFERSON OÑA',
    saldo: '$34.50',
    fecha: '05/08/2026',
  })

  assert.equal(texto, 'Estimado/a JEFFERSON OÑA: debe $34.50 hasta el 05/08/2026.')
})

test('un marcador que no existe se deja como está, no se borra', () => {
  // Borrarlo dejaría una frase incompleta que parece correcta; dejarlo visible
  // hace evidente que falta un dato antes de mandarlo.
  assert.equal(aplicarPlantilla('Hola {{nombre}}, su {{invento}}.', { nombre: 'ANA' }), 'Hola ANA, su {{invento}}.')
})

test('tolera espacios dentro del marcador', () => {
  assert.equal(aplicarPlantilla('Hola {{ nombre }}', { nombre: 'ANA' }), 'Hola ANA')
})

test('las variables del abonado incluyen el primer nombre y el saldo con formato', () => {
  const v = variablesDe({ nombre: 'JEFFERSON FABIAN OÑA RIERA', saldo: 34.5 })
  assert.equal(v.primer_nombre, 'JEFFERSON')
  assert.equal(v.saldo, '$34.50')
})

test('un saldo cero se escribe igual, no queda vacío', () => {
  assert.equal(variablesDe({ saldo: 0 }).saldo, '$0.00')
})

test('los celulares ecuatorianos salen en formato internacional', () => {
  assert.equal(aInternacional('0987654321'), '593987654321')
  assert.equal(aInternacional('+593 98 765 4321'), '593987654321')
  assert.equal(aInternacional('593987654321'), '593987654321')
  assert.equal(aInternacional(''), null)
  assert.equal(aInternacional(null), null)
})

test('cada canal sabe a dónde escribir', () => {
  const cliente = {
    email: 'a@b.com',
    telefono: '032801234',
    telefono_movil: '0987654321',
    telegram_chat_id: '55512345',
  }

  assert.equal(destinoDe('email', cliente), 'a@b.com')
  assert.equal(destinoDe('telegram', cliente), '55512345')
  // WhatsApp y SMS van al celular, no al fijo: mandar un WhatsApp a un teléfono
  // de línea no llega y no da error.
  assert.equal(destinoDe('whatsapp', cliente), '0987654321')
  assert.equal(destinoDe('sms', cliente), '0987654321')
})

test('sin celular cargado cae al teléfono fijo antes que a nada', () => {
  assert.equal(destinoDe('whatsapp', { telefono: '032801234' }), '032801234')
  assert.equal(destinoDe('whatsapp', {}), null)
})
