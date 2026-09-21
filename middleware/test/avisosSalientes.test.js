import test from 'node:test'
import assert from 'node:assert/strict'

import { avisarAlAbonado } from '../src/services/avisosSalientes.js'

/**
 * Los avisos que dispara la base: la confirmación de pago y el de corte.
 *
 * Lo que se puede probar sin base ni router es la parte que decide si se manda:
 * el respeto a lo que pidió el abonado, y qué pasa con un tipo de aviso que no
 * existe. El envío en sí se prueba contra el sistema de verdad.
 */

test('el que pidió no recibir avisos tampoco recibe el del corte', async () => {
  /**
   * Es su decisión y vale para todo. Un ISP podría querer que el aviso de corte
   * sea la excepción —"que al menos sepa por qué se quedó sin internet"— y la
   * respuesta es que no: el que pidió silencio pidió silencio, y el corte
   * igual se le explica en la página del navegador y por teléfono.
   */
  const r = await avisarAlAbonado({
    cliente: { id: 'x', nombre: 'NO ME ESCRIBAN', avisos_activos: false, email: 'a@x.com' },
    tipo: 'corte_servicio',
  })

  assert.equal(r.enviado, false)
  assert.match(r.motivo, /pidió no recibir/)
})

test('un tipo de aviso desconocido se dice, no se ignora', async () => {
  // Un error de escritura en el nombre del tipo dejaría el aviso sin mandar y
  // sin rastro. Se contesta con el motivo para que aparezca en el registro.
  const r = await avisarAlAbonado({
    cliente: { id: 'x', nombre: 'ALGUIEN', email: 'a@x.com' },
    tipo: 'saludo_de_cumpleanos',
  })

  assert.equal(r.enviado, false)
  assert.match(r.motivo, /desconocido/)
})

test('nunca lanza: un aviso que falla no puede frenar un corte', async () => {
  /**
   * Quien llama a esto está en medio de otra cosa —cortando abonados, drenando
   * una cola—. Si esta función lanzara, un abonado sin correo haría fallar el
   * corte de los que vienen después en la lista.
   */
  const r = await avisarAlAbonado({ cliente: null, tipo: 'corte_servicio' })
  assert.equal(r.enviado, false)
  assert.ok(r.motivo)
})

test('acepta la fila de una cola, que llama al abonado "cliente_id"', async () => {
  /**
   * ── El error que esta prueba ataja ──
   *
   * Las vistas de cola devuelven `cliente_id` —también traen un `aviso_id`, y
   * dos columnas no pueden llamarse igual— mientras que una ficha devuelve `id`.
   *
   * Pasando la fila tal cual, `enviar` recibía `undefined` y contestaba "No
   * existe ese cliente" sobre un abonado que estaba perfectamente en la base. El
   * mensaje culpaba al dato y el problema era del nombre de una columna.
   */
  const r = await avisarAlAbonado({
    cliente: { cliente_id: 'x', nombre: 'DESDE LA COLA', avisos_activos: false },
    tipo: 'pago_confirmado',
  })

  // Llega hasta la comprobación de las preferencias, que es lo que prueba que
  // reconoció al abonado en vez de rechazarlo por no identificarlo.
  assert.match(r.motivo, /pidió no recibir/)
})

test('un aviso sin abonado lo dice con claridad', () => {
  // "No existe ese cliente" mandaba a buscar el problema al lugar equivocado.
  return avisarAlAbonado({ cliente: { nombre: 'SIN ID' }, tipo: 'pago_confirmado' }).then((r) => {
    assert.equal(r.enviado, false)
    assert.match(r.motivo, /no dice de qué abonado/)
  })
})

test('los seis tipos de aviso tienen sus dos plantillas', async () => {
  /**
   * Un tipo sin plantilla no falla: contesta "tipo desconocido" y el mensaje no
   * sale. Como el disparador que lo encola vive en la base, el aviso quedaría
   * dando vueltas en la cola sin que nadie note que falta un renglón acá.
   */
  for (const tipo of [
    'pago_confirmado', 'corte_servicio', 'bienvenida',
    'ticket_abierto', 'ticket_asignado', 'ticket_respuesta',
  ]) {
    const r = await avisarAlAbonado({
      cliente: { id: 'x', nombre: 'ALGUIEN', avisos_activos: false },
      tipo,
    })
    assert.ok(
      !/desconocido/.test(r.motivo),
      `"${tipo}" no está en la tabla de plantillas del servicio`,
    )
  }
})
