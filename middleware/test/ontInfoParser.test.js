import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseOntInfoAll } from '../src/parsers/huaweiOntParser.js'
import { normalizarSn, pareceSn } from '../src/lib/sn.js'

/**
 * Lectura de `display ont info <puerto> all`.
 *
 * La salida de abajo es literal del MA5800-X7 de LA MANÁ, incluidos el eco del
 * comando, el hint de autocompletado, el relleno de las columnas y la basura de
 * cursor que el equipo mete a mitad de línea.
 *
 * Está copiada con los espacios exactos a propósito: el relleno del final de
 * cada línea es lo que distingue una descripción cortada en un borde de palabra
 * de una cortada al medio, y un editor que "limpie" esos espacios rompe estos
 * tests por el motivo correcto.
 */

// El equipo intercala saltos de cursor a mitad de la salida. Se escribe
// explícito para que la fixture no dependa de que un ESC invisible sobreviva a
// un copiar y pegar.
const ESC = '\x1b'

// prettier-ignore
const REAL = [
  'display ont info 0 all ',
  '{ <cr>||<K> }: ',
  '',
  '  Command:',
  '          display ont info 0 all',
  '  -----------------------------------------------------------------------------',
  '  F/S/P   ONT         SN         Control     Run      Config   Match    Protect',
  '          ID                     flag        state    state    state    side ',
  '  -----------------------------------------------------------------------------',
  '  0/ 6/0    0  52544547C7085381  active      online   normal   mismatch no ',
  '  0/ 6/0    1  48575443304D1BB2  active      online   normal   match    no ',
  '  0/ 6/0    6  4E42454CB17EADD5  active      offline  initial  initial  no ',
  '  0/ 6/0    7  4857544346AADF9B  active      online   failed   match    no ',
  '  0/ 6/0   10  4857544383C0C443  active      online   normal   mismatch no ',
  '  0/ 6/0   13  48575443549B63A3  active      online   failed   match    no ',
  '[37D                                     [37D  0/ 6/0   19  48575443CD860BB1  active      online   normal   match    no ',
  '  -----------------------------------------------------------------------------',
  '  F/S/P   ONT-ID   Description',
  '  -----------------------------------------------------------------------------',
  '  0/ 6/0       0   MOLINA GARCIA FULTON ORFAY_descr_Selvalegre Frente al   ',
  '                   estadio',
  '  0/ 6/0       1   HERRERA_GUAMANI_ENMA_BEATRIZ_zone_Zone_1_descr_Via_San_G',
  '                   erardo_Recinto_Selvalegre_frente_a_una_casa_blanca_authd',
  '                   _20251013',
  '  0/ 6/0       6   MORALES GUAMAN KLEVER ARNULFO_descr_RECINTO SELVALEGRE',
  '  0/ 6/0       7   MORALES_zone_Zone 1_descr_SAN _authd_20240424',
  '  0/ 6/0      19   MASAPANTA CHANGOLUISA WILSON RENE_zone_Zone             ',
  '                   1_descr_Recinto Selva Alegre_authd_20260402',
  // El equipo llenó la columna justo hasta el final de "Recinto" y empujó el
  // espacio separador al comienzo de la línea siguiente: fijate que ésta tiene
  // 20 espacios de sangría y no 19 como las demás.
  '  0/ 6/0      13   YUPANGUI CHILUISA LUIS ROBERTO_zone_Zone 1_descr_Recinto',
  '                    Nuevo Amanecer_authd_20240501',
  // Fila de descripción CORRIDA por los saltos de cursor. Su continuación, en
  // cambio, viene en la posición normal: medir la columna contra esta fila daba
  // un ancho falso y la continuación se perdía entera.
  `${ESC}[37D                                     ${ESC}[37D  0/ 6/0      10   Jesus David Mapanta Masapanta_zone_Zone 1_descr_Via     `,
  '                   Manguila Chico_authd_20251106',
  '  -----------------------------------------------------------------------------',
  '',
  '  MA5800-X7(config-if-gpon-0/6)#',
].join('\n')

const porId = (onts, id) => onts.find((o) => o.ontId === id)

describe('display ont info — el bug de la descripción que pisaba la serie', () => {
  const onts = parseOntInfoAll(REAL)

  test('lee todas las ONTs de la tabla de estado', () => {
    assert.equal(onts.length, 7)
    assert.deepEqual(
      onts.map((o) => o.ontId),
      [0, 1, 6, 7, 10, 13, 19],
    )
  })

  test('la serie NO es la primera palabra de la descripción', () => {
    // Este es EL bug. La fila de descripción de la ONT 0 ("MOLINA GARCIA
    // FULTON ORFAY_descr_Selvalegre Frente al") encajaba en la forma de una fila
    // de estado y la pisaba, dejando "MOLINA" como número de serie.
    const ont = porId(onts, 0)
    assert.notEqual(ont.sn, 'MOLINA')
    assert.equal(ont.sn, 'RTEGC7085381')
  })

  test('tampoco con una descripción de exactamente cuatro palabras', () => {
    // El bug no dependía de que la ONT estuviera caída, como parecía: dependía
    // de cuántas palabras tuviera la descripción. Con cuatro ya alcanzaba.
    const ont = porId(onts, 6)
    assert.notEqual(ont.sn, 'MORALES')
    assert.equal(ont.sn, 'NBELB17EADD5')
    assert.equal(ont.estado, 'offline')
  })

  test('la serie queda como está en la etiqueta, no en hexadecimal crudo', () => {
    // La CLI imprime 48575443304D1BB2 y la etiqueta dice HWTC304D1BB2. Son el
    // mismo equipo, y compararlos sin normalizar da "no existe" para una ONT
    // que sí está —o crea un duplicado del mismo abonado.
    assert.equal(porId(onts, 1).sn, 'HWTC304D1BB2')
    assert.equal(porId(onts, 7).sn, 'HWTC46AADF9B')
  })

  test('lee la ONT aunque el equipo meta basura de cursor a mitad de línea', () => {
    const ont = porId(onts, 19)
    assert.equal(ont.sn, 'HWTCCD860BB1')
    assert.equal(ont.estado, 'online')
  })
})

describe('descripciones que el equipo parte en varias líneas', () => {
  const onts = parseOntInfoAll(REAL)

  test('une el corte hecho en un borde de palabra CON espacio', () => {
    // "…Frente al␣␣␣" + "estadio" → "…Frente al estadio"
    assert.equal(
      porId(onts, 0).descripcion,
      'MOLINA GARCIA FULTON ORFAY_descr_Selvalegre Frente al estadio',
    )
  })

  test('une el corte hecho al medio de una palabra SIN espacio', () => {
    // "…_Via_San_G" + "erardo_…" → "…_Via_San_Gerardo_…", no "…_Via_San_G erardo_…"
    assert.equal(
      porId(onts, 1).descripcion,
      'HERRERA_GUAMANI_ENMA_BEATRIZ_zone_Zone_1_descr_Via_San_Gerardo_Recinto_Selvalegre_frente_a_una_casa_blanca_authd_20251013',
    )
  })

  test('une bien también cuando son tres líneas', () => {
    assert.match(porId(onts, 1).descripcion, /_authd_20251013$/)
  })

  test('el relleno de la columna no queda dentro del texto', () => {
    // "…_zone_Zone␣␣␣␣" + "1_descr_…" → "…_zone_Zone 1_descr_…"
    assert.equal(
      porId(onts, 19).descripcion,
      'MASAPANTA CHANGOLUISA WILSON RENE_zone_Zone 1_descr_Recinto Selva Alegre_authd_20260402',
    )
  })

  test('no se come el espacio que el equipo empujó a la línea siguiente', () => {
    // Cuando la columna se llena justo al terminar una palabra, el separador
    // queda al principio de la continuación. Recortarlo dejaba
    // "…descr_RecintoNuevo Amanecer": la dirección del abonado mal escrita.
    const d = porId(onts, 13).descripcion
    assert.match(d, /_descr_Recinto Nuevo Amanecer_/)
    assert.doesNotMatch(d, /RecintoNuevo/)
  })

  test('no pierde la continuación de una fila corrida por el cursor', () => {
    // La fila de la ONT 10 viene desplazada a la derecha pero su continuación
    // no. Midiendo la columna contra la fila desplazada, la dirección quedaba
    // trunca en "…_descr_Via" y se perdía dónde vive el abonado.
    assert.equal(
      porId(onts, 10).descripcion,
      'Jesus David Mapanta Masapanta_zone_Zone 1_descr_Via Manguila Chico_authd_20251106',
    )
  })

  test('una descripción de una sola línea llega entera', () => {
    assert.equal(porId(onts, 6).descripcion, 'MORALES GUAMAN KLEVER ARNULFO_descr_RECINTO SELVALEGRE')
  })

  test('ninguna descripción queda con espacios repetidos', () => {
    for (const o of onts) {
      if (o.descripcion) assert.doesNotMatch(o.descripcion, /\s{2,}/, `ONT ${o.ontId}`)
    }
  })
})

describe('el resto de los campos', () => {
  const onts = parseOntInfoAll(REAL)

  test('estado, ubicación y banderas', () => {
    const ont = porId(onts, 0)
    assert.deepEqual(
      { frame: ont.frame, slot: ont.slot, puerto: ont.puerto },
      { frame: 0, slot: 6, puerto: 0 },
    )
    assert.equal(ont.controlFlag, 'active')
    assert.equal(ont.runState, 'online')
    assert.equal(ont.configState, 'normal')
    assert.equal(ont.matchState, 'mismatch')
    assert.equal(ont.estado, 'online')
  })

  test('una salida sin ONTs no rompe', () => {
    assert.deepEqual(parseOntInfoAll('The required ONT does not exist'), [])
    assert.deepEqual(parseOntInfoAll(''), [])
  })

  test('una descripción "-" no se guarda como texto', () => {
    const s = [
      '  F/S/P   ONT         SN         Control     Run      Config   Match    Protect',
      '  0/ 6/0    3  48575443AABBCCDD  active      online   normal   match    no ',
      '  F/S/P   ONT-ID   Description',
      '  0/ 6/0       3   -',
    ].join('\n')
    assert.equal(parseOntInfoAll(s)[0].descripcion, null)
  })

  test('una descripción sin su fila de estado se descarta', () => {
    // Sin la ONT en la primera tabla no hay a qué pegarle la descripción, y
    // inventar una fila desde la sección equivocada es justo el bug de origen.
    const s = [
      '  F/S/P   ONT-ID   Description',
      '  0/ 6/0       9   ALGUIEN QUE NO ESTA ARRIBA',
    ].join('\n')
    assert.deepEqual(parseOntInfoAll(s), [])
  })
})

describe('notaciones del número de serie', () => {
  test('las dos formas se normalizan a la de la etiqueta', () => {
    assert.equal(normalizarSn('48575443304D1BB2'), 'HWTC304D1BB2')
    assert.equal(normalizarSn('HWTC304D1BB2'), 'HWTC304D1BB2')
  })

  test('reconoce lo que parece una serie y lo que no', () => {
    assert.ok(pareceSn('48575443304D1BB2'))
    assert.ok(pareceSn('HWTC304D1BB2'))
    assert.ok(!pareceSn('MOLINA'))
    assert.ok(!pareceSn('active'))
  })
})
