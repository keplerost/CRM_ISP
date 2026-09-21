/**
 * XML de factura según el esquema del SRI (Ecuador), versión 1.1.0.
 *
 * Dos cosas que hacen rechazar comprobantes y por eso están resueltas acá:
 *
 * 1. Los montos van con EXACTAMENTE dos decimales. El SRI valida contra un
 *    XSD estricto: "12.5" o "12.500" son rechazados.
 * 2. `totalConImpuestos` agrupa por código de porcentaje, sumando las bases de
 *    todos los detalles con esa tarifa. No es una copia de los impuestos línea
 *    por línea.
 *
 * Los caracteres especiales de los nombres —& en razones sociales, tildes— se
 * escapan: un solo & sin escapar invalida el XML entero.
 */

/** Códigos de porcentaje de IVA del SRI. */
export const IVA = {
  CERO: { codigo: '0', tarifa: 0 },
  DOCE: { codigo: '2', tarifa: 12 },
  CATORCE: { codigo: '3', tarifa: 14 },
  QUINCE: { codigo: '4', tarifa: 15 },
  NO_OBJETO: { codigo: '6', tarifa: 0 },
  EXENTO: { codigo: '7', tarifa: 0 },
}

/** Tipos de identificación del comprador. */
export const IDENTIFICACION = {
  RUC: '04',
  CEDULA: '05',
  PASAPORTE: '06',
  CONSUMIDOR_FINAL: '07',
  EXTERIOR: '08',
}

class SriError extends Error {}

/**
 * Escapa el texto de un elemento.
 *
 * Solo `&`, `<`, `>` y el retorno de carro: es exactamente lo que escapa la
 * canonicalización C14N dentro de un elemento. Escapar de más —`"` como
 * `&quot;`, por ejemplo— parece inofensivo pero rompe la firma: nosotros
 * digerimos el texto tal como lo escribimos y el SRI lo digiere después de
 * canonicalizarlo, donde la comilla vuelve a ser una comilla. Los dos digests
 * dejan de coincidir y el comprobante vuelve con "FIRMA INVALIDA".
 */
export function escaparXml(valor) {
  if (valor == null) return ''
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;')
}

/**
 * Escapa el valor de un atributo.
 *
 * Las reglas son otras: acá sí hay que escapar la comilla doble —si no, cierra
 * el atributo— pero no el `>`, que la canonicalización deja literal.
 */
export function escaparAtributo(valor) {
  if (valor == null) return ''
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;')
}

/**
 * Redondeo a 2 decimales, sin el error del binario.
 * `(1.005).toFixed(2)` da "1.00" porque 1.005 no es exactamente 1.005 en punto
 * flotante; el desvío de un centavo hace que el SRI rechace por descuadre.
 */
export function dec2(n) {
  const x = Number(n) || 0
  return (Math.round((x + Number.EPSILON) * 100) / 100).toFixed(2)
}

/** Cantidades y precios unitarios admiten hasta 6 decimales. */
export function dec6(n) {
  const x = Number(n) || 0
  return (Math.round((x + Number.EPSILON) * 1e6) / 1e6).toFixed(6)
}

const etiqueta = (nombre, valor) => `<${nombre}>${escaparXml(valor)}</${nombre}>`

/** Etiqueta que se omite si el valor está vacío (los opcionales del XSD). */
const opcional = (nombre, valor) =>
  valor == null || valor === '' ? '' : etiqueta(nombre, valor)

/**
 * Calcula los totales de un detalle y de la factura completa.
 *
 * Se expone aparte del armado del XML para poder verificar la aritmética sin
 * mirar texto, y para que la UI muestre lo mismo que se va a enviar.
 */
export function calcularTotales(detalles = []) {
  const lineas = detalles.map((d) => {
    const cantidad = Number(d.cantidad ?? 1)
    const precioUnitario = Number(d.precioUnitario ?? 0)
    const descuento = Number(d.descuento ?? 0)

    const totalSinImpuesto = cantidad * precioUnitario - descuento
    const tarifa = Number(d.tarifaIva ?? 0)
    const valorIva = totalSinImpuesto * (tarifa / 100)

    return {
      ...d,
      cantidad,
      precioUnitario,
      descuento,
      precioTotalSinImpuesto: Number(dec2(totalSinImpuesto)),
      codigoPorcentaje: d.codigoPorcentaje ?? IVA.QUINCE.codigo,
      tarifaIva: tarifa,
      baseImponible: Number(dec2(totalSinImpuesto)),
      valorIva: Number(dec2(valorIva)),
    }
  })

  // El SRI espera los impuestos AGRUPADOS por código de porcentaje, no una
  // repetición de los de cada línea.
  const porCodigo = new Map()
  for (const l of lineas) {
    const previo = porCodigo.get(l.codigoPorcentaje) ?? {
      codigo: '2',
      codigoPorcentaje: l.codigoPorcentaje,
      tarifa: l.tarifaIva,
      baseImponible: 0,
      valor: 0,
    }
    previo.baseImponible += l.baseImponible
    previo.valor += l.valorIva
    porCodigo.set(l.codigoPorcentaje, previo)
  }

  const impuestos = [...porCodigo.values()].map((i) => ({
    ...i,
    baseImponible: Number(dec2(i.baseImponible)),
    valor: Number(dec2(i.valor)),
  }))

  const totalSinImpuestos = Number(dec2(lineas.reduce((s, l) => s + l.precioTotalSinImpuesto, 0)))
  const totalDescuento = Number(dec2(lineas.reduce((s, l) => s + l.descuento, 0)))
  const totalIva = Number(dec2(impuestos.reduce((s, i) => s + i.valor, 0)))

  return {
    lineas,
    impuestos,
    totalSinImpuestos,
    totalDescuento,
    totalIva,
    importeTotal: Number(dec2(totalSinImpuestos + totalIva)),
  }
}

function exigir(valor, campo) {
  if (valor == null || String(valor).trim() === '') {
    throw new SriError(`Falta "${campo}", que el SRI exige en la factura`)
  }
  return valor
}

/**
 * Arma el XML sin firmar.
 *
 * @param emisor   datos de sri_config
 * @param factura  cabecera del comprobante
 * @param detalles líneas
 */
export function generarXmlFactura({ emisor, factura, detalles }) {
  exigir(emisor?.ruc, 'RUC del emisor')
  exigir(emisor?.razon_social, 'razón social del emisor')
  exigir(emisor?.dir_matriz, 'dirección de la matriz')
  exigir(factura?.claveAcceso, 'clave de acceso')
  exigir(factura?.secuencial, 'secuencial')
  exigir(factura?.razonSocialComprador, 'razón social del comprador')
  exigir(factura?.identificacionComprador, 'identificación del comprador')

  if (!Array.isArray(detalles) || detalles.length === 0) {
    throw new SriError('La factura necesita al menos un detalle')
  }

  const t = calcularTotales(detalles)

  const infoTributaria = [
    etiqueta('ambiente', factura.ambiente ?? emisor.ambiente ?? '1'),
    etiqueta('tipoEmision', factura.tipoEmision ?? '1'),
    etiqueta('razonSocial', emisor.razon_social),
    opcional('nombreComercial', emisor.nombre_comercial),
    etiqueta('ruc', emisor.ruc),
    etiqueta('claveAcceso', factura.claveAcceso),
    etiqueta('codDoc', '01'),
    etiqueta('estab', factura.establecimiento ?? '001'),
    etiqueta('ptoEmi', factura.puntoEmision ?? '001'),
    etiqueta('secuencial', String(factura.secuencial).padStart(9, '0')),
    etiqueta('dirMatriz', emisor.dir_matriz),
  ].join('')

  const totalConImpuestos = t.impuestos
    .map((i) =>
      [
        '<totalImpuesto>',
        etiqueta('codigo', i.codigo),
        etiqueta('codigoPorcentaje', i.codigoPorcentaje),
        etiqueta('baseImponible', dec2(i.baseImponible)),
        etiqueta('valor', dec2(i.valor)),
        '</totalImpuesto>',
      ].join(''),
    )
    .join('')

  const infoFactura = [
    etiqueta('fechaEmision', factura.fechaEmision),
    opcional('dirEstablecimiento', emisor.dir_establecimiento ?? emisor.dir_matriz),
    opcional('contribuyenteEspecial', emisor.contribuyente_especial),
    etiqueta('obligadoContabilidad', emisor.obligado_contabilidad ? 'SI' : 'NO'),
    etiqueta('tipoIdentificacionComprador', factura.tipoIdentificacionComprador ?? IDENTIFICACION.CEDULA),
    etiqueta('razonSocialComprador', factura.razonSocialComprador),
    etiqueta('identificacionComprador', factura.identificacionComprador),
    opcional('direccionComprador', factura.direccionComprador),
    etiqueta('totalSinImpuestos', dec2(t.totalSinImpuestos)),
    etiqueta('totalDescuento', dec2(t.totalDescuento)),
    `<totalConImpuestos>${totalConImpuestos}</totalConImpuestos>`,
    etiqueta('propina', dec2(factura.propina ?? 0)),
    etiqueta('importeTotal', dec2(t.importeTotal)),
    etiqueta('moneda', factura.moneda ?? 'DOLAR'),
    '<pagos><pago>',
    etiqueta('formaPago', factura.formaPago ?? '01'),
    etiqueta('total', dec2(t.importeTotal)),
    '</pago></pagos>',
  ].join('')

  const detallesXml = t.lineas
    .map((l) =>
      [
        '<detalle>',
        opcional('codigoPrincipal', l.codigoPrincipal),
        opcional('codigoAuxiliar', l.codigoAuxiliar),
        etiqueta('descripcion', l.descripcion),
        etiqueta('cantidad', dec6(l.cantidad)),
        etiqueta('precioUnitario', dec6(l.precioUnitario)),
        etiqueta('descuento', dec2(l.descuento)),
        etiqueta('precioTotalSinImpuesto', dec2(l.precioTotalSinImpuesto)),
        '<impuestos><impuesto>',
        etiqueta('codigo', '2'),
        etiqueta('codigoPorcentaje', l.codigoPorcentaje),
        etiqueta('tarifa', dec2(l.tarifaIva)),
        etiqueta('baseImponible', dec2(l.baseImponible)),
        etiqueta('valor', dec2(l.valorIva)),
        '</impuesto></impuestos>',
        '</detalle>',
      ].join(''),
    )
    .join('')

  // El correo del comprador viaja acá porque es donde lo busca quien recibe el
  // comprobante: sin eso queda sin destinatario para el envío automático. No se
  // imprime en el RIDE —el RIDE muestra solo el período— pero sí va en el XML.
  const adicionales = [
    factura.emailComprador ? { nombre: 'email', valor: factura.emailComprador } : null,
    ...(factura.infoAdicional ?? []),
  ].filter(Boolean)

  // El XSD corta los campos adicionales en 300 caracteres y el SRI devuelve el
  // comprobante entero si alguno se pasa. Conviene enterarse acá —donde se
  // puede corregir el texto— y no después de haber consumido el secuencial.
  for (const c of adicionales) {
    const largo = String(c.valor ?? '').length
    if (largo > 300) {
      throw new SriError(
        `El campo adicional "${c.nombre}" tiene ${largo} caracteres y el SRI admite 300. ` +
          'Partilo en varios campos (ver partirEnCampos en sri/periodo.js).',
      )
    }
  }

  const infoAdicional = adicionales.length
    ? `<infoAdicional>${adicionales
        .map(
          (c) =>
            `<campoAdicional nombre="${escaparAtributo(c.nombre)}">${escaparXml(c.valor)}</campoAdicional>`,
        )
        .join('')}</infoAdicional>`
    : ''

  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<factura id="comprobante" version="1.1.0">' +
    `<infoTributaria>${infoTributaria}</infoTributaria>` +
    `<infoFactura>${infoFactura}</infoFactura>` +
    `<detalles>${detallesXml}</detalles>` +
    infoAdicional +
    '</factura>'
  )
}

/** Deshace el escape del XML, para volver a mostrar el texto tal cual se emitió. */
function desescaparXml(valor) {
  return String(valor ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Lee los campos adicionales de un comprobante ya armado.
 *
 * El RIDE los toma de acá y no de la base: lo que se imprime tiene que ser lo
 * mismo que el SRI autorizó, aunque después alguien cambie la plantilla o los
 * datos del cliente.
 *
 * Si el XML viene envuelto en la respuesta de autorización —el SRI devuelve el
 * comprobante dentro de un CDATA— igual funciona, porque solo se buscan las
 * etiquetas `campoAdicional`.
 */
export function leerCamposAdicionales(xml) {
  if (!xml) return []
  const campos = []
  const re = /<campoAdicional\s+nombre="([^"]*)"\s*>([\s\S]*?)<\/campoAdicional>/g
  let m
  while ((m = re.exec(xml))) {
    campos.push({ nombre: desescaparXml(m[1]), valor: desescaparXml(m[2]).trim() })
  }
  return campos
}
