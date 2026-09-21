import { db } from '../lib/db.js'
import { AppError, badRequest, notFound } from '../lib/errors.js'

/**
 * Las plantillas aprobadas de WhatsApp.
 *
 * ── Por qué esto existe ──
 *
 * Porque la API oficial solo acepta texto libre dentro de una ventana de 24
 * horas contada desde el último mensaje del abonado, y todos nuestros avisos
 * automáticos caen fuera: nadie le escribe al ISP para que le avisen que se le
 * vence la factura.
 *
 * Fuera de esa ventana hay que mandar una plantilla que Meta aprobó de antemano,
 * con variables POSICIONALES. Este archivo es lo que traduce entre nuestras
 * variables con nombre —`{{saldo}}`, `{{fecha_corte}}`— y los `{{1}}`, `{{2}}`
 * que espera Meta.
 *
 * ── La regla que gobierna todo ──
 *
 * Si un aviso automático no tiene plantilla APROBADA, no sale por WhatsApp. No
 * se intenta "por si acaso": intentarlo devuelve error, el abonado no recibe
 * nada, y el sistema lo cuenta como envío fallido en vez de caer al SMS o al
 * correo, que sí habrían llegado.
 */

/**
 * La plantilla aprobada de este mensaje, lista para mandar.
 *
 * @param plantillaId  el id en `plantillas_mensaje` del texto que se va a usar
 * @param datos        las variables con nombre ya resueltas
 * @returns  `{ nombre, idioma, parametros }` o `null` si no hay una aprobada
 */
export async function plantillaAprobadaDe(plantillaId, datos = {}) {
  if (!plantillaId) return null

  const { data, error } = await db()
    .from('plantillas_whatsapp')
    .select('nombre_meta, idioma, variables, estado, sid_twilio, purpose_crm')
    .eq('plantilla_id', plantillaId)
    .maybeSingle()

  // Sin la migración corrida esto todavía no existe. No es un fallo del
  // sistema: es que la tabla no está, y entonces no hay plantilla aprobada.
  if (error || !data) return null

  /**
   * Lo que necesita un CRM externo va aparte de lo que necesita Meta.
   *
   * Por Meta hace falta la plantilla APROBADA por ellos y las variables por
   * posición. Por un CRM alcanza con saber cómo se llama el aviso allá —la
   * aprobación la maneja el proveedor— y las variables van por nombre.
   *
   * Se devuelven las dos cosas y decide el driver, así el mismo ISP puede
   * pasarse de una vía a la otra sin volver a configurar nada.
   */
  const paraCrm = data.purpose_crm
    ? { purpose: data.purpose_crm, variables: { ...datos } }
    : null

  if (data.estado !== 'aprobada') {
    return { bloqueada: true, estado: data.estado, nombre: data.nombre_meta, crm: paraCrm }
  }

  /**
   * Los valores en el orden que espera Meta.
   *
   * Si falta uno se devuelve el problema en vez de mandar el hueco. Meta
   * rechazaría igual un parámetro vacío, pero el error suyo dice "parameter
   * count mismatch" y no cuál falta — y eso se descubre a las tres de la mañana
   * con doscientos avisos sin salir.
   */
  const parametros = []
  for (const nombre of data.variables ?? []) {
    const valor = datos[nombre]
    if (valor == null || String(valor).trim() === '') {
      return {
        bloqueada: true,
        estado: 'aprobada',
        nombre: data.nombre_meta,
        falta: nombre,
        crm: paraCrm,
      }
    }
    parametros.push(String(valor))
  }

  return {
    nombre: data.nombre_meta,
    idioma: data.idioma || 'es',
    parametros,
    sid_twilio: data.sid_twilio ?? null,
    crm: paraCrm,
  }
}

// --- La administración desde la pantalla -------------------------------------

export async function listar() {
  const { data, error } = await db()
    .from('v_plantillas_whatsapp')
    .select('*')
    .order('estado')
    .order('nombre_meta')

  if (error) {
    if (/does not exist/i.test(error.message)) {
      throw new AppError(
        'Falta la tabla de plantillas de WhatsApp. Corré supabase/migracion-176-las-plantillas-aprobadas-de-whatsapp.sql',
        { status: 503 },
      )
    }
    throw new AppError(`No se pudieron leer las plantillas: ${error.message}`, { status: 502 })
  }
  return data ?? []
}

const ESTADOS = ['borrador', 'enviada', 'aprobada', 'rechazada', 'pausada']

/**
 * Guarda los cambios de una plantilla.
 *
 * ── Por qué cambiar el cuerpo la devuelve a borrador ──
 *
 * Porque lo que vale es lo que Meta aprobó, no lo que dice nuestra base. Editar
 * el texto acá y dejarla en "aprobada" haría que el sistema mande la plantilla
 * vieja creyendo que manda la nueva — y nadie lo notaría, porque el mensaje
 * sale bien, solo que dice otra cosa.
 *
 * Lo mismo con el orden de las variables: es lo único que conecta `{{saldo}}`
 * con `{{2}}`. Cambiarlo sin volver a registrar pondría el saldo en el lugar de
 * la fecha, y el abonado recibiría "vence el $20.00".
 */
export async function guardar(id, cambios = {}) {
  const { data: previa, error: eLeer } = await db()
    .from('plantillas_whatsapp')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (eLeer) throw new AppError(`No se pudo leer la plantilla: ${eLeer.message}`, { status: 502 })
  if (!previa) throw notFound('No existe esa plantilla de WhatsApp.')

  const fila = { actualizado_en: new Date().toISOString() }

  if ('nombre_meta' in cambios) {
    const n = String(cambios.nombre_meta ?? '').trim().toLowerCase()
    // Meta solo acepta minúsculas, números y guion bajo. Con cualquier otra
    // cosa el registro falla del lado de ellos, con un error que no lo explica.
    if (!/^[a-z0-9_]{1,64}$/.test(n)) {
      throw badRequest('El nombre en Meta va en minúsculas, números y guion bajo, hasta 64 caracteres.')
    }
    fila.nombre_meta = n
  }

  if ('idioma' in cambios) fila.idioma = String(cambios.idioma ?? 'es').trim() || 'es'
  if ('categoria' in cambios) {
    const c = String(cambios.categoria ?? '').toUpperCase()
    if (!['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(c)) {
      throw badRequest(`Categoría desconocida: ${c}`)
    }
    fila.categoria = c
  }

  if ('cuerpo_meta' in cambios) {
    const cuerpo = String(cambios.cuerpo_meta ?? '').trim()
    revisarCuerpo(cuerpo)
    fila.cuerpo_meta = cuerpo
  }

  if ('variables' in cambios) {
    fila.variables = Array.isArray(cambios.variables)
      ? cambios.variables.map((v) => String(v).trim()).filter(Boolean)
      : []
  }
  if ('ejemplos' in cambios) {
    fila.ejemplos = Array.isArray(cambios.ejemplos) ? cambios.ejemplos.map(String) : []
  }
  if ('meta_id' in cambios) fila.meta_id = String(cambios.meta_id ?? '').trim() || null
  if ('sid_twilio' in cambios) fila.sid_twilio = String(cambios.sid_twilio ?? '').trim() || null
  // El nombre del lado del CRM. No hace volver la plantilla a borrador: el
  // borrador es sobre lo que aprobó Meta, y esto no pasa por Meta.
  if ('purpose_crm' in cambios) fila.purpose_crm = String(cambios.purpose_crm ?? '').trim() || null
  if ('notas' in cambios) fila.notas = String(cambios.notas ?? '').trim() || null
  if ('motivo_rechazo' in cambios) {
    fila.motivo_rechazo = String(cambios.motivo_rechazo ?? '').trim() || null
  }

  if ('estado' in cambios) {
    if (!ESTADOS.includes(cambios.estado)) throw badRequest(`Estado desconocido: ${cambios.estado}`)
    fila.estado = cambios.estado
  }

  // El texto o el orden cambiaron: lo aprobado ya no es esto.
  const cambioLoQueMeta_aprobo =
    ('cuerpo_meta' in fila && fila.cuerpo_meta !== previa.cuerpo_meta) ||
    ('variables' in fila && JSON.stringify(fila.variables) !== JSON.stringify(previa.variables)) ||
    ('nombre_meta' in fila && fila.nombre_meta !== previa.nombre_meta) ||
    ('idioma' in fila && fila.idioma !== previa.idioma)

  if (cambioLoQueMeta_aprobo && fila.estado !== 'aprobada') {
    fila.estado = 'borrador'
    fila.motivo_rechazo = null
  }

  const { data, error } = await db()
    .from('plantillas_whatsapp')
    .update(fila)
    .eq('id', id)
    .select()
    .single()

  if (error) throw new AppError(`No se pudo guardar: ${error.message}`, { status: 502 })

  return {
    ...data,
    ...(cambioLoQueMeta_aprobo && data.estado === 'borrador'
      ? {
          aviso:
            'Cambió el texto o el orden de las variables: la plantilla volvió a borrador. Hay que registrarla de nuevo en Meta y marcarla aprobada cuando la aprueben.',
        }
      : {}),
  }
}

/**
 * Las reglas de Meta que rechazan una plantilla, revisadas antes de mandarla.
 *
 * Están acá y no solo en la documentación porque las cuatro se cometen igual:
 * son las que uno no ve al escribir un texto que suena perfecto.
 */
export function revisarCuerpo(cuerpo) {
  const texto = String(cuerpo ?? '').trim()

  if (!texto) throw badRequest('El cuerpo de la plantilla no puede estar vacío.')
  if (texto.length > 1024) {
    throw badRequest('El cuerpo de una plantilla no puede pasar de 1024 caracteres.')
  }

  // 1. No puede empezar ni terminar con una variable.
  if (/^\s*\{\{\s*\d+\s*\}\}/.test(texto)) {
    throw badRequest('Meta no acepta que el mensaje EMPIECE con una variable.', {
      hint: 'Poné una palabra antes. El nombre de la empresa no hace falta: WhatsApp ya lo muestra.',
    })
  }
  if (/\{\{\s*\d+\s*\}\}\s*$/.test(texto)) {
    throw badRequest('Meta no acepta que el mensaje TERMINE con una variable.', {
      hint: 'Cerrá con una frase: un punto y "Gracias" alcanza.',
    })
  }

  // 2. Dos variables pegadas tampoco.
  if (/\}\}\s*\{\{/.test(texto)) {
    throw badRequest('Meta no acepta dos variables seguidas sin texto en el medio.')
  }

  // 3. Las posiciones tienen que ser 1, 2, 3… sin saltos ni repetidas.
  const usadas = [...texto.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]))
  const esperadas = usadas.slice().sort((a, b) => a - b)
  for (let i = 0; i < esperadas.length; i++) {
    if (esperadas[i] !== i + 1) {
      throw badRequest(
        `Las variables tienen que ir {{1}}, {{2}}, {{3}}… sin saltos. Encontré: ${usadas.join(', ')}`,
      )
    }
  }

  return { variables: usadas.length }
}

/**
 * Cuántas variables espera el cuerpo, para avisar si no coinciden con el orden
 * cargado. Un cuerpo con tres `{{n}}` y dos nombres en `variables` manda un
 * parámetro de menos y Meta rechaza el envío entero.
 */
export function verificarCoherencia({ cuerpo_meta, variables }) {
  const { variables: enCuerpo } = revisarCuerpo(cuerpo_meta)
  const cargadas = (variables ?? []).length

  if (enCuerpo !== cargadas) {
    return {
      ok: false,
      motivo: `El texto usa ${enCuerpo} variable(s) y hay ${cargadas} nombre(s) cargados. Tienen que ser la misma cantidad y en el mismo orden.`,
    }
  }
  return { ok: true }
}
