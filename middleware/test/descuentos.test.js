import test from 'node:test'
import assert from 'node:assert/strict'

import { descuentoDe, repartirImpuesto, decidirFacturacion } from '../src/services/facturacionMensual.js'

/**
 * Los descuentos tienen consecuencias legales en las dos direcciones: no
 * aplicárselo a quien tiene derecho es ilegal, y regalarlo de por vida a quien
 * contrató una promoción de tres meses es plata que no vuelve.
 */

const BASE = { descuento_tipo: null, promo_porcentaje: null, promo_meses: null, promo_desde: null }

test('el descuento de ley no vence', () => {
  const abuelo = { ...BASE, descuento_tipo: 'tercera_edad', descuento_porcentaje: 50 }

  for (const fecha of ['2026-01-01', '2030-06-15', '2045-12-31']) {
    const d = descuentoDe(abuelo, new Date(`${fecha}T12:00:00`))
    assert.equal(d.porcentaje, 50, `debería seguir vigente en ${fecha}`)
    assert.equal(d.ley, true)
  }

  assert.match(descuentoDe(abuelo).motivo, /tercera edad 50%/i)
})

test('discapacidad admite un porcentaje distinto al de la norma', () => {
  // Puede escalonarse según el grado: el campo existe para eso.
  const d = descuentoDe({ ...BASE, descuento_tipo: 'discapacidad', descuento_porcentaje: 30 })
  assert.equal(d.porcentaje, 30)
  assert.match(d.motivo, /discapacidad 30%/i)
})

test('sin porcentaje cargado, el de ley es el 50 de la norma', () => {
  const d = descuentoDe({ ...BASE, descuento_tipo: 'tercera_edad' })
  assert.equal(d.porcentaje, 50)
})

test('la promoción corre los meses pactados y después se apaga sola', () => {
  const promo = { ...BASE, promo_porcentaje: 40, promo_meses: 3, promo_desde: '2026-09-01' }

  // Los tres meses de la oferta.
  for (const mes of ['2026-09-01', '2026-10-01', '2026-11-01']) {
    assert.equal(descuentoDe(promo, new Date(`${mes}T12:00:00`)).porcentaje, 40, mes)
  }

  // El cuarto ya es precio de lista, sin que nadie tenga que acordarse.
  const despues = descuentoDe(promo, new Date('2026-12-01T12:00:00'))
  assert.equal(despues.porcentaje, 0)
  assert.equal(despues.promoVencida, true)
})

test('el descuento de ley manda sobre la promoción, no se acumulan', () => {
  const d = descuentoDe({
    descuento_tipo: 'tercera_edad',
    descuento_porcentaje: 50,
    promo_porcentaje: 40,
    promo_meses: 12,
    promo_desde: '2026-01-01',
  })

  assert.equal(d.porcentaje, 50, 'el de ley, no 40 ni 90')
  assert.equal(d.ley, true)
})

test('una promoción sin fecha de inicio no descuenta nada', () => {
  // Si corriera desde siempre, sería un descuento permanente disfrazado.
  assert.equal(descuentoDe({ ...BASE, promo_porcentaje: 50, promo_meses: 6 }).porcentaje, 0)
})

test('el reparto deja el papel cuadrado: subtotal − descuento + impuesto = total', () => {
  const r = repartirImpuesto(34.5, 'incluido', 15, { descuentoPct: 50 })

  assert.equal(r.subtotal, 30, 'la base completa, antes de descontar')
  assert.equal(r.descuento, 15)
  assert.equal(r.impuesto, 2.25, 'el IVA va sobre los $15 que quedan')
  assert.equal(r.total, 17.25)
  assert.equal(Math.round((r.subtotal - r.descuento + r.impuesto) * 100) / 100, r.total)
})

test('sin descuento, el reparto da lo mismo que antes', () => {
  assert.deepEqual(repartirImpuesto(34.5, 'incluido', 15), {
    subtotal: 30,
    descuento: 0,
    impuesto: 4.5,
    total: 34.5,
  })
  assert.deepEqual(repartirImpuesto(30, 'mas', 15), {
    subtotal: 30,
    descuento: 0,
    impuesto: 4.5,
    total: 34.5,
  })
})

test('con impuesto sumado, el descuento se calcula sobre el precio y el IVA sobre lo que queda', () => {
  const r = repartirImpuesto(30, 'mas', 15, { descuentoPct: 50 })
  assert.equal(r.subtotal, 30)
  assert.equal(r.descuento, 15)
  assert.equal(r.impuesto, 2.25)
  assert.equal(r.total, 17.25)
})

test('exento con descuento no inventa impuesto', () => {
  const r = repartirImpuesto(20, 'ninguno', 15, { descuentoPct: 25 })
  assert.equal(r.impuesto, 0)
  assert.equal(r.total, 15)
})

test('la generación mensual factura con el descuento y dice por qué', () => {
  const clientes = [
    {
      id: 'a',
      nombre: 'ADULTO MAYOR',
      estado: 'activo',
      precio_mensual: 34.5,
      tipo_impuesto: 'incluido',
      dia_generar_factura: 1,
      dia_facturacion: 5,
      descuento_tipo: 'tercera_edad',
      descuento_porcentaje: 50,
    },
    {
      id: 'b',
      nombre: 'CON PROMO VIGENTE',
      estado: 'activo',
      precio_mensual: 34.5,
      tipo_impuesto: 'incluido',
      dia_generar_factura: 1,
      dia_facturacion: 5,
      promo_porcentaje: 20,
      promo_meses: 6,
      promo_desde: '2026-08-01',
    },
    {
      id: 'c',
      nombre: 'PROMO VENCIDA',
      estado: 'activo',
      precio_mensual: 34.5,
      tipo_impuesto: 'incluido',
      dia_generar_factura: 1,
      dia_facturacion: 5,
      promo_porcentaje: 20,
      promo_meses: 2,
      promo_desde: '2026-08-01',
    },
  ]

  const { facturar } = decidirFacturacion(clientes, new Date('2026-11-01T12:00:00'))
  const por = Object.fromEntries(facturar.map((f) => [f.cliente.id, f]))

  assert.equal(por.a.total, 17.25)
  assert.match(por.a.descuento_motivo, /tercera edad/i)

  assert.equal(por.b.total, 27.6, '34.50 menos el 20%')
  assert.match(por.b.descuento_motivo, /Promoci/i)

  assert.equal(por.c.total, 34.5, 'la promoción venció: precio de lista')
  assert.equal(por.c.descuento, 0)
  assert.equal(por.c.descuento_motivo, null)
})
