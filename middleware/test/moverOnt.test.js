import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfigOnt, parseServicePortsDeOnt } from '../src/parsers/huaweiPerfilParser.js'

/**
 * Mover una ONT de puerto.
 *
 * En Huawei no existe "mover": se borra y se recrea. Eso significa que la foto
 * de su configuración es lo ÚNICO que permite devolverla a como estaba — si se
 * lee mal, el abonado vuelve distinto, o no vuelve.
 *
 * Las salidas son literales del MA5800-X7.
 */

const CONFIG = `  Control flag            : active
  Run state               : online
  Authentic type          : SN-auth
  SN                      : 48575443304D1BB2 (HWTC-304D1BB2)
  Management mode         : OMCI
  Description             : HERRERA_GUAMANI_ENMA_BEATRIZ_zon
  e_Zone_1_descr_Via_San_Gerardo_R
  ONT online duration     : 2 day(s), 13 hour(s)
  Line profile ID      : 2
  Line profile name    : SMARTOLT_FLEXIBLE_GPON
  Service profile ID   : 7
  Service profile name : HG8145X6-13`

const SERVICE_PORTS = `   INDEX VLAN VLAN     PORT F/ S/ P VPI  VCI   FLOW  FLOW       RX   TX   STATE
         ID   ATTR     TYPE                    TYPE  PARA
   -----------------------------------------------------------------------------
        0  999 common   gpon 0/6 /0  1    2     vlan  999        9    9    up
        4  200 common   gpon 0/6 /0  1    1     vlan  200        11   10   up`

describe('foto de la configuración de una ONT', () => {
  const c = parseConfigOnt(CONFIG)

  test('lee los IDs de perfil, que son lo que hay que reponer', () => {
    // Sin ellos la ONT se recrea con la configuración por defecto: otra VLAN,
    // otro comportamiento, y el abonado "vuelve" pero no anda igual.
    assert.equal(c.lineProfileId, 2)
    assert.equal(c.srvProfileId, 7)
    assert.equal(c.lineProfileNombre, 'SMARTOLT_FLEXIBLE_GPON')
    assert.equal(c.srvProfileNombre, 'HG8145X6-13')
  })

  test('la serie sale en la forma de la etiqueta', () => {
    assert.equal(c.sn, 'HWTC304D1BB2')
  })

  test('la descripción partida en dos líneas se une sin espacio', () => {
    // El equipo corta a mitad de palabra: "..._zon" + "e_Zone_1_...". Unir con
    // un espacio dejaría al abonado con el nombre roto en su propia ONT.
    assert.equal(
      c.descripcion,
      'HERRERA_GUAMANI_ENMA_BEATRIZ_zone_Zone_1_descr_Via_San_Gerardo_R',
    )
  })

  test('no se traga la línea siguiente como parte de la descripción', () => {
    assert.doesNotMatch(c.descripcion, /online duration/i)
  })

  test('el espacio empujado a la línea siguiente no se pierde', () => {
    // Cuando el corte cae justo al terminar una palabra, el equipo manda el
    // espacio separador al principio de la línea de abajo, escondido entre
    // saltos de cursor. Al limpiarlos quedaba una sangría más grande que la
    // normal, y recortarla dejaba la dirección del abonado como
    // "Frente alestadio".
    //
    // Salida literal de la ONT 0/6/0:0 del X7.
    const c2 = parseConfigOnt(
      [
        '  SN                      : 5254474743708538 (RTEG-C7085381)',
        '  Description             : MOLINA GARCIA FULTON            ',
        '                            ORFAY_descr_Selvalegre Frente al',
        '                                                                 estadio',
        '  Last down cause         : dying-gasp',
        '  Line profile ID      : 2',
        '  Service profile ID   : 9',
      ].join('\n'),
    )
    assert.equal(c2.descripcion, 'MOLINA GARCIA FULTON ORFAY_descr_Selvalegre Frente al estadio')
  })

  test('una salida ilegible devuelve null en vez de una foto a medias', () => {
    // Con una foto incompleta se borraría la ONT sin poder recrearla igual.
    assert.equal(parseConfigOnt('% Unknown command'), null)
    assert.equal(parseConfigOnt(''), null)
  })

  test('una salida CORTADA se nota, porque los perfiles quedan en null', () => {
    // El volcado son diez mil caracteres y a veces llega por la mitad. La foto
    // sale creíble —serie y descripción correctas— pero sin los perfiles.
    //
    // Al mover una ONT con esta foto, el `ont add` sale sin ont-srvprofile-id y
    // el equipo la recrea con el perfil por defecto: vuelve online, con el mismo
    // nombre, y con otra configuración de puertos.
    const cortada = parseConfigOnt(`  Run state               : online
  SN                      : 48575443304D1BB2 (HWTC-304D1BB2)
  Description             : HERRERA_GUAMANI
  Line profile ID      : 2
  Line profile name    : SMARTOLT_FLEXIBLE_GPON`)

    assert.equal(cortada.sn, 'HWTC304D1BB2')
    assert.equal(cortada.lineProfileId, 2)
    // Null, no cero: no es que tenga el perfil 0, es que no se llegó a leer.
    assert.equal(cortada.srvProfileId, null)
  })
})

describe('service-ports que hay que rehacer', () => {
  const sp = parseServicePortsDeOnt(SERVICE_PORTS)

  test('lee los dos con su VLAN y su gemport', () => {
    assert.equal(sp.length, 2)
    assert.equal(sp[0].indice, 0)
    assert.equal(sp[0].vlan, 999)
    assert.equal(sp[0].gemport, 2)
    assert.equal(sp[1].vlan, 200)
    assert.equal(sp[1].gemport, 1)
  })

  test('las traffic-tables van CRUZADAS respecto de las columnas RX y TX', () => {
    // La tabla muestra RX=11 TX=10 y la configuración del equipo dice
    // "inbound traffic-table index 10 outbound traffic-table index 11".
    //
    // Invertirlos al recrear le daría al abonado la velocidad de bajada en la
    // subida: sube rapidísimo y baja lento, y nadie lo relaciona con la mudanza
    // de puerto que se hizo tres días antes.
    assert.equal(sp[1].ttEntrada, 10)
    assert.equal(sp[1].ttSalida, 11)
  })

  test('cuando entrada y salida son iguales no se nota la diferencia', () => {
    assert.equal(sp[0].ttEntrada, 9)
    assert.equal(sp[0].ttSalida, 9)
  })

  test('el encabezado no se cuela como service-port', () => {
    for (const x of sp) assert.ok(Number.isFinite(x.vlan) && x.vlan > 0)
  })

  test('un service-port SIN plan igual se ve, con la velocidad en null', () => {
    // Una ONT autorizada sin elegir plan queda con las columnas en guion.
    // Cuando estas filas no se leían, el sistema creía que la ONT no tenía nada
    // colgando y no la podía ni borrar ni mover: el equipo rechazaba el borrado
    // con "This configured object has some service virtual ports".
    const sinPlan = parseServicePortsDeOnt(
      `   INDEX VLAN VLAN     PORT F/ S/ P VPI  VCI   FLOW  FLOW       RX   TX   STATE
      17  300 common   gpon 0/6 /9  17   1     vlan  300        -    -    up   `,
    )
    assert.equal(sinPlan.length, 1)
    assert.equal(sinPlan[0].indice, 17)
    assert.equal(sinPlan[0].vlan, 300)
    assert.equal(sinPlan[0].ontId, 17)
    // null, no cero: no tiene límite, no es que tenga un límite de cero.
    assert.equal(sinPlan[0].ttEntrada, null)
    assert.equal(sinPlan[0].ttSalida, null)
  })
})
