import { db } from '../lib/db.js'
import { badRequest, AppError } from '../lib/errors.js'
import { normalizarSn } from '../drivers/huaweiSnmp.js'
import * as olts from './oltService.js'
import * as ficha from './oltFicha.js'

/**
 * Plantillas de autorización y ONTs cargadas por adelantado.
 *
 * Las dos existen para lo mismo: que autorizar una ONT deje de ser tipear seis
 * datos de memoria. La segunda va más lejos — si la ONT está cargada antes de
 * llegar, el técnico la conecta y el sistema la autoriza sin que nadie esté
 * mirando la pantalla.
 *
 * Eso último escribe en el equipo sin intervención humana, así que todo acá
 * está escrito para fallar cerrado: ante cualquier duda no se autoriza y queda
 * para que una persona lo mire.
 */

const AHORA = () => new Date().toISOString()

// -----------------------------------------------------------------------------
// Plantillas
// -----------------------------------------------------------------------------

export async function listarPresets(oltId) {
  const q = db().from('autorizacion_presets').select('*').order('predeterminado', { ascending: false }).order('nombre')
  // Las generales (olt_id null) sirven para cualquier OLT, así que se muestran
  // siempre; las de otra OLT no.
  const { data, error } = oltId ? await q.or(`olt_id.is.null,olt_id.eq.${oltId}`) : await q
  if (error) throw new AppError(`No se pudieron leer las plantillas: ${error.message}`, { status: 500 })
  return data ?? []
}

export async function guardarPreset(datos) {
  const { id, nombre, ...resto } = datos
  if (!nombre?.trim()) throw badRequest('La plantilla necesita un nombre')

  const fila = {
    nombre: nombre.trim(),
    olt_id: resto.olt_id || null,
    line_profile_id: numeroONada(resto.line_profile_id),
    line_profile_nombre: resto.line_profile_nombre || null,
    srv_profile_id: numeroONada(resto.srv_profile_id),
    srv_profile_nombre: resto.srv_profile_nombre || null,
    vlan: numeroONada(resto.vlan),
    gemport: numeroONada(resto.gemport) ?? 1,
    plan_id: resto.plan_id || null,
    zona: resto.zona || null,
    predeterminado: Boolean(resto.predeterminado),
    notas: resto.notas || null,
    updated_at: AHORA(),
  }

  // Una sola predeterminada por alcance: si hay dos marcadas, el formulario abre
  // con una u otra según cómo ordene la base, y eso es peor que ninguna.
  if (fila.predeterminado) {
    const q = db().from('autorizacion_presets').update({ predeterminado: false })
    await (fila.olt_id ? q.eq('olt_id', fila.olt_id) : q.is('olt_id', null))
  }

  const { data, error } = id
    ? await db().from('autorizacion_presets').update(fila).eq('id', id).select().maybeSingle()
    : await db().from('autorizacion_presets').insert(fila).select().maybeSingle()

  if (error) throw new AppError(`No se pudo guardar la plantilla: ${error.message}`, { status: 400 })
  return data
}

export async function borrarPreset(id) {
  const { error } = await db().from('autorizacion_presets').delete().eq('id', id)
  if (error) throw new AppError(`No se pudo borrar la plantilla: ${error.message}`, { status: 400 })
  return { ok: true }
}

/**
 * Traduce una plantilla a los perfiles de UNA OLT concreta.
 *
 * Los IDs de perfil son de cada equipo: el perfil 2 de una OLT no tiene por qué
 * ser el perfil 2 de otra. Por eso una plantilla general se resuelve por NOMBRE
 * contra los perfiles que tiene cargados esa OLT.
 *
 * Si el nombre no existe ahí, se devuelve el problema en vez de un número: usar
 * el ID a ciegas daría un alta que "funciona" con el perfil equivocado, y eso no
 * se descubre hasta que el abonado se queja de algo que nadie relaciona.
 */
export async function resolverPreset(olt, preset) {
  if (!preset) return { lineProfileId: null, srvProfileId: null, problemas: [] }

  // Plantilla de esta misma OLT: los IDs son suyos, valen tal cual.
  if (preset.olt_id === olt.id) {
    return {
      lineProfileId: preset.line_profile_id ?? null,
      srvProfileId: preset.srv_profile_id ?? null,
      problemas: [],
    }
  }

  const perfiles = await olts.listarPerfilesOnt(olt)
  const problemas = []

  const buscar = (lista, nombre, id, que) => {
    if (!nombre) return id ?? null
    const hallado = (lista ?? []).find((p) => p.nombre.toUpperCase() === nombre.toUpperCase())
    if (!hallado) {
      problemas.push(`La OLT ${olt.nombre} no tiene el perfil de ${que} "${nombre}"`)
      return null
    }
    return hallado.id
  }

  return {
    lineProfileId: buscar(perfiles.line, preset.line_profile_nombre, preset.line_profile_id, 'línea'),
    srvProfileId: buscar(perfiles.srv, preset.srv_profile_nombre, preset.srv_profile_id, 'servicio'),
    problemas,
  }
}

// -----------------------------------------------------------------------------
// ONTs cargadas por adelantado
// -----------------------------------------------------------------------------

export async function listarPreautorizadas(filtros = {}) {
  let q = db().from('v_preautorizadas').select('*').order('created_at', { ascending: false })
  if (filtros.olt_id) q = q.eq('olt_id', filtros.olt_id)
  if (filtros.estado) q = q.eq('estado', filtros.estado)
  const { data, error } = await q
  if (error) throw new AppError(`No se pudieron leer las ONTs cargadas: ${error.message}`, { status: 500 })
  return data ?? []
}

/**
 * Carga una ONT que todavía no está conectada.
 *
 * Se copian los datos de la plantilla ACÁ en vez de guardar solo su ID: si
 * alguien la edita entre hoy y el día que el técnico conecte, esta ONT tiene
 * que entrar con lo que se decidió hoy.
 */
export async function cargarPreautorizada(olt, datos) {
  const serie = normalizarSn(datos.sn)
  if (!serie) throw badRequest('Falta la serie de la ONT')

  // Antes de aceptarla: que no exista ya en el sistema. Cargar una serie que ya
  // tiene servicio termina en un alta duplicada el día que se reconecte.
  const { data: yaEsta } = await db()
    .from('onus')
    .select('id, olt_id, slot, puerto, onu_index, nombre_cliente')
    .eq('sn', serie)
    .maybeSingle()

  if (yaEsta) {
    throw badRequest(`La serie ${serie} ya está dada de alta`, {
      hint: `Está en placa ${yaEsta.slot} puerto ${yaEsta.puerto}${yaEsta.nombre_cliente ? ` a nombre de ${yaEsta.nombre_cliente}` : ''}. Si es una mudanza, primero hay que darla de baja.`,
    })
  }

  // La orden de instalación se busca sola por la serie, igual que hace el
  // formulario de autorización: el técnico ya escaneó el QR de esta misma ONT al
  // cargar la orden, así que el nombre, la dirección y el plan ya están en el
  // sistema. Volver a pedirlos es la forma más segura de que queden distintos.
  //
  // La serie se compara en sus dos notaciones porque puede haberse cargado
  // escaneando la etiqueta o tipeada del comando.
  let instalacion = null
  if (datos.instalacion_id) {
    const { data } = await db()
      .from('instalaciones')
      .select('id, nombre, direccion, plan_id')
      .eq('id', datos.instalacion_id)
      .maybeSingle()
    instalacion = data
  } else {
    const { data: todas } = await db()
      .from('instalaciones')
      .select('id, nombre, direccion, plan_id, equipo_sn, estado')
      .neq('estado', 'cancelada')
    instalacion = (todas ?? []).find((i) => normalizarSn(i.equipo_sn) === serie) ?? null
  }

  let preset = null
  if (datos.preset_id) {
    const { data } = await db()
      .from('autorizacion_presets')
      .select('*')
      .eq('id', datos.preset_id)
      .maybeSingle()
    preset = data
  }

  const resuelto = await resolverPreset(olt, preset)
  if (resuelto.problemas.length) {
    throw badRequest(resuelto.problemas.join('. '), {
      hint: 'Elegí una plantilla de esta OLT, o cargá los perfiles a mano.',
    })
  }

  const vlan = numeroONada(datos.vlan) ?? preset?.vlan ?? null
  if (vlan == null) {
    throw badRequest('Falta la VLAN', {
      hint: 'Sin VLAN la ONT se registraría sin service-port y no pasaría tráfico. Elegí una plantilla que la traiga o escribila.',
    })
  }

  const fila = {
    olt_id: olt.id,
    sn: serie,
    preset_id: preset?.id ?? null,
    nombre: datos.nombre || instalacion?.nombre || null,
    comentario: datos.comentario || instalacion?.direccion || null,
    plan_id: datos.plan_id || instalacion?.plan_id || preset?.plan_id || null,
    vlan,
    gemport: numeroONada(datos.gemport) ?? preset?.gemport ?? 1,
    line_profile_id: numeroONada(datos.line_profile_id) ?? resuelto.lineProfileId,
    srv_profile_id: numeroONada(datos.srv_profile_id) ?? resuelto.srvProfileId,
    slot: numeroONada(datos.slot),
    puerto: numeroONada(datos.puerto),
    instalacion_id: instalacion?.id ?? null,
    automatica: datos.automatica !== false,
    vence_at: datos.vence_at ?? null,
    estado: 'esperando',
    intentos: 0,
    ultimo_error: null,
    updated_at: AHORA(),
  }

  if (fila.line_profile_id == null || fila.srv_profile_id == null) {
    throw badRequest('Faltan los perfiles de línea o de servicio', {
      hint: 'Sin ellos la ONT se registraría con la configuración por defecto del equipo.',
    })
  }

  const { data, error } = await db()
    .from('onts_preautorizadas')
    .upsert(fila, { onConflict: 'olt_id,sn' })
    .select()
    .maybeSingle()

  if (error) throw new AppError(`No se pudo cargar la ONT: ${error.message}`, { status: 400 })
  return data
}

export async function borrarPreautorizada(id) {
  const { error } = await db().from('onts_preautorizadas').delete().eq('id', id)
  if (error) throw new AppError(`No se pudo borrar: ${error.message}`, { status: 400 })
  return { ok: true }
}

/** Vuelve a dejarla esperando después de un fallo, para poder reintentar a mano. */
export async function reactivarPreautorizada(id) {
  const { data, error } = await db()
    .from('onts_preautorizadas')
    .update({ estado: 'esperando', intentos: 0, ultimo_error: null, updated_at: AHORA() })
    .eq('id', id)
    .select()
    .maybeSingle()
  if (error) throw new AppError(`No se pudo reactivar: ${error.message}`, { status: 400 })
  return data
}

// -----------------------------------------------------------------------------
// El enganche con el barrido
// -----------------------------------------------------------------------------

const MAX_INTENTOS = 3

/**
 * ¿Se autoriza sola esta ONT, o no?
 *
 * Está aparte y sin tocar la base a propósito: es la única decisión del sistema
 * que termina escribiendo en un equipo de producción sin que una persona
 * apriete nada, y hay que poder probarla sin un equipo delante.
 *
 * Devuelve `{ autorizar: true }` o el motivo por el que no. Todos los caminos
 * que no son un "sí" claro terminan en "no": es preferible que alguien tenga que
 * apretar un botón a que se configure sola una ONT que no era.
 */
export function decidirPreautorizacion(carga, ont, ahora = new Date()) {
  if (!carga) return { autorizar: false, motivo: 'no estaba cargada' }
  if (carga.estado !== 'esperando') {
    return { autorizar: false, motivo: `está en estado "${carga.estado}"` }
  }
  if (!carga.automatica) {
    return { autorizar: false, motivo: 'está cargada pero marcada para autorizar a mano' }
  }
  if (carga.vence_at && new Date(carga.vence_at) < ahora) {
    return { autorizar: false, vencida: true, motivo: 'venció antes de conectarse' }
  }
  // La ubicación esperada, si se cargó, tiene que coincidir. La misma serie
  // apareciendo en otro puerto es motivo para mirar, no para autorizar sola: el
  // equipo pudo haber terminado en manos de otro.
  if (
    (carga.slot != null && carga.slot !== ont.slot) ||
    (carga.puerto != null && carga.puerto !== ont.puerto)
  ) {
    return {
      autorizar: false,
      motivo: `apareció en ${ont.slot}/${ont.puerto} y estaba cargada para ${carga.slot}/${carga.puerto}`,
    }
  }
  // Sin VLAN o sin perfiles el alta entraría a medias: registrada y sin tráfico,
  // o con la configuración por defecto del equipo.
  if (carga.vlan == null) return { autorizar: false, motivo: 'no tiene VLAN cargada' }
  if (carga.line_profile_id == null || carga.srv_profile_id == null) {
    return { autorizar: false, motivo: 'le faltan los perfiles' }
  }
  return { autorizar: true }
}

/**
 * De las ONTs que el barrido encontró esperando, autoriza las que estaban
 * cargadas de antemano.
 *
 * Esto es lo único del sistema que escribe en un equipo de producción sin que
 * una persona apriete nada, así que cada condición de acá está para no hacerlo:
 *
 *   - solo series cargadas explícitamente, nunca las que aparecen sueltas
 *   - solo si la marcaron como automática
 *   - solo si no venció
 *   - si se cargó una ubicación esperada, solo si apareció justo ahí
 *   - si el equipo la rechaza, no se reintenta a ciegas: queda fallada
 *
 * La última importa más de lo que parece. Un alta que falla siempre reintentada
 * cada cinco minutos no se arregla sola: solo llena el equipo de intentos y tapa
 * el error real.
 */
export async function aplicarPreautorizaciones(olt, esperando = []) {
  if (!esperando.length) return { autorizadas: [], omitidas: [], fallidas: [] }

  const { data: cargadas } = await db()
    .from('onts_preautorizadas')
    .select('*')
    .eq('olt_id', olt.id)
    .eq('estado', 'esperando')

  if (!cargadas?.length) return { autorizadas: [], omitidas: [], fallidas: [] }

  const porSn = new Map(cargadas.map((c) => [normalizarSn(c.sn), c]))
  const autorizadas = []
  const omitidas = []
  const fallidas = []

  for (const ont of esperando) {
    const sn = normalizarSn(ont.sn)
    const carga = porSn.get(sn)
    if (!carga) continue

    const decision = decidirPreautorizacion(carga, ont)
    if (!decision.autorizar) {
      if (decision.vencida) {
        await db()
          .from('onts_preautorizadas')
          .update({ estado: 'cancelada', ultimo_error: decision.motivo, updated_at: AHORA() })
          .eq('id', carga.id)
      }
      omitidas.push({ sn, motivo: decision.motivo })
      continue
    }

    try {
      const r = await ficha.autorizarOnt(olt, {
        sn,
        slot: ont.slot,
        puerto: ont.puerto,
        lineProfileId: carga.line_profile_id,
        srvProfileId: carga.srv_profile_id,
        vlan: carga.vlan,
        gemport: carga.gemport ?? 1,
        nombre: carga.nombre,
        comentario: carga.comentario,
        plan_id: carga.plan_id,
        instalacion_id: carga.instalacion_id,
      })

      await db()
        .from('onts_preautorizadas')
        .update({
          estado: 'autorizada',
          autorizada_at: AHORA(),
          onu_id: r.onu_id ?? null,
          intentos: (carga.intentos ?? 0) + 1,
          ultimo_error: null,
          updated_at: AHORA(),
        })
        .eq('id', carga.id)

      autorizadas.push({ sn, slot: ont.slot, puerto: ont.puerto, ontId: r.ontId, aviso: r.aviso })
    } catch (err) {
      const intentos = (carga.intentos ?? 0) + 1
      await db()
        .from('onts_preautorizadas')
        .update({
          estado: intentos >= MAX_INTENTOS ? 'fallada' : 'esperando',
          intentos,
          ultimo_error: err.message,
          updated_at: AHORA(),
        })
        .eq('id', carga.id)

      fallidas.push({ sn, intentos, error: err.message })
    }
  }

  return { autorizadas, omitidas, fallidas }
}

const numeroONada = (v) => {
  if (v === '' || v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
