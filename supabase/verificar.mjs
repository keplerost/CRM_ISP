/**
 * Verifica que Supabase esté bien configurado.
 *
 *   npm run check
 *
 * Comprueba, en orden:
 *   1. Que los .env tengan valores reales (no los de ejemplo).
 *   2. Que el proyecto de Supabase exista y responda.
 *   3. Que las 8 tablas existan.
 *   4. Que RLS esté protegiendo los datos (un anónimo no puede leer).
 *   5. Que el middleware esté configurado.
 *
 * No modifica nada: solo lee y reporta.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')

const TABLAS = [
  'olts',
  'routers_mikrotik',
  'tipos_ont',
  'line_profiles',
  'planes_velocidad',
  'onus',
  'ip_addresses',
  'firewall_bloqueos',
]

let fallos = 0
const ok = (msg) => console.log(`  \x1b[32mOK\x1b[0m    ${msg}`)
const mal = (msg, pista) => {
  fallos++
  console.log(`  \x1b[31mFALLA\x1b[0m ${msg}`)
  if (pista) console.log(`        \x1b[90m→ ${pista}\x1b[0m`)
}
const info = (msg) => console.log(`  \x1b[90m·     ${msg}\x1b[0m`)
const titulo = (msg) => console.log(`\n\x1b[1m${msg}\x1b[0m`)

/** Corta la verificación cuando no tiene sentido seguir. */
class Abortar extends Error {}
const abortar = (motivo) => {
  throw new Abortar(motivo)
}

/** Lee un .env sin dependencias externas. */
function leerEnv(ruta) {
  if (!existsSync(ruta)) return null
  const vars = {}
  for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
    const limpia = linea.trim()
    if (!limpia || limpia.startsWith('#')) continue
    const i = limpia.indexOf('=')
    if (i === -1) continue
    vars[limpia.slice(0, i).trim()] = limpia.slice(i + 1).trim()
  }
  return vars
}

const esRelleno = (v) =>
  !v || v.includes('xxxxxxxxxxxx') || v.includes('...') || v.includes('cambiame-por-una-frase')

/** Decodifica el payload de un JWT para poder mostrar qué rol trae. */
function rolDelJwt(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
    return { rol: payload.role, ref: payload.ref }
  } catch {
    return {}
  }
}

async function main() {
  console.log('\n\x1b[1m\x1b[36mVerificación de Supabase — Taller SmartOLT\x1b[0m')

  // ===========================================================================
  titulo('1. Archivos .env')

  const envWeb = leerEnv(join(raiz, 'web', '.env'))
  const envApi = leerEnv(join(raiz, 'middleware', '.env'))

  if (!envWeb) mal('No existe web/.env', 'Copiá web/.env.example a web/.env')
  if (!envApi) mal('No existe middleware/.env', 'Copiá middleware/.env.example a middleware/.env')
  if (!envWeb || !envApi) abortar('Faltan archivos .env')

  const url = (envWeb.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  const anonKey = envWeb.VITE_SUPABASE_ANON_KEY
  const serviceKey = envApi.SUPABASE_SERVICE_ROLE_KEY

  esRelleno(url)
    ? mal('VITE_SUPABASE_URL todavía tiene el valor de ejemplo', 'Project Settings → API → Project URL')
    : ok(`VITE_SUPABASE_URL = ${url}`)

  if (esRelleno(anonKey)) {
    mal('VITE_SUPABASE_ANON_KEY todavía tiene el valor de ejemplo', 'Es la clave "anon / public"')
  } else {
    const { rol } = rolDelJwt(anonKey)
    rol === 'service_role'
      ? mal(
          'En web/.env pusiste la clave service_role',
          'Ese archivo llega al navegador. Ahí va únicamente la clave anon.',
        )
      : ok(`VITE_SUPABASE_ANON_KEY = rol "${rol ?? 'desconocido'}" (${anonKey.length} caracteres)`)
  }

  envWeb.VITE_DEMO_MODE === 'true'
    ? mal('VITE_DEMO_MODE sigue en true', 'Ponelo en false para usar Supabase de verdad')
    : ok('VITE_DEMO_MODE = false (usa Supabase real)')

  esRelleno(envApi.SUPABASE_URL)
    ? mal('SUPABASE_URL del middleware sin configurar')
    : ok('SUPABASE_URL del middleware configurada')

  if (esRelleno(serviceKey)) {
    mal('SUPABASE_SERVICE_ROLE_KEY sin configurar', 'Es la clave "service_role", distinta de la anon')
  } else {
    const { rol } = rolDelJwt(serviceKey)
    rol === 'service_role'
      ? ok(`SUPABASE_SERVICE_ROLE_KEY = rol "${rol}" (${serviceKey.length} caracteres)`)
      : mal(
          `En middleware/.env pusiste una clave con rol "${rol ?? 'desconocido'}"`,
          'El middleware necesita la service_role para poder leer las credenciales cifradas.',
        )
  }

  esRelleno(envApi.CREDENTIALS_KEY)
    ? mal('CREDENTIALS_KEY sin configurar')
    : ok('CREDENTIALS_KEY configurada')

  // Las dos claves apuntan al mismo proyecto?
  if (!esRelleno(anonKey) && !esRelleno(serviceKey)) {
    const refAnon = rolDelJwt(anonKey).ref
    const refService = rolDelJwt(serviceKey).ref
    if (refAnon && refService && refAnon !== refService) {
      mal(
        'Las dos claves son de proyectos distintos',
        `web/.env apunta a "${refAnon}" y middleware/.env a "${refService}".`,
      )
    }
  }

  if (esRelleno(url) || esRelleno(anonKey)) {
    abortar('Completá web/.env antes de probar la conexión')
  }

  // ===========================================================================
  titulo('2. Conexión con el proyecto')

  const cabeceras = { apikey: anonKey, Authorization: `Bearer ${anonKey}` }
  const pedir = (ruta) =>
    fetch(`${url}${ruta}`, { headers: cabeceras, signal: AbortSignal.timeout(15000) })

  // Sonda de vida: /auth/v1/health responde sin tocar la base, así que distingue
  // "el proyecto no responde" de "el schema no está cargado". El endpoint
  // /rest/v1/ raíz NO sirve: devuelve 401 incluso con una clave anon válida.
  try {
    const res = await pedir('/auth/v1/health')
    if (!res.ok) {
      mal(`El proyecto respondió HTTP ${res.status}`, 'Revisá la URL y que el proyecto no esté pausado.')
      abortar('Proyecto inalcanzable')
    }
    const salud = await res.json()
    ok(`El proyecto responde (${salud.name} ${salud.version})`)
  } catch (err) {
    if (err instanceof Abortar) throw err
    mal(`No se puede contactar ${url}`, `${err.message}. Revisá la URL y tu conexión a internet.`)
    abortar('Proyecto inalcanzable')
  }

  // ===========================================================================
  titulo('3. Tablas del schema')

  let faltantes = 0
  let claveRechazada = false

  for (const tabla of TABLAS) {
    const res = await pedir(`/rest/v1/${tabla}?select=*&limit=1`)
    const cuerpo = await res.text()

    if (res.ok) {
      ok(`${tabla}`)
    } else if (res.status === 404 || /does not exist/i.test(cuerpo)) {
      faltantes++
      mal(`La tabla "${tabla}" no existe`)
    } else if (res.status === 401) {
      claveRechazada = true
      mal(`${tabla} — la clave anon fue rechazada (HTTP 401)`)
    } else if (res.status === 403) {
      ok(`${tabla} — existe (RLS bloqueando, correcto)`)
    } else {
      info(`${tabla} — HTTP ${res.status}: ${cuerpo.slice(0, 120)}`)
    }
  }

  if (faltantes > 0) {
    info('')
    info('Falta ejecutar el schema. En Supabase:')
    info('  SQL Editor → New query → pegar todo supabase/schema.sql → Run')
  }
  if (claveRechazada) {
    info('')
    info('Verificá que copiaste la clave anon completa, sin espacios ni saltos de línea.')
  }

  if (faltantes > 0 || claveRechazada) abortar('El schema no está listo')

  // ===========================================================================
  titulo('4. Row Level Security')

  // Sin token de usuario, la clave anon NO debería devolver datos.
  const resAnon = await pedir('/rest/v1/olts?select=*')
  const cuerpoAnon = await resAnon.text()

  if (resAnon.status === 401 || resAnon.status === 403) {
    ok('RLS bloquea la lectura anónima (correcto)')
  } else if (resAnon.ok) {
    const filas = JSON.parse(cuerpoAnon || '[]')
    filas.length === 0
      ? ok('RLS activo: un usuario no autenticado no obtiene filas')
      : mal(
          `Un usuario NO autenticado puede leer ${filas.length} fila(s) de "olts"`,
          'RLS no está protegiendo la tabla. Volvé a ejecutar la sección de policies de schema.sql.',
        )
  } else {
    info(`Respuesta inesperada al probar RLS (HTTP ${resAnon.status})`)
  }

  // ===========================================================================
  titulo('5. Middleware')

  const puerto = envApi.PORT || 4000
  try {
    const res = await fetch(`http://localhost:${puerto}/api/health`, {
      signal: AbortSignal.timeout(4000),
    })
    const salud = await res.json()
    salud.ok
      ? ok('El middleware está corriendo y bien configurado')
      : mal(
          `Al middleware le falta: ${salud.configuracionFaltante.join(', ')}`,
          'Completá esas variables en middleware/.env y reiniciá',
        )
  } catch {
    info(`No está corriendo en el puerto ${puerto} (no es un error si todavía no lo levantaste)`)
  }
}

try {
  await main()
} catch (err) {
  if (!(err instanceof Abortar)) throw err
}

console.log(
  fallos === 0
    ? '\n\x1b[32m\x1b[1mTodo listo.\x1b[0m Entrá con el usuario que creaste en Authentication → Users.\n'
    : `\n\x1b[31m\x1b[1m${fallos} punto(s) a corregir.\x1b[0m Revisá las pistas de arriba.\n`,
)

// process.exitCode en vez de process.exit(): cortar el proceso de golpe mientras
// quedan sockets abiertos hace que Node aborte con un assert de libuv en Windows.
process.exitCode = fallos === 0 ? 0 : 1
