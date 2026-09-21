import { Router } from 'express'
import { encrypt } from '../lib/crypto.js'
import { asyncHandler, badRequest } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'

const router = Router()

/**
 * POST /api/crypto/encrypt  { password }  →  { encrypted }
 *
 * El frontend guarda las OLTs y routers directamente en Supabase, pero no puede
 * cifrar la contraseña (no tiene ni debe tener la clave). Pide el ciphertext acá y
 * guarda eso en password_encrypted.
 *
 * Es de una sola dirección a propósito: no existe el endpoint inverso. Descifrar
 * solo ocurre dentro del middleware, al momento de conectarse a un equipo.
 */
router.post(
  '/encrypt',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { password } = req.body ?? {}
    if (!password) throw badRequest('Falta el campo password')
    res.json({ encrypted: encrypt(String(password)) })
  }),
)

export default router
