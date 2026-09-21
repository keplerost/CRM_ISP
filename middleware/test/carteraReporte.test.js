import test from 'node:test'
import assert from 'node:assert/strict'

import { COLUMNAS_GESTIONES, gestionesACSV } from '../../web/src/lib/carteraReporte.js'

/**
 * El reporte de recuperación de equipos.
 *
 * Es el papel con el que alguien sale a la calle: una columna corrida manda a
 * un técnico a la dirección de otro abonado. Por eso se prueba el escapado con
 * lo que de verdad aparece en estos campos — el abonado dice "pasá el jueves;
 * después de las 6" con punto y coma, y la dirección lleva comillas.
 */

const gestion = (extra = {}) => ({
  cliente_codigo: 132,
  cliente: 'Ana Pérez',
  telefono: '0999000000',
  direccion: 'Av. Principal',
  zona: 'Centro',
  serie: 'SN-1',
  modelo: 'ONT XPON',
  valor: 35,
  meses_sin_pago: 3,
  responsable: 'Rosa Pérez',
  estado_orden: 'asignado',
  ...extra,
})

test('el encabezado es el del recorrido: a quién, dónde, cuándo y qué dijo', () => {
  const [encabezado] = gestionesACSV([]).split('\n')
  assert.equal(
    encabezado,
    'ID;Cliente;Teléfono;Dirección;Zona;Equipo;Valor;Meses sin pagar;Responsable;Cita;Lo que pidió;Contacto;Resultado;Lo que dijo;Estado;Motivo del cierre',
  )
})

test('el punto y coma de lo que dijo el abonado no corre las columnas', () => {
  const csv = gestionesACSV([
    gestion({ observacion: 'Dijo: pasá el jueves; después de las 6', direccion: 'Av. "La Y", casa 3' }),
  ])
  const fila = csv.split('\n')[1]

  assert.ok(fila.includes('"Dijo: pasá el jueves; después de las 6"'))
  assert.ok(fila.includes('"Av. ""La Y"", casa 3"'))
  // Y sigue teniendo una sola fila: un salto sin escapar partiría el registro.
  assert.equal(csv.split('\n').length, 2)
})

test('un salto de línea adentro de una observación no parte el archivo', () => {
  const csv = gestionesACSV([gestion({ observacion: 'No estaba.\nVolver el sábado.' })])
  assert.equal(csv.split('\n').length, 3, 'la comilla mantiene el campo, aunque ocupe dos renglones')
  assert.ok(csv.includes('"No estaba.\nVolver el sábado."'))
})

test('el ID se lee con seis dígitos y el valor con dos decimales', () => {
  const fila = gestionesACSV([gestion()]).split('\n')[1]
  assert.ok(fila.startsWith('000132;Ana Pérez'))
  assert.ok(fila.includes(';35.00;'))
})

test('la orden que nadie visitó igual sale, con el contacto vacío', () => {
  // Es la fila que más importa del reporte: a esa casa no fue nadie.
  const fila = gestionesACSV([gestion({ contacto_en: null, resultado: null, observacion: null })]).split('\n')[1]
  const campos = fila.split(';')
  assert.equal(campos.length, COLUMNAS_GESTIONES.length)
  assert.equal(campos[COLUMNAS_GESTIONES.findIndex((c) => c.titulo === 'Resultado')], '')
})

test('las fechas salen en formato local, no en ISO', () => {
  const csv = gestionesACSV([gestion({ agendado_para: '2026-08-20T15:00:00-05:00' })])
  assert.ok(/20\/08\/2026 \d{2}:\d{2}/.test(csv), 'la cita tiene que leerse como fecha, no como ISO')
  assert.ok(!csv.includes('2026-08-20T'), 'no puede quedar el ISO crudo')
})

test('todas las columnas devuelven texto aunque la fila venga vacía', () => {
  for (const c of COLUMNAS_GESTIONES) {
    const v = c.valor({})
    assert.ok(v === '' || v === undefined || v === null || typeof v === 'string' || typeof v === 'number',
      `${c.titulo} devolvió algo raro`)
  }
})
