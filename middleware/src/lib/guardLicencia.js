import { estado } from '../services/licencia.js'

/**
 * Deja pasar solo si la licencia habilita.
 *
 * ── Qué pasa cuando la verificación misma falla ──
 *
 * Hay dos fallas distintas y NO se tratan igual:
 *
 *   La licencia dice que no  → se bloquea. Venció, no está cargada, la firma no
 *                              es del vendedor. Es la respuesta correcta.
 *
 *   No se pudo averiguar     → se DEJA PASAR, y se grita en el log. La base no
 *                              contesta, la tabla todavía no existe porque no
 *                              corrieron la migración, un bug nuestro.
 *
 * La segunda es la que importa. Bloquear ante un problema propio significa que
 * un hipo de Supabase, o una migración que el cliente no corrió, deja a un ISP
 * sin poder facturar ni reconectar a nadie — y el teléfono que suena es el del
 * vendedor. El pirata decidido edita este archivo de todos modos; el cliente
 * que paga, no. Entre proteger la licencia de alguien que ya tiene el servidor
 * y no voltear a un cliente al día, se elige lo segundo.
 *
 * Se cachea un minuto: sin eso, cada request iría a la base a preguntar lo
 * mismo, y la licencia cambia una vez por mes.
 */

const CACHE_MS = 60_000
let cache = { hasta: 0, valor: null }

/** Se llama al activar una licencia: esperar el minuto sería desconcertante. */
export function olvidarCache() {
  cache = { hasta: 0, valor: null }
}

async function estadoCacheado() {
  if (cache.valor && Date.now() < cache.hasta) return cache.valor
  const valor = await estado()
  cache = { valor, hasta: Date.now() + CACHE_MS }
  return valor
}

export async function guardLicencia(req, res, next) {
  let lic
  try {
    lic = await estadoCacheado()
  } catch (err) {
    console.error('[licencia] no se pudo verificar, se deja pasar:', err.message)
    return next()
  }

  if (lic.habilitada) return next()

  // 402 Payment Required. Es el código que existe justo para esto, y le permite
  // al frontend distinguir "vencida" de "no tenés permiso" sin leer el texto.
  res.status(402).json({
    error: lic.motivo ?? 'La licencia de este sistema no está vigente.',
    licencia_vencida: true,
    hint: 'Contactá a tu proveedor para renovarla. El sistema vuelve solo apenas se acredite.',
    instalacion: lic.instalacion,
  })
}
