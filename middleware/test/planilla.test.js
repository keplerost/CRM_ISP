import test from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'

import { aTexto, esExcel, leerExcel, leerPlanilla } from '../src/lib/planilla.js'

/**
 * Leer la planilla del sistema anterior venga como venga.
 *
 * El CSV tiene sus pruebas en csv.test.js. Acá se prueba lo que ese módulo no
 * puede saber porque recibe texto ya decodificado: la codificación del archivo
 * y el Excel.
 */

const utf8 = (t) => new TextEncoder().encode(t)
const latin1 = (t) => Uint8Array.from(Buffer.from(t, 'latin1'))

// --- La codificación -------------------------------------------------------

test('un archivo en UTF-8 se lee tal cual', () => {
  assert.equal(aTexto(utf8('OÑA RIERA JOSÉ')), 'OÑA RIERA JOSÉ')
})

test('uno en Latin-1 —el que escribe Excel en Windows— también', () => {
  // Sin esto "OÑA" llega roto, se importa roto y nadie lo revisa después.
  assert.equal(aTexto(latin1('OÑA RIERA JOSÉ')), 'OÑA RIERA JOSÉ')
})

test('se prueba UTF-8 primero, no Latin-1', () => {
  // Latin-1 acepta cualquier byte y nunca falla: si se probara primero, un
  // archivo UTF-8 perfecto se leería como "OÃ‘A".
  assert.equal(aTexto(utf8('GUAMANÍ')), 'GUAMANÍ')
})

test('los acentos sobreviven al recorrido completo del CSV', async () => {
  const { filas } = await leerPlanilla({
    nombre: 'padron.csv',
    bytes: latin1('nombre;direccion\nOÑA RIERA JOSÉ;Barrio GUAMANÍ'),
  })
  assert.equal(filas[0].nombre, 'OÑA RIERA JOSÉ')
  assert.equal(filas[0].direccion, 'Barrio GUAMANÍ')
})

// --- Qué formato es --------------------------------------------------------

test('la extensión decide', () => {
  assert.equal(esExcel({ nombre: 'padron.xlsx' }), true)
  assert.equal(esExcel({ nombre: 'PADRON.XLSX' }), true)
  assert.equal(esExcel({ nombre: 'padron.csv' }), false)
})

test('sin nombre, se mira si es un zip —que es lo que es un .xlsx—', () => {
  assert.equal(esExcel({ bytes: Uint8Array.from([0x50, 0x4b, 3, 4]) }), true)
  assert.equal(esExcel({ bytes: utf8('nombre;cedula') }), false)
})

// --- El Excel --------------------------------------------------------------

async function excelDePrueba(filas, encabezados = ['nombre', 'cedula', 'instalado', 'precio']) {
  const wb = new ExcelJS.Workbook()
  const hoja = wb.addWorksheet('Clientes')
  hoja.addRow(encabezados)
  for (const f of filas) hoja.addRow(f)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

test('un .xlsx da las mismas filas y encabezados que un CSV', async () => {
  const buf = await excelDePrueba([
    ['OÑA RIERA JOSÉ', '1712345678', new Date('2024-01-15T12:00:00Z'), 20.09],
    ['MASAPANTA LUIS', '1799999999', new Date('2023-06-01T12:00:00Z'), 17.39],
  ])

  const { encabezados, filas } = await leerExcel(buf, ExcelJS)
  assert.deepEqual(encabezados, ['nombre', 'cedula', 'instalado', 'precio'])
  assert.equal(filas.length, 2)
  assert.equal(filas[0].nombre, 'OÑA RIERA JOSÉ')
})

test('las fechas del Excel llegan como fecha, no como texto', async () => {
  // Es el dato que el usuario no quiere perder al migrar. Pasarlo por texto
  // obligaría a adivinar después si "01/02" es enero o febrero.
  const buf = await excelDePrueba([['Ana', '123', new Date('2024-01-15T12:00:00Z'), 20]])
  const { filas } = await leerExcel(buf, ExcelJS)
  assert.ok(filas[0].instalado instanceof Date)
  assert.equal(filas[0].instalado.getUTCFullYear(), 2024)
})

test('los números llegan como número', async () => {
  const buf = await excelDePrueba([['Ana', '123', new Date(), 20.09]])
  const { filas } = await leerExcel(buf, ExcelJS)
  assert.equal(filas[0].precio, 20.09)
})

test('una fila totalmente vacía en el medio no se importa', async () => {
  const wb = new ExcelJS.Workbook()
  const hoja = wb.addWorksheet('h')
  hoja.addRow(['nombre', 'cedula'])
  hoja.addRow(['Ana', '123'])
  hoja.addRow([])
  hoja.addRow(['Beto', '456'])
  const { filas } = await leerExcel(Buffer.from(await wb.xlsx.writeBuffer()), ExcelJS)
  assert.deepEqual(filas.map((f) => f.nombre), ['Ana', 'Beto'])
})

test('una celda con fórmula trae su resultado, no la fórmula', async () => {
  const wb = new ExcelJS.Workbook()
  const hoja = wb.addWorksheet('h')
  hoja.addRow(['nombre', 'total'])
  hoja.addRow(['Ana', { formula: 'A2', result: 42 }])
  const { filas } = await leerExcel(Buffer.from(await wb.xlsx.writeBuffer()), ExcelJS)
  assert.equal(filas[0].total, 42)
})

test('el texto con formato no llega como [object Object]', async () => {
  const wb = new ExcelJS.Workbook()
  const hoja = wb.addWorksheet('h')
  hoja.addRow(['nombre', 'cedula'])
  hoja.addRow([{ richText: [{ text: 'OÑA ' }, { text: 'RIERA' }] }, '123'])
  const { filas } = await leerExcel(Buffer.from(await wb.xlsx.writeBuffer()), ExcelJS)
  assert.equal(filas[0].nombre, 'OÑA RIERA')
})

test('se lee la primera hoja', async () => {
  const wb = new ExcelJS.Workbook()
  const h1 = wb.addWorksheet('Clientes')
  h1.addRow(['nombre', 'cedula'])
  h1.addRow(['Ana', '123'])
  const h2 = wb.addWorksheet('Otra cosa')
  h2.addRow(['x', 'y'])
  const { filas } = await leerExcel(Buffer.from(await wb.xlsx.writeBuffer()), ExcelJS)
  assert.equal(filas[0].nombre, 'Ana')
})

test('un Excel sin encabezado se rechaza con una explicación', async () => {
  const wb = new ExcelJS.Workbook()
  wb.addWorksheet('h').addRow(['solo una columna'])
  const buf = Buffer.from(await wb.xlsx.writeBuffer())
  await assert.rejects(() => leerExcel(buf, ExcelJS), /encabezado/)
})

test('un archivo que no es un Excel válido se rechaza sin reventar', async () => {
  await assert.rejects(() => leerExcel(Buffer.from('esto no es un xlsx'), ExcelJS), /No se pudo leer/)
})

// --- El punto de entrada ---------------------------------------------------

test('decide el formato y devuelve siempre la misma forma', async () => {
  const csv = await leerPlanilla({ nombre: 'padron.csv', bytes: utf8('nombre;cedula\nAna;123') })
  assert.deepEqual(csv.encabezados, ['nombre', 'cedula'])
  assert.equal(csv.formato, 'csv')

  const xlsx = await leerPlanilla({
    nombre: 'padron.xlsx',
    bytes: await excelDePrueba([['Beto', '456', new Date(), 20]]),
    ExcelJS,
  })
  assert.equal(xlsx.filas[0].nombre, 'Beto')
  assert.equal(xlsx.formato, 'excel')
})

test('el texto pelado sigue funcionando, para no romper lo que ya llamaba así', async () => {
  const r = await leerPlanilla({ texto: 'nombre,cedula\nAna,123' })
  assert.equal(r.filas[0].nombre, 'Ana')
})
