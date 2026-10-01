import { db } from './db.js'
import { PAIS_POR_DEFECTO, perfilDe } from './paises.js'

/**
 * El país de ESTE ISP, leído de la base.
 *
 * Separado de `paises.js` para que el catálogo se pueda probar sin base. Sin la
 * migración 199 —o si no se puede leer— es Ecuador: es lo que había antes, y
 * una instalación que ya funcionaba no puede perder la facturación del SRI por
 * una columna que falta.
 */
export async function paisDelIsp() {
  const { data, error } = await db().from('config_general').select('pais').eq('id', 1).maybeSingle()
  return perfilDe(error ? PAIS_POR_DEFECTO : (data?.pais ?? PAIS_POR_DEFECTO))
}
