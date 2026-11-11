/**
 * KMZ y KML de la planta externa (migración 234), sin librerías.
 *
 *   · leer un KMZ (es un ZIP con un doc.kml adentro) y sus placemarks;
 *   · clasificarlos: qué es poste, NAP, manga, reserva, cable… a partir de la
 *     carpeta, el nombre y la descripción, que es lo único que trae un KMZ
 *     dibujado a mano en Google Earth;
 *   · armar el KMZ de vuelta para abrirlo en Google Earth.
 *
 * La clasificación y el ZIP son funciones puras para poder probarlas. Lo único
 * que necesita el navegador es `DOMParser`, en `leerPlacemarks`.
 *
 * ── Lo que no se adivina ──
 *
 * El importador no descarta nada ni inventa nada. Lo que ve raro (sin nombre,
 * duplicado, lejos del resto, ruta armada uniendo postes) entra igual y queda
 * en `revisar`, para que una persona decida.
 */

// ── ZIP ──────────────────────────────────────────────────────────────────────

const TABLA_CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = TABLA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Arma un ZIP sin comprimir con los archivos dados ({ nombre, datos: Uint8Array }).
 * Google Earth abre igual un KMZ sin comprimir, y así no hace falta deflate.
 */
export function armarZip(archivos) {
  const enc = new TextEncoder()
  const partes = []
  const central = []
  let offset = 0
  for (const a of archivos) {
    const nombre = enc.encode(a.nombre)
    const datos = a.datos
    const crc = crc32(datos)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true) // nombres en UTF-8
    local.setUint16(8, 0, true) // sin comprimir
    local.setUint32(14, crc, true)
    local.setUint32(18, datos.length, true)
    local.setUint32(22, datos.length, true)
    local.setUint16(26, nombre.length, true)
    partes.push(new Uint8Array(local.buffer), nombre, datos)

    const c = new DataView(new ArrayBuffer(46))
    c.setUint32(0, 0x02014b50, true)
    c.setUint16(4, 20, true)
    c.setUint16(6, 20, true)
    c.setUint16(8, 0x0800, true)
    c.setUint32(16, crc, true)
    c.setUint32(20, datos.length, true)
    c.setUint32(24, datos.length, true)
    c.setUint16(28, nombre.length, true)
    c.setUint32(42, offset, true)
    central.push(new Uint8Array(c.buffer), nombre)
    offset += 30 + nombre.length + datos.length
  }
  const tamCentral = central.reduce((s, x) => s + x.length, 0)
  const fin = new DataView(new ArrayBuffer(22))
  fin.setUint32(0, 0x06054b50, true)
  fin.setUint16(8, archivos.length, true)
  fin.setUint16(10, archivos.length, true)
  fin.setUint32(12, tamCentral, true)
  fin.setUint32(16, offset, true)
  const todo = [...partes, ...central, new Uint8Array(fin.buffer)]
  const salida = new Uint8Array(todo.reduce((s, x) => s + x.length, 0))
  let p = 0
  for (const x of todo) {
    salida.set(x, p)
    p += x.length
  }
  return salida
}

async function inflar(bytes) {
  const flujo = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(flujo).arrayBuffer())
}

/** Lee un ZIP: { nombre → Uint8Array }. Soporta "sin comprimir" y deflate. */
export async function leerZip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let fin = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      fin = i
      break
    }
  }
  if (fin < 0) throw new Error('El archivo no es un KMZ válido (no se encontró el índice del ZIP).')
  const total = v.getUint16(fin + 10, true)
  let p = v.getUint32(fin + 16, true)
  const dec = new TextDecoder()
  const salida = {}
  for (let n = 0; n < total; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break
    const metodo = v.getUint16(p + 10, true)
    const tamComp = v.getUint32(p + 20, true)
    const largoNombre = v.getUint16(p + 28, true)
    const largoExtra = v.getUint16(p + 30, true)
    const largoCom = v.getUint16(p + 32, true)
    const local = v.getUint32(p + 42, true)
    const nombre = dec.decode(bytes.subarray(p + 46, p + 46 + largoNombre))
    const inicio = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
    const datos = bytes.subarray(inicio, inicio + tamComp)
    if (!nombre.endsWith('/')) {
      if (metodo === 0) salida[nombre] = datos
      else if (metodo === 8) salida[nombre] = await inflar(datos)
    }
    p += 46 + largoNombre + largoExtra + largoCom
  }
  return salida
}

/** El texto del KML de un archivo .kmz o .kml. */
export async function textoKml(nombreArchivo, buffer) {
  if (/\.kml$/i.test(nombreArchivo)) return new TextDecoder().decode(buffer)
  const archivos = await leerZip(buffer)
  const kml = Object.keys(archivos).find((k) => /(^|\/)doc\.kml$/i.test(k)) ?? Object.keys(archivos).find((k) => /\.kml$/i.test(k))
  if (!kml) throw new Error('El KMZ no trae ningún archivo .kml adentro.')
  return new TextDecoder().decode(archivos[kml])
}

// ── Leer los placemarks (navegador) ──────────────────────────────────────────

const limpiarHtml = (t) =>
  String(t ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

function coordenadas(texto) {
  return String(texto ?? '')
    .trim()
    .split(/\s+/)
    .map((c) => c.split(',').map(Number))
    .filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
    .map(([lng, lat]) => [lat, lng])
}

/**
 * Los placemarks del KML como objetos planos, en el orden del archivo:
 * { carpeta, nombre, descripcion, datos, estilo, geom: 'punto'|'linea'|'poligono', coords: [[lat,lng]] }
 */
export function leerPlacemarks(kmlTexto) {
  const doc = new DOMParser().parseFromString(kmlTexto, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('El KML tiene un error de formato.')
  const hijo = (e, tag) => [...e.children].find((x) => x.localName === tag)
  const texto = (e, tag) => hijo(e, tag)?.textContent?.trim() ?? ''
  const salida = []

  function recorrer(nodo, ruta) {
    for (const e of nodo.children) {
      if (e.localName === 'Folder' || e.localName === 'Document') {
        const n = texto(e, 'name')
        recorrer(e, e.localName === 'Folder' ? [...ruta, n] : ruta)
      } else if (e.localName === 'Placemark') {
        const datos = {}
        for (const d of e.getElementsByTagNameNS('*', 'Data')) {
          const v = [...d.children].find((x) => x.localName === 'value')
          datos[d.getAttribute('name')] = v?.textContent?.trim() ?? ''
        }
        for (const d of e.getElementsByTagNameNS('*', 'SimpleData')) datos[d.getAttribute('name')] = d.textContent.trim()
        const punto = e.getElementsByTagNameNS('*', 'Point')[0]
        const linea = e.getElementsByTagNameNS('*', 'LineString')[0]
        const poli = e.getElementsByTagNameNS('*', 'Polygon')[0]
        const geo = punto ?? linea ?? poli
        if (!geo) continue
        const c = geo.getElementsByTagNameNS('*', 'coordinates')[0]
        salida.push({
          carpeta: ruta.join(' / '),
          nombre: texto(e, 'name'),
          descripcion: limpiarHtml(texto(e, 'description')),
          datos,
          estilo: texto(e, 'styleUrl'),
          geom: punto ? 'punto' : linea ? 'linea' : 'poligono',
          coords: coordenadas(c?.textContent),
        })
      }
    }
  }
  recorrer(doc.documentElement, [])
  return salida
}

// ── Clasificar ───────────────────────────────────────────────────────────────

/** Mayúsculas y sin tildes, para comparar. */
export const normal = (t) =>
  String(t ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ /g, ' ')
    .toUpperCase()
    .trim()

export function metrosEntre([la1, lo1], [la2, lo2]) {
  const r = Math.PI / 180
  const a =
    Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(a))
}

export const largoRuta = (ruta) => ruta.slice(1).reduce((s, p, i) => s + metrosEntre(ruta[i], p), 0)

const COLORES_HILO = [
  'AZUL', 'NARANJA', 'VERDE', 'CAFE', 'GRIS', 'BLANCO', 'ROJO', 'NEGRO', 'AMARILLO', 'VIOLETA', 'ROSADO', 'AQUA', 'TURQUESA',
]

/** "24 HILOS", "ADSS-24-HILOS", "48FO", "FIBRA DE 8", "DROP 2 HILOS" → número de hilos. */
export function hilosDe(texto) {
  const t = normal(texto)
  const m =
    t.match(/(\d{1,3})\s*-?\s*(?:HILOS?|FO\b|F\.O\b|H\b)/) ??
    t.match(/(?:FIBRA|CABLE|MANGA)\s+(?:DE\s+)?(\d{1,3})\b/) ??
    t.match(/\bDE\s+(\d{1,3})\s+HILOS/)
  const n = m ? Number(m[1]) : null
  return n && n <= 288 ? n : null
}

/** "RESERVA DE 50", "50 mtrs", "4005 mtrs" → metros. */
export function metrosDe(texto) {
  const t = normal(texto)
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:M\b|MT|MTS|MTRS|METROS|MMTTA|NTRS)/) ?? t.match(/RESERVA\s+(?:DE\s+)?(\d+)/)
  return m ? Number(m[1].replace(',', '.')) : null
}

const GENERICOS = /^(NAP|MANGA|MINI MANGA|RESERVA|POSTE|PUNTO|SIN NOMBRE|BASE|NODO)[\s\-_.#]*\d*$/

/** El nombre útil: el del placemark, o el campo "nombre" de la descripción si dice más. */
function mejorNombre(p) {
  const propio = String(p.nombre ?? '').replace(/ /g, ' ').trim()
  const campo = Object.entries(p.datos ?? {}).find(([k]) => normal(k) === 'NOMBRE')?.[1]?.trim() ?? ''
  if (campo && (!propio || GENERICOS.test(normal(propio)))) return campo
  return propio || campo
}

/** La descripción sin la plantilla vacía de Google My Maps ("Descripción: nombre: descripción:"). */
function mejorDescripcion(p) {
  const campos = Object.entries(p.datos ?? {})
    .filter(([k, v]) => v && !['NOMBRE', 'GX_MEDIA_LINKS'].includes(normal(k)))
    .map(([, v]) => v.trim())
  if (campos.length) return [...new Set(campos)].join(' · ')
  const d = String(p.descripcion ?? '')
    .replace(/\b(descripci[oó]n|nombre)\s*:/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return d || null
}

/** Qué es un punto, por carpeta primero y por nombre después. */
export function tipoDePunto(carpeta, nombre) {
  const c = normal(carpeta)
  const n = normal(nombre)
  if (/\bNODO/.test(c)) return 'nodo'
  if (/POSTE/.test(c)) return 'poste'
  if (/\bMANGA/.test(c)) return 'manga'
  if (/RESERVA/.test(c)) return 'reserva'
  if (/\bNAP/.test(c) && !/^(A|J)\b/.test(n)) return 'nap'
  if (/SPL?ET+ER|SPLIT+ER/.test(n)) return 'splitter'
  if (/\bODF\b/.test(n)) return 'odf'
  if (/\bNODO\b/.test(n)) return 'nodo'
  if (/^(A|J)\s*-\s*RESERVA|^RESERVA/.test(n)) return 'reserva'
  if (/^(A|J)\b/.test(n) || /^(POSTES?|BASE|PUNTO)\b/.test(n) || /POSTE/.test(c)) return 'poste'
  if (/\bMANGA\b/.test(n)) return 'manga'
  if (/\bNAP\b/.test(n)) return 'nap'
  return 'otro'
}

/** Qué cable es una línea. */
export function tipoDeCable(nombre) {
  const n = normal(nombre)
  const hilos = hilosDe(nombre)
  const color = COLORES_HILO.find((c) => new RegExp(`\\bHILO\\s+${c}\\b`).test(n)) ?? null
  let tipo = 'distribucion'
  if (/\bDROP\b/.test(n)) tipo = 'drop'
  else if (color && (!hilos || hilos <= 2)) tipo = 'hilo'
  else if (/TRONCAL|FEEDER|MAIN/.test(n) || (hilos && hilos >= 24)) tipo = hilos && hilos >= 24 ? 'troncal' : 'feeder'
  else if (!hilos && !/FIBRA|F\.?O\b|ADSS|CABLE/.test(n)) tipo = 'otro'
  return { tipo, hilos, color_hilo: color ? color.toLowerCase() : null }
}

const esProyecto = (carpeta) => /PROYECT/.test(normal(carpeta))

/**
 * Del KMZ a lo que entra a la base: { elementos, cables, resumen }.
 *
 * `unirTendidos`: en una carpeta de postes marcados en orden (A, J, A…), une
 * los consecutivos en una ruta de cable. Se corta cuando hay un salto de más
 * de `vanoMaximo` metros: ahí el cable no siguió, o falta un poste.
 */
export function clasificar(placemarks, { unirTendidos = true, vanoMaximo = 150, lejosKm = 30 } = {}) {
  const elementos = []
  const cables = []

  for (const p of placemarks) {
    if (!p.coords?.length) continue
    const origen = { carpeta: p.carpeta, nombre: p.nombre, estilo: p.estilo || undefined, fila: p.fila }
    const estado = p.estado ?? (esProyecto(p.carpeta) ? 'proyectado' : 'existente')
    const nombre = mejorNombre(p)
    const descripcion = mejorDescripcion(p)

    if (p.geom === 'linea' || p.geom === 'poligono') {
      if (p.coords.length < 2) continue
      const c = tipoDeCable(`${nombre} ${p.carpeta}`)
      const revisar = []
      if (!nombre) revisar.push('Cable sin nombre')
      if (!c.hilos && c.tipo !== 'hilo') revisar.push('No dice cuántos hilos tiene')
      cables.push({
        nombre: nombre || 'Cable sin nombre',
        ...c,
        ruta: p.coords.map(([a, b]) => [round7(a), round7(b)]),
        estado,
        descripcion,
        origen,
        revisar,
      })
      continue
    }

    // Lo que trae una planilla (columnas Tipo, Herraje, Hilos…) manda sobre lo adivinado.
    const tipo = p.tipo ?? tipoDePunto(p.carpeta, nombre)
    const n = normal(nombre)
    const [lat, lng] = p.coords[0]
    const e = {
      tipo,
      nombre: nombre || null,
      latitud: round7(lat),
      longitud: round7(lng),
      estado,
      descripcion,
      origen,
      revisar: [...(p.revisar ?? [])],
    }
    const herraje = p.herraje ?? n.match(/^(A|J)\b/)?.[1]
    if (herraje && (tipo === 'poste' || tipo === 'reserva')) e.herraje = herraje
    if (tipo === 'manga') e.hilos = hilosDe(nombre)
    if (tipo === 'reserva') e.metros = metrosDe(`${nombre} ${descripcion ?? ''}`)
    if (tipo === 'splitter') e.splitter = n.match(/1\s*[:/]\s*(\d+)/) ? `1:${n.match(/1\s*[:/]\s*(\d+)/)[1]}` : null
    if (tipo === 'nap') {
      const cap = n.match(/(\d+)\s*(?:PUERTOS|P\b)/)
      if (cap) e.capacidad = Number(cap[1])
    }
    if (tipo === 'poste' && /^(A|J)\s*-\s*(NAP|MANGA)/.test(n)) {
      e.descripcion = [descripcion, `En este poste: ${n.replace(/^(A|J)\s*-\s*/, '')}`].filter(Boolean).join(' · ')
    }
    if (p.hilos) e.hilos = p.hilos
    if (p.capacidad) e.capacidad = p.capacidad
    if (p.metros != null) e.metros = p.metros
    if (p.splitter) e.splitter = p.splitter
    const foto = Object.entries(p.datos ?? {}).find(([k]) => normal(k) === 'GX_MEDIA_LINKS')?.[1]
    if (foto) e.foto_url = foto.split(/\s+/)[0]

    if (!nombre) {
      e.nombre = `${ETIQUETA[tipo]} sin nombre`
      if (tipo !== 'poste') e.revisar.push('Sin nombre')
    } else if ((tipo === 'nap' || tipo === 'manga') && GENERICOS.test(n)) {
      e.revisar.push('Sin nombre propio: ponele el rótulo real')
    }
    if (tipo === 'otro') e.revisar.push(`No se sabe qué es (carpeta "${p.carpeta}")`)
    elementos.push(e)
  }

  // Las carpetas de tendido: postes marcados en orden (A, J, A…).
  const tendidos = new Set()
  {
    const cuenta = new Map()
    for (const p of placemarks) {
      if (p.geom !== 'punto') continue
      const c = cuenta.get(p.carpeta) ?? { total: 0, aj: 0 }
      c.total += 1
      if (p.herraje || /^(A|J)\b/.test(normal(p.nombre))) c.aj += 1
      cuenta.set(p.carpeta, c)
    }
    for (const [k, c] of cuenta) if (c.total >= 3 && c.aj / c.total >= 0.6) tendidos.add(k)
  }
  // Dentro de un tendido, lo que no tiene nombre claro ("Mi ubicación") es un
  // poste más del recorrido.
  for (const e of elementos) {
    if (e.tipo !== 'otro' || !tendidos.has(e.origen.carpeta)) continue
    e.tipo = 'poste'
    e.revisar = []
    if (/ sin nombre$/.test(e.nombre)) e.nombre = 'Poste sin nombre'
  }

  // Lo que no se supo por carpeta ni por nombre, por el ícono: si ese ícono es
  // casi siempre un poste en el resto del archivo, es un poste.
  const iconoBase = (e) => String(e ?? '').replace(/-(nodesc|normal|highlight|labelson)$/g, '').replace(/-nodesc$/, '')
  const votos = new Map()
  for (const e of elementos) {
    if (e.tipo === 'otro' || !e.origen.estilo) continue
    const k = iconoBase(e.origen.estilo)
    if (!votos.has(k)) votos.set(k, {})
    votos.get(k)[e.tipo] = (votos.get(k)[e.tipo] ?? 0) + 1
  }
  for (const e of elementos) {
    if (e.tipo !== 'otro' || !e.origen.estilo) continue
    const v = votos.get(iconoBase(e.origen.estilo))
    if (!v) continue
    const total = Object.values(v).reduce((s, x) => s + x, 0)
    const [tipo, n] = Object.entries(v).sort((x, y) => y[1] - x[1])[0]
    if (total >= 3 && n / total >= 0.7) {
      e.tipo = tipo
      if (/ sin nombre$/.test(e.nombre)) e.nombre = `${ETIQUETA[tipo]} sin nombre`
      e.revisar = e.revisar.filter((r) => !r.startsWith('No se sabe qué es'))
      if (tipo !== 'poste') e.revisar.push(`Tipo deducido por el ícono del KMZ (${ETIQUETA[tipo]})`)
      else e.revisar = e.revisar.filter((r) => r !== 'Sin nombre')
    }
  }

  // Tendidos marcados poste por poste: se arma la ruta.
  if (unirTendidos) {
    const porCarpeta = new Map()
    for (const p of placemarks) {
      if (p.geom !== 'punto' || !p.coords?.length) continue
      if (!porCarpeta.has(p.carpeta)) porCarpeta.set(p.carpeta, [])
      porCarpeta.get(p.carpeta).push(p)
    }
    for (const [carpeta, ps] of porCarpeta) {
      if (!tendidos.has(carpeta)) continue
      const hilos = ps.map((p) => hilosDe(p.nombre)).find(Boolean) ?? hilosDe(carpeta)
      let tramo = [ps[0].coords[0]]
      let n = 0
      const cerrar = () => {
        if (tramo.length >= 2) {
          n += 1
          cables.push({
            nombre: `${carpeta} · tramo ${n}`,
            tipo: hilos && hilos >= 24 ? 'troncal' : 'distribucion',
            hilos: hilos ?? null,
            color_hilo: null,
            ruta: tramo.map(([a, b]) => [round7(a), round7(b)]),
            estado: esProyecto(carpeta) ? 'proyectado' : 'existente',
            descripcion: `Ruta armada uniendo los postes de "${carpeta}" en el orden del archivo.`,
            origen: { carpeta, tendido: true },
            revisar: ['Ruta armada uniendo postes consecutivos: confirmala', ...(hilos ? [] : ['No dice cuántos hilos tiene'])],
          })
        }
      }
      for (const p of ps.slice(1)) {
        const punto = p.coords[0]
        if (metrosEntre(tramo[tramo.length - 1], punto) > vanoMaximo) {
          cerrar()
          tramo = [punto]
        } else tramo.push(punto)
      }
      cerrar()
    }
  }

  // Lejos del resto: casi seguro una coordenada mal puesta.
  const lats = elementos.map((e) => e.latitud).sort((a, b) => a - b)
  const lngs = elementos.map((e) => e.longitud).sort((a, b) => a - b)
  if (lats.length) {
    const centro = [lats[Math.floor(lats.length / 2)], lngs[Math.floor(lngs.length / 2)]]
    for (const e of elementos) {
      const km = metrosEntre(centro, [e.latitud, e.longitud]) / 1000
      if (km > lejosKm) e.revisar.push(`A ${Math.round(km)} km del resto de la red: ¿coordenada mal puesta?`)
    }
  }

  // Duplicados: mismo tipo a menos de 3 m.
  const nodosTipo = ['nap', 'manga', 'nodo', 'splitter', 'odf']
  for (let i = 0; i < elementos.length; i++) {
    const a = elementos[i]
    if (!nodosTipo.includes(a.tipo)) continue
    for (let j = i + 1; j < elementos.length; j++) {
      const b = elementos[j]
      if (b.tipo !== a.tipo) continue
      if (metrosEntre([a.latitud, a.longitud], [b.latitud, b.longitud]) < 3) {
        b.revisar.push(`Repetida: hay otra ${ETIQUETA[a.tipo]} en el mismo lugar ("${a.nombre}")`)
      }
    }
  }

  const porTipo = {}
  for (const e of elementos) porTipo[e.tipo] = (porTipo[e.tipo] ?? 0) + 1
  const cablesPorTipo = {}
  for (const c of cables) cablesPorTipo[c.tipo] = (cablesPorTipo[c.tipo] ?? 0) + 1
  return {
    elementos,
    cables,
    resumen: {
      elementos: porTipo,
      cables: cablesPorTipo,
      metros: Math.round(cables.reduce((s, c) => s + largoRuta(c.ruta), 0)),
      tendidos: cables.filter((c) => c.origen?.tendido).length,
      revisar: elementos.filter((e) => e.revisar.length).length + cables.filter((c) => c.revisar.length).length,
    },
  }
}

const round7 = (x) => Math.round(Number(x) * 1e7) / 1e7

export const ETIQUETA = {
  nodo: 'Nodo',
  poste: 'Poste',
  nap: 'NAP',
  manga: 'Manga',
  reserva: 'Reserva',
  splitter: 'Splitter',
  odf: 'ODF',
  otro: 'Otro',
}

// ── Escribir el KMZ ──────────────────────────────────────────────────────────

const esc = (t) =>
  String(t ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** Colores KML (aabbggrr) por tipo. */
const KML_COLOR = {
  nodo: 'ff1e1ed6',
  poste: 'ff9e9e9e',
  nap: 'ff00b4ff',
  manga: 'ffb0279c',
  reserva: 'ff00796b',
  splitter: 'ffff8f00',
  odf: 'ff3c3c3c',
  otro: 'ff888888',
  troncal: 'ffd47619',
  feeder: 'ffd4a019',
  distribucion: 'ff2ca02c',
  drop: 'ff0b84ff',
  hilo: 'ff00c8ff',
}
const ANCHO = { troncal: 5, feeder: 4, distribucion: 3, drop: 2, hilo: 2, otro: 2 }

function datosExtendidos(o) {
  const filas = Object.entries(o)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<Data name="${esc(k)}"><value>${esc(v)}</value></Data>`)
  return filas.length ? `<ExtendedData>${filas.join('')}</ExtendedData>` : ''
}

/**
 * El KML de la planta: una carpeta por capa (o por tipo, para lo que no tiene
 * capa), con sus datos.
 *
 * `estiloDe(x, 'e'|'c')` → { color: 'aabbggrr', ancho, icono? } pone el estilo
 * propio de cada uno (el que se ve en el mapa); sin él, cada tipo lleva el suyo
 * fijo. `icono` es la ruta del PNG dentro del KMZ (va en `archivos`).
 * `carpetaDe(x, 'e'|'c')` → nombre de carpeta, o null para la del tipo.
 */
export function armarKml({ nombre = 'Planta externa', elementos = [], cables = [], estiloDe = null, carpetaDe = null }) {
  const estilos = Object.entries(KML_COLOR)
    .map(([k, c]) =>
      ANCHO[k]
        ? `<Style id="c-${k}"><LineStyle><color>${c}</color><width>${ANCHO[k]}</width></LineStyle></Style>`
        : `<Style id="e-${k}"><IconStyle><color>${c}</color><scale>${k === 'poste' ? 0.6 : 1}</scale><Icon><href>${ICONO}</href></Icon></IconStyle></Style>`,
    )
    .join('\n')

  const estiloPm = (x, clase) => {
    if (!estiloDe) return `<styleUrl>#${clase}-${x.tipo}</styleUrl>`
    const st = estiloDe(x, clase)
    return clase === 'e'
      ? `<Style><IconStyle><color>${st.icono ? 'ffffffff' : st.color}</color><scale>${Math.max(0.4, Math.min(2.5, st.ancho / 6)).toFixed(2)}</scale><Icon><href>${esc(st.icono ?? ICONO)}</href></Icon></IconStyle></Style>`
      : `<Style><LineStyle><color>${st.color}</color><width>${st.ancho}</width></LineStyle></Style>`
  }

  const pmElemento = (e) =>
    `<Placemark><name>${esc(e.nombre)}</name>${estiloPm(e, 'e')}${datosExtendidos({
      tipo: ETIQUETA[e.tipo],
      estado: e.estado,
      verificacion: e.verificacion,
      puertos: e.capacidad,
      abonados: e.abonados,
      libres: e.libres,
      hilos: e.hilos,
      splitter: e.splitter,
      herraje: e.herraje,
      metros: e.metros,
      descripcion: e.descripcion,
    })}<Point><coordinates>${e.longitud},${e.latitud},0</coordinates></Point></Placemark>`

  const pmCable = (c) =>
    `<Placemark><name>${esc(c.nombre)}</name>${estiloPm(c, 'c')}${datosExtendidos({
      tipo: c.tipo,
      hilos: c.hilos,
      color_hilo: c.color_hilo,
      metros: c.longitud_m ?? Math.round(largoRuta(c.ruta)),
      estado: c.estado,
      verificacion: c.verificacion,
      descripcion: c.descripcion,
    })}<LineString><tessellate>1</tessellate><coordinates>${c.ruta
      .map(([la, lo]) => `${lo},${la},0`)
      .join(' ')}</coordinates></LineString></Placemark>`

  // Las carpetas, en orden: primero las capas (como vengan), después los tipos.
  const grupos = new Map()
  const meter = (clave, item, pm) => {
    if (!grupos.has(clave)) grupos.set(clave, [])
    grupos.get(clave).push(pm(item))
  }
  for (const e of elementos) meter(carpetaDe?.(e, 'e') ?? `${PLURAL[e.tipo] ?? 'Otros'}`, e, pmElemento)
  for (const c of cables) meter(carpetaDe?.(c, 'c') ?? `Cables ${c.tipo}`, c, pmCable)
  const carpetas = [...grupos]
    .map(([n, pms]) => `<Folder><name>${esc(n)} (${pms.length})</name>\n${pms.join('\n')}\n</Folder>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>${esc(nombre)}</name>
${estilos}
${carpetas}
</Document>
</kml>
`
}

const ICONO = 'https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png'

const PLURAL = {
  nodo: 'Nodos',
  poste: 'Postes',
  nap: 'Cajas NAP',
  manga: 'Mangas',
  reserva: 'Reservas',
  splitter: 'Splitters',
  odf: 'ODF',
  otro: 'Otros',
}

/**
 * El KMZ listo para descargar. `archivos` son los que van al lado del KML
 * (los PNG de los íconos): [{ nombre: 'iconos/nap-f59e0b.png', datos }].
 */
export function armarKmz(planta, archivos = []) {
  const kml = new TextEncoder().encode(armarKml(planta))
  return armarZip([{ nombre: 'doc.kml', datos: kml }, ...archivos])
}
