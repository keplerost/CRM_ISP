/**
 * Factura del sistema, en PDF.
 *
 * No es el RIDE —ese lo autoriza el SRI y existe solo para quien pide
 * comprobante—: es el papel que se le entrega al abonado con lo que se le cobra
 * y lo que pagó. Sigue el formato al que ya están acostumbrados: banda de
 * estado arriba, De/Para, el detalle con su período, los totales, y abajo las
 * transacciones con el balance.
 *
 * El balance se calcula contra lo que el abonado ENTREGÓ, no contra lo que se
 * imputó a esta factura. Si trajo $30 por una de $25.70, el balance es −$4.30:
 * ese número negativo es la plata que tiene a favor, y es justo lo que viene a
 * preguntar cuando reclama.
 */

import PDFDocument from 'pdfkit'
import { montoEnPalabras } from './reciboPdf.js'
import { dibujarCode128 } from '../sri/code128.js'

const MARGEN = 30
const ANCHO_PAGINA = 595.28
const ANCHO = ANCHO_PAGINA - MARGEN * 2

const GRIS_FONDO = '#eef2f3'
const GRIS_TEXTO = '#6b7280'
const NEGRO = '#111827'
const BORDE = '#d1d5db'

const REGULAR = 'Helvetica'
const NEGRITA = 'Helvetica-Bold'

/** La banda de arriba dice de un vistazo cómo está la factura. */
const ESTADOS = {
  pagada: { texto: 'PAGADO', color: '#06c393' },
  pendiente: { texto: 'PENDIENTE', color: '#f59e0b' },
  vencida: { texto: 'VENCIDO', color: '#dc2626' },
  anulada: { texto: 'ANULADO', color: '#6b7280' },
}

const FORMAS = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia bancaria',
  deposito: 'Depósito bancario',
  tarjeta: 'Tarjeta',
  otro: 'Otro',
}

const dinero = (n) => `$ ${(Number(n) || 0).toFixed(2)}`

function fechaLegible(valor) {
  const iso = String(valor ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '—'
  const [a, m, d] = iso.split('-')
  return `${d}/${m}/${a}`
}

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/** "oct 2026" — para nombrar de qué mes viene una deuda arrastrada. */
function mesCorto(valor) {
  const iso = String(valor ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}/.test(iso)) return '—'
  const [a, m] = iso.split('-')
  return `${MESES_CORTOS[Number(m) - 1] ?? m} ${a}`
}

/** dd/mm/aaaa hh:mm — las transacciones llevan la hora. */
function fechaHora(valor) {
  if (!valor) return '—'
  const d = new Date(valor)
  if (Number.isNaN(d.getTime())) return fechaLegible(valor)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const numeroFactura = (f) => String(f.numero ?? '').padStart(8, '0')

/** Bloque gris de encabezado de tabla. */
function encabezado(doc, x, y, w, h = 20) {
  doc.rect(x, y, w, h).fillColor(GRIS_FONDO).fill()
}

function etiqueta(doc, x, y, texto, { tam = 7.5, color = GRIS_TEXTO } = {}) {
  doc.fontSize(tam).font(REGULAR).fillColor(color).text(texto, x, y, { lineBreak: false })
}

function valor(doc, x, y, texto, { tam = 8.5, negrita = false, ancho = 240 } = {}) {
  doc
    .fontSize(tam)
    .font(negrita ? NEGRITA : REGULAR)
    .fillColor(NEGRO)
    .text(String(texto ?? '—'), x, y, { width: ancho })
}

/**
 * @param emisor    fila de `sri_config`
 * @param factura   fila de `v_facturas`
 * @param pagos     filas de `v_pagos` de esa factura, con `total_cobro`
 * @param cliente   ficha del abonado
 * @param logo      Buffer con el logo, opcional
 * @returns {Promise<Buffer>}
 */
export function generarFacturaPdf({
  emisor = {},
  factura,
  pagos = [],
  excedentes = [],
  origenes = {},
  deudaAnterior = [],
  cliente = null,
  logo = null,
  /**
   * El mensaje al cliente, escrito por el ISP.
   *
   * Sale de la plantilla "Recibo" del editor. Es lo único de este papel que se
   * redacta: el resto —la banda de estado, el detalle, los cobros, el saldo— son
   * datos, y dejarlos escribir a mano sería dejar que digan algo distinto de lo
   * que la base tiene.
   *
   * Vacío no rompe nada: el papel sale igual, sin esa línea.
   */
  leyenda = null,
}) {
  if (!factura) throw new Error('No hay factura que imprimir')

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGEN,
      info: {
        Title: `Factura ${numeroFactura(factura)}`,
        Author: emisor.razon_social ?? '',
      },
    })

    const trozos = []
    doc.on('data', (t) => trozos.push(t))
    doc.on('end', () => resolve(Buffer.concat(trozos)))
    doc.on('error', reject)

    try {
      const estado = ESTADOS[factura.estado] ?? ESTADOS.pendiente

      /**
       * ── Por qué este papel está tan compacto ──
       *
       * Porque tiene que entrar en la mitad de arriba de una A4. Antes ocupaba la
       * hoja entera —el pie estaba clavado al borde inferior y estiraba el
       * documento— y se gastaba una hoja completa por cada cobro, con media
       * carilla en blanco.
       *
       * Cada espacio de acá está medido contra ese límite: la línea de corte del
       * final solo se dibuja si el contenido termina antes de la mitad.
       */

      // --- Banda de estado
      doc.rect(MARGEN, MARGEN, ANCHO, 24).fillColor(estado.color).fill()
      doc.fontSize(13).font(NEGRITA).fillColor('#ffffff')
      doc.text(estado.texto, MARGEN, MARGEN + 6, { width: ANCHO, align: 'center' })

      let y = MARGEN + 34

      // --- Número y fechas
      if (logo) {
        try {
          doc.image(logo, MARGEN, y, { fit: [110, 34] })
        } catch {
          // Un logo ilegible no puede impedir que salga el papel.
        }
      }

      doc.fontSize(14).font(NEGRITA).fillColor(NEGRO)
      doc.text(`FACTURA # ${numeroFactura(factura)}`, MARGEN + (logo ? 122 : 0), y, { width: 260 })

      const xd = MARGEN + ANCHO - 200
      etiqueta(doc, xd, y, 'Fecha emisión')
      valor(doc, xd + 90, y - 1, fechaLegible(factura.fecha_emision), { ancho: 110 })
      etiqueta(doc, xd, y + 14, 'Fecha vencimiento')
      valor(doc, xd + 90, y + 13, fechaLegible(factura.fecha_vencimiento), { ancho: 110 })

      if (factura.numero_fiscal) {
        etiqueta(doc, xd, y + 28, 'Comprobante SRI')
        valor(doc, xd + 90, y + 27, factura.numero_fiscal, { ancho: 110, tam: 8 })
      }

      y += 36

      // --- De / Para
      const mitad = ANCHO / 2 - 6
      encabezado(doc, MARGEN, y, mitad, 18)
      encabezado(doc, MARGEN + mitad + 12, y, mitad, 18)
      doc.fontSize(8.5).font(NEGRITA).fillColor(NEGRO)
      doc.text('De', MARGEN + 8, y + 5, { lineBreak: false })
      doc.text('Para', MARGEN + mitad + 20, y + 5, { lineBreak: false })
      y += 16

      const izq = [
        emisor.nombre_comercial || emisor.razon_social,
        emisor.ruc ? `Ruc ${emisor.ruc}` : null,
        emisor.dir_matriz,
        emisor.telefono ? `Teléfono ${emisor.telefono}` : null,
      ].filter(Boolean)

      const der = [
        factura.cliente ?? cliente?.nombre,
        cliente?.identificacion ?? factura.identificacion,
        cliente?.direccion,
        cliente?.telefono ? `Teléfono / ${cliente.telefono}` : null,
      ].filter(Boolean)

      let yi = y
      for (const [i, linea] of izq.entries()) {
        doc.fontSize(i === 0 ? 9 : 8).font(i === 0 ? NEGRITA : REGULAR).fillColor(NEGRO)
        doc.text(linea, MARGEN + 8, yi, { width: mitad - 16 })
        yi = doc.y + 1
      }

      let yd = y
      for (const [i, linea] of der.entries()) {
        doc.fontSize(i === 0 ? 9 : 8).font(i === 0 ? NEGRITA : REGULAR).fillColor(NEGRO)
        doc.text(linea, MARGEN + mitad + 20, yd, { width: mitad - 16 })
        yd = doc.y + 1
      }

      y = Math.max(yi, yd) + 6

      // --- Detalle
      const cols = [ANCHO - 210, 70, 45, 35, 60]
      const xCols = []
      let acc = MARGEN
      for (const c of cols) {
        xCols.push(acc)
        acc += c
      }

      encabezado(doc, MARGEN, y, ANCHO, 20)
      doc.fontSize(8).font(NEGRITA).fillColor(NEGRO)
      doc.text('Descripción', xCols[0] + 8, y + 6, { lineBreak: false })
      doc.text('Precio', xCols[1], y + 6, { width: cols[1], align: 'right' })
      doc.text('Imp%', xCols[2], y + 6, { width: cols[2], align: 'right' })
      doc.text('Cant.', xCols[3], y + 6, { width: cols[3], align: 'right' })
      doc.text('Total', xCols[4], y + 6, { width: cols[4] - 8, align: 'right' })
      y += 26

      // La descripción incluye el período y el plan: es lo que el abonado lee
      // para entender qué mes está pagando.
      const detalle = [
        factura.concepto ?? 'Servicio de internet',
        factura.periodo_desde
          ? `facturación del ${fechaLegible(factura.periodo_desde)} al ${fechaLegible(factura.periodo_hasta)}`
          : null,
        `Fecha de suspensión: ${fechaLegible(factura.fecha_vencimiento)}`,
        factura.notas,
      ].filter(Boolean)

      const yDetalle = y
      for (const linea of detalle) {
        doc.fontSize(8).font(REGULAR).fillColor(NEGRO)
        doc.text(linea, xCols[0] + 8, y, { width: cols[0] - 16 })
        y = doc.y + 1
      }

      const tarifa =
        Number(factura.subtotal) > 0
          ? ((Number(factura.impuesto) / Number(factura.subtotal)) * 100).toFixed(2)
          : '0.00'

      doc.fontSize(8.5).font(REGULAR).fillColor(NEGRO)
      doc.text(dinero(factura.subtotal), xCols[1], yDetalle, { width: cols[1], align: 'right' })
      doc.text(tarifa, xCols[2], yDetalle, { width: cols[2], align: 'right' })
      doc.text('1', xCols[3], yDetalle, { width: cols[3], align: 'right' })
      doc.font(NEGRITA).text(dinero(factura.total), xCols[4], yDetalle, {
        width: cols[4] - 8,
        align: 'right',
      })

      /**
       * El detalle mide lo que ocupa, no 40 puntos fijos.
       *
       * Reservaba alto para una descripción de varias líneas aunque casi siempre
       * es una sola —"Servicio de internet · agosto"—. Con una hoja que tiene que
       * entrar en la mitad, eso son 22 puntos regalados en cada cobro.
       */
      y = Math.max(y, doc.y + 4, yDetalle + 18) + 4
      doc.moveTo(MARGEN, y).lineTo(MARGEN + ANCHO, y).lineWidth(0.5).strokeColor(BORDE).stroke()
      y += 10

      // --- Importe en letras, código de barras y totales
      //
      // Las letras acompañan al total de ESTA factura, no al arrastre: es el
      // importe del documento, y el arrastre se muestra aparte más abajo.
      doc.fontSize(8).font(NEGRITA).fillColor(NEGRO)
      doc.text(`SON: ${montoEnPalabras(factura.total)}`, MARGEN, y, { width: ANCHO - 220 })

      // El código de barras del número de factura: sirve para buscarla con un
      // lector cuando el abonado trae el papel al mostrador.
      /**
       * El código de barras, bajo pero legible.
       *
       * Se achicó de 26 a 18 puntos de alto para que el comprobante entre en media
       * hoja A4. Un lector no necesita más: lo que le importa es el ancho de las
       * barras, no el largo — se lee igual de bien y se ahorra la mitad de una
       * hoja en cada cobro.
       */
      const yBarras = doc.y + 5
      dibujarCode128(doc, numeroFactura(factura), {
        x: MARGEN,
        y: yBarras,
        ancho: 150,
        alto: 18,
      })
      doc.fontSize(7).font(REGULAR).fillColor(NEGRO)
      doc.text(numeroFactura(factura), MARGEN, yBarras + 20, { width: 150, align: 'center' })

      const xt = MARGEN + ANCHO - 210
      let yt = y

      // Por qué se descontó. Es lo que el abonado con derecho tiene que poder
      // mostrar, y lo que se enseña si ARCOTEL pregunta.
      if (Number(factura.descuento) > 0.005 && factura.descuento_motivo) {
        doc.fontSize(7).font(NEGRITA).fillColor('#047857')
        doc.text(factura.descuento_motivo, MARGEN, yBarras + 32, { width: ANCHO - 220 })
      }
      const totales = [
        ['SUBTOTAL :', dinero(factura.subtotal)],
        ['DESCUENTO :', dinero(factura.descuento)],
        ['IMPUESTO :', dinero(factura.impuesto)],
      ]
      for (const [t, v] of totales) {
        doc.fontSize(8).font(REGULAR).fillColor(GRIS_TEXTO)
        doc.text(t, xt, yt, { width: 110, align: 'right' })
        doc.fillColor(NEGRO).text(v, xt + 115, yt, { width: 90, align: 'right' })
        yt += 14
      }

      // Lo que quedó debiendo de meses anteriores. No se suma al total de esta
      // factura —cada mes conserva el suyo, y meterlo acá lo cobraría dos
      // veces—, pero el abonado tiene que ver en el papel cuánto debe en total:
      // es lo que decide si viene a pagar o se le corta.
      const arrastre =
        Math.round(deudaAnterior.reduce((t, f) => t + Number(f.saldo ?? 0), 0) * 100) / 100

      const conArrastre = arrastre > 0.005

      if (conArrastre) {
        doc.fontSize(8).font(REGULAR).fillColor(GRIS_TEXTO)
        doc.text('TOTAL DEL MES :', xt, yt, { width: 110, align: 'right' })
        doc.fillColor(NEGRO).text(dinero(factura.total), xt + 115, yt, { width: 90, align: 'right' })
        yt += 14

        doc.fontSize(8).font(REGULAR).fillColor(GRIS_TEXTO)
        doc.text('SALDO ANTERIOR :', xt, yt, { width: 110, align: 'right' })
        doc.fillColor('#dc2626').text(dinero(arrastre), xt + 115, yt, { width: 90, align: 'right' })
        yt += 14
      }

      encabezado(doc, xt, yt, 205, 20)
      doc.fontSize(9).font(NEGRITA).fillColor(NEGRO)
      doc.text(conArrastre ? 'TOTAL A PAGAR :' : 'TOTAL :', xt, yt + 6, {
        width: 110,
        align: 'right',
      })
      doc.text(
        dinero(Number(factura.total) + (conArrastre ? arrastre : 0)),
        xt + 115,
        yt + 6,
        { width: 85, align: 'right' },
      )
      yt += 20

      // De dónde viene el arrastre: sin el detalle el abonado discute el número,
      // y en el mostrador no hay con qué responderle.
      if (conArrastre) {
        const detalle = deudaAnterior
          .map((f) => `N° ${String(f.numero).padStart(8, '0')} (${mesCorto(f.periodo_desde ?? f.fecha_emision)}) ${dinero(f.saldo)}`)
          .join(' · ')

        doc.fontSize(6.5).font(REGULAR).fillColor(GRIS_TEXTO)
        doc.text(`Saldo anterior: ${detalle}`, xt - 60, yt + 2, { width: 265, align: 'right' })
        yt = doc.y
      }

      y = Math.max(yBarras + 34, yt + 8) + 4

      // --- Transacciones
      doc.fontSize(9).font(NEGRITA).fillColor(NEGRO).text('Transacciones', MARGEN, y)
      y = doc.y + 6

      encabezado(doc, MARGEN, y, ANCHO, 18)
      doc.fontSize(8).font(NEGRITA).fillColor(NEGRO)
      doc.text('Fecha', MARGEN + 8, y + 5, { lineBreak: false })
      doc.text('Forma pago', MARGEN + 160, y + 5, { lineBreak: false })
      doc.text('N° transacción', MARGEN + 310, y + 5, { lineBreak: false })
      doc.text('Total', MARGEN + ANCHO - 100, y + 5, { width: 92, align: 'right' })
      y += 24

      const validos = pagos.filter((p) => !p.anulado)

      if (!validos.length) {
        doc.fontSize(8).font(REGULAR).fillColor(GRIS_TEXTO)
        doc.text('Sin pagos registrados.', MARGEN + 8, y, { width: ANCHO - 16 })
        y = doc.y + 6
      } else {
        for (const p of validos) {
          // Se muestra lo que el abonado entregó, no lo que se imputó: es lo
          // que él recuerda haber pagado.
          const recibido = Number(p.total_cobro ?? p.monto)

          doc.fontSize(8).font(REGULAR).fillColor(NEGRO)
          doc.text(fechaHora(p.created_at ?? p.fecha_pago), MARGEN + 8, y, { lineBreak: false })
          doc.text(FORMAS[p.forma_pago] ?? p.forma_pago ?? '—', MARGEN + 160, y, { lineBreak: false })
          // Un excedente no tiene número del banco propio: el número pertenece
          // al cobro del que salió, y decirlo es lo que permite rastrearlo.
          //
          // No es lo mismo un cobro que se repartió entre varias facturas que un
          // saldo que había quedado a favor y se aplicó después: el abonado
          // pregunta por los dos casos, y son historias distintas.
          const recibo = String(origenes[p.pago_origen_id] ?? '').padStart(6, '0')
          const referencia = p.n_transaccion
            ? p.n_transaccion
            : p.pago_origen_id
              ? p.es_reparto
                ? `parte del recibo N° ${recibo}`
                : `saldo a favor del recibo N° ${recibo}`
              : '—'

          doc.fontSize(p.n_transaccion ? 8 : 7).font(REGULAR).fillColor(NEGRO)
          doc.text(referencia, MARGEN + 310, y + (p.n_transaccion ? 0 : 1), {
            width: 150,
            lineBreak: false,
          })
          doc.fontSize(8)
          doc.text(dinero(recibido), MARGEN + ANCHO - 100, y, { width: 92, align: 'right' })
          y += 14
        }
      }

      // --- Balance
      //
      // Contra lo entregado: un balance negativo es plata a favor del abonado,
      // que es exactamente lo que viene a preguntar.
      const recibidoTotal = validos.reduce((s, p) => s + Number(p.total_cobro ?? p.monto), 0)
      const balance = Math.round((Number(factura.total) - recibidoTotal) * 100) / 100

      y += 4
      encabezado(doc, MARGEN + ANCHO - 205, y, 205, 22)
      doc.fontSize(9).font(NEGRITA)
      doc.fillColor(NEGRO).text('Balance', MARGEN + ANCHO - 197, y + 7, {
        width: 100,
        lineBreak: false,
      })
      doc
        .fillColor(balance > 0.005 ? '#dc2626' : balance < -0.005 ? '#7c3aed' : '#047857')
        .text(dinero(balance), MARGEN + ANCHO - 100, y + 7, { width: 92, align: 'right' })

      if (balance < -0.005) {
        // Decir "a favor" cuando esa plata ya se usó sería mentir: el abonado
        // vendría a reclamar un saldo que no tiene. Se distingue lo que sigue
        // disponible de lo que ya se imputó, y a qué factura fue.
        const disponible = excedentes
          .filter((e) => !e.factura_id)
          .reduce((s, e) => s + Number(e.monto), 0)

        const aplicados = excedentes.filter((e) => e.factura_id)

        const partes = []
        if (disponible > 0.005) {
          partes.push(`${dinero(disponible)} a favor: se descuentan de su próxima factura.`)
        }
        for (const e of aplicados) {
          partes.push(`${dinero(e.monto)} se aplicaron a la factura N° ${e.numero_factura}.`)
        }
        if (!partes.length) partes.push(`${dinero(-balance)} a favor del cliente.`)

        doc.fontSize(7).font(REGULAR).fillColor(GRIS_TEXTO)
        doc.text(partes.join(' '), MARGEN, y + 8, { width: ANCHO - 215 })
      }

      /**
       * El recuadro del balance mide 22 puntos y `y` seguía apuntando a su borde
       * de ARRIBA. Sin esto, el pie se dibujaba adentro de la caja, encima del
       * número — y como el papel igual "terminaba" en el borde del recuadro,
       * medirlo no delataba nada.
       */
      y += 22

      /**
       * ── El pie va PEGADO al contenido, no al fondo de la hoja ──
       *
       * Antes estaba clavado a 841 puntos —el borde inferior de la A4— y eso
       * estiraba el comprobante a la hoja entera: el detalle terminaba a media
       * página y abajo quedaba un bloque de blanco con la nota legal perdida al
       * pie. Al imprimirlo se gastaba una hoja completa para media carilla.
       *
       * Ahora el documento termina donde termina lo que dice, y en la mayoría de
       * los cobros eso cae en la mitad de arriba. La línea de corte marca dónde
       * separar para aprovechar la otra mitad.
       */
      let yPie = Math.max(y + 6, doc.y + 6)

      if (leyenda?.trim()) {
        doc.fontSize(8.5).font(REGULAR).fillColor(NEGRO)
        doc.text(leyenda.trim(), MARGEN, yPie, {
          width: ANCHO,
          align: 'center',
          height: 22,
          ellipsis: true,
        })
        yPie = doc.y + 4
      }

      /**
       * La nota legal y el sello de generación, en un solo renglón.
       *
       * Eran dos líneas y sobraban 28 puntos para entrar en media hoja. Juntarlas
       * los recupera sin sacar información: las dos son letra chica que nadie lee
       * salvo cuando la necesita.
       */
      doc.fontSize(7).font(REGULAR).fillColor(GRIS_TEXTO)
      doc.text(
        (factura.numero_fiscal
          ? `Comprobante electrónico autorizado ${factura.numero_fiscal} — el RIDE se entrega aparte.`
          : 'Documento interno de cobro. No es un comprobante tributario autorizado por el SRI.')
        + `  ·  Generado ${fechaHora(new Date().toISOString())}`,
        MARGEN,
        yPie,
        { width: ANCHO, align: 'center' },
      )

      /**
       * La línea de corte, justo debajo de lo que se imprimió.
       *
       * ── Por qué no va en la mitad exacta ──
       *
       * Porque el comprobante no siempre entra en media hoja: con dos cobros y una
       * nota de excedente se pasa unos milímetros. Una línea fija en 421 partiría
       * el documento al medio en esos casos, que es peor que no marcar nada.
       *
       * Se dibuja donde termina el contenido, con un respiro. En un cobro normal
       * eso cae cerca de la mitad y queda media hoja limpia para volver a usar.
       */
      /**
       * El respiro bajo el texto es de 3 puntos, no de 14.
       *
       * Con 14 la línea caía en 432 aunque el contenido terminara en 418: el
       * comprobante entraba en la mitad y el corte marcaba fuera de ella. El aire
       * de más lo pone la mitad de la hoja, no la línea.
       */
      const corte = Math.max(doc.y + 3, 841.89 / 2)

      if (corte < 841.89 - MARGEN - 10) {
        doc.save()
        doc.dash(3, { space: 3 })
        doc.moveTo(MARGEN, corte).lineTo(MARGEN + ANCHO, corte)
           .lineWidth(0.5).strokeColor(BORDE).stroke()
        doc.undash()
        doc.restore()

        /**
         * El rótulo va ARRIBA de la línea, no debajo.
         *
         * Debajo, el punto más bajo del papel pasaba a ser el texto y no el corte:
         * el comprobante "medía" ocho puntos más de los que ocupa, y con una hoja
         * que tiene que entrar justo en la mitad esos ocho puntos son la
         * diferencia entre entrar y no.
         */
        doc.fontSize(6).fillColor(GRIS_TEXTO)
        doc.text('corte aquí', MARGEN, corte - 9, { width: ANCHO, align: 'right' })
      }
    } catch (err) {
      doc.end()
      return reject(err)
    }

    doc.end()
  })
}
