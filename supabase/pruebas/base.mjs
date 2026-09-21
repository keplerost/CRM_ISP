import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * Un Postgres de verdad, en memoria, para probar las migraciones.
 *
 * ── Por qué hace falta ──
 *
 * Las migraciones son el único código del proyecto que se ejecuta a mano, una
 * vez, contra la base de producción. Si una falla a la mitad, lo que queda es un
 * esquema roto en el peor momento posible.
 *
 * Y hay una clase entera de errores que no se ve leyendo el archivo: plpgsql
 * compila el cuerpo de una función recién cuando alguien la invoca. Una columna
 * ambigua o un tipo que no cierra se crean sin una sola queja y explotan meses
 * después, la primera vez que alguien aprieta el botón. Eso ya pasó acá: la
 * revisión del módulo de comisiones se creó perfecta y no corría.
 *
 * PGlite es Postgres 16 compilado a WebAssembly. Arranca en un segundo, no pide
 * instalar nada y corre el mismo SQL que el servidor.
 *
 * ── Lo que este arnés NO comprueba ──
 *
 * Que los datos de producción sobrevivan. Acá la base arranca vacía, así que se
 * verifica que el esquema se construya y que las funciones corran, no que una
 * migración no rompa filas que ya existen.
 */

const DIR = fileURLToPath(new URL('..', import.meta.url))

/**
 * Lo que Supabase trae puesto y una base pelada no tiene.
 *
 * Sin esto las migraciones fallarían por el entorno y no por su contenido, que
 * es justo lo que se quiere medir. Son las mismas piezas que usa cualquier
 * proyecto de Supabase: el esquema `auth` con su `uid()`, los tres roles a los
 * que se le dan permisos, y el esquema `storage` con los ayudantes que usan las
 * políticas de los buckets.
 */
const ENTORNO = `
CREATE ROLE authenticated;
CREATE ROLE anon;
CREATE ROLE service_role;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb,
    created_at timestamptz DEFAULT now()
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'authenticated'::text $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;

CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
    id text PRIMARY KEY,
    name text NOT NULL,
    public boolean DEFAULT false,
    file_size_limit bigint,
    allowed_mime_types text[],
    created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS storage.objects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id text REFERENCES storage.buckets(id),
    name text,
    owner uuid,
    metadata jsonb,
    created_at timestamptz DEFAULT now()
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE partes text[];
BEGIN
    partes := string_to_array(name, '/');
    RETURN partes[1:array_length(partes, 1) - 1];
END $fn$;

CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE partes text[];
BEGIN
    partes := string_to_array(name, '/');
    RETURN partes[array_length(partes, 1)];
END $fn$;

CREATE OR REPLACE FUNCTION storage.extension(name text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE partes text[];
BEGIN
    partes := string_to_array(name, '.');
    RETURN partes[array_length(partes, 1)];
END $fn$;

-- pgcrypto no viene compilado en PGlite. gen_random_uuid() es del núcleo desde
-- PG13, así que solo hacen falta las tres que usa el portal del cliente.
CREATE OR REPLACE FUNCTION crypt(text, text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT md5($1 || $2) $$;
CREATE OR REPLACE FUNCTION gen_salt(text) RETURNS text LANGUAGE sql VOLATILE AS $$ SELECT 'sal'::text $$;
CREATE OR REPLACE FUNCTION digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT decode(md5($1), 'hex') $$;
`

/**
 * El orden real de ejecución.
 *
 * Ordenar por nombre pondría la 100 justo después de la 10, y la 26b antes que
 * la 26. Se separa el número de la letra y se ordena por los dos.
 */
function orden(nombre) {
  const m = nombre.match(/^migracion-(\d+)([a-z]?)-/)
  return m ? [Number(m[1]), m[2] || ''] : [0, '']
}

export const MIGRACIONES = readdirSync(DIR)
  .filter((f) => f.startsWith('migracion-') && f.endsWith('.sql'))
  .sort((a, b) => {
    const [na, la] = orden(a)
    const [nb, lb] = orden(b)
    return na - nb || la.localeCompare(lb)
  })

/** El número de una migración, para poder correr un tramo. */
export const numero = (archivo) => orden(archivo)[0]

/** El `CREATE EXTENSION` se saca: la función que trae está stubbeada arriba. */
const leer = (f) =>
  readFileSync(join(DIR, f), 'utf8').replace(
    /CREATE EXTENSION IF NOT EXISTS pgcrypto;/g,
    '-- (pgcrypto: stubbeado en el arnés de pruebas)',
  )

/** Una base nueva con el entorno de Supabase puesto y el esquema base cargado. */
export async function crearBase() {
  const db = await new PGlite()
  await db.exec(ENTORNO)
  await db.exec(leer('schema.sql'))
  return db
}

/**
 * Corre las migraciones y devuelve las que fallaron.
 *
 * No corta en la primera: interesa el mapa completo, porque un fallo temprano
 * suele arrastrar a los cinco siguientes y verlos juntos dice cuál es el
 * verdadero.
 */
export async function correrCadena(db, { desde = 0, hasta = Infinity } = {}) {
  const fallos = []
  for (const f of MIGRACIONES) {
    const n = numero(f)
    if (n < desde || n > hasta) continue
    try {
      await db.exec(leer(f))
    } catch (err) {
      fallos.push({
        archivo: f,
        mensaje: String(err.message).split('\n')[0],
        detalle: err.detail ?? err.hint ?? '',
      })
    }
  }
  return fallos
}

/**
 * Cambia quién está usando el sistema.
 *
 * Todo el control de acceso cuelga de `auth.uid()`: los permisos, las políticas
 * de RLS y las funciones que exigen legajo. Redefinirla es la forma de probar
 * que un vendedor no puede aprobar su propia comisión sin inventar un servidor
 * de autenticación.
 */
export async function sesion(db, authId) {
  await db.exec(
    authId
      ? `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $x$ SELECT '${authId}'::uuid $x$`
      : `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $x$ SELECT NULL::uuid $x$`,
  )
}

/** Una sola fila, que es lo que devuelve casi todo lo que se prueba acá. */
export async function fila(db, sql) {
  const r = await db.query(sql)
  return r.rows[0] ?? null
}
