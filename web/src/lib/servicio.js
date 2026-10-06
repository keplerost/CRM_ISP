import { supabase } from './supabaseClient'

/**
 * ¿El técnico puede iniciar un trabajo ahora? (migración 210)
 *
 * Tiene que estar EN SERVICIO: jornada abierta o salida de emergencia abierta.
 * La base lo exige igual; esto lo pregunta ANTES, para no hacerle tomar el GPS
 * ni abrirle el mapa a quien después va a recibir un rechazo.
 *
 * Si no se puede preguntar —sin señal, o la 210 sin correr— deja seguir: lo
 * marcado sin señal entra a la cola, y la base lo juzga con la hora en que se
 * marcó cuando sincronice.
 */
export const MENSAJE_SIN_INGRESO =
  'Primero marcá tu ingreso en Mi jornada. Si tu jornada ya terminó y es una emergencia, marcá una salida de emergencia.'

export async function exigirEnServicio() {
  const { data, error } = await supabase.rpc('estoy_en_servicio')
  if (!error && data === false) throw new Error(MENSAJE_SIN_INGRESO)
}
