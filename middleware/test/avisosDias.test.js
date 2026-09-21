import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COMBINACIONES_FACTURA, OPCIONES_DIAS, OPCIONES_PANTALLA,
  avisosEnOrden, canalesDeCombinacion, combinacionDe, describirDias,
} from '../../web/src/lib/avisos.js'

/**
 * Cuándo se le manda cada aviso de pago.
 *
 * Vive en `web/` porque es de la pantalla, y se prueba desde acá porque la web
 * no tiene corredor de pruebas. Es el mismo arreglo que con las alertas: el
 * texto que se elige y el que se guarda son el mismo, y esa igualdad conviene
 * tenerla verificada.
 */

test('la lista dice el signo con palabras, no con un menos', () => {
  /**
   * El número es en días respecto del vencimiento y el signo lo cambia todo:
   * -1 es un día antes y 1 es un día después. Un menos que falta convierte
   * "avisale un día antes" en "avisale un día tarde", y eso no se ve revisando
   * la ficha: se ve cuando el abonado llama diciendo que le cortaron sin avisar.
   */
  const antes = OPCIONES_DIAS.find((o) => o.valor === -1)
  const despues = OPCIONES_DIAS.find((o) => o.valor === 1)

  assert.match(antes.titulo, /antes de vencer/)
  assert.match(despues.titulo, /después de vencer/)
  assert.ok(!antes.titulo.includes('-'), 'el signo no puede quedar a interpretación')
})

test('cada opción se describe igual que su texto en la lista', () => {
  // Si divergieran, la ficha mostraría una cosa y el desplegable otra para el
  // mismo valor guardado.
  for (const o of OPCIONES_DIAS) {
    if (o.valor === '') continue
    assert.equal(
      describirDias(o.valor).toLowerCase(),
      o.titulo.toLowerCase(),
      `"${o.titulo}" no coincide con lo que se describe`,
    )
  }
})

test('el día del vencimiento se dice aparte', () => {
  // "0 días antes" o "0 días después" no significan nada para nadie.
  assert.equal(describirDias(0), 'el mismo día del vencimiento')
})

test('vacío es usar el valor general', () => {
  assert.equal(describirDias(''), 'usa el valor general')
  assert.equal(describirDias(null), 'usa el valor general')
})

test('el singular y el plural están bien', () => {
  assert.equal(describirDias(-1), '1 día antes de vencer')
  assert.equal(describirDias(-2), '2 días antes de vencer')
})

// --- El orden ---------------------------------------------------------------

test('el orden correcto no da problemas', () => {
  assert.deepEqual(avisosEnOrden({ dias1: -3, dias2: 1, dias3: 5 }), [])
})

test('un aviso que quedó fuera de orden se avisa', () => {
  /**
   * La lista impide escribir mal un número, no ponerlos en desorden. Y el
   * desorden NO da error: la regla pregunta primero por el 3, después por el 2 y
   * después por el 1, así que si el 2 quedara más tarde que el 3, el nivel 2
   * nunca se alcanzaría. Ese aviso simplemente no se manda, y nada lo dice.
   */
  const problemas = avisosEnOrden({ dias1: -3, dias2: 10, dias3: 5 })
  assert.ok(problemas.length > 0)
  assert.match(problemas[0], /segundo no se va a mandar/)
})

test('dos avisos el mismo día también es desorden', () => {
  // Con la misma fecha, el de nivel más alto gana y el otro no sale nunca.
  assert.ok(avisosEnOrden({ dias1: 1, dias2: 1, dias3: 5 }).length > 0)
})

test('lo que no está definido no se juzga', () => {
  // Media base va a tener los tres en "usar el general", y eso no es un error.
  assert.deepEqual(avisosEnOrden({ dias1: null, dias2: null, dias3: null }), [])
  assert.deepEqual(avisosEnOrden({ dias1: '', dias2: 1, dias3: '' }), [])
})

test('el desorden entre el primero y el último también se detecta', () => {
  // Con el segundo sin definir, la comparación de a pares salteada es la única
  // que lo encuentra.
  const problemas = avisosEnOrden({ dias1: 10, dias2: null, dias3: 5 })
  assert.ok(problemas.length > 0)
  assert.match(problemas[0], /primero no se va a mandar/)
})

// --- El aviso de nueva factura ----------------------------------------------

test('lo guardado y la opción de la lista son lo mismo, ida y vuelta', () => {
  // Si divergieran, alguien elige "Correo + SMS", guarda, vuelve a abrir y ve
  // otra cosa — y no sabría cuál de las dos rige.
  for (const c of COMBINACIONES_FACTURA) {
    assert.equal(
      combinacionDe(canalesDeCombinacion(c.valor)),
      c.valor,
      `"${c.titulo}" no vuelve a su misma opción`,
    )
  }
})

test('"por donde se pueda" es null, y desactivado es lista vacía', () => {
  /**
   * La diferencia importa: `null` es "no lo configuré" y la lista vacía es "me
   * lo pidió el abonado". Guardar los dos igual haría que un abonado nuevo
   * quedara sin aviso de factura por omisión, cuando la regla es que se le avisa
   * a todos.
   */
  assert.equal(canalesDeCombinacion(null), null)
  assert.deepEqual(canalesDeCombinacion('ninguno'), [])
  assert.equal(combinacionDe(null), null)
  assert.equal(combinacionDe([]), 'ninguno')
})

test('el orden en que se guardaron los canales no cambia la opción', () => {
  // Postgres devuelve el arreglo como se guardó, y ['sms','email'] es la misma
  // combinación que ['email','sms'].
  assert.equal(combinacionDe(['sms', 'email']), 'email+sms')
  assert.equal(combinacionDe(['email', 'sms']), 'email+sms')
})

test('la opción de desactivar dice de quién es la decisión', () => {
  // Es la excepción a "se le avisa a todos", no una opción más de la lista.
  const ninguno = COMBINACIONES_FACTURA.find((c) => c.valor === 'ninguno')
  assert.match(ninguno.titulo, /lo pidió el abonado/i)
  assert.equal(
    COMBINACIONES_FACTURA[COMBINACIONES_FACTURA.length - 1].valor,
    'ninguno',
    'va última: no se elige por error',
  )
})

// --- La pantalla de aviso ---------------------------------------------------

test('la pantalla se describe como un rango, no como un día', () => {
  /**
   * No es un mensaje que se manda una vez: es un estado que dura hasta el
   * vencimiento. "El día 2 antes de vencer" haría pensar que se ve una sola vez
   * y que si ese día no abrió el navegador, se lo perdió.
   */
  for (const o of OPCIONES_PANTALLA) {
    if (o.valor === '') continue
    assert.match(o.titulo, /^Desde /, `"${o.titulo}" tiene que decir desde cuándo`)
  }
})

test('se puede elegir no mostrarle nada antes del corte', () => {
  assert.equal(OPCIONES_PANTALLA[0].valor, '')
  assert.match(OPCIONES_PANTALLA[0].titulo, /antes del corte/)
})

test('la pantalla nunca se ofrece después del vencimiento', () => {
  // Pasado el vencimiento el abonado ya está por cortarse o cortado, y ahí le
  // toca la otra página. Ofrecer "3 días después" sería ofrecer nada.
  for (const o of OPCIONES_PANTALLA) {
    if (o.valor === '') continue
    assert.ok(Number(o.valor) <= 0, `${o.titulo} cae después de vencer`)
  }
})
