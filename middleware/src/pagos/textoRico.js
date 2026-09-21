/**
 * Convertir el HTML de una plantilla en bloques que pdfkit sepa dibujar.
 *
 * ── Por qué un subconjunto propio y no una librería ──
 *
 * Porque lo que hay que renderizar no es "HTML": es lo que alguien escribe en un
 * editor de plantillas para un contrato o un recibo. Eso son párrafos, títulos,
 * negritas y listas. Traer un motor completo —o peor, un navegador entero para
 * imprimir a PDF— agregaría cien megas de dependencia y un proceso más que
 * mantener, para cubrir etiquetas que nadie va a usar.
 *
 * El subconjunto es deliberadamente chico, y lo que no entiende no se pierde: se
 * muestra como texto. Un documento al que le falta una palabra es un problema;
 * uno que descarta un párrafo entero en silencio es peor.
 */

/** Entidades que aparecen de verdad al escribir en español. */
const ENTIDADES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú',
  '&ntilde;': 'ñ', '&Ntilde;': 'Ñ',
}

const limpiar = (t) =>
  String(t ?? '')
    .replace(/&[a-zA-Z#0-9]+;/g, (e) => ENTIDADES[e] ?? e)
    // Los saltos y sangrías del código fuente no son espacios del documento.
    .replace(/\s+/g, ' ')
    .trim()

/**
 * El HTML como una lista de bloques.
 *
 * Cada bloque dice QUÉ es —un título, un párrafo, un ítem de lista— y con qué
 * texto. Quién lo dibuja decide tamaños y márgenes: así el mismo texto se puede
 * imprimir en una hoja A4 o en una tirilla de 58 mm sin tocar esto.
 */
export function aBloques(html) {
  const fuente = String(html ?? '')

  // Sin etiquetas, cada línea es un párrafo. Es lo que pasa con las plantillas
  // de SMS o con un contrato escrito a mano en el editor.
  if (!/<[a-z][^>]*>/i.test(fuente)) {
    return fuente
      .split(/\n{1,}/)
      .map((l) => limpiar(l))
      .filter(Boolean)
      .map((texto) => ({ tipo: 'parrafo', texto }))
  }

  const bloques = []

  /**
   * Se recorre etiqueta por etiqueta en vez de partir por expresiones
   * regulares anidadas: el texto suelto ENTRE etiquetas también es contenido, y
   * partiendo por bloques se perdería.
   */
  const re = /<(\/?)([a-z][a-z0-9]*)[^>]*>|([^<]+)/gi
  let actual = null
  let negrita = false
  let m

  const cerrar = () => {
    if (actual && actual.texto.trim()) bloques.push({ ...actual, texto: actual.texto.trim() })
    actual = null
  }

  const abrir = (tipo) => {
    cerrar()
    actual = { tipo, texto: '' }
  }

  while ((m = re.exec(fuente)) !== null) {
    const [, cierre, etiqueta, texto] = m

    if (texto != null) {
      const t = limpiar(texto)
      if (!t) continue
      if (!actual) actual = { tipo: 'parrafo', texto: '' }
      // El espacio va antes y no después: dos fragmentos seguidos no se pegan,
      // y el bloque no termina con un espacio colgando.
      actual.texto += (actual.texto ? ' ' : '') + t
      if (negrita) actual.fuerte = true
      continue
    }

    const et = etiqueta.toLowerCase()

    if (cierre) {
      if (et === 'b' || et === 'strong') negrita = false
      if (['p', 'h1', 'h2', 'h3', 'li', 'div'].includes(et)) cerrar()
      continue
    }

    if (et === 'br') {
      cerrar()
      continue
    }
    if (et === 'b' || et === 'strong') {
      negrita = true
      continue
    }
    if (et === 'hr') {
      cerrar()
      bloques.push({ tipo: 'linea' })
      continue
    }
    if (['h1', 'h2', 'h3'].includes(et)) {
      abrir(et)
      continue
    }
    if (et === 'li') {
      abrir('item')
      continue
    }
    if (['p', 'div'].includes(et)) {
      abrir('parrafo')
      continue
    }
    // `ul`, `ol`, `span`, `em` y cualquier otra: no cambian la estructura, y su
    // contenido sigue entrando al bloque que esté abierto.
  }

  cerrar()
  return bloques
}

/**
 * El texto plano de una plantilla, para donde no hay formato.
 *
 * Sirve para el recibo POS —una tirilla de 58 mm no tiene títulos— y para
 * cualquier lugar donde haya que medir el largo real de lo escrito.
 */
export function aTextoPlano(html) {
  return aBloques(html)
    .filter((b) => b.tipo !== 'linea')
    .map((b) => b.texto)
    .join('\n')
}
