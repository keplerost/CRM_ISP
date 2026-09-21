/**
 * Vocabulario de la señal óptica.
 *
 * El umbral del taller es −27 dBm: por debajo de ahí el enlace empieza a perder
 * paquetes y el abonado llama. Pero avisar recién al cruzarlo llega tarde —una
 * señal que viene bajando de a poco se arregla con una visita programada, y la
 * misma señal descubierta el día que corta se arregla con una urgencia.
 *
 * Por eso hay una franja intermedia: todavía funciona, pero ya hay que mirarla.
 */

export const UMBRAL_DBM = -27
const ATENCION_DBM = -24

export const NIVELES = {
  buena: {
    label: 'Buena',
    clase: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
    punto: 'bg-emerald-400',
    ayuda: 'Por encima de −24 dBm.',
  },
  atencion: {
    label: 'Para mirar',
    clase: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
    punto: 'bg-amber-400',
    ayuda: 'Entre −24 y −27 dBm: funciona, pero conviene revisarla antes de que corte.',
  },
  mala: {
    label: 'Baja',
    clase: 'border-rose-500/50 bg-rose-500/15 text-rose-300',
    punto: 'bg-rose-500',
    ayuda: 'Por debajo de −27 dBm: pérdida de paquetes y cortes.',
  },
  sin_dato: {
    label: 'Sin lectura',
    clase: 'border-slate-700 bg-slate-800/60 text-slate-500',
    punto: 'bg-slate-600',
    ayuda: 'La ONT no reportó su óptica: está apagada o desconectada.',
  },
}

/**
 * Nivel de una lectura.
 *
 * `null` es "sin lectura", nunca "cero". Un 0 dBm sería una señal buenísima y
 * "no sé" es otra cosa: confundirlos pintaría de verde una ONT apagada.
 */
export function nivelDe(dbm) {
  if (dbm == null) return 'sin_dato'
  const n = Number(dbm)
  if (!Number.isFinite(n)) return 'sin_dato'
  if (n < UMBRAL_DBM) return 'mala'
  if (n < ATENCION_DBM) return 'atencion'
  return 'buena'
}

export const nivel = (dbm) => NIVELES[nivelDe(dbm)]

/** Agrupa por puerto PON, que es como se recorre una OLT en la realidad. */
export function porPuerto(onts) {
  const mapa = new Map()
  for (const o of onts) {
    const clave = `${o.slot}/${o.puerto}`
    if (!mapa.has(clave)) mapa.set(clave, { slot: o.slot, puerto: o.puerto, clave, onts: [] })
    mapa.get(clave).onts.push(o)
  }
  return [...mapa.values()]
    .map((p) => ({
      ...p,
      onts: p.onts.sort((a, b) => (a.ontId ?? a.onu_index) - (b.ontId ?? b.onu_index)),
      malas: p.onts.filter((o) => nivelDe(o.rx_dbm ?? o.rx_power_dbm) === 'mala').length,
      sinDato: p.onts.filter((o) => (o.rx_dbm ?? o.rx_power_dbm) == null).length,
    }))
    .sort((a, b) => a.slot - b.slot || a.puerto - b.puerto)
}

export const dbm = (v) => (v == null ? '—' : `${Number(v).toFixed(2)} dBm`)
