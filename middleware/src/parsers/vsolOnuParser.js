import { normalizarVsol, celdas } from '../lib/ansi.js'

/**
 * Parsers de la salida de una OLT V-SOL.
 *
 * EL PUNTO IMPORTANTE (docs/comandos-referencia.md § 1.6): esta CLI alinea las
 * columnas moviendo el cursor con ESC[<n>C, no con espacios. `normalizarVsol()`
 * convierte esos saltos en '|' y por eso acá se separa por '|' y NUNCA por /\s+/.
 * Un parser basado en espacios se rompe además porque el <n> del código ANSI
 * deja dígitos sueltos que parecen datos.
 */

const ES_SEPARADOR = (l) => /^[\s|+-]{5,}$/.test(l)
const ES_ENCABEZADO = (l) => /onu\s*index|onuindex|onu\s*id/i.test(l)

const aNumero = (v) => {
  const n = Number.parseInt(String(v).replace(/[^\d-]/g, ''), 10)
  return Number.isFinite(n) ? n : null
}

function filasDeTabla(salidaCruda) {
  return normalizarVsol(salidaCruda)
    .split('\n')
    .filter((l) => l.trim() && !ES_SEPARADOR(l) && !ES_ENCABEZADO(l))
    .map(celdas)
    .filter((c) => c.length >= 2)
}

/**
 * `show onu state all`
 * Columnas: OnuIndex | Admin State | OMCC State | Phase State | Channel
 */
export function parseOnuState(salidaCruda, puerto = null) {
  const resultado = []

  for (const c of filasDeTabla(salidaCruda)) {
    const indice = aNumero(c[0])
    // La primera celda tiene que ser el índice de la ONU. Si no lo es, la línea
    // es ruido (prompt, eco del comando, aviso del equipo).
    if (indice == null || !/^\d+$/.test(c[0].trim())) continue

    const phase = (c[3] || '').toLowerCase()
    resultado.push({
      onuIndex: indice,
      puerto,
      adminState: c[1] ?? null,
      omccState: c[2] ?? null,
      phaseState: c[3] ?? null,
      canal: c[4] ?? null,
      estado: phase.includes('working') ? 'online' : phase.includes('los') ? 'los' : 'offline',
    })
  }

  return resultado
}

/**
 * `show onu info all` / `show onu info <id>`
 * Columnas: OnuIndex | Model | Profile | PON Type | Auth Mode  (+ SN según firmware)
 */
export function parseOnuInfo(salidaCruda, puerto = null) {
  const resultado = []

  for (const c of filasDeTabla(salidaCruda)) {
    if (!/^\d+$/.test((c[0] || '').trim())) continue

    // El SN puede venir en cualquier columna según el firmware; lo buscamos por forma.
    const sn = c.find((v) => /^[0-9A-Za-z]{4}[0-9A-Fa-f]{8}$|^[0-9A-Fa-f]{12,16}$/.test(v)) || null

    resultado.push({
      onuIndex: aNumero(c[0]),
      puerto,
      modelo: c[1] ?? null,
      perfil: c[2] ?? null,
      tipoPon: c[3] ?? null,
      authMode: c[4] ?? null,
      sn: sn ? sn.toUpperCase() : null,
    })
  }

  return resultado
}

/**
 * `show onu auto-find`
 * ONUs detectadas y todavía sin registrar. Si no hay ninguna, la salida viene vacía.
 */
export function parseAutoFind(salidaCruda, puerto = null) {
  const salida = normalizarVsol(salidaCruda)
  if (/no\s+(onu|auto.?find)|not\s+found/i.test(salida)) return []

  const resultado = []

  for (const c of filasDeTabla(salidaCruda)) {
    const sn = c.find((v) => /^[0-9A-Za-z]{4}[0-9A-Fa-f]{8}$|^[0-9A-Fa-f]{12,16}$/.test(v))
    if (!sn) continue

    resultado.push({
      sn: sn.toUpperCase(),
      puerto,
      onuIndex: /^\d+$/.test((c[0] || '').trim()) ? aNumero(c[0]) : null,
      modelo: c.find((v) => v !== sn && /[A-Za-z]/.test(v) && !/^\d+$/.test(v)) ?? null,
    })
  }

  return resultado
}

/** `show onu distance <id>` → "onu 18 Distance: 1m" */
export function parseDistancia(salidaCruda) {
  const salida = normalizarVsol(salidaCruda)
  const m = salida.match(/distance\s*:?\s*(\d+)\s*m/i)
  return m ? Number.parseInt(m[1], 10) : null
}

/** `show onu optical-info <id>` / `show onu optical-transceiver-diagnosis <id>` */
export function parseOpticalInfo(salidaCruda) {
  const salida = normalizarVsol(salidaCruda)
  const buscar = (re) => {
    const m = salida.match(re)
    return m ? Number.parseFloat(m[1]) : null
  }

  const rx = buscar(/rx\s*(?:optical\s*)?power[^\-\d]*(-?\d+(?:\.\d+)?)/i)
  const tx = buscar(/tx\s*(?:optical\s*)?power[^\-\d]*(-?\d+(?:\.\d+)?)/i)
  if (rx == null && tx == null) return null

  return {
    rxPowerDbm: rx,
    txPowerDbm: tx,
    temperaturaC: buscar(/temperature[^\-\d]*(-?\d+(?:\.\d+)?)/i),
    voltajeV: buscar(/voltage[^\-\d]*(-?\d+(?:\.\d+)?)/i),
  }
}

/** `show onu statistics <id>` → contadores de tráfico */
export function parseStatistics(salidaCruda) {
  const salida = normalizarVsol(salidaCruda)
  const buscar = (re) => {
    const m = salida.match(re)
    return m ? Number(m[1]) : null
  }

  return {
    inputBytes: buscar(/input\s*bytes?\s*:?\s*(\d+)/i),
    outputBytes: buscar(/output\s*bytes?\s*:?\s*(\d+)/i),
    inputPackets: buscar(/input\s*packets?\s*:?\s*(\d+)/i),
    outputPackets: buscar(/output\s*packets?\s*:?\s*(\d+)/i),
  }
}

/** Detecta el rechazo de un comando por parte de la CLI V-SOL. */
export function detectarFallo(salidaCruda) {
  const salida = normalizarVsol(salidaCruda)
  const m = salida.match(/^\s*(%\s*.*|.*Invalid input.*|.*Unknown command.*|.*Error:.*)$/im)
  return m ? m[1].trim() : null
}
