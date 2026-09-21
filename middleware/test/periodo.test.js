import test from 'node:test'
import assert from 'node:assert/strict'

import {
  periodoMensual,
  renderPlantilla,
  infoAdicionalDeFactura,
  partirEnCampos,
  fechaCorta,
  fechaLarga,
  MAX_CAMPO,
  PLANTILLA_POR_DEFECTO,
} from '../src/sri/periodo.js'

/**
 * El SRI devuelve el comprobante entero —"ARCHIVO NO CUMPLE ESTRUCTURA XML"— si
 * un campoAdicional pasa de 300 caracteres, y para entonces el secuencial ya se
 * consumió. El texto de reclamos que exige ARCOTEL no entra en uno solo.
 */

test('un texto corto queda en un solo campo', () => {
  assert.deepEqual(partirEnCampos('Descripción', 'Periodo del 1/Jul./2026'), [
    { nombre: 'Descripción', valor: 'Periodo del 1/Jul./2026' },
  ])
})

test('el texto por defecto se parte en campos que el SRI acepta', () => {
  const campos = partirEnCampos('Descripción', PLANTILLA_POR_DEFECTO)

  assert.ok(campos.length > 1, 'no entra en un solo campo')
  for (const c of campos) assert.ok(c.valor.length <= MAX_CAMPO, `${c.nombre} mide ${c.valor.length}`)

  // Numerados a partir del segundo, para poder distinguirlos leyendo el XML.
  assert.equal(campos[0].nombre, 'Descripción')
  assert.equal(campos[1].nombre, 'Descripción 2')
})

test('al reunir las partes vuelve el texto original', () => {
  const texto = PLANTILLA_POR_DEFECTO
  const reunido = partirEnCampos('Descripción', texto)
    .map((c) => c.valor)
    .join(' ')

  assert.equal(reunido, texto.trim())
})

test('se corta por palabras, no a la mitad de una', () => {
  const texto = `${'palabra '.repeat(60)}final`
  for (const c of partirEnCampos('D', texto)) {
    for (const palabra of c.valor.split(' ')) {
      assert.ok(['palabra', 'final'].includes(palabra), `quedó partida: "${palabra}"`)
    }
  }
})

test('una palabra más larga que el límite se parte igual', () => {
  // Preferible un corte feo a un campo que invalida el comprobante entero.
  const campos = partirEnCampos('D', 'x'.repeat(700))

  assert.equal(campos.length, 3)
  for (const c of campos) assert.ok(c.valor.length <= MAX_CAMPO)
})

test('un texto vacío no genera campos', () => {
  assert.deepEqual(partirEnCampos('D', ''), [])
  assert.deepEqual(partirEnCampos('D', null), [])
})

/**
 * El período de la factura cambia todos los meses. Si se calcula mal, cada
 * abonado recibe un comprobante que dice cubrir un mes equivocado — y eso es un
 * problema con el cliente y con el organismo de control, no un detalle estético.
 */

test('el formato corto es el del detalle del período', () => {
  assert.equal(fechaCorta('2026-07-01'), '1/Jul./2026')
  assert.equal(fechaCorta('2026-07-31'), '31/Jul./2026')
  assert.equal(fechaCorta('2026-01-05'), '5/Ene./2026')
  assert.equal(fechaCorta('2026-12-25'), '25/Dic./2026')
})

test('el formato largo es el de la fecha máxima de pago', () => {
  assert.equal(fechaLarga('2026-07-06'), '6 de Julio de 2026')
  assert.equal(fechaLarga('2026-09-01'), '1 de Septiembre de 2026')
})

test('el período va del primero al último día del mes', () => {
  const p = periodoMensual('2026-07-26')
  assert.equal(p.desdeIso, '2026-07-01')
  assert.equal(p.hastaIso, '2026-07-31')
  assert.equal(p.desdeCorta, '1/Jul./2026')
  assert.equal(p.hastaCorta, '31/Jul./2026')
})

test('resuelve bien los meses de 30 días', () => {
  const p = periodoMensual('2026-06-15')
  assert.equal(p.hastaIso, '2026-06-30')
})

test('resuelve febrero, incluido el bisiesto', () => {
  assert.equal(periodoMensual('2026-02-10').hastaIso, '2026-02-28')
  // 2028 es bisiesto.
  assert.equal(periodoMensual('2028-02-10').hastaIso, '2028-02-29')
})

test('el período cruza bien el fin de año', () => {
  const p = periodoMensual('2026-12-20')
  assert.equal(p.desdeIso, '2026-12-01')
  assert.equal(p.hastaIso, '2026-12-31')
  assert.equal(p.mes, 'Diciembre')
})

test('con desplazamiento negativo factura el mes anterior', () => {
  // Facturación vencida: en agosto se cobra julio.
  const p = periodoMensual('2026-08-05', { mesesDesplazado: -1 })
  assert.equal(p.desdeIso, '2026-07-01')
  assert.equal(p.hastaIso, '2026-07-31')
})

test('desplazar hacia atrás en enero cae en diciembre del año anterior', () => {
  const p = periodoMensual('2026-01-05', { mesesDesplazado: -1 })
  assert.equal(p.desdeIso, '2025-12-01')
  assert.equal(p.hastaIso, '2025-12-31')
})

test('la fecha máxima de pago usa el día configurado', () => {
  const p = periodoMensual('2026-07-26', { diaMaximoPago: 6 })
  assert.equal(p.pagoLarga, '6 de Julio de 2026')
})

test('un día de pago que no existe en el mes se ajusta al último', () => {
  // 31 en un mes de 30 días no puede quedar como fecha inválida.
  const p = periodoMensual('2026-06-10', { diaMaximoPago: 31 })
  assert.equal(p.fechaMaximaPago.getDate(), 30)
})

// --- Plantilla --------------------------------------------------------------

test('reemplaza las variables', () => {
  assert.equal(
    renderPlantilla('Periodo del {periodo_desde} al {periodo_hasta}', {
      periodo_desde: '1/Jul./2026',
      periodo_hasta: '31/Jul./2026',
    }),
    'Periodo del 1/Jul./2026 al 31/Jul./2026',
  )
})

test('una variable desconocida queda visible en vez de desaparecer', () => {
  // Un hueco silencioso en el PDF pasa desapercibido; las llaves se ven.
  assert.equal(renderPlantilla('Hola {inexistente}', {}), 'Hola {inexistente}')
  assert.equal(renderPlantilla('Hola {vacia}', { vacia: '' }), 'Hola {vacia}')
})

test('la plantilla por defecto produce el texto del ejemplo', () => {
  const { texto } = infoAdicionalDeFactura(PLANTILLA_POR_DEFECTO, {
    fechaEmision: '2026-07-26',
    diaMaximoPago: 6,
    telefono: '0986017616',
  })

  assert.ok(texto.includes('Periodo del 1/Jul./2026 al 31/Jul./2026'))
  assert.ok(texto.includes('Fecha Maxima de pago: 6 de Julio de 2026'))
  assert.ok(texto.includes('Call Center 0986017616'))
  assert.ok(texto.includes('reclamoconsumidor.arcotel.gob.ec'))
  // No debe quedar ninguna variable sin resolver.
  assert.ok(!/\{[a-z_]+\}/.test(texto), `quedaron variables sin reemplazar: ${texto}`)
})

test('el período se actualiza solo mes a mes', () => {
  // Es el punto de tener una plantilla: emitir en otro mes cambia el texto.
  const julio = infoAdicionalDeFactura(PLANTILLA_POR_DEFECTO, {
    fechaEmision: '2026-07-10',
    diaMaximoPago: 6,
  })
  const agosto = infoAdicionalDeFactura(PLANTILLA_POR_DEFECTO, {
    fechaEmision: '2026-08-10',
    diaMaximoPago: 6,
  })

  assert.ok(julio.texto.includes('1/Jul./2026 al 31/Jul./2026'))
  assert.ok(agosto.texto.includes('1/Ago./2026 al 31/Ago./2026'))
  assert.notEqual(julio.texto, agosto.texto)
})

test('admite variables propias del cliente', () => {
  const { texto } = infoAdicionalDeFactura('Estimado {cliente}, su {plan} vence el {fecha_maxima_pago}', {
    fechaEmision: '2026-07-10',
    diaMaximoPago: 6,
    cliente: 'JUAN PÉREZ',
    plan: 'PLAN HOME 150 Mbps',
  })

  assert.equal(texto, 'Estimado JUAN PÉREZ, su PLAN HOME 150 Mbps vence el 6 de Julio de 2026')
})

test('sin plantilla usa la por defecto', () => {
  const { texto } = infoAdicionalDeFactura(null, { fechaEmision: '2026-07-10' })
  assert.ok(texto.includes('Periodo del'))
})
