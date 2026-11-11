import test from 'node:test'
import assert from 'node:assert/strict'

import { esVisible, kmlColor, resolverEstilo } from '../../web/src/lib/planta.js'

const capas = new Map([['feeder', { id: 'feeder', color: '#dc2626', tamano: 7, linea: 'solida', opacidad: 1 }]])
const estilos = { 'c:troncal': { color: '#1d4ed8', tamano: 5, linea: 'solida', opacidad: 0.9 } }

test('el estilo: propio > capa > tipo', () => {
  assert.deepEqual(resolverEstilo({ tipo: 'troncal' }, 'c', { capas, estilos }), {
    icono: null, color: '#1d4ed8', tamano: 5, linea: 'solida', opacidad: 0.9, de: 'tipo',
  })
  const enCapa = resolverEstilo({ tipo: 'troncal', capa_id: 'feeder' }, 'c', { capas, estilos })
  assert.deepEqual([enCapa.color, enCapa.tamano, enCapa.de], ['#dc2626', 7, 'capa'])
  const propio = resolverEstilo({ tipo: 'troncal', capa_id: 'feeder', color: '#00ff00', tamano: '9', linea: 'rayada' }, 'c', { capas, estilos })
  assert.deepEqual([propio.color, propio.tamano, propio.linea, propio.de], ['#00ff00', 9, 'rayada', 'propio'])
  // Sin tabla de estilos, los de siempre.
  assert.equal(resolverEstilo({ tipo: 'nap' }, 'e').color, '#f59e0b')
  // Un hilo suelto, con el color de su hilo.
  assert.equal(resolverEstilo({ tipo: 'hilo', color_hilo: 'verde' }, 'c').color, '#16a34a')
})

test('el color KML es aabbggrr', () => {
  assert.equal(kmlColor('#dc2626', 1), 'ff2626dc')
  assert.equal(kmlColor('#1d4ed8', 0.5), '80d84e1d')
})

test('visible: el que está en una capa sigue a la capa; el suelto, a su tipo', () => {
  const sw = { 'k:feeder': false, 'c:troncal': true }
  assert.equal(esVisible({ tipo: 'troncal', capa_id: 'feeder' }, 'c', sw, capas), false)
  assert.equal(esVisible({ tipo: 'troncal' }, 'c', sw, capas), true)
  // Una capa que ya no existe: vuelve a su tipo.
  assert.equal(esVisible({ tipo: 'troncal', capa_id: 'borrada' }, 'c', sw, capas), true)
})

test('el ícono: propio > capa > tipo, y el poste con herraje lleva su letra', () => {
  assert.equal(resolverEstilo({ tipo: 'nap' }, 'e').icono, 'nap')
  assert.equal(resolverEstilo({ tipo: 'poste', herraje: 'J' }, 'e').icono, 'poste_j')
  const k = new Map([['c1', { id: 'c1', clase: 'elemento', color: '#111111', tamano: 4, icono: 'poste_hormigon' }]])
  assert.equal(resolverEstilo({ tipo: 'poste', herraje: 'A', capa_id: 'c1' }, 'e', { capas: k }).icono, 'poste_hormigon')
  assert.equal(resolverEstilo({ tipo: 'poste', capa_id: 'c1', icono: 'torre' }, 'e', { capas: k }).icono, 'torre')
  assert.equal(resolverEstilo({ tipo: 'troncal' }, 'c').icono, null)
})

test('el catálogo de íconos: todos dibujan, el color se valida', async () => {
  const { ICONOS, svgIcono, archivoIcono } = await import('../../web/src/lib/iconos.js')
  assert.ok(Object.keys(ICONOS).length >= 30)
  for (const k of Object.keys(ICONOS)) {
    const s = svgIcono(k, '#dc2626', 24)
    assert.match(s, /^<svg [^>]+viewBox="0 0 32 32">.+<\/svg>$/, k)
    assert.match(s, /#dc2626/, k)
  }
  // Un color que no es #RRGGBB no entra al SVG.
  assert.doesNotMatch(svgIcono('nap', '"><script>'), /script/)
  assert.equal(archivoIcono('nap', '#DC2626'), 'iconos/nap-dc2626.png')
})
