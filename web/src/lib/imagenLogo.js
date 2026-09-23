/**
 * Achicar el logo al subirlo, en el navegador.
 *
 * ── Por qué importa el peso ──
 *
 * El logo viaja en base64 dentro de `/api/general`, y esa respuesta se pide en
 * CADA carga de página: el login del personal, el portal del abonado, la app
 * del técnico. Codificar en base64 además infla un tercio, así que un archivo
 * de 300 KB son 400 KB que baja, entre otros, el abonado desde el celular con
 * datos móviles para ver el logo de su proveedor.
 *
 * ── Por qué achicar y no rechazar ──
 *
 * Antes se rechazaba el archivo pesado con un cartel que explicaba a qué
 * tamaño tenía que venir. Eso traslada el trabajo a quien instala el sistema:
 * abrir un editor, redimensionar, exportar, volver. Y el logo que le mandó su
 * diseñador viene en 2000 px, siempre.
 *
 * El navegador sabe redimensionar. Que lo haga él.
 *
 * ── Los tamaños ──
 *
 * El login muestra el logo hasta 128 px de alto, y en una pantalla de las que
 * duplican píxeles eso son 256 reales. De ahí sale el alto máximo. El ancho
 * acompaña para logos apaisados, que son la mayoría en un ISP —suelen llevar el
 * nombre escrito al lado del símbolo.
 *
 * Nunca agranda: un logo de 80 px se guarda de 80 px. Estirarlo no agrega
 * detalle, solo peso.
 */

const ANCHO_MAX = 512
const ALTO_MAX = 256

/** Cuánto va a medir, respetando la proporción y sin agrandar nunca. */
export function medidasDestino(ancho, alto, anchoMax = ANCHO_MAX, altoMax = ALTO_MAX) {
  if (!ancho || !alto || ancho < 0 || alto < 0) return null

  // `1` como tope hace que una imagen ya chica pase tal cual.
  const escala = Math.min(1, anchoMax / ancho, altoMax / alto)

  return {
    ancho: Math.max(1, Math.round(ancho * escala)),
    alto: Math.max(1, Math.round(alto * escala)),
    achicada: escala < 1,
  }
}

/** Los bytes que ocupa una data URL, sin el encabezado. */
export function pesoDeDataUrl(dataUrl) {
  const coma = String(dataUrl ?? '').indexOf(',')
  if (coma < 0) return 0
  const datos = dataUrl.slice(coma + 1)
  const relleno = (datos.match(/=+$/) ?? [''])[0].length
  return Math.max(0, Math.floor((datos.length * 3) / 4) - relleno)
}

/**
 * ¿Queda algún píxel que no sea totalmente opaco?
 *
 * Se recorre solo el canal alfa, que es uno de cada cuatro bytes. Alcanza con
 * encontrar UNO: en cuanto aparece, la imagen tiene transparencia y hay que
 * guardarla en un formato que la conserve.
 */
export function tieneTransparencia(datos) {
  if (!datos?.length) return false
  for (let i = 3; i < datos.length; i += 4) {
    if (datos[i] < 255) return true
  }
  return false
}

/**
 * Lee un archivo de imagen y devuelve una data URL liviana.
 *
 * El formato lo decide la propia imagen: PNG si tiene transparencia, WebP si
 * es opaca. El porqué está en el comentario largo de más abajo.
 */
export function achicarLogo(archivo, { anchoMax = ANCHO_MAX, altoMax = ALTO_MAX } = {}) {
  return new Promise((resolver, rechazar) => {
    if (!archivo?.type?.startsWith('image/')) {
      rechazar(new Error('Eso no es una imagen. Va un PNG o un JPG.'))
      return
    }

    const url = URL.createObjectURL(archivo)
    const img = new Image()

    img.onerror = () => {
      URL.revokeObjectURL(url)
      rechazar(new Error('No se pudo leer la imagen. Puede estar dañada.'))
    }

    img.onload = () => {
      URL.revokeObjectURL(url)

      const medidas = medidasDestino(img.naturalWidth, img.naturalHeight, anchoMax, altoMax)
      if (!medidas) {
        rechazar(new Error('La imagen no tiene un tamaño válido.'))
        return
      }

      const lienzo = document.createElement('canvas')
      lienzo.width = medidas.ancho
      lienzo.height = medidas.alto

      // Sin fondo: si el PNG trae transparencia, se conserva.
      const ctx = lienzo.getContext('2d')
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, medidas.ancho, medidas.alto)

      /*
        El formato se elige según si la imagen tiene transparencia.

        Con transparencia va PNG, aunque pese más. El WebP con pérdida que
        produce el lienzo no siempre conserva el canal alfa —depende del
        navegador y no avisa: devuelve una imagen válida, opaca, con el fondo
        aplanado en blanco—. El logo llega al login con un recuadro blanco
        alrededor y no hay nada en pantalla que explique por qué.

        Sin transparencia va WebP, que para un logo pesa una fracción del PNG.

        Y se comprueba el prefijo igual: un navegador sin WebP devuelve PNG sin
        decirlo.
      */
      let transparente = false
      try {
        const px = ctx.getImageData(0, 0, lienzo.width, lienzo.height).data
        transparente = tieneTransparencia(px)
      } catch {
        // Si el lienzo quedara marcado por origen cruzado, no se puede mirar.
        // Ante la duda, PNG: conserva lo que haya.
        transparente = true
      }

      let salida = transparente ? lienzo.toDataURL('image/png') : lienzo.toDataURL('image/webp', 0.92)
      if (!transparente && !salida.startsWith('data:image/webp')) {
        salida = lienzo.toDataURL('image/png')
      }

      resolver({
        dataUrl: salida,
        ancho: medidas.ancho,
        alto: medidas.alto,
        achicada: medidas.achicada,
        transparente,
        pesoOriginal: archivo.size,
        peso: pesoDeDataUrl(salida),
      })
    }

    img.src = url
  })
}

/** "23 KB", para decirle a quien sube el logo en qué quedó. */
export const enKb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`
