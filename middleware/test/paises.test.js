import test from 'node:test'
import assert from 'node:assert/strict'
import { PAISES, PAIS_POR_DEFECTO, perfilDe } from '../src/lib/paises.js'
import { esZonaValida } from '../src/lib/zonaHoraria.js'
import { ivaValido } from '../src/lib/iva.js'

/**
 * El catálogo de países.
 *
 * Lo que se protege es que elegir cualquier país deje al sistema en un estado
 * que funcione: una zona horaria que Node no reconoce deja las tareas en UTC
 * sin avisar, y un país sin nombre de documento deja el alta del cliente con
 * un desplegable vacío.
 */

test('cada país trae todo lo que la pantalla usa', () => {
  for (const p of PAISES) {
    for (const campo of ['codigo', 'nombre', 'impuesto', 'ente', 'regulador', 'moneda', 'zona', 'documentos', 'modulos']) {
      assert.ok(p[campo] != null, `${p.codigo} no tiene ${campo}`)
    }
    for (const rol of ['05', '04', '06', '07', '08']) {
      assert.ok(p.documentos[rol]?.nombre, `${p.codigo} no nombra el documento ${rol}`)
    }
    assert.ok(p.impuesto.nombre && ivaValido(p.impuesto.tarifa), `${p.codigo}: impuesto inválido`)
    assert.ok(p.ente.sigla && p.regulador.sigla, `${p.codigo}: falta el ente o el regulador`)
  }
})

test('las zonas horarias existen de verdad', () => {
  for (const p of PAISES) assert.ok(esZonaValida(p.zona), `${p.codigo}: zona ${p.zona} desconocida`)
})

test('los códigos no se repiten', () => {
  const codigos = PAISES.map((p) => p.codigo)
  assert.equal(new Set(codigos).size, codigos.length)
})

test('los módulos legales son solo de Ecuador', () => {
  const ec = perfilDe('EC')
  assert.ok(ec.modulos.facturacionElectronica && ec.modulos.reporteRegulador && ec.modulos.contratoRegulador)
  for (const p of PAISES.filter((x) => x.codigo !== 'EC')) {
    assert.ok(!Object.values(p.modulos).some(Boolean), `${p.codigo} no debería tener módulos de Ecuador`)
  }
})

test('un país desconocido cae a Ecuador, que es lo que había antes', () => {
  assert.equal(perfilDe('ZZ').codigo, PAIS_POR_DEFECTO)
  assert.equal(perfilDe(null).codigo, PAIS_POR_DEFECTO)
  assert.equal(perfilDe('co').codigo, 'CO', 'no distingue mayúsculas')
})
