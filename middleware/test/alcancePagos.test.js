import test from 'node:test'
import assert from 'node:assert/strict'

import { tienePermiso, permisosDeRol } from '../../web/src/lib/permisos.js'

/**
 * Quién ve los cobros de quién.
 *
 * ── El agujero que esto fija ──
 *
 * El punto de recaudación entraba a Finanzas → Transacciones y veía los cobros de
 * TODOS los operadores. Peor: su propia pantalla tiene un botón "Mi reporte de
 * hoy" que pedía el PDF solo con las fechas, así que le devolvía el cierre de caja
 * del ISP entero.
 *
 * Lo encontró el ISP entrando con ese perfil, no una revisión del mapa de rutas.
 *
 * La regla ahora: sin `finanzas.ver_todos`, el servidor acota el reporte a lo que
 * cobró quien lo pide, ignorando el operador que haya mandado.
 */

/** La decisión del endpoint, tal como la aplica `/api/pagos/transacciones/pdf`. */
const alcance = (actor, pedido) =>
  tienePermiso(actor, 'finanzas.ver_todos') ? (pedido ?? null) : actor.id

const recaudacion = { id: 'legajo-recaudacion', rol: 'recaudacion', permisos: permisosDeRol('recaudacion') }
const admin = { id: 'legajo-admin', rol: 'admin', permisos: permisosDeRol('admin') }
const cajero = { id: 'legajo-cajero', rol: 'cajero', permisos: permisosDeRol('cajero') }

test('el punto de recaudación solo puede ver lo suyo', () => {
  assert.equal(alcance(recaudacion, null), 'legajo-recaudacion')
})

test('y no puede pedir el de otro cambiando el filtro', () => {
  /**
   * Es el caso que importa: el filtro viaja en la URL y se cambia a mano en dos
   * segundos. El servidor no lo discute, lo ignora.
   */
  assert.equal(alcance(recaudacion, 'legajo-de-otro'), 'legajo-recaudacion')
  assert.equal(alcance(recaudacion, 'legajo-admin'), 'legajo-recaudacion')
})

test('quien consolida ve a todos, o al que elija', () => {
  assert.equal(alcance(admin, null), null, 'sin filtro, todos')
  assert.equal(alcance(admin, 'legajo-recaudacion'), 'legajo-recaudacion', 'o el que pida')
})

test('el cajero tampoco consolida', () => {
  /**
   * Cobra en la ventanilla, no cierra la caja del ISP. Si algún día hace falta,
   * el permiso se le da desde Gestión de personal sin tocar código.
   */
  assert.equal(alcance(cajero, null), 'legajo-cajero')
  assert.equal(tienePermiso(cajero, 'finanzas.ver_todos'), false)
})

test('conciliación y reporte del regulador son de quien consolida', () => {
  for (const permiso of ['finanzas.conciliacion', 'finanzas.reporte_arcotel']) {
    assert.equal(tienePermiso(recaudacion, permiso), false, `recaudación no tiene ${permiso}`)
    assert.equal(tienePermiso(cajero, permiso), false, `el cajero no tiene ${permiso}`)
    assert.equal(tienePermiso(admin, permiso), true, `el administrador sí tiene ${permiso}`)
  }
})

test('el rol de recaudación no tiene ningún permiso de finanzas', () => {
  /**
   * Se comprueba el conjunto entero y no permiso por permiso: el día que se
   * agregue uno nuevo al módulo, esta prueba lo agarra sin que nadie se acuerde
   * de volver acá.
   */
  const suyos = permisosDeRol('recaudacion')
  const finanzas = suyos.filter((p) => p.startsWith('finanzas.'))

  assert.deepEqual(finanzas, [], `recaudación no debería tener: ${finanzas.join(', ')}`)
})
