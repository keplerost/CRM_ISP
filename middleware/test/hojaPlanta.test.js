import test from 'node:test'
import assert from 'node:assert/strict'

import { clasificar } from '../../web/src/lib/kmz.js'
import {
  COLUMNAS,
  armarPlantilla,
  armarXlsx,
  claveDeEncabezado,
  filasAPlacemarks,
  leerCsv,
  leerHoja,
  leerXlsx,
  numeroCoordenada,
  utmALatLng,
} from '../../web/src/lib/hojaPlanta.js'

const ENC = COLUMNAS.map((c) => c.titulo)
const fila = (o) => COLUMNAS.map((c) => o[c.clave] ?? '')

test('la plantilla se abre de vuelta: hoja Postes con los encabezados y las Instrucciones', async () => {
  const hojas = await leerXlsx(armarPlantilla())
  assert.deepEqual(
    hojas.map((h) => h.nombre),
    ['Postes', 'Instrucciones'],
  )
  assert.deepEqual(hojas[0].filas[0], ENC)
  assert.equal(hojas[0].filas.length, 1)
  const { hoja, filas } = await leerHoja('plantilla.xlsx', armarPlantilla())
  assert.equal(hoja, 'Postes')
  assert.equal(filas.length, 1)
})

test('un xlsx llenado: tipos, herraje, estado y descripción', async () => {
  const xlsx = armarXlsx([
    {
      nombre: 'Postes',
      filas: [
        ENC,
        fila({ nombre: 'P-001', latitud: -0.941234, longitud: -79.224567, herraje: 'A', zona: 'Centro', material: 'Hormigón', altura: 9, propietario: 'CNEL' }),
        fila({ nombre: 'P-002', latitud: '-0,9420', longitud: '-79,2250', herraje: 'J', zona: 'Centro', estado: 'Proyectado' }),
        fila({ nombre: 'NAP-01', tipo: 'NAP', latitud: -0.943, longitud: -79.226, puertos: 16, splitter: '1:16' }),
        fila({ nombre: 'Sin GPS' }),
        [],
      ],
    },
  ])
  const { filas } = await leerHoja('lamana.xlsx', xlsx)
  const l = filasAPlacemarks(filas, { carpeta: 'lamana' })
  assert.equal(l.placemarks.length, 3)
  assert.deepEqual(l.sinUbicar, [{ fila: 5, nombre: 'Sin GPS', motivo: 'Sin coordenadas' }])

  const r = clasificar(l.placemarks, { unirTendidos: false })
  const [p1, p2, nap] = r.elementos
  assert.equal(p1.tipo, 'poste')
  assert.equal(p1.herraje, 'A')
  assert.equal(p1.estado, 'existente')
  assert.equal(p1.descripcion, 'Material: Hormigón · Altura: 9 m · Propietario: CNEL')
  assert.equal(p1.origen.carpeta, 'Centro')
  assert.equal(p1.origen.fila, 2)
  assert.equal(p2.latitud, -0.942)
  assert.equal(p2.herraje, 'J')
  assert.equal(p2.estado, 'proyectado')
  assert.equal(nap.tipo, 'nap')
  assert.equal(nap.capacidad, 16)
  assert.equal(nap.splitter, '1:16')
  assert.equal(nap.origen.carpeta, 'lamana')
})

test('postes de un tendido con herraje A/J en orden: se arma la ruta del cable', () => {
  const filas = [
    ['Nombre', 'Latitud', 'Longitud', 'Herraje', 'Tendido'],
    ['1', -0.94, -79.22, 'A', 'Troncal Norte'],
    ['2', -0.9405, -79.22, 'J', 'Troncal Norte'],
    ['3', -0.941, -79.22, 'J', 'Troncal Norte'],
    ['4', -0.9415, -79.22, 'A', 'Troncal Norte'],
  ]
  const r = clasificar(filasAPlacemarks(filas).placemarks, { unirTendidos: true, vanoMaximo: 150 })
  assert.equal(r.elementos.length, 4)
  assert.equal(r.cables.length, 1)
  assert.equal(r.cables[0].ruta.length, 4)
})

test('encabezados propios y sinónimos', () => {
  assert.equal(claveDeEncabezado('LAT'), 'latitud')
  assert.equal(claveDeEncabezado('Longitud (WGS84)'), 'longitud')
  assert.equal(claveDeEncabezado('Código'), 'nombre')
  assert.equal(claveDeEncabezado('Observaciones'), 'observacion')
  assert.equal(claveDeEncabezado('UTM Este'), 'este')
  assert.equal(claveDeEncabezado('Color favorito'), null)
})

test('encabezado que no está en la primera fila, y columnas que no se usan', () => {
  const filas = [['POSTERÍA LA MANÁ'], [], ['N°', 'Lat', 'Long', 'Foto'], ['P1', -0.94, -79.22, 'x.jpg']]
  const l = filasAPlacemarks(filas)
  assert.equal(l.placemarks.length, 1)
  assert.equal(l.placemarks[0].nombre, 'P1')
  assert.equal(l.placemarks[0].fila, 4)
  assert.deepEqual(l.encabezado.ignoradas, ['Foto'])
})

test('coordenadas: coma decimal, grados-minutos-segundos y números', () => {
  assert.equal(numeroCoordenada('-0,94123'), -0.94123)
  assert.equal(numeroCoordenada(-79.5), -79.5)
  assert.ok(Math.abs(numeroCoordenada('0°56\'28.4"S') - -0.941222) < 1e-5)
  assert.ok(Math.abs(numeroCoordenada('79°13\'28.4" O') - -79.224556) < 1e-5)
  assert.equal(numeroCoordenada('abc'), null)
  assert.equal(numeroCoordenada(''), null)
})

test('columna única de coordenadas como las copia Google Maps', () => {
  const l = filasAPlacemarks([['Poste', 'Coordenadas'], ['P1', '-0.941234, -79.224567'], ['P2', '-0,9412; -79,2245']])
  assert.deepEqual(l.placemarks.map((p) => p.coords[0]), [
    [-0.941234, -79.224567],
    [-0.9412, -79.2245],
  ])
})

test('latitud y longitud cruzadas se dan vuelta y quedan para revisar', () => {
  const l = filasAPlacemarks([['Nombre', 'Latitud', 'Longitud'], ['P1', -79.22, -0.94]])
  assert.deepEqual(l.placemarks[0].coords[0], [-0.94, -79.22])
  assert.match(l.placemarks[0].revisar[0], /cruzadas/)
})

test('UTM 17 Sur cae en La Maná, por columnas Este/Norte o escrito en Latitud/Longitud', () => {
  const [lat, lng] = utmALatLng(697800, 9895900, 17, true)
  assert.ok(lat > -1.0 && lat < -0.9, `lat ${lat}`)
  assert.ok(lng > -79.3 && lng < -79.15, `lng ${lng}`)

  const a = filasAPlacemarks([['Nombre', 'Este', 'Norte'], ['P1', 697800, 9895900]])
  assert.equal(a.usaUtm, true)
  assert.ok(Math.abs(a.placemarks[0].coords[0][0] - lat) < 1e-9)

  const b = filasAPlacemarks([['Nombre', 'Latitud', 'Longitud'], ['P1', 9895900, 697800]])
  assert.equal(b.usaUtm, true)
  assert.ok(Math.abs(b.placemarks[0].coords[0][1] - lng) < 1e-9)
})

test('filas repetidas en el mismo lugar quedan para revisar', () => {
  const l = filasAPlacemarks([['Nombre', 'Latitud', 'Longitud'], ['P1', -0.94, -79.22], ['P1b', -0.94, -79.22]])
  assert.match(l.placemarks[1].revisar[0], /fila 2/)
})

test('tipo desconocido entra como Otro y queda para revisar', () => {
  const l = filasAPlacemarks([['Nombre', 'Tipo', 'Latitud', 'Longitud'], ['X', 'Antena', -0.94, -79.22]])
  const r = clasificar(l.placemarks)
  assert.equal(r.elementos[0].tipo, 'otro')
  assert.ok(r.elementos[0].revisar.some((x) => /Antena/.test(x)))
})

test('CSV con punto y coma, comillas y tildes en Windows-1252', async () => {
  assert.deepEqual(leerCsv('a;b\n"x;1";"di ""hola"""\n'), [
    ['a', 'b'],
    ['x;1', 'di "hola"'],
  ])
  const latin1 = Uint8Array.from([...'Nombre;Latitud;Longitud\nPoste Man\xe1;-0,94;-79,22\n'].map((c) => c.charCodeAt(0)))
  const { filas } = await leerHoja('postes.csv', latin1.buffer)
  const l = filasAPlacemarks(filas)
  assert.equal(l.placemarks[0].nombre, 'Poste Maná')
  assert.deepEqual(l.placemarks[0].coords[0], [-0.94, -79.22])
})

test('sin columnas de ubicación: error claro', () => {
  assert.throws(() => filasAPlacemarks([['Nombre', 'Dirección'], ['P1', 'Calle 1']]), /Latitud/)
})
