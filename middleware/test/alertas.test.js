import test from 'node:test'
import assert from 'node:assert/strict'

import {
  enHorario,
  haceCuanto,
  leCorresponde,
  textoAlerta,
  duracion,
} from '../../web/src/lib/alertas.js'

/**
 * Los textos y los filtros de las alertas.
 *
 * Lo que se cuida acá es que un mensaje sirva a las tres de la mañana: que diga
 * dónde, cuántos y desde cuándo. Y que a esa hora suene solo lo que amerita
 * levantarse — si no, a la semana el destinatario silencia el chat y la
 * herramienta deja de existir.
 */

const AHORA = new Date('2026-08-14T15:30:00')

test('un corte agrupado nombra la caja y cuántos abonados abarca', () => {
  const t = textoAlerta(
    {
      regla: 'corte_grupo',
      etiqueta: 'NAP-12',
      abonados: 8,
      zona: 'Centro',
      empezo_en: new Date('2026-08-14T15:18:00'),
    },
    AHORA,
  )

  assert.match(t, /🔴 CORTE — NAP-12/)
  assert.match(t, /8 abonados sin señal desde las 15:18/)
  assert.match(t, /hace 12 min/)
  assert.match(t, /Zona: Centro/)
})

test('una ONT sola dice que su caja está normal: es lo que la hace sospechosa', () => {
  const t = textoAlerta(
    {
      regla: 'ont_caida',
      etiqueta: 'Ana Pérez',
      zona: 'Centro',
      empezo_en: new Date('2026-08-14T15:20:00'),
      detalle: { codigo: 132, telefono: '0999000000' },
    },
    AHORA,
  )

  assert.match(t, /Sin señal — Ana Pérez \(000132\)/)
  assert.match(t, /Su caja está normal/)
  assert.match(t, /Tel: 0999000000/)
})

test('el aviso de que volvió el servicio es corto y se distingue de un problema', () => {
  const t = textoAlerta({ regla: 'corte_grupo', etiqueta: 'NAP-12', resuelto: true }, AHORA)
  assert.match(t, /^✅/)
  assert.match(t, /se restableció/)
})

test('la antigüedad se dice en minutos, horas o días según cuál se entienda', () => {
  assert.equal(haceCuanto(new Date('2026-08-14T15:18:00'), AHORA), 'hace 12 min')
  assert.equal(haceCuanto(new Date('2026-08-14T13:30:00'), AHORA), 'hace 2 h')
  assert.equal(haceCuanto(new Date('2026-08-11T15:30:00'), AHORA), 'hace 3 d')
  assert.equal(haceCuanto(null, AHORA), '')
})

test('un destino sin filtros recibe todo', () => {
  const d = { activo: true, tipos: [], zonas: [] }
  assert.equal(leCorresponde(d, { regla: 'ont_caida', zona: 'Centro' }, AHORA), true)
  assert.equal(leCorresponde(d, { regla: 'corte_grupo', zona: 'La Maná' }, AHORA), true)
})

test('los filtros de tipo y de zona se suman', () => {
  const tecnico = { activo: true, tipos: ['corte_grupo'], zonas: ['Centro'] }

  assert.equal(leCorresponde(tecnico, { regla: 'corte_grupo', zona: 'Centro' }, AHORA), true)
  // Tipo que no recibe.
  assert.equal(leCorresponde(tecnico, { regla: 'degradacion', zona: 'Centro' }, AHORA), false)
  // Zona que no es la suya.
  assert.equal(leCorresponde(tecnico, { regla: 'corte_grupo', zona: 'La Maná' }, AHORA), false)
})

test('un evento sin zona no se descarta por el filtro de zonas', () => {
  // Un corte de una caja sin zona cargada es justo el que no hay que perderse.
  const d = { activo: true, tipos: [], zonas: ['Centro'] }
  assert.equal(leCorresponde(d, { regla: 'corte_grupo', zona: null }, AHORA), true)
})

test('un destino apagado no recibe nada', () => {
  assert.equal(leCorresponde({ activo: false, tipos: [], zonas: [] }, { regla: 'ont_caida' }), false)
})

test('la franja de la guardia nocturna cruza la medianoche', () => {
  const guardia = { desde_hora: '20:00', hasta_hora: '07:00' }

  assert.equal(enHorario(guardia, new Date('2026-08-14T23:00:00')), true)
  assert.equal(enHorario(guardia, new Date('2026-08-14T03:00:00')), true)
  assert.equal(enHorario(guardia, new Date('2026-08-14T15:00:00')), false)
})

test('la franja normal no cruza la medianoche', () => {
  const diurno = { desde_hora: '07:00', hasta_hora: '20:00' }

  assert.equal(enHorario(diurno, new Date('2026-08-14T15:00:00')), true)
  assert.equal(enHorario(diurno, new Date('2026-08-14T06:00:00')), false)
  assert.equal(enHorario(diurno, new Date('2026-08-14T22:00:00')), false)
})

test('sin horario cargado se recibe a cualquier hora', () => {
  assert.equal(enHorario({}, new Date('2026-08-14T03:00:00')), true)
})

test('sin ficha de cliente, el aviso igual sirve: nombre de la OLT, dirección y serie', () => {
  // Es la situación normal en una instalación nueva: la red está cargada y el
  // CRM todavía no. Si la alerta dependiera de la ficha, no serviría para nada.
  const t = textoAlerta(
    {
      regla: 'ont_caida',
      etiqueta: 'MORALES GUAMAN KLEVER ARNULFO',
      zona: null,
      empezo_en: new Date('2026-08-14T15:16:00'),
      detalle: { direccion: 'RECINTO SELVALEGRE', sn: 'NBELB17EADD5', codigo: null },
    },
    AHORA,
  )

  assert.match(t, /Sin señal — MORALES GUAMAN KLEVER ARNULFO/)
  assert.match(t, /RECINTO SELVALEGRE/)
  // Sin código de abonado va la serie: es lo único con lo que se encuentra el equipo.
  assert.match(t, /SN: NBELB17EADD5/)
  assert.doesNotMatch(t, /\(000000\)/, 'no puede inventar un código de abonado')
})

test('con ficha, va el código y no la serie', () => {
  const t = textoAlerta(
    {
      regla: 'ont_caida',
      etiqueta: 'Ana Pérez',
      empezo_en: new Date('2026-08-14T15:16:00'),
      detalle: { codigo: 132, sn: 'SN-1', direccion: 'Av. Principal' },
    },
    AHORA,
  )

  assert.match(t, /Ana Pérez \(000132\)/)
  assert.doesNotMatch(t, /SN: /, 'con código, la serie es ruido')
  assert.match(t, /Av\. Principal/)
})

test('la dirección va antes que la zona: es con lo que se llega a la puerta', () => {
  const t = textoAlerta({
    regla: 'ont_caida',
    etiqueta: 'Ana',
    zona: 'Centro',
    empezo_en: new Date(),
    detalle: { direccion: 'Calle 5' },
  })

  assert.ok(t.indexOf('Calle 5') < t.indexOf('Zona: Centro'))
})


// --- Plazo de atención (migración 219) ---------------------------------------

const PLAZO = {
  regla: 'plazo_atencion',
  entidad: 'ticket',
  etiqueta: 'Ana Pérez',
  zona: 'Centro',
  detalle: {
    numero: '128',
    tipo_nombre: 'Sin internet',
    tecnico: 'Carlos',
    direccion: 'Av. Principal y Calle 5',
    telefono: '0991234567',
  },
}

test('plazo por vencer: qué trabajo, cuánto falta, quién lo tiene y dónde', () => {
  const vence = new Date(AHORA.getTime() + 45 * 60000)
  const t = textoAlerta({ ...PLAZO, detalle: { ...PLAZO.detalle, vence_at: vence.toISOString() } }, AHORA)

  assert.match(t, /Plazo por vencer — Ticket N° 128/)
  assert.match(t, /Sin internet · Ana Pérez/)
  assert.match(t, /en 45 min/)
  assert.match(t, /Técnico: Carlos/)
  assert.match(t, /📍 Av. Principal/)
  assert.match(t, /Tel: 0991234567/)
})

test('plazo vencido y sin técnico: lo dice en mayúsculas', () => {
  const vence = new Date(AHORA.getTime() - 130 * 60000)
  const t = textoAlerta(
    { ...PLAZO, entidad: 'instalacion', detalle: { ...PLAZO.detalle, tecnico: undefined, vence_at: vence.toISOString() } },
    AHORA,
  )

  assert.match(t, /PLAZO VENCIDO — Instalación N° 128/)
  assert.match(t, /hace 2 h 10 min/)
  assert.match(t, /SIN TÉCNICO ASIGNADO/)
})

test('plazo asignado a una cuadrilla: la nombra con sus integrantes, no "sin técnico"', () => {
  const vence = new Date(AHORA.getTime() + 30 * 60000)
  const t = textoAlerta(
    {
      ...PLAZO,
      detalle: {
        ...PLAZO.detalle,
        tecnico: undefined,
        cuadrilla: 'TROOPER',
        integrantes: 'Byron, David',
        vence_at: vence.toISOString(),
      },
    },
    AHORA,
  )

  assert.match(t, /Cuadrilla: TROOPER \(Byron, David\)/)
  assert.doesNotMatch(t, /SIN TÉCNICO/)
  assert.doesNotMatch(t, /Técnico:/)
})

test('el cierre de un plazo no dice "se restableció"', () => {
  const t = textoAlerta({ ...PLAZO, resuelto: true }, AHORA)
  assert.match(t, /ya llegó el técnico o se cerró/)
  assert.doesNotMatch(t, /restableció/)
})

test('duracion: minutos, horas y días', () => {
  assert.equal(duracion(45), '45 min')
  assert.equal(duracion(120), '2 h')
  assert.equal(duracion(130), '2 h 10 min')
  assert.equal(duracion(3 * 24 * 60 + 5), '3 d')
})
