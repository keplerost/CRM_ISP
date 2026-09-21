import test from 'node:test'
import assert from 'node:assert/strict'

import { aFecha, aNumero, textoDeCelda } from '../src/services/extractoBanco.js'
import { nombreDelConcepto, soloDigitos } from '../src/services/conciliacion.js'

/**
 * El extracto del banco.
 *
 * Lo que se prueba acá es la lectura, que es donde un error no se ve: un importe
 * mal interpretado no rompe nada, solo hace que la conciliación diga que falta
 * plata que está.
 */

test('un importe con separador de miles no se lee mil veces más chico', () => {
  /**
   * "$9.970,84" son nueve mil novecientos setenta con ochenta y cuatro. El punto
   * separa los miles y la coma los centavos, como se escribe en Ecuador.
   *
   * `Number("$9.970,84")` da NaN, y quitarle solo el símbolo da 9.97 — un error
   * de mil veces que en un extracto pasa desapercibido porque el número sigue
   * pareciendo un importe.
   */
  assert.equal(aNumero('$9.970,84'), 9970.84)
  assert.equal(aNumero('$600,00'), 600)
  assert.equal(aNumero('$23,1'), 23.1)
  assert.equal(aNumero('23,10'), 23.1)
})

test('también se lee el formato inglés, por si el banco cambia', () => {
  // "1,234.56" es mil doscientos treinta y cuatro. El último separador manda.
  assert.equal(aNumero('$1,234.56'), 1234.56)
  assert.equal(aNumero('1234.56'), 1234.56)
  // Y una coma que separa exactamente tres cifras son miles, no decimales:
  // "1,234" no puede ser uno con doscientos treinta y cuatro milésimos.
  assert.equal(aNumero('1,234'), 1234)
})

test('lo que no es un importe no se convierte en cero', () => {
  /**
   * Devolver 0 haría que una fila ilegible entre a la conciliación como un
   * movimiento de cero pesos: no llama la atención de nadie y esconde plata que
   * el banco reportó.
   */
  assert.equal(aNumero(''), null)
  assert.equal(aNumero(null), null)
  assert.equal(aNumero('Monto'), null)
})

test('las fechas del Pichincha se leen con su hora', () => {
  assert.deepEqual(aFecha('2026-8-17, 9:28 AM'), { fecha: '2026-08-17', hora: '09:28:00' })
  // La tarde: 11:16 PM son las 23:16, no las 11:16.
  assert.deepEqual(aFecha('2026-8-17, 11:16 PM'), { fecha: '2026-08-17', hora: '23:16:00' })
  // Y medianoche, que es el caso que rompe la conversión ingenua.
  assert.deepEqual(aFecha('2026-8-17, 12:05 AM'), { fecha: '2026-08-17', hora: '00:05:00' })
  assert.deepEqual(aFecha('2026-8-17, 12:05 PM'), { fecha: '2026-08-17', hora: '12:05:00' })
})

test('también el formato con el día primero', () => {
  assert.deepEqual(aFecha('17/08/2026'), { fecha: '2026-08-17', hora: '00:00:00' })
})

test('una fecha ilegible se dice, no se inventa', () => {
  assert.equal(aFecha('Fecha'), null)
  assert.equal(aFecha(''), null)
})

test('el texto con formato se lee como texto', () => {
  /**
   * TODO el extracto del Pichincha viene como `richText`. Sin esto, cada celda
   * se lee como "[object Object]" y no hay conciliación posible.
   */
  assert.equal(textoDeCelda({ richText: [{ text: '116415212' }] }), '116415212')
  assert.equal(
    textoDeCelda({ richText: [{ text: 'TRANSF. ' }, { text: 'DIRECTA' }] }),
    'TRANSF. DIRECTA',
  )
  assert.equal(textoDeCelda({ result: 42 }), '42')
  assert.equal(textoDeCelda(null), '')
})

test('el número de comprobante se compara sin adornos', () => {
  /**
   * El abonado dicta "Doc. 116415212" o "comprobante N° 116415212" y el banco
   * guarda el número pelado. Comparar los textos tal cual no encuentra nada y la
   * conciliación manda a llamar a alguien que pagó.
   */
  assert.equal(soloDigitos('Doc. 116415212'), '116415212')
  assert.equal(soloDigitos('116415212'), '116415212')
  assert.equal(soloDigitos('N° 116-415-212'), '116415212')
  assert.equal(soloDigitos(null), '')
})

test('del concepto se saca quién transfirió', () => {
  /**
   * Es lo único que permite ponerle nombre a un depósito que nadie registró: el
   * banco no manda el nombre en una columna propia.
   */
  assert.equal(
    nombreDelConcepto('TRANSF. DIRECTA DE ESPIN CAMPAÑA ANGEL ORLANDO'),
    'ESPIN CAMPAÑA ANGEL ORLANDO',
  )
  assert.equal(
    nombreDelConcepto('TRANSF. DIRECTA DE MURILLO SALVATIERRA JAIRON'),
    'MURILLO SALVATIERRA JAIRON',
  )
})

test('cuando el banco no dice el nombre, no se inventa uno', () => {
  /**
   * Un depósito en corresponsal dice "DEP CNB" y el RUC del local, que no es el
   * del abonado. Devolver eso como "probable nombre" mandaría a buscar a la
   * persona equivocada.
   */
  assert.equal(nombreDelConcepto('DEP CNB 0503363376001'), '')
  assert.equal(nombreDelConcepto('TRANSFERENCIA INTERNET'), '')
  assert.equal(nombreDelConcepto(''), '')
})
