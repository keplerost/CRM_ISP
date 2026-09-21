/**
 * Lo último que se pudo leer, guardado para cuando no hay señal.
 *
 * ── Por qué hace falta ──
 *
 * La cola resuelve la mitad del trabajo sin conexión: lo que el técnico
 * ESCRIBE. La otra mitad es lo que necesita LEER —su ruta, sus órdenes, los
 * datos del cliente— y eso venía de una consulta que sin señal falla.
 *
 * El resultado era una app que abría perfecto y mostraba tarjetas vacías. Peor
 * que no abrir: parece rota.
 *
 * ── La regla que no se negocia ──
 *
 * Un dato guardado NUNCA se muestra como si fuera de ahora. Siempre viaja con
 * la hora en que se leyó, y la pantalla la dice.
 *
 * Es el mismo criterio que la cola: ahí se dice "preparado" y no "enviado";
 * acá se dice "datos de las 14:32" y no simplemente los datos. Un técnico
 * mirando la ruta de ayer creyendo que es la de hoy maneja hasta la casa
 * equivocada.
 *
 * ── Por qué localStorage y no IndexedDB ──
 *
 * IndexedDB es para la cola, que guarda cosas que no se pueden perder. Esto es
 * distinto: si se pierde, se vuelve a pedir. localStorage es síncrono, así que
 * la pantalla puede dibujarse con lo guardado en el primer cuadro, sin el
 * parpadeo de esperar una promesa.
 */

const PREFIJO = 'campo-cache:'

/** Guarda el resultado de una lectura, con la hora. */
export function guardarCache(clave, datos) {
  try {
    localStorage.setItem(
      PREFIJO + clave,
      JSON.stringify({ en: Date.now(), datos }),
    )
  } catch {
    // Sin espacio o en modo privado. No es motivo para romper nada: se sigue
    // sin caché, que es como estaba antes.
  }
}

/**
 * Lo guardado, o null.
 *
 * Devuelve `{ datos, en, minutos }`. Quien llama tiene que mostrar la hora —
 * por eso viene junta y no aparte: separarlas invita a usar los datos y
 * olvidarse de decir de cuándo son.
 */
export function leerCache(clave) {
  try {
    const crudo = localStorage.getItem(PREFIJO + clave)
    if (!crudo) return null
    const { en, datos } = JSON.parse(crudo)
    if (!en || datos == null) return null
    return { datos, en, minutos: Math.round((Date.now() - en) / 60000) }
  } catch {
    return null
  }
}

/** Al cerrar sesión: lo guardado es de quien salió. */
export function limpiarCache() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(PREFIJO)) localStorage.removeItem(k)
    }
  } catch {
    /* nada que hacer */
  }
}

/**
 * Envuelve una lectura: intenta, guarda si sale bien, y si falla usa lo último.
 *
 * Devuelve siempre `{ datos, deCache, minutos }` para que la pantalla no tenga
 * que preguntar de dónde vino: si `deCache` es true, hay que decirlo.
 */
export async function conCache(clave, leer, { tiempoLimite = 6000 } = {}) {
  /**
   * Sin red, ni se intenta.
   *
   * ── Por qué esto importa tanto ──
   *
   * Sin este atajo, abrir la app en modo avión tardaba entre diez y quince
   * segundos: cada consulta salía, esperaba su tiempo límite y recién ahí caía
   * a la caché. Quince segundos mirando una pantalla vacía es indistinguible de
   * una app rota, y el técnico la cierra antes de que termine.
   *
   * `navigator.onLine` no sirve para afirmar que HAY internet —puede decir que
   * sí con el wifi conectado a un router sin salida— pero cuando dice que NO,
   * no se equivoca: el dispositivo no tiene ninguna interfaz de red. Y ese es
   * justamente el caso que hay que resolver rápido.
   */
  const guardadoYa = leerCache(clave)
  if (!navigator.onLine && guardadoYa) {
    return { datos: guardadoYa.datos, deCache: true, minutos: guardadoYa.minutos }
  }

  try {
    /**
     * Y con red dudosa, un tiempo límite.
     *
     * El caso peor no es no tener señal: es tener una raya. Ahí la consulta no
     * falla, se arrastra, y la pantalla queda esperando sin decir nada. Seis
     * segundos es más de lo que tarda una consulta normal y menos de lo que
     * alguien espera parado en una vereda.
     */
    const datos = await Promise.race([
      leer(),
      new Promise((_, rechazar) =>
        setTimeout(() => rechazar(new Error('La consulta tardó demasiado')), tiempoLimite),
      ),
    ])
    guardarCache(clave, datos)
    return { datos, deCache: false, minutos: 0 }
  } catch (err) {
    const guardado = leerCache(clave)
    if (guardado) {
      return { datos: guardado.datos, deCache: true, minutos: guardado.minutos }
    }
    // Sin nada guardado no se puede inventar: el error sube y la pantalla lo
    // dice. Es el caso del técnico que estrena el teléfono en una zona sin
    // señal, y ahí la verdad es que no hay datos.
    throw err
  }
}
