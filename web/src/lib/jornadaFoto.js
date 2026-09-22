import { supabase } from './supabaseClient'
import { comprimirImagen, distanciaEnMetros, ubicacionActual } from './soporte'

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

/**
 * Dónde marcó el técnico, y a qué distancia de su primer trabajo.
 *
 * ── Por qué el primer trabajo se busca acá y no se recibe ──
 *
 * Porque la pantalla que abre la jornada no carga la agenda: pedirle que lo
 * haga para poder pasarlo la obligaría a saber cómo se ordena el día, que es
 * conocimiento de otro módulo. Acá se pide lo justo —las órdenes de hoy con
 * coordenada, la primera por hora— y se devuelve el número.
 *
 * ── Qué significa cada NULL ──
 *
 * Todos significan "no se pudo saber", nunca "estaba lejos":
 *
 *   · sin GPS            el teléfono no respondió o el permiso está negado
 *   · sin primer trabajo no hay órdenes agendadas para hoy
 *   · sin coordenada     la orden existe pero nadie le cargó la ubicación
 *
 * Distinguirlos importa al revisar: una jornada sin distancia porque el abonado
 * no tiene coordenada cargada es un problema de datos, no del técnico.
 */
export async function ubicacionDelIngreso(tecnicoId, hoy) {
  const donde = await ubicacionActual()
  if (!donde) return { lat: null, lng: null, precision: null, primerTrabajoId: null, distancia: null }

  const base = {
    lat: donde.lat,
    lng: donde.lng,
    precision: donde.precision != null ? Math.round(donde.precision) : null,
    primerTrabajoId: null,
    distancia: null,
  }

  if (!tecnicoId || !hoy) return base

  /**
   * La PRIMERA por hora, y solo entre las que tienen coordenada.
   *
   * Si la de las 8:00 no tiene ubicación cargada y la de las 10:00 sí, se
   * compara contra la de las 10:00 — y por eso se guarda cuál fue. Comparar
   * contra una orden sin coordenada no da un cero: no da nada.
   */
  const { data } = await supabase
    .from('v_instalaciones')
    .select('id, latitud, longitud, hora')
    .eq('tecnico_id', tecnicoId)
    .eq('fecha', hoy)
    .not('latitud', 'is', null)
    .not('longitud', 'is', null)
    .order('hora', { nullsFirst: false })
    .limit(1)

  const primera = data?.[0]
  if (!primera) return base

  return {
    ...base,
    primerTrabajoId: primera.id,
    distancia: distanciaEnMetros(
      { lat: donde.lat, lng: donde.lng },
      { lat: primera.latitud, lng: primera.longitud },
    ),
  }
}
