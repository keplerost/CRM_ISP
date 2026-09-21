import crypto from 'node:crypto'
import { config } from '../config.js'
import { AppError } from './errors.js'

const ALGO = 'aes-256-gcm'
const PREFIJO = 'v1'
// Salt fijo: la passphrase es el secreto real y necesitamos que la misma frase
// derive siempre la misma clave para poder descifrar lo ya guardado.
const SALT = Buffer.from('taller-smartolt-v1')

let claveCache = null

function getClave() {
  if (!config.credentialsKey) {
    throw new AppError('CREDENTIALS_KEY no está configurada en el .env del middleware', {
      status: 500,
      hint: 'Copiá middleware/.env.example a middleware/.env y definí CREDENTIALS_KEY.',
    })
  }
  if (!claveCache) {
    claveCache = crypto.scryptSync(config.credentialsKey, SALT, 32)
  }
  return claveCache
}

/** Devuelve "v1:<iv>:<tag>:<ciphertext>" en base64. */
export function encrypt(textoPlano) {
  if (typeof textoPlano !== 'string' || textoPlano.length === 0) {
    throw new AppError('No hay nada para cifrar', { status: 400 })
  }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, getClave(), iv)
  const ct = Buffer.concat([cipher.update(textoPlano, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [PREFIJO, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
}

export function decrypt(payload) {
  if (typeof payload !== 'string') {
    throw new AppError('Credencial vacía o inválida', { status: 500 })
  }
  const partes = payload.split(':')
  if (partes.length !== 4 || partes[0] !== PREFIJO) {
    throw new AppError('La credencial guardada no tiene el formato esperado', {
      status: 500,
      hint: 'Volvé a guardar el equipo desde la UI para regenerar la credencial cifrada.',
    })
  }
  const [, ivB64, tagB64, ctB64] = partes
  try {
    const decipher = crypto.createDecipheriv(ALGO, getClave(), Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new AppError('No se pudo descifrar la credencial del equipo', {
      status: 500,
      hint: 'Lo más probable es que CREDENTIALS_KEY haya cambiado desde que se guardó. Volvé a cargar la contraseña del equipo.',
    })
  }
}
