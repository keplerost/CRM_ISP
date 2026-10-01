import test from 'node:test'
import assert from 'node:assert/strict'
import { PROVEEDORES, armarDatos, proveedorDe, proveedoresDe } from '../src/lib/proveedoresFactura.js'
import { PAISES } from '../src/lib/paises.js'

/**
 * Los proveedores de factura electrónica.
 *
 * Lo delicado es lo que se guarda: un secreto vacío no puede borrar el que ya
 * estaba —la pantalla nunca lo muestra, así que siempre llega vacío—, y no se
 * puede activar un proveedor al que le falta lo que pide.
 */

const openfactura = proveedorDe('CL', 'openfactura')

test('cada país tiene al menos un proveedor, y Ecuador el SRI directo', () => {
  for (const p of PAISES) assert.ok(proveedoresDe(p.codigo).length, `${p.codigo} sin proveedores`)
  const sri = proveedorDe('EC', 'sri')
  assert.ok(sri.integrado && sri.configuraEn)
})

test('los ids no se repiten dentro de un país, y cada campo tiene clave y tipo', () => {
  for (const [pais, lista] of Object.entries(PROVEEDORES)) {
    const ids = lista.map((p) => p.id)
    assert.equal(new Set(ids).size, ids.length, `${pais}: ids repetidos`)
    for (const p of lista) for (const c of p.campos) assert.ok(c.clave && c.tipo, `${pais}/${p.id}: campo incompleto`)
  }
})

test('un secreto vacío no borra el guardado', () => {
  const { secretos, faltan } = armarDatos(
    openfactura,
    { razon_social: 'ISP SpA', rut: '76.123.456-7', api_key: '' },
    { activo: true, guardados: { api_key: true } },
  )
  assert.ok(!('api_key' in secretos))
  assert.deepEqual(faltan, [])
})

test('no se activa sin lo obligatorio, pero se puede guardar a medias', () => {
  assert.deepEqual(armarDatos(openfactura, {}, { activo: true }).faltan, ['Razón social emisor', 'RUT emisor', 'API KEY'])
  assert.deepEqual(armarDatos(openfactura, {}, { activo: false }).faltan, [])
})

test('el secreto nunca queda entre los datos en claro', () => {
  const { datos, secretos } = armarDatos(openfactura, { api_key: 'abc123', razon_social: 'X' })
  assert.equal(secretos.api_key, 'abc123')
  assert.ok(!JSON.stringify(datos).includes('abc123'))
})

test('las opciones toman su valor por defecto', () => {
  assert.equal(armarDatos(openfactura, {}).datos.tamano_pdf, 'LETTER')
})
