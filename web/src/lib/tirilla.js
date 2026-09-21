/**
 * Imprimir un recibo en la impresora térmica del mostrador.
 *
 * ── Por qué una ventana con texto y no un PDF ──
 *
 * Porque una térmica de 58 mm no pagina: recibe líneas y las escupe. Un PDF
 * abriría el visor con márgenes de hoja A4 y saldría un recibo centrado en el
 * medio de una tirilla, con el papel desperdiciado arriba y abajo.
 *
 * El texto ya viene cortado al ancho por el middleware —él sabe cuántos
 * caracteres entran—; acá solo se le da un tipo monoespaciado y el ancho de
 * papel, que es lo que el navegador necesita para no reacomodar nada.
 */

/** Ancho del papel en milímetros, según el rollo que tenga la impresora. */
const PAPEL = { 32: '58mm', 48: '80mm' }

export function imprimirTirilla(texto, ancho = 32) {
  const ventana = window.open('', '_blank', 'width=380,height=640')

  // El navegador puede bloquear la ventana emergente. Decirlo es mejor que
  // dejar a quien cobra apretando un botón que no hace nada.
  if (!ventana) {
    throw new Error(
      'El navegador bloqueó la ventana de impresión. Permitila para este sitio y volvé a intentar.',
    )
  }

  const escapado = String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  ventana.document.write(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Recibo</title>
<style>
  /* Sin márgenes: cada milímetro de la tirilla es papel que se paga. */
  @page { size: ${PAPEL[ancho] ?? '58mm'} auto; margin: 0; }
  body { margin: 0; padding: 4mm 3mm; background: #fff; }
  pre {
    margin: 0;
    font-family: "Courier New", monospace;
    font-size: 11px;
    line-height: 1.32;
    /* Ya viene cortado al ancho justo: si el navegador lo reacomodara,
       las líneas de guiones y las columnas quedarían torcidas. */
    white-space: pre;
    color: #000;
  }
</style>
</head>
<body><pre>${escapado}</pre></body>
</html>`)
  ventana.document.close()

  // `onload` y no un temporizador: imprimir antes de que la fuente monoespaciada
  // esté aplicada saca la tirilla con el ancho equivocado.
  ventana.onload = () => {
    ventana.focus()
    ventana.print()
  }
}
