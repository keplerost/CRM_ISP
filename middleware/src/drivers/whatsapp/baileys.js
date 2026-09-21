/**
 * WhatsApp por Baileys, adentro de este proceso.
 *
 * ── Por qué es un driver y no está implementado del todo ──
 *
 * Porque Baileys mantiene una sesión de WhatsApp Web viva: hay que guardar y
 * restaurar credenciales, manejar reconexiones, exponer el QR para vincular y
 * sobrevivir a los reinicios. Eso es un servicio, no una función — y ese
 * servicio ya existe hecho y probado: es Evolution API, que por dentro usa esta
 * misma librería.
 *
 * El driver queda declarado para que la vía se pueda elegir el día que se
 * decida embeberla, y para que la pantalla pueda explicar por qué hoy no está,
 * en vez de mostrar una opción que falla en silencio.
 *
 * Si se implementa, va acá:
 *   - `@whiskeysockets/baileys` como dependencia opcional
 *   - la sesión en disco (`useMultiFileAuthState`) o en la base
 *   - un endpoint que devuelva el QR mientras no esté vinculado
 */
const NO_IMPLEMENTADO =
  'Baileys embebido todavía no está implementado. Usá Evolution API, que es la misma librería ' +
  'corriendo como servicio aparte: gratis igual, y la sesión no se cae cuando se reinicia el middleware.'

export async function enviar() {
  return { ok: false, error: NO_IMPLEMENTADO }
}

export async function estado() {
  return { conectado: false, detalle: NO_IMPLEMENTADO }
}
