import { supabase } from './supabaseClient'
import { comprimirImagen } from './soporte'
import { personalApi } from './personal'

/**
 * El expediente de venta: documentación, ubicación, contrato y envío.
 *
 * ── Lo que NO hace este archivo ──
 *
 * No decide si el expediente está completo. Eso lo calcula la vista
 * `v_expedientes` y lo vuelve a verificar la función del servidor al enviarlo.
 * Si la decisión viviera acá, el vendedor con apuro la saltearía desde la
 * consola y la orden llegaría al backoffice sin la cédula.
 */

export const PASOS = [
  { n: 1, titulo: 'Datos del cliente', corto: 'Datos' },
  { n: 2, titulo: 'Cédula', corto: 'Cédula' },
  { n: 3, titulo: 'Fotos del domicilio', corto: 'Domicilio' },
  { n: 4, titulo: 'Ubicación', corto: 'Ubicación' },
  { n: 5, titulo: 'Contrato y firma', corto: 'Contrato' },
]

export const TIPOS_DOCUMENTO = {
  cedula_frontal: 'Cédula — frente',
  cedula_posterior: 'Cédula — dorso',
  fachada: 'Fachada',
  referencia: 'Referencia para llegar',
  lugar_instalacion: 'Dónde va el equipo',
  otro: 'Otra',
}

export const ESTADOS_FIRMA = {
  no_enviado: { label: 'Sin enviar', color: 'gris' },
  enviado: { label: 'Esperando firma', color: 'ambar' },
  firmado: { label: 'Firmado', color: 'verde' },
  rechazado: { label: 'Rechazado', color: 'rojo' },
  vencido: { label: 'Vencido', color: 'rojo' },
}

/** Lo que falta, en palabras, para mostrarlo sin repetir la lógica en cada pantalla. */
export function loQueFalta(e) {
  if (!e) return []
  return [
    !e.ok_datos && 'confirmar los datos',
    !e.ok_cedula_frontal && 'la cédula por el frente',
    !e.ok_cedula_posterior && 'la cédula por el dorso',
    !e.ok_fotos && 'al menos una foto del domicilio',
    !e.ok_ubicacion && 'la ubicación',
    !e.ok_plan && 'el plan',
    !e.ok_contrato && 'generar el contrato',
    !e.ok_firma && 'la firma del cliente',
  ].filter(Boolean)
}

export const expedientesApi = {
  async listar() {
    const { data, error } = await supabase
      .from('v_expedientes')
      .select('*')
      .order('creado_en', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  async abrir(id) {
    const [exp, docs] = await Promise.all([
      supabase.from('v_expedientes').select('*').eq('id', id).maybeSingle(),
      supabase.from('expediente_documentos').select('*').eq('expediente_id', id).order('subido_en'),
    ])
    if (exp.error) throw exp.error
    return { expediente: exp.data, documentos: docs.data ?? [] }
  },

  /** El expediente de un prospecto, que es como se llega desde la lista. */
  async porProspecto(prospectoId) {
    const { data } = await supabase
      .from('v_expedientes')
      .select('*')
      .eq('prospecto_id', prospectoId)
      .maybeSingle()
    return data ?? null
  },

  async guardar(id, cambios) {
    const { error } = await supabase
      .from('expedientes')
      .update({ ...cambios, actualizado_en: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error
  },

  /**
   * Sube un documento del expediente.
   *
   * La ruta empieza por el id del expediente porque la política del bucket lee
   * esa primera carpeta para decidir quién puede abrirlo. Cambiar el orden de la
   * ruta rompería el permiso del archivo sin que nada avise.
   */
  async subirDocumento({ expedienteId, tipo, archivo, perfil }) {
    // Se comprime antes de subir: el vendedor está con datos móviles en la
    // vereda y una foto de 4 MB del celular muchas veces no llega. La cédula se
    // deja más grande que el resto — tiene que poder leerse el número.
    const esCedula = tipo.startsWith('cedula')
    const blob = await comprimirImagen(archivo, {
      max: esCedula ? 1600 : 1280,
      calidad: esCedula ? 0.82 : 0.7,
    })

    const ruta = `${expedienteId}/${tipo}-${Date.now()}.jpg`
    const { error: errSubida } = await supabase.storage
      .from('expedientes')
      .upload(ruta, blob, { contentType: 'image/jpeg' })
    if (errSubida) throw errSubida

    // Reemplazar la cédula borrosa: se marca la anterior como rechazada en vez
    // de borrarla. El índice único deja una sola vigente, y el historial queda.
    if (esCedula) {
      await supabase
        .from('expediente_documentos')
        .update({ estado: 'rechazado', notas: 'Reemplazada por una foto nueva' })
        .eq('expediente_id', expedienteId)
        .eq('tipo', tipo)
        .neq('estado', 'rechazado')
    }

    const { error } = await supabase.from('expediente_documentos').insert({
      expediente_id: expedienteId,
      tipo,
      ruta,
      mime: 'image/jpeg',
      bytes: blob.size,
      subido_por: perfil?.id ?? null,
    })
    if (error) throw error
  },

  /** URL firmada y corta. Una cédula no puede quedar en un enlace que dura una hora. */
  async verDocumento(ruta) {
    const { data, error } = await supabase.storage
      .from('expedientes')
      .createSignedUrl(ruta, 300)
    if (error) throw error

    personalApi.registrar('expediente.ver_documento', `Abrió el documento ${ruta}`, {
      entidad: 'expediente_documento',
      entidad_id: ruta,
    })
    return data.signedUrl
  },

  async borrarDocumento(doc) {
    await supabase.storage.from('expedientes').remove([doc.ruta])
    const { error } = await supabase.from('expediente_documentos').delete().eq('id', doc.id)
    if (error) throw error
  },

  /**
   * Guarda la ubicación capturada.
   *
   * `origen` no es decorativo: la base tiene un CHECK que rechaza `gps` sin
   * precisión, porque la API del navegador siempre la devuelve y un formulario
   * manual no. Mandar 'gps' con una coordenada tipeada falla, que es el punto.
   */
  async guardarUbicacion({ expedienteId, latitud, longitud, precision, origen, perfil }) {
    const { error } = await supabase
      .from('expedientes')
      .update({
        latitud,
        longitud,
        precision_m: origen === 'gps' ? precision : null,
        ubicacion_origen: origen,
        ubicacion_en: new Date().toISOString(),
        ubicacion_por: perfil?.id ?? null,
        actualizado_en: new Date().toISOString(),
      })
      .eq('id', expedienteId)
    if (error) throw error

    personalApi.registrar(
      'expediente.ubicacion',
      `Registró la ubicación (${origen}${origen === 'gps' ? `, ±${Math.round(precision)} m` : ''})`,
      { entidad: 'expediente', entidad_id: expedienteId },
    )
  },

  /** Crea el contrato reutilizando el módulo que ya existe. */
  async generarContrato({ expediente, perfil }) {
    const { data: contrato, error } = await supabase
      .from('contratos')
      .insert({
        client_id: null,
        plan_id: expediente.plan_id,
        precio_mensual: expediente.plan_precio ?? 0,
        estado: 'vigente',
        firma_estado: 'no_enviado',
        notas: `Generado desde el expediente de venta de ${expediente.cliente}`,
      })
      .select()
      .single()
    if (error) throw error

    await this.guardar(expediente.id, { contrato_id: contrato.id })
    personalApi.registrar('contrato.generar', `Generó el contrato de ${expediente.cliente}`, {
      entidad: 'contrato',
      entidad_id: contrato.id,
    })
    return contrato
  },

  /**
   * Manda el expediente al backoffice.
   *
   * Llama a la función del servidor, que revalida el checklist entero. Si algo
   * falta, el mensaje que vuelve dice exactamente qué — y viene de la base, no
   * de una validación del navegador que se puede saltear.
   */
  async enviar(expedienteId) {
    const { data, error } = await supabase.rpc('enviar_expediente_a_instalaciones', {
      p_expediente: expedienteId,
    })
    if (error) throw new Error(error.message.replace(/^.*?:\s*/, ''))

    personalApi.registrar('expediente.enviar', 'Envió el expediente a instalaciones', {
      entidad: 'expediente',
      entidad_id: expedienteId,
    })
    return data
  },
}
