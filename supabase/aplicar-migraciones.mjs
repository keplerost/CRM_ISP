/**
 * Aplica TODAS las migraciones, en orden, contra una base nueva.
 *
 *   node supabase/aplicar-migraciones.mjs "postgresql://..."      ← por Postgres
 *   SUPABASE_ACCESS_TOKEN=sbp_... node supabase/aplicar-migraciones.mjs --api <ref>
 *
 * Sirve para armar un ambiente de prueba desde cero: 178 archivos pegados a
 * mano en el SQL Editor son una tarde perdida y, peor, una oportunidad de
 * saltearse uno sin darse cuenta —y una base a la que le falta una migración
 * del medio falla mucho después, en un lugar que no tiene nada que ver.
 *
 * ── Por qué hay dos caminos ──
 *
 * El natural es conectarse a Postgres. Pero Supabase dejó la conexión directa
 * en IPv6 para el plan gratuito, y una red sin salida IPv6 —que es la mayoría
 * de las de acá— simplemente no la alcanza. El pooler sí tiene IPv4, pero su
 * nombre de host depende de la región y hay que copiarlo del panel.
 *
 * La API de administración funciona siempre: es HTTPS contra api.supabase.com.
 * Necesita un token personal (Account → Access Tokens).
 *
 * ── Contra qué base se puede correr ──
 *
 * Contra la de PRUEBA. El script se niega a correr si el proyecto coincide con
 * el de `middleware/.env`, que es producción. No es paranoia: la diferencia
 * entre las dos cadenas son unos caracteres en el medio de un texto largo, y el
 * precio de equivocarse es reescribir la base que factura.
 *
 * ── Por qué lleva registro ──
 *
 * Guarda en `_migraciones_aplicadas` cuáles ya corrieron, así se puede volver a
 * ejecutar cuando se agregan migraciones nuevas y solo aplica las que faltan.
 * Las migraciones son idempotentes, pero eso no es excusa para correr 178
 * archivos cada vez: cuando una falla, importa saber si es la primera vez.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'supabase'

/**
 * El orden importa y la numeración tiene trampas.
 *
 * Hay `26b`, `28b` y `31b`, que van DESPUÉS de su número y antes del siguiente.
 * Ordenar por nombre de archivo pondría `migracion-100` antes que
 * `migracion-99`, y `26b` antes que `26`. Se ordena por número y después por
 * letra.
 */
function enOrden() {
  const clave = (f) => {
    const m = f.match(/^migracion-(\d+)([a-z]?)-/)
    return m ? [Number(m[1]), m[2] || ''] : [Number.MAX_SAFE_INTEGER, '']
  }

  const migraciones = readdirSync(DIR)
    .filter((f) => /^migracion-.*\.sql$/.test(f))
    .sort((a, b) => {
      const A = clave(a)
      const B = clave(b)
      return A[0] - B[0] || A[1].localeCompare(B[1])
    })

  /**
   * `schema.sql` va primero, siempre.
   *
   * Crea las ocho tablas de las que parte todo —olts, routers_mikrotik, onus…—
   * y la migración 01 ya las da por existentes: contra una base nueva falla en
   * el primer renglón con `relation "routers_mikrotik" does not exist`, que no
   * dice en ningún lado que lo que falta es este archivo.
   *
   * `limpieza-datos-de-prueba.sql` queda afuera a propósito: es una herramienta
   * para vaciar datos, no parte del esquema.
   */
  return ['schema.sql', ...migraciones]
}

/** El proyecto que usa el middleware hoy. Es el que NO hay que tocar. */
function refDeProduccion() {
  try {
    const env = readFileSync('middleware/.env', 'utf8')
    const m = env.match(/SUPABASE_URL\s*=\s*https:\/\/([a-z0-9]+)\.supabase\.co/i)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function frenar(mensaje) {
  console.error(`\n  ALTO. ${mensaje}\n`)
  process.exit(1)
}

// =============================================================================
// Los dos caminos, con la misma forma
// =============================================================================

/**
 * Por la API de administración.
 *
 * Cada llamada corre en su propia conexión, así que el BEGIN/COMMIT tiene que
 * ir DENTRO del texto que se manda: no se puede abrir una transacción en una
 * llamada y cerrarla en otra.
 */
function porApi(ref, token) {
  const pedir = async (sql) => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    })
    const cuerpo = await r.json().catch(() => null)
    if (!r.ok) throw new Error(cuerpo?.message ?? `HTTP ${r.status}`)
    return Array.isArray(cuerpo) ? cuerpo : []
  }

  return {
    describir: async () => {
      const [f] = await pedir('SELECT current_database() AS db, version() AS v')
      return `${f.db} — ${f.v.split(',')[0]}`
    },
    consultar: pedir,
    aplicar: (sql, archivo) =>
      pedir(
        ['BEGIN;', sql, ';', marcar(archivo), 'COMMIT;'].join('\n'),
      ),
    cerrar: async () => {},
  }
}

/** Por una conexión Postgres directa o por el pooler. */
async function porPostgres(cadena) {
  const { default: pg } = await import('pg')
  const cliente = new pg.Client({
    connectionString: cadena,
    // Supabase exige TLS pero con un certificado que Node no valida contra su
    // almacén por defecto. Es la conexión a una base propia, no a un tercero.
    ssl: { rejectUnauthorized: false },
  })
  await cliente.connect()

  return {
    describir: async () => {
      const { rows } = await cliente.query('SELECT current_database() AS db, version() AS v')
      return `${rows[0].db} — ${rows[0].v.split(',')[0]}`
    },
    consultar: async (sql) => (await cliente.query(sql)).rows,
    aplicar: async (sql, archivo) => {
      try {
        await cliente.query('BEGIN')
        await cliente.query(sql)
        await cliente.query(marcar(archivo))
        await cliente.query('COMMIT')
      } catch (err) {
        await cliente.query('ROLLBACK').catch(() => {})
        throw err
      }
    },
    cerrar: () => cliente.end(),
  }
}

/** El registro se escribe adentro de la misma transacción que la migración. */
const marcar = (archivo) =>
  `INSERT INTO _migraciones_aplicadas (archivo) VALUES ('${archivo.replace(/'/g, "''")}');`

// =============================================================================
// El trabajo, igual para los dos caminos
// =============================================================================

async function correr(base) {
  console.log(`Conectado a ${await base.describir()}\n`)

  await base.consultar(`
    CREATE TABLE IF NOT EXISTS _migraciones_aplicadas (
      archivo     TEXT PRIMARY KEY,
      aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)

  const yaEstan = await base.consultar('SELECT archivo FROM _migraciones_aplicadas')
  const aplicadas = new Set(yaEstan.map((r) => r.archivo))

  const archivos = enOrden()
  const pendientes = archivos.filter((f) => !aplicadas.has(f))

  console.log(
    `${archivos.length} migraciones · ${aplicadas.size} ya aplicadas · ${pendientes.length} por correr\n`,
  )

  if (!pendientes.length) {
    console.log('No hay nada que hacer.')
    await base.cerrar()
    return
  }

  let n = 0
  for (const archivo of pendientes) {
    n++
    const etiqueta = `[${String(n).padStart(3)}/${pendientes.length}] ${archivo}`

    try {
      await base.aplicar(readFileSync(join(DIR, archivo), 'utf8'), archivo)
      console.log(`  ok   ${etiqueta}`)
    } catch (err) {
      console.error(`\n  FALLÓ ${etiqueta}`)
      console.error(`  ${err.message}\n`)
      console.error(`  Las ${n - 1} anteriores quedaron aplicadas. Corregí y volvé a correr:`)
      console.error(`  el script retoma desde acá.\n`)
      await base.cerrar()
      process.exit(1)
    }
  }

  console.log(`\n${pendientes.length} migraciones aplicadas.`)
  console.log('Ahora comprobá el resultado con:  npm run check:prueba')
  await base.cerrar()
}

// =============================================================================
// Entrada
// =============================================================================

const arg = process.argv[2]
const prod = refDeProduccion()

if (arg === '--api') {
  const ref = process.argv[3]
  const token = process.env.SUPABASE_ACCESS_TOKEN

  if (!ref || !token) {
    console.error(`
Faltan datos para el camino por API.

  SUPABASE_ACCESS_TOKEN=sbp_... node supabase/aplicar-migraciones.mjs --api <ref>

El token se genera en: supabase.com/dashboard/account/tokens
El ref es la parte del medio de https://REF.supabase.co
`)
    process.exit(1)
  }

  if (prod && ref === prod) frenar(`"${ref}" es el proyecto de PRODUCCIÓN. Usá el de prueba.`)
  await correr(porApi(ref, token))
} else if (arg) {
  if (prod && arg.includes(prod)) {
    frenar(
      `esa cadena apunta al proyecto "${prod}", que es el de PRODUCCIÓN\n` +
        '  —el que usa middleware/.env—. Este script reescribe el esquema entero.',
    )
  }
  await correr(await porPostgres(arg))
} else {
  console.error(`
Falta decir contra qué base correr.

  node supabase/aplicar-migraciones.mjs "postgresql://..."
  SUPABASE_ACCESS_TOKEN=sbp_... node supabase/aplicar-migraciones.mjs --api <ref>
`)
  process.exit(1)
}
