import { supabase } from './supabaseClient'
import { comprimirImagen } from './soporte'

/**
 * La foto con la que el técnico abre su jornada.
 *
 * ── Por qué vive en su propio archivo ──
 *
 * La usan dos pantallas que no se parecen en nada: la del técnico, que la saca
 * en el teléfono, y la de revisión, que la mira desde una computadora. Si la
 * subida viviera en la primera, la segunda tendría que conocer la forma de la
 * ruta para poder pedir la URL — y el día que la ruta cambie, una de las dos
 * se entera y la otra no.
 *
 * ── Por qué subir nunca tira el error hacia afuera ──
 *
 * La jornada se abre con foto o sin ella. El técnico que está en una zona sin
 * cobertura tiene que poder empezar a trabajar igual; si la foto fallara la
 * apertura, empezaría sin registrar nada, que es peor que no tener la foto.
 *
 * Por eso `subirFotoIngreso` devuelve `{ ok, error }` en vez de lanzar: quien
 * llama decide si eso es un aviso al costado o un problema, y en la pantalla
 * del técnico es un aviso.
 */

const BUCKET = 'jornadas'

/**
 * Sube la foto y la deja anotada en la jornada.
 *
 * El nombre lleva la marca de tiempo para que reemplazar una foto movida no
 * pise la anterior en el bucket: la fila apunta a la última, y la anterior
 * queda. Guardar de más acá cuesta unos kilobytes; pisar la única foto de un
 * ingreso que alguien ya miró no se deshace.
 */
export async function subirFotoIngreso(jornadaId, archivo) {
  if (!jornadaId || !archivo) return { ok: false, error: new Error('Falta la jornada o la foto') }

  try {
    const blob = await comprimirImagen(archivo)
    const ruta = `${jornadaId}/ingreso-${Date.now()}.jpg`

    const { error: errSubida } = await supabase.storage
      .from(BUCKET)
      .upload(ruta, blob, { contentType: 'image/jpeg' })
    if (errSubida) throw errSubida

    /**
     * La hora de la foto se guarda aparte de `inicio_at`.
     *
     * No son lo mismo: sin señal la jornada se abre a las 7 y la foto sube a
     * las 9, cuando el técnico pasa por una zona con cobertura. Esa diferencia
     * es un dato —dice dónde estuvo trabajando— y machacarla con una sola hora
     * la borraría.
     */
    const { error: errFila } = await supabase
      .from('jornadas')
      .update({ foto_ingreso: ruta, foto_ingreso_at: new Date().toISOString() })
      .eq('id', jornadaId)
    if (errFila) throw errFila

    return { ok: true, ruta }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * Una URL para mirar la foto, que se vence sola.
 *
 * El bucket es privado: sin esto no hay forma de mostrarla. Cinco minutos es
 * lo que dura mirar una pantalla de ingresos; que se venza es lo que evita que
 * una dirección copiada de la barra siga abriendo la foto de un empleado
 * dentro de seis meses.
 */
export async function urlDeFoto(ruta, segundos = 300) {
  if (!ruta) return null
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(ruta, segundos)
  return data?.signedUrl ?? null
}
