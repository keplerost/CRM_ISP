import test from 'node:test'
import assert from 'node:assert/strict'

import { endpointsDe, resumirMensajes } from '../src/sri/sriSoap.js'

/**
 * El parseo de las respuestas del SRI se prueba con respuestas reales grabadas.
 * Lo que más importa es no perder los mensajes de error: son lo único que
 * explica por qué rechazó un comprobante.
 */

// Se accede a los parsers a través de las funciones exportadas simulando fetch,
// porque el parseo vive dentro del módulo y no tiene sentido exportarlo solo
// para el test.
const RESPUESTA_RECIBIDA = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion">
      <RespuestaRecepcionComprobante>
        <estado>RECIBIDA</estado>
        <comprobantes/>
      </RespuestaRecepcionComprobante>
    </ns2:validarComprobanteResponse>
  </soap:Body>
</soap:Envelope>`

const RESPUESTA_DEVUELTA = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion">
      <RespuestaRecepcionComprobante>
        <estado>DEVUELTA</estado>
        <comprobantes>
          <comprobante>
            <claveAcceso>3107202601050405615100110010010000000011234567819</claveAcceso>
            <mensajes>
              <mensaje>
                <identificador>43</identificador>
                <mensaje>CLAVE ACCESO REGISTRADA</mensaje>
                <informacionAdicional>El comprobante ya fue registrado antes</informacionAdicional>
                <tipo>ERROR</tipo>
              </mensaje>
            </mensajes>
          </comprobante>
        </comprobantes>
      </RespuestaRecepcionComprobante>
    </ns2:validarComprobanteResponse>
  </soap:Body>
</soap:Envelope>`

const RESPUESTA_AUTORIZADO = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion">
      <RespuestaAutorizacionComprobante>
        <claveAccesoConsultada>3107202601050405615100110010010000000011234567819</claveAccesoConsultada>
        <numeroComprobantes>1</numeroComprobantes>
        <autorizaciones>
          <autorizacion>
            <estado>AUTORIZADO</estado>
            <numeroAutorizacion>3107202601050405615100110010010000000011234567819</numeroAutorizacion>
            <fechaAutorizacion>2026-07-31T10:15:30-05:00</fechaAutorizacion>
            <ambiente>PRUEBAS</ambiente>
            <comprobante><![CDATA[<factura id="comprobante"><infoTributaria/></factura>]]></comprobante>
            <mensajes/>
          </autorizacion>
        </autorizaciones>
      </RespuestaAutorizacionComprobante>
    </ns2:autorizacionComprobanteResponse>
  </soap:Body>
</soap:Envelope>`

const RESPUESTA_EN_PROCESO = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <RespuestaAutorizacionComprobante>
      <claveAccesoConsultada>3107202601050405615100110010010000000011234567819</claveAccesoConsultada>
      <numeroComprobantes>0</numeroComprobantes>
      <autorizaciones/>
    </RespuestaAutorizacionComprobante>
  </soap:Body>
</soap:Envelope>`

/** Reemplaza fetch para devolver una respuesta grabada. */
function conFetchSimulado(cuerpo, fn) {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(cuerpo, { status: 200 })
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

const CLAVE = '3107202601050405615100110010010000000011234567819'

test('los endpoints cambian según el ambiente', () => {
  assert.match(endpointsDe('1').recepcion, /celcer\.sri\.gob\.ec/)
  assert.equal(endpointsDe('1').nombre, 'pruebas')

  assert.match(endpointsDe('2').recepcion, /^https:\/\/cel\.sri\.gob\.ec/)
  assert.equal(endpointsDe('2').nombre, 'producción')

  // Sin ambiente definido se usa pruebas: es el lado seguro.
  assert.match(endpointsDe(undefined).recepcion, /celcer/)
})

test('una recepción exitosa se reporta como recibida', async () => {
  const { enviarComprobante } = await import('../src/sri/sriSoap.js')
  await conFetchSimulado(RESPUESTA_RECIBIDA, async () => {
    const r = await enviarComprobante('<factura id="comprobante"/>', '1')
    assert.equal(r.estado, 'RECIBIDA')
    assert.equal(r.recibida, true)
    assert.deepEqual(r.mensajes, [])
  })
})

test('una devolución conserva el motivo del rechazo', async () => {
  const { enviarComprobante } = await import('../src/sri/sriSoap.js')
  await conFetchSimulado(RESPUESTA_DEVUELTA, async () => {
    const r = await enviarComprobante('<factura id="comprobante"/>', '1')

    assert.equal(r.estado, 'DEVUELTA')
    assert.equal(r.recibida, false)
    assert.equal(r.mensajes.length, 1)
    assert.equal(r.mensajes[0].identificador, '43')
    assert.equal(r.mensajes[0].mensaje, 'CLAVE ACCESO REGISTRADA')
    assert.equal(r.mensajes[0].informacionAdicional, 'El comprobante ya fue registrado antes')
    assert.equal(r.mensajes[0].tipo, 'ERROR')
    // Se guarda el crudo para poder diagnosticar lo que el parseo no cubra.
    assert.ok(r.respuestaCruda)
  })
})

test('una autorización se parsea completa', async () => {
  const { consultarAutorizacion } = await import('../src/sri/sriSoap.js')
  await conFetchSimulado(RESPUESTA_AUTORIZADO, async () => {
    const r = await consultarAutorizacion(CLAVE, '1')

    assert.equal(r.estado, 'AUTORIZADO')
    assert.equal(r.autorizado, true)
    assert.equal(r.pendiente, false)
    assert.equal(r.numeroAutorizacion, CLAVE)
    assert.equal(r.fechaAutorizacion, '2026-07-31T10:15:30-05:00')
    // El comprobante autorizado viene en CDATA y hay que devolverlo limpio.
    assert.equal(r.comprobante, '<factura id="comprobante"><infoTributaria/></factura>')
  })
})

/**
 * El SRI devuelve el comprobante autorizado de dos formas: en CDATA o con las
 * etiquetas escapadas. Guardar la segunda tal cual deja un archivo que no es
 * XML — el comprador no puede procesarlo y el RIDE se queda sin los campos
 * adicionales.
 */
test('el comprobante escapado se guarda como XML de verdad', async () => {
  const { desenvolverComprobante } = await import('../src/sri/sriSoap.js')

  const escapado =
    '&lt;factura id=&quot;comprobante&quot;&gt;&lt;razonSocial&gt;FIBRA &amp;amp; REDES&lt;/razonSocial&gt;&lt;/factura&gt;'

  assert.equal(
    desenvolverComprobante(escapado),
    '<factura id="comprobante"><razonSocial>FIBRA &amp; REDES</razonSocial></factura>',
  )
})

test('un comprobante que ya está bien no se toca', () => {
  const xml = '<factura id="comprobante"><razonSocial>FIBRA &amp; REDES</razonSocial></factura>'
  return import('../src/sri/sriSoap.js').then(({ desenvolverComprobante }) => {
    // Idempotente: se puede aplicar al leer sin arruinar lo que ya estaba sano.
    assert.equal(desenvolverComprobante(xml), xml)
    assert.equal(desenvolverComprobante(desenvolverComprobante(xml)), xml)
    assert.equal(desenvolverComprobante(null), null)
  })
})

test('sin autorizaciones todavía se reporta como en proceso, no como error', async () => {
  const { consultarAutorizacion } = await import('../src/sri/sriSoap.js')
  await conFetchSimulado(RESPUESTA_EN_PROCESO, async () => {
    const r = await consultarAutorizacion(CLAVE, '1')

    assert.equal(r.pendiente, true)
    assert.equal(r.estado, 'EN_PROCESO')
    assert.equal(r.numeroComprobantes, 0)
    assert.ok(r.aviso, 'debe explicar que hay que volver a consultar')
  })
})

test('una clave inválida se rechaza antes de llamar al SRI', async () => {
  const { consultarAutorizacion } = await import('../src/sri/sriSoap.js')
  await assert.rejects(consultarAutorizacion('123', '1'), /49 dígitos/)
})

test('resumirMensajes arma un texto legible', () => {
  assert.equal(
    resumirMensajes([
      { identificador: '43', mensaje: 'CLAVE ACCESO REGISTRADA', informacionAdicional: 'ya existe' },
    ]),
    '[43] CLAVE ACCESO REGISTRADA — ya existe',
  )
  assert.equal(resumirMensajes([]), null)
})
