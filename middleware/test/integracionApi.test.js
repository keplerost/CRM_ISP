import test from 'node:test'
import assert from 'node:assert/strict'

import { mensajeDeComprobante, normalizarPago } from '../src/services/integracion.js'
import { generarLlave } from '../src/lib/apiKey.js'

/**
 * La puerta por la que entra el CRM.
 *
 * Del otro lado hay un programa de otra empresa, escrito contra un documento y
 * desplegado cuando ellos pueden. Todo lo que este archivo prueba es lo mismo:
 * que un malentendido de ese lado no se convierta en plata mal contada del
 * nuestro.
 */

const HOY = '2026-08-19'

// --- El monto ---------------------------------------------------------------

test('un pago normal pasa y queda redondeado a centavos', () => {
  const r = normalizarPago({ monto: 25.004, forma_pago: 'transferencia' }, HOY)

  assert.equal(r.monto, 25)
  assert.equal(r.forma_pago, 'transferencia')
  // Sin fecha, la de hoy: es lo que el bot va a mandar la mayoría de las veces.
  assert.equal(r.fecha_pago, HOY)
})

test('un monto en cero o negativo no es un cobro', () => {
  assert.throws(() => normalizarPago({ monto: 0 }, HOY), /mayor que cero/)
  assert.throws(() => normalizarPago({ monto: -10 }, HOY), /mayor que cero/)
})

test('un monto que no es número se rechaza en vez de guardarse como NaN', () => {
  // El CRM manda strings: "25.00" tiene que entrar, "veinticinco" no.
  assert.equal(normalizarPago({ monto: '25.00' }, HOY).monto, 25)
  assert.throws(() => normalizarPago({ monto: 'veinticinco' }, HOY), /mayor que cero/)
  assert.throws(() => normalizarPago({ monto: null }, HOY), /mayor que cero/)
})

test('el cero de más se frena', () => {
  // Un pago de $250 tecleado como $250000. Existe el pago grande de verdad,
  // pero ese se carga a mano y con alguien mirando.
  assert.throws(() => normalizarPago({ monto: 250000 }, HOY), /demasiado alto/)
})

// --- La forma de pago -------------------------------------------------------

test('la forma de pago se acepta en cualquier caja', () => {
  assert.equal(normalizarPago({ monto: 10, forma_pago: 'EFECTIVO' }, HOY).forma_pago, 'efectivo')
})

test('una forma de pago inventada se rechaza diciendo cuáles valen', () => {
  // Sin la lista en el mensaje, el proveedor tiene que preguntar por chat.
  assert.throws(
    () => normalizarPago({ monto: 10, forma_pago: 'paypal' }, HOY),
    (err) => /paypal/.test(err.message) && /transferencia/.test(err.hint),
  )
})

test('sin forma de pago se asume transferencia', () => {
  // Es lo que manda un bot de WhatsApp: el abonado sube la captura del banco.
  assert.equal(normalizarPago({ monto: 10 }, HOY).forma_pago, 'transferencia')
})

// --- La fecha ---------------------------------------------------------------

test('una fecha pasada se acepta: el abonado pagó el viernes y avisa el lunes', () => {
  assert.equal(normalizarPago({ monto: 10, fecha_pago: '2026-08-15' }, HOY).fecha_pago, '2026-08-15')
})

test('una fecha futura no entra', () => {
  // Metería en el cierre de caja de hoy un cobro que "ocurre" pasado mañana.
  assert.throws(() => normalizarPago({ monto: 10, fecha_pago: '2026-08-25' }, HOY), /futura/)
})

test('una fecha con hora se recorta al día', () => {
  const r = normalizarPago({ monto: 10, fecha_pago: '2026-08-15T14:33:00Z' }, HOY)
  assert.equal(r.fecha_pago, '2026-08-15')
})

test('una fecha con formato de otro país se rechaza en vez de interpretarse', () => {
  /**
   * El caso venenoso es `01/02/2026`: es válido leído como 1 de febrero y como
   * 2 de enero, y JavaScript elige el segundo sin avisar. Se registraría el
   * cobro con un mes corrido y nadie lo notaría hasta que la caja no cierre.
   *
   * Por eso la fecha tiene que empezar por el año, siempre.
   */
  for (const mala of ['15/08/2026', '08/15/2026', '01/02/2026', 'ayer']) {
    assert.throws(
      () => normalizarPago({ monto: 10, fecha_pago: mala }, HOY),
      (err) => /no se entiende/.test(err.message) && /AAAA-MM-DD/.test(err.hint),
      `deberia rechazar ${mala}`,
    )
  }
})

test('acepta la fecha con hora que manda el CRM, y se queda con el día', () => {
  // "2026-08-17 05:00:00" sin zona es hora local de quien lo mandó: el día es
  // el que dice, sin reinterpretarlo.
  assert.equal(normalizarPago({ monto: 10, fecha_pago: '2026-08-17 05:00:00' }, HOY).fecha_pago, '2026-08-17')
  assert.equal(normalizarPago({ monto: 10, fecha: '2026-08-17T05:00:00' }, HOY).fecha_pago, '2026-08-17')
  assert.equal(
    normalizarPago({ monto: 10, fecha_transaccion: '2026-08-17' }, HOY).fecha_pago,
    '2026-08-17',
  )
})

test('los rieles del CRM se traducen a formas de pago contables', () => {
  /**
   * `spi` y `app` no existen para ARCOTEL ni para la conciliación: ahí solo hay
   * efectivo, transferencia, depósito y tarjeta. El riel igual no se pierde,
   * queda en `origen`.
   */
  assert.equal(normalizarPago({ monto: 10, forma_pago: 'app' }, HOY).forma_pago, 'transferencia')
  assert.equal(normalizarPago({ monto: 10, forma_pago: 'spi' }, HOY).forma_pago, 'transferencia')
  assert.equal(normalizarPago({ monto: 10, forma_pago: 'deuna' }, HOY).forma_pago, 'transferencia')
  assert.equal(normalizarPago({ monto: 10, forma_pago: 'cnb' }, HOY).forma_pago, 'deposito')
  assert.equal(normalizarPago({ monto: 10, forma_pago: 'unknown' }, HOY).forma_pago, 'otro')

  assert.equal(normalizarPago({ monto: 10, forma_pago: 'cnb' }, HOY).origen, 'CNB')
})

test('la evidencia del comprobante se conserva', () => {
  // Banco y depositante son lo que se cruza contra el extracto. Perderlos
  // convierte la bandeja de verificación en una búsqueda a ciegas.
  const r = normalizarPago(
    {
      monto: 10,
      banco_origen: 'Banco Pichincha',
      depositante: 'JOSE PEREZ',
      hash_qr: '9aa587037b5c',
      uuid_transaccion: '65702911-c699',
      num_comprobante: '92947292',
      verificado_por: 'ocr_only',
    },
    HOY,
  )

  assert.equal(r.banco_origen, 'Banco Pichincha')
  assert.equal(r.depositante, 'JOSE PEREZ')
  assert.equal(r.hash_qr, '9aa587037b5c')
  assert.equal(r.uuid_transaccion, '65702911-c699')
  // El CRM lo llama `num_comprobante`; adentro es `n_transaccion`.
  assert.equal(r.n_transaccion, '92947292')
  /**
   * El CRM lo manda como `verificado_por` y adentro se llama
   * `metodo_verificacion`: `pagos_reportados.verificado_por` ya existía como
   * UUID —la PERSONA que verificó— desde la migración 173. Reusar el nombre
   * hacía fallar la migración con "invalid input syntax for type uuid".
   */
  assert.equal(r.metodo_verificacion, 'ocr_only')
  assert.equal(r.verificado_por, undefined)
})

test('qr_validado es un método válido y distinto de ocr_only', () => {
  /**
   * El QR del comprobante del Pichincha trae los datos de la transferencia.
   * Si el texto impreso no coincide con el QR, la imagen fue editada — retocar
   * el texto visible no cambia el QR.
   *
   * Meterlo en `ocr_only` subestima lo comprobado; meterlo en `bank_api`
   * afirmaría que se consultó al banco, y no se lo consultó. Seis meses
   * después, la respuesta a "¿por qué se acreditó esto solo?" tiene que decir
   * la verdad de lo que se verificó.
   */
  assert.equal(normalizarPago({ monto: 10, verificado_por: 'qr_validado' }, HOY).metodo_verificacion, 'qr_validado')
  assert.equal(normalizarPago({ monto: 10, verificado_por: 'QR_VALIDADO' }, HOY).metodo_verificacion, 'qr_validado')
})

test('un verificado_por inventado no pasa', () => {
  // Es el campo que decide si un pago se acredita solo. Un valor desconocido
  // que se ignorara en silencio dejaría pasar el pago como si fuera confiable.
  assert.throws(
    () => normalizarPago({ monto: 10, verificado_por: 'confio' }, HOY),
    /verificado_por desconocido/,
  )
  // Y el mensaje dice cuáles sí valen, para no tener que preguntar por chat.
  assert.throws(
    () => normalizarPago({ monto: 10, verificado_por: 'confio' }, HOY),
    (err) => /qr_validado/.test(err.hint),
  )
})

// --- La referencia y los textos ---------------------------------------------

test('la referencia externa se conserva: es lo que evita el pago duplicado', () => {
  const r = normalizarPago({ monto: 10, referencia_externa: '  wa-000431  ' }, HOY)
  assert.equal(r.referencia_externa, 'wa-000431')
})

test('sin referencia se guarda null y no la cadena vacía', () => {
  // El índice único es parcial (WHERE referencia_externa IS NOT NULL). Con
  // cadenas vacías, el segundo pago sin referencia chocaría contra el primero.
  assert.equal(normalizarPago({ monto: 10 }, HOY).referencia_externa, null)
  assert.equal(normalizarPago({ monto: 10, referencia_externa: '   ' }, HOY).referencia_externa, null)
})

test('los textos largos se recortan al límite de la columna', () => {
  const r = normalizarPago(
    { monto: 10, n_transaccion: '9'.repeat(200), notas: 'x'.repeat(5000) },
    HOY,
  )
  // Si no se recortaran, el insert fallaría y el CRM recibiría un 502 por un
  // campo que no le importa a nadie.
  assert.equal(r.n_transaccion.length, 60)
  assert.equal(r.notas.length, 1000)
})

// --- Las llaves -------------------------------------------------------------

test('cada llave emitida es distinta', () => {
  const a = generarLlave()
  const b = generarLlave()

  assert.notEqual(a.llave, b.llave)
  assert.notEqual(a.huella, b.huella)
})

test('la llave lleva el prefijo con el que se la reconoce en un log', () => {
  const { llave, prefijo } = generarLlave()

  assert.ok(llave.startsWith('sk_'))
  assert.equal(prefijo, llave.slice(0, 12))
  // Larga en serio: es lo único que separa a cualquiera de la deuda de todos
  // los abonados.
  assert.ok(llave.length > 40)
})

test('de la huella no se saca la llave', () => {
  // Es todo lo que se guarda en la base. Si la contuviera, un volcado de
  // `api_llaves` sería un llavero.
  const { llave, huella } = generarLlave()

  assert.equal(huella.length, 64)
  assert.ok(!huella.includes(llave.slice(3)))
})

// --- El comprobante ya registrado -------------------------------------------

test('un comprobante de OTRO abonado no dice de quién es', () => {
  /**
   * Es el caso del que reenvía el comprobante del vecino. Decirle "ya lo usó
   * María Pérez" le confirma un dato de otra persona que no tenía — y encima se
   * lo confirma el propio ISP.
   *
   * El mensaje avisa que está tomado y nada más. El detalle completo lo ve el
   * ISP en su bandeja.
   */
  const m = mensajeDeComprobante('pendiente', false)

  assert.match(m, /otro abonado/)
  assert.ok(!/[A-ZÁÉÍÓÚÑ]{2,}\s+[A-ZÁÉÍÓÚÑ]{2,}/.test(m), 'no debería incluir un nombre')
})

test('el mensaje distingue acreditado de en revisión', () => {
  // "Ya se acreditó" sobre algo que todavía está en revisión es la promesa que
  // genera el reclamo del día siguiente.
  assert.match(mensajeDeComprobante('confirmado', true), /acreditado/)
  assert.match(mensajeDeComprobante('pendiente', true), /validando/)
})

test('un comprobante rechazado invita a mandar otra foto', () => {
  // Rechazado no es "ya está": es "no se pudo leer". Cerrarle la puerta al
  // abonado ahí lo deja sin forma de acreditar un pago que sí hizo.
  const m = mensajeDeComprobante('rechazado', true)
  assert.match(m, /no se pudo validar/)
  assert.match(m, /foto más clara/)
})

test('una coincidencia por número de comprobante se dice con menos certeza', () => {
  /**
   * `num_comprobante` no es único en el mundo real: dos bancos distintos pueden
   * emitir el mismo número. Afirmar "este comprobante ya lo recibimos" sobre esa
   * base puede estar rechazando un pago legítimo.
   */
  const exacta = mensajeDeComprobante('pendiente', null, true)
  const floja = mensajeDeComprobante('pendiente', null, false)

  assert.notEqual(exacta, floja)
  assert.match(floja, /ese número de comprobante/)
})

test('sin saber de quién es, no se afirma que sea de otro', () => {
  // `null` es "no se preguntó por ningún abonado". Tratarlo como `false`
  // acusaría de reenviar el comprobante ajeno a quien mandó el suyo.
  assert.ok(!/otro abonado/.test(mensajeDeComprobante('pendiente', null)))
})
