import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLAVES,
  MARCA,
  comentario,
  comentarioHeredado,
  esNuestra,
  hayQueRenombrar,
} from '../src/lib/marcaReglas.js'

/**
 * La firma con la que el sistema marca sus reglas en un MikroTik.
 *
 * ── Qué se protege ──
 *
 * Que el renombre de la marca no deje huérfanas las reglas ya instaladas.
 *
 * El sistema reconoce lo suyo por el comentario de la regla. Si dejara de
 * reconocer la firma vieja, en cada router con reglas puestas haría lo peor
 * posible: crear una segunda regla igual, y perder de vista la primera — que
 * sigue ahí, cortando gente, fuera del control del sistema.
 *
 * Por eso `esNuestra` acepta las dos firmas y `comentario` escribe solo la
 * nueva. Un test que se rompa acá casi seguro está avisando de eso.
 */

test('las reglas nuevas se firman con la marca actual', () => {
  assert.equal(comentario('corte'), 'ZenithCore-CorteMorosos')
  assert.equal(comentario('redireccion'), 'ZenithCore-RedireccionPago')
  assert.equal(comentario('corteV6Salida'), 'ZenithCore-CorteMorosos-v6-salida')
  assert.equal(comentario('corteV6Entrada'), 'ZenithCore-CorteMorosos-v6-entrada')
})

test('se siguen reconociendo las reglas firmadas con el nombre viejo', () => {
  // Lo que hay hoy en los equipos que ya están en la calle.
  for (const clave of CLAVES) {
    assert.ok(esNuestra(comentarioHeredado(clave), clave), `no reconoce la vieja de ${clave}`)
  }
})

test('se reconocen también las nuevas', () => {
  for (const clave of CLAVES) {
    assert.ok(esNuestra(comentario(clave), clave), `no reconoce la nueva de ${clave}`)
  }
})

test('una regla ajena no se toma por propia', () => {
  // Un router con WispHub tiene sus propias reglas de corte. Confundirlas con
  // las nuestras sería peor que no encontrar ninguna: el sistema daría por
  // configurado un equipo que no lo está, o peor, las modificaría.
  for (const ajena of [
    'WispHub - Bloquear puerto WebProxy desde WANs',
    'CorteMorosos',
    'ZenithCore',
    'ZenithCore-OtraCosa',
    'algo ZenithCore-CorteMorosos algo',
    '',
    null,
    undefined,
  ]) {
    assert.equal(esNuestra(ajena, 'corte'), false, `tomó por propia: ${ajena}`)
  }
})

test('no confunde una regla nuestra con otra regla nuestra', () => {
  // La de corte y la de redirección conviven en el mismo router, en cadenas
  // distintas. Buscar una y encontrar la otra daría por puesta la que falta.
  assert.equal(esNuestra(comentario('redireccion'), 'corte'), false)
  assert.equal(esNuestra(comentario('corte'), 'redireccion'), false)
  assert.equal(esNuestra(comentario('corteV6Salida'), 'corteV6Entrada'), false)
})

test('la v6 de salida y la de entrada no se confunden entre sí', () => {
  // Comparten prefijo: `...CorteMorosos-v6-salida` y `...-v6-entrada`. Una
  // comparación por "empieza con" las daría por la misma y dejaría el corte
  // IPv6 a medias — el abonado seguiría recibiendo tráfico.
  assert.ok(esNuestra('ZenithCore-CorteMorosos-v6-salida', 'corteV6Salida'))
  assert.equal(esNuestra('ZenithCore-CorteMorosos-v6-salida', 'corteV6Entrada'), false)
})

test('solo hay que renombrar lo que tiene la firma vieja', () => {
  assert.ok(hayQueRenombrar('SmartOLT-CorteMorosos', 'corte'))
  assert.equal(hayQueRenombrar('ZenithCore-CorteMorosos', 'corte'), false)
  assert.equal(hayQueRenombrar('WispHub - lo que sea', 'corte'), false)
})

test('renombrar es idempotente: lo ya renombrado no se vuelve a tocar', () => {
  // Cada `configurar` de un equipo pasa por acá. Si esto devolviera true sobre
  // la firma nueva, cada pasada escribiría en el router sin motivo.
  const yaHecha = comentario('corte')
  assert.equal(hayQueRenombrar(yaHecha, 'corte'), false)
  assert.ok(esNuestra(yaHecha, 'corte'))
})

test('la marca suelta no lleva guion ni sufijo', () => {
  // Se usa como comentario por defecto de una cola, donde no identifica nada.
  assert.equal(MARCA, 'ZenithCore')
})
