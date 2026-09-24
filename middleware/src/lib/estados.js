/**
 * Los estados de un abonado, y cuál de ellos significa "sin servicio".
 *
 * ── Por qué hay dos ──
 *
 * `cortado` es el que se quedó sin internet por deuda: su IP está en la lista
 * de corte del router. `suspendido` es el que lo perdió por otra razón —lo pidió
 * él, se pausó por una obra— y llega de una importación, cuando el sistema lee
 * un secret deshabilitado en el equipo.
 *
 * La distinción sirve para saber POR QUÉ se fue, que no es lo mismo a la hora de
 * decidir si reclamarle o llamarlo. Pero para la red los dos son lo mismo: nadie
 * de los dos tiene que estar navegando.
 *
 * ── El agujero que esto cierra ──
 *
 * El corte y la reparación miraban solo `cortado`. Para ellos `suspendido` era
 * "está al día", así que a un abonado suspendido cuya IP estuviera en la lista
 * lo DESBLOQUEABAN: le devolvían el internet entendiendo que no debía nada.
 *
 * No se veía en el piloto porque ninguna pantalla produce `suspendido` —el botón
 * "Suspender servicio" deja al abonado en `cortado`—, pero aparece en cuanto se
 * importa un sector donde haya secrets deshabilitados.
 */

/** Los que no tienen que estar navegando. */
export const SIN_SERVICIO = ['cortado', 'suspendido']

/** ¿A este abonado le corresponde estar bloqueado en el router? */
export const sinServicio = (estado) =>
  SIN_SERVICIO.includes(String(estado ?? '').trim().toLowerCase())

/**
 * `baja` no está en la lista, y es a propósito.
 *
 * Un retirado no es un abonado bloqueado: es alguien que ya no está. Su IP
 * vuelve al pozo y puede ser de otro mañana, así que dejarlo en la lista de
 * corte le cortaría el servicio al que venga después.
 */
export const esBaja = (estado) => String(estado ?? '').trim().toLowerCase() === 'baja'
