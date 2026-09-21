/**
 * Vocabulario y aritmética de la gestión de red.
 *
 * El mapa de direcciones se arma acá, en el navegador, y no en la base: un /24
 * son 254 filas por subred que habría que mantener sincronizadas para mostrar
 * una grilla. Lo que se guarda es lo que alguien decidió —esta IP es de este
 * abonado— y el resto se calcula.
 */

export const TIPOS_SUBRED = {
  estatica: {
    label: 'Estática',
    color: 'azul',
    ayuda: 'Se asigna a mano, dirección por dirección. Es lo habitual en radioenlace.',
  },
  pool_pppoe: {
    label: 'Pool PPPoE',
    color: 'verde',
    ayuda: 'La reparte el router al autenticar. No se elige quién recibe cuál.',
  },
  cgnat: {
    label: 'CGNAT',
    color: 'ambar',
    ayuda: 'Direccionamiento compartido. No se le promete una IP fija a nadie.',
  },
  nodos: {
    label: 'Nodos',
    color: 'gris',
    ayuda: 'Enlaces y equipos propios: torres, antenas, OLTs. No van abonados acá.',
  },
}

export const ESTADOS_IP = {
  libre: { label: 'Libre', clase: 'bg-slate-800 text-slate-500 border-slate-700' },
  asignada: { label: 'Asignada', clase: 'bg-sky-500/20 text-sky-300 border-sky-500/40' },
  reservada: { label: 'Reservada', clase: 'bg-violet-500/20 text-violet-300 border-violet-500/40' },
  sin_autorizar: {
    label: 'Sin autorizar',
    clase: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  },
}

export const TIPOS_NODO = {
  ptp: { label: 'Enlace PTP', ayuda: 'Punto a punto entre dos torres.' },
  ptmp: { label: 'Antena base (PTMP)', ayuda: 'Sectorial que le da a varios abonados.' },
  rb_torre: { label: 'MikroTik de torre', ayuda: 'RouterBoard en el sitio.' },
  olt: { label: 'OLT', ayuda: 'Cabecera de fibra.' },
  energia: { label: 'Energía', ayuda: 'UPS, inversor, banco de baterías.' },
  switch: { label: 'Switch', ayuda: 'Conmutador de sitio.' },
  otro: { label: 'Otro', ayuda: '' },
}

export const ESTADOS_NODO = {
  up: { label: 'UP', punto: '🟢', clase: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' },
  warning: { label: 'WARNING', punto: '🟡', clase: 'bg-amber-500/15 text-amber-300 border-amber-500/40' },
  down: { label: 'DOWN', punto: '🔴', clase: 'bg-rose-500/15 text-rose-300 border-rose-500/40' },
  desconocido: { label: 'SIN DATOS', punto: '⚪', clase: 'bg-slate-500/15 text-slate-400 border-slate-600' },
}

// --- Aritmética de bloques ---------------------------------------------------

export function aEntero(ip) {
  const partes = String(ip ?? '').trim().split('.')
  if (partes.length !== 4) return null

  let n = 0
  for (const p of partes) {
    if (!/^\d{1,3}$/.test(p)) return null
    const octeto = Number(p)
    if (octeto > 255) return null
    n = n * 256 + octeto
  }
  return n
}

export const aIp = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')

/** ¿Es un CIDR IPv4 escribible? Sirve para validar antes de mandar. */
export function esCidrValido(texto) {
  const [dir, bits] = String(texto ?? '').trim().split('/')
  const n = Number(bits)
  return aEntero(dir) != null && Number.isInteger(n) && n >= 0 && n <= 32
}

/**
 * El rango utilizable de un bloque IPv4.
 *
 * Se descartan la dirección de red y la de broadcast: dárselas a un abonado es
 * un ticket asegurado. En /31 y /32 no hay ninguna de las dos —son enlaces
 * punto a punto— y el bloque entero es utilizable.
 */
export function rangoDe(cidr) {
  const [dir, bitsTexto] = String(cidr ?? '').trim().split('/')
  const base = aEntero(dir)
  const bits = Number(bitsTexto)
  if (base == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null

  const mascara = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  const red = (base & mascara) >>> 0
  const broadcast = (red | (~mascara >>> 0)) >>> 0

  if (bits >= 31) return { desde: red, hasta: broadcast, red, broadcast: null }
  return { desde: red + 1, hasta: broadcast - 1, red, broadcast }
}

/**
 * Cuántas direcciones dibuja el mapa antes de rendirse.
 *
 * Un /22 son 1022 celdas, que ya es mucho para mirar de un vistazo pero se
 * puede recorrer. Un /16 son 65.534 y el navegador se cuelga dibujándolas para
 * que nadie las lea.
 */
export const MAXIMO_MAPA = 1024

/**
 * El mapa de la subred: una celda por dirección, con su estado.
 *
 * Las que nadie registró salen como libres. Las que se vieron en la red sin
 * dueño salen aparte: no son lo mismo que una asignada, y mezclarlas escondería
 * justo lo que la auditoría vino a mostrar.
 */
export function mapaDe(cidr, direcciones = []) {
  const rango = rangoDe(cidr)
  if (!rango) return null

  const total = rango.hasta - rango.desde + 1
  if (total > MAXIMO_MAPA) return { rango, total, celdas: null, demasiado: true }

  const porIp = new Map(direcciones.map((d) => [d.ip_address, d]))
  const celdas = []

  for (let n = rango.desde; n <= rango.hasta; n++) {
    const ip = aIp(n)
    const d = porIp.get(ip)
    celdas.push({
      ip,
      // El último octeto es lo que se dice en voz alta: "el .45".
      corto: ip.split('.').pop(),
      estado: !d ? 'libre' : d.sin_autorizar ? 'sin_autorizar' : d.estado,
      datos: d ?? null,
    })
  }

  return { rango, total, celdas, demasiado: false }
}

/** "3 h 20 min", "45 min" — cuánto lleva un nodo en su estado. */
export function duracion(minutos) {
  const m = Math.round(Number(minutos) || 0)
  if (m < 1) return 'recién'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ${m % 60} min`
  const d = Math.floor(h / 24)
  return `${d} ${d === 1 ? 'día' : 'días'} ${h % 24} h`
}
