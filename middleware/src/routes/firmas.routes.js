import crypto from 'node:crypto'
import { Router } from 'express'

import { asyncHandler, notFound, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { db } from '../lib/db.js'
import { encrypt } from '../lib/crypto.js'
import {
  autorizarManual,
  configuracion,
  confirmarDesdeProveedor,
  registrarFirmaManual,
  solicitarFirma,
  tramitesDe,
  vencerPendientes,
} from '../services/firmaContrato.js'

/**
 * La firma del contrato.
 *
 * ── El aviso del proveedor va en otro router ──
 *
 * Todo lo de acá exige sesión, pero el proveedor no tiene una: cuando el abonado
 * firma, quien golpea la puerta es su servidor. Ese endpoint vive en
 * `webhookFirma` y se monta aparte, antes del guardia de sesión.
 */

const router = Router()
router.use(requireAuth)

/** Quién es el usuario del sistema que está pidiendo esto. */
async function usuarioDe(req) {
  const authId = req.usuario?.id ?? req.user?.id ?? null
  if (!authId) return null

  const { data } = await db()
    .from('usuarios_sistema')
    .select('id, nombre, rol')
    .eq('auth_id', authId)
    .maybeSingle()
  return data ?? null
}

/** El interruptor y los tiempos, para que la pantalla sepa qué ofrecer. */
router.get(
  '/config',
  asyncHandler(async (_req, res) => {
    const c = await configuracion()
    // La clave del proveedor no sale de acá ni cifrada: la pantalla solo
    // necesita saber si está cargada.
    const { api_key_encrypted, ...resto } = c
    res.json({ ...resto, tiene_clave: Boolean(api_key_encrypted) })
  }),
)

/**
 * Guarda la configuración.
 *
 * La clave del proveedor se cifra acá y nunca vuelve a salir: la pantalla solo
 * sabe si hay una cargada. Es la misma regla que la clave del certificado del
 * SRI y la del correo — una credencial que el navegador puede leer es una
 * credencial que cualquiera con la consola abierta puede llevarse.
 */
router.put(
  '/config',
  asyncHandler(async (req, res) => {
    const fila = { actualizado_en: new Date().toISOString() }
    const b = req.body ?? {}

    if ('api_habilitada' in b) fila.api_habilitada = Boolean(b.api_habilitada)
    if ('proveedor' in b) fila.proveedor = String(b.proveedor ?? '').trim() || null
    if ('api_url' in b) fila.api_url = String(b.api_url ?? '').trim() || null

    if ('timeout_segundos' in b) {
      const n = Number(b.timeout_segundos)
      if (!Number.isFinite(n) || n < 5 || n > 300) {
        throw new AppError('El tiempo de espera va entre 5 y 300 segundos', { status: 400 })
      }
      fila.timeout_segundos = Math.round(n)
    }

    if ('vigencia_horas' in b) {
      const n = Number(b.vigencia_horas)
      if (!Number.isFinite(n) || n < 1 || n > 720) {
        throw new AppError('La vigencia del enlace va entre 1 y 720 horas', { status: 400 })
      }
      fila.vigencia_horas = Math.round(n)
    }

    if ('roles_autorizan' in b) {
      const roles = Array.isArray(b.roles_autorizan) ? b.roles_autorizan : []
      /**
       * Sin nadie que pueda autorizar, el papel deja de existir.
       *
       * Y el papel es la salida cuando el proveedor no contesta: una lista vacía
       * dejaría al sistema sin ningún camino para firmar el día que la API falle.
       */
      if (!roles.length) {
        throw new AppError(
          'Tiene que haber al menos un rol que pueda habilitar la firma en papel: es la salida cuando el proveedor no responde.',
          { status: 400 },
        )
      }
      fila.roles_autorizan = roles
    }

    /**
     * La clave vacía NO borra la que hay.
     *
     * La pantalla no puede mostrar la clave guardada, así que su campo aparece
     * vacío siempre. Si el vacío borrara, cambiar el tiempo de espera dejaría al
     * sistema sin credencial sin que nadie lo pida.
     */
    if (b.api_key) fila.api_key_encrypted = encrypt(String(b.api_key))
    if (b.borrar_api_key === true) fila.api_key_encrypted = null

    // Encender la API sin URL deja al sistema llamando a la nada y esperando el
    // timeout completo en cada venta.
    const { data: actual } = await db().from('config_firma').select('*').eq('id', 1).maybeSingle()
    const quedaUrl = 'api_url' in fila ? fila.api_url : actual?.api_url
    const quedaEncendida = 'api_habilitada' in fila ? fila.api_habilitada : actual?.api_habilitada

    if (quedaEncendida && !quedaUrl) {
      throw new AppError(
        'Para encender la firma electrónica hace falta la URL del proveedor. Sin ella, cada venta esperaría el tiempo completo antes de ofrecer el papel.',
        { status: 400 },
      )
    }

    const { data, error } = await db()
      .from('config_firma')
      .update(fila)
      .eq('id', 1)
      .select('*')
      .single()

    if (error) throw new AppError(`No se pudo guardar: ${error.message}`, { status: 502 })

    const { api_key_encrypted, ...resto } = data
    res.json({ ...resto, tiene_clave: Boolean(api_key_encrypted) })
  }),
)

/**
 * Prueba la conexión con el proveedor, sin crear ningún trámite.
 *
 * ── Por qué existe ──
 *
 * Porque el momento de descubrir que la URL está mal escrita no puede ser la
 * primera venta. Acá el error se ve con la pantalla de ajustes abierta, no con
 * un cliente esperando.
 */
router.post(
  '/probar',
  asyncHandler(async (req, res) => {
    const c = await configuracion()
    const url = String(req.body?.api_url ?? c.api_url ?? '').trim()

    if (!url) throw new AppError('Falta la URL del proveedor', { status: 400 })

    const empezo = Date.now()
    try {
      const respuesta = await fetch(url, {
        method: 'OPTIONS',
        signal: AbortSignal.timeout((c.timeout_segundos || 30) * 1000),
      })
      res.json({
        ok: true,
        estado: respuesta.status,
        ms: Date.now() - empezo,
        // Contesta algo: eso es lo que se quería saber. Que el 405 sea un
        // "método no permitido" no importa — significa que el servidor está.
        mensaje: `El proveedor respondió en ${Date.now() - empezo} ms.`,
      })
    } catch (e) {
      const esTiempo = e.name === 'TimeoutError' || e.name === 'AbortError'
      res.json({
        ok: false,
        ms: Date.now() - empezo,
        mensaje: esTiempo
          ? `No respondió en ${c.timeout_segundos} segundos. Con esta configuración, cada venta esperaría eso antes de ofrecer el papel.`
          : `No se pudo contactar: ${e.message}`,
      })
    }
  }),
)

/** Los trámites de una venta o de un abonado. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(
      await tramitesDe({
        instalacionId: req.query.instalacion || null,
        clienteId: req.query.cliente || null,
      }),
    )
  }),
)

/**
 * Manda el contrato a firmar.
 *
 * ── Por qué devuelve 200 aunque la API del proveedor haya fallado ──
 *
 * Porque el fallo del proveedor no es un fallo de esta operación: el trámite se
 * creó, quedó registrado por qué no salió, y la pantalla tiene que poder
 * ofrecer el papel. Un 502 haría que el navegador muestre un error y pierda el
 * trámite que sí existe.
 */
router.post(
  '/solicitar',
  asyncHandler(async (req, res) => {
    const usuario = await usuarioDe(req)

    let tramite
    try {
      tramite = await solicitarFirma({
        instalacionId: req.body?.instalacion_id ?? null,
        clienteId: req.body?.cliente_id ?? null,
        contratoId: req.body?.contrato_id ?? null,
        usuarioId: usuario?.id ?? null,
      })
    } catch (e) {
      throw new AppError(e.message, { status: 502 })
    }

    if (!tramite) throw notFound('No existe esa venta ni ese abonado')

    res.json({
      tramite,
      // Lo que la pantalla necesita decidir, ya masticado.
      ok: tramite.estado === 'enviado',
      hay_que_firmar_en_papel: tramite.estado === 'fallido' || tramite.metodo === 'manual',
      motivo: tramite.error_api ?? null,
    })
  }),
)

/** Habilita la firma en papel para este contrato. */
router.post(
  '/:id/autorizar-manual',
  asyncHandler(async (req, res) => {
    const usuario = await usuarioDe(req)
    if (!usuario) {
      throw new AppError(
        'Tu usuario no tiene legajo en el sistema, así que no se puede registrar quién autorizó la firma en papel.',
        { status: 403 },
      )
    }

    try {
      res.json(
        await autorizarManual({
          firmaId: req.params.id,
          usuarioId: usuario.id,
          motivo: req.body?.motivo ?? null,
        }),
      )
    } catch (e) {
      // La base rechaza al que no puede autorizar; su mensaje ya explica por qué.
      throw new AppError(e.message, { status: /no puede habilitar/.test(e.message) ? 403 : 502 })
    }
  }),
)

/** Registra el papel firmado que llegó a oficina. */
router.post(
  '/:id/registrar-manual',
  asyncHandler(async (req, res) => {
    const usuario = await usuarioDe(req)

    try {
      res.json(
        await registrarFirmaManual({
          firmaId: req.params.id,
          documentoUrl: req.body?.documento_url,
          validadoPor: usuario?.id ?? null,
          firmadoEn: req.body?.firmado_en ?? null,
        }),
      )
    } catch (e) {
      throw new AppError(e.message, { status: 400 })
    }
  }),
)

/** Vence los trámites cuyo enlace ya no vale. La tarea la llama sola. */
router.post(
  '/vencer',
  asyncHandler(async (_req, res) => {
    res.json(await vencerPendientes())
  }),
)

export default router

/**
 * El aviso del proveedor cuando el abonado firmó.
 *
 * ── Por qué está separado y sin sesión ──
 *
 * Porque quien llama es el servidor del proveedor, que no tiene usuario ni token
 * de Supabase. Exigirle sesión haría que la confirmación no llegue nunca y todos
 * los contratos queden esperando.
 *
 * ── Qué lo protege entonces ──
 *
 * Dos cosas. La REFERENCIA del proveedor, que solo conoce quien creó el trámite:
 * no se acepta un id nuestro, porque eso permitiría marcar como firmado
 * cualquier contrato adivinando un UUID. Y un SECRETO compartido en la cabecera,
 * cuando está configurado.
 *
 * El secreto se compara con `timingSafeEqual` y no con `===`: comparar cadenas
 * corta en el primer carácter distinto, y midiendo cuánto tarda se puede
 * adivinar el secreto de a un carácter por vez.
 */
export const webhookFirma = Router()

webhookFirma.post(
  '/firma',
  asyncHandler(async (req, res) => {
    const esperado = process.env.FIRMA_WEBHOOK_SECRETO
    if (esperado) {
      const recibido = String(req.get('X-Firma-Secreto') ?? '')
      const a = Buffer.from(recibido)
      const b = Buffer.from(esperado)
      const iguales = a.length === b.length && crypto.timingSafeEqual(a, b)
      if (!iguales) throw new AppError('Secreto inválido', { status: 401 })
    }

    /**
     * Un aviso mal formado se contesta 400, no 500.
     *
     * Es el mismo razonamiento que el 404 de más abajo, del otro lado: un 500 le
     * dice al proveedor "fallé, probá de nuevo" y lo hace reintentar durante días
     * un aviso que nunca va a poder procesarse. El 400 dice "esto está mal
     * armado" y corta ahí.
     *
     * Lo encontró un POST vacío contra el endpoint: devolvía 500.
     */
    const referencia = req.body?.referencia ?? req.body?.id ?? req.body?.transaction_id
    const estado = req.body?.estado ?? req.body?.status

    if (!referencia) {
      throw new AppError('El aviso no dice de qué trámite es', { status: 400 })
    }
    if (!estado) {
      throw new AppError('El aviso no dice qué pasó con la firma', { status: 400 })
    }

    let tramite
    try {
      tramite = await confirmarDesdeProveedor({
        referencia,
        estado,
        documentoUrl: req.body?.documento_url ?? req.body?.signed_document_url ?? null,
        firmadoEn: req.body?.firmado_en ?? req.body?.signed_at ?? null,
      })
    } catch (e) {
      // Un estado que no se entiende tampoco se reintenta: no va a cambiar.
      if (/estado que no se entiende/.test(e.message)) {
        throw new AppError(e.message, { status: 400 })
      }
      throw e
    }

    /**
     * Si no se conoce el trámite se contesta 200 igual.
     *
     * Un 404 hace que el proveedor reintente el mismo aviso durante días por
     * algo que nunca va a existir de nuestro lado — un trámite borrado, o de otra
     * instalación del sistema.
     */
    res.json({ recibido: true, conocido: Boolean(tramite) })
  }),
)
