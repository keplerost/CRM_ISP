import { supabase } from './supabaseClient'

/**
 * La cartera que se cae: quién dejó de renovar, qué equipo hay que ir a buscar
 * y quién volvió.
 *
 * ── Por qué la gestión del contacto no está acá ──
 *
 * Porque ya existe. Llamar a un abonado, anotar el resultado y registrar una
 * promesa es `registrar_gestion_cobranza`, del módulo de cobranza comercial.
 * Duplicarlo dejaría dos historiales de contacto con la misma persona, y el que
 * se consulta siempre es el que está incompleto.
 *
 * Lo único que se agrega es la puerta para abrir esa gestión desde la cartera en
 * riesgo: `abrirGestion`.
 */

/** Cómo se muestra cada situación. El texto es el que ve el vendedor. */
export const SITUACIONES = {
  sin_renovar: {
    label: 'No renovó',
    tono: 'ambar',
    ayuda: 'Se le pasó el período. Todavía es recuperable con una llamada.',
  },
  por_retirar: {
    label: 'Por retirar',
    tono: 'rojo',
    ayuda: 'Llegó a la condición de retiro de equipo. La orden se genera sola.',
  },
  retiro: {
    label: 'Retiro en curso',
    tono: 'rojo',
    ayuda: 'Hay una orden abierta para recuperar el equipo.',
  },
  baja: { label: 'Dado de baja', tono: 'gris', ayuda: 'Ya no es abonado.' },
}

/** Por qué no se pudo recuperar un equipo. */
export const MOTIVOS_RETIRO = [
  { clave: 'no_ubicado', label: 'No vive más ahí' },
  { clave: 'se_niega', label: 'Se niega a entregarlo' },
  { clave: 'no_estaba', label: 'Nunca se lo encontró' },
  { clave: 'equipo_roto', label: 'El equipo está roto' },
  { clave: 'equipo_robado', label: 'Robo o pérdida' },
  { clave: 'zona_insegura', label: 'Zona insegura' },
  { clave: 'cliente_volvio', label: 'El abonado volvió' },
  { clave: 'otro', label: 'Otro' },
]

/** Cómo salió cada visita. */
export const RESULTADOS_INTENTO = [
  { clave: 'no_estaba', label: 'No había nadie' },
  { clave: 'se_niega', label: 'Se niega a entregarlo' },
  { clave: 'no_ubicado', label: 'No vive más ahí' },
  { clave: 'reprogramado', label: 'Reprogramado' },
  { clave: 'recuperado', label: 'Equipo recuperado' },
  { clave: 'otro', label: 'Otro' },
]

export const carteraApi = {
  /** Los clientes propios que dejaron de renovar. */
  async enRiesgo({ vendedor } = {}) {
    let q = supabase
      .from('v_cartera_en_riesgo')
      .select('*')
      .order('meses_sin_pago', { ascending: false })
    if (vendedor) q = q.eq('vendedor_id', vendedor)

    const { data, error } = await q
    if (error) throw error
    return data ?? []
  },

  /**
   * Abre la gestión de recuperación y devuelve la asignación.
   *
   * La pantalla la necesita para registrar el contacto con la función de
   * cobranza, que trabaja sobre la asignación y no sobre el cliente.
   */
  async abrirGestion(clienteId, dias = 30) {
    const { data, error } = await supabase.rpc('abrir_gestion_recuperacion', {
      p_cliente: clienteId,
      p_dias: dias,
    })
    if (error) throw error
    return data
  },

  // ── Retiros de equipo ──────────────────────────────────────────────────────

  async retiros({ estados, tecnico } = {}) {
    let q = supabase.from('v_retiros_equipo').select('*').order('creado_en', { ascending: false })
    if (estados?.length) q = q.in('estado', estados)
    if (tecnico) q = q.eq('tecnico_id', tecnico)

    const { data, error } = await q
    if (error) throw error
    return data ?? []
  },

  /**
   * Cada visita a esa orden, con lo que dijo el abonado.
   *
   * Se trae el nombre del técnico junto con el intento: quien después tiene que
   * explicarle a un vendedor por qué se dio de baja a su cliente necesita poder
   * decir quién fue y qué encontró, no solo qué día.
   */
  async intentos(retiroId) {
    const { data, error } = await supabase
      .from('retiro_intentos')
      .select('*, tecnicos(nombre), usuarios_sistema(nombre, apellido)')
      .eq('retiro_id', retiroId)
      .order('creado_en', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  /** Los números del punto 13. La fila sin vendedor es el total. */
  async resumen() {
    const { data, error } = await supabase.from('v_retiros_resumen').select('*')
    if (error) throw error
    return data ?? []
  },

  /**
   * Las órdenes de quien las tiene que trabajar.
   *
   * Sin filtro por técnico ni por responsable: la vista ya devuelve solo las
   * suyas —lo hace la política de RLS— y filtrar de nuevo en la pantalla sería
   * repetir la seguridad en el lugar equivocado.
   */
  async misRetiros() {
    const { data, error } = await supabase
      .from('v_retiros_equipo')
      .select('*')
      .in('estado', ['pendiente', 'asignado'])
      // Primero lo que tiene hora, y de eso lo más cercano. Lo que no tiene
      // cita va después, por antigüedad: es el orden del día de trabajo.
      .order('agendado_para', { ascending: true, nullsFirst: false })
      .order('meses_sin_pago', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  /** Asigna una orden a una persona del sistema, sea técnico o no. */
  async asignar(retiroId, usuarioId) {
    const { error } = await supabase.rpc('asignar_retiro_a', {
      p_retiro: retiroId,
      p_usuario: usuarioId,
    })
    if (error) throw error
  },

  /** Lo mismo para un recorrido entero. Devuelve cuántas entraron y cuántas no. */
  async asignarLote(retiroIds, usuarioId) {
    const { data, error } = await supabase.rpc('asignar_retiros_equipo', {
      p_retiros: retiroIds,
      p_usuario: usuarioId,
    })
    if (error) throw error
    return data?.[0] ?? { asignadas: 0, salteadas: 0 }
  },

  /**
   * Anota la cita que pidió el abonado.
   *
   * `cuando` es un ISO completo. La nota es lo que dijo con sus palabras, que
   * es lo que evita el viaje al pedo: "después de las 6", "el sábado", "avisá
   * antes de venir".
   */
  async agendar(retiroId, { cuando, nota } = {}) {
    const { error } = await supabase.rpc('agendar_retiro_equipo', {
      p_retiro: retiroId,
      p_cuando: cuando,
      p_nota: nota || null,
    })
    if (error) throw error
  },

  /**
   * Borra la deuda del equipo que no volvió.
   *
   * Pasa más de lo que uno cree: el abonado aparece meses después con la ONT en
   * la mano, o la paga para poder volver a contratar. Queda en la auditoría
   * porque es plata: alguien decidió borrar una deuda.
   */
  async saldarDeudaEquipo(clienteId, nota) {
    const { data, error } = await supabase.rpc('saldar_deuda_equipo', {
      p_cliente: clienteId,
      p_nota: nota || null,
    })
    if (error) throw error
    return data
  },

  /** Cada contacto con el abonado y lo que dijo. Es lo que se baja al archivo. */
  async gestiones({ estados } = {}) {
    let q = supabase
      .from('v_retiro_gestiones')
      .select('*')
      .order('contacto_en', { ascending: false, nullsFirst: false })
    if (estados?.length) q = q.in('estado_orden', estados)

    const { data, error } = await q
    if (error) throw error
    return data ?? []
  },

  async registrarIntento(retiroId, { resultado, observacion, foto }) {
    const { error } = await supabase.rpc('registrar_intento_retiro', {
      p_retiro: retiroId,
      p_resultado: resultado,
      p_observacion: observacion || null,
      p_foto: foto || null,
    })
    if (error) throw error
  },

  /**
   * Cierra la orden.
   *
   * La serie es opcional y se manda cuando el técnico la escribió a mano: es el
   * caso del abonado viejo cuyo equipo nunca entró al inventario, y el del
   * equipo que resultó ser otro distinto al que decía la ficha.
   */
  async cerrar(retiroId, { recuperado, motivo, observacion, serie, almacen, firma, firmante } = {}) {
    const { error } = await supabase.rpc('cerrar_retiro_equipo', {
      p_retiro: retiroId,
      p_recuperado: Boolean(recuperado),
      p_motivo: motivo || null,
      p_observacion: observacion || null,
      p_serie: serie || null,
      p_almacen: almacen || null,
      p_firma: firma || null,
      p_firmante: firmante || null,
    })
    if (error) throw error
  },

  /**
   * Por qué no se recuperó, en categorías.
   *
   * Salen de la base y no de una lista escrita acá: cada una lleva reglas
   * —si cuenta como pérdida, si se puede reclamar— y el día que aparezca un
   * caso nuevo se agrega una fila, no una versión de la app.
   */
  async categorias() {
    const { data, error } = await supabase
      .from('retiro_categorias')
      .select('*')
      .eq('activa', true)
      .order('orden')
    if (error) throw error
    return data ?? []
  },

  // ── El pendiente que queda después ────────────────────────────────────────

  /** Abonados sin equipo que siguen figurando como activos. */
  async fichasPorCerrar() {
    const { data, error } = await supabase
      .from('v_fichas_por_cerrar')
      .select('*')
      .order('cerrado_en', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  async motivosBaja() {
    const { data, error } = await supabase
      .from('motivos_baja')
      .select('id, nombre, afecta_calidad')
      .eq('activo', true)
      .order('orden')
    if (error) throw error
    return data ?? []
  },

  /**
   * Marca al abonado como retirado.
   *
   * No borra la ficha: los pagos, las facturas del SRI y las comisiones pagadas
   * apuntan a ella, y el que se fue vuelve. Se marca y se guarda por qué.
   */
  async cerrarFicha(clienteId, { motivo, nota } = {}) {
    const { data, error } = await supabase.rpc('cerrar_ficha_por_retiro', {
      p_cliente: clienteId,
      p_motivo: motivo || null,
      p_nota: nota || null,
    })
    if (error) throw error
    return data
  },

  // ── Reactivaciones ─────────────────────────────────────────────────────────

  /**
   * Quiénes volvieron.
   *
   * No generan comisión y no hay nada acá que las convierta en una: es registro
   * para el día que exista el incentivo de recuperación.
   */
  async reactivaciones({ desde, vendedor } = {}) {
    let q = supabase
      .from('v_reactivaciones')
      .select('*')
      .order('reactivado_el', { ascending: false })
    if (desde) q = q.gte('reactivado_el', desde)
    if (vendedor) q = q.eq('vendedor_id', vendedor)

    const { data, error } = await q
    if (error) throw error
    return data ?? []
  },
}
