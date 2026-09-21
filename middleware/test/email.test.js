import test from 'node:test'
import assert from 'node:assert/strict'

import {
  armarCorreo,
  adjuntosDe,
  faltantesSmtp,
  crearTransporte,
  remitente,
} from '../src/sri/email.js'

/**
 * El correo es la entrega del comprobante: el SRI obliga a hacerle llegar al
 * comprador el XML autorizado. Un envío que sale sin el adjunto, o con el
 * comprobante equivocado, se descubre cuando el cliente pide el duplicado.
 */

const EMISOR = {
  razon_social: 'OÑA RIERA JEFFERSON FABIAN',
  nombre_comercial: 'HOMELINK & NET',
  telefono: '0986017616',
  smtp_host: 'smtp.gmail.com',
  smtp_user: 'facturacion@homelink.ec',
  smtp_pass_encrypted: 'cifrado',
  email_from: 'facturacion@homelink.ec',
  email_from_name: 'HOMELINK NET',
}

const DOCUMENTO = {
  establecimiento: '001',
  punto_emision: '002',
  secuencial: '000000827',
  clave_acceso: '2607202601125057992500120010020000008271619987719',
  numero_autorizacion: '2607202601125057992500120010020000008271619987719',
  fecha_emision: '2026-07-26',
  razon_social_comprador: 'ANIBAL PATRICIO SHIGUI UNSUÑO',
  email_comprador: 'homelinknetor@gmail.com',
  importe_total: 22.2,
}

// --- Mensaje ----------------------------------------------------------------

test('el asunto identifica el comprobante y a quién lo emite', () => {
  const { asunto } = armarCorreo({ emisor: EMISOR, documento: DOCUMENTO })

  assert.match(asunto, /001-002-000000827/)
  assert.match(asunto, /HOMELINK & NET/)
})

test('el cuerpo lleva el total, la fecha y la clave de acceso', () => {
  const { texto, html } = armarCorreo({ emisor: EMISOR, documento: DOCUMENTO })

  for (const cuerpo of [texto, html]) {
    assert.match(cuerpo, /\$22\.20/)
    assert.match(cuerpo, /26\/07\/2026/, 'la fecha en el formato de una factura')
    assert.match(cuerpo, /2607202601125057992500120010020000008271619987719/)
  }
})

test('el correo repite el período que dice el comprobante, no uno nuevo', () => {
  const { texto } = armarCorreo({
    emisor: EMISOR,
    documento: DOCUMENTO,
    campos: [{ nombre: 'Descripción', valor: 'Periodo del 1/Jul./2026 al 31/Jul./2026.' }],
  })

  assert.match(texto, /Periodo del 1\/Jul\.\/2026 al 31\/Jul\.\/2026\./)
})

test('el HTML escapa los nombres con &, que si no rompen el marcado', () => {
  const { html } = armarCorreo({
    emisor: EMISOR,
    documento: { ...DOCUMENTO, razon_social_comprador: 'PÉREZ & HIJOS <SA>' },
  })

  assert.match(html, /P.REZ &amp; HIJOS &lt;SA&gt;/)
  assert.doesNotMatch(html, /<SA>/)
})

// --- Adjuntos ---------------------------------------------------------------

test('van los dos archivos, nombrados con la clave de acceso', () => {
  const adjuntos = adjuntosDe({
    documento: DOCUMENTO,
    xml: '<factura/>',
    pdf: Buffer.from('%PDF-1.3'),
  })

  assert.equal(adjuntos.length, 2)
  assert.deepEqual(
    adjuntos.map((a) => a.filename),
    [`${DOCUMENTO.clave_acceso}.xml`, `${DOCUMENTO.clave_acceso}.pdf`],
  )
  assert.match(adjuntos[0].contentType, /xml/)
  assert.equal(adjuntos[1].contentType, 'application/pdf')
})

test('sin PDF va igual el XML: el comprobante es el XML', () => {
  const adjuntos = adjuntosDe({ documento: DOCUMENTO, xml: '<factura/>' })

  assert.equal(adjuntos.length, 1)
  assert.match(adjuntos[0].filename, /\.xml$/)
})

// --- Configuración ----------------------------------------------------------

test('se listan todos los datos que faltan, no solo el primero', () => {
  const faltan = faltantesSmtp({})

  assert.ok(faltan.length >= 3)
  assert.match(faltan.join(' '), /servidor SMTP/)
  assert.match(faltan.join(' '), /contraseña/)
})

test('una configuración completa no reporta faltantes', () => {
  assert.deepEqual(faltantesSmtp(EMISOR), [])
})

test('en 465 y 587 manda el puerto, aunque la configuración diga otra cosa', () => {
  /**
   * ── Por qué esta prueba cambió ──
   *
   * Antes decía que `smtp_secure` guardado pisaba al puerto. Eso rompía Gmail en
   * la vida real: la columna nace en `false` porque ninguna pantalla la muestra,
   * así que el 465 quedaba sin TLS. El servidor esperaba un saludo cifrado,
   * recibía texto plano y no contestaba nunca — "Greeting never received", que no
   * le dice nada a nadie.
   *
   * Lo encontró configurar Gmail de verdad, no una lectura del código.
   *
   * En estos dos puertos no es una preferencia, es el protocolo: el 465 es SMTPS
   * y habla TLS desde el saludo; el 587 arranca en claro y sube con STARTTLS. Un
   * 465 sin TLS no existe, y un 587 con TLS directo tampoco.
   */
  assert.equal(crearTransporte({ ...EMISOR, smtp_port: 465 }, 'x').options.secure, true)
  assert.equal(crearTransporte({ ...EMISOR, smtp_port: 587 }, 'x').options.secure, false)

  // Y lo guardado no puede desarmarlo.
  assert.equal(
    crearTransporte({ ...EMISOR, smtp_port: 465, smtp_secure: false }, 'x').options.secure,
    true,
    'el caso que rompía Gmail',
  )
  assert.equal(
    crearTransporte({ ...EMISOR, smtp_port: 587, smtp_secure: true }, 'x').options.secure,
    false,
  )
})

test('en un puerto raro sí manda lo configurado', () => {
  // Ahí no hay una respuesta correcta, y quien lo configuró sabe más que este
  // código: puede ser un servidor interno en un puerto propio.
  assert.equal(
    crearTransporte({ ...EMISOR, smtp_port: 2525, smtp_secure: true }, 'x').options.secure,
    true,
  )
  assert.equal(
    crearTransporte({ ...EMISOR, smtp_port: 2525, smtp_secure: false }, 'x').options.secure,
    false,
  )
})

test('sin puerto configurado se asume el 587, que es el habitual', () => {
  assert.equal(crearTransporte(EMISOR, 'x').options.port, 587)
})

test('el remitente sale con nombre visible si está configurado', () => {
  assert.equal(remitente(EMISOR), '"HOMELINK NET" <facturacion@homelink.ec>')

  // Sin nombre ni email_from queda el usuario del SMTP: siempre hay remitente.
  assert.equal(
    remitente({ smtp_user: 'facturacion@homelink.ec' }),
    'facturacion@homelink.ec',
  )
})
