import { useCallback, useEffect, useState } from 'react'
import { api } from './apiNetwork'

/**
 * El estado de la licencia de esta instalación.
 *
 * Si no se puede preguntar —el middleware está apagado, no hay red— NO se
 * asume que venció. El sistema se vende: dejar afuera a un cliente al día
 * porque el navegador no llegó al backend sería el peor error posible de este
 * módulo, y encima el más fácil de cometer.
 *
 * Por eso `vencida` solo es true cuando el middleware lo dijo con claridad.
 */
export function useLicencia() {
  const [licencia, setLicencia] = useState(null)
  const [cargando, setCargando] = useState(true)

  const consultar = useCallback(() => {
    setCargando(true)
    return api.licencia
      .estado()
      .then(setLicencia)
      .catch(() => setLicencia(null))
      .finally(() => setCargando(false))
  }, [])

  useEffect(() => {
    consultar()
  }, [consultar])

  return {
    licencia,
    cargando,
    consultar,
    vencida: licencia ? licencia.habilitada === false : false,
  }
}
