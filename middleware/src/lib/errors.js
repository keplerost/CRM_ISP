/**
 * Error con status HTTP y una pista de qué hacer.
 * El objetivo es que la UI muestre algo accionable en vez de "Error 500".
 */
export class AppError extends Error {
  constructor(message, { status = 500, hint, detalle, codigo, ...extra } = {}) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.hint = hint
    this.detalle = detalle

    /**
     * El código estable del error, para quien consume la API desde afuera.
     *
     * La app propia lee `message`, que está escrito para una persona y puede
     * mejorarse cuando alguien lo lea y no se entienda. Un programa de otra
     * empresa no puede depender de eso: si ramifica por el texto, el día que se
     * corrija una palabra deja de funcionar sin que nadie lo toque.
     *
     * Va como campo propio y no dentro de `extra` porque el manejador de
     * `/api/v1` lo necesita para armar su respuesta, y buscarlo en dos lugares
     * distintos es cómo se pierde.
     */
    this.codigo = codigo

    // Todo lo demás viaja con el error hasta la pantalla.
    //
    // Hasta acá se descartaba en silencio, y eso hacía falsos varios mensajes
    // que ya estaban escritos. El peor: al fallar la mudanza de una ONT a otro
    // puerto, el error decía "la foto de la configuración original está en la
    // respuesta" — y no estaba. Justo cuando el abonado había quedado sin
    // servicio y esa foto era lo único con lo que rehacerlo a mano.
    this.extra = Object.keys(extra).length ? extra : undefined
  }
}

export const badRequest = (msg, opts) => new AppError(msg, { ...opts, status: 400 })
export const notFound = (msg, opts) => new AppError(msg, { ...opts, status: 404 })

/** Envuelve un handler async para que los rejects lleguen al error handler de Express. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)
