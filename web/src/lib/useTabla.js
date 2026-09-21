import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { modoDemo, demoDb } from './demo'

/**
 * CRUD sobre una tabla de Supabase.
 *
 * El frontend habla directo con Supabase (RLS protege los datos); el middleware
 * solo entra en juego para lo que toca la red. Esto evita duplicar un CRUD entero
 * en el backend.
 */
export function useTabla(tabla, { select = '*', orderBy = 'created_at', ascending = false } = {}) {
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    setError(null)

    if (modoDemo) {
      setFilas(await demoDb.listar(tabla, { orderBy, ascending }))
      setCargando(false)
      return
    }

    const { data, error: err } = await supabase
      .from(tabla)
      .select(select)
      .order(orderBy, { ascending })
    if (err) setError(traducir(err, tabla))
    else setFilas(data ?? [])
    setCargando(false)
  }, [tabla, select, orderBy, ascending])

  useEffect(() => {
    recargar()
  }, [recargar])

  const insertar = useCallback(
    async (fila) => {
      if (modoDemo) {
        const nueva = await demoDb.insertar(tabla, fila)
        await recargar()
        return nueva
      }
      const { data, error: err } = await supabase.from(tabla).insert(fila).select().single()
      if (err) throw traducir(err, tabla)
      await recargar()
      return data
    },
    [tabla, recargar],
  )

  const actualizar = useCallback(
    async (id, cambios) => {
      if (modoDemo) {
        await demoDb.actualizar(tabla, id, cambios)
      } else {
        const { error: err } = await supabase.from(tabla).update(cambios).eq('id', id)
        if (err) throw traducir(err, tabla)
      }
      await recargar()
    },
    [tabla, recargar],
  )

  const eliminar = useCallback(
    async (id) => {
      if (modoDemo) {
        await demoDb.eliminar(tabla, id)
      } else {
        const { error: err } = await supabase.from(tabla).delete().eq('id', id)
        if (err) throw traducir(err, tabla)
      }
      await recargar()
    },
    [tabla, recargar],
  )

  return { filas, cargando, error, recargar, insertar, actualizar, eliminar, setError }
}

/** Convierte los errores de PostgREST en algo que se entienda sin abrir la consola. */
function traducir(err, tabla) {
  const e = new Error(err.message)
  e.hint = err.hint

  if (err.code === '42P01') {
    e.message = `La tabla "${tabla}" no existe en Supabase`
    e.hint = 'Ejecutá supabase/schema.sql en el SQL Editor del proyecto.'
  } else if (err.code === '42501' || /row-level security/i.test(err.message)) {
    e.message = `Sin permiso para operar sobre "${tabla}"`
    e.hint = 'RLS está bloqueando la operación. Verificá que estés autenticado y que las policies del schema.sql se hayan creado.'
  } else if (err.code === '23505') {
    e.message = 'Ya existe un registro con esos datos'
    e.hint = err.details
  } else if (err.code === '23503') {
    e.message = 'El registro está referenciado por otro y no se puede borrar'
    e.hint = err.details
  }

  return e
}
