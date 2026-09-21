import forge from 'node-forge'
import { AppError } from '../lib/errors.js'
import { leerCertificado } from './certificado.js'

/**
 * Firma XAdES-BES con el perfil que exige el SRI de Ecuador.
 *
 * El SRI valida contra su propio verificador y rechaza con mensajes poco
 * informativos ("ERROR EN LA ESTRUCTURA", "FIRMA INVALIDA"), así que conviene
 * conocer las tres decisiones que importan:
 *
 * 1. SHA-1, no SHA-256. El perfil del SRI sigue exigiéndolo para los digests y
 *    para la firma (rsa-sha1). Usar SHA-256 hace que rechace el comprobante.
 *
 * 2. Namespaces al digerir. El algoritmo declarado es C14N 1.0 INCLUSIVO: al
 *    canonicalizar un subárbol, su elemento raíz recibe TODOS los namespaces en
 *    contexto —estén o no usados dentro— y ordenados por prefijo. Como en el
 *    documento ds y etsi se declaran en <ds:Signature>, los subárboles que
 *    cuelgan de ahí se digieren con AMBOS, ds antes que etsi.
 *
 *    Omitir etsi al firmar SignedInfo hace que el SRI calcule otro digest y
 *    responda "FIRMA INVALIDA", sin decir dónde está la diferencia. Por eso
 *    cada fragmento se arma dos veces: una con los namespaces para digerir,
 *    otra sin ellos para insertar en el documento.
 *
 * 3. La referencia al comprobante usa la transformación "enveloped-signature":
 *    su digest se calcula sobre el XML SIN la firma, es decir el documento
 *    original sin la declaración <?xml ... ?>.
 */

const NS_DS = 'http://www.w3.org/2000/09/xmldsig#'
const NS_ETSI = 'http://uri.etsi.org/01903/v1.3.2#'
const ALG_C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
const ALG_SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1'
const ALG_RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1'
const ALG_ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'

/**
 * Declaraciones de namespace tal como las emite C14N inclusivo en el elemento
 * raíz de un subárbol: todas las que están en contexto, ordenadas por prefijo.
 * Dentro de <ds:Signature> el contexto es siempre ds + etsi.
 */
const NS_EN_CONTEXTO = `xmlns:ds="${NS_DS}" xmlns:etsi="${NS_ETSI}"`

const sha1B64 = (texto) =>
  forge.util.encode64(forge.md.sha1.create().update(texto, 'utf8').digest().getBytes())

const escapar = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

/**
 * Fecha en ISO con el desplazamiento horario, como espera <SigningTime>.
 * Ecuador es UTC-5; se calcula del reloj del servidor en vez de fijarlo, para
 * que también sirva si el middleware corre en un VPS en otra zona.
 */
function isoConZona(fecha = new Date()) {
  const off = -fecha.getTimezoneOffset()
  const signo = off >= 0 ? '+' : '-'
  const dosDig = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0')

  return (
    fecha.getFullYear() +
    '-' + dosDig(fecha.getMonth() + 1) +
    '-' + dosDig(fecha.getDate()) +
    'T' + dosDig(fecha.getHours()) +
    ':' + dosDig(fecha.getMinutes()) +
    ':' + dosDig(fecha.getSeconds()) +
    signo + dosDig(off / 60) + ':' + dosDig(off % 60)
  )
}

/** Números pseudo-únicos para los Id. No son secretos, solo tienen que no repetirse. */
const nid = (semilla) => String(100000 + (semilla % 899999))

/**
 * Firma un XML de comprobante.
 *
 * @param xml         XML sin firmar (tiene que traer id="comprobante")
 * @param p12Base64   certificado en base64
 * @param password    clave del certificado
 * @param fecha       momento de la firma (para poder fijarlo en los tests)
 */
export function firmarComprobante(xml, p12Base64, password, { fecha = new Date() } = {}) {
  if (!xml || typeof xml !== 'string') {
    throw new AppError('No hay XML para firmar', { status: 400 })
  }
  if (!xml.includes('id="comprobante"')) {
    throw new AppError('El XML no tiene el atributo id="comprobante"', {
      status: 400,
      hint: 'La firma del SRI referencia ese id. Sin él no hay a qué apuntar.',
    })
  }

  const cert = leerCertificado(p12Base64, password)

  // La firma se envuelve dentro del documento, así que el digest del
  // comprobante se calcula sobre el XML sin la declaración inicial.
  const sinDeclaracion = xml.replace(/^<\?xml[^?]*\?>\s*/, '')
  const digestComprobante = sha1B64(sinDeclaracion)

  const base = Math.abs(hashTexto(cert.certificadoB64 + digestComprobante))
  const idSig = nid(base)
  const idSignedProps = nid(base + 7)
  const idCert = nid(base + 13)
  const idRef = nid(base + 29)
  const idSignedInfo = nid(base + 37)
  const idObject = nid(base + 41)
  const idSigValue = nid(base + 53)

  const signatureId = `Signature${idSig}`
  const signedPropsId = `Signature${idSig}-SignedProperties${idSignedProps}`
  const certificateId = `Certificate${idCert}`
  const referenceId = `Reference-ID-${idRef}`

  // --- SignedProperties ----------------------------------------------------
  const cuerpoSignedProps =
    `<etsi:SignedSignatureProperties>` +
    `<etsi:SigningTime>${isoConZona(fecha)}</etsi:SigningTime>` +
    `<etsi:SigningCertificate>` +
    `<etsi:Cert>` +
    `<etsi:CertDigest>` +
    `<ds:DigestMethod Algorithm="${ALG_SHA1}"></ds:DigestMethod>` +
    `<ds:DigestValue>${cert.certificadoDigestSha1}</ds:DigestValue>` +
    `</etsi:CertDigest>` +
    `<etsi:IssuerSerial>` +
    `<ds:X509IssuerName>${escapar(cert.emisor)}</ds:X509IssuerName>` +
    `<ds:X509SerialNumber>${cert.serie}</ds:X509SerialNumber>` +
    `</etsi:IssuerSerial>` +
    `</etsi:Cert>` +
    `</etsi:SigningCertificate>` +
    `</etsi:SignedSignatureProperties>` +
    `<etsi:SignedDataObjectProperties>` +
    `<etsi:DataObjectFormat ObjectReference="#${referenceId}">` +
    `<etsi:Description>contenido comprobante</etsi:Description>` +
    `<etsi:MimeType>text/xml</etsi:MimeType>` +
    `</etsi:DataObjectFormat>` +
    `</etsi:SignedDataObjectProperties>`

  // Con namespaces: es lo que "ve" la canonicalización al digerir el subárbol.
  const signedPropsParaDigest =
    `<etsi:SignedProperties ${NS_EN_CONTEXTO} Id="${signedPropsId}">` +
    cuerpoSignedProps +
    `</etsi:SignedProperties>`

  // Sin namespaces: los hereda de <ds:Signature> dentro del documento.
  const signedPropsEnDocumento =
    `<etsi:SignedProperties Id="${signedPropsId}">` +
    cuerpoSignedProps +
    `</etsi:SignedProperties>`

  const digestSignedProps = sha1B64(signedPropsParaDigest)

  // --- KeyInfo -------------------------------------------------------------
  const cuerpoKeyInfo =
    `<ds:X509Data>` +
    `<ds:X509Certificate>${cert.certificadoB64}</ds:X509Certificate>` +
    `</ds:X509Data>` +
    `<ds:KeyValue>` +
    `<ds:RSAKeyValue>` +
    `<ds:Modulus>${cert.modulusB64}</ds:Modulus>` +
    `<ds:Exponent>${cert.exponentB64}</ds:Exponent>` +
    `</ds:RSAKeyValue>` +
    `</ds:KeyValue>`

  const keyInfoParaDigest =
    `<ds:KeyInfo ${NS_EN_CONTEXTO} Id="${certificateId}">${cuerpoKeyInfo}</ds:KeyInfo>`
  const keyInfoEnDocumento = `<ds:KeyInfo Id="${certificateId}">${cuerpoKeyInfo}</ds:KeyInfo>`

  const digestKeyInfo = sha1B64(keyInfoParaDigest)

  // --- SignedInfo ----------------------------------------------------------
  const cuerpoSignedInfo =
    `<ds:CanonicalizationMethod Algorithm="${ALG_C14N}"></ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="${ALG_RSA_SHA1}"></ds:SignatureMethod>` +
    `<ds:Reference Id="SignedPropertiesID${idSignedProps}" Type="http://uri.etsi.org/01903#SignedProperties" URI="#${signedPropsId}">` +
    `<ds:DigestMethod Algorithm="${ALG_SHA1}"></ds:DigestMethod>` +
    `<ds:DigestValue>${digestSignedProps}</ds:DigestValue>` +
    `</ds:Reference>` +
    `<ds:Reference URI="#${certificateId}">` +
    `<ds:DigestMethod Algorithm="${ALG_SHA1}"></ds:DigestMethod>` +
    `<ds:DigestValue>${digestKeyInfo}</ds:DigestValue>` +
    `</ds:Reference>` +
    `<ds:Reference Id="${referenceId}" URI="#comprobante">` +
    `<ds:Transforms>` +
    `<ds:Transform Algorithm="${ALG_ENVELOPED}"></ds:Transform>` +
    `</ds:Transforms>` +
    `<ds:DigestMethod Algorithm="${ALG_SHA1}"></ds:DigestMethod>` +
    `<ds:DigestValue>${digestComprobante}</ds:DigestValue>` +
    `</ds:Reference>`

  const signedInfoParaFirmar =
    `<ds:SignedInfo ${NS_EN_CONTEXTO} Id="Signature-SignedInfo${idSignedInfo}">` +
    cuerpoSignedInfo +
    `</ds:SignedInfo>`

  const signedInfoEnDocumento =
    `<ds:SignedInfo Id="Signature-SignedInfo${idSignedInfo}">` +
    cuerpoSignedInfo +
    `</ds:SignedInfo>`

  // --- Firma ---------------------------------------------------------------
  const md = forge.md.sha1.create()
  md.update(signedInfoParaFirmar, 'utf8')
  const signatureValue = forge.util.encode64(cert.clavePrivada.sign(md))

  const firma =
    `<ds:Signature xmlns:ds="${NS_DS}" xmlns:etsi="${NS_ETSI}" Id="${signatureId}">` +
    signedInfoEnDocumento +
    `<ds:SignatureValue Id="SignatureValue${idSigValue}">${signatureValue}</ds:SignatureValue>` +
    keyInfoEnDocumento +
    `<ds:Object Id="${signatureId}-Object${idObject}">` +
    `<etsi:QualifyingProperties Target="#${signatureId}">` +
    signedPropsEnDocumento +
    `</etsi:QualifyingProperties>` +
    `</ds:Object>` +
    `</ds:Signature>`

  // La firma va como último hijo del elemento raíz.
  const cierre = xml.lastIndexOf('</')
  if (cierre === -1) throw new AppError('El XML no tiene un elemento raíz cerrado', { status: 400 })

  return {
    xmlFirmado: xml.slice(0, cierre) + firma + xml.slice(cierre),
    signatureId,
    // Se devuelven para poder verificar la firma sin volver a calcularla.
    digests: {
      comprobante: digestComprobante,
      signedProperties: digestSignedProps,
      keyInfo: digestKeyInfo,
    },
    signedInfoParaFirmar,
    signatureValue,
    certificado: {
      sujeto: cert.sujeto,
      emisor: cert.emisor,
      serie: cert.serie,
      validoHasta: cert.validoHasta,
    },
  }
}

/**
 * Verifica una firma generada por esta misma implementación.
 *
 * No reemplaza al validador del SRI —no hace canonicalización real ni valida la
 * cadena de confianza— pero detecta lo más común: un digest mal calculado o una
 * firma que no corresponde al certificado incluido.
 */
export function verificarFirma(xmlFirmado) {
  const problemas = []

  const sacar = (etiqueta) => {
    const m = xmlFirmado.match(new RegExp(`<ds:${etiqueta}[^>]*>([\\s\\S]*?)</ds:${etiqueta}>`))
    return m?.[1] ?? null
  }

  const signatureValue = sacar('SignatureValue')
  const certB64 = sacar('X509Certificate')
  if (!signatureValue) problemas.push('falta SignatureValue')
  if (!certB64) problemas.push('falta X509Certificate')

  // El digest del comprobante tiene que corresponder al XML sin la firma.
  const sinFirma = xmlFirmado.replace(/<ds:Signature[\s\S]*?<\/ds:Signature>/, '')
  const sinDeclaracion = sinFirma.replace(/^<\?xml[^?]*\?>\s*/, '')
  const digestEsperado = sha1B64(sinDeclaracion)

  const mRef = xmlFirmado.match(
    /<ds:Reference Id="Reference-ID-[^"]*" URI="#comprobante">[\s\S]*?<ds:DigestValue>([^<]+)<\/ds:DigestValue>/,
  )
  if (!mRef) problemas.push('no se encontró la referencia al comprobante')
  else if (mRef[1] !== digestEsperado) {
    problemas.push('el digest del comprobante no coincide con el contenido')
  }

  // La firma tiene que validar contra el certificado que viaja en el XML.
  const mSignedInfo = xmlFirmado.match(/<ds:SignedInfo[^>]*>[\s\S]*?<\/ds:SignedInfo>/)
  if (mSignedInfo && signatureValue && certB64) {
    let cert
    let digest
    try {
      // Mismo criterio que al firmar: C14N inclusivo pone ds y etsi.
      const signedInfoConNs = mSignedInfo[0].replace(
        /^<ds:SignedInfo/,
        `<ds:SignedInfo ${NS_EN_CONTEXTO}`,
      )
      const der = forge.util.decode64(certB64.replace(/\s/g, ''))
      cert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(der))

      const md = forge.md.sha1.create()
      md.update(signedInfoConNs, 'utf8')
      digest = md.digest().bytes()
    } catch (err) {
      // Acá sí es un problema de lectura: el certificado o el XML están rotos.
      problemas.push(`no se pudo leer el certificado del XML: ${err?.message ?? err}`)
    }

    if (cert && digest) {
      // Una firma que no corresponde no siempre devuelve false: con el relleno
      // RSA inconsistente, node-forge lanza. Los dos casos significan lo mismo
      // —la firma no valida— y así hay que reportarlos.
      let valida = false
      try {
        valida = cert.publicKey.verify(digest, forge.util.decode64(signatureValue))
      } catch {
        valida = false
      }
      if (!valida) problemas.push('la firma no valida contra el certificado incluido')
    }
  }

  return { valida: problemas.length === 0, problemas }
}

/** Hash simple y estable, solo para derivar los Id. */
function hashTexto(texto) {
  let h = 0
  for (let i = 0; i < texto.length; i++) {
    h = (h << 5) - h + texto.charCodeAt(i)
    h |= 0
  }
  return h
}
