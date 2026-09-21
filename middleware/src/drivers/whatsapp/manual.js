/**
 * Sin proveedor: se arma el enlace y lo manda una persona.
 *
 * Devuelve `ok: false` a propósito, con el enlace adentro. No es un fracaso del
 * envío —el enlace sirve— pero SÍ es la verdad para quien pregunta: nadie mandó
 * nada todavía. Un `ok: true` acá haría que el historial de alertas dijera
 * "enviado" sobre mensajes que nunca salieron.
 */
export async function enviar({ numero, texto }) {
  return {
    ok: false,
    error: 'La vía "manual" no envía sola: hay que abrir el enlace y mandarlo a mano.',
    enlace: `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`,
  }
}

export async function estado() {
  return { conectado: false, detalle: 'Manual: no hay conexión que mantener' }
}
