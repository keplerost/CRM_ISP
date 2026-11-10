import test from 'node:test'
import assert from 'node:assert/strict'

import { resolverFichaTecnico } from '../src/routes/personal.routes.js'

/** Una base de mentira que anota lo que se le pidió a `tecnicos`. */
function base() {
  const hechos = []
  return {
    hechos,
    from: (tabla) => ({
      insert: (fila) => ({
        select: () => ({
          single: async () => {
            hechos.push(['insert', tabla, fila])
            return { data: { id: 'ficha-nueva' }, error: null }
          },
        }),
      }),
      update: (cambios) => ({
        eq: async (_c, id) => {
          hechos.push(['update', tabla, cambios, id])
          return { error: null }
        },
      }),
    }),
  }
}

const JEFF = { nombre: 'Jefferson', apellido: 'Oña', email: 'j@isp.ec', celular: '099', auth_id: 'auth-1' }

test('resolverFichaTecnico: "nuevo" crea la ficha con los datos del usuario', async () => {
  const cliente = base()
  const id = await resolverFichaTecnico('nuevo', JEFF, null, cliente)
  assert.equal(id, 'ficha-nueva')
  const [, tabla, fila] = cliente.hechos[0]
  assert.equal(tabla, 'tecnicos')
  assert.deepEqual(
    { nombre: fila.nombre, email: fila.email, telefono: fila.telefono, user_id: fila.user_id, activo: fila.activo },
    { nombre: 'Jefferson Oña', email: 'j@isp.ec', telefono: '099', user_id: 'auth-1', activo: true },
  )
})

test('resolverFichaTecnico: si ya tenía ficha, la reactiva en vez de duplicarla', async () => {
  const cliente = base()
  const id = await resolverFichaTecnico('nuevo', JEFF, 'ficha-vieja', cliente)
  assert.equal(id, 'ficha-vieja')
  assert.deepEqual(cliente.hechos, [['update', 'tecnicos', { activo: true }, 'ficha-vieja']])
})

test('resolverFichaTecnico: un id o vacío pasan tal cual, sin tocar la base', async () => {
  const cliente = base()
  assert.equal(await resolverFichaTecnico('abc', JEFF, null, cliente), 'abc')
  assert.equal(await resolverFichaTecnico('', JEFF, 'x', cliente), null)
  assert.equal(await resolverFichaTecnico(null, JEFF, null, cliente), null)
  assert.equal(cliente.hechos.length, 0)
})
