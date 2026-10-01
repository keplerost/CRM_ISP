import { db } from './db.js'

/**
 * La hora del lugar donde está el ISP, no la de la máquina.
 *
 * ── Por qué existe ──
 *
 * Todas las tareas programadas comparan contra la hora local del proceso:
 * `ahora.getHours() >= 1` y listo. En la PC de desarrollo eso es la hora de
 * Ecuador. En un VPS es UTC, que va cinco horas adelante. La facturación de la
 * 01:00 corrió a las 20:00 del día anterior, la franja de avisos quedó corrida
 * hacia la madrugada, y la fecha de las facturas salió con el día siguiente.
 *
 * Arreglarlo en cada `getHours()` habría significado tocar una docena de
 * archivos y acordarse para siempre en los que vengan. En cambio se fija
 * `process.env.TZ`: Node lo relee en el acto, y todo `Date` del proceso pasa a
 * hablar en la hora del ISP, sin tocar una sola línea de las tareas.
 *
 * ── De dónde sale ──
 *
 * 1. Lo guardado en Ajustes → Sistema (`config_general.zona_horaria`).
 * 2. Si no hay nada guardado, la variable TZ del entorno, si alguien la puso.
 * 3. Si tampoco, America/Guayaquil: es para donde se hizo el sistema, y caer a
 *    UTC es justamente el error que esto vino a corregir.
 */

export const ZONA_POR_DEFECTO = 'America/Guayaquil'

/** La TZ con la que arrancó el proceso, antes de que la toquemos. */
const TZ_DEL_ENTORNO = process.env.TZ || null

/** ¿Node la reconoce? Una zona mal escrita no da error: da UTC en silencio. */
export function esZonaValida(zona) {
  if (!zona || typeof zona !== 'string') return false
  try {
    new Intl.DateTimeFormat('es', { timeZone: zona })
    return true
  } catch {
    return false
  }
}

/** Fija la zona del proceso. Devuelve la que quedó aplicada. */
export function aplicarZona(zona) {
  const elegida = esZonaValida(zona)
    ? zona
    : esZonaValida(TZ_DEL_ENTORNO)
      ? TZ_DEL_ENTORNO
      : ZONA_POR_DEFECTO
  process.env.TZ = elegida
  return elegida
}

// Apenas se importa: entre el arranque y la lectura de la base no puede haber
// un rato en que el proceso hable en UTC.
aplicarZona(null)

/**
 * Lee la zona guardada y la aplica.
 *
 * Que falte la columna —la migración 196 sin correr— no puede impedir que
 * arranque el sistema: se queda con la del entorno o la de Ecuador.
 */
export async function cargarZona() {
  const { data, error } = await db()
    .from('config_general')
    .select('zona_horaria')
    .eq('id', 1)
    .maybeSingle()
  if (error) {
    console.warn(`[zona horaria] no se pudo leer la guardada (${error.message}); se usa ${process.env.TZ}.`)
    return process.env.TZ
  }
  return aplicarZona(data?.zona_horaria ?? null)
}

/** "−05:00": cuánto se separa la zona de UTC en este momento. */
export function desfase(zona, ahora = new Date()) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona,
    timeZoneName: 'longOffset',
  }).formatToParts(ahora)
  const valor = partes.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  // "GMT" a secas es UTC; si no, viene "GMT-05:00".
  return valor === 'GMT' ? '+00:00' : valor.replace('GMT', '')
}

/**
 * Lo que muestra la pantalla: qué hora cree el servidor que es.
 *
 * Se manda la hora ya escrita y no solo el instante, porque comparar con el
 * reloj del navegador es justamente la pregunta: si el texto no coincide con
 * el reloj de la pared, algo está mal.
 */
export function relojDelServidor(ahora = new Date()) {
  const zona = process.env.TZ
  return {
    zona,
    desfase: desfase(zona, ahora),
    hora_local: new Intl.DateTimeFormat('es-EC', {
      timeZone: zona,
      dateStyle: 'full',
      timeStyle: 'medium',
      // 20:00 y no "8:00 p. m.": es como están escritas las horas de las tareas.
      hourCycle: 'h23',
    }).format(ahora),
    utc: ahora.toISOString(),
    zona_del_entorno: TZ_DEL_ENTORNO,
  }
}
