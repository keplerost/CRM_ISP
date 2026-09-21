import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * La base del servidor de licencias.
 *
 * SQLite en un archivo, a propósito. Acá no hay miles de filas: hay una por ISP
 * al que le vendiste el sistema. Un motor aparte sería una pieza más que
 * mantener, respaldar y que se puede caer — y si esta base se cae, ninguno de
 * tus clientes puede renovar.
 *
 * Un archivo se respalda copiándolo. Eso importa más que cualquier otra cosa:
 * perder esta base significa perder la lista de quién te paga.
 */

const RUTA = process.env.LICENCIA_DB || './datos/licencias.db'

mkdirSync(dirname(RUTA), { recursive: true })

export const db = new DatabaseSync(RUTA)

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS instalaciones (
      -- El identificador que genera la instalación del cliente. No lo elegís
      -- vos: te lo trae él, o aparece solo la primera vez que su sistema
      -- intenta renovar.
      id              TEXT PRIMARY KEY,

      isp             TEXT,
      contacto        TEXT,

      -- Por cuántos abonados paga. NULL = sin límite.
      plan_clientes   INTEGER,
      precio_mensual  REAL,

      -- Hasta cuándo pagó. Es LO que decide si se le emite permiso.
      pagado_hasta    TEXT,

      -- Lo último que reportó su sistema. Es lo que se factura, y lo que te
      -- avisa cuando creció y hay que venderle un plan más grande.
      abonados        INTEGER DEFAULT 0,
      ultimo_contacto TEXT,

      -- Corte manual, para el caso feo: el que no paga hace tres meses y no
      -- contesta. Gana sobre la fecha.
      suspendida      INTEGER NOT NULL DEFAULT 0,

      notas           TEXT,
      creada_en       TEXT NOT NULL
  );

  /*
   * Las sesiones del portal del ISP.
   *
   * Se guarda la huella del token, no el token: si esta base se filtra, no se
   * puede entrar con lo que se encontró.
   */
  CREATE TABLE IF NOT EXISTS sesiones (
      token_hash  TEXT PRIMARY KEY,
      instalacion TEXT NOT NULL REFERENCES instalaciones(id) ON DELETE CASCADE,
      expira_en   TEXT NOT NULL,
      creada_en   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pagos (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      instalacion  TEXT NOT NULL REFERENCES instalaciones(id),
      monto        REAL,
      meses        INTEGER NOT NULL DEFAULT 1,
      -- Hasta dónde quedó la licencia después de este pago. Guardarlo permite
      -- reconstruir la cuenta sin rehacer la suma de todos los pagos.
      hasta        TEXT NOT NULL,
      nota         TEXT,
      fecha        TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pagos_instalacion ON pagos (instalacion);
`)

/**
 * Columnas que se agregaron después de la primera versión.
 *
 * SQLite no tiene ADD COLUMN IF NOT EXISTS, así que se pregunta antes. Sin
 * esto, arrancar un servidor que ya venía funcionando fallaría en la segunda
 * ejecución.
 */
for (const [columna, tipo] of [
  ['email', 'TEXT'],
  ['clave_hash', 'TEXT'],
  ['clave_actualizada', 'TEXT'],
]) {
  const existe = db.prepare('PRAGMA table_info(instalaciones)').all().some((c) => c.name === columna)
  if (!existe) db.exec(`ALTER TABLE instalaciones ADD COLUMN ${columna} ${tipo}`)
}

// El correo identifica al ISP para entrar, así que no puede repetirse.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_instalaciones_email
         ON instalaciones (LOWER(email)) WHERE email IS NOT NULL AND email <> ''`)

export const hoy = () => new Date().toISOString().slice(0, 10)

/** Suma meses a una fecha, cuidando los meses que no tienen ese día. */
export function sumarMeses(desdeISO, meses) {
  const d = new Date(`${desdeISO}T00:00:00Z`)
  const dia = d.getUTCDate()
  d.setUTCMonth(d.getUTCMonth() + meses)
  // El 31 de enero más un mes no existe: JavaScript lo desborda al 3 de marzo.
  // Se corrige al último día del mes que corresponde.
  if (d.getUTCDate() < dia) d.setUTCDate(0)
  return d.toISOString().slice(0, 10)
}

export const listar = () =>
  db.prepare('SELECT * FROM instalaciones ORDER BY COALESCE(isp, id)').all()

export const buscar = (id) =>
  db.prepare('SELECT * FROM instalaciones WHERE id = ?').get(id) ?? null

/**
 * Registra una instalación que apareció sola.
 *
 * Pasa cuando instalás el sistema en un cliente nuevo: su copia empieza a pedir
 * renovación antes de que vos la hayas dado de alta acá. En vez de rechazarla
 * sin dejar rastro, queda anotada y sin pagar — así la ves en la lista y sabés
 * que hay alguien esperando que le vendas.
 */
export function registrarDesconocida(id, abonados) {
  db.prepare(
    `INSERT INTO instalaciones (id, abonados, ultimo_contacto, creada_en)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(id, abonados ?? 0, new Date().toISOString(), new Date().toISOString())
  return buscar(id)
}

export function anotarContacto(id, abonados) {
  db.prepare('UPDATE instalaciones SET abonados = ?, ultimo_contacto = ? WHERE id = ?').run(
    abonados ?? 0,
    new Date().toISOString(),
    id,
  )
}

export function guardar(id, campos) {
  const permitidos = ['isp', 'contacto', 'email', 'plan_clientes', 'precio_mensual', 'notas', 'suspendida', 'pagado_hasta']
  const entradas = Object.entries(campos).filter(([k]) => permitidos.includes(k))
  if (!entradas.length) return buscar(id)

  db.prepare(
    `UPDATE instalaciones SET ${entradas.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`,
  ).run(...entradas.map(([, v]) => v), id)
  return buscar(id)
}

/**
 * Anota un pago y extiende la licencia.
 *
 * Extiende desde la fecha de vencimiento, no desde hoy: el que paga con cinco
 * días de atraso no pierde esos cinco días, y el que paga adelantado los suma.
 * Contar desde hoy le regalaría meses al que siempre paga tarde.
 */
export function registrarPago(id, { monto, meses = 1, nota } = {}) {
  const inst = buscar(id)
  if (!inst) return null

  const desde = inst.pagado_hasta && inst.pagado_hasta > hoy() ? inst.pagado_hasta : hoy()
  const hasta = sumarMeses(desde, Number(meses) || 1)

  db.prepare(
    `INSERT INTO pagos (instalacion, monto, meses, hasta, nota, fecha)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, monto ?? null, Number(meses) || 1, hasta, nota ?? null, new Date().toISOString())

  // Un pago reactiva: cobrarle a alguien y dejarlo suspendido sería un error
  // que solo se descubre cuando llama enojado.
  db.prepare('UPDATE instalaciones SET pagado_hasta = ?, suspendida = 0 WHERE id = ?').run(hasta, id)
  return buscar(id)
}

/** Busca por correo o por código de instalación: el ISP usa el que recuerde. */
export function buscarPorAcceso(quien) {
  const q = String(quien ?? '').trim()
  if (!q) return null

  if (/^[0-9a-f-]{36}$/i.test(q)) return buscar(q)

  return (
    db
      .prepare('SELECT * FROM instalaciones WHERE LOWER(email) = LOWER(?)')
      .get(q) ?? null
  )
}

export function guardarClave(id, hash) {
  db.prepare('UPDATE instalaciones SET clave_hash = ?, clave_actualizada = ? WHERE id = ?').run(
    hash,
    new Date().toISOString(),
    id,
  )
  // Cambiar la contraseña cierra las demás sesiones. Es el punto de cambiarla
  // cuando se sospecha que alguien más entró: si las sesiones viejas siguieran
  // vivas, el cambio no serviría de nada.
  db.prepare('DELETE FROM sesiones WHERE instalacion = ?').run(id)
}

export function abrirSesion(instalacion, tokenHash, dias = 30) {
  db.prepare('INSERT INTO sesiones (token_hash, instalacion, expira_en, creada_en) VALUES (?, ?, ?, ?)').run(
    tokenHash,
    instalacion,
    new Date(Date.now() + dias * 86400000).toISOString(),
    new Date().toISOString(),
  )
}

export function instalacionDeSesion(tokenHash) {
  const s = db.prepare('SELECT * FROM sesiones WHERE token_hash = ?').get(tokenHash)
  if (!s) return null
  if (new Date(s.expira_en) < new Date()) {
    db.prepare('DELETE FROM sesiones WHERE token_hash = ?').run(tokenHash)
    return null
  }
  return buscar(s.instalacion)
}

export const cerrarSesion = (tokenHash) =>
  db.prepare('DELETE FROM sesiones WHERE token_hash = ?').run(tokenHash)

export const pagosDe = (id) =>
  db.prepare('SELECT * FROM pagos WHERE instalacion = ? ORDER BY fecha DESC LIMIT 24').all(id)
