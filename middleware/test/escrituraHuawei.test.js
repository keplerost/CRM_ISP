import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfigOnt } from '../src/parsers/huaweiPerfilParser.js'
import { detectarFallo } from '../src/parsers/huaweiOntParser.js'

/**
 * El error que dejó a un abonado "dado de alta" sin existir en el equipo.
 *
 * Los comandos de escritura no se ejecutan de una: el equipo contesta con el
 * hint de autocompletado y espera un Enter. Leyendo solo esa primera respuesta
 * no hay ni éxito ni fallo, porque todavía no pasó nada.
 *
 * Todo lo de acá es salida literal del MA5800-X7 durante esa prueba.
 */

// Lo que contesta `ont add ...` ANTES del Enter que falta.
const ANTES_DEL_ENTER = `ont add 9 17 sn-auth "534B5957B800528F" omci ont-lineprofile-id 2 ont-srvprofile-id 11 desc "PRUEBA"
{ <cr>|ont-type<K> }: `

// Y lo que contesta DESPUÉS, que es donde por fin dice qué pasó.
const DESPUES_OK = `
  Command:
          ont add 9 17 sn-auth "534B5957B800528F" omci
  Number of ONTs that can be added: 1, success: 1
  PortID :9, ONTID :17

MA5800-X7(config-if-gpon-0/6)#`

const DESPUES_FALLA = `
  Command:
          display ont info 9 17
  Failure: The ONT does not exist

MA5800-X7(config-if-gpon-0/6)#`

describe('el hint de autocompletado esconde el resultado', () => {
  test('la primera respuesta no dice nada, ni bueno ni malo', () => {
    // Esto es exactamente lo que veía el sistema al informar "alta exitosa".
    assert.equal(detectarFallo(ANTES_DEL_ENTER), null)
  })

  test('el fallo recién aparece después del Enter', () => {
    assert.match(detectarFallo(`${ANTES_DEL_ENTER}\n${DESPUES_FALLA}`), /does not exist/i)
  })

  test('y el éxito también', () => {
    const todo = `${ANTES_DEL_ENTER}\n${DESPUES_OK}`
    assert.equal(detectarFallo(todo), null)
    assert.match(todo, /success: 1/)
  })
})

describe('descripción partida en varias líneas', () => {
  const armar = (desc) => `  SN                      : 534B5957B800528F (SKYW-B800528F)
${desc}
  Last down cause         : -
  Line profile ID      : 2
  Service profile ID   : 11`

  test('cortada a mitad de palabra: se une pegada', () => {
    // Sin relleno al final de la línea, el corte fue a mitad de palabra.
    const c = parseConfigOnt(
      armar(`  Description             : HERRERA_GUAMANI_ENMA_BEATRIZ_zon
                            e_Zone_1_descr_Via_San_Gerardo_R`),
    )
    assert.equal(c.descripcion, 'HERRERA_GUAMANI_ENMA_BEATRIZ_zone_Zone_1_descr_Via_San_Gerardo_R')
  })

  test('cortada en un espacio: se une con espacio', () => {
    // Con relleno de espacios al final, el corte fue entre palabras. Unirlas
    // pegadas daría "NO ES UNABONADO".
    //
    // El relleno se escribe a mano porque es justo lo que distingue un caso del
    // otro, y es lo primero que se pierde al copiar y pegar.
    const c = parseConfigOnt(
      armar(
        [
          '  Description             : PRUEBA BORRAR NO ES UN' + ' '.repeat(10),
          '                            ABONADO_descr_alta de' + ' '.repeat(11),
          '                            prueba_authd_20260804',
        ].join('\n'),
      ),
    )
    assert.equal(c.descripcion, 'PRUEBA BORRAR NO ES UN ABONADO_descr_alta de prueba_authd_20260804')
  })

  test('no se lleva puesta la línea siguiente', () => {
    const c = parseConfigOnt(armar('  Description             : ABC'))
    assert.equal(c.descripcion, 'ABC')
  })
})

describe('qué cuenta como rechazo del equipo', () => {
  test('"% Incomplete command" es un rechazo', () => {
    // Faltaba en la lista. Al crear una traffic table sin la política de
    // prioridad del final, el equipo contestaba esto, el sistema lo daba por
    // bueno, y el plan quedaba apuntando a una tabla que nunca se creó.
    assert.match(
      detectarFallo('  Command:\n     traffic table ip index 22 ...\n  % Incomplete command'),
      /Incomplete/,
    )
  })

  test('cualquier línea que empiece con % lo es', () => {
    // Enumerar los errores conocidos deja pasar el que todavía no se vio. VRP
    // marca todos sus rechazos con %.
    assert.ok(detectarFallo('% Too many parameters, the error locates at ^'))
    assert.ok(detectarFallo('% Unknown command'))
    assert.ok(detectarFallo('% Parameter error'))
    assert.ok(detectarFallo('Failure: The traffic table does not exist'))
  })

  test('una salida buena no se marca como fallo', () => {
    assert.equal(detectarFallo('  Create traffic descriptor record successfully'), null)
    assert.equal(detectarFallo('  Number of ONTs that can be added: 1, success: 1'), null)
    assert.equal(detectarFallo('MA5800-X7(config)#'), null)
  })

  test('un porcentaje en medio de una línea NO es un rechazo', () => {
    // "CPU occupation : 12%" empieza con texto, no con %. La regla es la
    // primera columna, no que aparezca el signo.
    assert.equal(detectarFallo('  CPU occupation          : 12%'), null)
  })
})
