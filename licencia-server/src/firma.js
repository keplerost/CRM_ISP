import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * La firma de las licencias.
 *
 * Acá vive lo único que no puede filtrarse: la clave privada. Quien la tenga
 * emite licencias eternas para cualquier instalación, y recuperarse de eso
 * significa rotar la clave pública en cada cliente, uno por uno.
 *
 * Por eso se lee de un archivo fuera del código y el servidor se niega a
 * arrancar sin ella. Un servidor de licencias que arranca sin poder firmar
 * parece funcionar hasta que un cliente intenta renovar.
 */

const RUTA = process.env.LICENCIA_CLAVE_PRIVADA || './datos/licencia-privada.pem'

let privada = null

export function cargarClave() {
  if (privada) return privada
  try {
    privada = createPrivateKey(readFileSync(RUTA, 'utf8'))
  } catch (err) {
    throw new Error(
      `No se pudo leer la clave privada en ${RUTA}: ${err.message}\n` +
        'Generala con: node ../middleware/scripts/licencia.mjs claves',
    )
  }
  return privada
}

const b64url = (b) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * Emite el permiso firmado.
 *
 * `vence` se pasa como fecha del día (YYYY-MM-DD) y se lleva al final de ese
 * día: el cliente que pagó hasta el 15 tiene el 15 completo, no hasta la
 * medianoche del 14.
 */
export function emitir({ instalacion, isp, clientes_max, vence }) {
  const contenido = {
    instalacion,
    isp: isp ?? null,
    clientes_max: clientes_max ?? null,
    vence: `${vence}T23:59:59.999Z`,
    emitido: new Date().toISOString(),
  }

  const payload = b64url(JSON.stringify(contenido))
  return `${payload}.${b64url(sign(null, Buffer.from(payload), cargarClave()))}`
}
