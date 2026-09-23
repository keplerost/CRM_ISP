/**
 * Los servicios de una misma persona.
 *
 * Una cédula puede tener más de un abonado: la casa y el local, o la casa y la
 * de la madre. Hasta la migración 192 la base lo impedía y el segundo servicio
 * se cargaba con el nombre deformado y sin cédula, lo que rompía la factura, el
 * contrato y el portal.
 *
 * Ahora conviven, y eso obliga a contestar una pregunta que antes no existía:
 * cuando alguien entra al portal con una cédula que tiene dos servicios, ¿sobre
 * cuál se abre la sesión?
 */

/** ¿Por dónde se le puede mandar un código a este abonado? */
export const tieneContacto = (c) =>
  Boolean(c?.telefono_movil || c?.telefono || c?.email || c?.telegram_chat_id)

/**
 * Sobre cuál de los servicios se abre la sesión.
 *
 * El orden de preferencia no es arbitrario:
 *
 *   1. El que YA tiene contraseña del portal. Si la persona puso una, es la
 *      ficha que viene usando; abrirle otra sería desconcertante.
 *   2. El que tiene por dónde recibir el código. Elegir uno sin teléfono ni
 *      correo deja a la persona sin poder entrar aunque su otra ficha sí tenga
 *      celular cargado — y el mensaje que vería sería "no se pudo enviar",
 *      que no dice nada sobre la causa.
 *   3. El más antiguo. Desempata de forma estable: sin un criterio fijo, dos
 *      llamadas seguidas podrían elegir fichas distintas y el código quedaría
 *      atado a una mientras se valida contra la otra.
 *
 * Los tres criterios se aplican en orden, y dentro de cada uno manda el más
 * antiguo. Nunca devuelve algo distinto para la misma entrada.
 */
export function principalDe(servicios) {
  const lista = (servicios ?? []).filter(Boolean)
  if (!lista.length) return null

  const porAntiguedad = [...lista].sort((a, b) => {
    const fa = a.created_at ?? ''
    const fb = b.created_at ?? ''
    if (fa !== fb) return fa < fb ? -1 : 1
    // Sin fecha —o con la misma— desempata el id, que siempre está.
    return String(a.id ?? '') < String(b.id ?? '') ? -1 : 1
  })

  return (
    porAntiguedad.find((c) => c.portal_clave_hash) ??
    porAntiguedad.find(tieneContacto) ??
    porAntiguedad[0]
  )
}

/**
 * Lo que el portal necesita saber de cada servicio para poder ofrecerlos.
 *
 * Va deliberadamente corto: el selector de servicio se dibuja antes de que la
 * persona elija, así que no puede llevar nada que no deba ver quien todavía
 * está eligiendo. Nada de saldos, contraseñas ni datos de otro.
 */
export const resumirServicios = (servicios, actualId) =>
  (servicios ?? []).map((c) => ({
    id: c.id,
    nombre: c.nombre ?? '',
    referencia: c.referencia_servicio ?? null,
    direccion: c.direccion ?? null,
    actual: c.id === actualId,
  }))

/**
 * ¿Puede esta sesión pasarse a ese otro servicio?
 *
 * La regla: solo entre servicios de la MISMA identificación, y solo si la
 * identificación existe. Quien entró ya demostró ser dueño de esa cédula —por
 * el código o por la contraseña— así que moverse entre los servicios de esa
 * misma cédula no necesita volver a probar nada.
 *
 * La condición de que no esté vacía no es un detalle: sin ella, dos fichas
 * cargadas sin cédula quedarían "emparejadas" por su vacío, y cualquiera de las
 * dos podría abrir la otra. Es exactamente el agujero que hay que no dejar.
 */
export function puedeCambiarA(actual, destino) {
  if (!actual || !destino) return false
  if (destino.estado === 'baja') return false

  const a = String(actual.identificacion ?? '').trim()
  const b = String(destino.identificacion ?? '').trim()

  return a !== '' && a === b
}
