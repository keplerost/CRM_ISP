import { db } from './db.js'

/**
 * El IVA general del ISP: un solo número, en un solo lugar.
 *
 * ── Por qué existe ──
 *
 * El 15 % estaba escrito en una docena de sitios: el valor por defecto de cada
 * plan, la emisión al SRI, el RIDE, la edición de facturas. Bajarlo al 12 % —ya
 * pasó en Ecuador, en los dos sentidos— obligaba a encontrarlos todos, y el que
 * se olvidara iba a facturar con la tarifa vieja sin que nada lo avisara.
 *
 * Cada plan conserva su propio porcentaje (un plan exento, uno a otra tarifa),
 * pero al cambiar el general se actualizan los planes que tenían el anterior:
 * cambiar en un lugar cambia todo, y lo distinto a propósito se respeta.
 */

export const IVA_POR_DEFECTO = 15

/**
 * Las tarifas que el SRI reconoce, con su código de porcentaje.
 *
 * El código es lo que va en el XML del comprobante, no el número: un 12 % con
 * el código del 15 % lo rechaza el SRI.
 */
export const CODIGO_SRI = { 15: '4', 14: '3', 13: '10', 12: '2', 8: '8', 5: '5', 0: '0' }

/** Las que tiene sentido elegir como general. 0 no: eso se hace por abonado (exento). */
export const TARIFAS_GENERALES = [15, 14, 13, 12, 8, 5]

export const codigoDeTarifa = (tarifa) => CODIGO_SRI[Number(tarifa)] ?? null

/** El IVA general. Si la columna todavía no existe (migración 197), el de siempre. */
export async function ivaGeneral() {
  const { data, error } = await db()
    .from('config_general')
    .select('iva_porcentaje')
    .eq('id', 1)
    .maybeSingle()
  if (error || data?.iva_porcentaje == null) return IVA_POR_DEFECTO
  return Number(data.iva_porcentaje)
}
