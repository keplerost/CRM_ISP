import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'

import {
  armarKml,
  armarZip,
  clasificar,
  crc32,
  hilosDe,
  leerZip,
  metrosDe,
  textoKml,
  tipoDeCable,
  tipoDePunto,
} from '../../web/src/lib/kmz.js'

const p = (carpeta, nombre, lat, lng, extra = {}) => ({
  carpeta,
  nombre,
  descripcion: '',
  datos: {},
  estilo: '',
  geom: 'punto',
  coords: [[lat, lng]],
  ...extra,
})

test('el ZIP: lo que se escribe se vuelve a leer, y también lo comprimido con deflate', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
  const kml = new TextEncoder().encode('<kml>ñandú</kml>')
  const zip = armarZip([{ nombre: 'doc.kml', datos: kml }])
  const leido = await leerZip(zip)
  assert.equal(new TextDecoder().decode(leido['doc.kml']), '<kml>ñandú</kml>')

  // Un KMZ como los de Google Earth: comprimido.
  const nombre = Buffer.from('doc.kml')
  const datos = Buffer.from('<kml>comprimido</kml>')
  const comp = deflateRawSync(datos)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(comp.length, 18)
  local.writeUInt32LE(datos.length, 22)
  local.writeUInt16LE(nombre.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(comp.length, 20)
  central.writeUInt32LE(datos.length, 24)
  central.writeUInt16LE(nombre.length, 28)
  central.writeUInt32LE(0, 42)
  const fin = Buffer.alloc(22)
  fin.writeUInt32LE(0x06054b50, 0)
  fin.writeUInt16LE(1, 8)
  fin.writeUInt16LE(1, 10)
  fin.writeUInt32LE(46 + nombre.length, 12)
  fin.writeUInt32LE(30 + nombre.length + comp.length, 16)
  const kmz = Buffer.concat([local, nombre, comp, central, nombre, fin])
  assert.equal(await textoKml('red.kmz', kmz), '<kml>comprimido</kml>')
  await assert.rejects(textoKml('roto.kmz', Buffer.from('no es un zip')), /no es un KMZ válido/)
})

test('los hilos y los metros, como los escriben en Google Earth', () => {
  assert.equal(hilosDe('F.O. -ADSS-24-HILOS -TENDIDO TRAMO-TOQUILLAL'), 24)
  assert.equal(hilosDe('HL 48FO 4X12'), 48)
  assert.equal(hilosDe('Fibra de 8'), 8)
  assert.equal(hilosDe('DROP 2 HILOS -NAP2/NAP3'), 2)
  assert.equal(hilosDe('MANGA TRONCAL 24 HILOS'), 24)
  assert.equal(hilosDe('NAP LOMA DE LA VIRGEN'), null)
  assert.equal(metrosDe('A-RESERVA DE 50'), 50)
  assert.equal(metrosDe('22 mtrs'), 22)
})

test('qué es cada punto: por carpeta, por nombre', () => {
  assert.equal(tipoDePunto('NODOS', 'NODO-CNET'), 'nodo')
  assert.equal(tipoDePunto('POSTERIA EL CARMEN', 'Punto 76'), 'poste')
  assert.equal(tipoDePunto('NAP EXISTENTES', 'NAP'), 'nap')
  assert.equal(tipoDePunto('MANGAS', 'Punto 15'), 'manga')
  assert.equal(tipoDePunto('TENDIDO HOME LINK', 'J'), 'poste')
  assert.equal(tipoDePunto('TENDIDO HOME LINK', 'A-NAP'), 'poste')
  assert.equal(tipoDePunto('TENDIDO HOME LINK', 'A-RESERVA DE 50'), 'reserva')
  assert.equal(tipoDePunto('PROYECTOS', 'NAP-TURQUEZA'), 'nap')
  assert.equal(tipoDePunto('PROYECTOS', 'Spletter 1/8'), 'splitter')
  assert.equal(tipoDePunto('VARIOS', 'cosa rara'), 'otro')
})

test('qué cable es cada línea', () => {
  assert.deepEqual(tipoDeCable('HILO VERDE NAP A3'), { tipo: 'hilo', hilos: null, color_hilo: 'verde' })
  assert.equal(tipoDeCable('F.O. -ADSS-24-HILOS TOQUILLAL').tipo, 'troncal')
  assert.equal(tipoDeCable('DROP DE 2 HILOS-NAP PUEMBO').tipo, 'drop')
  assert.equal(tipoDeCable('Fibra de 8').tipo, 'distribucion')
  assert.equal(tipoDeCable('AMERICANO').tipo, 'otro')
})

test('clasificar: nombres de la descripción, sin nombre, repetidas, lejos, proyectos', () => {
  const r = clasificar(
    [
      p('NAP EXISTENTES', 'NAP', -0.93, -79.22, { datos: { nombre: 'NAP-LOMA DE LA VIRGEN', 'descripción': 'DROP' } }),
      p('NAP EXISTENTES', 'NAP', -0.931, -79.221, { datos: { nombre: '', 'descripción': '' } }),
      p('NAP EXISTENTES', 'NAP 2', -0.931, -79.221),
      p('NAP EXISTENTES', '', -0.94, -79.23, { datos: { gx_media_links: 'https://foto/1 https://foto/2' } }),
      p('NAP EXISTENTES', 'NAP LEJANA', -2.77, -77.08),
      p('MANGAS', 'MANGA TRONCAL 24 HILOS', -0.932, -79.222),
      p('PROYECTOS', 'NAP-TURQUEZA', -0.95, -79.24),
      p('NAP EXISTENTES', 'HILO VERDE NAP A3', 0, 0, { geom: 'linea', coords: [[-0.93, -79.22], [-0.931, -79.22]] }),
    ],
    { unirTendidos: false },
  )
  const [loma, generica, repetida, sinNombre, lejana, manga, proyecto] = r.elementos
  assert.equal(loma.nombre, 'NAP-LOMA DE LA VIRGEN')
  assert.equal(loma.descripcion, 'DROP')
  assert.deepEqual(loma.revisar, [])
  assert.match(generica.revisar[0], /Sin nombre propio/)
  assert.ok(repetida.revisar.some((x) => /Repetida/.test(x)))
  assert.equal(sinNombre.nombre, 'NAP sin nombre')
  assert.equal(sinNombre.foto_url, 'https://foto/1')
  assert.ok(lejana.revisar.some((x) => /km del resto/.test(x)))
  assert.equal(manga.hilos, 24)
  assert.equal(proyecto.estado, 'proyectado')
  assert.equal(r.cables[0].tipo, 'hilo')
  assert.equal(r.resumen.elementos.nap, 6)
})

test('clasificar: el tendido marcado poste por poste se vuelve ruta, cortada en los saltos', () => {
  const ps = []
  // 5 postes cada ~50 m, un salto de ~5 km, y 3 postes más.
  for (let i = 0; i < 5; i++) ps.push(p('TENDIDO HOME LINK', i % 2 ? 'J' : 'A', -0.93 - i * 0.00045, -79.22))
  ps[0].nombre = 'A-MANGA 24 4005 mtrs'
  for (let i = 0; i < 3; i++) ps.push(p('TENDIDO HOME LINK', 'A', -0.98 - i * 0.00045, -79.22))
  ps.push(p('TENDIDO HOME LINK', 'A-RESERVA DE 50', -0.98 - 3 * 0.00045, -79.22))
  // Un punto marcado con "Mi ubicación" en medio del recorrido, con ícono de NAP.
  ps.splice(2, 0, p('TENDIDO HOME LINK', 'Mi ubicación', -0.93 - 1.5 * 0.00045, -79.22, { estilo: '#icon-nap' }))
  for (let i = 0; i < 3; i++) ps.push(p('NAP EXISTENTES', 'NAP', -0.5 - i * 0.01, -79.22, { estilo: '#icon-nap' }))

  const r = clasificar(ps)
  const tramos = r.cables.filter((c) => c.origen.tendido)
  assert.equal(tramos.length, 2)
  assert.deepEqual(tramos.map((t) => t.ruta.length), [6, 4])
  assert.equal(tramos[0].hilos, 24)
  assert.equal(tramos[0].tipo, 'troncal')
  assert.match(tramos[0].revisar[0], /Ruta armada uniendo postes/)
  assert.equal(r.elementos.filter((e) => e.tipo === 'poste').length, 9, '"Mi ubicación" es un poste del tendido, no una NAP')
  const reserva = r.elementos.find((e) => e.tipo === 'reserva')
  assert.deepEqual([reserva.herraje, reserva.metros], ['A', 50])
  assert.equal(r.elementos[0].herraje, 'A')
})

test('clasificar: lo que no se sabe por carpeta ni nombre, se deduce por el ícono', () => {
  const ps = [
    p('POSTERIA', 'Poste 1', -0.93, -79.22, { estilo: '#icon-1899-0288D1' }),
    p('POSTERIA', 'Poste 2', -0.931, -79.22, { estilo: '#icon-1899-0288D1' }),
    p('POSTERIA', 'Poste 3', -0.932, -79.22, { estilo: '#icon-1899-0288D1-nodesc' }),
    p('PROYECTOS', '', -0.933, -79.22, { estilo: '#icon-1899-0288D1' }),
  ]
  const r = clasificar(ps)
  assert.equal(r.elementos[3].tipo, 'poste')
  assert.equal(r.elementos[3].estado, 'proyectado')
  assert.deepEqual(r.elementos[3].revisar, [])
})

test('el KML de salida: carpetas por tipo, datos y coordenadas lng,lat', () => {
  const kml = armarKml({
    nombre: 'Red <La Maná>',
    elementos: [{ tipo: 'nap', nombre: 'NAP-01', latitud: -0.93, longitud: -79.22, capacidad: 16, abonados: 3 }],
    cables: [{ nombre: 'Troncal', tipo: 'troncal', hilos: 24, ruta: [[-0.93, -79.22], [-0.931, -79.22]] }],
  })
  assert.match(kml, /<name>Red &lt;La Maná&gt;<\/name>/)
  assert.match(kml, /<Folder><name>Cajas NAP \(1\)<\/name>/)
  assert.match(kml, /<Data name="puertos"><value>16<\/value><\/Data>/)
  assert.match(kml, /<coordinates>-79.22,-0.93,0<\/coordinates>/)
  assert.match(kml, /<coordinates>-79.22,-0.93,0 -79.22,-0.931,0<\/coordinates>/)
  assert.match(kml, /<Data name="metros"><value>111<\/value><\/Data>/)
})

test('el KML con el estilo de cada uno y una carpeta por capa', () => {
  const kml = armarKml({
    elementos: [{ tipo: 'poste', nombre: 'P1', latitud: -0.93, longitud: -79.22, capa: 'Postería CNEL' }],
    cables: [
      { nombre: 'Feeder', tipo: 'troncal', ruta: [[-0.93, -79.22], [-0.931, -79.22]], capa: 'Feeder principal' },
      { nombre: 'Suelto', tipo: 'drop', ruta: [[-0.93, -79.22], [-0.931, -79.22]] },
    ],
    estiloDe: (x, clase) => (clase === 'c' ? { color: 'ff2626dc', ancho: 7 } : { color: 'ff111111', ancho: 3 }),
    carpetaDe: (x) => x.capa ?? null,
  })
  assert.match(kml, /<Folder><name>Postería CNEL \(1\)<\/name>/)
  assert.match(kml, /<Folder><name>Feeder principal \(1\)<\/name>/)
  assert.match(kml, /<Folder><name>Cables drop \(1\)<\/name>/)
  assert.match(kml, /<LineStyle><color>ff2626dc<\/color><width>7<\/width><\/LineStyle>/)
})

test('el KMZ con los íconos adentro', async () => {
  const kml = armarKml({
    elementos: [{ tipo: 'nap', nombre: 'NAP-01', latitud: -0.93, longitud: -79.22 }],
    estiloDe: () => ({ color: 'ff0b9ef5', ancho: 6, icono: 'iconos/nap-f59e0b.png' }),
  })
  assert.match(kml, /<IconStyle><color>ffffffff<\/color><scale>1.00<\/scale><Icon><href>iconos\/nap-f59e0b.png<\/href>/)
  const { armarKmz } = await import('../../web/src/lib/kmz.js')
  const png = new Uint8Array([137, 80, 78, 71])
  const zip = await leerZip(armarKmz({ elementos: [] }, [{ nombre: 'iconos/nap-f59e0b.png', datos: png }]))
  assert.deepEqual(Object.keys(zip).sort(), ['doc.kml', 'iconos/nap-f59e0b.png'])
})
