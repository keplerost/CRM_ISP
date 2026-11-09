/**
 * Los plazos de atención, del lado del navegador (migración 219).
 *
 * Sin imports a propósito, como `alertas.js`: se prueba con el runner del
 * middleware, sin navegador y sin base.
 *
 * ── Por qué el vencimiento se calcula también acá ──
 *
 * La app del técnico ya tiene el ticket y la orden cargados, con su tipo y su
 * fecha de registro. Pedirle a la base el vencimiento de cada uno sería otra
 * consulta por trabajo en una conexión de celular, y la cuenta es la misma que
 * hace `v_plazos_trabajo`: registrado + horas del plazo de su tipo.
 */

/**
 * Por qué se llegó fuera de plazo.
 *
 * `de` dice a quién corresponde. Es lo que permite leer el tablero: si la
 * mayoría de los atrasos son "me lo asignaron tarde", lo que hay que corregir
 * es el reparto de la oficina, no al técnico.
 */
export const MOTIVOS_DEMORA = [
  { valor: 'asignado_tarde', label: 'Me asignaron el trabajo tarde', corto: 'asignado tarde', de: 'oficina' },
  { valor: 'cliente', label: 'El cliente no estaba o pidió otra hora', corto: 'por el cliente', de: 'cliente' },
  { valor: 'trabajo_anterior', label: 'El trabajo anterior se alargó', corto: 'trabajo anterior', de: 'tecnico' },
  { valor: 'material', label: 'Faltó material o equipo', corto: 'material', de: 'bodega' },
  { valor: 'vehiculo', label: 'Problema con el vehículo o la moto', corto: 'vehículo', de: 'logistica' },
  { valor: 'clima', label: 'Lluvia o camino cerrado', corto: 'clima o camino', de: 'externo' },
  { valor: 'otro', label: 'Otro (escribí cuál)', corto: 'otro', de: 'otro' },
]

export const etiquetaMotivo = (v) => MOTIVOS_DEMORA.find((m) => m.valor === v)?.label ?? v ?? '—'

/**
 * "3 fuera: 2 asignado tarde · 1 sin justificar".
 *
 * Para el tablero, debajo del porcentaje en plazo: el número solo no dice si el
 * atraso fue del técnico o de la oficina, y es lo primero que se pregunta.
 *
 * @param fila  una fila de `v_plazos_tecnico`
 */
export function desgloseFuera(fila) {
  const fuera = Number(fila?.fuera_plazo ?? 0)
  if (!fuera) return null
  const partes = Object.entries(fila.motivos ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([v, n]) => `${n} ${MOTIVOS_DEMORA.find((m) => m.valor === v)?.corto ?? v}`)
  if (Number(fila.sin_justificar)) partes.push(`${fila.sin_justificar} sin justificar`)
  if (Number(fila.esperando)) partes.push(`${fila.esperando} todavía esperando`)
  return `${fuera} fuera: ${partes.join(' · ')}`
}

/** El tipo de plazo de una instalación, igual que en `v_plazos_trabajo`. */
export function tipoDeInstalacion(tipo) {
  if (tipo === 'nueva' || tipo == null) return 'instalacion'
  if (tipo === 'traslado' || tipo === 'retiro') return tipo
  return 'otro'
}

/**
 * Las horas del plazo de un tipo. Un tipo que no está en la tabla usa el de
 * 'otro', y si tampoco está, un día: nunca queda sin plazo.
 */
export function horasDePlazo(tipo, plazos = []) {
  const de = (clave) => plazos.find((p) => p.clave === clave)?.horas
  return Number(de(tipo) ?? de('otro') ?? 24)
}

/**
 * Cuándo vence un trabajo.
 *
 * @param trabajo  un ticket (con `tipo_incidencia`) o una orden de instalación
 *                 (con `tipo`); los dos con `created_at`
 * @param clase    'ticket' | 'instalacion'
 * @returns Date o null si no se sabe cuándo se registró
 */
export function venceEl(trabajo, plazos = [], clase = 'ticket') {
  if (!trabajo?.created_at) return null
  const tipo =
    clase === 'instalacion' ? tipoDeInstalacion(trabajo.tipo) : (trabajo.tipo_incidencia ?? 'otro')
  return new Date(new Date(trabajo.created_at).getTime() + horasDePlazo(tipo, plazos) * 3600000)
}

/**
 * Cómo está el plazo ahora.
 *
 *   'ok'       hay tiempo
 *   'cerca'    falta una hora o menos
 *   'vencido'  ya pasó
 */
export function estadoPlazo(vence, ahora = new Date()) {
  if (!vence) return null
  const min = Math.round((new Date(vence) - ahora) / 60000)
  return { min, nivel: min <= 0 ? 'vencido' : min <= 60 ? 'cerca' : 'ok' }
}

/**
 * ¿Esta llegada necesita justificación?
 *
 * Solo si se llega DESPUÉS del vencimiento. Si no se sabe el vencimiento —no
 * cargaron los plazos, falta la fecha— no se pide nada: frenar al técnico en la
 * puerta por un dato que falta en la oficina sería castigarlo por algo ajeno.
 */
export function pideJustificacion(vence, llegada = new Date()) {
  return Boolean(vence) && new Date(llegada) > new Date(vence)
}
