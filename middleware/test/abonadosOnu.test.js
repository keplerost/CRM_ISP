import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizarNombre, compararNombres, buscarPersona } from '../src/lib/nombres.js'
import { planificarAbonados } from '../src/services/oltFicha.js'

/**
 * Enlace entre ONTs y abonados.
 *
 * Es la parte del sistema con las consecuencias más caras de todo lo construido:
 * un enlace equivocado hace que la señal de un abonado aparezca en la ficha de
 * otro, que un corte por falta de pago le caiga al vecino y que una factura se
 * emita a nombre de quien no contrató.
 *
 * Por eso la mitad de estos tests verifica que NO se enlace.
 */

describe('normalización de nombres', () => {
  test('los guiones bajos de la OLT valen lo mismo que espacios', () => {
    assert.equal(
      normalizarNombre('HERRERA_GUAMANI_ENMA_BEATRIZ'),
      normalizarNombre('Herrera Guamani Enma Beatriz'),
    )
  })

  test('los acentos no separan a la misma persona', () => {
    assert.equal(normalizarNombre('Herrera Guamaní'), 'HERRERA GUAMANI')
    assert.equal(normalizarNombre('DÍAS OTTO'), 'DIAS OTTO')
  })

  test('la Ñ NO es un acento', () => {
    // "PEÑA" y "PENA" son apellidos distintos y personas distintas. Este test
    // existe porque la descomposición Unicode convierte la Ñ en N + tilde, y el
    // filtro de acentos se la llevaría puesta.
    assert.equal(normalizarNombre('PEÑA LOPEZ'), 'PEÑA LOPEZ')
    assert.notEqual(normalizarNombre('PEÑA LOPEZ'), normalizarNombre('PENA LOPEZ'))
    assert.equal(compararNombres('PEÑA LOPEZ JUAN', 'PENA LOPEZ JUAN'), null)
  })

  test('la Ñ sí se reconoce entre sí, con o sin otros acentos', () => {
    assert.equal(compararNombres('OÑA RIERA JEFFERSON', 'Oña Riera Jefferson'), 'exacto')
  })
})

describe('cuándo dos nombres son la misma persona', () => {
  test('el mismo texto escrito distinto', () => {
    assert.equal(compararNombres('TOAQUIZA_SUATUNCE_LUIS', 'Toaquiza Suatunce Luis'), 'exacto')
  })

  test('las mismas palabras en otro orden', () => {
    // Un sistema guarda "APELLIDO NOMBRE" y el otro "NOMBRE APELLIDO".
    assert.equal(compararNombres('OÑA RIERA JEFFERSON FABIAN', 'JEFFERSON FABIAN OÑA RIERA'), 'orden')
  })

  test('un nombre incompleto NO se enlaza', () => {
    // Caso real del X7: una ONT dice solo "MORALES" y otra "MORALES GUAMAN
    // KLEVER ARNULFO". Pueden ser la misma persona o dos hermanos. Adivinar acá
    // es exactamente el error que no se puede cometer.
    assert.equal(compararNombres('MORALES', 'MORALES GUAMAN KLEVER ARNULFO'), null)
  })

  test('un apellido en común no alcanza', () => {
    assert.equal(compararNombres('MASAPANTA WALTER', 'MASAPANTA JORGE'), null)
  })

  test('un nombre vacío no coincide con nadie', () => {
    assert.equal(compararNombres('', 'MOLINA GARCIA'), null)
    assert.equal(compararNombres(null, 'MOLINA GARCIA'), null)
  })
})

describe('búsqueda entre varios candidatos', () => {
  const gente = [
    { id: 'a', nombre: 'MOLINA GARCIA FULTON ORFAY' },
    { id: 'b', nombre: 'HERRERA GUAMANI ENMA BEATRIZ' },
    { id: 'c', nombre: 'MOLINA GARCIA FULTON ORFAY' },
  ]

  test('un candidato único se devuelve', () => {
    const r = buscarPersona('Herrera Guamaní Enma Beatriz', gente)
    assert.equal(r.candidato.id, 'b')
    assert.equal(r.ambiguo, false)
  })

  test('dos homónimos no se resuelven al azar', () => {
    // En un pueblo hay más homónimos de los que uno cree. Elegir el primero
    // sería correcto la mitad de las veces.
    const r = buscarPersona('MOLINA GARCIA FULTON ORFAY', gente)
    assert.equal(r.ambiguo, true)
    assert.equal(r.candidato, null)
    assert.equal(r.coincidencias.length, 2)
  })

  test('sin coincidencias devuelve nada, no el más parecido', () => {
    assert.equal(buscarPersona('PEREZ JUAN', gente), null)
  })
})

describe('plan de enlace con abonados', () => {
  const onu = (extra = {}) => ({
    id: 'onu-1',
    sn: 'HWTC304D1BB2',
    nombre_cliente: 'HERRERA GUAMANI ENMA BEATRIZ',
    slot: 6,
    puerto: 0,
    onu_index: 1,
    ...extra,
  })

  const cli = (extra = {}) => ({
    id: 'cli-1',
    nombre: 'HERRERA GUAMANI ENMA BEATRIZ',
    onu_id: null,
    ...extra,
  })

  test('enlaza cuando hay un solo abonado con ese nombre', () => {
    const p = planificarAbonados([onu()], [cli()])
    assert.equal(p.enlazar.length, 1)
    assert.equal(p.enlazar[0].cliente.id, 'cli-1')
    assert.equal(p.crear.length, 0)
  })

  test('una ONT ya enlazada no se vuelve a tocar', () => {
    const p = planificarAbonados([onu()], [cli({ onu_id: 'onu-1' })])
    assert.equal(p.yaEnlazadas.length, 1)
    assert.equal(p.enlazar.length, 0)
  })

  test('un abonado que ya tiene otra ONT no se roba', () => {
    // Está enlazado a otra ONT: engancharlo a ésta le sacaría el servicio de la
    // ficha donde estaba bien.
    const p = planificarAbonados([onu()], [cli({ onu_id: 'otra-onu' })])
    assert.equal(p.enlazar.length, 0)
    assert.equal(p.crear.length, 1)
  })

  test('dos ONTs que apuntan al mismo abonado van las dos a revisión', () => {
    // Pasa cuando alguien tiene dos servicios, o cuando una ONT vieja quedó con
    // la descripción del abonado anterior. Enlazar cualquiera es elegir al azar.
    const p = planificarAbonados(
      [onu({ id: 'onu-1', sn: 'A' }), onu({ id: 'onu-2', sn: 'B', onu_index: 2 })],
      [cli()],
    )
    assert.equal(p.enlazar.length, 0)
    assert.equal(p.ambiguas.length, 2)
    assert.match(p.ambiguas[0].motivo, /ONTs distintas/)
  })

  test('sin nombre en la OLT va a creación, no a un enlace inventado', () => {
    const p = planificarAbonados([onu({ nombre_cliente: null })], [cli()])
    assert.equal(p.enlazar.length, 0)
    assert.equal(p.crear.length, 1)
    assert.match(p.crear[0].motivo, /no tiene un nombre/)
  })

  test('sin abonados en la base, todo va a creación', () => {
    // Es el estado real del sistema hoy: 85 ONTs en el equipo y ningún abonado
    // FTTH cargado.
    const onus = Array.from({ length: 5 }, (_, i) =>
      onu({ id: `onu-${i}`, sn: `SN${i}`, onu_index: i, nombre_cliente: `ABONADO ${i}` }),
    )
    const p = planificarAbonados(onus, [])
    assert.equal(p.crear.length, 5)
    assert.equal(p.enlazar.length, 0)
    assert.equal(p.ambiguas.length, 0)
  })

  test('los homónimos de la base van a revisión, no a un enlace', () => {
    const p = planificarAbonados(
      [onu()],
      [cli({ id: 'x' }), cli({ id: 'y' })],
    )
    assert.equal(p.enlazar.length, 0)
    assert.equal(p.ambiguas.length, 1)
    assert.equal(p.ambiguas[0].candidatos.length, 2)
  })
})
