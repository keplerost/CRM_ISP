import test from 'node:test'
import assert from 'node:assert/strict'
import { CODIGO_SRI, TARIFAS_GENERALES, codigoDeTarifa } from '../src/lib/iva.js'
import { IVA } from '../src/sri/facturaXml.js'

/**
 * El código de porcentaje que va en el XML.
 *
 * Es lo que hace que bajar el IVA al 12 % no termine en comprobantes
 * rechazados: el SRI no lee el número, lee el código, y un 12 % con el código
 * del 15 % ('4') no pasa.
 */

test('cada tarifa general tiene su código del SRI', () => {
  for (const t of TARIFAS_GENERALES) assert.ok(codigoDeTarifa(t), `falta el código de ${t} %`)
})

test('los códigos coinciden con los que usa el armado del XML', () => {
  assert.equal(codigoDeTarifa(15), IVA.QUINCE.codigo)
  assert.equal(codigoDeTarifa(12), IVA.DOCE.codigo)
  assert.equal(codigoDeTarifa(14), IVA.CATORCE.codigo)
  assert.equal(codigoDeTarifa(0), IVA.CERO.codigo)
})

test('una tarifa que no existe no inventa código', () => {
  assert.equal(codigoDeTarifa(16), null)
  assert.equal(codigoDeTarifa('abc'), null)
  assert.equal(codigoDeTarifa('12'), '2', 'llega como texto desde el formulario')
})

test('0 no es una tarifa general: los exentos se marcan por abonado', () => {
  assert.ok(!TARIFAS_GENERALES.includes(0))
  assert.equal(CODIGO_SRI[0], '0')
})
