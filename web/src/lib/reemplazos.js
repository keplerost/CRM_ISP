import { supabase } from './supabaseClient'
import { api } from './apiNetwork'

/**
 * Cambio de equipo en el domicilio.
 *
 * ── Por qué son dos llamadas y no una ──
 *
 * Son dos cosas distintas y fallan distinto.
 *
 * La primera —la función de la base— mueve el inventario: descuenta la ONT
 * nueva del almacén del técnico, la ata al abonado, saca la vieja y deja el
 * reemplazo registrado. Es una transacción: o pasa todo o no pasa nada.
 *
 * La segunda toca la OLT, y para eso hace falta el middleware: las credenciales
 * del equipo viven ahí y el navegador del técnico no las ve nunca.
 *
 * Que la segunda falle NO deshace la primera, a propósito. El equipo ya está
 * físicamente en la casa del cliente; borrar el registro sería mentirle al
 * inventario para que la pantalla quede prolija. Lo que queda es un reemplazo
 * `pendiente_olt`, que la oficina ve en su cola y puede cerrar desde la pantalla
 * de la OLT.
 */

export const MOTIVOS = {
  quemado: 'Quemada (rayo / subida de tensión)',
  no_enciende: 'No enciende',
  sin_senal: 'No engancha con la OLT',
  wifi_falla: 'El WiFi falla',
  golpeado: 'Golpeada o rota',
  obsoleto: 'Se cambia por una mejor',
  robo_perdida: 'Robo o pérdida',
  otro: 'Otro',
}

export const DESTINOS = {
  averiado: { label: 'Vuelve averiada', ayuda: 'La traigo para revisión o garantía.' },
  bodega: { label: 'Anda: vuelve a mi almacén', ayuda: 'Queda disponible para instalar de nuevo.' },
  baja: { label: 'Para dar de baja', ayuda: 'No se recupera.' },
  cliente: { label: 'Se la dejé al cliente', ayuda: 'El abonado se queda con el equipo viejo.' },
}

export const reemplazosApi = {
  /**
   * Paso 1: el inventario. Devuelve el id del reemplazo.
   *
   * Los errores de la función salen tal cual: son mensajes escritos para que el
   * técnico los entienda parado en la vereda ("ese equipo no está en tu
   * almacén"), no códigos.
   */
  async registrar({ clienteId, serieNueva, motivo, destino, detalle, ticketId, instalacionId }) {
    const { data, error } = await supabase.rpc('reemplazar_equipo_cliente', {
      p_cliente: clienteId,
      p_serie_nueva: serieNueva,
      p_motivo: motivo,
      p_destino: destino ?? 'averiado',
      p_detalle: detalle || null,
      p_ticket: ticketId ?? null,
      p_instalacion: instalacionId ?? null,
    })
    if (error) throw error
    return data
  },

  /** Paso 2: la OLT. Solo va el id — puerto, perfil y VLAN los copia el servidor. */
  aprovisionar: (reemplazoId) => api.reemplazos.aprovisionar(reemplazoId),

  /** Lo que quedó a medias. Mientras esté acá, el abonado no tiene servicio. */
  async pendientes() {
    const { data, error } = await supabase
      .from('v_reemplazos_pendientes')
      .select('*')
      .order('creado_en')
    if (error) throw error
    return data ?? []
  },

  /** El historial de un abonado: qué equipo tuvo antes y por qué se cambió. */
  async delCliente(clienteId) {
    const { data, error } = await supabase
      .from('reemplazos_equipo')
      .select('*')
      .eq('cliente_id', clienteId)
      .order('creado_en', { ascending: false })
    if (error) throw error
    return data ?? []
  },
}
