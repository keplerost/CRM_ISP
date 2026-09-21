import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { agruparEnCajas } from '../src/services/cajasNap.js'

/**
 * Proponer cajas NAP.
 *
 * Es la parte del sistema que más se parece a una adivinanza: la OLT no puede
 * saber de qué caja cuelga un abonado porque los splitters son pasivos. Lo
 * único que separa esto de adivinar es que las reglas estén escritas, fijadas y
 * que el resultado diga cuánto se le puede creer.
 *
 * Los datos son los reales del X7.
 */

const onu = (o) => ({ id: o.sn, slot: 6, nombre_cliente: o.sn, ...o })

describe('qué agrupa y qué no', () => {
  test('mismo puerto y distancias juntas: una caja', () => {
    const p = agruparEnCajas([
      onu({ sn: 'A', puerto: 2, direccion: 'SAN ANTONIO DE MANGUILA', distancia_m: 10841 }),
      onu({ sn: 'B', puerto: 2, direccion: 'SAN ANTONIO DE MANGUILA', distancia_m: 10855 }),
      onu({ sn: 'C', puerto: 2, direccion: 'SAN ANTONIO DE MANGUILA', distancia_m: 10871 }),
    ])
    assert.equal(p.length, 1)
    assert.equal(p[0].abonados, 3)
    assert.equal(p[0].confianza.nivel, 'alta')
  })

  test('la misma distancia en OTRO puerto es otra caja', () => {
    // Dos cajas pueden estar a la misma distancia colgando de puertos
    // distintos. Juntarlas diría que hay lugar en una que está en otro splitter.
    const p = agruparEnCajas([
      onu({ sn: 'A', puerto: 2, direccion: 'SAN ANTONIO', distancia_m: 10841 }),
      onu({ sn: 'B', puerto: 9, direccion: 'SAN ANTONIO', distancia_m: 10850 }),
    ])
    assert.equal(p.length, 2)
  })

  test('un salto grande de distancia parte el grupo en dos', () => {
    // El caso real del puerto 9: catorce abonados con la misma dirección
    // repartidos en 1178 m. Eso no es una caja, son varias sobre la misma vía.
    const p = agruparEnCajas([
      onu({ sn: 'A', puerto: 9, direccion: 'SAN ANTONIO DE MANGUILA', distancia_m: 8335 }),
      onu({ sn: 'B', puerto: 9, direccion: 'SAN ANTONIO DE MANGUILA', distancia_m: 8360 }),
      onu({ sn: 'C', puerto: 9, direccion: 'SAN ANTONIO DE MANGUILA', distancia_m: 9490 }),
      onu({ sn: 'D', puerto: 9, direccion: 'SAN ANTONIO DE MANGUILA', distancia_m: 9513 }),
    ])
    assert.equal(p.length, 2)
    assert.deepEqual(p.map((x) => x.abonados).sort(), [2, 2])
  })

  test('la dirección NO parte un grupo que la distancia junta', () => {
    // Este fue el error. Se agrupaba por dirección y en esta red la "dirección"
    // es el nombre del recinto: "Selvalegre" abarca dos kilómetros. Agrupando
    // por ahí, seis abonados de la misma caja quedaban en seis grupos de uno.
    //
    // Tres abonados a 14 m entre sí son una caja, escriban lo que escriban.
    const p = agruparEnCajas([
      onu({ sn: 'A', puerto: 4, direccion: 'Pueblo Arrecho', distancia_m: 4746 }),
      onu({ sn: 'B', puerto: 4, direccion: 'MANGUILA-PUEBLO ARRECHO', distancia_m: 4760 }),
      onu({ sn: 'C', puerto: 4, direccion: null, distancia_m: 4770 }),
    ])
    assert.equal(p.length, 1)
    assert.equal(p[0].abonados, 3)
  })

  test('la dirección que más se repite nombra la caja', () => {
    const p = agruparEnCajas([
      onu({ sn: 'A', puerto: 4, direccion: 'Pueblo Arrecho', distancia_m: 4746 }),
      onu({ sn: 'B', puerto: 4, direccion: 'pueblo  arrecho', distancia_m: 4760 }),
      onu({ sn: 'C', puerto: 4, direccion: 'Otra Cosa', distancia_m: 4770 }),
    ])
    assert.equal(p[0].direccion, 'PUEBLO ARRECHO')
    // Las demás se muestran igual: si una sola dice otra cosa, ésa hay que mirarla.
    assert.equal(p[0].direcciones.length, 3)
  })
})

describe('cuánto se le puede creer a cada grupo', () => {
  const grupo = (distancias) =>
    agruparEnCajas(
      distancias.map((d, i) => onu({ sn: `X${i}`, puerto: 1, direccion: 'VIA', distancia_m: d })),
      { saltoMetros: 10_000 },
    )[0]

  test('dentro de 100 m: probable', () => {
    assert.equal(grupo([5000, 5040, 5080]).confianza.nivel, 'alta')
  })

  test('cientos de metros: a revisar', () => {
    assert.equal(grupo([5000, 5200, 5350]).confianza.nivel, 'media')
  })

  test('medio kilómetro: floja', () => {
    const g = grupo([5000, 5300, 5600])
    assert.equal(g.confianza.nivel, 'baja')
    assert.match(g.confianza.motivo, /varias cajas/)
  })

  test('un grupo de uno solo NO es "probable"', () => {
    // Puede ser una caja de un abonado, o puede que falten los otros. No se
    // presenta como probable: quedaron 40 así con el criterio anterior y eso
    // no es un mapa, es la lista de abonados otra vez.
    const p = agruparEnCajas([onu({ sn: 'A', puerto: 1, direccion: 'VIA', distancia_m: 5000 })])
    assert.equal(p[0].confianza.nivel, 'media')
  })

  test('sin distancias medidas: floja, no "probable por defecto"', () => {
    // Es el error clásico: sin datos para dudar, todo parece correcto. Acá la
    // falta de datos baja la confianza en vez de subirla.
    const p = agruparEnCajas([
      onu({ sn: 'A', puerto: 1, direccion: 'VIA', distancia_m: null }),
      onu({ sn: 'B', puerto: 1, direccion: 'VIA', distancia_m: null }),
    ])
    assert.equal(p[0].confianza.nivel, 'baja')
    assert.equal(p[0].sin_distancia, true)
  })
})

describe('lo que no se propone', () => {
  test('sin dirección sí entra: lo que ubica es la distancia', () => {
    // La dirección sirve para nombrar la caja, no para armarla. Doce de las
    // noventa y una no la tienen y están igual de ubicadas que el resto.
    const p = agruparEnCajas([
      onu({ sn: 'A', puerto: 4, direccion: null, distancia_m: 4746 }),
      onu({ sn: 'B', puerto: 4, direccion: '', distancia_m: 4750 }),
    ])
    assert.equal(p.length, 1)
    assert.equal(p[0].abonados, 2)
    assert.equal(p[0].direccion, null)
  })

  test('las que ya tienen caja no se vuelven a proponer', () => {
    // El filtro vive en proponerCajas; acá se fija que agrupar no las invente.
    const p = agruparEnCajas([])
    assert.deepEqual(p, [])
  })

  test('una ONU sin distancia no se cuela en el grupo de las que sí tienen', () => {
    // Sin ese dato no se sabe dónde está. Ponerla con las otras diría que
    // ocupa una boca de una caja en la que quizá no está.
    const p = agruparEnCajas([
      onu({ sn: 'A', puerto: 1, direccion: 'VIA', distancia_m: 5000 }),
      onu({ sn: 'B', puerto: 1, direccion: 'VIA', distancia_m: 5020 }),
      onu({ sn: 'C', puerto: 1, direccion: 'VIA', distancia_m: null }),
    ])
    assert.equal(p.length, 2)
    const suelta = p.find((x) => x.sin_distancia)
    assert.equal(suelta.abonados, 1)
    assert.equal(suelta.onus[0].sn, 'C')
  })
})

describe('las claves de las propuestas', () => {
  const armar = (sns) =>
    agruparEnCajas(sns.map((sn, i) => onu({ sn, puerto: 1, direccion: 'VIA', distancia_m: 5000 + i * 20 })))

  test('no cambian cuando se acepta otra caja', () => {
    // Al crear una caja, sus abonados salen de la lista y las demás propuestas
    // se recalculan. Con una clave posicional, la que era la tercera pasaba a
    // ser la segunda — y la pantalla, que recuerda cuál tenía abierta, mostraba
    // el formulario de un grupo sobre los abonados de otro.
    const antes = armar(['A', 'B', 'C'])
    const despues = agruparEnCajas([
      onu({ sn: 'X', puerto: 0, direccion: 'OTRA', distancia_m: 100 }),
      ...['A', 'B', 'C'].map((sn, i) =>
        onu({ sn, puerto: 1, direccion: 'VIA', distancia_m: 5000 + i * 20 }),
      ),
    ])
    const mismo = despues.find((p) => p.puerto === 1)
    assert.equal(mismo.clave, antes[0].clave)
  })

  test('dos grupos distintos nunca comparten clave', () => {
    const p = agruparEnCajas([
      onu({ sn: 'A', puerto: 1, direccion: 'VIA', distancia_m: 5000 }),
      onu({ sn: 'B', puerto: 1, direccion: 'VIA', distancia_m: 9000 }),
    ])
    assert.equal(p.length, 2)
    assert.notEqual(p[0].clave, p[1].clave)
  })
})
