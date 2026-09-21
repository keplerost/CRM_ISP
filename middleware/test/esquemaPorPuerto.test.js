import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { planificarEsquemaPorPuerto } from '../src/services/esquemaPorPuerto.js'

/**
 * La aritmética del esquema por puerto.
 *
 * Se prueba contra lo que este ISP ya tiene funcionando en la MA5608T, que es la
 * mejor referencia posible: si el generador reproduce exactamente esos dieciséis
 * bloques, hace lo que tiene que hacer.
 *
 *     vlan116  172.16.8.0/25    gw 172.16.8.1     pool .2 → .126
 *     vlan117  172.16.8.128/25  gw 172.16.8.129   pool .130 → .254
 *     …
 *     vlan131  172.16.15.128/25 gw 172.16.15.129  pool .130 → .254
 */

const ma5608t = () =>
  planificarEsquemaPorPuerto({
    slot: 1,
    desdePuerto: 0,
    hastaPuerto: 15,
    desdeVlan: 116,
    bloqueBase: '172.16.8.0',
    prefijo: 25,
    olt: 'MA5608T',
  })

describe('reproduce el esquema que ya está funcionando', () => {
  test('los dieciséis puertos', () => {
    assert.equal(ma5608t().total, 16)
  })

  test('el primero', () => {
    const f = ma5608t().filas[0]
    assert.equal(f.vlan, 116)
    assert.equal(f.cidr, '172.16.8.0/25')
    assert.equal(f.gateway, '172.16.8.1')
    assert.equal(f.rango, '172.16.8.2-172.16.8.126')
    assert.equal(f.nombre, 'BOARD1_PON0_VLAN116_MA5608T')
  })

  test('el segundo cae en la mitad de arriba del mismo /24', () => {
    const f = ma5608t().filas[1]
    assert.equal(f.cidr, '172.16.8.128/25')
    assert.equal(f.gateway, '172.16.8.129')
    assert.equal(f.rango, '172.16.8.130-172.16.8.254')
  })

  test('el último', () => {
    const f = ma5608t().filas[15]
    assert.equal(f.vlan, 131)
    assert.equal(f.cidr, '172.16.15.128/25')
    assert.equal(f.gateway, '172.16.15.129')
    assert.equal(f.rango, '172.16.15.130-172.16.15.254')
    assert.equal(f.nombre, 'BOARD1_PON15_VLAN131_MA5608T')
  })

  test('126 direcciones para abonados en cada uno', () => {
    // 128 menos la red, el broadcast y el gateway. El "son 128 IPs" del /25 es
    // el tamaño del bloque; las que se pueden entregar son menos, y prometer
    // 128 es prometer dos que no existen y una que es el router.
    for (const f of ma5608t().filas) assert.equal(f.direcciones, 125)
  })

  test('ningún bloque se solapa con otro', () => {
    const filas = ma5608t().filas
    for (let i = 1; i < filas.length; i++) {
      const anterior = filas[i - 1]
      const [red] = filas[i].cidr.split('/')
      assert.ok(
        aNumero(red) > aNumero(anterior.hasta),
        `${filas[i].cidr} pisa a ${anterior.cidr}`,
      )
    }
  })

  test('la placa viaja en cada fila', () => {
    // Las filas van al navegador y vuelven para aplicarse. Si la placa solo
    // estuviera arriba, volverían sin ella y se crearía el puerto 4 de la placa
    // equivocada.
    for (const f of ma5608t().filas) assert.equal(f.slot, 1)
  })
})

describe('el gateway al final del bloque', () => {
  // Es como está la X7: 172.18.1.254/24 en vez de 172.18.1.1.
  const plan = planificarEsquemaPorPuerto({
    slot: 6,
    desdePuerto: 0,
    hastaPuerto: 1,
    desdeVlan: 210,
    bloqueBase: '172.18.10.0',
    prefijo: 24,
    gateway: 'fin',
  })

  test('el gateway es la penúltima', () => {
    assert.equal(plan.filas[0].gateway, '172.18.10.254')
  })

  test('el rango arranca en .1 y no pisa el gateway', () => {
    assert.equal(plan.filas[0].rango, '172.18.10.1-172.18.10.253')
  })
})

describe('modo PPPoE', () => {
  /**
   * En PPPoE cada sesión es punto a punto y levanta su propia ruta /32: no hay
   * dominio de broadcast ni ARP, y el bloque no vive en ninguna interfaz.
   *
   * Verificado contra el router de este ISP: el abonado 172.16.5.2 tiene como
   * puerta de enlace el 172.17.0.1 del perfil PPP, no el 172.16.5.1 que está
   * puesto en la interfaz vlan110. Ese /25 en la interfaz no lo usa nadie.
   */
  const plan = () =>
    planificarEsquemaPorPuerto({
      slot: 6,
      desdePuerto: 0,
      hastaPuerto: 1,
      desdeVlan: 204,
      bloqueBase: '172.16.16.0',
      prefijo: 25,
      gateway: 'pppoe',
      gatewayPppoe: '172.17.0.1',
      olt: 'X7',
    })

  test('el gateway es el mismo para todos: el del perfil', () => {
    for (const f of plan().filas) assert.equal(f.gateway, '172.17.0.1')
  })

  test('no se reserva ninguna dirección dentro del bloque', () => {
    // Es la diferencia concreta: sin gateway que descontar, el rango arranca en
    // .1 y no en .2.
    assert.equal(plan().filas[0].rango, '172.16.16.1-172.16.16.126')
  })

  test('126 por bloque en vez de 125', () => {
    // Dos más por puerto. En treinta y dos puertos son sesenta y cuatro
    // direcciones que en el otro modo se tiran.
    for (const f of plan().filas) assert.equal(f.direcciones, 126)
  })

  test('la red y el broadcast siguen afuera', () => {
    // Se podrían entregar —no hay dominio de broadcast— pero se dejan fuera
    // para que el bloque siga siendo agregable y para no sorprender a un CPE
    // que los rechace.
    const f = plan().filas[0]
    assert.notEqual(f.desde, '172.16.16.0')
    assert.notEqual(f.hasta, '172.16.16.127')
  })

  test('las filas quedan marcadas, para que el alta no toque la interfaz', () => {
    for (const f of plan().filas) assert.equal(f.pppoe, true)
  })

  test('sin local-address se rechaza en vez de dejar al abonado sin gateway', () => {
    // El secret se crearía igual y el cliente conectaría sin navegar: un fallo
    // que aparece recién cuando llama.
    assert.throws(
      () =>
        planificarEsquemaPorPuerto({
          slot: 6,
          hastaPuerto: 1,
          desdeVlan: 204,
          bloqueBase: '172.16.16.0',
          gateway: 'pppoe',
        }),
      /local-address/,
    )
  })

  test('el modo con gateway propio no se ve afectado', () => {
    const otro = planificarEsquemaPorPuerto({
      slot: 1,
      hastaPuerto: 0,
      desdeVlan: 116,
      bloqueBase: '172.16.8.0',
      prefijo: 25,
    })
    assert.equal(otro.filas[0].gateway, '172.16.8.1')
    assert.equal(otro.filas[0].rango, '172.16.8.2-172.16.8.126')
    assert.equal(otro.filas[0].pppoe, false)
  })
})

describe('lo que se rechaza en vez de generar mal', () => {
  test('un bloque base desalineado', () => {
    // Arrancar los /25 en .64 hace que el segundo pise al primero, y en la tabla
    // de dieciséis filas eso no se ve.
    assert.throws(
      () =>
        planificarEsquemaPorPuerto({
          slot: 1,
          hastaPuerto: 3,
          desdeVlan: 100,
          bloqueBase: '172.16.8.64',
          prefijo: 25,
        }),
      /empieza en 172\.16\.8\.0/,
    )
  })

  test('dice cuál es la dirección correcta, no solo que está mal', () => {
    try {
      planificarEsquemaPorPuerto({
        slot: 1,
        hastaPuerto: 1,
        desdeVlan: 100,
        bloqueBase: '10.0.0.200',
        prefijo: 25,
      })
      assert.fail('tenía que rechazarlo')
    } catch (e) {
      assert.match(e.message, /10\.0\.0\.128/)
    }
  })

  test('un rango de VLANs que se pasa de 4094', () => {
    assert.throws(
      () =>
        planificarEsquemaPorPuerto({
          slot: 1,
          hastaPuerto: 15,
          desdeVlan: 4090,
          bloqueBase: '10.0.0.0',
          prefijo: 25,
        }),
      /4094/,
    )
  })

  test('el rango de puertos al revés', () => {
    assert.throws(
      () =>
        planificarEsquemaPorPuerto({
          slot: 1,
          desdePuerto: 15,
          hastaPuerto: 0,
          desdeVlan: 100,
          bloqueBase: '10.0.0.0',
        }),
      /no es válido/,
    )
  })

  test('una dirección base que no es una dirección', () => {
    assert.throws(
      () =>
        planificarEsquemaPorPuerto({
          slot: 1,
          hastaPuerto: 1,
          desdeVlan: 100,
          bloqueBase: '172.16.300.0',
        }),
      /no es una dirección válida/,
    )
  })
})

describe('el nombre', () => {
  test('reemplaza todas las piezas', () => {
    const plan = planificarEsquemaPorPuerto({
      slot: 6,
      desdePuerto: 4,
      hastaPuerto: 4,
      desdeVlan: 204,
      bloqueBase: '192.168.111.0',
      prefijo: 24,
      olt: 'X7',
    })
    assert.equal(plan.filas[0].nombre, 'BOARD6_PON4_VLAN204_X7')
  })

  test('acepta otro patrón', () => {
    const plan = planificarEsquemaPorPuerto({
      slot: 6,
      hastaPuerto: 0,
      desdeVlan: 300,
      bloqueBase: '10.9.0.0',
      prefijo: 25,
      nombre: 'PON{puerto} · {cidr}',
    })
    assert.equal(plan.filas[0].nombre, 'PON0 · 10.9.0.0/25')
  })
})

const aNumero = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0)

describe('las dos formas de repartir en PPPoE', () => {
  /**
   * Son dos convenciones legítimas y el sistema tiene que servir a las dos: un
   * ISP puede tener un solo local-address para todo, y otro uno por VLAN.
   *
   * Estaban mezcladas en un solo campo —`gateway: 'pppoe'` significaba las dos
   * cosas a la vez— y no había forma de pedir la segunda.
   */
  const plan = (extra) =>
    planificarEsquemaPorPuerto({
      slot: 6,
      desdePuerto: 0,
      hastaPuerto: 0,
      desdeVlan: 202,
      bloqueBase: '172.19.0.0',
      prefijo: 25,
      pppoe: true,
      ...extra,
    }).filas[0]

  test('con local-address compartido, el .1 se entrega', () => {
    // No hay nada que reservar dentro del bloque: la puerta de enlace es una
    // sola para todos los segmentos.
    const f = plan({ gateway: 'compartido', gatewayPppoe: '172.17.0.1' })
    assert.equal(f.gateway, '172.17.0.1')
    assert.equal(f.rango, '172.19.0.1-172.19.0.126')
    assert.equal(f.direcciones, 126)
  })

  test('con local-address por VLAN, el .1 se reserva', () => {
    // Cuesta una dirección por bloque y a cambio el ruteo se lee por segmento.
    const f = plan({ gateway: 'inicio' })
    assert.equal(f.gateway, '172.19.0.1')
    assert.equal(f.rango, '172.19.0.2-172.19.0.126')
    assert.equal(f.direcciones, 125)
  })

  test('en los dos casos el bloque NO va en una interfaz del router', () => {
    // Es lo que distingue PPPoE de IP fija, y es independiente de dónde esté el
    // gateway. Ponerlo en la interfaz crearía una red conectada que nadie usa.
    assert.equal(plan({ gateway: 'compartido', gatewayPppoe: '172.17.0.1' }).pppoe, true)
    assert.equal(plan({ gateway: 'inicio' }).pppoe, true)
  })

  test('la misma posición de gateway, pero con IP fija, sí va en la interfaz', () => {
    const f = planificarEsquemaPorPuerto({
      slot: 6, hastaPuerto: 0, desdeVlan: 202,
      bloqueBase: '172.19.0.0', prefijo: 25,
      gateway: 'inicio', pppoe: false,
    }).filas[0]
    assert.equal(f.gateway, '172.19.0.1')
    assert.equal(f.rango, '172.19.0.2-172.19.0.126')
    assert.equal(f.pppoe, false)
  })

  test('el "pppoe" viejo sigue significando lo mismo que antes', () => {
    // Había esquemas generados con la forma anterior: cambiar su significado
    // haría que un bloque existente y uno nuevo repartan distinto sin que nadie
    // lo pida.
    const viejo = planificarEsquemaPorPuerto({
      slot: 6, hastaPuerto: 0, desdeVlan: 202,
      bloqueBase: '172.19.0.0', prefijo: 25,
      gateway: 'pppoe', gatewayPppoe: '172.17.0.1',
    }).filas[0]
    assert.equal(viejo.gateway, '172.17.0.1')
    assert.equal(viejo.rango, '172.19.0.1-172.19.0.126')
    assert.equal(viejo.pppoe, true)
  })
})
