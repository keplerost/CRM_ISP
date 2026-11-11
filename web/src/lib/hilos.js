/**
 * Los hilos de la planta externa y el presupuesto óptico (migración 237).
 *
 * ── Cómo está armada la red ──
 *
 * Un CABLE tiene N hilos, del 1 al N, agrupados en tubos con el código de
 * colores TIA-598. En cada caja o manga hay UNIONES entre "extremos":
 *
 *   · un hilo de un cable          { tipo: 'hilo', id: cable, num: hilo, lado }
 *   · un puerto de un splitter     { tipo: 'splitter', id, num: 0 entrada | 1..N salida }
 *   · un puerto PON                { tipo: 'pon', id }
 *
 * El hilo es continuo a lo largo de su cable. Pasa de largo por las mangas
 * donde nadie lo tocó; donde se lo corta para fusionarlo (sangría), `lado`
 * dice qué pedazo es: 'd' el que va hacia el inicio del cable, 'h' el que va
 * hacia el final. Si el cable empieza o termina en esa caja, no hace falta.
 *
 * ── El recorrido ──
 *
 * Desde la entrada del splitter de una caja NAP se va hacia atrás: la unión
 * lleva a un hilo, el hilo se sigue por su cable hasta la próxima caja donde
 * está unido, esa unión lleva a una salida de splitter (se pasa a su entrada) o
 * a otro hilo, y así hasta llegar al puerto PON. En cada paso se suma la
 * pérdida: metros de fibra, fusión, conector, splitter.
 *
 * Nada de esto se guarda: se recalcula con lo que hay, así una fusión nueva o
 * un cable corregido cambian el resultado al instante.
 */

import { largoRuta, metrosEntre } from './kmz.js'

/** El código de colores TIA-598, para hilos y tubos. */
export const COLORES_FIBRA = [
  ['azul', '#2563eb'],
  ['naranja', '#f97316'],
  ['verde', '#16a34a'],
  ['cafe', '#92400e'],
  ['gris', '#6b7280'],
  ['blanco', '#f8fafc'],
  ['rojo', '#dc2626'],
  ['negro', '#111827'],
  ['amarillo', '#eab308'],
  ['violeta', '#7c3aed'],
  ['rosado', '#ec4899'],
  ['aqua', '#06b6d4'],
]

/** El hilo n de un cable: su tubo, su color y cómo se dice ("T2 naranja · hilo verde"). */
export function colorHilo(n, porTubo = 12) {
  const pt = Math.max(1, Number(porTubo) || 12)
  const t = Math.floor((n - 1) / pt)
  const f = (n - 1) % pt
  const tubo = COLORES_FIBRA[t % 12]
  const hilo = COLORES_FIBRA[f % 12]
  return {
    tubo: t + 1,
    colorTubo: tubo[1],
    nombreTubo: tubo[0],
    posicion: f + 1,
    color: hilo[1],
    nombre: hilo[0],
    etiqueta: `T${t + 1} ${tubo[0]} · hilo ${hilo[0]}`,
  }
}

/** Los valores de siempre, si `planta_optica` no está. */
export const OPTICA_BASE = {
  atenuacion_db_km: 0.35,
  perdida_fusion: 0.1,
  perdida_conector: 0.5,
  sensibilidad_dbm: -27,
  margen_min_db: 3,
  drop_m: 150,
  tolerancia_db: 3,
}

const BALANCEADOS = { 2: 3.7, 4: 7.3, 8: 10.5, 16: 13.7, 32: 17.1, 64: 20.5 }

/** Cuántas salidas tiene un splitter. */
export const salidasDe = (relacion) => (String(relacion).startsWith('1:') ? Number(String(relacion).slice(2)) : 2)

/**
 * La pérdida de un splitter hacia una salida. Balanceado: la típica de tabla.
 * Desbalanceado "10/90": la salida 1 se lleva el 10%, la 2 el 90% (más 0,4 dB
 * de exceso).
 */
export function perdidaSplitter(relacion, salida = 1, medida = null) {
  if (medida != null && medida !== '') return Number(medida)
  const r = String(relacion)
  if (r.startsWith('1:')) return BALANCEADOS[Number(r.slice(2))] ?? 10 * Math.log10(Number(r.slice(2))) + 1
  const [a, b] = r.split('/').map(Number)
  const p = (salida === 1 ? a : b) / 100
  return Math.round((-10 * Math.log10(p) + 0.4) * 100) / 100
}

/**
 * A cuántos metros del inicio del cable queda un punto (proyectándolo sobre la
 * ruta), y a cuántos metros de la ruta está.
 */
export function cadenamiento(ruta, [lat, lng]) {
  let mejor = { c: 0, d: Infinity }
  let acum = 0
  const kx = 111320 * Math.cos((lat * Math.PI) / 180)
  const ky = 110540
  for (let i = 0; i < ruta.length - 1; i++) {
    const [la1, lo1] = ruta[i]
    const [la2, lo2] = ruta[i + 1]
    const seg = metrosEntre(ruta[i], ruta[i + 1])
    const ax = (lo1 - lng) * kx
    const ay = (la1 - lat) * ky
    const bx = (lo2 - lng) * kx
    const by = (la2 - lat) * ky
    const dx = bx - ax
    const dy = by - ay
    const l2 = dx * dx + dy * dy
    const t = l2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / l2)) : 0
    const d = Math.hypot(ax + t * dx, ay + t * dy)
    if (d < mejor.d) mejor = { c: acum + t * seg, d }
    acum += seg
  }
  return mejor
}

const clave = (el, x) => `${el}|${x.tipo}|${x.id}|${x.num ?? ''}|${x.lado ?? ''}`
const extremo = (u, l) => ({ tipo: u[`${l}_tipo`], id: u[`${l}_id`], num: u[`${l}_num`] ?? null, lado: u[`${l}_lado`] ?? null })
const opuesto = (d) => (d === 'd' ? 'h' : 'd')

/** Todo indexado para recorrer rápido. */
export function armarRed({ elementos = [], cables = [], splitters = [], pons = [], uniones = [] }) {
  const el = new Map(elementos.map((e) => [e.id, e]))
  const cab = new Map(cables.map((c) => [c.id, c]))
  const spl = new Map(splitters.map((s) => [s.id, s]))
  const pon = new Map(pons.map((p) => [p.id, p]))
  const enCaja = new Map()
  const ocurrencias = new Map()
  for (const u of uniones) {
    for (const [mio, otro] of [
      [extremo(u, 'a'), extremo(u, 'b')],
      [extremo(u, 'b'), extremo(u, 'a')],
    ]) {
      enCaja.set(clave(u.elemento_id, mio), { union: u, mio, otro })
      if (mio.tipo === 'hilo') {
        const k = `${mio.id}:${mio.num}`
        if (!ocurrencias.has(k)) ocurrencias.set(k, [])
        ocurrencias.get(k).push({ elemento: u.elemento_id, extremo: mio, union: u })
      }
    }
  }
  const largos = new Map()
  const largo = (c) => {
    if (!largos.has(c.id)) largos.set(c.id, Number(c.longitud_m) || largoRuta(c.ruta))
    return largos.get(c.id)
  }
  const cadenas = new Map()
  /** A cuántos metros del inicio del cable está la caja. */
  const cadena = (cableId, elId) => {
    const k = `${cableId}|${elId}`
    if (cadenas.has(k)) return cadenas.get(k)
    const c = cab.get(cableId)
    const e = el.get(elId)
    let v = 0
    if (c && e) {
      if (c.desde_id === elId) v = 0
      else if (c.hasta_id === elId) v = largo(c)
      else {
        // La ruta mide "en línea"; los metros reales pueden ser otros. Se
        // escala para que el final coincida con la longitud del cable.
        const p = cadenamiento(c.ruta, [Number(e.latitud), Number(e.longitud)])
        const geo = largoRuta(c.ruta) || 1
        v = (p.c / geo) * largo(c)
      }
    }
    cadenas.set(k, v)
    return v
  }
  return { el, cab, spl, pon, enCaja, ocurrencias, cadena, largo }
}

/**
 * Hacia dónde sigue el pedazo de hilo que está unido en esa caja: 'd' (hacia
 * el inicio del cable) o 'h' (hacia el final). null si no se puede saber.
 */
export function sentido(red, elId, x) {
  if (x.lado) return x.lado
  const c = red.cab.get(x.id)
  if (!c) return null
  if (c.desde_id === elId) return 'h'
  if (c.hasta_id === elId) return 'd'
  // Sin extremos cargados: si la caja está en una punta de la ruta, es esa.
  const k = red.cadena(x.id, elId)
  const L = red.largo(c)
  if (k <= 15) return 'h'
  if (k >= L - 15) return 'd'
  return null
}

/** Sigue un hilo por su cable desde una caja, en un sentido, hasta la próxima donde está unido. */
export function viajar(red, x, elId, dir) {
  const lista = red.ocurrencias.get(`${x.id}:${x.num}`) ?? []
  const aqui = red.cadena(x.id, elId)
  let mejor = null
  for (const o of lista) {
    if (o.elemento === elId) continue
    const k = red.cadena(x.id, o.elemento)
    const dist = dir === 'h' ? k - aqui : aqui - k
    if (dist < 0) continue
    if (!mejor || dist < mejor.metros) mejor = { o, metros: dist }
  }
  if (!mejor) return null
  // El pedazo por el que se llega tiene que ser el que mira para este lado.
  const llega = sentido(red, mejor.o.elemento, mejor.o.extremo)
  // Con dos ocurrencias en la misma caja (sangría), se toma la que mira acá.
  const gemela = lista.find(
    (o) => o.elemento === mejor.o.elemento && o !== mejor.o && sentido(red, o.elemento, o.extremo) === opuesto(dir),
  )
  if (gemela) return { o: gemela, metros: mejor.metros }
  if (llega && llega === dir) return { cortado: true, o: mejor.o, metros: mejor.metros }
  return mejor
}

const nombreEl = (red, id) => red.el.get(id)?.nombre ?? 'una caja'

/** Cómo se dice un extremo: "Feeder 48h · hilo 5 (T1 azul · hilo gris)". */
export function describir(red, x) {
  if (x.tipo === 'pon') return `PON ${red.pon.get(x.id)?.nombre ?? ''}`.trim()
  if (x.tipo === 'splitter') {
    const s = red.spl.get(x.id)
    return `splitter ${s?.relacion ?? ''} ${x.num === 0 ? 'entrada' : `salida ${x.num}`}`
  }
  const c = red.cab.get(x.id)
  return `${c?.nombre ?? 'cable'} · hilo ${x.num} (${colorHilo(x.num, c?.hilos_por_tubo).etiqueta})${
    x.lado ? (x.lado === 'd' ? ' hacia el inicio' : ' hacia el final') : ''
  }`
}

const perdidaUnion = (u, cfg) =>
  u.perdida_db != null ? Number(u.perdida_db) : u.tipo === 'conector' ? Number(cfg.perdida_conector) : Number(cfg.perdida_fusion)

/**
 * De un extremo en una caja hasta su puerto PON.
 * → { ok, pon, pasos: [{ tipo, texto, elemento, metros?, perdida }], perdida, error? }
 */
export function trazarHaciaPon(red, elId, x, cfgParcial = {}) {
  const cfg = { ...OPTICA_BASE, ...cfgParcial }
  const pasos = []
  const vistos = new Set()
  let E = elId
  let X = x
  const fin = (extra) => ({ pasos, perdida: suma(pasos), ...extra })
  for (let i = 0; i < 300; i++) {
    const k = clave(E, X)
    if (vistos.has(k)) return fin({ ok: false, error: `El camino da una vuelta en ${nombreEl(red, E)}: revisá las uniones.` })
    vistos.add(k)
    const r = red.enCaja.get(k)
    if (!r) return fin({ ok: false, error: `En ${nombreEl(red, E)}, ${describir(red, X)} no está unido a nada.`, elemento: E })
    pasos.push({
      tipo: r.union.tipo,
      elemento: E,
      texto: `${nombreEl(red, E)}: ${r.union.tipo === 'conector' ? 'conector' : 'fusión'} ${describir(red, X)} ↔ ${describir(red, r.otro)}`,
      perdida: perdidaUnion(r.union, cfg),
    })
    const Y = r.otro
    if (Y.tipo === 'pon') return fin({ ok: true, pon: red.pon.get(Y.id) })
    if (Y.tipo === 'splitter') {
      const s = red.spl.get(Y.id)
      if (Y.num === 0) {
        return fin({ ok: false, error: `En ${nombreEl(red, E)} se llegó a la ENTRADA de un splitter: el hilo está unido al revés.`, elemento: E })
      }
      pasos.push({
        tipo: 'splitter',
        elemento: E,
        texto: `${nombreEl(red, E)}: splitter ${s?.relacion} (salida ${Y.num} → entrada)`,
        perdida: perdidaSplitter(s?.relacion, Y.num, s?.perdida_db),
      })
      X = { tipo: 'splitter', id: Y.id, num: 0, lado: null }
      continue
    }
    // Un hilo: se lo sigue por su cable.
    const dir = sentido(red, E, Y)
    if (!dir) {
      return fin({
        ok: false,
        error: `En ${nombreEl(red, E)}, el cable ${red.cab.get(Y.id)?.nombre ?? ''} pasa de largo: decí hacia qué lado sigue el hilo ${Y.num}.`,
        elemento: E,
      })
    }
    const v = viajar(red, Y, E, dir)
    if (!v) {
      return fin({
        ok: false,
        error: `El hilo ${Y.num} de ${red.cab.get(Y.id)?.nombre ?? 'el cable'} sale de ${nombreEl(red, E)} y no está unido en ninguna otra caja ${dir === 'd' ? 'hacia el inicio' : 'hacia el final'}.`,
        elemento: E,
      })
    }
    pasos.push({
      tipo: 'fibra',
      elemento: v.o.elemento,
      metros: Math.round(v.metros),
      texto: `${red.cab.get(Y.id)?.nombre ?? 'Cable'} hilo ${Y.num}: ${nombreEl(red, E)} → ${nombreEl(red, v.o.elemento)} (${Math.round(v.metros)} m)`,
      perdida: (v.metros / 1000) * Number(cfg.atenuacion_db_km),
    })
    if (v.cortado) {
      return fin({ ok: false, error: `El hilo ${Y.num} llega a ${nombreEl(red, v.o.elemento)} cortado y sin unir.`, elemento: v.o.elemento })
    }
    E = v.o.elemento
    X = v.o.extremo
  }
  return fin({ ok: false, error: 'El camino es demasiado largo: revisá las uniones.' })
}

const suma = (pasos) => Math.round(pasos.reduce((s, p) => s + p.perdida, 0) * 100) / 100

/**
 * El presupuesto de una caja NAP: desde la entrada de su splitter hasta el PON.
 * → { ok, error?, pasos, pon, perdidaEntrada, perdidaSalida, rxEntrada, rxSalida,
 *     rxAbonado, margen, estado: 'bien'|'atencion'|'mal'|'sin_camino', splitter }
 */
export function presupuestoCaja(red, elId, cfgParcial = {}) {
  const cfg = { ...OPTICA_BASE, ...cfgParcial }
  const splitters = [...red.spl.values()].filter((s) => s.elemento_id === elId)
  // El splitter de la caja es el que tiene la entrada unida (el que recibe).
  const propio =
    splitters.find((s) => red.enCaja.has(clave(elId, { tipo: 'splitter', id: s.id, num: 0, lado: null }))) ?? splitters[0]
  if (!propio) return { ok: false, estado: 'sin_camino', error: 'La caja no tiene splitter cargado.', pasos: [] }
  const t = trazarHaciaPon(red, elId, { tipo: 'splitter', id: propio.id, num: 0, lado: null }, cfg)
  if (!t.ok) return { ...t, estado: 'sin_camino', splitter: propio }
  const tx = Number(t.pon.tx_dbm)
  const sPropio = perdidaSplitter(propio.relacion, salidasDe(propio.relacion) === 2 ? 2 : 1, propio.perdida_db)
  const perdidaEntrada = t.perdida
  const perdidaSalida = Math.round((perdidaEntrada + sPropio) * 100) / 100
  const drop = (Number(cfg.drop_m) / 1000) * Number(cfg.atenuacion_db_km) + 2 * Number(cfg.perdida_conector)
  const rxAbonado = Math.round((tx - perdidaSalida - drop) * 100) / 100
  const margen = Math.round((rxAbonado - Number(cfg.sensibilidad_dbm)) * 100) / 100
  return {
    ...t,
    splitter: propio,
    perdidaEntrada,
    perdidaSalida,
    rxEntrada: Math.round((tx - perdidaEntrada) * 100) / 100,
    rxSalida: Math.round((tx - perdidaSalida) * 100) / 100,
    rxAbonado,
    margen,
    estado: margen >= Number(cfg.margen_min_db) ? 'bien' : margen >= 0 ? 'atencion' : 'mal',
  }
}

/**
 * Lo medido contra lo calculado en una caja: si difieren más de la
 * tolerancia, hay algo en el camino (un empalme malo, un conector sucio).
 */
export function compararMedido(presupuesto, medidoDbm, cfgParcial = {}) {
  const cfg = { ...OPTICA_BASE, ...cfgParcial }
  if (!presupuesto?.ok || medidoDbm == null) return null
  const dif = Math.round((Number(medidoDbm) - presupuesto.rxSalida) * 100) / 100
  return { diferencia: dif, alerta: Math.abs(dif) > Number(cfg.tolerancia_db) }
}

/**
 * Desde un puerto PON hacia adelante: qué hilos ocupa y a qué cajas llega.
 * → { hilos: [{ cable, num }], cajas: [{ elemento, rxSalida, nivel }], cortes: [texto] }
 */
export function trazarDesdePon(red, ponId, cfgParcial = {}) {
  const cfg = { ...OPTICA_BASE, ...cfgParcial }
  const p = red.pon.get(ponId)
  const tx = Number(p?.tx_dbm ?? 3)
  const hilos = []
  const cajas = new Map()
  const cortes = []
  const vistos = new Set()
  const pon = [...red.enCaja.values()].find((r) => r.mio.tipo === 'pon' && r.mio.id === ponId)
  if (!pon) return { hilos, cajas: [], cortes: ['El puerto no está unido a ningún hilo.'] }

  const ir = (E, X, perdida, nivel) => {
    const k = clave(E, X)
    if (vistos.has(k) || vistos.size > 5000) return
    vistos.add(k)
    const r = red.enCaja.get(k)
    if (!r) return
    perdida += perdidaUnion(r.union, cfg)
    const Y = r.otro
    if (Y.tipo === 'hilo') {
      hilos.push({ cable: Y.id, num: Y.num, elemento: E })
      const dir = sentido(red, E, Y)
      if (!dir) return cortes.push(`En ${nombreEl(red, E)} falta decir hacia dónde sigue el hilo ${Y.num}.`)
      const v = viajar(red, Y, E, dir)
      if (!v) return cortes.push(`El hilo ${Y.num} de ${red.cab.get(Y.id)?.nombre ?? ''} no está unido después de ${nombreEl(red, E)}.`)
      if (v.cortado) return cortes.push(`El hilo ${Y.num} llega cortado a ${nombreEl(red, v.o.elemento)}.`)
      ir(v.o.elemento, v.o.extremo, perdida + (v.metros / 1000) * Number(cfg.atenuacion_db_km), nivel)
    } else if (Y.tipo === 'splitter' && Y.num === 0) {
      const s = red.spl.get(Y.id)
      const e = red.el.get(E)
      const n = salidasDe(s?.relacion)
      for (let i = 1; i <= n; i++) {
        const ps = perdida + perdidaSplitter(s?.relacion, i, s?.perdida_db)
        if (e?.tipo === 'nap') {
          const prev = cajas.get(E)
          if (!prev || prev.rxSalida < tx - ps) cajas.set(E, { elemento: E, rxSalida: Math.round((tx - ps) * 100) / 100, nivel: nivel + 1 })
        }
        ir(E, { tipo: 'splitter', id: Y.id, num: i, lado: null }, ps, nivel + 1)
      }
    }
  }
  ir(pon.union.elemento_id, pon.mio, 0, 0)
  return { hilos, cajas: [...cajas.values()], cortes }
}
