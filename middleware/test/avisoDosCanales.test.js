import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * Cuando el ISP elige dos canales, tienen que salir los dos.
 *
 * ── El error que esto fija ──
 *
 * El aviso de factura mandaba por el PRIMER canal que funcionara y se detenía.
 * Con el canal preferido en WhatsApp y WhatsApp en modo manual, el mensaje
 * "salía" —quedaba pendiente, sin lanzar error— y el correo no se mandaba nunca.
 *
 * El abonado no recibía nada y el sistema informaba "enviado por whatsapp". Lo
 * encontró una prueba de verdad con el correo abierto, no una revisión del
 * código: desde afuera todo parecía funcionar.
 */

/**
 * La regla, tal como la aplica `avisarFacturaNueva`.
 *
 * Se replica acá porque la función real escribe en la base y manda correos. Lo
 * que importa probar es la DECISIÓN, que es donde estaba el error.
 */
const mandaPorTodos = (ficha) =>
  Array.isArray(ficha.aviso_factura_canales) && ficha.aviso_factura_canales.length > 1

test('dos canales elegidos a mano: salen los dos', () => {
  /**
   * La pantalla ofrece las combinaciones de a pares —"Correo + WhatsApp",
   * "Correo + Telegram"— justamente para esto. Mandar por uno solo convierte una
   * elección explícita en una sugerencia.
   */
  assert.equal(mandaPorTodos({ aviso_factura_canales: ['email', 'whatsapp'] }), true)
  assert.equal(mandaPorTodos({ aviso_factura_canales: ['email', 'telegram'] }), true)
  assert.equal(mandaPorTodos({ aviso_factura_canales: ['email', 'sms', 'telegram'] }), true)
})

test('un solo canal elegido: sale por ese y nada más', () => {
  assert.equal(mandaPorTodos({ aviso_factura_canales: ['email'] }), false)
  assert.equal(mandaPorTodos({ aviso_factura_canales: ['whatsapp'] }), false)
})

test('sin configurar: el primero que funcione', () => {
  /**
   * `null` es "avisale por donde puedas". Mandarle el mismo aviso por correo,
   * SMS y Telegram a alguien que no pidió nada es molestarlo tres veces y pagar
   * tres veces.
   */
  assert.equal(mandaPorTodos({ aviso_factura_canales: null }), false)
  assert.equal(mandaPorTodos({}), false)
})

test('lista vacía no es lo mismo que sin configurar', () => {
  /**
   * Una lista vacía es el abonado que pidió que NO le avisen. `canalesDeFactura`
   * devuelve `[]` y no se manda nada — pero eso lo decide antes, no acá.
   */
  assert.equal(mandaPorTodos({ aviso_factura_canales: [] }), false)
})

test('el canal preferido no puede tragarse a los otros', async () => {
  /**
   * El caso exacto que falló: preferido en WhatsApp, elegidos correo Y WhatsApp.
   * `canalesPara` pone el preferido primero —está bien, es su trabajo— y por eso
   * el corte en el primer éxito dejaba el correo sin mandar.
   */
  const { canalesDeFactura } = await import('../src/services/avisoFactura.js')

  const ficha = {
    email: 'abonado@ejemplo.ec',
    telefono_movil: '0999000000',
    canal_preferido: 'whatsapp',
    aviso_factura_canales: ['email', 'whatsapp'],
    avisos_activos: true,
  }

  const canales = canalesDeFactura(ficha)

  assert.ok(canales.includes('email'), 'el correo tiene que estar en la lista')
  assert.ok(canales.includes('whatsapp'), 'y WhatsApp también')
  assert.equal(canales[0], 'whatsapp', 'el preferido va primero, como corresponde')
  // Y por eso hace falta la regla: sin ella, el bucle terminaba en el primero.
  assert.equal(mandaPorTodos(ficha), true, 'con dos elegidos, tienen que salir los dos')
})

test('el que pidió que no lo molesten no recibe nada', async () => {
  const { canalesDeFactura } = await import('../src/services/avisoFactura.js')

  assert.deepEqual(
    canalesDeFactura({
      email: 'abonado@ejemplo.ec',
      avisos_activos: false,
      aviso_factura_canales: ['email', 'whatsapp'],
    }),
    [],
    'el interruptor general manda sobre los canales elegidos',
  )
})

test('un mensaje que queda pendiente no cuenta como enviado', async () => {
  /**
   * ── El error que esto fija ──
   *
   * `enviar` NO lanza cuando WhatsApp está en modo manual: devuelve la fila con
   * estado 'pendiente' y el enlace de wa.me para mandarlo a mano. Eso está bien,
   * es el modo de trabajo del ISP sin proveedor — pero no es una entrega.
   *
   * Los tres avisadores recorrían los canales "hasta el primero que funcione" y
   * los tres tomaban ese 'pendiente' como éxito y cortaban ahí. Con WhatsApp
   * como canal preferido y sin proveedor, el sistema informaba "enviado por
   * whatsapp", el correo no se mandaba nunca, y al abonado no le llegaba nada.
   *
   * Se vio en una corrida de facturación de verdad: tres facturas creadas, las
   * tres con `aviso: whatsapp`, y ni un correo en la casilla.
   */
  const { seEntrego } = await import('../src/services/mensajeria.js')

  assert.equal(seEntrego({ estado: 'enviado' }), true)
  assert.equal(seEntrego({ estado: 'entregado' }), true)

  assert.equal(seEntrego({ estado: 'pendiente' }), false, 'pendiente es "a mano", no "llegó"')
  assert.equal(seEntrego({ estado: 'fallido' }), false)

  // Y sin resultado no se puede afirmar que llegó.
  assert.equal(seEntrego(null), false)
  assert.equal(seEntrego(undefined), false)
})
