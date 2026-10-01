import { useEffect, useState } from 'react'
import { traerMarca } from './useMarca'

/**
 * El país del ISP, del lado de la pantalla.
 *
 * El catálogo vive en el middleware (lib/paises.js) y llega con la marca, en el
 * mismo viaje: no se pide aparte. Acá queda solo lo que se usa mientras llega
 * —el perfil de Ecuador, que es lo que había antes—, para que ninguna pantalla
 * esconda la facturación del SRI durante el medio segundo que tarda.
 *
 * Al cambiar el país en Ajustes se actualiza acá también, así el menú y las
 * pantallas abiertas cambian sin recargar.
 */

const ECUADOR = {
  codigo: 'EC',
  nombre: 'Ecuador',
  impuesto: { nombre: 'IVA', tarifa: 15 },
  ente: { sigla: 'SRI', nombre: 'Servicio de Rentas Internas' },
  regulador: { sigla: 'ARCOTEL', nombre: 'Agencia de Regulación y Control de las Telecomunicaciones' },
  moneda: { simbolo: '$', codigo: 'USD' },
  zona: 'America/Guayaquil',
  prefijo: '+593',
  documentos: {
    '05': { nombre: 'Cédula', largo: 10, ejemplo: '1712345678' },
    '04': { nombre: 'RUC', largo: 13, ejemplo: '1790012345001' },
    '06': { nombre: 'Pasaporte' },
    '07': { nombre: 'Consumidor final' },
    '08': { nombre: 'Identificación del exterior' },
  },
  modulos: { facturacionElectronica: true, reporteRegulador: true, contratoRegulador: true },
}

let cache = null
const oyentes = new Set()

function avisar(perfil) {
  cache = perfil
  for (const o of oyentes) o(perfil)
}

/** Después de cambiar el país: que todas las pantallas abiertas se enteren. */
export const fijarPais = (perfil) => avisar(perfil)

export function usePais() {
  const [pais, setPais] = useState(cache ?? ECUADOR)

  useEffect(() => {
    oyentes.add(setPais)
    if (cache) setPais(cache)
    else traerMarca().then((m) => !cache && m?.pais && avisar(m.pais))
    return () => oyentes.delete(setPais)
  }, [])

  return pais
}

/** Nombre del documento por su rol (05 persona, 04 empresa, 08 extranjero…). */
export const nombreDocumento = (pais, codigo) => pais?.documentos?.[codigo]?.nombre ?? codigo
