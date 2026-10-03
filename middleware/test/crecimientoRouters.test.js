import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  desdeParaRango,
  finDeMes,
  nombreMes,
  resumirPorRouter,
  totalesPorMes,
} from '../../web/src/lib/crecimientoRouters.js'

const fila = (mes, router_id, extra = {}) => ({
  mes,
  router_id,
  router: router_id ?? 'Sin router asignado',
  altas: 0,
  carga_inicial: 0,
  bajas: 0,
  neto: 0,
  total: 0,
  con_foto: false,
  ...extra,
})

test('el resumen toma el inicio antes del primer mes y el cierre del último', () => {
  const [r] = resumirPorRouter([
    fila('2026-09-01', 'a', { altas: 5, bajas: 2, neto: 3, total: 103 }),
    fila('2026-08-01', 'a', { altas: 10, carga_inicial: 50, bajas: 0, neto: 60, total: 100 }),
  ])
  assert.equal(r.inicio, 40)
  assert.equal(r.fin, 103)
  assert.equal(r.altas, 15)
  assert.equal(r.carga_inicial, 50)
  assert.equal(r.bajas, 2)
  assert.equal(r.variacion, (103 - 40) / 40)
})

test('la foto del resumen es la del último mes que la tiene', () => {
  const [r] = resumirPorRouter([
    fila('2026-08-01', 'a', { con_foto: true, cortados: 9, vencido: '120.50' }),
    fila('2026-09-01', 'a', { con_foto: false }),
  ])
  assert.equal(r.foto.mes, '2026-08-01')
  assert.equal(r.foto.cortados, 9)
  assert.equal(r.foto.vencido, 120.5)
})

test('un mes sin foto deja los morosos en null, no en cero', () => {
  const meses = totalesPorMes([
    fila('2026-08-01', 'a', { total: 10 }),
    fila('2026-09-01', 'a', { total: 12, con_foto: true, cortados: 0, por_cobrar: 0 }),
    fila('2026-09-01', 'b', { total: 5 }),
  ])
  assert.equal(meses[0].cortados, null)
  assert.equal(meses[1].cortados, 0)
  assert.equal(meses[1].total, 17)
})

test('los rangos de meses cruzan el año bien', () => {
  assert.equal(desdeParaRango('2026-02', 3), '2025-12-01')
  assert.equal(desdeParaRango('2026-10', 12), '2025-11-01')
  assert.equal(finDeMes('2026-02'), '2026-02-28')
  assert.equal(finDeMes('2024-02'), '2024-02-29')
  assert.equal(nombreMes('2026-10-01'), 'oct 2026')
})
