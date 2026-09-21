import { supabase } from './supabaseClient'

/**
 * Las actas de entrega de material.
 *
 * ── Por qué todo pasa por funciones y nada escribe la tabla ──
 *
 * Porque un acta no es un registro: es un movimiento de inventario con dos
 * personas de por medio. Crearla marca equipos como "en camino"; firmarla los
 * pasa de un almacén a otro y deja el rastro. Una fila insertada a mano no
 * movería nada y quedaría mintiendo sobre dónde está el material.
 *
 * Por eso las políticas de RLS niegan la escritura directa y acá solo hay RPC.
 */
export const entregasApi = {
  /** Lo que tiene en su almacén quien pregunta. */
  async miAlmacen() {
    const { data, error } = await supabase
      .from('v_mi_almacen_equipos')
      .select('*')
      .order('recuperado_en', { ascending: false, nullsFirst: false })
    if (error) throw error
    return data ?? []
  },

  /** Las actas que le tocan: las que entregó o las que recibió. */
  async mias() {
    const { data, error } = await supabase
      .from('v_entregas_inventario')
      .select('*')
      .order('creado_en', { ascending: false })
      .limit(50)
    if (error) throw error
    return data ?? []
  },

  /** Solo las que esperan firma. Es la bandeja de la oficina. */
  async pendientes() {
    const { data, error } = await supabase
      .from('v_entregas_inventario')
      .select('*')
      .eq('estado', 'pendiente')
      .order('creado_en')
    if (error) throw error
    return data ?? []
  },

  async items(entregaId) {
    const { data, error } = await supabase
      .from('entrega_items')
      .select('*')
      .eq('entrega_id', entregaId)
    if (error) throw error
    return data ?? []
  },

  /**
   * Arma el acta y la firma de este lado.
   *
   * La firma va acá y no en un paso aparte porque es el mismo acto: armar la
   * lista de lo que se entrega ES entregarlo. Separarlos dejaría actas a medio
   * firmar dando vueltas.
   */
  async crear(equipos, notas, firma) {
    const { data, error } = await supabase.rpc('crear_entrega_inventario', {
      p_equipos: equipos,
      p_notas: notas || null,
      p_firma: firma || null,
    })
    if (error) throw error
    return data
  },

  /**
   * Firma la recepción.
   *
   * La firma es la imagen del trazo. Sin ella la función rechaza: un acta
   * recibida sin firma no distingue "me lo entregaron" de "alguien apretó un
   * botón".
   */
  async recibir(entregaId, { firma, almacen, notas } = {}) {
    const { data, error } = await supabase.rpc('recibir_entrega_inventario', {
      p_entrega: entregaId,
      p_firma: firma,
      p_almacen: almacen || null,
      p_notas: notas || null,
    })
    if (error) throw error
    return data
  },
}
