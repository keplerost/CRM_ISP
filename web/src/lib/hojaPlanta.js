/**
 * Planta externa desde una planilla (Excel .xlsx o CSV), sin librerías.
 *
 *   · `armarPlantilla()` arma el .xlsx para descargar: hoja "Postes" con los
 *     encabezados y listas desplegables, y hoja "Instrucciones".
 *   · `leerHoja()` lee un .xlsx o .csv y devuelve las filas tal cual.
 *   · `filasAPlacemarks()` convierte esas filas en los mismos placemarks que
 *     salen de un KMZ, para que pasen por `clasificar()` igual que un KMZ: el
 *     resumen, lo de "A revisar", la ruta de los tendidos y el "Deshacer".
 *
 * Las columnas se reconocen por el nombre del encabezado, con sinónimos, así
 * que sirve la plantilla y también una planilla propia con otros nombres.
 * Las coordenadas aceptan decimales con punto o coma, grados-minutos-segundos
 * y UTM (columnas Este/Norte, o números grandes en Latitud/Longitud).
 */

import { armarZip, leerZip, metrosEntre, normal } from './kmz.js'

// ── Las columnas ─────────────────────────────────────────────────────────────

export const TIPOS_HOJA = ['Poste', 'NAP', 'Manga', 'Reserva', 'Nodo', 'Splitter', 'ODF']
const MATERIALES = ['Hormigón', 'Madera', 'Metal', 'Fibra de vidrio']

/**
 * Las columnas de la plantilla, en orden. `sinonimos` son los encabezados que
 * también se aceptan (ya normalizados: mayúsculas, sin tildes).
 */
export const COLUMNAS = [
  {
    clave: 'nombre', titulo: 'Nombre o código', ancho: 18, obligatoria: 'Recomendada', ejemplo: 'P-LM-001',
    ayuda: 'El rótulo o código del poste o la caja. Si se deja vacío entra como "Poste sin nombre".',
    sinonimos: ['NOMBRE', 'CODIGO', 'COD', 'ID', 'POSTE', 'NUMERO', 'NRO', 'N°', 'NO', 'ROTULO', 'IDENTIFICADOR', 'NAME'],
  },
  {
    clave: 'tipo', titulo: 'Tipo', ancho: 12, obligatoria: 'No (vacío = Poste)', ejemplo: 'Poste', lista: TIPOS_HOJA,
    ayuda: 'Poste, NAP, Manga, Reserva, Nodo, Splitter u ODF. Vacío se toma como Poste.',
    sinonimos: ['TIPO', 'ELEMENTO', 'CLASE', 'TYPE'],
  },
  {
    clave: 'latitud', titulo: 'Latitud', ancho: 13, obligatoria: 'Sí', ejemplo: -0.941234,
    ayuda: 'En grados decimales, negativa al sur del ecuador (La Maná ≈ -0.94). Con punto o coma.',
    sinonimos: ['LATITUD', 'LAT', 'Y', 'LATITUDE', 'COORDENADA Y'],
  },
  {
    clave: 'longitud', titulo: 'Longitud', ancho: 13, obligatoria: 'Sí', ejemplo: -79.224567,
    ayuda: 'En grados decimales, negativa al oeste (Ecuador ≈ -79). Con punto o coma.',
    sinonimos: ['LONGITUD', 'LON', 'LNG', 'LONG', 'X', 'LONGITUDE', 'COORDENADA X'],
  },
  {
    clave: 'herraje', titulo: 'Herraje', ancho: 9, obligatoria: 'No', ejemplo: 'A', lista: ['A', 'J'],
    ayuda: 'A = anclaje (retención), J = suspensión (paso). Vacío si el poste no tiene cable todavía.',
    sinonimos: ['HERRAJE', 'HERRAJES', 'TIPO DE HERRAJE', 'SUJECION'],
  },
  {
    clave: 'zona', titulo: 'Zona o tendido', ancho: 22, obligatoria: 'Recomendada', ejemplo: 'La Maná - Centro',
    ayuda:
      'Agrupa los postes (como una carpeta de Google Earth). Si los postes de un tendido van en el orden del cable y con herraje A/J, el sistema arma la ruta del cable uniéndolos.',
    sinonimos: ['ZONA', 'TENDIDO', 'CARPETA', 'SECTOR', 'RUTA', 'BARRIO', 'GRUPO', 'PROYECTO', 'RECORRIDO'],
  },
  {
    clave: 'estado', titulo: 'Estado', ancho: 12, obligatoria: 'No (vacío = Existente)', ejemplo: 'Existente',
    lista: ['Existente', 'Proyectado'],
    ayuda: 'Existente: ya está en la calle. Proyectado: se planea poner.',
    sinonimos: ['ESTADO', 'SITUACION', 'STATUS'],
  },
  {
    clave: 'material', titulo: 'Material', ancho: 14, obligatoria: 'No', ejemplo: 'Hormigón', lista: MATERIALES,
    ayuda: 'Hormigón, madera, metal… Se guarda en la descripción.',
    sinonimos: ['MATERIAL', 'TIPO DE POSTE', 'MATERIAL DEL POSTE'],
  },
  {
    clave: 'altura', titulo: 'Altura (m)', ancho: 10, obligatoria: 'No', ejemplo: 9,
    ayuda: 'Altura del poste en metros. Se guarda en la descripción.',
    sinonimos: ['ALTURA', 'ALTURA (M)', 'ALTURA M', 'METROS DE ALTURA', 'ALTO'],
  },
  {
    clave: 'propietario', titulo: 'Propietario', ancho: 14, obligatoria: 'No', ejemplo: 'CNEL',
    ayuda: 'De quién es el poste: CNEL, CNT, propio… Se guarda en la descripción.',
    sinonimos: ['PROPIETARIO', 'DUENO', 'PROPIEDAD', 'EMPRESA', 'OPERADOR'],
  },
  {
    clave: 'hilos', titulo: 'Hilos (manga)', ancho: 12, obligatoria: 'No', ejemplo: '',
    ayuda: 'Solo para mangas: cuántos hilos tiene el cable que empalma.',
    sinonimos: ['HILOS', 'HILOS (MANGA)', 'FIBRAS', 'N HILOS'],
  },
  {
    clave: 'puertos', titulo: 'Puertos (NAP)', ancho: 12, obligatoria: 'No', ejemplo: '',
    ayuda: 'Solo para cajas NAP: cuántos puertos tiene (8, 16…).',
    sinonimos: ['PUERTOS', 'PUERTOS (NAP)', 'CAPACIDAD', 'SALIDAS'],
  },
  {
    clave: 'splitter', titulo: 'Splitter', ancho: 10, obligatoria: 'No', ejemplo: '',
    lista: ['1:2', '1:4', '1:8', '1:16', '1:32'],
    ayuda: 'Para NAP o splitter: la división (1:8, 1:16…).',
    sinonimos: ['SPLITTER', 'DIVISION', 'SPLITER'],
  },
  {
    clave: 'metros', titulo: 'Metros (reserva)', ancho: 14, obligatoria: 'No', ejemplo: '',
    ayuda: 'Solo para reservas: cuántos metros de cable hay enrollados.',
    sinonimos: ['METROS', 'METROS (RESERVA)', 'RESERVA', 'MTS'],
  },
  {
    clave: 'observacion', titulo: 'Observación', ancho: 30, obligatoria: 'No', ejemplo: 'Frente a la escuela',
    ayuda: 'Cualquier dato extra: referencia, daño, si está inclinado…',
    sinonimos: ['OBSERVACION', 'OBSERVACIONES', 'DESCRIPCION', 'NOTA', 'NOTAS', 'COMENTARIO', 'REFERENCIA', 'DIRECCION'],
  },
]

/** Columnas que no están en la plantilla pero se aceptan. */
const EXTRA = [
  { clave: 'este', sinonimos: ['ESTE', 'UTM ESTE', 'ESTE (UTM)', 'EASTING', 'X UTM', 'UTM X', 'COORDENADA ESTE'] },
  { clave: 'norte', sinonimos: ['NORTE', 'UTM NORTE', 'NORTE (UTM)', 'NORTHING', 'Y UTM', 'UTM Y', 'COORDENADA NORTE'] },
  { clave: 'coordenadas', sinonimos: ['COORDENADAS', 'COORDENADA', 'UBICACION', 'GPS', 'LAT, LONG', 'LAT,LONG', 'LATITUD, LONGITUD'] },
]

const limpiarEnc = (t) => normal(t).replace(/[_.]/g, ' ').replace(/\s+/g, ' ').trim()

/** La clave de un encabezado, o null si no se reconoce. */
export function claveDeEncabezado(texto) {
  const t = limpiarEnc(texto)
  if (!t) return null
  for (const c of [...COLUMNAS, ...EXTRA]) {
    if (limpiarEnc(c.titulo ?? '') === t || c.sinonimos.includes(t)) return c.clave
  }
  // "Latitud (decimal)", "Longitud WGS84"…: por la primera palabra.
  const primera = t.split(/[\s(]/)[0]
  for (const c of [...COLUMNAS, ...EXTRA]) if (c.sinonimos.includes(primera)) return c.clave
  return null
}

// ── Coordenadas ──────────────────────────────────────────────────────────────

/**
 * Un número de coordenada desde lo que venga en la celda:
 * -0.94123 · "-0,94123" · "0°56'28.4\"S" · "79 13 28.4 O".
 */
export function numeroCoordenada(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  let t = String(v).trim().replace(/ /g, ' ')
  if (!t) return null
  const dms = t.match(/^([-+])?\s*(\d{1,3})\s*[°º:\s]\s*(\d{1,2}(?:[.,]\d+)?)?\s*['’′:\s]?\s*(\d{1,2}(?:[.,]\d+)?)?\s*["”″]?\s*([NSEOWnseow])?$/)
  if (dms && (dms[3] != null || /[°º]/.test(t))) {
    const n = (x) => (x == null ? 0 : Number(String(x).replace(',', '.')))
    let g = n(dms[2]) + n(dms[3]) / 60 + n(dms[4]) / 3600
    if (dms[1] === '-' || /[SOWsow]/.test(dms[5] ?? '')) g = -g
    return g
  }
  // Separador de miles con punto y decimal con coma ("9.895.123,5") o solo coma decimal.
  if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.')
  else if (/^[-+]?\d+,\d+$/.test(t)) t = t.replace(',', '.')
  const x = Number(t)
  return Number.isFinite(x) ? x : null
}

/** "-0.94, -79.22" · "-0,94; -79,22" · "-0.94 -79.22" → [lat, lng] (sin validar). */
function partirCoordenadas(v) {
  const t = String(v ?? '').trim()
  if (!t) return null
  let partes
  if (t.includes(';')) partes = t.split(';')
  else if (/^\s*[-+]?\d+(\.\d+)?\s*,\s*[-+]?\d+(\.\d+)?\s*$/.test(t)) partes = t.split(',')
  else partes = t.split(/\s+/)
  if (partes.length !== 2) return null
  const [a, b] = partes.map(numeroCoordenada)
  return a == null || b == null ? null : [a, b]
}

/** UTM (WGS84) → [lat, lng]. `sur`: la zona es del hemisferio sur (Ecuador: 17 Sur). */
export function utmALatLng(este, norte, zona = 17, sur = true) {
  const a = 6378137
  const f = 1 / 298.257223563
  const k0 = 0.9996
  const e2 = f * (2 - f)
  const ep2 = e2 / (1 - e2)
  const x = este - 500000
  const y = sur ? norte - 10000000 : norte
  const mu = y / k0 / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256))
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2))
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu)
  const s = Math.sin(phi1)
  const c = Math.cos(phi1)
  const n1 = a / Math.sqrt(1 - e2 * s ** 2)
  const t1 = Math.tan(phi1) ** 2
  const c1 = ep2 * c ** 2
  const r1 = (a * (1 - e2)) / (1 - e2 * s ** 2) ** 1.5
  const d = x / (n1 * k0)
  const lat =
    phi1 -
    ((n1 * Math.tan(phi1)) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6) / 720)
  const lng0 = (((zona - 1) * 6 - 180 + 3) * Math.PI) / 180
  const lng =
    lng0 +
    (d - ((1 + 2 * t1 + c1) * d ** 3) / 6 + ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5) / 120) / c
  return [(lat * 180) / Math.PI, (lng * 180) / Math.PI]
}

// ── Leer la planilla ─────────────────────────────────────────────────────────

const desescapar = (t) =>
  String(t)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')

/** El texto de un <si> o <is>: junta todos los <t>, también los de texto enriquecido. */
const textoDe = (xml) => desescapar([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''))

/** "AB12" → 27 (base 0). */
function columnaDe(ref) {
  const letras = String(ref).match(/^[A-Z]+/i)?.[0].toUpperCase() ?? 'A'
  let n = 0
  for (const l of letras) n = n * 26 + (l.charCodeAt(0) - 64)
  return n - 1
}

/** Las hojas de un .xlsx: [{ nombre, filas: [[valor]] }]. */
export async function leerXlsx(buffer) {
  const zip = await leerZip(buffer)
  const dec = new TextDecoder()
  const archivo = (ruta) => {
    const k = Object.keys(zip).find((x) => x.replace(/^\/+/, '').toLowerCase() === ruta.toLowerCase())
    return k ? dec.decode(zip[k]) : null
  }
  const libro = archivo('xl/workbook.xml')
  if (!libro) throw new Error('El archivo no es un Excel .xlsx válido. Si es un .xls viejo, guardalo como .xlsx.')
  const rels = archivo('xl/_rels/workbook.xml.rels') ?? ''
  const destino = {}
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1]
    const t = m[0].match(/\bTarget="([^"]+)"/)?.[1]
    if (id && t) destino[id] = t.startsWith('/') ? t.slice(1) : `xl/${t}`
  }
  const compartidos = [...(archivo('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textoDe(m[1]))

  const hojas = []
  for (const m of libro.matchAll(/<sheet\b[^>]*>/g)) {
    const nombre = desescapar(m[0].match(/\bname="([^"]*)"/)?.[1] ?? '')
    const rid = m[0].match(/\br:id="([^"]+)"/)?.[1] ?? m[0].match(/\bid="([^"]+)"/)?.[1]
    const xml = rid && destino[rid] ? archivo(destino[rid]) : null
    if (!xml) continue
    const filas = []
    for (const f of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const nFila = Number(f[1].match(/\br="(\d+)"/)?.[1] ?? filas.length + 1) - 1
      const fila = []
      let col = 0
      for (const c of f[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]
        const ref = attrs.match(/\br="([A-Z]+)\d*"/i)?.[1]
        if (ref) col = columnaDe(ref)
        const tipo = attrs.match(/\bt="([^"]+)"/)?.[1]
        const cuerpo = c[2] ?? ''
        const v = cuerpo.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        let valor = null
        if (tipo === 's') valor = compartidos[Number(v)] ?? ''
        else if (tipo === 'inlineStr') valor = textoDe(cuerpo)
        else if (tipo === 'str' || tipo === 'e') valor = v != null ? desescapar(v) : ''
        else if (tipo === 'b') valor = v === '1'
        else if (v != null) valor = Number(v)
        fila[col] = valor
        col += 1
      }
      filas[nFila] = fila
    }
    hojas.push({ nombre, filas: Array.from(filas, (x) => x ?? []) })
  }
  return hojas
}

/** Un CSV: detecta el separador (; , o tabulador) y respeta las comillas. */
export function leerCsv(texto) {
  const t = String(texto).replace(/^﻿/, '')
  const primera = t.split(/\r?\n/).find((l) => l.trim()) ?? ''
  const sep = [';', '\t', ','].map((s) => [s, primera.split(s).length]).sort((a, b) => b[1] - a[1])[0][0]
  const filas = []
  let fila = []
  let campo = ''
  let comillas = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (comillas) {
      if (ch === '"' && t[i + 1] === '"') {
        campo += '"'
        i++
      } else if (ch === '"') comillas = false
      else campo += ch
    } else if (ch === '"') comillas = true
    else if (ch === sep) {
      fila.push(campo)
      campo = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++
      fila.push(campo)
      filas.push(fila)
      fila = []
      campo = ''
    } else campo += ch
  }
  if (campo || fila.length) {
    fila.push(campo)
    filas.push(fila)
  }
  return filas
}

/** Texto de un CSV: UTF-8, y si no lo es, el de Windows que usa Excel en español. */
function decodificarCsv(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('windows-1252').decode(buffer)
  }
}

/**
 * Las filas de la planilla, de la hoja que tenga encabezados reconocibles
 * (la hoja "Postes" de la plantilla, o la primera que sirva).
 */
export async function leerHoja(nombreArchivo, buffer) {
  if (/\.(csv|txt|tsv)$/i.test(nombreArchivo)) return { hoja: null, filas: leerCsv(decodificarCsv(buffer)) }
  if (/\.xls$/i.test(nombreArchivo)) throw new Error('Los .xls viejos no se pueden leer: en Excel, "Guardar como" → Libro de Excel (.xlsx).')
  const hojas = await leerXlsx(buffer)
  const util = hojas.find((h) => buscarEncabezado(h.filas)) ?? hojas.find((h) => h.filas.length)
  if (!util) throw new Error('El Excel no tiene datos.')
  return { hoja: util.nombre, filas: util.filas }
}

/** La fila de encabezados (de las primeras 15) y qué columna es cada cosa. */
export function buscarEncabezado(filas) {
  for (let i = 0; i < Math.min(filas.length, 15); i++) {
    const mapa = {}
    const ignoradas = []
    ;(filas[i] ?? []).forEach((v, j) => {
      if (v == null || String(v).trim() === '') return
      const k = claveDeEncabezado(v)
      if (k && mapa[k] == null) mapa[k] = j
      else if (!k) ignoradas.push(String(v).trim())
    })
    const conUbicacion = (mapa.latitud != null && mapa.longitud != null) || (mapa.este != null && mapa.norte != null) || mapa.coordenadas != null
    if (conUbicacion) return { fila: i, mapa, ignoradas }
  }
  return null
}

// ── De filas a placemarks ────────────────────────────────────────────────────

const texto = (v) => (v == null ? '' : String(v).replace(/ /g, ' ').trim())

function tipoDeCelda(v) {
  const t = normal(v)
  if (!t) return { tipo: 'poste' }
  if (/^POSTE/.test(t)) return { tipo: 'poste' }
  if (/^(NAP|CAJA|CTO)/.test(t)) return { tipo: 'nap' }
  if (/MANGA|EMPALME/.test(t)) return { tipo: 'manga' }
  if (/RESERVA/.test(t)) return { tipo: 'reserva' }
  if (/NODO/.test(t)) return { tipo: 'nodo' }
  if (/SPLI?T+ER/.test(t)) return { tipo: 'splitter' }
  if (/ODF/.test(t)) return { tipo: 'odf' }
  return { tipo: 'otro', aviso: `Tipo "${texto(v)}" no reconocido` }
}

function herrajeDeCelda(v) {
  const t = normal(v)
  if (!t) return null
  if (/^A\b|ANCLAJE|RETENCION|TERMINAL/.test(t)) return 'A'
  if (/^J\b|SUSPENSION|PASO/.test(t)) return 'J'
  return null
}

function estadoDeCelda(v) {
  const t = normal(v)
  if (!t) return undefined
  if (/PROYECT|PLANIF|NUEVO|POR (PONER|INSTALAR)/.test(t)) return 'proyectado'
  if (/RETIRAD|BAJA/.test(t)) return 'retirado'
  return 'existente'
}

const entero = (v) => {
  const n = numeroCoordenada(v)
  return n != null && n > 0 ? Math.round(n) : null
}

function splitterDeCelda(v) {
  const m = normal(v).match(/(?:1\s*[:/x]\s*)?(\d{1,2})$/)
  return m ? `1:${m[1]}` : null
}

const dentro = ([la, lo]) => Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0)

/**
 * Las filas → placemarks como los del KMZ, más lo que la planilla dice
 * explícito (tipo, herraje, estado…), que `clasificar()` respeta.
 *
 * Devuelve { placemarks, sinUbicar: [{ fila, nombre, motivo }], encabezado, usaUtm }.
 * `fila` es el número de fila como lo ve Excel (1 = la primera).
 */
export function filasAPlacemarks(filas, { carpeta = 'Planilla', zonaUtm = 17, sur = true } = {}) {
  const enc = buscarEncabezado(filas)
  if (!enc) {
    throw new Error(
      'No encontré las columnas de ubicación. La planilla tiene que tener encabezados "Latitud" y "Longitud" (o "Este" y "Norte" si es UTM). Descargá la plantilla para ver el formato.',
    )
  }
  const { mapa } = enc
  const celda = (fila, k) => (mapa[k] == null ? null : fila[mapa[k]])
  const placemarks = []
  const sinUbicar = []
  let usaUtm = false

  for (let i = enc.fila + 1; i < filas.length; i++) {
    const fila = filas[i] ?? []
    if (!fila.some((v) => texto(v) !== '')) continue
    const nFila = i + 1
    const nombre = texto(celda(fila, 'nombre'))
    const revisar = []

    // Ubicación: Latitud/Longitud, Este/Norte o una sola columna "Coordenadas".
    let lat = numeroCoordenada(celda(fila, 'latitud'))
    let lng = numeroCoordenada(celda(fila, 'longitud'))
    if ((lat == null || lng == null) && mapa.coordenadas != null) {
      const par = partirCoordenadas(celda(fila, 'coordenadas'))
      if (par) [lat, lng] = par
    }
    let este = numeroCoordenada(celda(fila, 'este'))
    let norte = numeroCoordenada(celda(fila, 'norte'))
    if ((este == null || norte == null) && lat != null && lng != null && Math.abs(lat) > 180 && Math.abs(lng) > 180) {
      // UTM escrito en las columnas de latitud/longitud: el norte es el número grande.
      ;[norte, este] = Math.abs(lat) > Math.abs(lng) ? [lat, lng] : [lng, lat]
    }
    if ((lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) && este != null && norte != null) {
      ;[lat, lng] = utmALatLng(Math.abs(este), Math.abs(norte), zonaUtm, sur)
      usaUtm = true
    }
    if (lat == null || lng == null) {
      sinUbicar.push({ fila: nFila, nombre, motivo: 'Sin coordenadas' })
      continue
    }
    // Latitud y longitud cruzadas: en América la longitud siempre es la mayor.
    if (Math.abs(lat) > Math.abs(lng) && Math.abs(lat) <= 180) {
      ;[lat, lng] = [lng, lat]
      revisar.push('Latitud y longitud venían cruzadas: se dieron vuelta')
    }
    if (!dentro([lat, lng])) {
      sinUbicar.push({ fila: nFila, nombre, motivo: `Coordenadas imposibles (${lat}, ${lng})` })
      continue
    }

    const { tipo, aviso } = tipoDeCelda(celda(fila, 'tipo'))
    if (aviso) revisar.push(aviso)
    const herrajeTxt = texto(celda(fila, 'herraje'))
    const herraje = herrajeDeCelda(herrajeTxt)
    if (herrajeTxt && !herraje) revisar.push(`Herraje "${herrajeTxt}" no es A ni J`)

    const altura = texto(celda(fila, 'altura'))
    const descripcion = [
      texto(celda(fila, 'material')) && `Material: ${texto(celda(fila, 'material'))}`,
      altura && `Altura: ${altura}${/^\d+([.,]\d+)?$/.test(altura) ? ' m' : ''}`,
      texto(celda(fila, 'propietario')) && `Propietario: ${texto(celda(fila, 'propietario'))}`,
      herrajeTxt && !herraje && `Herraje: ${herrajeTxt}`,
      texto(celda(fila, 'observacion')),
    ]
      .filter(Boolean)
      .join(' · ')

    const p = {
      carpeta: texto(celda(fila, 'zona')) || carpeta,
      nombre,
      descripcion,
      datos: {},
      estilo: '',
      geom: 'punto',
      coords: [[lat, lng]],
      fila: nFila,
      tipo,
      estado: estadoDeCelda(celda(fila, 'estado')),
      revisar,
    }
    if (herraje) p.herraje = herraje
    if (tipo === 'manga') p.hilos = entero(celda(fila, 'hilos'))
    if (tipo === 'nap') p.capacidad = entero(celda(fila, 'puertos'))
    if (tipo === 'nap' || tipo === 'splitter') p.splitter = texto(celda(fila, 'splitter')) ? splitterDeCelda(celda(fila, 'splitter')) : null
    if (tipo === 'reserva') {
      const m = numeroCoordenada(celda(fila, 'metros'))
      if (m != null && m >= 0) p.metros = m
    }
    placemarks.push(p)
  }

  // Repetidos: dos filas del mismo tipo en el mismo lugar (a menos de 1 m).
  for (let i = 0; i < placemarks.length; i++) {
    for (let j = i + 1; j < placemarks.length; j++) {
      const a = placemarks[i]
      const b = placemarks[j]
      if (a.tipo === b.tipo && metrosEntre(a.coords[0], b.coords[0]) < 1) {
        b.revisar.push(`Mismo lugar que la fila ${a.fila}${a.nombre ? ` (${a.nombre})` : ''}: ¿repetido?`)
      }
    }
  }

  return { placemarks, sinUbicar, encabezado: enc, usaUtm }
}

// ── La plantilla ─────────────────────────────────────────────────────────────

const esc = (t) =>
  String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function letra(n) {
  let s = ''
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** Una celda: número, o texto en línea. `s` es el índice del estilo. */
function celdaXml(ref, v, s = 0) {
  const st = s ? ` s="${s}"` : ''
  if (v == null || v === '') return s ? `<c r="${ref}"${st}/>` : ''
  if (typeof v === 'number') return `<c r="${ref}"${st}><v>${v}</v></c>`
  return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`
}

/**
 * Una hoja: { filas: [[v | { v, s }]], anchos: [n], congelar, listas: [{ col, valores, hasta }], seleccionada }.
 */
function hojaXml({ filas, anchos = [], congelar = false, listas = [], seleccionada = false }) {
  const vista = `<sheetViews><sheetView workbookViewId="0"${seleccionada ? ' tabSelected="1"' : ''}>${
    congelar ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : ''
  }</sheetView></sheetViews>`
  const cols = anchos.length
    ? `<cols>${anchos.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : ''
  const datos = filas
    .map((fila, i) => {
      const celdas = fila
        .map((x, j) => {
          const o = x != null && typeof x === 'object' ? x : { v: x }
          return celdaXml(`${letra(j)}${i + 1}`, o.v, o.s ?? 0)
        })
        .join('')
      return `<row r="${i + 1}">${celdas}</row>`
    })
    .join('')
  const val = listas.length
    ? `<dataValidations count="${listas.length}">${listas
        .map(
          (l) =>
            `<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorStyle="warning" errorTitle="Valor fuera de la lista" error="Ese valor no está en la lista. Igual se puede guardar." sqref="${letra(l.col)}2:${letra(l.col)}${l.hasta ?? 5000}"><formula1>"${esc(l.valores.join(','))}"</formula1></dataValidation>`,
        )
        .join('')}</dataValidations>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${vista}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${datos}</sheetData>${val}</worksheet>`
}

/** Un .xlsx con las hojas dadas: [{ nombre, ...hojaXml }] → Uint8Array. */
export function armarXlsx(hojas) {
  const enc = new TextEncoder()
  const estilos = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`
  const archivos = [
    {
      nombre: '[Content_Types].xml',
      datos: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${hojas
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('')}</Types>`),
    },
    {
      nombre: '_rels/.rels',
      datos: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    },
    {
      nombre: 'xl/workbook.xml',
      datos: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${hojas
        .map((h, i) => `<sheet name="${esc(h.nombre)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`),
    },
    {
      nombre: 'xl/_rels/workbook.xml.rels',
      datos: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${hojas
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    },
    { nombre: 'xl/styles.xml', datos: enc.encode(estilos) },
    ...hojas.map((h, i) => ({ nombre: `xl/worksheets/sheet${i + 1}.xml`, datos: enc.encode(hojaXml({ ...h, seleccionada: i === 0 })) })),
  ]
  return armarZip(archivos)
}

/** La plantilla para descargar: hoja "Postes" vacía con encabezados, e "Instrucciones". */
export function armarPlantilla() {
  const H = 1 // estilo encabezado
  const T = 2 // título
  const W = 3 // texto con ajuste
  const B = 4 // subtítulo
  const postes = {
    nombre: 'Postes',
    filas: [COLUMNAS.map((c) => ({ v: c.titulo, s: H }))],
    anchos: COLUMNAS.map((c) => c.ancho),
    congelar: true,
    listas: COLUMNAS.map((c, col) => (c.lista ? { col, valores: c.lista } : null)).filter(Boolean),
  }
  const instrucciones = {
    nombre: 'Instrucciones',
    anchos: [20, 22, 70, 20],
    filas: [
      [{ v: 'Plantilla de postería y planta externa', s: T }],
      [{ v: 'Una fila por poste (o caja, manga, reserva…). Llená la hoja "Postes" desde la fila 2, sin cambiar los encabezados, y subila en Planta externa → Importar.', s: W }],
      [{ v: 'Solo Latitud y Longitud son obligatorias. Lo que no sepas, dejalo vacío.', s: W }],
      [],
      [{ v: 'Columna', s: H }, { v: 'Obligatoria', s: H }, { v: 'Qué poner', s: H }, { v: 'Ejemplo', s: H }],
      ...COLUMNAS.map((c) => [
        { v: c.titulo, s: B },
        { v: c.obligatoria, s: W },
        { v: c.ayuda + (c.lista ? ` Opciones: ${c.lista.join(', ')}.` : ''), s: W },
        c.ejemplo === '' ? '' : c.ejemplo,
      ]),
      [],
      [{ v: 'Coordenadas', s: B }],
      [{ v: 'Se aceptan con punto o con coma decimal (-0.941234 o -0,941234), y en grados-minutos-segundos (0°56\'28.4"S).', s: W }],
      [{ v: 'Tomalas desde Google Maps: mantené apretado sobre el poste y copiá los dos números que aparecen arriba (el primero es la latitud).', s: W }],
      [{ v: 'Si las tenés en UTM (números grandes como 698543 y 9895123), poné dos columnas "Este" y "Norte" en vez de Latitud y Longitud. Al subir se elige la zona (Ecuador: 17 Sur).', s: W }],
      [],
      [{ v: 'Tendidos', s: B }],
      [{ v: 'Si en "Zona o tendido" agrupás los postes de un mismo cable, en el orden en que pasa el cable y con herraje A o J, el sistema dibuja la ruta del cable uniéndolos (se puede apagar al importar).', s: W }],
      [],
      [{ v: 'Al subir', s: B }],
      [{ v: 'Antes de guardar se muestra cuántos elementos entran y qué filas no tienen coordenadas. Todo entra como "importado (sin verificar)" y la importación se puede deshacer.', s: W }],
    ],
  }
  return armarXlsx([postes, instrucciones])
}
