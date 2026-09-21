import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { decodificarSn, normalizarSn, parsearDescripcion } from '../src/drivers/huaweiSnmp.js'
import { compararInventario, detectarPuertosCaidos } from '../src/services/oltFicha.js'

/**
 * Importación de ONTs desde el equipo.
 *
 * Todos los valores salen del MA5800-X7 de LA MANÁ. Es la parte del sistema
 * donde un error se lleva puesta la ficha de un abonado, así que se prueba con
 * lo que el equipo devuelve de verdad y no con ejemplos inventados.
 */

describe('número de serie', () => {
  test('decodifica los ocho bytes como los lee un técnico de la etiqueta', () => {
    // Cuatro bytes ASCII de fabricante + cuatro binarios.
    assert.equal(decodificarSn(Buffer.from('48575443304D1BB2', 'hex')), 'HWTC304D1BB2')
    assert.equal(decodificarSn(Buffer.from('52544547C7085381', 'hex')), 'RTEGC7085381')
    // Otro fabricante presente en el mismo equipo.
    assert.equal(decodificarSn(Buffer.from('4E42454CB17EADD5', 'hex')), 'NBELB17EADD5')
  })

  test('las dos notaciones del mismo equipo se normalizan igual', () => {
    // La CLI del MA5800 imprime los ocho bytes en hexadecimal; SNMP devuelve la
    // forma de la etiqueta. Sin normalizar, cada importación crearía duplicados
    // de las mismas ONTs — o peor, no encontraría la que ya está.
    assert.equal(normalizarSn('48575443304D1BB2'), 'HWTC304D1BB2')
    assert.equal(normalizarSn('HWTC304D1BB2'), 'HWTC304D1BB2')
    assert.equal(normalizarSn('hwtc304d1bb2'), 'HWTC304D1BB2')
    assert.equal(normalizarSn('HWTC:30:4D:1B:B2'), 'HWTC304D1BB2')
  })

  test('un hexadecimal que no empieza con ASCII se deja como está', () => {
    // 16 dígitos hex no siempre son "4 ASCII + 4 binarios". Convertir a ciegas
    // inventaría un fabricante que no existe.
    assert.equal(normalizarSn('0011223344556677'), '0011223344556677')
  })

  test('sin serie no se devuelve una cadena vacía que parezca una', () => {
    assert.equal(decodificarSn(null), null)
    assert.equal(decodificarSn(Buffer.alloc(0)), null)
    assert.equal(normalizarSn(''), null)
  })
})

describe('descripción que dejó el sistema anterior', () => {
  test('desarma el formato completo de SmartOLT', () => {
    // Texto literal de la ONT 6/0/1 del X7.
    const d = parsearDescripcion(
      'HERRERA_GUAMANI_ENMA_BEATRIZ_zone_Zone_1_descr_Via_San_Gerardo_Recinto_Selvalegre_frente_a_una_casa_blanca_authd_20251013',
    )

    assert.equal(d.nombre, 'HERRERA GUAMANI ENMA BEATRIZ')

    // La zona y la dirección se limpian igual que el nombre. Antes solo se
    // limpiaba el nombre, y la misma zona terminaba guardada de dos formas
    // —"Zone 1" en 67 ONUs y "Zone_1" en 8— porque distintos caminos de
    // importación la escribían distinto.
    //
    // El filtro de zonas las mostraba como dos zonas separadas: al filtrar para
    // ver a quiénes dejó sin servicio un corte, devolvía 67 abonados y dejaba 8
    // afuera sin que nada avisara de que faltaban.
    assert.equal(d.zona, 'Zone 1')
    assert.equal(d.direccion, 'Via San Gerardo Recinto Selvalegre frente a una casa blanca')

    // Una fecha pegada no se puede ni ordenar ni comparar.
    assert.equal(d.alta, '2025-10-13')
  })

  test('sin fecha de alta tampoco se pierde el resto', () => {
    const d = parsearDescripcion('MASAPANTA_MASAPANTA_WALTER_MARCELO_descr_Selvalegre')
    assert.equal(d.nombre, 'MASAPANTA MASAPANTA WALTER MARCELO')
    assert.equal(d.direccion, 'Selvalegre')
    assert.equal(d.alta, null)
  })

  test('un texto libre queda entero como nombre', () => {
    // Inventarle estructura a algo que no la tiene es peor que dejarlo.
    const d = parsearDescripcion('MOLINA GARCIA FULTON ORFAY')
    assert.equal(d.nombre, 'MOLINA GARCIA FULTON ORFAY')
    assert.equal(d.direccion, null)
  })

  test('una descripción vacía no inventa un abonado', () => {
    assert.deepEqual(parsearDescripcion(''), {
      nombre: null,
      zona: null,
      direccion: null,
      alta: null,
      completa: null,
    })
  })
})

describe('comparación entre el equipo y la base', () => {
  const enEquipo = (extra = {}) => ({
    sn: 'HWTC304D1BB2',
    slot: 6,
    puerto: 0,
    ontId: 1,
    estado: 'online',
    ...extra,
  })

  const enBase = (extra = {}) => ({
    id: 'fila-1',
    sn: 'HWTC304D1BB2',
    slot: 6,
    puerto: 0,
    onu_index: 1,
    nombre_cliente: 'HERRERA GUAMANI ENMA',
    ...extra,
  })

  test('una ONT que no está en la base es nueva', () => {
    const r = compararInventario([enEquipo()], [])
    assert.equal(r.nuevas.length, 1)
    assert.equal(r.sobrantes.length, 0)
  })

  test('la misma ONT en el mismo lugar no genera trabajo', () => {
    const r = compararInventario([enEquipo()], [enBase()])
    assert.equal(r.sinCambios.length, 1)
    assert.equal(r.nuevas.length, 0)
    // Se arrastra el id para poder actualizarla sin volver a buscarla.
    assert.equal(r.sinCambios[0].id, 'fila-1')
  })

  test('reconoce la ONT aunque la base tenga la serie en la otra notación', () => {
    // Este es EL caso: las filas viejas pueden tener el hexadecimal crudo de la
    // CLI. Sin normalizar, la importación duplicaría a todos los abonados.
    const r = compararInventario([enEquipo()], [enBase({ sn: '48575443304D1BB2' })])
    assert.equal(r.nuevas.length, 0)
    assert.equal(r.sinCambios.length, 1)
  })

  test('una ONT que cambió de puerto se marca como mudada, no como nueva', () => {
    // Pasa cuando se reubica a un abonado, y es justo lo que deja a la base
    // apuntando a la fibra equivocada.
    const r = compararInventario([enEquipo({ puerto: 4, ontId: 9 })], [enBase()])

    assert.equal(r.mudadas.length, 1)
    assert.equal(r.nuevas.length, 0)
    assert.deepEqual(r.mudadas[0].antes, { slot: 6, puerto: 0, onu_index: 1 })
  })

  test('lo que está en la base y no en el equipo se informa, no se borra', () => {
    // La función no puede borrar nada — solo reportar. Una ONT que hoy no
    // aparece puede ser un abonado que desenchufó el equipo diez minutos.
    const r = compararInventario([], [enBase()])
    assert.equal(r.sobrantes.length, 1)
    assert.equal(r.sobrantes[0].id, 'fila-1')
  })

  test('una ONT sin serie no entra ni como nueva', () => {
    const r = compararInventario([enEquipo({ sn: null })], [])
    assert.equal(r.nuevas.length, 0)
  })

  test('no confunde dos abonados distintos del mismo puerto', () => {
    const equipo = [
      enEquipo({ sn: 'HWTC00000001', ontId: 1 }),
      enEquipo({ sn: 'HWTC00000002', ontId: 2 }),
    ]
    const base = [
      enBase({ id: 'a', sn: 'HWTC00000001', onu_index: 1 }),
      enBase({ id: 'b', sn: 'HWTC00000002', onu_index: 2 }),
    ]

    const r = compararInventario(equipo, base)
    assert.equal(r.sinCambios.length, 2)
    assert.equal(r.mudadas.length, 0)
    assert.deepEqual(r.sinCambios.map((x) => x.id).sort(), ['a', 'b'])
  })

  test('un puerto entero que desaparece se distingue de abonados que se fueron', () => {
    // Pasó de verdad: el puerto 6/6 estuvo caído durante una importación y sus
    // seis abonados quedaron fuera del sistema sin que nada lo dijera.
    const sobrantes = [
      { id: 'a', sn: 'SN1', slot: 6, puerto: 6, onu_index: 0 },
      { id: 'b', sn: 'SN2', slot: 6, puerto: 6, onu_index: 1 },
      { id: 'c', sn: 'SN3', slot: 6, puerto: 6, onu_index: 2 },
    ]
    const delEquipo = [{ sn: 'SN9', slot: 6, puerto: 0, ontId: 0 }]

    const caidos = detectarPuertosCaidos(sobrantes, delEquipo)
    assert.equal(caidos.length, 1)
    assert.deepEqual(caidos[0], { slot: 6, puerto: 6, onus: 3 })
  })

  test('un solo abonado que se fue NO es un puerto caído', () => {
    // Con uno solo no se puede distinguir una baja de una falla, y avisar de
    // más entrena a ignorar el aviso.
    const sobrantes = [{ id: 'a', sn: 'SN1', slot: 6, puerto: 6, onu_index: 0 }]
    assert.deepEqual(detectarPuertosCaidos(sobrantes, []), [])
  })

  test('si el puerto sigue reportando otras ONTs, no está caído', () => {
    const sobrantes = [
      { id: 'a', sn: 'SN1', slot: 6, puerto: 6, onu_index: 0 },
      { id: 'b', sn: 'SN2', slot: 6, puerto: 6, onu_index: 1 },
    ]
    const delEquipo = [{ sn: 'SN3', slot: 6, puerto: 6, ontId: 2 }]
    assert.deepEqual(detectarPuertosCaidos(sobrantes, delEquipo), [])
  })

  test('dos ONTs que se intercambiaron el puerto se detectan las dos', () => {
    const equipo = [
      enEquipo({ sn: 'HWTC00000001', ontId: 2 }),
      enEquipo({ sn: 'HWTC00000002', ontId: 1 }),
    ]
    const base = [
      enBase({ id: 'a', sn: 'HWTC00000001', onu_index: 1 }),
      enBase({ id: 'b', sn: 'HWTC00000002', onu_index: 2 }),
    ]

    const r = compararInventario(equipo, base)
    assert.equal(r.mudadas.length, 2)
    assert.equal(r.sinCambios.length, 0)
  })
})
