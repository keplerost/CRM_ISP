import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { leerCsv } from '../src/lib/csv.js'

/**
 * Leer el archivo que exporta el sistema anterior.
 *
 * Todo lo que se prueba acá pasó de verdad en algún export de ISP. Un CSV
 * parece trivial hasta que llega uno con la dirección entre comillas y comas
 * adentro: partir por comas corre todas las columnas una posición y el teléfono
 * termina en la dirección. En silencio.
 */

describe('lo básico', () => {
  test('encabezados y filas', () => {
    const r = leerCsv('id,nombre,telefono\n1,Ana,0999\n2,Luis,0888')
    assert.deepEqual(r.encabezados, ['id', 'nombre', 'telefono'])
    assert.equal(r.filas.length, 2)
    assert.equal(r.filas[0].nombre, 'Ana')
    assert.equal(r.filas[1].telefono, '0888')
  })

  test('descarta las líneas vacías del final', () => {
    // Casi todo exportador deja una o dos. Contarlas como abonados haría que el
    // resumen mienta antes de importar nada.
    const r = leerCsv('id,nombre\n1,Ana\n\n\n')
    assert.equal(r.filas.length, 1)
  })
})

describe('los separadores que usa cada exportador', () => {
  test('punto y coma, que es lo que da Excel en español', () => {
    const r = leerCsv('id;nombre;saldo\n1;Ana;45,20')
    assert.equal(r.separador, ';')
    assert.equal(r.filas[0].saldo, '45,20')
  })

  test('tabulaciones', () => {
    const r = leerCsv('id\tnombre\n1\tAna')
    assert.equal(r.separador, '\t')
    assert.equal(r.filas[0].nombre, 'Ana')
  })

  test('no confunde el separador por las comas de una dirección', () => {
    // Con punto y coma como separador real, la dirección trae comas adentro.
    // Contarlas haría elegir la coma y romper todas las filas.
    const r = leerCsv('id;nombre;direccion\n1;Ana;"Av. Quito, casa 3, entre 5 y 6"')
    assert.equal(r.separador, ';')
    assert.equal(r.filas[0].direccion, 'Av. Quito, casa 3, entre 5 y 6')
  })
})

describe('las comillas', () => {
  test('una coma dentro de la dirección no parte la columna', () => {
    // El caso que rompe el `split(',')` de manual, y el que corre el teléfono
    // al lugar de la dirección sin que nadie se entere.
    const r = leerCsv('id,nombre,direccion,telefono\n1,Ana,"Av. Quito, casa 3",0999')
    assert.equal(r.filas[0].direccion, 'Av. Quito, casa 3')
    assert.equal(r.filas[0].telefono, '0999')
  })

  test('comillas dentro de un texto entrecomillado', () => {
    const r = leerCsv('id,nombre\n1,"Casa ""La Esperanza"""')
    assert.equal(r.filas[0].nombre, 'Casa "La Esperanza"')
  })

  test('un salto de línea dentro de una nota no parte el abonado', () => {
    const r = leerCsv('id,notas\n1,"Cobra el 5.\nAvisar antes."\n2,Nada')
    assert.equal(r.filas.length, 2)
    assert.match(r.filas[0].notas, /Cobra el 5\.\nAvisar antes\./)
    assert.equal(r.filas[1].notas, 'Nada')
  })
})

describe('lo que llega mal y hay que tolerar', () => {
  test('el BOM de Excel no arruina la primera columna', () => {
    // Sin sacarlo, la columna se llama "﻿id" y no coincide con ningún
    // nombre conocido: el archivo entero parece no tener identificador.
    const r = leerCsv('﻿id,nombre\n1,Ana')
    assert.deepEqual(r.encabezados, ['id', 'nombre'])
    assert.equal(r.filas[0].id, '1')
  })

  test('saltos de Windows', () => {
    const r = leerCsv('id,nombre\r\n1,Ana\r\n2,Luis')
    assert.equal(r.filas.length, 2)
    assert.equal(r.filas[1].nombre, 'Luis')
  })

  test('una fila con menos columnas se completa, no se descarta', () => {
    // Varios exportadores omiten las últimas columnas cuando están vacías.
    // Perder esos abonados sería perderlos por nada.
    const r = leerCsv('id,nombre,telefono,email\n1,Ana')
    assert.equal(r.filas.length, 1)
    assert.equal(r.filas[0].nombre, 'Ana')
    assert.equal(r.filas[0].email, '')
  })

  test('espacios alrededor de los valores', () => {
    const r = leerCsv('id , nombre \n 1 , Ana ')
    assert.equal(r.filas[0].nombre, 'Ana')
  })
})

describe('lo que se rechaza', () => {
  test('un archivo vacío', () => {
    assert.throws(() => leerCsv(''), /vacío/)
    assert.throws(() => leerCsv('   \n  '), /vacío/)
  })

  test('algo que no es una tabla', () => {
    // Un PDF renombrado, o un export que salió mal. Mejor decirlo que importar
    // una sola columna sin sentido.
    assert.throws(() => leerCsv('esto no es un csv\nni esto'), /encabezado/)
  })
})
