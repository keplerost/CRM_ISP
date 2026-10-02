import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Nadie lee la fila entera de un router por su cuenta.
 *
 * La contraseña está cifrada en la base. Una fila leída con `select('*')` y
 * pasada al driver manda la cifrada, y el MikroTik contesta "Username or
 * password is invalid": parece un problema del router y es del sistema. Pasó
 * con la medición de consumo y con las herramientas de la ficha del cliente.
 *
 * La fila entera se lee en `lib/db.js` (cargarRouter), o se pasa por
 * `conClave` antes de hablarle al equipo.
 */

const archivos = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? archivos(p) : p.endsWith('.js') ? [p] : []
  })

test('la fila entera de un router solo se lee donde se descifra', () => {
  const sospechosos = []
  for (const p of archivos('src')) {
    if (p.split(/[\\/]/).slice(-2).join('/') === 'lib/db.js') continue
    const texto = readFileSync(p, 'utf8')
    const re = /from\('routers_mikrotik'\)\s*\.select\('\*'\)/g
    for (const m of texto.matchAll(re)) {
      // Se acepta si el mismo archivo la pasa por conClave.
      if (!texto.includes('conClave(')) sospechosos.push(`${p}:${texto.slice(0, m.index).split('\n').length}`)
    }
  }
  assert.deepEqual(sospechosos, [], 'usar cargarRouter() o conClave()')
})
