import { supabase } from './supabaseClient'
import { personalApi } from './personal'

/**
 * Ventas: el embudo, la agenda y la cobertura.
 *
 * ── El estado es el embudo ──
 *
 * No hay una tabla de "oportunidades" separada del prospecto. La oportunidad es
 * el prospecto parado en una etapa: nuevo → contactado → cotizado → negociación
 * → ganado o perdido. Dos tablas obligarían a mantener sincronizadas dos filas
 * que siempre dicen lo mismo, y la segunda se desactualiza.
 */

export const ESTADOS = [
  { clave: 'nuevo', label: 'Nuevo', color: 'gris', ayuda: 'Entró y nadie lo llamó todavía.' },
  { clave: 'contactado', label: 'Contactado', color: 'azul', ayuda: 'Se habló y hay interés.' },
  { clave: 'cotizado', label: 'Cotizado', color: 'ambar', ayuda: 'Tiene el precio en la mano.' },
  { clave: 'negociacion', label: 'En negociación', color: 'ambar', ayuda: 'Discutiendo precio o fecha.' },
  { clave: 'ganado', label: 'Ganado', color: 'verde', ayuda: 'Aceptó. Se le crea la instalación.' },
  { clave: 'perdido', label: 'Perdido', color: 'rojo', ayuda: 'No va. Pide motivo, y por algo.' },
]

/** Las etapas en las que el prospecto sigue vivo: las que forman la agenda. */
export const ESTADOS_ABIERTOS = ['nuevo', 'contactado', 'cotizado', 'negociacion']

export const ORIGENES = {
  referido: 'Referido de un abonado',
  redes: 'Redes sociales',
  llamada: 'Llamó a la oficina',
  visita: 'Se acercó / puerta a puerta',
  local: 'Vino al local',
  web: 'Sitio web',
  otro: 'Otro',
}

export const TIPOS_ACTIVIDAD = {
  llamada: 'Llamada',
  visita: 'Visita',
  whatsapp: 'WhatsApp',
  correo: 'Correo',
  nota: 'Nota interna',
}

export const RESULTADOS = {
  contactado: 'Se lo contactó',
  no_contesta: 'No contesta',
  reagendar: 'Pidió que lo llamen después',
  interesado: 'Interesado',
  no_interesado: 'No le interesa',
}

export const COBERTURAS = {
  pendiente: { label: 'Sin verificar', color: 'gris' },
  factible: { label: 'Factible', color: 'verde' },
  con_obra: { label: 'Llega con obra', color: 'ambar' },
  no_factible: { label: 'Fuera de alcance', color: 'rojo' },
}

export const etiquetaEstado = (clave) => ESTADOS.find((e) => e.clave === clave) ?? ESTADOS[0]

/**
 * ¿Está en riesgo de enfriarse?
 *
 * Cinco días sin tocarlo. El número no sale de ningún lado teórico: es lo que
 * tarda alguien que pidió precio en llamar a otro proveedor. Sirve para ordenar
 * la lista por lo que hay que atender hoy, no para bloquear nada.
 */
export const seEstaEnfriando = (p) =>
  ESTADOS_ABIERTOS.includes(p.estado) && (p.dias_sin_contacto ?? 0) >= 5

export const ventasApi = {
  async listar() {
    const { data, error } = await supabase
      .from('v_prospectos')
      .select('*')
      .order('creado_en', { ascending: false })
      .limit(500)
    if (error) throw error
    return data ?? []
  },

  async guardar(prospecto) {
    const { id, ...datos } = prospecto
    const fila = { ...datos, actualizado_en: new Date().toISOString() }

    const { data, error } = id
      ? await supabase.from('prospectos').update(fila).eq('id', id).select().single()
      : await supabase.from('prospectos').insert(fila).select().single()
    if (error) throw error

    personalApi.registrar(
      id ? 'prospecto.editar' : 'prospecto.crear',
      `${id ? 'Editó' : 'Cargó'} el prospecto ${data.nombre}`,
      { entidad: 'prospecto', entidad_id: data.id },
    )
    return data
  },

  async eliminar(p) {
    const { error } = await supabase.from('prospectos').delete().eq('id', p.id)
    if (error) throw error
    personalApi.registrar('prospecto.eliminar', `Eliminó el prospecto ${p.nombre}`, {
      entidad: 'prospecto',
      entidad_id: p.id,
    })
  },

  /**
   * Mueve el prospecto de etapa.
   *
   * Va aparte de `guardar` porque es la acción que más se repite y la que se
   * audita: "quién dio por perdida esta venta y por qué" es una pregunta que se
   * hace de verdad, y no se puede responder si el cambio viaja escondido dentro
   * de un guardado general.
   */
  async cambiarEstado(p, estado, motivo) {
    const fila = { estado, actualizado_en: new Date().toISOString() }
    if (estado === 'perdido') fila.motivo_perdida = motivo
    // Volver a abrir un prospecto tiene que limpiar el motivo: si no, queda
    // diciendo "no le alcanzaba" un prospecto que hoy está en negociación.
    if (estado !== 'perdido') fila.motivo_perdida = null

    const { data, error } = await supabase
      .from('prospectos')
      .update(fila)
      .eq('id', p.id)
      .select()
      .single()
    if (error) throw error

    personalApi.registrar(
      'prospecto.estado',
      `${p.nombre}: ${etiquetaEstado(p.estado).label} → ${etiquetaEstado(estado).label}` +
        (motivo ? ` (${motivo})` : ''),
      { entidad: 'prospecto', entidad_id: p.id },
    )
    return data
  },

  async actividades(prospectoId) {
    const { data, error } = await supabase
      .from('prospecto_actividades')
      .select('*')
      .eq('prospecto_id', prospectoId)
      .order('creado_en', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  async registrarActividad(prospectoId, actividad, perfil) {
    const { error } = await supabase.from('prospecto_actividades').insert({
      prospecto_id: prospectoId,
      ...actividad,
      usuario_id: perfil?.id ?? null,
      usuario_nombre: perfil ? `${perfil.nombre} ${perfil.apellido ?? ''}`.trim() : null,
    })
    if (error) throw error
  },

  /**
   * Agenda un seguimiento: lo que HAY que hacer, con fecha y hora.
   *
   * Es la misma tabla que el historial. Un seguimiento cumplido se marca
   * completado y pasa a ser historial sin moverse de lugar — separarlos en dos
   * tablas obligaría a cruzarlas para armar la línea de tiempo de un prospecto,
   * que es lo único que alguien quiere leer.
   */
  async agendar(prospectoId, seguimiento, perfil) {
    const { error } = await supabase.from('prospecto_actividades').insert({
      prospecto_id: prospectoId,
      estado: 'pendiente',
      ...seguimiento,
      usuario_id: perfil?.id ?? null,
      usuario_nombre: perfil ? `${perfil.nombre} ${perfil.apellido ?? ''}`.trim() : null,
    })
    if (error) throw error

    // La fecha del próximo contacto también vive en el prospecto, porque es por
    // donde se ordena la lista. Se copia acá para que no haya que consultar los
    // seguimientos de los 500 prospectos solo para ordenarlos.
    if (seguimiento.programado_para) {
      await supabase
        .from('prospectos')
        .update({ proxima_accion: seguimiento.programado_para.slice(0, 10) })
        .eq('id', prospectoId)
    }
  },

  /** Cierra un seguimiento: completado o cancelado. */
  async cerrarSeguimiento(id, estado) {
    const { error } = await supabase
      .from('prospecto_actividades')
      .update({
        estado,
        completado_en: estado === 'completado' ? new Date().toISOString() : null,
      })
      .eq('id', id)
    if (error) throw error
  },

  async cotizaciones(prospectoId) {
    const { data, error } = await supabase
      .from('cotizaciones')
      .select('*')
      .eq('prospecto_id', prospectoId)
      .order('creado_en', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  async cotizar(prospectoId, cotizacion, perfil) {
    const { data, error } = await supabase
      .from('cotizaciones')
      .insert({ prospecto_id: prospectoId, ...cotizacion, creado_por: perfil?.id ?? null })
      .select()
      .single()
    if (error) throw error

    // Cotizar mueve el embudo solo. Dejarlo a mano significa que la mitad de los
    // prospectos con cotización siguen figurando como "contactado", y el tablero
    // deja de servir para saber dónde está cada venta.
    await supabase
      .from('prospectos')
      .update({ estado: 'cotizado', actualizado_en: new Date().toISOString() })
      .eq('id', prospectoId)
      .in('estado', ['nuevo', 'contactado'])

    return data
  },

  /**
   * Los planes vigentes, para elegir qué pidió el cliente. Solo lectura.
   *
   * `precio` acá es el TOTAL con IVA — lo que el abonado paga. La columna
   * `precio` de la tabla es el neto, y usarla era el error: el vendedor decía
   * "veinte" y al mes llegaba una factura de veintitrés.
   *
   * El neto viaja aparte porque lo necesitan la comisión y la contabilidad. Lo
   * que no puede pasar es que alguien lea `precio` y no sepa cuál de los dos es.
   */
  async planes() {
    const { data, error } = await supabase
      .from('v_planes')
      .select('id, nombre, precio_total, precio_sin_iva, iva_valor, iva_porcentaje, tipo_impuesto, bajada_kbps, subida_kbps, activo')
      .eq('activo', true)
      .order('bajada_kbps')
    if (error) throw error
    return (data ?? []).map((p) => ({ ...p, precio: p.precio_total }))
  },

  /** Las zonas dibujadas y las cajas con puerto libre: las dos capas del mapa. */
  async cobertura() {
    const [zonas, cajas] = await Promise.all([
      supabase.from('zonas_cobertura').select('*').eq('activa', true),
      supabase.from('v_cajas_nap').select('id, nombre, tipo, latitud, longitud, capacidad, libres, llena, activo'),
    ])
    if (zonas.error) throw zonas.error
    return {
      zonas: zonas.data ?? [],
      // Sin coordenadas no hay nada que dibujar, y una caja invisible en el mapa
      // se lee como "no hay cobertura ahí".
      cajas: (cajas.data ?? []).filter((c) => c.latitud != null && c.longitud != null),
    }
  },

  async guardarZona(zona) {
    const { id, ...datos } = zona
    const { error } = id
      ? await supabase.from('zonas_cobertura').update(datos).eq('id', id)
      : await supabase.from('zonas_cobertura').insert(datos)
    if (error) throw error
  },

  async eliminarZona(id) {
    const { error } = await supabase.from('zonas_cobertura').delete().eq('id', id)
    if (error) throw error
  },
}
