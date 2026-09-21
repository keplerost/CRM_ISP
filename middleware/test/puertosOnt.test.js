import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseEthPortsOnt, parsePotsPortsOnt } from '../src/parsers/huaweiPuertosOntParser.js'

/**
 * Los puertos de adentro de la ONT del abonado.
 *
 * Salida literal del MA5800-X7 para la ONT 0/6/4:10 (un HG8145X6).
 */

const ETH = `  --------------------------------------------------------------------------
  ONT-ID   ONT      ONT       Speed(Mbps)   Duplex   LinkState  RingStatus
           port-ID  Port-type
  --------------------------------------------------------------------------
      10         1         GE -             -        down       noloop
      10         2         GE 1000          full     up         noloop
      10         3         GE -             -        down       noloop
      10         4         GE 100           full     up         loop
  --------------------------------------------------------------------------`

const POTS = `  ------------------------------------------------------------------------------
   Port Physical Admin  Hook    Session    Service     Call          Service
   ID   State    State  State   Type       State       State         Codec
  ------------------------------------------------------------------------------
   1    Normal   Unlock OnHook  Idle       AutoBlock   RegisterFail  G711A
  ------------------------------------------------------------------------------`

describe('puertos ethernet de la ONT', () => {
  const p = parseEthPortsOnt(ETH)

  test('lee los cuatro puertos', () => {
    assert.equal(p.length, 4)
    assert.deepEqual(p.map((x) => x.puerto), [1, 2, 3, 4])
  })

  test('distingue el que tiene algo enchufado del que no', () => {
    // Es la respuesta a "no me anda internet" con la fibra perfecta: si están
    // todos en down, el problema está del router para adentro.
    assert.equal(p[0].conectado, false)
    assert.equal(p[1].conectado, true)
    assert.equal(p[1].velocidad_mbps, 1000)
    assert.equal(p[1].duplex, 'full')
  })

  test('un puerto caído no tiene velocidad CERO: no tiene velocidad', () => {
    // El equipo escribe "-". Guardarlo como 0 haría que un puerto sin nada
    // enchufado se lea como uno enchufado y andando a cero.
    assert.equal(p[0].velocidad_mbps, null)
    assert.equal(p[0].duplex, null)
  })

  test('detecta el cable en bucle', () => {
    // Un cable de la casa enchufado en dos bocas del mismo equipo tira abajo la
    // red del abonado, y sin esta columna se diagnostica como problema de la red.
    assert.equal(p[1].bucle, false)
    assert.equal(p[3].bucle, true)
  })

  test('un guion en la columna de bucle NO es un bucle', () => {
    // El equipo escribe "-" cuando la detección de bucle está apagada o el
    // modelo no la soporta. Tomarlo como bucle encendía la alarma roja en los
    // cuatro puertos de una ONT sana — y una alarma que salta sin motivo deja
    // de mirarse cuando el problema es de verdad.
    const sinDato = parseEthPortsOnt(
      '      11         1         GE -             -        down       -',
    )
    assert.equal(sinDato.length, 1)
    assert.equal(sinDato[0].bucle, null)
    assert.equal(sinDato[0].anillo, null)
  })

  test('el encabezado y los separadores no se cuelan', () => {
    for (const x of p) assert.ok(Number.isFinite(x.puerto))
  })
})

describe('puertos de teléfono', () => {
  const p = parsePotsPortsOnt(POTS)

  test('lee el puerto con todos sus estados', () => {
    assert.equal(p.length, 1)
    assert.equal(p[0].puerto, 1)
    assert.equal(p[0].estado_fisico, 'Normal')
    assert.equal(p[0].gancho, 'OnHook')
    assert.equal(p[0].codec, 'G711A')
  })

  test('RegisterFail NO cuenta como registrado', () => {
    // Es el caso que importa: la ONT está online, el puerto existe, y el
    // teléfono del abonado no funciona. Desde afuera se ve igual que uno bueno.
    assert.equal(p[0].registro, 'RegisterFail')
    assert.equal(p[0].registrado, false)
  })

  test('un estado desconocido cae del lado de "revisalo"', () => {
    // Se compara contra la lista de lo que SÍ está bien. Si una versión de VRP
    // devuelve un estado nuevo, tiene que aparecer como sospechoso y no pasar
    // por bueno sin que nadie lo mire.
    const raro = parsePotsPortsOnt(POTS.replace('RegisterFail', 'EstadoNuevo'))
    assert.equal(raro[0].registrado, false)
  })

  test('un puerto registrado se reconoce', () => {
    const bien = parsePotsPortsOnt(POTS.replace('RegisterFail', 'Registered'))
    assert.equal(bien[0].registrado, true)
  })
})
