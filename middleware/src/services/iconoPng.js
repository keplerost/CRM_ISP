import zlib from 'node:zlib'

/**
 * Un PNG dibujado acá, sin librerías ni archivos.
 *
 * ── Por qué generar la imagen en vez de guardarla ──
 *
 * Porque un correo no puede depender de una imagen alojada en otro lado: si ese
 * servidor se cae o cambia la ruta, todos los correos YA ENVIADOS quedan con un
 * cuadrito roto. Y un archivo binario en el repositorio es algo que nadie puede
 * revisar ni corregir sin abrir un editor de imágenes.
 *
 * Dibujado desde una máscara de texto, el ícono se lee, se corrige y se entiende
 * en el mismo lugar donde está el código que lo usa.
 */

/** Un trozo de PNG: largo, tipo, datos y su comprobación. */
function trozo(tipo, datos) {
  const largo = Buffer.alloc(4)
  largo.writeUInt32BE(datos.length)

  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos])

  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(cuerpo) >>> 0)

  return Buffer.concat([largo, cuerpo, crc])
}

/**
 * El CRC que exige el formato.
 *
 * Sin él, el visor descarta el trozo entero: la imagen no se ve y no hay ningún
 * mensaje que diga por qué.
 */
const TABLA_CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = TABLA_CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return c ^ 0xffffffff
}

/**
 * Convierte una máscara de texto en un PNG con transparencia.
 *
 * Cada carácter distinto de espacio y de punto se pinta del color pedido; el
 * resto queda transparente. `escala` multiplica cada carácter por N píxeles, así
 * la máscara se puede escribir chica y legible.
 */
export function pngDeMascara(mascara, { color = [255, 255, 255], escala = 1 } = {}) {
  const filas = mascara.split('\n').filter((f) => f.length)
  const altoM = filas.length
  const anchoM = Math.max(...filas.map((f) => f.length))

  const ancho = anchoM * escala
  const alto = altoM * escala

  // Cada fila del PNG empieza con un byte de filtro; se usa 0, "sin filtro".
  const crudo = Buffer.alloc(alto * (1 + ancho * 4))

  for (let y = 0; y < alto; y++) {
    const base = y * (1 + ancho * 4)
    crudo[base] = 0

    for (let x = 0; x < ancho; x++) {
      const c = filas[Math.floor(y / escala)]?.[Math.floor(x / escala)] ?? ' '
      const pinta = c !== ' ' && c !== '.'
      const p = base + 1 + x * 4

      crudo[p] = pinta ? color[0] : 0
      crudo[p + 1] = pinta ? color[1] : 0
      crudo[p + 2] = pinta ? color[2] : 0
      crudo[p + 3] = pinta ? 255 : 0
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(ancho, 0)
  ihdr.writeUInt32BE(alto, 4)
  ihdr[8] = 8 // bits por canal
  ihdr[9] = 6 // color verdadero con transparencia
  ihdr[10] = 0 // compresión estándar
  ihdr[11] = 0 // filtrado estándar
  ihdr[12] = 0 // sin entrelazado

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr),
    trozo('IDAT', zlib.deflateSync(crudo)),
    trozo('IEND', Buffer.alloc(0)),
  ])
}

/**
 * El auricular de WhatsApp, en blanco y sobre transparente.
 *
 * Va sobre el verde del botón, así que solo hace falta la silueta. No es el
 * logotipo oficial de Meta —ese tiene reglas de uso— sino la forma que cualquiera
 * reconoce de un vistazo.
 */
const AURICULAR = `
....########....
..############..
.####......####.
####........####
###...####...###
###..######..###
###..######..###
###...#####..###
###....###...###
####.........###
.####.......####
..###########.##
...##########.##
....########..##
.....#####......
`

/** El ícono listo para embeber en el correo. */
export function iconoWhatsapp() {
  return pngDeMascara(AURICULAR, { color: [255, 255, 255], escala: 3 })
}
