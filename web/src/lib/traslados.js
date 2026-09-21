import { supabase } from './supabaseClient'

/**
 * Traslado de domicilio.
 *
 * ── Qué resuelve y qué no ──
 *
 * Abrir un traslado hace dos cosas que hasta ahora se hacían por teléfono:
 * guarda DÓNDE estaba el abonado —OLT, puerto PON, VLAN, NAP, IP— antes de que
 * ese dato se pierda, y agenda la orden de trabajo en la dirección nueva.
 *
 * Lo que NO hace es elegir nada de la red del destino. El puerto, la VLAN y el
 * segmento del sector nuevo salen de dónde aparezca físicamente la ONT cuando
 * el técnico mida, exactamente igual que en un alta. Que sea otra OLT —Progreso
 * en vez de La Maná— no cambia el procedimiento: se autoriza donde apareció.
 *
 * ── Por qué importa la foto del origen ──
 *
 * Porque si el abonado se lleva el mismo equipo, la OLT del destino lo va a
 * rechazar: una serie no puede estar viva en dos puertos. Sin saber dónde
 * estaba, nadie puede darla de baja, y el técnico se queda esperando en la casa
 * nueva a que alguien en la oficina la busque a mano.
 */

export const trasladosApi = {
  /** Abre el traslado y agenda la visita. Devuelve el id del traslado. */
  async iniciar({ clienteId, direccion, latitud, longitud, fecha, motivo, tecnicoId, referencia }) {
    const { data, error } = await supabase.rpc('iniciar_traslado', {
      p_cliente: clienteId,
      p_direccion: direccion,
      p_latitud: latitud === '' || latitud == null ? null : Number(latitud),
      p_longitud: longitud === '' || longitud == null ? null : Number(longitud),
      p_fecha: fecha || null,
      p_motivo: motivo || null,
      p_tecnico: tecnicoId || null,
      p_referencia: referencia || null,
    })
    if (error) throw error
    return data
  },

  /** Los que tienen la ONT vieja todavía viva en su OLT de origen. */
  async pendientes() {
    const { data, error } = await supabase
      .from('v_traslados_pendientes')
      .select('*')
      .order('creado_en')
    if (error) throw error
    return data ?? []
  },

  /** El historial de mudanzas de un abonado. */
  async delCliente(clienteId) {
    const { data, error } = await supabase
      .from('v_traslados')
      .select('*')
      .eq('cliente_id', clienteId)
      .order('creado_en', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  /** El que está abierto ahora, si hay. Solo puede haber uno. */
  async abierto(clienteId) {
    const { data, error } = await supabase
      .from('v_traslados')
      .select('*')
      .eq('cliente_id', clienteId)
      .eq('estado', 'abierto')
      .maybeSingle()
    if (error) throw error
    return data ?? null
  },

  /**
   * Marca la ONT vieja como dada de baja.
   *
   * Es para cuando se resolvió a mano desde la pantalla de la OLT. No borra
   * nada en el equipo: solo deja de reclamar algo que ya se hizo. Por eso pide
   * un detalle — "la borré yo el martes" es lo que después explica el hueco.
   */
  async marcarBaja(id, detalle) {
    const { error } = await supabase
      .from('traslados')
      .update({
        pendiente_baja: false,
        baja_at: new Date().toISOString(),
        baja_detalle: detalle || 'Dada de baja a mano desde la OLT',
      })
      .eq('id', id)
    if (error) throw error
  },

  /** Cierra el traslado. La base no deja cerrarlo con la ONT vieja viva. */
  async cerrar(id) {
    const { error } = await supabase
      .from('traslados')
      .update({ estado: 'hecho', cerrado_en: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error
  },

  async cancelar(id) {
    const { error } = await supabase
      .from('traslados')
      .update({ estado: 'cancelado', cerrado_en: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error
  },
}
