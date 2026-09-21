/**
 * Abrir un PDF que viene del middleware.
 *
 * ── Por qué no alcanza con un enlace ──
 *
 * Porque esas rutas exigen el token de la sesión en la cabecera, y un `<a href>`
 * no lo manda: se abriría una pestaña con un 401. Hay que traerlo como blob y
 * abrirlo desde la memoria del navegador.
 *
 * La URL temporal se libera al minuto. Sin eso, cada acta que alguien mira deja
 * su archivo retenido hasta que cierre la pestaña.
 */
export async function abrirPdf(traer, nombre = 'documento.pdf') {
  const blob = await traer()
  const url = URL.createObjectURL(blob)

  const pestana = window.open(url, '_blank', 'noopener')

  /**
   * Si el navegador bloqueó la pestaña, se baja el archivo.
   *
   * ── Por qué hace falta ──
   *
   * `window.open` después de un `await` cae fuera del gesto del usuario que
   * apretó el botón, y ahí el navegador lo bloquea. Lo peor es que lo bloquea
   * EN SILENCIO: devuelve `null`, no lanza nada. Desde afuera se ve como que el
   * sistema no hizo nada — el contrato se generó, el PDF viajó entero, y en la
   * pantalla no pasó nada.
   *
   * Es el mismo caso que ya estaba resuelto en `imprimirPdf` con un marco
   * escondido, pero acá no sirve: se quiere VER el documento, no imprimirlo.
   *
   * La descarga sí está permitida aunque el emergente esté bloqueado, porque no
   * abre ventana. El archivo termina en Descargas en vez de en una pestaña, que
   * es peor de leer pero infinitamente mejor que nada.
   *
   * No se intenta abrir la pestaña ANTES del `await` —que también funcionaría—
   * porque varios de los cuarenta y pico de llamadores ya vienen de un `await`
   * previo (recargar la orden, pedir el plan) y para cuando llegan acá el gesto
   * ya se perdió igual. Esto los cubre a todos sin tocar ninguno.
   */
  if (!pestana) {
    const a = document.createElement('a')
    a.href = url
    a.download = nombre
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  setTimeout(() => URL.revokeObjectURL(url), 60_000)

  // Para que quien llama pueda avisar "se descargó" en vez de "se abrió".
  return { abrioPestana: Boolean(pestana) }
}

/**
 * Bajar un archivo que viene del middleware.
 *
 * Igual que `abrirPdf` pero forzando la descarga, para lo que el navegador no
 * sabe mostrar: un Excel abierto en una pestaña es una pantalla de caracteres
 * binarios, y quien lo ve cree que el archivo salió roto.
 */
export async function descargar(traer, nombre) {
  const blob = await traer()
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = nombre
  document.body.appendChild(a)
  a.click()
  a.remove()

  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * Mandar un PDF directo a la impresora.
 *
 * ── Por qué no alcanza con `abrirPdf` ──
 *
 * Porque `window.open` después de un `await` lo bloquea el navegador: la llamada
 * ya no está dentro del gesto del usuario que apretó el botón. Y lo bloquea EN
 * SILENCIO —devuelve `null`, no lanza— así que ni el mensaje de error aparece.
 * Desde afuera se ve como que el sistema no hizo nada.
 *
 * Ese era el caso del recibo automático: el cobro se registraba, el PDF se
 * generaba, y en la pantalla no pasaba nada.
 *
 * Con un marco escondido no hay ventana que bloquear, y además cae directo en el
 * diálogo de impresión — que es lo que se quiere cuando hay que entregarle el
 * papel al cliente que está esperando.
 */
export async function imprimirPdf(traer) {
  const blob = await traer()
  const url = URL.createObjectURL(blob)

  const marco = document.createElement('iframe')
  marco.setAttribute('aria-hidden', 'true')
  Object.assign(marco.style, {
    position: 'fixed',
    right: '0',
    bottom: '0',
    width: '0',
    height: '0',
    border: '0',
    visibility: 'hidden',
  })

  const listo = new Promise((resolver) => {
    marco.onload = () => {
      try {
        marco.contentWindow.focus()
        marco.contentWindow.print()
        resolver(true)
      } catch {
        /**
         * Algún navegador no deja imprimir desde un marco con un blob. Ahí se
         * abre en una pestaña: sigue siendo mejor que no mostrar nada, y quien
         * está cobrando imprime con Ctrl+P.
         */
        window.open(url, '_blank', 'noopener')
        resolver(false)
      }
    }
    marco.onerror = () => resolver(false)
  })

  marco.src = url
  document.body.appendChild(marco)
  await listo

  /**
   * La limpieza va tarde a propósito.
   *
   * Quitar el marco mientras el diálogo de impresión sigue abierto cancela la
   * impresión, y el usuario ve el diálogo cerrarse solo sin haber tocado nada.
   */
  setTimeout(() => {
    marco.remove()
    URL.revokeObjectURL(url)
  }, 120_000)
}
