import test from 'node:test'
import assert from 'node:assert/strict'

import { generarDocumento, generarTirilla } from '../src/pagos/documentoPdf.js'

/**
 * El motor que comparten el contrato, la hoja de instalación y el ticket.
 *
 * Lo que se cuida acá es lo que rompe un documento que alguien va a firmar: que
 * la firma capturada se vea, que no se pierda texto, y que un dato faltante o un
 * archivo corrupto no dejen sin papel a nadie.
 */

const EMPRESA = { nombre_comercial: 'OR IMPORTACIONES', ruc: '0504056151001' }

// Un PNG de 1×1 válido: sirve para comprobar que la firma se embebe de verdad.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('la firma capturada se dibuja sobre la raya', async () => {
  // El punto entero de la hoja de instalación: la firma ya se guardaba y no la
  // veía nadie.
  const conFirma = await generarDocumento({
    plantilla: '<p>Recibí conforme el equipo instalado.</p>',
    empresa: EMPRESA,
    firmas: [{ nombre: 'Edison Delgado', pie: 'C.I. 1234569870', imagen_b64: PNG }],
  })
  const sinFirma = await generarDocumento({
    plantilla: '<p>Recibí conforme el equipo instalado.</p>',
    empresa: EMPRESA,
    firmas: [{ nombre: 'Edison Delgado', pie: 'C.I. 1234569870' }],
  })

  assert.match(conFirma.toString('latin1'), /\/Image/, 'la firma tiene que quedar embebida')
  assert.ok(
    conFirma.length > sinFirma.length,
    'el documento con firma pesa más que el mismo sin firma',
  )
})

test('una firma ilegible no impide sacar el documento', async () => {
  // La firma se captura en una tablet, en la calle: puede llegar cortada. Que
  // eso deje al técnico sin hoja para hacer firmar sería absurdo.
  const pdf = await generarDocumento({
    plantilla: '<p>Recibí conforme.</p>',
    empresa: EMPRESA,
    firmas: [{ nombre: 'Edison Delgado', imagen_b64: 'no-es-una-imagen' }],
  })

  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
})

test('sin firmantes no se dibuja ninguna raya', async () => {
  // Un reporte recién abierto no tiene atención que conformar, y una raya vacía
  // invita a que alguien la firme igual.
  const conRaya = await generarDocumento({
    plantilla: '<p>Reporte recibido.</p>',
    empresa: EMPRESA,
    firmas: [{ nombre: 'Alguien' }],
  })
  const sinRaya = await generarDocumento({
    plantilla: '<p>Reporte recibido.</p>',
    empresa: EMPRESA,
    firmas: [],
  })

  assert.ok(sinRaya.length < conRaya.length)
})

test('la tirilla respeta el ancho de la impresora', () => {
  const salida = generarTirilla({
    plantilla: 'OR IMPORTACIONES\nRECIBO 52\nDEMO CARTERA CUATRO\nTOTAL $20.09',
    ancho: 32,
  })

  for (const l of salida.split('\n')) {
    assert.ok(l.length <= 32, `la línea "${l}" se pasa del ancho de la tirilla`)
  }
  assert.match(salida, /RECIBO 52/)
})

test('la tirilla corta por palabras y no por la mitad de un dato', () => {
  // Partir "TRANSFERENCIA" a la mitad haría ilegible justo lo que el abonado
  // busca en el papel.
  const salida = generarTirilla({
    plantilla: 'Forma de pago TRANSFERENCIA bancaria registrada',
    ancho: 20,
  })

  assert.match(salida, /^TRANSFERENCIA$/m)
  for (const l of salida.split('\n')) assert.ok(l.length <= 20)
})

test('una palabra más larga que la tirilla se parte, porque no hay otra', () => {
  const salida = generarTirilla({ plantilla: 'REF' + '9'.repeat(40), ancho: 20 })

  const lineas = salida.split('\n')
  assert.ok(lineas.length > 1)
  for (const l of lineas) assert.ok(l.length <= 20)
  // Y no se perdió ningún dígito por el camino.
  assert.equal(lineas.join(''), 'REF' + '9'.repeat(40))
})

test('la línea separadora se ajusta al ancho en vez de doblarse', () => {
  // Una raya de 26 guiones en una tirilla de 32 deja el recibo torcido; una de
  // 40 se parte en dos y queda una raya huérfana.
  const salida = generarTirilla({
    plantilla: 'RECIBO\n--------------------------\nTOTAL $20.09',
    ancho: 32,
  })

  assert.match(salida, /^-{32}$/m)
  assert.equal(salida.split('\n').filter((l) => l.startsWith('-')).length, 1)
})

test('la tirilla de 80 mm usa el ancho más grande', () => {
  const salida = generarTirilla({ plantilla: '----\nTOTAL', ancho: 48 })
  assert.match(salida, /^-{48}$/m)
})
