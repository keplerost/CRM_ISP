import test from 'node:test'
import assert from 'node:assert/strict'
import { aplicarZona, desfase, esZonaValida, relojDelServidor } from '../src/lib/zonaHoraria.js'

/**
 * La hora con la que corren las tareas.
 *
 * En el VPS el proceso arrancaba en UTC y la facturación de la 01:00 salía a
 * las 20:00 del día anterior en Ecuador. Lo que se prueba es que, con la zona
 * aplicada, `getHours()` —que es lo que preguntan todas las tareas— contesta
 * la hora del ISP.
 */

const TZ_ORIGINAL = process.env.TZ
test.after(() => {
  process.env.TZ = TZ_ORIGINAL
})

// 01:00 UTC del 01/10 = 20:00 del 30/09 en Ecuador.
const INSTANTE = new Date(Date.UTC(2026, 9, 1, 1, 0))

test('con America/Guayaquil, las 01:00 UTC son las 20:00 del día anterior', () => {
  aplicarZona('America/Guayaquil')
  assert.equal(INSTANTE.getHours(), 20)
  assert.equal(INSTANTE.getDate(), 30)
})

test('cambiar la zona se nota en el acto, sin reiniciar', () => {
  aplicarZona('UTC')
  assert.equal(INSTANTE.getHours(), 1)
  aplicarZona('America/Guayaquil')
  assert.equal(INSTANTE.getHours(), 20)
})

test('una zona mal escrita no deja el proceso en UTC: cae a una válida', () => {
  const quedo = aplicarZona('America/Guayaquill')
  assert.ok(esZonaValida(quedo))
  assert.notEqual(quedo, 'America/Guayaquill')
})

test('esZonaValida rechaza lo vacío y lo inventado', () => {
  assert.equal(esZonaValida('America/Lima'), true)
  assert.equal(esZonaValida(''), false)
  assert.equal(esZonaValida(null), false)
  assert.equal(esZonaValida('Ecuador'), false)
})

test('el desfase se escribe como lo lee una persona', () => {
  assert.equal(desfase('America/Guayaquil', INSTANTE), '-05:00')
  assert.equal(desfase('UTC', INSTANTE), '+00:00')
})

test('el reloj dice la zona aplicada y la hora en esa zona', () => {
  aplicarZona('America/Guayaquil')
  const r = relojDelServidor(INSTANTE)
  assert.equal(r.zona, 'America/Guayaquil')
  assert.equal(r.utc, '2026-10-01T01:00:00.000Z')
  assert.match(r.hora_local, /30/)
  assert.match(r.hora_local, /20:00/)
})
