import test from 'node:test'
import assert from 'node:assert/strict'

import { esVersionVieja } from '../../web/src/lib/versionNueva.js'

/**
 * Después de actualizar el servidor, una pestaña abierta pide archivos que ya
 * no existen. Se reconoce para recargar sola; cualquier otro error se muestra.
 */
test('reconoce el error de una versión vieja de la página', () => {
  for (const m of [
    'Failed to fetch dynamically imported module: https://crmpiloto.smartbotai.net/assets/Dashboard-m9mGcc-G.js',
    'Importing a module script failed.',
    'error loading dynamically imported module',
    'Unable to preload CSS for /assets/index-abc.css',
  ]) {
    assert.equal(esVersionVieja(new Error(m)), true, m)
  }
  for (const m of ['Failed to fetch', 'Cannot read properties of undefined', '']) {
    assert.equal(esVersionVieja(new Error(m)), false, m)
  }
})
