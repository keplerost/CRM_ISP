import { supabase } from './supabaseClient'
import { personalApi } from './personal'
import { enlaceWhatsApp as enlace } from './telefono'

/**
 * Cobranza comercial: la bandeja del vendedor.
 *
 * ── Lo que este archivo NO puede hacer ──
 *
 * Leer `clientes`. Al vendedor la tabla le está cerrada por RLS, a propósito:
 * para cobrar hacen falta un nombre, un teléfono y un saldo, no la cédula ni la
 * dirección ni el historial. Todo lo que necesita viene de
 * `v_cobros_por_gestionar`, que corre con privilegio y devuelve solo esas
 * columnas.
 *
 * Si alguna vez hace falta un dato más en la bandeja, se agrega a esa vista —
 * pensándolo— y no abriendo la tabla.
 */

export const CANALES = {
  llamada: 'Llamada',
  whatsapp: 'WhatsApp',
  visita: 'Visita',
  otro: 'Otro',
}

export const RESULTADOS_COBRO = {
  pendiente_contacto: { label: 'Pendiente de contacto', color: 'gris' },
  contactado: { label: 'Contactado', color: 'azul' },
  promesa_pago: { label: 'Promesa de pago', color: 'ambar' },
  no_responde: { label: 'No responde', color: 'ambar' },
  pago_informado: { label: 'Pago informado', color: 'azul' },
  pagado: { label: 'Pagado', color: 'verde' },
  escalar: { label: 'Escalar a cobranza', color: 'rojo' },
}

/**
 * ¿Este cobro está en rojo?
 *
 * Quince días es cuando en un ISP se corta el servicio. Antes de eso todavía es
 * una gestión comercial; después ya es un corte y una reconexión, que cuesta
 * plata a los dos lados.
 */
export const esUrgente = (c) => (c.dias_atraso ?? 0) >= 15

/**
 * El enlace que abre WhatsApp con el mensaje escrito.
 *
 * La conversión del número la hace `telefono.js`. Antes estaba acá, y estaba
 * mal: si el teléfono venía sin el 0 adelante —`990032123`— lo dejaba tal cual
 * y WhatsApp abría un chat con un número que no existe.
 */
export function enlaceWhatsApp(cobro) {
  return enlace(
    cobro.telefono,
    `Hola ${cobro.cliente}, le escribo de parte del ISP. Tiene un saldo pendiente de $${Number(
      cobro.saldo_pendiente ?? 0,
    ).toFixed(2)}. ¿Cuándo podría acercarse a cancelar?`,
  )
}

export const cobranzaApi = {
  async bandeja() {
    const { data, error } = await supabase
      .from('v_cobros_por_gestionar')
      .select('*')
      .order('dias_atraso', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  async gestiones(asignacionId) {
    const { data, error } = await supabase
      .from('cobranza_gestiones')
      .select('*')
      .eq('asignacion_id', asignacionId)
      .order('creado_en', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  /**
   * Registra un contacto de cobro.
   *
   * Pasa por la función del servidor, que verifica que la asignación sea de
   * quien la registra. La pantalla ya lo garantiza, pero la vista es de solo
   * lectura y la tabla acepta inserciones: sin ese control, alguien podría
   * anotar gestiones sobre la cobranza de otro.
   */
  async registrar({ asignacionId, canal, resultado, observacion, promesaFecha, promesaMonto }) {
    const { error } = await supabase.rpc('registrar_gestion_cobranza', {
      p_asignacion: asignacionId,
      p_canal: canal,
      p_resultado: resultado,
      p_observacion: observacion || null,
      p_promesa_fecha: promesaFecha || null,
      p_promesa_monto: promesaMonto ? Number(promesaMonto) : null,
    })
    if (error) throw new Error(error.message.replace(/^.*?:\s*/, ''))

    personalApi.registrar(
      'cobranza.gestion',
      `${CANALES[canal]} — ${RESULTADOS_COBRO[resultado]?.label ?? resultado}`,
      { entidad: 'cobranza', entidad_id: asignacionId },
    )
  },

  /** Vuelve a revisar deudas y cierra las pagadas. Corre sola, pero se puede forzar. */
  async sincronizar() {
    const { data, error } = await supabase.rpc('sincronizar_cobranza_comercial')
    if (error) throw error
    return data?.[0] ?? { abiertas: 0, cerradas: 0 }
  },

  /** Los contadores del tablero. */
  async contadores(vendedorId) {
    if (!vendedorId) return null
    const { data } = await supabase
      .from('v_tablero_vendedor')
      .select('*')
      .eq('vendedor_id', vendedorId)
      .maybeSingle()
    return data ?? null
  },
}
