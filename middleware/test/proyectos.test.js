import test from 'node:test'
import assert from 'node:assert/strict'

import { delProyecto, listaMateriales, metasDelProyecto } from '../../web/src/lib/proyectos.js'

const diseno = {
  elementos: [
    { tipo: 'nap', capacidad: 16, estado: 'proyectado' },
    { tipo: 'nap', capacidad: 16, estado: 'proyectado' },
    { tipo: 'nap', capacidad: 8, estado: 'proyectado' },
    { tipo: 'manga', hilos: 24, estado: 'proyectado' },
    { tipo: 'poste', herraje: 'A', estado: 'proyectado' },
    { tipo: 'poste', herraje: 'J', estado: 'proyectado' },
    { tipo: 'poste', estado: 'proyectado' },
    { tipo: 'reserva', metros: 30, estado: 'proyectado' },
  ],
  cables: [
    { tipo: 'distribucion', hilos: 12, longitud_m: 1000 },
    { tipo: 'distribucion', hilos: 12, longitud_m: 500 },
    { tipo: 'troncal', hilos: 48, longitud_m: 2000 },
    { tipo: 'drop', hilos: 2, longitud_m: 100 },
  ],
  splitters: [{ relacion: '1:8' }, { relacion: '1:16' }, { relacion: '1:16' }],
  uniones: [{ tipo: 'fusion' }, { tipo: 'fusion' }, { tipo: 'conector' }],
}

test('la lista de materiales: cable con reserva, cajas por puertos, herrajes, fusiones', () => {
  const l = listaMateriales(diseno, { reservaPct: 10 })
  const de = (d) => l.find((f) => f.descripcion === d)?.cantidad
  assert.equal(de('Cable de fibra de distribución 12 hilos'), 1650) // 1500 + 10%
  assert.equal(de('Cable de fibra troncal 48 hilos'), 2200)
  assert.equal(de('Cable drop 2 hilos'), 110)
  assert.equal(de('Fibra para reservas'), 30)
  assert.equal(de('Caja NAP 16 puertos'), 2)
  assert.equal(de('Caja NAP 8 puertos'), 1)
  assert.equal(de('Manga de empalme 24 hilos'), 1)
  assert.equal(de('Splitter 1:16'), 2)
  assert.equal(de('Poste nuevo'), 3)
  assert.equal(de('Herraje de retención (A)'), 1)
  assert.equal(de('Herraje de suspensión (J)'), 1)
  assert.equal(de('Herraje (definir A o J)'), 1)
  assert.equal(de('Fusiones'), 2)
  assert.equal(de('Conectores'), 1)
  // Ordenada por grupo: cable primero.
  assert.equal(l[0].grupo, 'Cable')
})

test('el alcance de la obra, del diseño', () => {
  assert.deepEqual(metasDelProyecto(diseno), {
    meta_metros: 3500, // sin el drop
    meta_naps: 3,
    meta_fusiones: 2,
    meta_mangas: 1,
    meta_postes: 3,
    meta_puertos: 40,
  })
})

test('lo de un proyecto, de todas las listas', () => {
  const d = delProyecto('P', {
    elementos: [{ proyecto_id: 'P' }, { proyecto_id: 'Q' }, {}],
    cables: [{ proyecto_id: 'P' }],
    splitters: [],
    uniones: [{ proyecto_id: 'Q' }],
  })
  assert.deepEqual([d.elementos.length, d.cables.length, d.uniones.length], [1, 1, 0])
})
