#!/usr/bin/env node
/**
 * La herramienta del VENDEDOR: genera el par de claves y emite licencias.
 *
 * Esto NO va en la instalación del cliente. Vive en tu máquina, junto con la
 * clave privada — que es lo único que impide que cualquiera se emita licencias
 * eternas. Si la clave privada se filtra, se pierde el control de todas las
 * licencias emitidas y hay que rotar la pública en cada instalación.
 *
 *   Generar el par (una sola vez, el primer día):
 *     node scripts/licencia.mjs claves
 *
 *   Emitir una licencia para un cliente:
 *     node scripts/licencia.mjs emitir --instalacion <uuid> --clientes 500 --meses 1 --isp "Fibra del Valle"
 *
 * El identificador de instalación se lo pide el cliente a su propia pantalla de
 * Ajustes → Licencia, y te lo pasa. Vos le devolvés el código que sale de acá.
 */

import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const orden = args[0]

/** --clave valor → { clave: 'valor' } */
function opciones(lista) {
  const o = {}
  for (let i = 0; i < lista.length; i++) {
    if (!lista[i].startsWith('--')) continue
    o[lista[i].slice(2)] = lista[i + 1]?.startsWith('--') ? true : lista[++i]
  }
  return o
}

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

if (orden === 'claves') {
  // Ed25519: firmas cortas y verificación rápida, sin elegir parámetros. Para
  // firmar un permiso de doscientos bytes es exactamente lo que hace falta.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')

  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString()

  console.log('\n═══ CLAVE PRIVADA — guardala y no la compartas con nadie ═══')
  console.log('Guardala como licencia-privada.pem. Quien la tenga puede emitir')
  console.log('licencias eternas para cualquier instalación.\n')
  console.log(priv)

  console.log('═══ CLAVE PÚBLICA — esta va en el .env de CADA cliente ═══')
  console.log('Es pública de verdad: publicarla no habilita a nadie a firmar.\n')
  console.log('LICENCIA_CLAVE_PUBLICA="' + pub.trimEnd().replace(/\n/g, '\\n') + '"\n')
  process.exit(0)
}

if (orden === 'emitir') {
  const o = opciones(args.slice(1))
  const rutaClave = o.clave ?? 'licencia-privada.pem'

  if (!o.instalacion) {
    console.error('Falta --instalacion. Es el código que el cliente ve en Ajustes → Licencia.')
    process.exit(1)
  }

  let privada
  try {
    privada = createPrivateKey(readFileSync(rutaClave, 'utf8'))
  } catch (err) {
    console.error(`No se pudo leer la clave privada en ${rutaClave}: ${err.message}`)
    console.error('Generala primero con: node scripts/licencia.mjs claves')
    process.exit(1)
  }

  const meses = Number(o.meses ?? 1)
  const vence = new Date()
  vence.setMonth(vence.getMonth() + meses)

  const contenido = {
    instalacion: o.instalacion,
    isp: o.isp ?? null,
    clientes_max: o.clientes ? Number(o.clientes) : null,
    vence: vence.toISOString(),
    emitido: new Date().toISOString(),
  }

  const payload = b64url(JSON.stringify(contenido))
  const firma = b64url(sign(null, Buffer.from(payload), privada))

  console.log('\n═══ LICENCIA ═══')
  console.log(`ISP:          ${contenido.isp ?? '(sin nombre)'}`)
  console.log(`Instalación:  ${contenido.instalacion}`)
  console.log(`Abonados:     ${contenido.clientes_max ?? 'sin límite'}`)
  console.log(`Vence:        ${vence.toLocaleDateString('es-EC')}`)
  console.log('\nPasale este código al cliente para que lo pegue en Ajustes → Licencia:\n')
  console.log(`${payload}.${firma}\n`)
  process.exit(0)
}

console.log(`
Emisor de licencias.

  node scripts/licencia.mjs claves
      Genera el par de claves. Una sola vez, el primer día.

  node scripts/licencia.mjs emitir --instalacion <uuid> [opciones]
      --clientes 500        Hasta cuántos abonados cubre. Sin esto, sin límite.
      --meses 1             Cuántos meses vale. Por defecto 1.
      --isp "Nombre"        Para que el cliente vea su nombre en la pantalla.
      --clave ruta.pem      Dónde está la privada. Por defecto licencia-privada.pem
`)
