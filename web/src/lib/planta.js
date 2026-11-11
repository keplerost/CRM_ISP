/**
 * Los estilos de la planta externa (migración 235).
 *
 * Lo que se ve sale de lo más específico que haya:
 *
 *     el propio del elemento o cable  >  el de su capa  >  el de su tipo
 *
 * Así "Feeder principal" puede ir en rojo de 7 px sin tocar el resto de los
 * troncales, y un tramo puntual en otro color sin sacarlo de su capa.
 */

/** Los de siempre, por si la tabla de estilos todavía no está (sin la 235). */
export const ESTILOS_BASE = {
  'e:nodo': { color: '#dc2626', tamano: 9 },
  'e:poste': { color: '#475569', tamano: 4 },
  'e:nap': { color: '#f59e0b', tamano: 6 },
  'e:manga': { color: '#9333ea', tamano: 6 },
  'e:reserva': { color: '#0d9488', tamano: 5 },
  'e:splitter': { color: '#0ea5e9', tamano: 5 },
  'e:odf': { color: '#334155', tamano: 7 },
  'e:otro': { color: '#64748b', tamano: 4 },
  'c:troncal': { color: '#1d4ed8', tamano: 5 },
  'c:feeder': { color: '#2563eb', tamano: 4 },
  'c:distribucion': { color: '#16a34a', tamano: 3 },
  'c:drop': { color: '#0891b2', tamano: 2 },
  'c:hilo': { color: '#f97316', tamano: 2 },
  'c:otro': { color: '#64748b', tamano: 2 },
}

/** El ícono de cada tipo de punto (migración 236). */
export { ICONO_POR_TIPO } from './iconos.js'
import { ICONO_POR_TIPO } from './iconos.js'

/** Los colores del código de hilos (TIA-598). */
export const COLOR_HILO = {
  azul: '#2563eb', naranja: '#f97316', verde: '#16a34a', cafe: '#92400e', gris: '#6b7280', blanco: '#e5e7eb',
  rojo: '#dc2626', negro: '#111827', amarillo: '#eab308', violeta: '#7c3aed', rosado: '#ec4899', aqua: '#06b6d4',
  turquesa: '#14b8a6',
}

export const LINEAS = { solida: 'Sólida', rayada: 'Rayada', punteada: 'Punteada' }
/** El `dashArray` de Leaflet para cada tipo de línea. */
export const DASH = { solida: null, rayada: '12 8', punteada: '2 7' }

const num = (v) => (v == null || v === '' ? null : Number(v))

/**
 * El estilo final de un elemento (`clase` 'e') o cable ('c'):
 * { color, tamano, linea, opacidad, de } — `de` dice de dónde salió.
 */
export function resolverEstilo(x, clase, { capas = new Map(), estilos = {} } = {}) {
  const clave = `${clase}:${x.tipo}`
  const tipo = { linea: 'solida', opacidad: 0.9, ...ESTILOS_BASE[clave], ...estilos[clave] }
  const capa = x.capa_id ? capas.get(x.capa_id) : null
  // Un hilo sin color propio ni capa va con el color del hilo.
  const colorHilo = clase === 'c' && x.tipo === 'hilo' && x.color_hilo ? COLOR_HILO[x.color_hilo] : null
  const de = x.color || num(x.tamano) || x.linea || x.icono ? 'propio' : capa ? 'capa' : 'tipo'
  return {
    // Solo los puntos llevan ícono; el poste con herraje, su letra.
    icono:
      clase === 'e'
        ? x.icono ||
          capa?.icono ||
          (x.tipo === 'poste' && !estilos[clave]?.icono && x.herraje === 'A' ? 'poste_a' : null) ||
          (x.tipo === 'poste' && !estilos[clave]?.icono && x.herraje === 'J' ? 'poste_j' : null) ||
          tipo.icono ||
          ICONO_POR_TIPO[x.tipo] ||
          'circulo'
        : null,
    color: x.color || capa?.color || colorHilo || tipo.color,
    tamano: num(x.tamano) ?? num(capa?.tamano) ?? num(tipo.tamano) ?? 3,
    linea: x.linea || capa?.linea || tipo.linea || 'solida',
    opacidad: num(capa?.opacidad) ?? num(tipo.opacidad) ?? 0.9,
    de,
  }
}

/** #RRGGBB + opacidad → aabbggrr, como lo pide el KML. */
export function kmlColor(hex, opacidad = 1) {
  const h = String(hex ?? '#888888').replace('#', '').padEnd(6, '8').slice(0, 6)
  const a = Math.round(Math.min(1, Math.max(0, Number(opacidad))) * 255)
    .toString(16)
    .padStart(2, '0')
  return `${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toLowerCase()
}

/** ¿Se ve? Un elemento en una capa sigue a su capa; uno suelto, a su tipo. */
export function esVisible(x, clase, interruptores, capas = new Map()) {
  if (x.capa_id && capas.has(x.capa_id)) return interruptores[`k:${x.capa_id}`] !== false
  return interruptores[`${clase}:${x.tipo}`] !== false
}

/** El color de una ONU por su potencia (o su estado, si está caída). */
export function colorOnu(o) {
  if (!o) return '#cbd5e1'
  if (o.estado === 'los') return '#111827'
  if (o.estado === 'offline') return '#64748b'
  const rx = o.rx_power_dbm == null ? null : Number(o.rx_power_dbm)
  if (rx == null) return '#cbd5e1'
  if (rx >= -24) return '#16a34a'
  if (rx >= -27) return '#f59e0b'
  return '#dc2626'
}
