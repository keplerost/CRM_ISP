import test from 'node:test'
import assert from 'node:assert/strict'

import { diasParaMeta, leerIndicadores, peor, periodo, progresoMetas, semaforo } from '../../web/src/lib/obras.js'

test('el semáforo: arriba o abajo de la meta, con margen amarillo', () => {
  assert.equal(semaforo(95, 90), 'bien')
  assert.equal(semaforo(85, 90), 'atencion')
  assert.equal(semaforo(70, 90), 'mal')
  assert.equal(semaforo(null, 90), 'sin_datos')
  // Menor es mejor: el desvío de material.
  assert.equal(semaforo(5, 10, { mayorEsMejor: false }), 'bien')
  assert.equal(semaforo(15, 10, { mayorEsMejor: false }), 'atencion')
  assert.equal(semaforo(30, 10, { mayorEsMejor: false }), 'mal')
})

test('el peor de dos semáforos no se deja engañar por el que no tiene datos', () => {
  assert.equal(peor('bien', 'mal'), 'mal')
  assert.equal(peor('sin_datos', 'atencion'), 'atencion')
  assert.equal(peor('bien', 'sin_datos'), 'bien')
})

test('el progreso muestra solo las metas que la obra tiene, y la NAP registrada cuenta', () => {
  const p = progresoMetas({
    meta_metros: 1000, hecho_metros: 600,
    meta_naps: 4, hecho_naps: 1, naps_registradas: 3,
    meta_fusiones: 0, hecho_fusiones: 5,
  })
  assert.deepEqual(p.map((m) => [m.clave, m.hecho, m.pct]), [['metros', 600, 60], ['naps', 3, 75]])
  // Pasarse de la meta no da más de 100.
  assert.equal(progresoMetas({ meta_metros: 100, hecho_metros: 250 })[0].pct, 100)
})

test('días para la meta: negativo es atrasada', () => {
  assert.equal(diasParaMeta('2026-11-15', '2026-11-10'), 5)
  assert.equal(diasParaMeta('2026-11-08', '2026-11-10'), -2)
  assert.equal(diasParaMeta(null, '2026-11-10'), null)
})

test('los períodos rápidos', () => {
  // 10/11/2026 es martes.
  assert.deepEqual(periodo('semana', '2026-11-10'), { desde: '2026-11-09', hasta: '2026-11-10' })
  assert.deepEqual(periodo('semana_pasada', '2026-11-10'), { desde: '2026-11-02', hasta: '2026-11-08' })
  assert.deepEqual(periodo('mes', '2026-11-10'), { desde: '2026-11-01', hasta: '2026-11-10' })
  assert.deepEqual(periodo('mes_pasado', '2026-11-10'), { desde: '2026-10-01', hasta: '2026-10-31' })
})

test('los ocho indicadores con sus semáforos', () => {
  const cfg = { potencia_min_dbm: -22, perdida_fusion_max_db: 0.1, merma_max_pct: 10, apoyo_max_pct: 35, dias_fallas: 30, meta_a_tiempo_pct: 90, meta_metros_dia: 0 }
  const k = leerIndicadores(
    {
      produccion: { metros: 900, naps: 2, fusiones: 10, mangas: 0, postes: 0, puertos: 0, dias: 2, metros_dia: 450 },
      plan: { entregadas: 1, a_tiempo: 1, abiertas: 0, atrasadas: 0 },
      calidad: { naps_medidas: 2, naps_ok: 1, potencia_promedio: -21.75, perdida_promedio: 0.11, dias_fusion_ok: 1, dias_fusion_medidos: 2 },
      fallas: { obras: 1, naps: 2, fallas: 1, clientes_conectados: 1, puertos: 32, dias: 30 },
      material: { lineas: 1, desvio_pct: 12.5, lineas_excedidas: 1, extras: 1 },
      documentacion: { dias: 2, dias_con_foto: 1, revisadas: 1, a_la_primera: 0, devoluciones: 1 },
      seguridad: { partes: 2, con_epp: 1, incidentes: 0 },
      apoyo: { tickets: 1, dias_tickets: 1, dias_obra: 2, pct: 25 },
    },
    cfg,
  )
  const e = Object.fromEntries(k.map((x) => [x.clave, x.estado]))
  assert.equal(k.length, 8)
  assert.equal(e.produccion, 'bien')
  assert.equal(e.plan, 'bien')
  assert.equal(e.calidad, 'mal', 'la mitad de las NAP bajo la meta')
  assert.equal(e.fallas, 'atencion', 'una falla en dos NAP')
  assert.equal(e.material, 'atencion')
  assert.equal(e.documentacion, 'mal', 'devuelta y la mitad de los días sin foto')
  assert.equal(e.seguridad, 'mal', 'un parte sin EPP')
  assert.equal(e.apoyo, 'bien')

  // Un incidente siempre es rojo; sin obras entregadas, las fallas no tienen datos.
  const k2 = leerIndicadores({ seguridad: { partes: 5, con_epp: 5, incidentes: 1 }, fallas: { obras: 0 } }, cfg)
  assert.equal(k2.find((x) => x.clave === 'seguridad').estado, 'mal')
  assert.equal(k2.find((x) => x.clave === 'fallas').estado, 'sin_datos')
})
