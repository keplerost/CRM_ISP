import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decidirFacturacion,
  periodoDe,
  repartirImpuesto,
  fechaLocal,
} from '../src/services/facturacionMensual.js'

/**
 * La generación mensual crea cobros. Un error acá no se ve hasta que el abonado
 * llama porque le facturaron de más, un mes que no usó, o dos veces el mismo.
 */

// --- Impuesto ---------------------------------------------------------------

test('con impuesto incluido el precio no cambia y el IVA se desglosa', () => {
  // El abonado paga 34.50; de ahí salen 30 de base y 4.50 de IVA.
  const r = repartirImpuesto(34.5, 'incluido')

  assert.equal(r.total, 34.5)
  assert.equal(r.subtotal, 30)
  assert.equal(r.impuesto, 4.5)
})

test('con "más impuestos" el IVA se suma al precio', () => {
  const r = repartirImpuesto(30, 'mas')

  assert.equal(r.subtotal, 30)
  assert.equal(r.impuesto, 4.5)
  assert.equal(r.total, 34.5)
})

test('sin impuesto el total es el precio', () => {
  const r = repartirImpuesto(20, 'ninguno')

  assert.equal(r.total, 20)
  assert.equal(r.impuesto, 0)
})

test('el total siempre es subtotal + impuesto', () => {
  // Es la propiedad que hace que la factura cierre. Con precios que no dividen
  // exacto, el redondeo tiene que caer del lado correcto.
  for (const precio of [17.39, 25.7, 22.2, 0.99, 105.55]) {
    for (const tipo of ['incluido', 'mas', 'ninguno']) {
      const r = repartirImpuesto(precio, tipo)
      assert.equal(
        Math.round((r.subtotal + r.impuesto) * 100) / 100,
        r.total,
        `${precio} con ${tipo}`,
      )
    }
  }
})

// --- Período ----------------------------------------------------------------

test('el prepago cubre el mes en curso y el postpago el anterior', () => {
  const enAgosto = new Date(2026, 7, 5, 12)

  assert.deepEqual(periodoDe('prepago', enAgosto), {
    desde: '2026-08-01',
    hasta: '2026-08-31',
  })
  assert.deepEqual(periodoDe('postpago', enAgosto), {
    desde: '2026-07-01',
    hasta: '2026-07-31',
  })
})

test('el período cruza bien el fin de año y febrero', () => {
  assert.deepEqual(periodoDe('postpago', new Date(2026, 0, 3, 12)), {
    desde: '2025-12-01',
    hasta: '2025-12-31',
  })
  assert.equal(periodoDe('prepago', new Date(2028, 1, 10, 12)).hasta, '2028-02-29')
})

// --- A quién se factura -----------------------------------------------------

const CLIENTE = {
  id: 'c1',
  nombre: 'JUAN PÉREZ',
  estado: 'activo',
  precio_mensual: 34.5,
  dia_facturacion: 5,
  dia_generar_factura: 1,
  modalidad_pago: 'prepago',
  tipo_impuesto: 'incluido',
  plan: 'PLAN_30M',
}

const elPrimero = new Date(2026, 7, 1, 12)

test('se factura a quien le toca ese día', () => {
  const { facturar } = decidirFacturacion([CLIENTE], elPrimero)

  assert.equal(facturar.length, 1)
  assert.equal(facturar[0].total, 34.5)
  assert.equal(facturar[0].vencimiento, '2026-08-05', 'vence en su día de pago')
  assert.equal(facturar[0].periodo.desde, '2026-08-01')
})

test('no se factura a quien le toca otro día', () => {
  const { facturar } = decidirFacturacion([CLIENTE], new Date(2026, 7, 2, 12))
  assert.equal(facturar.length, 0)
})

// --- El impuesto sale del plan y la ficha puede desviarse ---------------------

test('sin impuesto en la ficha se usa el del plan', () => {
  // El plan es de dónde viene la venta: si se vende "más IVA", eso vale para
  // todos los que lo tienen sin que nadie tenga que ponérselo uno por uno.
  const sinFicha = {
    ...CLIENTE,
    precio_mensual: 100,
    tipo_impuesto: null,
    plan_tipo_impuesto: 'mas',
    plan_iva_porcentaje: 15,
  }
  const { facturar } = decidirFacturacion([sinFicha], elPrimero)

  assert.equal(facturar[0].subtotal, 100)
  assert.equal(facturar[0].impuesto, 15)
  assert.equal(facturar[0].total, 115, 'al precio de lista se le suma el IVA')
})

test('el impuesto de la ficha manda sobre el del plan', () => {
  // Hay abonados exentos y no por eso se les cambia el plan.
  const exento = {
    ...CLIENTE,
    precio_mensual: 100,
    tipo_impuesto: 'ninguno',
    plan_tipo_impuesto: 'mas',
    plan_iva_porcentaje: 15,
  }
  const { facturar } = decidirFacturacion([exento], elPrimero)

  assert.equal(facturar[0].impuesto, 0)
  assert.equal(facturar[0].total, 100)
})

test('sin nada cargado se factura con IVA incluido, como siempre', () => {
  // Es el comportamiento que había antes de que el plan tuviera impuesto: no
  // cambia ninguna factura existente.
  const pelado = { ...CLIENTE, precio_mensual: 115, tipo_impuesto: null }
  const { facturar } = decidirFacturacion([pelado], elPrimero)

  assert.equal(facturar[0].total, 115)
  assert.equal(facturar[0].subtotal, 100, 'el IVA se desglosa hacia atrás')
})

test('la tarifa del plan se respeta', () => {
  const cinco = {
    ...CLIENTE,
    precio_mensual: 100,
    tipo_impuesto: 'mas',
    plan_iva_porcentaje: 5,
  }
  const { facturar } = decidirFacturacion([cinco], elPrimero)

  assert.equal(facturar[0].impuesto, 5)
  assert.equal(facturar[0].total, 105)
})

test('sin día de generación se usa el día de pago', () => {
  const sinDia = { ...CLIENTE, dia_generar_factura: null }

  assert.equal(decidirFacturacion([sinDia], elPrimero).facturar.length, 0)
  assert.equal(decidirFacturacion([sinDia], new Date(2026, 7, 5, 12)).facturar.length, 1)
})

test('un cliente de baja no se factura', () => {
  const { facturar, omitidos } = decidirFacturacion(
    [{ ...CLIENTE, estado: 'baja' }],
    elPrimero,
  )

  assert.equal(facturar.length, 0)
  assert.match(omitidos[0].motivo, /baja/)
})

test('un cortado sí se factura: sigue debiendo el mes', () => {
  // Cortar por mora no cancela el servicio; la deuda sigue corriendo hasta que
  // se lo da de baja.
  const { facturar } = decidirFacturacion([{ ...CLIENTE, estado: 'cortado' }], elPrimero)
  assert.equal(facturar.length, 1)
})

test('sin precio no se factura: cobrar $0 no sirve a nadie', () => {
  const { facturar, omitidos } = decidirFacturacion(
    [{ ...CLIENTE, precio_mensual: null, plan_precio: null }],
    elPrimero,
  )

  assert.equal(facturar.length, 0)
  assert.match(omitidos[0].motivo, /precio/)
})

test('sin día configurado queda listado, no se factura en silencio', () => {
  const { facturar, omitidos } = decidirFacturacion(
    [{ ...CLIENTE, dia_generar_factura: null, dia_facturacion: null }],
    elPrimero,
  )

  assert.equal(facturar.length, 0)
  assert.match(omitidos[0].motivo, /día de facturación/)
})

test('el precio del plan se usa cuando el abonado no tiene uno pactado', () => {
  const { facturar } = decidirFacturacion(
    [{ ...CLIENTE, precio_mensual: null, plan_precio: 25 }],
    elPrimero,
  )

  assert.equal(facturar[0].total, 25)
})

test('la fecha es la local, no la del huso UTC', () => {
  // A las 21:00 en Ecuador ya es el día siguiente en UTC: con toISOString, la
  // corrida de la noche facturaría con la fecha de mañana.
  assert.equal(fechaLocal(new Date(2026, 7, 31, 21, 30)), '2026-08-31')
})
