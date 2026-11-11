import test from 'node:test'
import assert from 'node:assert/strict'

import { esVisible, kmlColor, resolverEstilo } from '../../web/src/lib/planta.js'

const capas = new Map([['feeder', { id: 'feeder', color: '#dc2626', tamano: 7, linea: 'solida', opacidad: 1 }]])
const estilos = { 'c:troncal': { color: '#1d4ed8', tamano: 5, linea: 'solida', opacidad: 0.9 } }

test('el estilo: propio > capa > tipo', () => {
  assert.deepEqual(resolverEstilo({ tipo: 'troncal' }, 'c', { capas, estilos }), {
    color: '#1d4ed8', tamano: 5, linea: 'solida', opacidad: 0.9, de: 'tipo',
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
