import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizarAlcance,
  plantillasDe,
  textoDuracion,
  textoEstimado,
  textoVentana,
} from '../src/services/incidencias.js'
import { calidadOptica } from '../src/services/diagnostico.js'

/**
 * El corte masivo le escribe a cientos de personas y no se puede desenviar.
 *
 * Cada prueba de acá cubre una forma concreta de mandarle el mensaje equivocado
 * a la gente equivocada: el alcance que se resuelve a "todos", el texto con un
 * marcador crudo, el umbral de señal que decide si se manda un técnico.
 */

// --- El alcance: a quiénes se les escribe -----------------------------------

test('una zona se resuelve solo si se dijo cuál', () => {
  const r = normalizarAlcance({ alcance: 'zona', zona: 'EL PROGRESO' })
  assert.equal(r.zona, 'EL PROGRESO')
  // Los demás campos quedan en null: si sobrevivieran de un formulario a medio
  // llenar, la base intentaría resolver por dos caminos a la vez.
  assert.equal(r.punto_id, null)
  assert.equal(r.nodo_id, null)
})

test('una zona vacía se rechaza en vez de alcanzar a todos', () => {
  /**
   * Es el error más caro posible en esta pantalla.
   *
   * Con la zona vacía, la consulta sería `zona = NULL`, que en un padrón recién
   * migrado son casi todos los abonados. Se rechaza acá y además la función de
   * la base vuelve vacía: dos cierres para el mismo agujero, a propósito.
   */
  assert.throws(() => normalizarAlcance({ alcance: 'zona' }), /zona/)
  assert.throws(() => normalizarAlcance({ alcance: 'zona', zona: '   ' }), /zona/)
})

test('cada alcance exige su propio dato', () => {
  assert.throws(() => normalizarAlcance({ alcance: 'punto' }), /caja NAP/)
  assert.throws(() => normalizarAlcance({ alcance: 'nodo' }), /nodo/)
  assert.throws(() => normalizarAlcance({ alcance: 'olt' }), /OLT/)
  assert.throws(() => normalizarAlcance({ alcance: 'router' }), /router/)
  assert.throws(() => normalizarAlcance({ alcance: 'manual' }), /abonado/)
})

test('un alcance inventado no pasa', () => {
  // Sin esto, un alcance desconocido llegaría a la base y ahí se resolvería como
  // "ninguno" —silencioso— o como algo peor el día que se agregue un caso.
  assert.throws(() => normalizarAlcance({ alcance: 'todos' }), /Alcance desconocido/)
  assert.throws(() => normalizarAlcance({}), /Alcance desconocido/)
})

test('el puerto PON es opcional y acota el alcance de la OLT', () => {
  const sinPuerto = normalizarAlcance({ alcance: 'olt', olt_id: 'o1' })
  assert.equal(sinPuerto.puerto_pon, null)

  const conPuerto = normalizarAlcance({ alcance: 'olt', olt_id: 'o1', puerto_pon: '3' })
  assert.equal(conPuerto.puerto_pon, '3')
})

test('la selección manual conserva solo los ids que le dieron', () => {
  const r = normalizarAlcance({ alcance: 'manual', clientes_manual: ['a', 'b'] })
  assert.deepEqual(r.clientes_manual, ['a', 'b'])
  assert.equal(r.zona, null)
})

// --- Qué texto sale ---------------------------------------------------------

test('el mantenimiento programado usa su propia plantilla', () => {
  // Con la de avería, al abonado le llegaría "tenemos una avería" por un corte
  // planificado que se le avisó con dos días de anticipación.
  assert.equal(plantillasDe({ momento: 'apertura', programada: true }).corta, 'sms_mantenimiento_programado')
  assert.equal(plantillasDe({ momento: 'apertura', programada: false }).corta, 'sms_incidencia_abierta')
})

test('la resolución tiene su plantilla, sea programada o no', () => {
  assert.equal(plantillasDe({ momento: 'resolucion', programada: true }).corta, 'sms_incidencia_resuelta')
  assert.equal(plantillasDe({ momento: 'resolucion', programada: false }).corta, 'sms_incidencia_resuelta')
})

test('sin hora estimada sale una frase, nunca un hueco', () => {
  /**
   * "{{estimado}}" crudo en medio de un SMS solo se descubre leyendo un mensaje
   * ya enviado — y para entonces salió a trescientas personas.
   */
  const t = textoEstimado({ momento: 'apertura', estimado_at: null })
  assert.ok(t.length > 0)
  assert.ok(!t.includes('{{'))
  assert.match(t, /trabajando/)
})

test('con hora estimada, la dice', () => {
  const t = textoEstimado({ momento: 'apertura', estimado_at: '2026-08-19T21:30:00Z' })
  assert.match(t, /Estimamos/)
})

test('el aviso de resolución no habla de estimaciones', () => {
  // Ya está solucionado: prometer una hora sería absurdo.
  assert.equal(textoEstimado({ momento: 'resolucion', estimado_at: '2026-08-19T21:30:00Z' }), '')
})

test('la ventana de un mantenimiento se dice aunque falte el final', () => {
  assert.match(textoVentana({ inicio_previsto: '2026-08-20T02:00:00Z' }), /a partir de/)
  assert.match(
    textoVentana({ inicio_previsto: '2026-08-20T02:00:00Z', fin_previsto: '2026-08-20T05:00:00Z' }),
    / a /,
  )
  // Sin ninguna de las dos, una frase que igual se entiende.
  assert.equal(textoVentana({}), 'en las próximas horas')
})

test('la duración se dice en minutos o en horas, según cuánto fue', () => {
  const hace20min = new Date(Date.now() - 20 * 60000).toISOString()
  assert.match(textoDuracion({ ocurrio_at: hace20min }), /^2[01] minutos$/)

  const hace3horas = new Date(Date.now() - 3 * 3600_000).toISOString()
  assert.equal(textoDuracion({ ocurrio_at: hace3horas }), '3 horas')

  const haceUnaHora = new Date(Date.now() - 3600_000).toISOString()
  assert.equal(textoDuracion({ ocurrio_at: haceUnaHora }), '1 hora')
})

// --- El umbral que decide si se manda un técnico ----------------------------

test('la señal óptica se clasifica con los cortes de GPON', () => {
  assert.equal(calidadOptica(-19.5).nivel, 'buena')
  assert.equal(calidadOptica(-25).nivel, 'buena')
  assert.equal(calidadOptica(-26.3).nivel, 'regular')
  assert.equal(calidadOptica(-28).nivel, 'regular')
  // Por debajo de −28 la conexión se cae sola: es visita, no "reiniciá el router".
  assert.equal(calidadOptica(-31.4).nivel, 'mala')
})

test('sin lectura de señal no se inventa un nivel', () => {
  // Un `null` leído como "mala" mandaría un técnico a cada abonado cuya ONT
  // todavía no se midió.
  assert.equal(calidadOptica(null), null)
  assert.equal(calidadOptica(undefined), null)
  assert.equal(calidadOptica('sin dato'), null)
})
