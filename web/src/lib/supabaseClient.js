import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Los valores de relleno de .env.example cuentan como "sin configurar".
 * Si solo se chequea que la variable exista, copiar el .env.example da un falso
 * positivo: la app cree que está configurada y falla recién al intentar loguearse,
 * con un error de red que no dice nada.
 */
const esRelleno = (v) =>
  !v ||
  v.includes('xxxxxxxxxxxx') ||
  v.includes('...') ||
  v.startsWith('http://localhost:54321')

/** true si el .env tiene valores reales. La UI lo usa para explicar qué falta. */
export const supabaseConfigurado = !esRelleno(url) && !esRelleno(anonKey)

if (!supabaseConfigurado) {
  console.warn(
    'web/.env todavía tiene los valores de ejemplo. Completá VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY con los de tu proyecto de Supabase.',
  )
}

// Se crea igual con placeholders para que la app cargue y muestre el aviso en
// pantalla, en vez de quedar en blanco con un error de consola.
export const supabase = createClient(url || 'http://localhost:54321', anonKey || 'anon-key-faltante')
