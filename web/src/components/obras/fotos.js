import { useEffect, useState } from 'react'

import { supabase } from '../../lib/supabaseClient'
import { comprimirImagen } from '../../lib/soporte'

/**
 * Las fotos de las obras (migración 232): bucket privado `obras`, una carpeta
 * por obra. La base rechaza una ruta que no empiece con el id de la obra.
 */

/** Sube una foto y devuelve su ruta en el bucket. */
export async function subirFotoObra(obraId, archivo, prefijo = 'avance') {
  const blob = await comprimirImagen(archivo)
  const ruta = `${obraId}/${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`
  const { error } = await supabase.storage.from('obras').upload(ruta, blob, { contentType: 'image/jpeg' })
  if (error) throw error
  return ruta
}

/** URLs firmadas (una hora) para una lista de rutas. */
export function useFotosObra(rutas) {
  const clave = (rutas ?? []).filter(Boolean).join('|')
  const [urls, setUrls] = useState({})
  useEffect(() => {
    const lista = clave ? clave.split('|') : []
    if (!lista.length) return
    let vivo = true
    supabase.storage
      .from('obras')
      .createSignedUrls(lista, 3600)
      .then(({ data }) => {
        if (!vivo || !data) return
        setUrls(Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl])))
      })
    return () => {
      vivo = false
    }
  }, [clave])
  return urls
}
