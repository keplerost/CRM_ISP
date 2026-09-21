/**
 * Los frenos de las APIs que consumen sistemas externos.
 *
 * ── Qué son y qué no son ──
 *
 * No son una defensa contra un ataque: para eso está el firewall del servidor.
 * Son el freno al BUCLE — el bot que entra en un ciclo de reintentos y consulta
 * la misma cédula cuatro mil veces mientras un abonado espera respuesta.
 *
 * Viven en memoria porque un contador por minuto que sobrevive a un reinicio no
 * vale lo que cuesta guardarlo: si el proceso se cae, el bucle también se cortó.
 *
 * Están acá y no adentro de un router porque hay dos superficies —`/api/v1` y
 * `/api/integracion`— y una llave que gasta su cupo en una tiene que gastarlo
 * en la otra: es la misma llave y el mismo bot.
 */

const ventanas = new Map()

/**
 * Arma un freno con su propio cupo y su propio contador.
 *
 * @param nombre    identifica al grupo. Dos frenos distintos no comparten cupo.
 * @param porMinuto cuántos pedidos se admiten por minuto y por llave.
 * @param sugerencia qué decirle a quien se pasó, además de esperar.
 */
export function freno(nombre, porMinuto, sugerencia = null) {
  return function frenar(req, res, next) {
    const ahora = Date.now()
    const clave = `${nombre}:${req.llave?.id ?? 'sin-llave'}`
    const v = ventanas.get(clave)

    if (!v || ahora - v.desde > 60_000) {
      ventanas.set(clave, { desde: ahora, cuenta: 1 })
      return next()
    }

    v.cuenta += 1
    if (v.cuenta > porMinuto) {
      const faltan = Math.ceil((60_000 - (ahora - v.desde)) / 1000)
      res.set('Retry-After', String(faltan))
      // El 429 se arma acá y no se lanza como error para que llegue con el
      // `Retry-After` puesto: un límite que no dice cuánto esperar hace que el
      // cliente reintente enseguida y se quede afuera de nuevo.
      return res.status(429).json({
        status: 'error',
        code: 'LIMITE_EXCEDIDO',
        message: `Se superó el límite de ${porMinuto} pedidos por minuto. Reintentá en ${faltan} segundos.`,
        ...(sugerencia ? { hint: sugerencia } : {}),
      })
    }
    next()
  }
}

/**
 * Se limpian las ventanas viejas cada tanto.
 *
 * Sin esto el Map crece con cada llave que llamó alguna vez. Son pocas, pero un
 * proceso que corre meses no puede tener estructuras que solo crecen.
 * `unref()` para que este temporizador no mantenga vivo al proceso al apagarlo.
 */
setInterval(() => {
  const corte = Date.now() - 120_000
  for (const [k, v] of ventanas) if (v.desde < corte) ventanas.delete(k)
}, 300_000).unref()

/** Para las pruebas: vaciar los contadores entre casos. */
export const _reiniciar = () => ventanas.clear()
