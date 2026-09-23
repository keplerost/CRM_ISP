import test from 'node:test'
import assert from 'node:assert/strict'

import { principalDe, puedeCambiarA, resumirServicios, tieneContacto } from '../src/lib/servicios.js'

/**
 * Una persona con varios servicios.
 *
 * ── Qué se protege ──
 *
 * Lo más importante está en `puedeCambiarA`: es lo único que separa "mirar mi
 * otro servicio" de "mirar la ficha de otra persona". Una sesión del portal ya
 * está autenticada, así que si esa función dice que sí, se entregan los datos
 * sin preguntar nada más.
 *
 * Después, que `principalDe` sea estable. El código de ingreso se guarda contra
 * una ficha concreta y se valida contra la que elija la siguiente llamada: si
 * las dos no coinciden, el abonado recibe un código que nunca funciona y no hay
 * nada en pantalla que lo explique.
 */

const ficha = (extra = {}) => ({ id: 'a', identificacion: '1207422088', estado: 'activo', ...extra })

// ── principalDe ──────────────────────────────────────────────────────────────

test('sin servicios no hay principal', () => {
  assert.equal(principalDe([]), null)
  assert.equal(principalDe(null), null)
  assert.equal(principalDe(undefined), null)
})

test('con uno solo, ese es', () => {
  const uno = ficha({ id: 'x' })
  assert.equal(principalDe([uno]).id, 'x')
})

test('gana el que ya tiene contraseña del portal', () => {
  // Si la persona puso contraseña, esa es la ficha que viene usando.
  const servicios = [
    ficha({ id: 'nueva', created_at: '2024-01-01', telefono_movil: '0999' }),
    ficha({ id: 'vieja', created_at: '2020-01-01', portal_clave_hash: 'hash' }),
  ]
  assert.equal(principalDe(servicios).id, 'vieja')
})

test('si nadie tiene contraseña, gana el que tiene por dónde recibir el código', () => {
  // Elegir una ficha sin contacto deja a la persona sin poder entrar aunque su
  // otra ficha tenga el celular cargado.
  const servicios = [
    ficha({ id: 'sin-datos', created_at: '2020-01-01' }),
    ficha({ id: 'con-celular', created_at: '2024-01-01', telefono_movil: '0999999999' }),
  ]
  assert.equal(principalDe(servicios).id, 'con-celular')
})

test('si ninguno tiene contacto, gana el más antiguo', () => {
  const servicios = [
    ficha({ id: 'nueva', created_at: '2024-01-01' }),
    ficha({ id: 'vieja', created_at: '2019-06-01' }),
  ]
  assert.equal(principalDe(servicios).id, 'vieja')
})

test('entre varios con contacto, el más antiguo', () => {
  const servicios = [
    ficha({ id: 'b', created_at: '2024-01-01', email: 'b@x.com' }),
    ficha({ id: 'a', created_at: '2021-01-01', telefono: '05' }),
    ficha({ id: 'c', created_at: '2026-01-01', telegram_chat_id: '77' }),
  ]
  assert.equal(principalDe(servicios).id, 'a')
})

test('es estable: el mismo conjunto en otro orden da el mismo resultado', () => {
  // Es la propiedad que sostiene el ingreso. El código se guarda contra la
  // ficha que elige `pedirCodigo` y se valida contra la que elige `entrar`: si
  // no eligen igual, el abonado recibe un código que nunca va a funcionar.
  const a = ficha({ id: 'a', created_at: '2022-01-01', email: 'a@x.com' })
  const b = ficha({ id: 'b', created_at: '2023-01-01', email: 'b@x.com' })
  const c = ficha({ id: 'c', created_at: '2021-01-01', email: 'c@x.com' })

  const esperado = principalDe([a, b, c]).id
  assert.equal(principalDe([c, b, a]).id, esperado)
  assert.equal(principalDe([b, a, c]).id, esperado)
  assert.equal(principalDe([c, a, b]).id, esperado)
})

test('sin fecha de creación sigue siendo estable', () => {
  // Las fichas migradas pueden no traerla. Sin desempate por id, dos llamadas
  // seguidas podrían elegir fichas distintas.
  const a = ficha({ id: 'aaa' })
  const b = ficha({ id: 'bbb' })
  assert.equal(principalDe([a, b]).id, principalDe([b, a]).id)
})

// ── tieneContacto ────────────────────────────────────────────────────────────

test('cualquiera de los cuatro canales cuenta como contacto', () => {
  assert.equal(tieneContacto({ telefono_movil: '0999' }), true)
  assert.equal(tieneContacto({ telefono: '052' }), true)
  assert.equal(tieneContacto({ email: 'a@b.com' }), true)
  assert.equal(tieneContacto({ telegram_chat_id: '123' }), true)
  assert.equal(tieneContacto({}), false)
  assert.equal(tieneContacto(null), false)
})

test('un campo vacío no es un contacto', () => {
  // Viene así de una importación: la columna existe y trae cadena vacía.
  assert.equal(tieneContacto({ telefono_movil: '', email: '' }), false)
})

// ── puedeCambiarA ────────────────────────────────────────────────────────────

test('se puede cambiar entre servicios de la misma cédula', () => {
  const actual = ficha({ id: 'casa', identificacion: '1207422088' })
  const destino = ficha({ id: 'local', identificacion: '1207422088' })
  assert.equal(puedeCambiarA(actual, destino), true)
})

test('no se puede cambiar a la ficha de otra persona', () => {
  const actual = ficha({ id: 'casa', identificacion: '1207422088' })
  const otro = ficha({ id: 'ajeno', identificacion: '0913456789' })
  assert.equal(puedeCambiarA(actual, otro), false)
})

test('dos fichas SIN cédula no quedan emparejadas por su vacío', () => {
  // El agujero que hay que no dejar. Con 16 de 27 abonados sin identificación
  // cargada, tratar el vacío como coincidencia dejaría a cualquiera de ellos
  // abrir la ficha de los otros quince.
  for (const vacio of ['', null, undefined, '   ']) {
    const actual = ficha({ id: 'uno', identificacion: vacio })
    const destino = ficha({ id: 'dos', identificacion: vacio })
    assert.equal(puedeCambiarA(actual, destino), false, `emparejó con ${JSON.stringify(vacio)}`)
  }
})

test('no se puede cambiar a un servicio dado de baja', () => {
  const actual = ficha({ id: 'casa' })
  const baja = ficha({ id: 'vieja', estado: 'baja' })
  assert.equal(puedeCambiarA(actual, baja), false)
})

test('un destino que no existe no rompe', () => {
  assert.equal(puedeCambiarA(ficha(), null), false)
  assert.equal(puedeCambiarA(null, ficha()), false)
  assert.equal(puedeCambiarA(undefined, undefined), false)
})

test('los espacios alrededor de la cédula no impiden el cambio', () => {
  const actual = ficha({ identificacion: ' 1207422088' })
  const destino = ficha({ id: 'otro', identificacion: '1207422088 ' })
  assert.equal(puedeCambiarA(actual, destino), true)
})

// ── resumirServicios ─────────────────────────────────────────────────────────

test('el resumen no filtra datos que el selector no debe mostrar', () => {
  // Se dibuja ANTES de elegir, así que no puede llevar nada de más.
  const [r] = resumirServicios([
    ficha({
      id: 'casa',
      nombre: 'JENNY VERA',
      referencia_servicio: 'Casa',
      direccion: 'Av. Principal',
      portal_clave_hash: 'secreto',
      telefono_movil: '0999999999',
      identificacion: '1207422088',
    }),
  ], 'casa')

  assert.deepEqual(Object.keys(r).sort(), ['actual', 'direccion', 'id', 'nombre', 'referencia'])
  assert.equal(r.actual, true)
})

test('marca cuál es el que se está viendo', () => {
  const lista = resumirServicios([ficha({ id: 'a' }), ficha({ id: 'b' })], 'b')
  assert.deepEqual(lista.map((x) => x.actual), [false, true])
})
