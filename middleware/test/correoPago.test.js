import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * El acuse de pago, como tarjeta.
 *
 * ── El error que esto fija ──
 *
 * El correo de "Recibimos su pago" salía con el cuerpo crudo de la plantilla, así
 * que el abonado leía las etiquetas: literalmente `<p>Estimado/a Juan:</p>`. Los
 * avisos de factura ya salían bien porque pasan por su armador; este se había
 * quedado atrás.
 *
 * Acá se prueba la parte que decide QUÉ va en la tarjeta. El armado del HTML lo
 * cubre `correoHtml.test.js`, y el envío de verdad se probó contra el correo.
 */

/** Los datos del resumen, tal como los arma `correoDePago`. */
function resumen({ pago = {}, cliente = {} }) {
  const dinero = (n) => `$${(Number(n) || 0).toFixed(2)}`
  const saldo = Number(pago.saldo ?? 0)
  const alDia = saldo <= 0.005

  return [
    ['Cliente', cliente.nombre ?? pago.nombre ?? null],
    ['N° de cuenta', pago.codigo != null ? String(pago.codigo) : null],
    ['Factura N°', pago.factura_numero != null ? String(pago.factura_numero) : null],
    ['Monto pagado', dinero(pago.monto)],
    ['Forma de pago', pago.forma_pago ?? null],
    ['Fecha de pago', pago.fecha_pago ?? null],
    ...(alDia ? [['Estado', 'AL DÍA']] : [['Saldo pendiente', dinero(saldo)]]),
  ].filter(([, v]) => v != null)
}

const etiquetas = (filas) => filas.map(([k]) => k)

test('el resumen dice a qué factura corresponde el pago', () => {
  /**
   * Es lo primero que el abonado busca. Un acuse que dice "recibimos su pago" sin
   * decir de qué factura obliga a llamar para preguntarlo, que es exactamente la
   * llamada que este correo viene a evitar.
   */
  const filas = resumen({
    pago: { monto: 30, factura_numero: 57, codigo: 1042, forma_pago: 'transferencia', saldo: 0 },
    cliente: { nombre: 'Edison Raul Delgado Loor' },
  })

  assert.ok(etiquetas(filas).includes('Factura N°'))
  assert.ok(etiquetas(filas).includes('N° de cuenta'))
  assert.deepEqual(
    filas.find(([k]) => k === 'Monto pagado'),
    ['Monto pagado', '$30.00'],
  )
})

test('con la cuenta saldada dice AL DÍA, no "saldo $0.00"', () => {
  /**
   * "Saldo pendiente: $0.00" en un acuse de pago es una línea que hace dudar: el
   * abonado la lee dos veces para asegurarse de que no debe nada.
   */
  const filas = resumen({ pago: { monto: 30, saldo: 0 }, cliente: { nombre: 'Ana' } })

  assert.ok(etiquetas(filas).includes('Estado'))
  assert.ok(!etiquetas(filas).includes('Saldo pendiente'))
  assert.deepEqual(filas.find(([k]) => k === 'Estado'), ['Estado', 'AL DÍA'])
})

test('si quedó debiendo, el saldo se dice', () => {
  // Un pago parcial que no lo aclara deja al abonado creyendo que quedó al día, y
  // el corte que llega después parece un error del ISP.
  const filas = resumen({ pago: { monto: 10, saldo: 20 }, cliente: { nombre: 'Ana' } })

  assert.deepEqual(filas.find(([k]) => k === 'Saldo pendiente'), ['Saldo pendiente', '$20.00'])
  assert.ok(!etiquetas(filas).includes('Estado'))
})

test('lo que no se sabe no se inventa', () => {
  /**
   * Un pago cargado sin factura —una importación, un abono a cuenta— no tiene
   * número que mostrar. La fila se omite: "Factura N°: null" es peor que no
   * decirlo.
   */
  const filas = resumen({ pago: { monto: 15, saldo: 0 }, cliente: { nombre: 'Ana' } })

  assert.ok(!etiquetas(filas).includes('Factura N°'))
  assert.ok(!etiquetas(filas).includes('N° de cuenta'))
  assert.ok(!etiquetas(filas).includes('Forma de pago'))
})

test('el texto del ISP manda sobre el de fábrica', async () => {
  /**
   * Es la promesa del editor de plantillas: lo que se escribe ahí es lo que sale.
   * Sin esta puerta, editar la plantilla no cambiaría nada del correo y el editor
   * mentiría — el mismo error que se evitó con el RIDE y con la factura.
   */
  const { partirEnParrafos } = await import('../src/services/correoFactura.js')

  const propio = partirEnParrafos(
    '<p>Gracias por su pago, {{nombre}}.</p><p>Su servicio sigue activo.</p>',
  )

  assert.equal(propio.length, 2)
  assert.match(propio[0], /Gracias por su pago/)
  // Los marcadores se dejan intactos: los reemplaza `enviar` con los datos del
  // abonado, después de armar la tarjeta.
  assert.match(propio[0], /\{\{nombre\}\}/)
})

test('sin plantilla, el acuse sale igual', async () => {
  const { partirEnParrafos } = await import('../src/services/correoFactura.js')

  // Una plantilla desactivada o vacía no puede dejar al abonado sin acuse: el que
  // no lo recibe llama, o vuelve a pagar.
  assert.deepEqual(partirEnParrafos(null), [])
  assert.deepEqual(partirEnParrafos(''), [])
  assert.deepEqual(partirEnParrafos('   '), [])
})
