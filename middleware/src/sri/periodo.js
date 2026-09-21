/**
 * Período de facturación y plantilla del bloque "Información Adicional".
 *
 * En un ISP la factura de cada mes dice el período que cubre y hasta cuándo hay
 * plazo para pagarla. Ese texto cambia todos los meses, así que se guarda una
 * plantilla con variables y se resuelve al emitir — en vez de que alguien lo
 * edite a mano treinta veces y se olvide en la treintaiuno.
 */

const MESES_CORTOS = [
  'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
  'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
]

const MESES_LARGOS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

/** Acepta Date o 'YYYY-MM-DD'. El mediodía evita saltos de día por zona horaria. */
function aFecha(valor) {
  if (valor instanceof Date) return valor
  const d = new Date(`${valor}T12:00:00`)
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida: ${valor}`)
  return d
}

/** "1/Jul./2026" — el formato del detalle del período. */
export function fechaCorta(valor) {
  const d = aFecha(valor)
  return `${d.getDate()}/${MESES_CORTOS[d.getMonth()]}./${d.getFullYear()}`
}

/** "6 de Julio de 2026" — el formato de la fecha máxima de pago. */
export function fechaLarga(valor) {
  const d = aFecha(valor)
  return `${d.getDate()} de ${MESES_LARGOS[d.getMonth()]} de ${d.getFullYear()}`
}

export const fechaIso = (valor) => aFecha(valor).toISOString().slice(0, 10)

/**
 * Período mensual que cubre la factura.
 *
 * Va del primero al último día del mes de emisión. El último día se calcula
 * pidiendo el día 0 del mes siguiente: así funciona con meses de 30, 31 y con
 * febrero bisiesto, sin tablas ni casos especiales.
 *
 * @param fecha            fecha de emisión
 * @param diaMaximoPago    día del mes hasta el que se puede pagar
 * @param mesesDesplazado  0 = el mes de emisión, -1 = el anterior (facturación vencida)
 */
export function periodoMensual(fecha, { diaMaximoPago = 5, mesesDesplazado = 0 } = {}) {
  const base = aFecha(fecha)
  const anio = base.getFullYear()
  const mes = base.getMonth() + mesesDesplazado

  const desde = new Date(anio, mes, 1, 12)
  const hasta = new Date(anio, mes + 1, 0, 12)

  // El vencimiento cae en el mes de emisión. Si el día pedido no existe —31 en
  // un mes de 30— se usa el último día del mes.
  const ultimoDiaEmision = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate()
  const diaPago = Math.min(Math.max(1, diaMaximoPago), ultimoDiaEmision)
  const fechaMaximaPago = new Date(base.getFullYear(), base.getMonth(), diaPago, 12)

  return {
    desde,
    hasta,
    fechaMaximaPago,
    desdeIso: fechaIso(desde),
    hastaIso: fechaIso(hasta),
    desdeCorta: fechaCorta(desde),
    hastaCorta: fechaCorta(hasta),
    pagoLarga: fechaLarga(fechaMaximaPago),
    mes: MESES_LARGOS[desde.getMonth()],
    anio: desde.getFullYear(),
  }
}

/** Plantilla por defecto, con el texto que exige ARCOTEL para los reclamos. */
export const PLANTILLA_POR_DEFECTO =
  'Periodo del {periodo_desde} al {periodo_hasta}. ' +
  'Fecha Maxima de pago: {fecha_maxima_pago} ' +
  'Para consultas o requerimientos puede contactarse a nuestro Call Center {telefono}. ' +
  '"Para la atencion de reclamos NO resueltos por el prestador, ingrese su reclamo al link: ' +
  'http://reclamoconsumidor.arcotel.gob.ec/osTicket/, o para mayor informacion ' +
  'Comuniquese con el numero telefnico 1800 567 567."'

/** Variables que se pueden usar en la plantilla, para mostrarlas en la UI. */
export const VARIABLES = [
  { clave: 'periodo_desde', ejemplo: '1/Jul./2026', que: 'Primer día del período' },
  { clave: 'periodo_hasta', ejemplo: '31/Jul./2026', que: 'Último día del período' },
  { clave: 'fecha_maxima_pago', ejemplo: '6 de Julio de 2026', que: 'Vencimiento' },
  { clave: 'mes', ejemplo: 'Julio', que: 'Mes del período' },
  { clave: 'anio', ejemplo: '2026', que: 'Año del período' },
  { clave: 'telefono', ejemplo: '0986017616', que: 'Teléfono del emisor' },
  { clave: 'cliente', ejemplo: 'JUAN PÉREZ', que: 'Nombre del cliente' },
  { clave: 'plan', ejemplo: 'PLAN HOME 150 Mbps', que: 'Plan contratado' },
]

/**
 * Reemplaza las variables de la plantilla.
 *
 * Una variable desconocida se deja tal cual, con sus llaves: así se nota en el
 * PDF que hay un error de plantilla, en vez de aparecer un hueco silencioso.
 */
export function renderPlantilla(plantilla, variables = {}) {
  if (!plantilla) return ''
  return String(plantilla).replace(/\{(\w+)\}/g, (original, clave) => {
    const valor = variables[clave]
    return valor == null || valor === '' ? original : String(valor)
  })
}

/** Largo máximo de un campoAdicional en el esquema del SRI. */
export const MAX_CAMPO = 300

/**
 * Parte un texto largo en varios campos adicionales.
 *
 * El SRI rechaza el comprobante entero —"ARCHIVO NO CUMPLE ESTRUCTURA XML"— si
 * un campoAdicional pasa de 300 caracteres, y el aviso de reclamos que exige
 * ARCOTEL no entra en uno solo. Se corta por palabras para que el texto siga
 * siendo legible en el RIDE; una palabra más larga que el límite se parte al
 * medio, porque la alternativa es un campo inválido.
 *
 * Los campos van numerados a partir del segundo —"Descripción", "Descripción
 * 2"— para poder distinguirlos si alguien lee el XML.
 */
export function partirEnCampos(nombre, texto, { max = MAX_CAMPO } = {}) {
  const limpio = String(texto ?? '').trim()
  if (!limpio) return []
  if (limpio.length <= max) return [{ nombre, valor: limpio }]

  const partes = []
  let resto = limpio

  while (resto.length > max) {
    let corte = resto.lastIndexOf(' ', max)
    if (corte <= 0) corte = max
    partes.push(resto.slice(0, corte).trim())
    resto = resto.slice(corte).trim()
  }
  if (resto) partes.push(resto)

  return partes.map((valor, i) => ({ nombre: i === 0 ? nombre : `${nombre} ${i + 1}`, valor }))
}

/**
 * Texto de "Información Adicional" para una factura.
 *
 * @param plantilla  texto con variables; si falta se usa el por defecto
 * @param datos      { fechaEmision, diaMaximoPago, telefono, cliente, plan, mesesDesplazado }
 */
export function infoAdicionalDeFactura(plantilla, datos = {}) {
  const p = periodoMensual(datos.fechaEmision ?? new Date(), {
    diaMaximoPago: datos.diaMaximoPago ?? 5,
    mesesDesplazado: datos.mesesDesplazado ?? 0,
  })

  return {
    texto: renderPlantilla(plantilla || PLANTILLA_POR_DEFECTO, {
      periodo_desde: p.desdeCorta,
      periodo_hasta: p.hastaCorta,
      fecha_maxima_pago: p.pagoLarga,
      mes: p.mes,
      anio: p.anio,
      telefono: datos.telefono,
      cliente: datos.cliente,
      plan: datos.plan,
    }),
    periodo: p,
  }
}
