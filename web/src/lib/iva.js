import { useEffect, useState } from 'react'
import { api } from './apiNetwork'

/**
 * El IVA general, del lado de la pantalla.
 *
 * Se lee una vez por sesión y se comparte: lo usan el formulario de planes, la
 * edición de facturas y la emisión manual, y pedirlo en cada uno serían tres
 * viajes para el mismo número. Al cambiarlo en Configuración se actualiza acá
 * también, así las demás pantallas no siguen con el viejo hasta recargar.
 */

export const IVA_POR_DEFECTO = 15

/** Código de porcentaje del SRI por tarifa. Va en el XML: el número solo no alcanza. */
export const CODIGO_SRI = { 15: '4', 14: '3', 13: '10', 12: '2', 8: '8', 5: '5', 0: '0' }
export const TARIFA_DE_CODIGO = Object.fromEntries(Object.entries(CODIGO_SRI).map(([t, c]) => [c, Number(t)]))

let cache = null
let pedido = null
const oyentes = new Set()

function avisar(valor) {
  cache = valor
  for (const o of oyentes) o(valor)
}

/** Para Configuración: después de guardar, que todas las pantallas lo sepan. */
export const fijarIvaGeneral = (valor) => avisar(Number(valor))

export function useIvaGeneral() {
  const [iva, setIva] = useState(cache ?? IVA_POR_DEFECTO)

  useEffect(() => {
    oyentes.add(setIva)
    if (cache == null) {
      pedido ??= api.general
        .iva()
        .then((r) => avisar(Number(r?.iva_porcentaje) || IVA_POR_DEFECTO))
        // Sin la migración, o sin conexión: el de siempre. Nunca una pantalla rota.
        .catch(() => avisar(IVA_POR_DEFECTO))
    } else {
      setIva(cache)
    }
    return () => oyentes.delete(setIva)
  }, [])

  return iva
}
