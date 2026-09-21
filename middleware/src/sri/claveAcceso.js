/**
 * Clave de acceso del SRI — Ecuador.
 *
 * Es la identidad del comprobante ante el SRI: 49 dígitos que van dentro del
 * XML y que también se usan para consultar la autorización. Si el dígito
 * verificador está mal, el SRI rechaza el comprobante con "CLAVE ACCESO
 * REGISTRADA" o "ERROR EN LA ESTRUCTURA", sin más detalle.
 *
 * Estructura (48 dígitos + 1 verificador):
 *
 *   ddmmaaaa          8   fecha de emisión
 *   tipoComprobante   2   01 factura, 04 nota crédito, 07 retención…
 *   ruc              13   RUC del emisor
 *   ambiente          1   1 pruebas, 2 producción
 *   establecimiento   3
 *   puntoEmision      3
 *   secuencial        9
 *   codigoNumerico    8   libre; se usa el secuencial para que sea reproducible
 *   tipoEmision       1   1 normal
 *   digitoVerificador 1   módulo 11
 *                    ──
 *                    49
 */

const AppError = class extends Error {}

/**
 * Dígito verificador por módulo 11.
 *
 * Se recorren los 48 dígitos de derecha a izquierda multiplicando por pesos
 * 2,3,4,5,6,7 que se repiten. El dígito es 11 menos el resto, con dos casos
 * especiales que el SRI define explícitamente: 11 → 0 y 10 → 1.
 */
export function digitoVerificador(cadena48) {
  if (!/^\d{48}$/.test(cadena48)) {
    throw new AppError(`Se esperaban 48 dígitos y llegaron ${cadena48?.length ?? 0}`)
  }

  let peso = 2
  let suma = 0

  for (let i = cadena48.length - 1; i >= 0; i--) {
    suma += Number(cadena48[i]) * peso
    peso = peso === 7 ? 2 : peso + 1
  }

  const resto = suma % 11
  const digito = 11 - resto

  if (digito === 11) return 0
  if (digito === 10) return 1
  return digito
}

/** Rellena con ceros a la izquierda hasta `largo`. */
const pad = (valor, largo) => String(valor ?? '').replace(/\D/g, '').padStart(largo, '0').slice(-largo)

/** Fecha en ddmmaaaa. Acepta Date o 'YYYY-MM-DD'. */
export function fechaClave(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(`${fecha}T12:00:00`)
  if (Number.isNaN(d.getTime())) throw new AppError(`Fecha inválida: ${fecha}`)

  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}${mm}${d.getFullYear()}`
}

/**
 * Arma la clave de acceso completa.
 *
 * `codigoNumerico` es libre según el SRI. Por defecto se deriva del secuencial
 * en vez de usar un número al azar: así el mismo comprobante siempre produce la
 * misma clave, y reintentar una emisión fallida no genera un duplicado nuevo.
 */
export function generarClaveAcceso({
  fechaEmision,
  tipoComprobante,
  ruc,
  ambiente = '1',
  establecimiento = '001',
  puntoEmision = '001',
  secuencial,
  codigoNumerico,
  tipoEmision = '1',
}) {
  if (!ruc || !/^\d{13}$/.test(String(ruc))) {
    throw new AppError(`El RUC debe tener 13 dígitos, llegó: "${ruc}"`)
  }
  if (!tipoComprobante) throw new AppError('Falta el tipo de comprobante')
  if (secuencial == null) throw new AppError('Falta el secuencial')

  const partes = [
    fechaClave(fechaEmision),
    pad(tipoComprobante, 2),
    String(ruc),
    pad(ambiente, 1),
    pad(establecimiento, 3),
    pad(puntoEmision, 3),
    pad(secuencial, 9),
    pad(codigoNumerico ?? secuencial, 8),
    pad(tipoEmision, 1),
  ]

  const base = partes.join('')
  if (base.length !== 48) {
    throw new AppError(`La clave base debería tener 48 dígitos y tiene ${base.length}`)
  }

  return base + digitoVerificador(base)
}

/** Desarma una clave de acceso en sus campos. Útil para diagnosticar rechazos. */
export function leerClaveAcceso(clave) {
  if (!/^\d{49}$/.test(clave ?? '')) {
    throw new AppError(`La clave de acceso debe tener 49 dígitos, llegó ${clave?.length ?? 0}`)
  }

  const base = clave.slice(0, 48)
  const esperado = digitoVerificador(base)

  return {
    fecha: `${clave.slice(0, 2)}/${clave.slice(2, 4)}/${clave.slice(4, 8)}`,
    tipoComprobante: clave.slice(8, 10),
    ruc: clave.slice(10, 23),
    ambiente: clave.slice(23, 24),
    establecimiento: clave.slice(24, 27),
    puntoEmision: clave.slice(27, 30),
    secuencial: clave.slice(30, 39),
    codigoNumerico: clave.slice(39, 47),
    tipoEmision: clave.slice(47, 48),
    digitoVerificador: Number(clave.slice(48, 49)),
    valida: Number(clave.slice(48, 49)) === esperado,
    digitoEsperado: esperado,
  }
}

/** true si la clave tiene 49 dígitos y el verificador coincide. */
export const claveEsValida = (clave) => {
  try {
    return leerClaveAcceso(clave).valida
  } catch {
    return false
  }
}
