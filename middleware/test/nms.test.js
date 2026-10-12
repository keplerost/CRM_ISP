import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ordenarPorJerarquia,
  evaluar,
  mensajeDe,
  evaluarRouter,
  esSinConexion,
  mensajeDeRouter,
} from '../src/services/nms.js'

/**
 * La lógica que decide si algo está caído y a quién se le avisa.
 *
 * Es la parte del monitoreo que no se puede probar contra la red: para ver el
 * caso que importa —una torre que cae y arrastra veinte antenas— habría que
 * cortarle la fibra a una torre de verdad.
 */

// --- Orden del árbol ---------------------------------------------------------

const TORRE = { id: 't', nombre: 'Torre Centro', padre_id: null }
const SECTOR = { id: 's', nombre: 'Sector Norte', padre_id: 't' }
const CPE = { id: 'c', nombre: 'CPE 42', padre_id: 's' }
const SUELTO = { id: 'x', nombre: 'Enlace PTP', padre_id: null }

test('los padres se sondean antes que los hijos', () => {
  // Si el hijo se evalúa primero, el padre todavía figura arriba y la caída del
  // hijo se reporta como propia: veinte alertas por un solo corte de fibra.
  const orden = ordenarPorJerarquia([CPE, TORRE, SECTOR]).map((n) => n.id)
  assert.deepEqual(orden, ['t', 's', 'c'])
})

test('los nodos del mismo nivel salen por nombre', () => {
  const orden = ordenarPorJerarquia([SUELTO, TORRE]).map((n) => n.nombre)
  assert.deepEqual(orden, ['Enlace PTP', 'Torre Centro'])
})

test('un ciclo de carga no cuelga el sondeo', () => {
  // "A es padre de B y B es padre de A" es un error de carga que la base no
  // puede prohibir sin un disparador recursivo. Acá no puede colgar el bucle.
  const a = { id: 'a', nombre: 'A', padre_id: 'b' }
  const b = { id: 'b', nombre: 'B', padre_id: 'a' }
  const r = ordenarPorJerarquia([a, b])
  assert.equal(r.length, 2)
})

test('un padre que no existe no rompe el orden', () => {
  // Pasa al borrar un nodo: el hijo queda apuntando a nada.
  const huerfano = { id: 'h', nombre: 'Huérfano', padre_id: 'no-existe' }
  const r = ordenarPorJerarquia([huerfano, TORRE])
  assert.equal(r.length, 2)
})

test('una lista vacía devuelve una lista vacía', () => {
  assert.deepEqual(ordenarPorJerarquia([]), [])
})

// --- Evaluación de una medición ----------------------------------------------

const NODO = { latencia_warning_ms: 150, perdida_warning_pct: 20 }

test('todo responde y rápido: up', () => {
  const r = evaluar({ enviados: 4, recibidos: 4, latencia_ms: 12 }, NODO)
  assert.equal(r.estado, 'up')
  assert.equal(r.perdida_pct, 0)
})

test('nada responde: down', () => {
  const r = evaluar({ enviados: 4, recibidos: 0, latencia_ms: null }, NODO)
  assert.equal(r.estado, 'down')
  assert.equal(r.perdida_pct, 100)
})

test('responde pero con pérdida alta: warning, no down', () => {
  // El enlace está. Decir "caído" mandaría un técnico a buscar un corte que no
  // existe.
  const r = evaluar({ enviados: 4, recibidos: 3, latencia_ms: 20 }, NODO)
  assert.equal(r.estado, 'warning')
  assert.equal(r.perdida_pct, 25)
})

test('responde pero lento: warning', () => {
  const r = evaluar({ enviados: 4, recibidos: 4, latencia_ms: 300 }, NODO)
  assert.equal(r.estado, 'warning')
})

test('cada nodo tiene su propio umbral', () => {
  // Un PTP de 60 GHz a 2 ms y una sectorial saturada a 120 ms son las dos cosas
  // normales. Con un umbral único habría que elegir cuál ignorar.
  const medicion = { enviados: 4, recibidos: 4, latencia_ms: 120 }
  assert.equal(evaluar(medicion, { latencia_warning_ms: 50, perdida_warning_pct: 20 }).estado, 'warning')
  assert.equal(evaluar(medicion, { latencia_warning_ms: 200, perdida_warning_pct: 20 }).estado, 'up')
})

test('no haber podido preguntar no es estar caído', () => {
  // Si el router intermedio no contestó, no se sabe nada del nodo. Reportarlo
  // como caído mandaría un técnico a una torre que está perfecta.
  const r = evaluar({ enviados: 0, recibidos: 0, latencia_ms: null }, NODO)
  assert.equal(r.estado, 'desconocido')
  assert.equal(r.perdida_pct, null)
})

// --- El aviso ----------------------------------------------------------------

const CUANDO = '2026-08-02T14:35:20.000Z'

test('el aviso de caída dice qué, dónde y desde cuándo', () => {
  const t = mensajeDe({ nombre: 'Torre Centro', ip: '10.0.0.1', punto: 'Cerro Alto' }, 'down', CUANDO)
  assert.match(t, /CAÍDO/)
  assert.match(t, /Torre Centro/)
  assert.match(t, /Cerro Alto/)
  assert.match(t, /10\.0\.0\.1/)
  assert.match(t, /Desde:/)
})

test('el de recuperación dice cuánto estuvo caído', () => {
  const t = mensajeDe({ nombre: 'Torre Centro', ip: '10.0.0.1' }, 'up', CUANDO, 47)
  assert.match(t, /RECUPERADO/)
  assert.match(t, /47 min/)
})

test('un nodo sin punto cargado no deja un separador suelto', () => {
  const t = mensajeDe({ nombre: 'PTP Norte', ip: '10.0.0.9' }, 'down', CUANDO)
  assert.ok(!t.includes(' · \n'), t)
  assert.match(t, /10\.0\.0\.9/)
})

// --- El router que no contesta ----------------------------------------------

const T0 = '2026-10-12T17:00:00.000Z'
const mas = (min) => new Date(Date.parse(T0) + min * 60_000).toISOString()
const sano = { conexion_estado: 'up', conexion_fallas: 0, conexion_desde: T0, conexion_chequeo: T0 }

/** Corre varias pasadas seguidas, cada dos minutos, como la tarea. */
function pasadas(router, resultados, { umbral = 3, enGracia = false } = {}) {
  let r = router
  const avisos = []
  resultados.forEach((contesto, i) => {
    const ahora = mas((i + 1) * 2)
    const { aviso, ...cols } = evaluarRouter(r, { contesto, ahora, enGracia, umbral })
    r = { ...cols, conexion_chequeo: ahora }
    avisos.push(aviso)
  })
  return { r, avisos }
}

test('el router: una o dos fallas no avisan; la tercera seguida sí', () => {
  const { r, avisos } = pasadas(sano, [false, false, false])
  assert.deepEqual(avisos, [null, null, 'down'])
  assert.equal(r.conexion_estado, 'down')
  // La hora de la caída es la primera falla, no la que la confirmó.
  assert.equal(r.conexion_desde, mas(2))
})

test('el router: una falla suelta y vuelve, no avisa nada y la cuenta se reinicia', () => {
  const { r, avisos } = pasadas(sano, [false, true, false, false, true])
  assert.deepEqual(avisos, [null, null, null, null, null])
  assert.equal(r.conexion_estado, 'up')
  assert.equal(r.conexion_fallas, 0)
  assert.equal(r.conexion_desde, T0)
})

test('el router: caído avisa una sola vez, y avisa cuando vuelve', () => {
  const { r, avisos } = pasadas(sano, [false, false, false, false, false, true])
  assert.deepEqual(avisos, [null, null, 'down', null, null, 'up'])
  assert.equal(r.conexion_estado, 'up')
  assert.equal(r.conexion_desde, mas(12))
})

test('el router: en la gracia de arranque no se cuenta ninguna falla', () => {
  const { r, avisos } = pasadas(sano, [false, false, false, false], { enGracia: true })
  assert.deepEqual(avisos, [null, null, null, null])
  assert.equal(r.conexion_estado, 'up')
  assert.equal(r.conexion_fallas, 0)
})

test('el router: si contesta durante la gracia, todo sigue normal', () => {
  const { avisos } = pasadas(sano, [true, true], { enGracia: true })
  assert.deepEqual(avisos, [null, null])
})

test('el router: un reinicio no vuelve a avisar lo que ya estaba avisado', () => {
  // El estado viene de la base: ya estaba caído antes del reinicio.
  const caido = { conexion_estado: 'down', conexion_fallas: 5, conexion_falla_en: T0, conexion_desde: T0, conexion_chequeo: T0 }
  assert.deepEqual(pasadas(caido, [false, false], { enGracia: true }).avisos, [null, null])
  assert.deepEqual(pasadas(caido, [false, false]).avisos, [null, null])
  // Y si volvió mientras el servidor estaba apagado, eso sí se avisa.
  assert.deepEqual(pasadas(caido, [true], { enGracia: true }).avisos, ['up'])
})

test('el router: apretar "Sondear ahora" seguido no suma fallas de golpe', () => {
  const unaFalla = { ...sano, conexion_fallas: 1, conexion_falla_en: T0, conexion_chequeo: T0 }
  const r = evaluarRouter(unaFalla, { contesto: false, ahora: mas(0.5), enGracia: false, umbral: 2 })
  assert.equal(r.conexion_fallas, 1)
  assert.equal(r.aviso, null)
})

test('el router: una clave mal cargada no es un router caído', () => {
  assert.equal(esSinConexion({ status: 401 }), false)
  assert.equal(esSinConexion({ status: 504 }), true)
  assert.equal(esSinConexion({ status: 502 }), true)
  assert.equal(esSinConexion(new Error('socket hang up')), true)
})

test('el aviso del router no afirma más de lo que se sabe', () => {
  const r = { nombre: 'RB_LOS_RIOS', ip_host: '10.66.0.11' }
  const caido = mensajeDeRouter(r, 'down', { cuando: T0, afectados: 27 })
  assert.match(caido, /SIN CONEXIÓN — RB_LOS_RIOS/)
  assert.match(caido, /la VPN o el internet del servidor/)
  assert.match(caido, /27 abonados/)
  assert.match(mensajeDeRouter(r, 'up', { cuando: T0, minutos: 14.6 }), /RECUPERADA[\s\S]*15 min/)
})
