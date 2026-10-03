import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aBps, limiteSubida, medir, decidir, MARGEN_CIERRE, textoCampana } from '../src/services/subidaSaturada.js'
import { emparejar } from '../src/services/consumoDiario.js'
import { textoAlerta } from '../../web/src/lib/alertas.js'

const MIN = 60_000

test('los límites de RouterOS se leen en cualquier notación', () => {
  assert.equal(aBps('10M'), 10e6)
  assert.equal(aBps('512k'), 512e3)
  assert.equal(aBps('1.5G'), 1.5e9)
  assert.equal(aBps('10000000'), 10e6)
  assert.equal(aBps('0'), 0)
  assert.equal(aBps(''), 0)
  // "subida/bajada": el primero es la subida.
  assert.equal(limiteSubida({ 'max-limit': '10M/50M' }), 10e6)
  assert.equal(limiteSubida({}), 0)
})

test('emparejar deja la cola para poder leer su límite', () => {
  const [l] = emparejar(
    [{ name: 'juan', target: '10.0.0.5/32', bytes: '100/200', 'max-limit': '10M/50M' }],
    [{ id: 'c1', ip: '10.0.0.5' }],
  )
  assert.equal(l.cola['max-limit'], '10M/50M')
  assert.equal(l.subida, 100)
})

const lectura = (subida, extra = {}) => ({
  client_id: 'c1',
  cliente: { id: 'c1', nombre: 'Juan' },
  origen: 'juan',
  subida,
  cola: { 'max-limit': '10M/50M' },
  ...extra,
})

test('la velocidad es el promedio entre dos lecturas', () => {
  const t0 = 1_000_000
  const primera = medir([lectura(0)], new Map(), t0)
  assert.equal(primera.medidas.length, 0, 'la primera solo fija el punto de partida')

  // 9 Mbps durante 5 minutos = 9e6/8 * 300 bytes.
  const bytes = (9e6 / 8) * 300
  const { medidas } = medir([lectura(bytes)], primera.previas, t0 + 5 * MIN)
  assert.equal(medidas[0].mbps, 9)
  assert.equal(medidas[0].limite_mbps, 10)
  assert.equal(medidas[0].pct, 90)
})

test('no mide si el contador volvió atrás, si cambió la cola o si no hay límite', () => {
  const previas = new Map([['c1', { subida: 1000, origen: 'juan', t: 0 }]])
  assert.equal(medir([lectura(10)], previas, 5 * MIN).medidas.length, 0)
  assert.equal(medir([lectura(5000, { origen: '<pppoe-juan>' })], previas, 5 * MIN).medidas.length, 0)
  assert.equal(medir([lectura(5000, { cola: { 'max-limit': '0/0' } })], previas, 5 * MIN).medidas.length, 0)
  // Servidor parado una hora: el promedio diluiría el pico, no se usa.
  assert.equal(medir([lectura(5000)], previas, 60 * MIN).medidas.length, 0)
})

const regla = { umbral: 80, espera_min: 15 }
const medida = (pct) => ({
  client_id: 'c1',
  cliente: { id: 'c1', nombre: 'Juan' },
  mbps: pct / 10,
  limite_mbps: 10,
  pct,
  desde: new Date(0).toISOString(),
})

test('por encima del umbral abre; por debajo no hace nada', () => {
  assert.equal(decidir({ medidas: [medida(85)], abiertos: [], regla }).abrir.length, 1)
  assert.equal(decidir({ medidas: [medida(70)], abiertos: [], regla }).abrir.length, 0)
})

test('un pico que no sostiene la espera se borra, no queda como evidencia', () => {
  const abierto = { id: 'e1', entidad_id: 'c1', empezo_en: new Date(0).toISOString(), detalle: {} }
  const plan = decidir({ medidas: [medida(60)], abiertos: [abierto], regla, ahora: new Date(5 * MIN) })
  assert.deepEqual(plan.borrar, ['e1'])
})

test('cumplida la espera se confirma una sola vez', () => {
  const abierto = { id: 'e1', entidad_id: 'c1', empezo_en: new Date(0).toISOString(), detalle: {} }
  const antes = decidir({ medidas: [medida(90)], abiertos: [abierto], regla, ahora: new Date(10 * MIN) })
  assert.equal(antes.confirmar.length, 0)
  assert.equal(antes.actualizar.length, 1)

  const justo = decidir({ medidas: [medida(90)], abiertos: [abierto], regla, ahora: new Date(15 * MIN) })
  assert.equal(justo.confirmar.length, 1)
  assert.ok(justo.confirmar[0].detalle.confirmado_en)

  const ya = { ...abierto, detalle: justo.confirmar[0].detalle }
  const despues = decidir({ medidas: [medida(90)], abiertos: [ya], regla, ahora: new Date(20 * MIN) })
  assert.equal(despues.confirmar.length, 0, 'no vuelve a sonar la campana')
})

test('uno confirmado se cierra recién con margen, para no titilar', () => {
  const confirmado = {
    id: 'e1',
    entidad_id: 'c1',
    empezo_en: new Date(0).toISOString(),
    detalle: { confirmado_en: new Date(15 * MIN).toISOString(), pico_mbps: 9.5 },
  }
  const ahora = new Date(30 * MIN)
  const apenasDebajo = decidir({ medidas: [medida(75)], abiertos: [confirmado], regla, ahora })
  assert.equal(apenasDebajo.resolver.length, 0)
  assert.equal(apenasDebajo.actualizar[0].detalle.pico_mbps, 9.5, 'el pico se conserva')

  const bajo = decidir({ medidas: [medida(80 - MARGEN_CIERRE - 1)], abiertos: [confirmado], regla, ahora })
  assert.equal(bajo.resolver.length, 1)
})

test('un evento sin muestras por una hora se cierra solo', () => {
  const viejo = { id: 'e1', entidad_id: 'c1', empezo_en: new Date(0).toISOString(), detalle: { medido_en: new Date(0).toISOString() } }
  assert.deepEqual(decidir({ medidas: [], abiertos: [viejo], regla, ahora: new Date(61 * MIN) }).borrar, ['e1'])
  assert.equal(decidir({ medidas: [], abiertos: [viejo], regla, ahora: new Date(30 * MIN) }).borrar.length, 0)
})

test('los textos dicen cuánto sube, contra qué límite, y que no es la red', () => {
  const d = { ultimo_mbps: 9.4, limite_mbps: 10, ultimo_pct: 94, codigo: 123 }
  const wa = textoAlerta({ regla: 'subida_saturada', etiqueta: 'Juan Pérez', empezo_en: new Date(), detalle: d })
  assert.match(wa, /Subida saturada — Juan Pérez \(000123\)/)
  assert.match(wa, /9,4 de 10 Mbps \(94%\)/)
  assert.match(wa, /sale de su casa/)

  const c = textoCampana({ etiqueta: 'Juan Pérez', detalle: d })
  assert.match(c.titulo, /Juan Pérez/)
  assert.match(c.detalle, /9.4 de 10 Mbps/)
})
