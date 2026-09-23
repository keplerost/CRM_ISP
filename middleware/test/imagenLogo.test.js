import test from 'node:test'
import assert from 'node:assert/strict'

import {
  medidasDestino,
  pesoDeDataUrl,
  enKb,
  tieneTransparencia,
} from '../../web/src/lib/imagenLogo.js'

/**
 * El logo, achicado al subirlo.
 *
 * ── Qué se protege ──
 *
 * Lo primero: que nunca agrande. Un logo chico estirado no gana detalle, solo
 * peso — y el peso es todo el motivo por el que esto existe: el logo viaja en
 * base64 en cada carga de página, también la del abonado desde el celular.
 *
 * Lo segundo: que respete la proporción. Un logo deformado es peor que uno
 * grande; es la marca del ISP mostrada mal en la primera pantalla que ve todo
 * el mundo.
 *
 * Los logos de ISP son casi siempre apaisados —el símbolo con el nombre al
 * lado—, así que ese es el caso que más se prueba.
 */

test('un logo apaisado se limita por el ancho', () => {
  const r = medidasDestino(2000, 500)
  assert.equal(r.ancho, 512)
  assert.equal(r.alto, 128) // 500 * (512/2000)
  assert.equal(r.achicada, true)
})

test('un logo alto se limita por el alto', () => {
  const r = medidasDestino(600, 1200)
  assert.equal(r.alto, 256)
  assert.equal(r.ancho, 128)
})

test('un cuadrado grande entra en el lado más chico de la caja', () => {
  // 512 de ancho y 256 de alto: un cuadrado tiene que caber en los dos, así
  // que manda el alto. Tomar solo el ancho lo dejaría cortado.
  const r = medidasDestino(1000, 1000)
  assert.equal(r.ancho, 256)
  assert.equal(r.alto, 256)
})

test('nunca agranda: un logo chico se guarda tal cual', () => {
  const r = medidasDestino(80, 40)
  assert.equal(r.ancho, 80)
  assert.equal(r.alto, 40)
  assert.equal(r.achicada, false)
})

test('uno que ya mide justo tampoco se toca', () => {
  const r = medidasDestino(512, 256)
  assert.deepEqual({ a: r.ancho, b: r.alto, c: r.achicada }, { a: 512, b: 256, c: false })
})

test('la proporción se mantiene', () => {
  const r = medidasDestino(1920, 320) // 6:1
  assert.ok(Math.abs(r.ancho / r.alto - 6) < 0.05, `quedó ${r.ancho}×${r.alto}`)
})

test('una imagen muy apaisada no se queda en cero de alto', () => {
  // 4000×20 escalado por ancho da 2.56 de alto. Redondear sin piso daría 3,
  // pero una franja de 10000×5 daría 0 — y un canvas de alto 0 no dibuja nada,
  // así que el logo se guardaría en blanco sin ningún error.
  const r = medidasDestino(10000, 5)
  assert.ok(r.alto >= 1, `alto ${r.alto}`)
  assert.ok(r.ancho >= 1)
})

test('medidas inválidas no se inventan', () => {
  // Un SVG sin ancho ni alto declarados llega con naturalWidth 0. Devolver
  // null deja que quien llama muestre un error, en vez de un canvas vacío.
  assert.equal(medidasDestino(0, 100), null)
  assert.equal(medidasDestino(100, 0), null)
  assert.equal(medidasDestino(undefined, undefined), null)
})

test('se puede pedir otra caja', () => {
  const r = medidasDestino(1000, 1000, 100, 100)
  assert.equal(r.ancho, 100)
})

test('el peso de una data URL sale de los datos, no del texto', () => {
  // "AAAA" son 3 bytes; el encabezado no cuenta.
  assert.equal(pesoDeDataUrl('data:image/webp;base64,AAAA'), 3)
  // Con relleno: "AA==" es 1 byte.
  assert.equal(pesoDeDataUrl('data:image/png;base64,AA=='), 1)
  assert.equal(pesoDeDataUrl('data:image/png;base64,AAA='), 2)
})

test('un texto que no es data URL pesa cero en vez de romper', () => {
  assert.equal(pesoDeDataUrl(''), 0)
  assert.equal(pesoDeDataUrl(null), 0)
  assert.equal(pesoDeDataUrl('cualquier cosa'), 0)
})

test('los kilobytes se muestran sin decimales y nunca en cero', () => {
  assert.equal(enKb(20480), '20 KB')
  // Un logo minúsculo tiene que decir "1 KB" y no "0 KB", que se lee como si
  // no se hubiera guardado nada.
  assert.equal(enKb(120), '1 KB')
})

/**
 * La transparencia decide el formato de salida.
 *
 * Un PNG con el fondo blanco pintado se ve idéntico a uno sin fondo mientras
 * esté sobre blanco. La diferencia aparece recién al ponerlo sobre el gris del
 * sistema, y ahí ya es tarde: el logo queda con un recuadro y nada en pantalla
 * explica por qué.
 */

/** Píxeles RGBA sueltos, como los devuelve getImageData. */
const px = (...alfas) => Uint8ClampedArray.from(alfas.flatMap((a) => [0, 0, 0, a]))

test('detecta transparencia con un solo píxel no opaco', () => {
  // Alcanza uno: el borde suavizado de un logo recortado son unos pocos
  // píxeles semitransparentes en todo el contorno.
  assert.equal(tieneTransparencia(px(255, 255, 254, 255)), true)
})

test('una imagen totalmente opaca no la tiene', () => {
  assert.equal(tieneTransparencia(px(255, 255, 255, 255)), false)
})

test('un fondo completamente transparente la tiene', () => {
  assert.equal(tieneTransparencia(px(0, 0, 0, 0)), true)
})

test('mira el alfa y no el color', () => {
  // Blanco puro y opaco: es el caso del PNG con el fondo pintado, que es
  // exactamente lo que hay que NO confundir con transparencia.
  const blancoOpaco = Uint8ClampedArray.from([255, 255, 255, 255, 255, 255, 255, 255])
  assert.equal(tieneTransparencia(blancoOpaco), false)
})

test('sin datos no inventa transparencia', () => {
  assert.equal(tieneTransparencia(new Uint8ClampedArray(0)), false)
  assert.equal(tieneTransparencia(null), false)
  assert.equal(tieneTransparencia(undefined), false)
})
