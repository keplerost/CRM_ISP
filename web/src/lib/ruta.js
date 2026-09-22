/**
 * El orden en que conviene recorrer el día.
 *
 * ── Qué problema resuelve ──
 *
 * Hasta ahora la ruta se ordenaba solo por hora, y las órdenes sin hora
 * quedaban todas al final. Eso hace que un día con tres trabajos sueltos en el
 * norte y uno agendado en el sur salga: sur → norte → norte → norte, o peor,
 * que los tres del norte queden después de cruzar la ciudad dos veces.
 *
 * ── Lo que NO hace, y hay que decirlo ──
 *
 * Mide en LÍNEA RECTA, no por calle. El propio sistema ya lo dice en la
 * pantalla de jornada, explicando por qué el kilometraje se pide a mano:
 *
 *     "son líneas rectas —el camino real entre dos casas no lo es— e ignora
 *      todo lo que no es una parada registrada"
 *
 * Eso vale igual acá. Sirve para decidir el ORDEN de las paradas, que es una
 * comparación entre alternativas y no un número absoluto. No sirve para
 * prometer cuántos kilómetros se ahorran: un río, una vía de una sola mano o
 * un puente cortado cambian el resultado y este cálculo no los ve.
 *
 * ── Tampoco sabe cuánto dura cada trabajo ──
 *
 * Y eso limita lo que puede garantizar. Meter un trabajo suelto entre el de
 * las 9:00 y el de las 10:00 es lo más corto en distancia, pero si el suelto
 * lleva una hora, llega tarde al segundo. El sistema no tiene la duración de
 * cada tipo de trabajo, así que no puede decidirlo — por eso las órdenes con
 * hora quedan SIEMPRE en su orden y bien marcadas, y el técnico sigue
 * decidiendo. Esto propone un orden, no lo impone.
 */

import { distanciaEnMetros } from './soporte.js'

/** La coordenada de una orden, o null si no tiene. */
const punto = (o) =>
  o?.latitud != null && o?.longitud != null
    ? { lat: Number(o.latitud), lng: Number(o.longitud) }
    : null

/** Metros entre dos paradas. `null` si a alguna le falta la coordenada. */
function entre(a, b) {
  if (!a || !b) return null
  return distanciaEnMetros(a, b)
}

/**
 * Cuánto se alarga el recorrido al meter `o` en la posición `i`.
 *
 * Es la cuenta clásica de inserción más barata: lo que cuesta ir del anterior
 * a la nueva parada, más de la nueva a la siguiente, menos el tramo que se
 * dejó de hacer directo.
 *
 * Devuelve `null` cuando no se puede calcular —faltan coordenadas alrededor—,
 * que es distinto de un costo cero.
 */
function costoDeInsertar(ruta, i, o, desde) {
  const nuevo = punto(o)
  if (!nuevo) return null

  const antes = i === 0 ? desde : punto(ruta[i - 1])
  const despues = i < ruta.length ? punto(ruta[i]) : null

  const ida = entre(antes, nuevo)
  const vuelta = entre(nuevo, despues)
  const directo = entre(antes, despues)

  // En el medio del recorrido: el desvío real.
  if (ida != null && vuelta != null) return ida + vuelta - (directo ?? 0)
  // Al final, o arrancando: solo el tramo que se agrega.
  if (ida != null) return ida
  if (vuelta != null) return vuelta
  return null
}

/**
 * Ordena las paradas del día.
 *
 * Las que tienen hora son compromisos con el abonado: conservan su orden entre
 * ellas, siempre. Las que no tienen hora se acomodan donde menos alarguen el
 * recorrido.
 *
 * @param ordenes  las del día
 * @param desde    dónde arranca el técnico, si se sabe. Sin esto, la primera
 *                 parada libre se ubica respecto de las demás y no de él.
 */
export function ordenarPorCercania(ordenes, { desde = null } = {}) {
  const lista = [...(ordenes ?? [])]

  // El esqueleto: lo comprometido, en su orden.
  const ruta = lista
    .filter((o) => o.hora)
    .sort((a, b) => String(a.hora).localeCompare(String(b.hora)))

  const libres = lista.filter((o) => !o.hora)
  const sinCoordenada = libres.filter((o) => !punto(o))

  /**
   * Las libres se procesan de la más lejana a la más cercana al arranque.
   *
   * No es un capricho: insertar primero la que está lejos le deja al algoritmo
   * la posibilidad de armar el desvío largo una sola vez y colgarle las
   * cercanas de camino. Al revés —cercanas primero— cada lejana se termina
   * agregando al final, que es justo el zigzag que esto viene a evitar.
   */
  const conCoordenada = libres
    .filter((o) => punto(o))
    .sort((a, b) => (entre(desde, punto(b)) ?? 0) - (entre(desde, punto(a)) ?? 0))

  for (const o of conCoordenada) {
    let mejorPos = ruta.length
    let mejorCosto = Infinity

    for (let i = 0; i <= ruta.length; i++) {
      const c = costoDeInsertar(ruta, i, o, desde)
      if (c != null && c < mejorCosto) {
        mejorCosto = c
        mejorPos = i
      }
    }
    ruta.splice(mejorPos, 0, o)
  }

  // Las que nadie ubicó van al final: no se pueden comparar con nada, y
  // meterlas en el medio sería inventar una posición.
  return [...ruta, ...sinCoordenada]
}

/**
 * Cuánto recorrido representa una ruta, en metros y en línea recta.
 *
 * Se devuelve junto con `tramosMedidos` a propósito. Un total de 4 km sobre
 * seis paradas de las que solo dos tenían coordenada no es "4 km": es lo poco
 * que se pudo medir, y mostrarlo como total daría una precisión que no existe.
 */
export function largoDeRuta(ruta, { desde = null } = {}) {
  let metros = 0
  let medidos = 0
  let anterior = desde

  for (const o of ruta ?? []) {
    const p = punto(o)
    if (!p) continue
    const d = entre(anterior, p)
    if (d != null) {
      metros += d
      medidos++
    }
    anterior = p
  }

  return { metros, tramosMedidos: medidos }
}
