/**
 * Números de serie de ONT.
 *
 * El mismo equipo se escribe de dos formas y hay que saberlo, porque compararlas
 * sin normalizar da "no existe" para una ONT que sí está —o peor, crea un
 * duplicado del mismo abonado:
 *
 *   48575443304D1BB2   los ocho bytes en hexadecimal. Es lo que imprime la CLI
 *                      del MA5800.
 *   HWTC304D1BB2       cuatro caracteres de fabricante en ASCII más cuatro
 *                      bytes en hexadecimal. Es lo que devuelve SNMP, lo que
 *                      está pegado en la etiqueta del equipo y lo que un técnico
 *                      lee por teléfono.
 *
 * Se trabaja siempre con la segunda: es la única que una persona puede verificar
 * mirando el aparato.
 */

/** Ocho bytes crudos de SNMP a la forma de la etiqueta. */
export function decodificarSn(crudo) {
  if (!Buffer.isBuffer(crudo)) {
    const s = String(crudo ?? '').trim()
    return s || null
  }
  if (crudo.length < 8) return crudo.toString('latin1').trim() || null

  const fabricante = crudo.subarray(0, 4).toString('latin1')
  if (!/^[A-Za-z0-9]{4}$/.test(fabricante)) {
    // Algún fabricante usa los ocho bytes como texto.
    const texto = crudo.toString('latin1').replace(/\0/g, '').trim()
    return texto || crudo.toString('hex').toUpperCase()
  }
  return fabricante.toUpperCase() + crudo.subarray(4, 8).toString('hex').toUpperCase()
}

/** Cualquiera de las dos notaciones a la de la etiqueta. */
export function normalizarSn(sn) {
  const s = String(sn ?? '')
    .toUpperCase()
    .replace(/[\s:-]/g, '')
  if (!s) return null

  // 16 dígitos hexadecimales son los ocho bytes crudos. Se convierten solo si
  // los primeros cuatro dan un fabricante legible: convertir a ciegas
  // inventaría un fabricante que no existe.
  if (/^[0-9A-F]{16}$/.test(s)) {
    const fabricante = Buffer.from(s.slice(0, 8), 'hex').toString('latin1')
    if (/^[A-Za-z0-9]{4}$/.test(fabricante)) return fabricante.toUpperCase() + s.slice(8)
  }
  return s
}

/**
 * A la forma que espera la CLI al registrar: los ocho bytes en hexadecimal.
 *
 * `ont add ... sn-auth "48575443304D1BB2"` — así están escritas las 85 ONTs en
 * la configuración del equipo. Mandarle "HWTC304D1BB2" sería mandarle otra cosa.
 */
export function aHexSn(sn) {
  const s = normalizarSn(sn)
  if (!s) return null
  if (/^[0-9A-F]{16}$/.test(s)) return s

  // "HWTC" + 8 hex → el fabricante se convierte a sus bytes ASCII.
  const m = s.match(/^([A-Z0-9]{4})([0-9A-F]{8})$/)
  if (!m) return s
  return Buffer.from(m[1], 'latin1').toString('hex').toUpperCase() + m[2]
}

/** ¿Es un número de serie de ONT, en cualquiera de las dos formas? */
export const pareceSn = (texto) =>
  /^[0-9A-Fa-f]{12,16}$/.test(String(texto ?? '')) ||
  /^[A-Za-z0-9]{4}[0-9A-Fa-f]{8}$/.test(String(texto ?? ''))
