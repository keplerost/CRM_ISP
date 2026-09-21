/**
 * El formato del dinero, en un solo lugar.
 *
 * Estaba repetido en una docena de archivos, cada uno con su `$` escrito a
 * mano. Mientras el sistema fuera de un solo ISP en Ecuador eso no molestaba;
 * ahora se vende, y un ISP de otro país no puede necesitar que le editen doce
 * archivos para que diga S/ en vez de $.
 *
 * No es un hook ni un contexto a propósito. La moneda no cambia mientras
 * alguien usa el sistema: se lee una vez al arrancar y listo. Un contexto
 * obligaría a convertir en componente cada función que hoy formatea un monto,
 * a cambio de nada.
 */

let simbolo = '$'

/** Se llama una vez al arrancar, con lo que diga la configuración. */
export function configurarMoneda(nuevoSimbolo) {
  if (nuevoSimbolo) simbolo = nuevoSimbolo
}

export const simboloMoneda = () => simbolo

/**
 * Un monto listo para mostrar.
 *
 * `null` y `undefined` dan `—`, no `$0.00`. No es lo mismo "no debe nada" que
 * "no sabemos cuánto debe", y mostrar cero cuando falta el dato hace que nadie
 * lo busque.
 */
export const dinero = (n) => (n == null ? '—' : `${simbolo}${(Number(n) || 0).toFixed(2)}`)

/** Igual, pero el vacío es cero de verdad: para totales y sumas. */
export const dineroCero = (n) => `${simbolo}${(Number(n) || 0).toFixed(2)}`
