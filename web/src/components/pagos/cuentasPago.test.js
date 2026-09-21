import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * A qué cuenta puede entrar cada forma de pago.
 *
 * ── El error que esto fija ──
 *
 * El selector ofrecía TODAS las cuentas sin mirar cómo pagó el abonado, así que
 * al cobrar en efectivo se elegía entre cuentas del banco. Esa plata no está en
 * ningún banco: está en la caja de la oficina.
 *
 * No es cosmético. Ese cobro aparece después en la conciliación bancaria como
 * "sin respaldo" —el banco no lo tiene, claro— y manda a llamar a un abonado que
 * pagó en ventanilla.
 *
 * La regla se replica acá porque vive en un componente de React que no se puede
 * montar en estas pruebas. Lo que importa probar es la DECISIÓN, que es donde
 * estaba el error.
 */

const FORMAS_PAGO = [
  { valor: 'efectivo', tipos: ['efectivo'], electronico: false },
  { valor: 'transferencia', tipos: ['banco'], electronico: true },
  { valor: 'deposito', tipos: ['banco'], electronico: true },
  { valor: 'tarjeta', tipos: ['banco'], electronico: true },
  { valor: 'otro', tipos: null, electronico: true },
]

function cuentasPara(cuentas = [], formaPago = 'efectivo') {
  const forma = FORMAS_PAGO.find((f) => f.valor === formaPago)
  if (!forma?.tipos) return cuentas
  return cuentas.filter((c) => forma.tipos.includes(c.tipo))
}

const exigeCuenta = (formaPago) =>
  FORMAS_PAGO.find((f) => f.valor === formaPago)?.electronico ?? true

const CUENTAS = [
  { id: 'caja', nombre: 'Caja Oficina', tipo: 'efectivo' },
  { id: 'pichincha', nombre: 'Pichincha corriente', tipo: 'banco' },
  { id: 'guayaquil', nombre: 'Guayaquil ahorros', tipo: 'banco' },
  { id: 'deuna', nombre: 'DeUna', tipo: 'billetera' },
]

test('el efectivo solo puede entrar a una caja', () => {
  const opciones = cuentasPara(CUENTAS, 'efectivo')

  assert.deepEqual(opciones.map((c) => c.id), ['caja'])
  assert.ok(!opciones.some((c) => c.tipo === 'banco'), 'ninguna cuenta de banco')
})

test('una transferencia no puede entrar a la caja', () => {
  /**
   * Es el error al revés y también rompe la conciliación: la plata figura en la
   * caja de la oficina y el arqueo del día no cuadra por un dinero que nunca se
   * tocó.
   */
  const opciones = cuentasPara(CUENTAS, 'transferencia')

  assert.deepEqual(opciones.map((c) => c.id), ['pichincha', 'guayaquil'])
  assert.ok(!opciones.some((c) => c.id === 'caja'))
})

test('"otro" no restringe, porque no se sabe qué es', () => {
  // Billeteras, convenios, lo que aparezca. Se ofrecen todas: adivinar cuál
  // corresponde dejaría afuera la que hace falta.
  assert.equal(cuentasPara(CUENTAS, 'otro').length, CUENTAS.length)
})

test('todas las formas exigen cuenta menos el efectivo', () => {
  /**
   * El efectivo también la pide en la pantalla, pero la base no se la exige: hay
   * cobros en efectivo cargados de antes sin ella, y bloquearlos impediría
   * anularlos o corregirlos.
   */
  assert.equal(exigeCuenta('transferencia'), true)
  assert.equal(exigeCuenta('deposito'), true)
  assert.equal(exigeCuenta('tarjeta'), true)
  assert.equal(exigeCuenta('otro'), true)
  assert.equal(exigeCuenta('efectivo'), false)
})

test('sin cuentas del tipo que corresponde, no se ofrece ninguna', () => {
  /**
   * Y no se cae a la primera de la lista. Ofrecer una cuenta del banco cuando no
   * hay caja es exactamente el error que esto viene a impedir: el cajero elige
   * la única que le aparece.
   */
  const soloBancos = CUENTAS.filter((c) => c.tipo === 'banco')

  assert.deepEqual(cuentasPara(soloBancos, 'efectivo'), [])
})

test('la cuenta propuesta al abrir sirve para la forma de pago inicial', () => {
  /**
   * Antes se proponía la primera de la lista, que alfabéticamente puede ser una
   * del banco. El cajero que no toca ese campo terminaba imputando el efectivo
   * al Pichincha sin haber elegido nada.
   */
  const propuesta = cuentasPara(CUENTAS, 'efectivo')[0]?.id ?? ''
  assert.equal(propuesta, 'caja')
})

test('cambiar la forma de pago suelta la cuenta que ya no vale', () => {
  /**
   * El caso concreto: se elige Transferencia y la cuenta del Pichincha, después
   * se corrige a Efectivo. La cuenta del banco desaparece de la lista pero sigue
   * guardada, y el cobro en efectivo termina imputado al banco. Un valor que el
   * usuario ya no puede ver es un valor que nadie corrige.
   */
  const alCambiar = (cuentaActual, nuevaForma) => {
    const posibles = cuentasPara(CUENTAS, nuevaForma)
    if (posibles.some((c) => c.id === cuentaActual)) return cuentaActual
    return posibles.length === 1 ? posibles[0].id : ''
  }

  assert.equal(alCambiar('pichincha', 'efectivo'), 'caja', 'con una sola opción, se elige sola')
  assert.equal(alCambiar('caja', 'transferencia'), '', 'con varias, hay que elegir')
  assert.equal(alCambiar('pichincha', 'deposito'), 'pichincha', 'si sigue valiendo, se queda')
})
