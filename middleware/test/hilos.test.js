import test from 'node:test'
import assert from 'node:assert/strict'

import {
  armarRed,
  cadenamiento,
  colorHilo,
  compararMedido,
  perdidaSplitter,
  presupuestoCaja,
  trazarDesdePon,
  trazarHaciaPon,
} from '../../web/src/lib/hilos.js'

/*
 * La red de prueba, de norte a sur sobre el mismo meridiano (0,001° ≈ 111 m):
 *
 *   NODO ──feeder 12h (≈1110 m)── MANGA ──distribución 2h (≈555 m)── NAP-A
 *     PON1 → hilo 1                 hilo 1 → splitter 1:8
 *                                   salida 3 → dist hilo 1          hilo 1 → splitter 1:8 (de la NAP)
 *
 *   NODO ──troncal 24h (≈2220 m) pasa por MANGA2 (a mitad de camino) y sigue
 *     PON2 → hilo 2                 en MANGA2 el hilo 2 se corta: el lado 'd'
 *                                   va al splitter 1:16 de la caja NAP-B (ahí mismo)
 */
const E = (id, tipo, lat) => ({ id, tipo, nombre: id, latitud: lat, longitud: -79.22 })
const elementos = [E('NODO', 'nodo', -0.93), E('MANGA', 'manga', -0.94), E('NAP-A', 'nap', -0.945), E('NAP-B', 'nap', -0.94)]
const cables = [
  { id: 'FEEDER', nombre: 'Feeder', hilos: 12, ruta: [[-0.93, -79.22], [-0.94, -79.22]], desde_id: 'NODO', hasta_id: 'MANGA' },
  { id: 'DIST', nombre: 'Dist', hilos: 2, ruta: [[-0.94, -79.22], [-0.945, -79.22]], desde_id: 'MANGA', hasta_id: 'NAP-A' },
  // Sin extremos cargados (como lo deja el KMZ): se deduce por dónde empieza.
  { id: 'TRONCAL', nombre: 'Troncal', hilos: 24, ruta: [[-0.93, -79.22], [-0.95, -79.22]] },
]
const splitters = [
  { id: 'S-MANGA', elemento_id: 'MANGA', relacion: '1:8' },
  { id: 'S-NAPA', elemento_id: 'NAP-A', relacion: '1:8' },
  { id: 'S-NAPB', elemento_id: 'NAP-B', relacion: '1:16' },
]
const pons = [
  { id: 'PON1', elemento_id: 'NODO', nombre: 'OLT 0/1/1', tx_dbm: 3 },
  { id: 'PON2', elemento_id: 'NODO', nombre: 'OLT 0/1/2', tx_dbm: 3 },
]
const U = (elemento_id, a, b, tipo = 'fusion') => ({
  elemento_id,
  a_tipo: a[0], a_id: a[1], a_num: a[2] ?? null, a_lado: a[3] ?? null,
  b_tipo: b[0], b_id: b[1], b_num: b[2] ?? null, b_lado: b[3] ?? null,
  tipo,
})
const uniones = [
  U('NODO', ['pon', 'PON1'], ['hilo', 'FEEDER', 1], 'conector'),
  U('MANGA', ['hilo', 'FEEDER', 1], ['splitter', 'S-MANGA', 0]),
  U('MANGA', ['splitter', 'S-MANGA', 3], ['hilo', 'DIST', 1]),
  U('NAP-A', ['hilo', 'DIST', 1], ['splitter', 'S-NAPA', 0]),
  U('NODO', ['pon', 'PON2'], ['hilo', 'TRONCAL', 2], 'conector'),
  U('NAP-B', ['hilo', 'TRONCAL', 2, 'd'], ['splitter', 'S-NAPB', 0]),
]
const red = () => armarRed({ elementos, cables, splitters, pons, uniones })

test('los colores TIA-598, por tubo', () => {
  assert.equal(colorHilo(1).etiqueta, 'T1 azul · hilo azul')
  assert.equal(colorHilo(5).nombre, 'gris')
  assert.equal(colorHilo(14, 12).etiqueta, 'T2 naranja · hilo naranja')
  assert.equal(colorHilo(7, 6).etiqueta, 'T2 naranja · hilo azul') // 4X6
})

test('la pérdida de los splitters, balanceados y desbalanceados', () => {
  assert.equal(perdidaSplitter('1:8'), 10.5)
  assert.equal(perdidaSplitter('1:16'), 13.7)
  assert.equal(perdidaSplitter('10/90', 1), 10.4)
  assert.equal(perdidaSplitter('10/90', 2), 0.86)
  assert.equal(perdidaSplitter('1:8', 1, 11.2), 11.2)
})

test('el cadenamiento: a cuántos metros del inicio cae una caja', () => {
  const c = cadenamiento([[-0.93, -79.22], [-0.95, -79.22]], [-0.94, -79.2201])
  assert.ok(Math.abs(c.c - 1112) < 5, String(c.c))
  assert.ok(c.d < 15)
})

test('el presupuesto de una caja: del splitter de la NAP hasta el PON', () => {
  const p = presupuestoCaja(red(), 'NAP-A')
  assert.equal(p.ok, true, p.error)
  assert.equal(p.pon.id, 'PON1')
  // conector 0,5 + fibra 1,112 km·0,35 + fusión 0,1 + 1:8 10,5 + fusión 0,1 + fibra 0,556·0,35 + fusión 0,1
  assert.ok(Math.abs(p.perdidaEntrada - 11.88) < 0.02, String(p.perdidaEntrada))
  // + el 1:8 de la propia caja
  assert.ok(Math.abs(p.rxSalida - (3 - 11.88 - 10.5)) < 0.02, String(p.rxSalida))
  assert.equal(p.estado, 'bien')
  assert.deepEqual(p.pasos.map((x) => x.tipo), ['fusion', 'fibra', 'fusion', 'splitter', 'fusion', 'fibra', 'conector'])
})

test('la sangría: el hilo cortado a mitad del troncal se sigue hacia el inicio', () => {
  const p = presupuestoCaja(red(), 'NAP-B')
  assert.equal(p.ok, true, p.error)
  assert.equal(p.pon.id, 'PON2')
  const fibra = p.pasos.find((x) => x.tipo === 'fibra')
  assert.ok(Math.abs(fibra.metros - 1112) < 5, String(fibra.metros))
})

test('lo que falta se dice: hilo sin unir, entrada al revés, lado sin decir', () => {
  const r = armarRed({ elementos, cables, splitters, pons, uniones: uniones.filter((u) => u.a_id !== 'PON1') })
  const p = presupuestoCaja(r, 'NAP-A')
  assert.equal(p.ok, false)
  assert.match(p.error, /no está unido en ninguna otra caja hacia el inicio|no está unido a nada/)

  const sinLado = uniones.map((u) => (u.elemento_id === 'NAP-B' ? { ...u, a_lado: null } : u))
  const p2 = presupuestoCaja(armarRed({ elementos, cables, splitters, pons, uniones: sinLado }), 'NAP-B')
  assert.match(p2.error, /pasa de largo: decí hacia qué lado sigue el hilo 2/)

  // Desde una SALIDA el camino va hacia adelante y termina en la entrada de
  // la NAP: eso es ir al revés, y se dice.
  const t = trazarHaciaPon(red(), 'MANGA', { tipo: 'splitter', id: 'S-MANGA', num: 3 })
  assert.equal(t.ok, false)
  assert.match(t.error, /En NAP-A se llegó a la ENTRADA de un splitter/)
  assert.equal(presupuestoCaja(red(), 'MANGA').ok, true)
  assert.equal(presupuestoCaja(red(), 'NODO').error, 'La caja no tiene splitter cargado.')
})

test('desde el PON: qué hilos ocupa y a qué cajas llega', () => {
  const d = trazarDesdePon(red(), 'PON1')
  assert.deepEqual(d.hilos.map((h) => `${h.cable}:${h.num}`), ['FEEDER:1', 'DIST:1'])
  assert.deepEqual(d.cajas.map((c) => c.elemento), ['NAP-A'])
  assert.ok(Math.abs(d.cajas[0].rxSalida - (3 - 11.88 - 10.5)) < 0.02)
  assert.deepEqual(trazarDesdePon(red(), 'PON2').cajas.map((c) => c.elemento), ['NAP-B'])
})

test('lo medido contra lo calculado', () => {
  const p = presupuestoCaja(red(), 'NAP-A')
  assert.equal(compararMedido(p, p.rxSalida - 1).alerta, false)
  assert.equal(compararMedido(p, p.rxSalida - 4.5).alerta, true)
  assert.equal(compararMedido(p, null), null)
})
