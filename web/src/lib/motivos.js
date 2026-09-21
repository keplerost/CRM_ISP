/**
 * Los motivos que se repiten, escritos una vez.
 *
 * ── Por qué existen ──
 *
 * Todas estas acciones piden un motivo, y el motivo no es burocracia: es lo que
 * el abonado va a preguntar y lo que el que atiende el mes que viene va a leer
 * para entender qué pasó.
 *
 * Escrito a mano sale distinto cada vez —"repetido", "ya estaba", "duplicado",
 * "duplicad"— y entonces la lista de anulados o rechazados no se puede agrupar
 * ni leer de un vistazo. Con el texto fijo, el sistema y la persona que atiende
 * dicen lo mismo.
 *
 * Son sugerencias, no un menú cerrado: en todos lados se puede escribir uno
 * propio. El caso raro existe y encerrarlo en una lista lo haría salir peor.
 */

/** Anular un cobro ya registrado. Se usa en Pagos, Transacciones y Buscar pagos. */
export const MOTIVOS_ANULACION = [
  'Se cargó dos veces el mismo pago',
  'El monto está mal cargado',
  'La transferencia no entró, el comprobante era falso',
  'Se cargó al abonado equivocado',
  'El cheque salió sin fondos',
]

/** Rechazar un pago que reportó un sistema externo. */
export const MOTIVOS_RECHAZO_PAGO = [
  'Comprobante repetido, ese pago ya estaba registrado',
  'No aparece en el extracto de la cuenta',
  'El comprobante es de otro mes',
  'El monto no coincide con el comprobante',
  'La transferencia entró a una cuenta que no es nuestra',
]

/** Revocar una llave de API. */
export const MOTIVOS_REVOCACION = [
  'Era una llave de prueba',
  'Se terminó el contrato con ese proveedor',
  'La llave se filtró o se compartió por un canal inseguro',
  'Se emitió una llave nueva que la reemplaza',
  'Estaba haciendo llamadas que no corresponden',
]

/** Cancelar una incidencia masiva antes de que salgan los avisos. */
export const MOTIVOS_CANCELAR_INCIDENCIA = [
  'Se cargó por error',
  'El alcance estaba mal, afecta a otro sector',
  'Se resolvió antes de avisar',
  'El mantenimiento se reprogramó',
]
