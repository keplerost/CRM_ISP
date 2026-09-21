import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Qué segmento de red le toca a un abonado.
 *
 * La dirección la da DÓNDE está colgada la ONT, no qué plan contrató. En la
 * misma VLAN conviven un abonado de 150 megas y uno de 500: los bloques sirven a
 * todos los planes por igual. El plan decide la velocidad —las traffic tables
 * del service-port— y no interviene acá.
 *
 * Quedan dos fuentes, y no siempre coinciden:
 *
 *   la VLAN que la ONT TIENE     lo que está puesto en el equipo, ahora mismo
 *   la VLAN que el puerto USA    la convención del ISP para ese puerto PON
 *
 * Lo delicado no es resolver cada una: es qué hacer cuando dicen cosas
 * distintas. Elegir en silencio deja al abonado en el bloque equivocado y nadie
 * se entera hasta el reclamo.
 */

/** La misma regla que aplica `segmentoSugerido`, sin ir a buscar nada. */
function decidir(porVlan, porPuerto) {
  const v = porVlan?.encontrado ? porVlan : null
  const p = porPuerto?.encontrado ? porPuerto : null

  if (v && p && v.subred_id !== p.subred_id) {
    return { ...v, por: 'vlan', conflicto: { por_vlan: v, por_puerto: p } }
  }
  if (v) return { ...v, por: 'vlan' }
  if (p) return { ...p, por: 'puerto' }
  return porVlan ?? porPuerto ?? { encontrado: false }
}

const vlan = (id) => ({ encontrado: true, subred_id: id, subred: `porVlan-${id}` })
const puerto = (id) => ({ encontrado: true, subred_id: id, subred: `porPuerto-${id}` })
const nada = (motivo) => ({ encontrado: false, motivo })

describe('cuando resuelve una sola', () => {
  test('solo la VLAN de la ONT: se usa esa', () => {
    const r = decidir(vlan('A'), nada('el puerto no tiene VLAN asignada'))
    assert.equal(r.subred_id, 'A')
    assert.equal(r.por, 'vlan')
    assert.equal(r.conflicto, undefined)
  })

  test('solo el puerto: se usa la del puerto', () => {
    // El caso del alta nueva: la ONT todavía no está dada de alta, así que no
    // tiene VLAN propia, pero sabemos en qué puerto apareció.
    const r = decidir(nada('la ONU no tiene VLAN conocida'), puerto('B'))
    assert.equal(r.subred_id, 'B')
    assert.equal(r.por, 'puerto')
  })

  test('ninguna: se devuelve el motivo, no un vacío', () => {
    // Un campo vacío no distingue "no hay segmento" de "nadie lo configuró", y
    // esa diferencia decide si el técnico sigue solo o llama a la oficina.
    const r = decidir(nada('la ONU no tiene VLAN conocida'), nada('el puerto no tiene VLAN'))
    assert.equal(r.encontrado, false)
    assert.ok(r.motivo)
  })
})

describe('cuando las dos resuelven', () => {
  test('si coinciden, no hay nada que avisar', () => {
    const r = decidir(vlan('MISMO'), puerto('MISMO'))
    assert.equal(r.subred_id, 'MISMO')
    assert.equal(r.conflicto, undefined)
  })

  test('si difieren, se avisa en vez de elegir en silencio', () => {
    const r = decidir(vlan('REAL'), puerto('CONVENCION'))
    assert.ok(r.conflicto, 'tiene que avisar')
    assert.equal(r.conflicto.por_vlan.subred_id, 'REAL')
    assert.equal(r.conflicto.por_puerto.subred_id, 'CONVENCION')
  })

  test('ante el conflicto gana la VLAN que la ONT tiene puesta', () => {
    // El tráfico del abonado sale etiquetado con esa VLAN. Una dirección del
    // bloque del puerto no le enrutaría, por más que sea la convención.
    const r = decidir(vlan('REAL'), puerto('CONVENCION'))
    assert.equal(r.subred_id, 'REAL')
    assert.equal(r.por, 'vlan')
  })
})

describe('elegir entre varios bloques de la misma VLAN', () => {
  // Cuando un bloque se llena se agrega otro con la misma VLAN. Como todos
  // sirven a cualquier plan, no hay nada que los distinga salvo cuánto lugar
  // les queda.
  const libres = (s) => s.direcciones_del_bloque - s.anotadas
  const elegir = (bloques) => [...bloques].sort((a, b) => libres(b) - libres(a))[0]

  test('prefiere el que tiene más lugar', () => {
    const r = elegir([
      { subred: 'lleno', direcciones_del_bloque: 254, anotadas: 250 },
      { subred: 'nuevo', direcciones_del_bloque: 254, anotadas: 10 },
    ])
    assert.equal(r.subred, 'nuevo')
  })

  test('un /25 con lugar gana a un /24 lleno', () => {
    // El tamaño del bloque no decide: decide cuánto queda.
    const r = elegir([
      { subred: 'grande lleno', direcciones_del_bloque: 254, anotadas: 254 },
      { subred: 'chico libre', direcciones_del_bloque: 126, anotadas: 0 },
    ])
    assert.equal(r.subred, 'chico libre')
  })

  test('el plan del abonado no entra en la cuenta', () => {
    // Es el error que corrige la migración 50: el bloque no es "el de los de
    // 150 megas". En el mismo conviven todos los planes.
    const bloques = [
      { subred: 'A', direcciones_del_bloque: 126, anotadas: 100, plan: '150M' },
      { subred: 'B', direcciones_del_bloque: 126, anotadas: 3, plan: '500M' },
    ]
    assert.equal(elegir(bloques).subred, 'B')
    // Y el mismo resultado con los planes al revés: no los mira.
    assert.equal(
      elegir(bloques.map((b) => ({ ...b, plan: b.plan === '150M' ? '500M' : '150M' }))).subred,
      'B',
    )
  })
})
