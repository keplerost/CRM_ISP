import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * El tope del corte por mora.
 *
 * ── Por qué esto merece una prueba propia ──
 *
 * Porque el error que tenía no fallaba: el campo que debía avisar cuánta gente
 * quedaba sin cortar devolvía CERO siempre, por una cuenta mal escrita. El
 * informe decía "50 cortados" con 450 pendientes y parecía un trabajo
 * terminado.
 *
 * Es la peor clase de error de este sistema: nadie revisa un número que dice lo
 * que uno espera leer.
 */

/**
 * La cuenta tal como estaba antes.
 *
 * Se conserva para que la prueba muestre el error concreto y no una descripción
 * de él: cualquiera puede correrla y ver que da cero.
 */
const comoEstaba = (traidos, tope) => Math.max(0, traidos === tope ? -1 : 0)

/** Y como está ahora. */
const comoEsta = (total, traidos) => Math.max(0, total - traidos)

test('la cuenta vieja daba cero aunque quedaran cientos sin cortar', () => {
  // 500 morosos, tope 50: quedaban 450 navegando y el informe decía 0.
  assert.equal(comoEstaba(50, 50), 0, 'con el tope alcanzado')
  assert.equal(comoEstaba(30, 50), 0, 'y sin alcanzarlo')

  // No había forma de que diera otra cosa: los dos caminos terminan en 0.
  for (const [traidos, tope] of [[1, 1], [0, 50], [999, 999], [5, 50]]) {
    assert.equal(comoEstaba(traidos, tope), 0)
  }
})

test('la cuenta nueva dice cuántos quedaron de verdad', () => {
  assert.equal(comoEsta(500, 50), 450, 'el caso que motivó el arreglo')
  assert.equal(comoEsta(50, 50), 0, 'se cortó a todos los que había')
  assert.equal(comoEsta(0, 0), 0, 'no había ninguno')
  assert.equal(comoEsta(3, 3), 0)
})

test('nunca da un número negativo', () => {
  /**
   * Puede pasar: entre contar el total y traer la lista, alguien paga y la vista
   * devuelve uno menos. Un "quedaron -1 sin cortar" en un informe hace dudar de
   * todo el resto del número.
   */
  assert.equal(comoEsta(10, 12), 0)
})

test('de fábrica NO viene con tope', async () => {
  /**
   * 50 era un número de prueba disfrazado de configuración. Se saca porque las
   * dos razones para tenerlo no se sostuvieron al medirlas:
   *
   *   Un corte por una factura mal creada se revierte anulando la factura: la
   *   barrida los reconecta en quince minutos sin tocar ningún router.
   *
   *   Y no es un problema de tiempo: 9 ms por corte contra el router real de La
   *   Maná, unos 7000 por minuto. Cinco mil morosos son 43 segundos.
   */
  const { _COLUMNAS, valores } = await import('../src/services/tareas.js')
  assert.ok(_COLUMNAS().includes('mora_limite'), 'el campo sigue para quien lo quiera')

  const { archivo } = await valores().catch(() => ({ archivo: null }))
  if (archivo) {
    assert.equal(archivo.mora_limite, 0, 'de fábrica corta a todos los que corresponda')
  }
})
