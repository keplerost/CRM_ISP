/**
 * Los proyectos de red (migración 238): la lista de materiales y el alcance
 * de la obra, sacados de lo que se dibujó.
 *
 * Es una cuenta, no una adivinanza: cuenta lo que está en el proyecto. Lo que
 * no se dibujó no aparece, y eso es lo que hay que mirar antes de mandarla.
 */

import { largoRuta } from './kmz.js'

const TIPO_CABLE = {
  troncal: 'troncal',
  feeder: 'feeder',
  distribucion: 'de distribución',
  drop: 'drop',
  hilo: '',
  otro: '',
}

/**
 * → [{ clave, descripcion, unidad, cantidad, grupo }]
 *
 * `reservaPct`: cuánto se suma a los metros de cable por curvas, bajadas y
 * reservas no dibujadas. Las reservas dibujadas (con sus metros) van aparte.
 */
export function listaMateriales({ elementos = [], cables = [], splitters = [], uniones = [] }, { reservaPct = 10 } = {}) {
  const filas = new Map()
  const sumar = (clave, descripcion, unidad, cantidad, grupo) => {
    if (!cantidad) return
    const f = filas.get(clave) ?? { clave, descripcion, unidad, cantidad: 0, grupo }
    f.cantidad += cantidad
    filas.set(clave, f)
  }
  const factor = 1 + Number(reservaPct || 0) / 100

  for (const c of cables) {
    const metros = Number(c.longitud_m) || largoRuta(c.ruta ?? [])
    const tipo = TIPO_CABLE[c.tipo] ?? ''
    const desc =
      c.tipo === 'drop'
        ? `Cable drop${c.hilos ? ` ${c.hilos} hilos` : ''}`
        : `Cable de fibra ${tipo}${c.hilos ? ` ${c.hilos} hilos` : ''}`.replace(/\s+/g, ' ').trim()
    sumar(`cable:${c.tipo}:${c.hilos ?? ''}`, desc, 'm', metros * factor, 'Cable')
  }
  for (const e of elementos) {
    if (e.tipo === 'nap') sumar(`nap:${e.capacidad ?? ''}`, `Caja NAP${e.capacidad ? ` ${e.capacidad} puertos` : ''}`, 'u', 1, 'Cajas y empalmes')
    else if (e.tipo === 'manga') sumar(`manga:${e.hilos ?? ''}`, `Manga de empalme${e.hilos ? ` ${e.hilos} hilos` : ''}`, 'u', 1, 'Cajas y empalmes')
    else if (e.tipo === 'odf') sumar('odf', 'ODF / distribuidor', 'u', 1, 'Cajas y empalmes')
    else if (e.tipo === 'reserva') sumar('reserva', 'Fibra para reservas', 'm', Number(e.metros) || 0, 'Cable')
    else if (e.tipo === 'poste') {
      if (e.estado === 'proyectado' && !e.existente) sumar('poste', 'Poste nuevo', 'u', 1, 'Postes y herrajes')
      if (e.herraje === 'A') sumar('herraje:A', 'Herraje de retención (A)', 'u', 1, 'Postes y herrajes')
      else if (e.herraje === 'J') sumar('herraje:J', 'Herraje de suspensión (J)', 'u', 1, 'Postes y herrajes')
      else sumar('herraje:?', 'Herraje (definir A o J)', 'u', 1, 'Postes y herrajes')
    }
  }
  for (const s of splitters) sumar(`splitter:${s.relacion}`, `Splitter ${s.relacion}`, 'u', 1, 'Cajas y empalmes')
  for (const u of uniones) {
    if (u.tipo === 'conector') sumar('conector', 'Conectores', 'u', 1, 'Fusiones y conectores')
    else sumar('fusion', 'Fusiones', 'u', 1, 'Fusiones y conectores')
  }

  const orden = ['Cable', 'Cajas y empalmes', 'Postes y herrajes', 'Fusiones y conectores']
  return [...filas.values()]
    // Redondeo a centésimas antes de subir: 100 × 1,1 da 110,0000000001 y serían 111 m.
    .map((f) => ({ ...f, cantidad: f.unidad === 'm' ? Math.ceil(Math.round(f.cantidad * 100) / 100) : f.cantidad }))
    .sort((a, b) => orden.indexOf(a.grupo) - orden.indexOf(b.grupo) || a.descripcion.localeCompare(b.descripcion))
}

/** El alcance de la obra (las metas de la 232), del diseño. */
export function metasDelProyecto({ elementos = [], cables = [], uniones = [] }) {
  const metros = cables.filter((c) => c.tipo !== 'drop').reduce((s, c) => s + (Number(c.longitud_m) || largoRuta(c.ruta ?? [])), 0)
  const naps = elementos.filter((e) => e.tipo === 'nap')
  return {
    meta_metros: Math.round(metros),
    meta_naps: naps.length,
    meta_fusiones: uniones.filter((u) => u.tipo !== 'conector').length,
    meta_mangas: elementos.filter((e) => e.tipo === 'manga').length,
    meta_postes: elementos.filter((e) => e.tipo === 'poste' && e.estado === 'proyectado').length,
    meta_puertos: naps.reduce((s, n) => s + (Number(n.capacidad) || 0), 0),
  }
}

/** Lo que es de un proyecto, de todas las listas. */
export function delProyecto(id, { elementos = [], cables = [], splitters = [], uniones = [] }) {
  return {
    elementos: elementos.filter((e) => e.proyecto_id === id),
    cables: cables.filter((c) => c.proyecto_id === id),
    splitters: splitters.filter((s) => s.proyecto_id === id),
    uniones: uniones.filter((u) => u.proyecto_id === id),
  }
}
