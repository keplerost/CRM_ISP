import forge from 'node-forge'
import { AppError } from '../lib/errors.js'

/**
 * Lectura del certificado de firma electrónica (.p12 / PKCS#12).
 *
 * De acá salen los cuatro datos que necesita la firma XAdES del SRI:
 *   - la clave privada, para firmar
 *   - el certificado en base64, que va dentro de <X509Certificate>
 *   - el emisor y el número de serie, que van en <IssuerSerial>
 *   - el módulo y el exponente RSA, que van en <RSAKeyValue>
 */

/**
 * Abre el .p12 y devuelve lo necesario para firmar.
 *
 * @param p12Base64  contenido del archivo en base64
 * @param password   clave del certificado
 */
export function leerCertificado(p12Base64, password) {
  if (!p12Base64) throw new AppError('No hay certificado cargado', { status: 400 })

  let p12
  try {
    const der = forge.util.decode64(String(p12Base64).replace(/\s/g, ''))
    const asn1 = forge.asn1.fromDer(der)
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, String(password ?? ''))
  } catch (err) {
    // node-forge no distingue "clave incorrecta" de "archivo corrupto", pero en
    // la práctica casi siempre es lo primero.
    throw new AppError('No se pudo abrir el certificado', {
      status: 400,
      hint: 'Revisá que la contraseña sea la correcta y que el archivo sea un .p12 válido.',
      detalle: String(err?.message ?? err),
    })
  }

  // La clave privada puede venir en cualquiera de los dos tipos de bolsa.
  const bolsasClave = {
    ...p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag }),
    ...p12.getBags({ bagType: forge.pki.oids.keyBag }),
  }
  const clavePrivada = Object.values(bolsasClave)
    .flat()
    .find((b) => b?.key)?.key

  if (!clavePrivada) {
    throw new AppError('El certificado no contiene una clave privada', {
      status: 400,
      hint: 'Puede ser un archivo con el certificado público solamente. Necesitás el .p12 completo.',
    })
  }

  const certificados = Object.values(p12.getBags({ bagType: forge.pki.oids.certBag }))
    .flat()
    .map((b) => b?.cert)
    .filter(Boolean)

  if (!certificados.length) {
    throw new AppError('El certificado no contiene ningún certificado X.509', { status: 400 })
  }

  // Con varios certificados (la cadena completa), el de firma es el que
  // corresponde a la clave privada. Se identifica comparando el módulo RSA.
  const cert =
    certificados.find((c) => c.publicKey?.n?.equals?.(clavePrivada.n)) ?? certificados[0]

  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()

  const ahora = new Date()
  const vencido = cert.validity.notAfter < ahora
  const aunNoVigente = cert.validity.notBefore > ahora

  if (vencido) {
    throw new AppError(
      `El certificado venció el ${cert.validity.notAfter.toLocaleDateString('es')}`,
      {
        status: 400,
        hint: 'El SRI rechaza comprobantes firmados con un certificado vencido. Hay que renovarlo.',
      },
    )
  }
  if (aunNoVigente) {
    throw new AppError('El certificado todavía no es válido', { status: 400 })
  }

  return {
    clavePrivada,
    certificado: cert,
    // Base64 del DER, que es lo que va dentro de <ds:X509Certificate>
    certificadoB64: forge.util.encode64(der),
    // SHA-1 del DER: el <CertDigest> de SignedProperties
    certificadoDigestSha1: forge.util.encode64(
      forge.md.sha1.create().update(der).digest().getBytes(),
    ),
    emisor: nombreX509(cert.issuer),
    serie: new forge.jsbn.BigInteger(cert.serialNumber, 16).toString(10),
    validoDesde: cert.validity.notBefore,
    validoHasta: cert.validity.notAfter,
    sujeto: nombreX509(cert.subject),
    // Módulo y exponente para <ds:RSAKeyValue>
    modulusB64: forge.util.encode64(enterosinSigno(cert.publicKey.n)),
    exponentB64: forge.util.encode64(enterosinSigno(cert.publicKey.e)),
  }
}

/**
 * Nombre distinguido en el orden que espera el SRI.
 *
 * X.509 guarda los atributos del más general al más específico, pero
 * <X509IssuerName> se escribe al revés (CN primero). Si el orden no coincide
 * con el que el SRI calcula, la validación falla.
 */
function nombreX509(nombre) {
  return nombre.attributes
    .map((a) => `${a.shortName ?? a.name}=${a.value}`)
    .reverse()
    .join(',')
}

/**
 * BigInteger a bytes sin el cero de signo.
 * node-forge antepone 0x00 cuando el bit más alto está en 1, para marcar que el
 * número es positivo. Ese byte no va en el base64 de XMLDSig.
 */
function enterosinSigno(bigint) {
  let hex = bigint.toString(16)
  if (hex.length % 2) hex = '0' + hex
  const bytes = forge.util.hexToBytes(hex)
  return bytes.charCodeAt(0) === 0 ? bytes.slice(1) : bytes
}

/** Resumen sin secretos, para mostrar en la interfaz. */
export function resumenCertificado(p12Base64, password) {
  const c = leerCertificado(p12Base64, password)
  const dias = Math.ceil((c.validoHasta - new Date()) / 86400000)

  return {
    sujeto: c.sujeto,
    emisor: c.emisor,
    serie: c.serie,
    validoDesde: c.validoDesde.toISOString().slice(0, 10),
    validoHasta: c.validoHasta.toISOString().slice(0, 10),
    diasParaVencer: dias,
    // Un certificado vence sin avisar y los comprobantes empiezan a rebotar.
    porVencer: dias <= 30,
  }
}
