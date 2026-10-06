import { supabase } from './supabaseClient'
import { subirFotoIngreso } from './jornadaFoto'

/**
 * El ingreso en el primer trabajo (migraciones 212 y 213).
 *
 * Las cuadrillas salen de la base, pero las horas cuentan desde el primer
 * cliente. Al iniciar el primer trabajo del día:
 *
 *   · el JEFE DE GRUPO toma la foto grupal en el sitio, medida por GPS contra
 *     la ubicación del cliente, y marca el ingreso de los que están en ella;
 *   · un INTEGRANTE cuyo jefe todavía no la tomó espera, o marca el suyo si
 *     ese día trabaja separado;
 *   · quien trabaja solo se saca su selfie.
 *
 * Con la jornada cerrada no se inicia nada: para eso está la salida de
 * emergencia.
 *
 * Si no se puede preguntar —sin señal, o sin la 213— deja seguir: la llegada
 * entra a la cola, la base marca el ingreso con la hora en que se marcó, y la
 * foto se pide después desde el inicio ("Falta tu foto de ingreso").
 */
export const MENSAJE_JORNADA_CERRADA =
  'Tu jornada de hoy ya está cerrada. Si es una emergencia, marcá una salida de emergencia en Mi jornada.'

/** Abre la cámara y devuelve la foto, o `null` si se canceló. */
export function sacarFoto(camara = 'user') {
  return new Promise((resolver) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.capture = camara
    input.addEventListener('change', () => resolver(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => resolver(null))
    input.click()
  })
}

async function selfie(confirmar) {
  const seguir = await confirmar({
    mensaje:
      'Es tu primer trabajo del día: al iniciarlo se marca tu ingreso, y tus horas cuentan desde ahora.\n\n' +
      'Sacate la foto de ingreso.',
    etiquetaAccion: 'Sacar la foto',
    variante: 'primario',
  })
  const foto = seguir ? await sacarFoto('user') : null
  if (!foto) throw new Error('Para iniciar tu primer trabajo del día hace falta la foto de ingreso.')
  return foto
}

/**
 * Antes de iniciar un trabajo. Devuelve la selfie si este trabajo marca el
 * ingreso individual, `null` si no hace falta nada más (ya en servicio, o la
 * foto grupal ya lo marcó), y lanza si no puede iniciarlo.
 *
 * `sitio` = { tipo: 'ticket' | 'instalacion' | 'reparacion', id, lat, lng }.
 */
export async function prepararIngreso({ confirmar, pedirGrupal, sitio }) {
  const { data, error } = await supabase.rpc('mi_ingreso_de_hoy')
  if (error || !data || data.estado === 'en_servicio') return null
  if (data.estado === 'jornada_cerrada') throw new Error(MENSAJE_JORNADA_CERRADA)

  if (data.modo === 'grupal' && pedirGrupal) {
    const hecho = await pedirGrupal({ ...data, sitio })
    if (!hecho) throw new Error('Para iniciar el primer trabajo del día, tomá la foto grupal en el sitio.')
    return null
  }

  if (data.modo === 'espera_grupal') {
    const separado = await confirmar({
      mensaje:
        `${data.jefe ?? 'Tu jefe de grupo'} marca el ingreso de la cuadrilla con la foto grupal en el sitio.\n\n` +
        'Si hoy trabajás separado de la cuadrilla, sacate tu foto de ingreso.',
      etiquetaAccion: 'Trabajo separado: mi foto',
      etiquetaCancelar: 'Esperar la foto grupal',
      variante: 'primario',
    })
    if (!separado) throw new Error(`Esperá a que ${data.jefe ?? 'tu jefe de grupo'} tome la foto grupal.`)
    const foto = await sacarFoto('user')
    if (!foto) throw new Error('Para iniciar tu primer trabajo del día hace falta la foto de ingreso.')
    return foto
  }

  return selfie(confirmar)
}

/**
 * Después de iniciar el trabajo: sube la selfie a la jornada que la base
 * acaba de abrir. Si la llegada quedó en cola, la jornada todavía no existe y
 * la foto se pide de nuevo desde el inicio cuando haya señal.
 */
export async function completarIngreso(foto) {
  if (!foto) return
  const { data: id } = await supabase.rpc('mi_jornada_de_hoy')
  if (id) await subirFotoIngreso(id, foto)
}
