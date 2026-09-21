import test from 'node:test'
import assert from 'node:assert/strict'
import forge from 'node-forge'

import { firmarComprobante, verificarFirma } from '../src/sri/firmaXades.js'
import { leerCertificado, resumenCertificado } from '../src/sri/certificado.js'
import { generarXmlFactura } from '../src/sri/facturaXml.js'
import { generarClaveAcceso } from '../src/sri/claveAcceso.js'

/**
 * Se genera un certificado autofirmado al vuelo para poder probar la firma sin
 * necesitar el .p12 real. No reemplaza a la validación del SRI —eso solo se
 * confirma emitiendo contra su ambiente de pruebas— pero detecta lo que más
 * falla: digests mal calculados y firmas que no corresponden al certificado.
 */
function certificadoDePrueba({ password = 'test123', dias = 365 } = {}) {
  const claves = forge.pki.rsa.generateKeyPair(1024) // corto: es solo para el test
  const cert = forge.pki.createCertificate()

  cert.publicKey = claves.publicKey
  cert.serialNumber = '01A2B3C4'
  cert.validity.notBefore = new Date(Date.now() - 86400000)
  cert.validity.notAfter = new Date(Date.now() + dias * 86400000)

  const atributos = [
    { name: 'commonName', value: 'PRUEBA FIRMA ELECTRONICA' },
    { name: 'countryName', value: 'EC' },
    { name: 'organizationName', value: 'ENTIDAD DE PRUEBA' },
  ]
  cert.setSubject(atributos)
  cert.setIssuer(atributos)
  cert.sign(claves.privateKey, forge.md.sha256.create())

  const p12 = forge.pkcs12.toPkcs12Asn1(claves.privateKey, [cert], password, {
    generateLocalKeyId: true,
    friendlyName: 'prueba',
  })

  return {
    p12Base64: forge.util.encode64(forge.asn1.toDer(p12).getBytes()),
    password,
  }
}

const { p12Base64, password } = certificadoDePrueba()

const XML = generarXmlFactura({
  emisor: {
    ruc: '1790012345001',
    razon_social: 'FIBRA & REDES S.A.',
    dir_matriz: 'Av. Principal 123',
    obligado_contabilidad: true,
    ambiente: '1',
  },
  factura: {
    claveAcceso: generarClaveAcceso({
      fechaEmision: '2026-07-31',
      tipoComprobante: '01',
      ruc: '1790012345001',
      secuencial: 1,
    }),
    secuencial: 1,
    fechaEmision: '31/07/2026',
    razonSocialComprador: 'OÑA RIERA JOSÉ LUIS',
    identificacionComprador: '1712345678',
    emailComprador: 'cliente@ejemplo.com',
  },
  detalles: [
    { descripcion: 'Internet 50 Mbps', cantidad: 1, precioUnitario: 25, tarifaIva: 15, codigoPorcentaje: '4' },
  ],
})

// --- Lectura del certificado ------------------------------------------------

test('lee la clave y el certificado del .p12', () => {
  const c = leerCertificado(p12Base64, password)

  assert.ok(c.clavePrivada, 'debe traer la clave privada')
  assert.ok(c.certificadoB64.length > 100)
  assert.match(c.sujeto, /PRUEBA FIRMA ELECTRONICA/)
  // El emisor va con el CN primero, que es como lo espera el SRI.
  assert.match(c.emisor, /^CN=|^O=/)
  assert.ok(c.serie.length > 0)
  assert.ok(c.modulusB64.length > 0)
  assert.ok(c.exponentB64.length > 0)
})

test('la contraseña incorrecta da un error claro', () => {
  assert.throws(() => leerCertificado(p12Base64, 'incorrecta'), /No se pudo abrir el certificado/)
})

test('un certificado vencido se rechaza antes de firmar', () => {
  // Firmar con uno vencido produce un rechazo del SRI difícil de diagnosticar.
  const vencido = certificadoDePrueba({ dias: -10 })
  assert.throws(() => leerCertificado(vencido.p12Base64, vencido.password), /venció/)
})

test('el resumen avisa cuándo está por vencer', () => {
  const porVencer = certificadoDePrueba({ dias: 15 })
  const r = resumenCertificado(porVencer.p12Base64, porVencer.password)

  assert.equal(r.porVencer, true)
  assert.ok(r.diasParaVencer <= 30)

  const lejano = resumenCertificado(p12Base64, password)
  assert.equal(lejano.porVencer, false)
})

// --- Estructura de la firma -------------------------------------------------

test('la firma se inserta dentro del comprobante', () => {
  const { xmlFirmado } = firmarComprobante(XML, p12Base64, password)

  assert.ok(xmlFirmado.includes('<ds:Signature'))
  // Tiene que quedar ANTES del cierre de factura, no después.
  assert.ok(xmlFirmado.indexOf('<ds:Signature') < xmlFirmado.indexOf('</factura>'))
  assert.ok(xmlFirmado.endsWith('</factura>'))
})

test('usa SHA-1, que es lo que exige el perfil del SRI', () => {
  const { xmlFirmado } = firmarComprobante(XML, p12Base64, password)

  assert.ok(xmlFirmado.includes('xmldsig#rsa-sha1'))
  assert.ok(xmlFirmado.includes('xmldsig#sha1'))
  assert.ok(!xmlFirmado.includes('sha256'), 'SHA-256 hace que el SRI rechace el comprobante')
})

test('incluye las tres referencias del perfil XAdES-BES', () => {
  const { xmlFirmado } = firmarComprobante(XML, p12Base64, password)

  assert.ok(xmlFirmado.includes('URI="#comprobante"'), 'referencia al comprobante')
  assert.ok(xmlFirmado.includes('Type="http://uri.etsi.org/01903#SignedProperties"'))
  assert.ok(/URI="#Certificate\d+"/.test(xmlFirmado), 'referencia al KeyInfo')
  assert.equal((xmlFirmado.match(/<ds:Reference/g) ?? []).length, 3)
})

test('la referencia al comprobante lleva la transformación enveloped', () => {
  const { xmlFirmado } = firmarComprobante(XML, p12Base64, password)
  assert.ok(xmlFirmado.includes('xmldsig#enveloped-signature'))
})

test('trae los datos del certificado que exige SignedProperties', () => {
  const { xmlFirmado } = firmarComprobante(XML, p12Base64, password)

  assert.ok(xmlFirmado.includes('<etsi:SigningTime>'))
  assert.ok(xmlFirmado.includes('<etsi:SigningCertificate>'))
  assert.ok(xmlFirmado.includes('<ds:X509IssuerName>'))
  assert.ok(xmlFirmado.includes('<ds:X509SerialNumber>'))
  assert.ok(xmlFirmado.includes('<ds:Modulus>'))
  assert.ok(xmlFirmado.includes('<ds:Exponent>'))
})

test('SigningTime lleva el desplazamiento horario', () => {
  const { xmlFirmado } = firmarComprobante(XML, p12Base64, password)
  const m = xmlFirmado.match(/<etsi:SigningTime>([^<]+)</)
  assert.match(m[1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
})

// --- Verificación criptográfica ---------------------------------------------

test('la firma generada se verifica a sí misma', () => {
  const { xmlFirmado } = firmarComprobante(XML, p12Base64, password)
  const r = verificarFirma(xmlFirmado)

  assert.equal(r.valida, true, `problemas: ${r.problemas.join(' · ')}`)
})

test('detecta un comprobante alterado después de firmar', () => {
  // Cambiar el importe después de firmar tiene que romper el digest.
  const { xmlFirmado } = firmarComprobante(XML, p12Base64, password)
  const alterado = xmlFirmado.replace(
    '<importeTotal>28.75</importeTotal>',
    '<importeTotal>1.00</importeTotal>',
  )

  const r = verificarFirma(alterado)
  assert.equal(r.valida, false)
  assert.ok(r.problemas.some((p) => /digest del comprobante/.test(p)))
})

test('detecta una SignatureValue manipulada', () => {
  const { xmlFirmado, signatureValue } = firmarComprobante(XML, p12Base64, password)

  // Se altera un carácter del medio: tocar el final rompería el relleno del
  // base64 y fallaría al decodificar, sin llegar a verificar la firma.
  const i = Math.floor(signatureValue.length / 2)
  const otro =
    signatureValue.slice(0, i) +
    (signatureValue[i] === 'A' ? 'B' : 'A') +
    signatureValue.slice(i + 1)

  const r = verificarFirma(xmlFirmado.replace(signatureValue, otro))
  assert.equal(r.valida, false)
  assert.ok(
    r.problemas.some((p) => /no valida contra el certificado/.test(p)),
    `esperaba el fallo de verificación, llegó: ${r.problemas.join(' · ')}`,
  )
})

test('el digest del comprobante se calcula sin la firma', () => {
  // Es lo que significa la transformación enveloped: el digest corresponde al
  // documento ANTES de insertarle la firma.
  const { xmlFirmado, digests } = firmarComprobante(XML, p12Base64, password)

  const sinFirma = xmlFirmado.replace(/<ds:Signature[\s\S]*?<\/ds:Signature>/, '')
  assert.equal(sinFirma.replace(/^<\?xml[^?]*\?>\s*/, ''), XML.replace(/^<\?xml[^?]*\?>\s*/, ''))
  assert.ok(digests.comprobante.length > 20)
})

test('los acentos del comprobante sobreviven a la firma', () => {
  const { xmlFirmado } = firmarComprobante(XML, p12Base64, password)
  assert.ok(xmlFirmado.includes('OÑA RIERA JOSÉ LUIS'))
  assert.equal(verificarFirma(xmlFirmado).valida, true)
})

// --- Validaciones -----------------------------------------------------------

test('rechaza un XML sin id="comprobante"', () => {
  assert.throws(
    () => firmarComprobante('<factura><a/></factura>', p12Base64, password),
    /id="comprobante"/,
  )
})

test('rechaza si no hay certificado', () => {
  assert.throws(() => firmarComprobante(XML, null, password), /No hay certificado/)
})

/**
 * Regresión del error que hacía rechazar TODOS los comprobantes.
 *
 * El SRI respondía "[39] FIRMA INVALIDA" sin más detalle. La causa: el
 * algoritmo declarado es C14N 1.0 INCLUSIVO, y al canonicalizar un subárbol su
 * elemento raíz recibe todos los namespaces en contexto —usados o no— ordenados
 * por prefijo. Dentro de <ds:Signature> el contexto es ds + etsi.
 *
 * Se firmaba sobre SignedInfo con xmlns:ds solamente, así que el SRI calculaba
 * un digest distinto. Con ambos namespaces, y en ese orden, el comprobante
 * quedó AUTORIZADO.
 */
test('los fragmentos se digieren con ds Y etsi, en ese orden', () => {
  const { signedInfoParaFirmar } = firmarComprobante(XML, p12Base64, password)

  assert.ok(signedInfoParaFirmar.includes('xmlns:ds='), 'falta el namespace ds')
  assert.ok(
    signedInfoParaFirmar.includes('xmlns:etsi='),
    'falta etsi: C14N inclusivo lo incluye aunque SignedInfo no lo use',
  )

  // C14N ordena las declaraciones por prefijo: ds antes que etsi.
  const posDs = signedInfoParaFirmar.indexOf('xmlns:ds=')
  const posEtsi = signedInfoParaFirmar.indexOf('xmlns:etsi=')
  assert.ok(posDs < posEtsi, 'ds tiene que ir antes que etsi')

  // Y los namespaces van antes que los demás atributos.
  assert.ok(posEtsi < signedInfoParaFirmar.indexOf('Id='))
})

test('el documento no repite los namespaces en cada fragmento', () => {
  // En el XML final ds y etsi se declaran UNA vez, en <ds:Signature>. Los
  // subárboles los heredan: repetirlos ahí cambiaría el documento respecto de
  // lo que se digirió.
  const { xmlFirmado } = firmarComprobante(XML, p12Base64, password)

  assert.equal((xmlFirmado.match(/xmlns:ds=/g) ?? []).length, 1)
  assert.equal((xmlFirmado.match(/xmlns:etsi=/g) ?? []).length, 1)
  assert.match(xmlFirmado, /<ds:Signature xmlns:ds="[^"]+" xmlns:etsi="[^"]+"/)
})

test('dos firmas del mismo comprobante producen el mismo SignedInfo', () => {
  // Los Id se derivan del contenido, no del azar: reintentar una firma no
  // genera un comprobante estructuralmente distinto.
  const fecha = new Date('2026-07-31T10:00:00')
  const a = firmarComprobante(XML, p12Base64, password, { fecha })
  const b = firmarComprobante(XML, p12Base64, password, { fecha })

  assert.equal(a.signatureId, b.signatureId)
  assert.equal(a.signedInfoParaFirmar, b.signedInfoParaFirmar)
})
