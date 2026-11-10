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
/**
 * ¿Es una coordenada de verdad?
 *
 * `Number(null)` y `Number('')` dan 0, que es un número válido: sin esta
 * revisión, un trabajo sin ubicación se dibujaba en el punto 0,0 —en el medio
 * del océano, frente a África— y la ruta cruzaba el mar para llegar.
 */
export const esCoordenada = (v) => v != null && v !== '' && Number.isFinite(Number(v))

const punto = (o) =>
  esCoordenada(o?.latitud) && esCoordenada(o?.longitud)
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

/** Cuánto antes del vencimiento un trabajo pasa adelante: dos horas. */
export const URGENCIA_MIN = 120

/** El orden de las franjas que se le prometen al abonado. */
const GRUPO_FRANJA = { manana: 0, exacta: 0, tarde: 2 }

/**
 * El orden automático de la ruta de un técnico, para la oficina.
 *
 * Arma la propuesta en este orden de importancia:
 *
 *   1. Lo que ya está en curso, primero. No se le cambia el trabajo a quien
 *      está parado en la puerta de un cliente.
 *   2. Lo URGENTE: prioridad alta, o un plazo que vence en menos de dos horas
 *      (o ya vencido). Entre ellos, por cercanía.
 *   3. El resto por FRANJA —mañana, sin franja, tarde—, porque la franja es lo
 *      que se le prometió al abonado. Dentro de cada una, por cercanía, y los
 *      que tienen hora exacta conservan su hora (eso ya lo hace
 *      `ordenarPorCercania`).
 *
 * Cada tramo arranca donde terminó el anterior: así los cuatro clientes de un
 * mismo sector quedan seguidos aunque estén en tramos distintos de la lista.
 *
 * Propone, no impone: la oficina lo ve, lo corrige con las flechas y lo guarda.
 *
 * @param items  los pendientes de la ruta (de `rutas_del_dia`)
 * @param vence  (item) => fecha de vencimiento del plazo, o null
 * @param desde  de dónde arranca el técnico, si se sabe
 */
export function ordenarRutaAutomatica(items, { vence = () => null, desde = null, ahora = new Date() } = {}) {
  const lista = [...(items ?? [])]
  const enCurso = lista.filter((i) => i.en_curso)
  const resto = lista.filter((i) => !i.en_curso)

  const urgente = (i) => {
    if (i.hora) return false // la hora acordada manda; se queda en su franja
    if (i.prioridad === 'alta') return true
    const v = vence(i)
    return Boolean(v) && new Date(v) - ahora <= URGENCIA_MIN * 60000
  }

  // Dónde está parado ahora, o de dónde sale.
  const ultimoPunto = (ruta, inicial) => {
    for (let k = ruta.length - 1; k >= 0; k--) {
      const p = punto(ruta[k])
      if (p) return p
    }
    return inicial
  }

  let salida = ultimoPunto(enCurso, desde)
  const tramos = []

  const urgentes = resto.filter(urgente)
  const normales = resto.filter((i) => !urgente(i))

  const grupos = [0, 1, 2].map((g) => normales.filter((i) => (GRUPO_FRANJA[i.franja] ?? 1) === g))

  for (const grupo of [urgentes, ...grupos]) {
    if (!grupo.length) continue
    const ordenado = ordenarPorCercania(grupo, { desde: salida })
    tramos.push(...ordenado)
    salida = ultimoPunto(ordenado, salida)
  }

  return [...enCurso, ...tramos]
}

/**
 * Coordenadas a partir de lo que se pegue: "-0.815962, -79.281162" (como lo
 * copia MikroWISP), "-0.815962 -79.281162", o un enlace de Google Maps
 * (`?q=lat,lng`, `@lat,lng,17z`, `/place/lat,lng`).
 *
 * Devuelve `{ lat, lng }` como texto, o null si no reconoce dos números que
 * puedan ser una coordenada. Es para no tener que separar a mano la latitud de
 * la longitud cada vez que se carga un ticket.
 */
export function coordenadasDeTexto(texto) {
  const t = String(texto ?? '').trim()
  if (!t) return null
  const m = t.match(/(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)/)
  if (!m) return null
  const lat = Number(m[1])
  const lng = Number(m[2])
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return null
  return { lat: m[1], lng: m[2] }
}

/** Cuántas paradas acepta un enlace de Google Maps: destino + 9 intermedias. */
export const MAX_PARADAS_GOOGLE = 10

/**
 * La ruta del día trazada por calles, en Google Maps.
 *
 * Sin origen: Google arranca desde donde está el teléfono, que es lo que el
 * técnico quiere. Las paradas van en el orden de la ruta, y solo las que tienen
 * coordenadas. Google no acepta más de nueve intermedias en un enlace, así que
 * con más se traza el primer tramo y la pantalla lo dice.
 *
 * @param paradas  [{ latitud, longitud }] en el orden de visita
 * @returns { url, incluidas, total } o null si ninguna tiene ubicación
 */
export function enlaceRutaGoogle(paradas = []) {
  const ubicadas = paradas.filter((p) => esCoordenada(p?.latitud) && esCoordenada(p?.longitud))
  if (!ubicadas.length) return null
  const tramo = ubicadas.slice(0, MAX_PARADAS_GOOGLE)
  const punto = (p) => `${Number(p.latitud)},${Number(p.longitud)}`
  const destino = tramo[tramo.length - 1]
  const intermedias = tramo.slice(0, -1)
  let url = `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${punto(destino)}`
  if (intermedias.length) url += `&waypoints=${encodeURIComponent(intermedias.map(punto).join('|'))}`
  return { url, incluidas: tramo.length, total: ubicadas.length }
}

/** Hasta dónde un trabajo cuenta como "de la misma zona": dos kilómetros. */
export const RADIO_ZONA_M = 2000

/**
 * Los trabajos pendientes cerca de un punto, del más cercano al más lejano.
 *
 * Para quien carga un ticket: si a 600 m ya hay dos visitas el miércoles por
 * la mañana, conviene agendar este junto a ellas y no un jueves a la tarde en
 * la otra punta. Se mide con coordenadas y no por sector porque el sector casi
 * nunca se llena.
 *
 * @param punto     { latitud, longitud } del ticket que se está cargando
 * @param trabajos  pendientes con latitud/longitud
 * @param excluir   id a dejar afuera (el propio ticket, al editar)
 */
export function trabajosCercanos(punto, trabajos = [], { radio = RADIO_ZONA_M, excluir = null } = {}) {
  if (!esCoordenada(punto?.latitud) || !esCoordenada(punto?.longitud)) return []
  const desde = { lat: Number(punto.latitud), lng: Number(punto.longitud) }
  return trabajos
    .filter((t) => t.id !== excluir && esCoordenada(t.latitud) && esCoordenada(t.longitud))
    .map((t) => {
      const d = distanciaEnMetros(desde, { lat: Number(t.latitud), lng: Number(t.longitud) })
      return { ...t, metros: d == null ? null : Math.round(d) }
    })
    .filter((t) => t.metros != null && t.metros <= radio)
    .sort((a, b) => a.metros - b.metros)
}

/**
 * Las paradas que caen en el mismo lugar, juntas.
 *
 * Dos tickets del mismo abonado tienen las mismas coordenadas, y el mapa
 * dibujaba un número encima del otro: se veía el 6 y el 4 desaparecía. Juntas,
 * la marca dice "4·6" y no se pierde ninguna.
 *
 * Se compara con seis decimales (unos 10 cm): más fino que eso es el mismo
 * punto cargado dos veces.
 *
 * @param puntos  [{ lat, lng, n, ... }] en el orden de la ruta
 * @returns [{ lat, lng, numeros: [n…], puntos: [...] }] en el orden de la
 *          primera parada de cada lugar
 */
export function agruparPorLugar(puntos = []) {
  const lugares = new Map()
  puntos.forEach((p, i) => {
    if (!esCoordenada(p?.lat) || !esCoordenada(p?.lng)) return
    const clave = `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`
    if (!lugares.has(clave)) lugares.set(clave, { lat: Number(p.lat), lng: Number(p.lng), numeros: [], puntos: [] })
    const l = lugares.get(clave)
    l.numeros.push(p.n ?? i + 1)
    l.puntos.push(p)
  })
  return [...lugares.values()]
}
