import { useEffect, useState } from 'react'
import { configurarMoneda } from './formato'

/**
 * El nombre, el logo y la moneda del sistema.
 *
 * Se pide una sola vez y se guarda acá: la marca no cambia mientras alguien usa
 * el sistema, y pedirla en cada pantalla sería una consulta por navegación para
 * traer siempre lo mismo.
 *
 * Si no se puede leer —el middleware está apagado, no hay red— se usan los
 * valores por defecto en vez de dejar la pantalla en blanco. Alguien que no
 * puede entrar tiene que ver el formulario de entrada, no un cartel de error
 * sobre el nombre del sistema.
 *
 * Usa `fetch` pelado y NO el cliente del sistema. No es un capricho: ese
 * cliente arrastra el SDK de Supabase, y el portal del abonado lo estaba
 * descargando entero —medio megabyte— solo para saber cómo se llama el ISP.
 * El abonado entra desde el celular con datos móviles.
 */

const BASE = (import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/$/, '')

const POR_DEFECTO = {
  nombre_sistema: 'Taller SmartOLT',
  lema: 'Gestión de OLTs y MikroTik',
  logo_b64: null,
  moneda_simbolo: '$',
}

let cache = null
let pedido = null

function traer() {
  if (cache) return Promise.resolve(cache)
  pedido ??= fetch(`${BASE}/api/general`)
    .then((r) => (r.ok ? r.json() : POR_DEFECTO))
    .catch(() => POR_DEFECTO)
    .then((m) => {
      cache = m
      configurarMoneda(m.moneda_simbolo)
      // La pestaña del navegador: es cómo se distingue esta instalación de las
      // otras diez que alguien puede tener abiertas.
      document.title = m.lema ? `${m.nombre_sistema} — ${m.lema}` : m.nombre_sistema
      return m
    })
  return pedido
}

export function useMarca() {
  const [marca, setMarca] = useState(cache ?? POR_DEFECTO)

  useEffect(() => {
    let vivo = true
    traer().then((m) => vivo && setMarca(m))
    return () => {
      vivo = false
    }
  }, [])

  return marca
}
