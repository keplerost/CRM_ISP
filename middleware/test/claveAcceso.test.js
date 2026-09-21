import test from 'node:test'
import assert from 'node:assert/strict'

import {
  generarClaveAcceso,
  digitoVerificador,
  leerClaveAcceso,
  claveEsValida,
  fechaClave,
} from '../src/sri/claveAcceso.js'

/**
 * La clave de acceso es la identidad del comprobante ante el SRI. Si el dígito
 * verificador está mal, el rechazo llega sin explicación útil, así que conviene
 * que el error salte acá y no en producción.
 */

const BASE = {
  fechaEmision: '2026-07-31',
  tipoComprobante: '01',
  ruc: '1790012345001',
  ambiente: '1',
  establecimiento: '001',
  puntoEmision: '001',
  secuencial: 1,
}

test('la clave tiene exactamente 49 dígitos', () => {
  const clave = generarClaveAcceso(BASE)
  assert.equal(clave.length, 49)
  assert.match(clave, /^\d{49}$/)
})

test('los campos quedan en la posición que define el SRI', () => {
  const clave = generarClaveAcceso(BASE)
  const p = leerClaveAcceso(clave)

  assert.equal(p.fecha, '31/07/2026')
  assert.equal(p.tipoComprobante, '01')
  assert.equal(p.ruc, '1790012345001')
  assert.equal(p.ambiente, '1')
  assert.equal(p.establecimiento, '001')
  assert.equal(p.puntoEmision, '001')
  assert.equal(p.secuencial, '000000001')
  assert.equal(p.tipoEmision, '1')
  assert.equal(p.valida, true)
})

test('el dígito verificador usa módulo 11 con pesos 2..7', () => {
  // Verificación independiente del algoritmo, calculada aparte.
  const base = '3107202601179001234500110011001000000001000000011'.slice(0, 48)

  let peso = 2
  let suma = 0
  for (let i = base.length - 1; i >= 0; i--) {
    suma += Number(base[i]) * peso
    peso = peso === 7 ? 2 : peso + 1
  }
  const resto = suma % 11
  const esperado = resto === 0 ? 0 : resto === 1 ? 1 : 11 - resto

  assert.equal(digitoVerificador(base), esperado)
})

test('los dos casos especiales del módulo 11', () => {
  // 11 - resto puede dar 11 o 10; el SRI los define como 0 y 1.
  // Se comprueba sobre muchas claves que el resultado siempre sea un dígito.
  for (let s = 1; s <= 500; s++) {
    const d = digitoVerificador(generarClaveAcceso({ ...BASE, secuencial: s }).slice(0, 48))
    assert.ok(d >= 0 && d <= 9, `dígito fuera de rango: ${d}`)
  }
})

test('todas las claves generadas se validan a sí mismas', () => {
  for (let s = 1; s <= 200; s++) {
    const clave = generarClaveAcceso({ ...BASE, secuencial: s })
    assert.ok(claveEsValida(clave), `no validó la del secuencial ${s}`)
  }
})

test('detecta una clave alterada', () => {
  const clave = generarClaveAcceso(BASE)
  // Cambiar un dígito del medio tiene que invalidar el verificador.
  const alterada = clave.slice(0, 20) + (clave[20] === '9' ? '0' : '9') + clave.slice(21)
  assert.equal(claveEsValida(alterada), false)
})

test('la misma emisión produce siempre la misma clave', () => {
  // El código numérico se deriva del secuencial, no es aleatorio: reintentar
  // una emisión fallida no debe generar una clave distinta.
  assert.equal(generarClaveAcceso(BASE), generarClaveAcceso(BASE))
})

test('el secuencial se rellena a 9 dígitos', () => {
  const p = leerClaveAcceso(generarClaveAcceso({ ...BASE, secuencial: 12345 }))
  assert.equal(p.secuencial, '000012345')
})

test('la fecha se arma como ddmmaaaa', () => {
  assert.equal(fechaClave('2026-01-05'), '05012026')
  assert.equal(fechaClave('2026-12-31'), '31122026')
  assert.equal(fechaClave(new Date(2026, 6, 31, 12)), '31072026')
})

test('rechaza un RUC que no tenga 13 dígitos', () => {
  assert.throws(() => generarClaveAcceso({ ...BASE, ruc: '1790012345' }), /13 dígitos/)
  assert.throws(() => generarClaveAcceso({ ...BASE, ruc: '' }), /13 dígitos/)
})

test('rechaza una clave que no tenga 49 dígitos', () => {
  assert.throws(() => leerClaveAcceso('123'), /49 dígitos/)
  assert.equal(claveEsValida('123'), false)
  assert.equal(claveEsValida(null), false)
})

test('el ambiente de producción cambia la clave', () => {
  const pruebas = generarClaveAcceso({ ...BASE, ambiente: '1' })
  const produccion = generarClaveAcceso({ ...BASE, ambiente: '2' })
  assert.notEqual(pruebas, produccion)
  assert.equal(leerClaveAcceso(produccion).ambiente, '2')
})

test('cada tipo de comprobante produce claves distintas', () => {
  const tipos = ['01', '03', '04', '07']
  const claves = tipos.map((t) => generarClaveAcceso({ ...BASE, tipoComprobante: t }))
  assert.equal(new Set(claves).size, tipos.length)
  for (const [i, t] of tipos.entries()) {
    assert.equal(leerClaveAcceso(claves[i]).tipoComprobante, t)
  }
})
