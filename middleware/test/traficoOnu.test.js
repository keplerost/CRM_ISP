import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseEstadisticasServicePort } from '../src/parsers/huaweiPerfilParser.js'

/**
 * El consumo en vivo del abonado.
 *
 * El equipo no informa velocidad: informa BYTES ACUMULADOS desde que se creó el
 * service-port. La velocidad sale de restar dos lecturas, y todo lo delicado de
 * esta función está en qué hacer cuando esa resta no significa nada.
 *
 * Salida literal del MA5800-X7.
 */
const SALIDA = ` Number of upstream bytes             : 42667431805
 Number of upstream packets           : 220815909
 Number of upstream discard packets   : 5688
 Number of downstream bytes           : 859344460143
 Number of downstream packets         : 693827384
 Number of downstream discard packets : 125928`

describe('contadores del service-port', () => {
  const c = parseEstadisticasServicePort(SALIDA)

  test('lee los seis contadores', () => {
    assert.equal(c.subida_bytes, 42667431805)
    assert.equal(c.bajada_bytes, 859344460143)
    assert.equal(c.subida_paquetes, 220815909)
    assert.equal(c.bajada_paquetes, 693827384)
    assert.equal(c.subida_descartados, 5688)
    assert.equal(c.bajada_descartados, 125928)
  })

  test('no confunde bytes con paquetes descartados', () => {
    // Las seis etiquetas se parecen mucho entre sí: "upstream bytes",
    // "upstream packets" y "upstream discard packets". Cruzarlas daría una
    // velocidad calculada sobre paquetes en vez de bytes — un número creíble y
    // ocho veces equivocado.
    assert.notEqual(c.subida_bytes, c.subida_paquetes)
    assert.ok(c.bajada_bytes > c.bajada_paquetes)
  })

  test('una salida sin contadores devuelve null, no ceros', () => {
    // Ceros se dibujarían en el gráfico como "el abonado no consume nada".
    assert.equal(parseEstadisticasServicePort(''), null)
    assert.equal(parseEstadisticasServicePort('% Unknown command'), null)
  })

  test('un contador de terabytes no pierde precisión', () => {
    // 859 GB ya es grande; un abonado con años de servicio pasa el entero
    // seguro de JavaScript y ahí las restas empiezan a dar velocidades
    // inventadas. Por eso se leen como BigInt antes de convertir.
    const grande = parseEstadisticasServicePort(
      ' Number of downstream bytes : 9007199254740993\n Number of upstream bytes : 1',
    )
    assert.ok(grande.bajada_bytes > 9e15)
  })
})

describe('de bytes acumulados a Mbps', () => {
  // La misma cuenta que hace el servicio, aislada para poder fijarla.
  const mbps = (bytes, ms) => Math.round(((bytes * 8) / (ms / 1000) / 1e6) * 1000) / 1000

  test('12,5 MB en 10 segundos son 10 Mbps', () => {
    assert.equal(mbps(12_500_000, 10_000), 10)
  })

  test('un contador que retrocedió no es tráfico negativo', () => {
    // Pasa cuando la ONT se reinicia o se rehace su service-port: el contador
    // vuelve a empezar. La resta daría un número enorme y negativo, y el
    // gráfico dibujaría un pico que nunca existió.
    const delta = (ahora, antes) => (ahora == null || antes == null || ahora < antes ? null : ahora - antes)
    assert.equal(delta(100, 5_000_000), null)
    assert.equal(delta(5_000_100, 5_000_000), 100)
  })

  test('sin lectura anterior no hay velocidad, y eso no es cero', () => {
    const delta = (ahora, antes) => (ahora == null || antes == null || ahora < antes ? null : ahora - antes)
    assert.equal(delta(5_000_000, null), null)
  })
})
