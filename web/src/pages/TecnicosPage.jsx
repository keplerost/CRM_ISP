import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../lib/confirmar'
import { HardHat, Pencil, Plus, Trash2, Truck, Users } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import ConPermiso from '../components/layout/ConPermiso'
import {
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
  Table,
} from '../components/ui'

/**
 * Quién puede recibir una orden de trabajo.
 *
 * Sin esta pantalla los técnicos habría que cargarlos por SQL, y el ticket
 * quedaría siempre sin asignar. Es chica a propósito: son datos que se tocan
 * una vez al mes, no todos los días.
 */

const ESPECIALIDADES = {
  ambas: 'Fibra y radio',
  ftth: 'Solo fibra',
  wireless: 'Solo radio',
}

const TECNICO_VACIO = {
  nombre: '',
  identificacion: '',
  telefono: '',
  email: '',
  especialidad: 'ambas',
  activo: true,
}

const CUADRILLA_VACIA = { nombre: '', zona: '', vehiculo: '', activo: true }

export default function TecnicosPage() {
  const confirmar = useConfirmar()
  const [tecnicos, setTecnicos] = useState([])
  const [cuadrillas, setCuadrillas] = useState([])
  const [miembros, setMiembros] = useState([])
  const [error, setError] = useState(null)
  const [cargando, setCargando] = useState(true)

  const [editandoTecnico, setEditandoTecnico] = useState(null)
  const [editandoCuadrilla, setEditandoCuadrilla] = useState(null)
  const [guardando, setGuardando] = useState(false)

  const recargar = useCallback(async () => {
    setCargando(true)
    const [t, c, m] = await Promise.all([
      supabase.from('tecnicos').select('*').order('nombre'),
      supabase.from('cuadrillas').select('*').order('nombre'),
      supabase.from('cuadrilla_miembros').select('*'),
    ])
    if (t.error) setError(t.error)
    setTecnicos(t.data ?? [])
    setCuadrillas(c.data ?? [])
    setMiembros(m.data ?? [])
    setCargando(false)
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  async function guardarTecnico(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)

    try {
      const { id, ...datos } = editandoTecnico
      const fila = {
        nombre: datos.nombre.trim(),
        identificacion: datos.identificacion?.trim() || null,
        telefono: datos.telefono?.trim() || null,
        email: datos.email?.trim() || null,
        especialidad: datos.especialidad,
        activo: Boolean(datos.activo),
      }

      const { error: err } = id
        ? await supabase.from('tecnicos').update(fila).eq('id', id)
        : await supabase.from('tecnicos').insert(fila)
      if (err) throw err

      setEditandoTecnico(null)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  async function guardarCuadrilla(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)

    try {
      const { id, integrantes = [], ...datos } = editandoCuadrilla
      const fila = {
        nombre: datos.nombre.trim(),
        zona: datos.zona?.trim() || null,
        vehiculo: datos.vehiculo?.trim() || null,
        activo: Boolean(datos.activo),
      }

      const { data: guardada, error: err } = id
        ? await supabase.from('cuadrillas').update(fila).eq('id', id).select().single()
        : await supabase.from('cuadrillas').insert(fila).select().single()
      if (err) throw err

      // Se reemplaza la lista entera: es más simple que calcular altas y bajas,
      // y son tres filas.
      await supabase.from('cuadrilla_miembros').delete().eq('cuadrilla_id', guardada.id)
      if (integrantes.length) {
        await supabase.from('cuadrilla_miembros').insert(
          integrantes.map((tecnico_id) => ({ cuadrilla_id: guardada.id, tecnico_id })),
        )
      }

      setEditandoCuadrilla(null)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  async function borrar(tabla, id, aviso) {
    if (!await confirmar(aviso)) return
    const { error: err } = await supabase.from(tabla).delete().eq('id', id)
    if (err) setError(err)
    await recargar()
  }

  const integrantesDe = (cuadrillaId) =>
    miembros.filter((m) => m.cuadrilla_id === cuadrillaId).map((m) => m.tecnico_id)

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-100">
          <HardHat className="text-amber-400" /> Técnicos y cuadrillas
        </h1>
        <p className="text-sm text-slate-500">A quién se le pueden asignar los tickets.</p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <Card
        title="Técnicos"
        icon={Users}
        actions={
          <ConPermiso permiso="usuarios.crear" envezDe={null}>
            <Button variante="primario" icon={Plus} onClick={() => setEditandoTecnico(TECNICO_VACIO)}>
              Agregar
            </Button>
          </ConPermiso>
        }
      >
        <Table
          columnas={['Nombre', 'Cédula', 'Teléfono', 'Especialidad', 'Estado', '']}
          filas={cargando ? [] : tecnicos}
          vacio="Todavía no hay técnicos cargados."
          renderFila={(t) => (
            <tr key={t.id} className="border-t border-slate-800">
              <td className="px-3 py-2 text-slate-200">{t.nombre}</td>
              <td className="px-3 py-2 font-mono text-xs">{t.identificacion ?? '—'}</td>
              <td className="px-3 py-2 font-mono text-xs">{t.telefono ?? '—'}</td>
              <td className="px-3 py-2 text-xs">{ESPECIALIDADES[t.especialidad]}</td>
              <td className="px-3 py-2 text-xs">
                {t.activo ? (
                  <span className="text-emerald-400">Activo</span>
                ) : (
                  <span className="text-slate-500">Inactivo</span>
                )}
              </td>
              <td className="px-3 py-2">
                <div className="flex justify-end gap-1">
                  <ConPermiso permiso="usuarios.editar" envezDe={null}>
                    <Button variante="fantasma" icon={Pencil} onClick={() => setEditandoTecnico(t)} />
                  </ConPermiso>
                  <ConPermiso permiso="usuarios.eliminar" envezDe={null}>
                    <Button
                      variante="fantasma"
                      icon={Trash2}
                      onClick={() =>
                        borrar(
                          'tecnicos',
                          t.id,
                          `¿Borrar a ${t.nombre}? Los tickets que tenga asignados quedan sin técnico.`,
                        )
                      }
                    />
                  </ConPermiso>
                </div>
              </td>
            </tr>
          )}
        />
      </Card>

      <Card
        title="Cuadrillas"
        icon={Truck}
        subtitle="Equipos que salen juntos"
        actions={
          <ConPermiso permiso="usuarios.crear" envezDe={null}>
            <Button
              variante="primario"
              icon={Plus}
              onClick={() => setEditandoCuadrilla({ ...CUADRILLA_VACIA, integrantes: [] })}
            >
              Agregar
            </Button>
          </ConPermiso>
        }
      >
        <Table
          columnas={['Nombre', 'Zona', 'Vehículo', 'Integrantes', '']}
          filas={cargando ? [] : cuadrillas}
          vacio="Sin cuadrillas. Se puede asignar a técnicos sueltos igual."
          renderFila={(c) => {
            const ids = integrantesDe(c.id)
            return (
              <tr key={c.id} className="border-t border-slate-800">
                <td className="px-3 py-2 text-slate-200">{c.nombre}</td>
                <td className="px-3 py-2 text-xs">{c.zona ?? '—'}</td>
                <td className="px-3 py-2 text-xs">{c.vehiculo ?? '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-400">
                  {ids.length
                    ? tecnicos
                        .filter((t) => ids.includes(t.id))
                        .map((t) => t.nombre)
                        .join(', ')
                    : 'sin integrantes'}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <ConPermiso permiso="usuarios.editar" envezDe={null}>
                      <Button
                        variante="fantasma"
                        icon={Pencil}
                        onClick={() => setEditandoCuadrilla({ ...c, integrantes: ids })}
                      />
                    </ConPermiso>
                    <ConPermiso permiso="usuarios.eliminar" envezDe={null}>
                      <Button
                        variante="fantasma"
                        icon={Trash2}
                        onClick={() => borrar('cuadrillas', c.id, `¿Borrar la cuadrilla ${c.nombre}?`)}
                      />
                    </ConPermiso>
                  </div>
                </td>
              </tr>
            )
          }}
        />
      </Card>

      {/* --- Modal técnico --- */}
      <Modal
        abierto={Boolean(editandoTecnico)}
        titulo={editandoTecnico?.id ? 'Editar técnico' : 'Nuevo técnico'}
        onCerrar={() => setEditandoTecnico(null)}
      >
        {editandoTecnico && (
          <form onSubmit={guardarTecnico} className="space-y-4">
            <Field label="Nombre">
              <Input
                value={editandoTecnico.nombre}
                onChange={(e) => setEditandoTecnico((t) => ({ ...t, nombre: e.target.value }))}
                required
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Cédula">
                <Input
                  value={editandoTecnico.identificacion ?? ''}
                  onChange={(e) =>
                    setEditandoTecnico((t) => ({ ...t, identificacion: e.target.value }))
                  }
                />
              </Field>
              <Field label="Teléfono">
                <Input
                  value={editandoTecnico.telefono ?? ''}
                  onChange={(e) => setEditandoTecnico((t) => ({ ...t, telefono: e.target.value }))}
                />
              </Field>
            </div>

            <Field label="Correo">
              <Input
                type="email"
                value={editandoTecnico.email ?? ''}
                onChange={(e) => setEditandoTecnico((t) => ({ ...t, email: e.target.value }))}
              />
            </Field>

            <Field
              label="Especialidad"
              hint="Filtra a quién se le ofrece cada ticket según la tecnología"
            >
              <Select
                value={editandoTecnico.especialidad}
                onChange={(e) =>
                  setEditandoTecnico((t) => ({ ...t, especialidad: e.target.value }))
                }
              >
                {Object.entries(ESPECIALIDADES).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={Boolean(editandoTecnico.activo)}
                onChange={(e) => setEditandoTecnico((t) => ({ ...t, activo: e.target.checked }))}
                className="accent-sky-500"
              />
              Activo — aparece al asignar tickets
            </label>

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setEditandoTecnico(null)}>
                Cancelar
              </Button>
              <Button variante="primario" type="submit" cargando={guardando}>
                Guardar
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* --- Modal cuadrilla --- */}
      <Modal
        abierto={Boolean(editandoCuadrilla)}
        titulo={editandoCuadrilla?.id ? 'Editar cuadrilla' : 'Nueva cuadrilla'}
        onCerrar={() => setEditandoCuadrilla(null)}
      >
        {editandoCuadrilla && (
          <form onSubmit={guardarCuadrilla} className="space-y-4">
            <Field label="Nombre">
              <Input
                value={editandoCuadrilla.nombre}
                onChange={(e) => setEditandoCuadrilla((c) => ({ ...c, nombre: e.target.value }))}
                required
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Zona">
                <Input
                  value={editandoCuadrilla.zona ?? ''}
                  onChange={(e) => setEditandoCuadrilla((c) => ({ ...c, zona: e.target.value }))}
                />
              </Field>
              <Field label="Vehículo">
                <Input
                  value={editandoCuadrilla.vehiculo ?? ''}
                  onChange={(e) => setEditandoCuadrilla((c) => ({ ...c, vehiculo: e.target.value }))}
                />
              </Field>
            </div>

            <Field label="Integrantes">
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-700 p-2">
                {tecnicos.length === 0 && (
                  <p className="p-2 text-xs text-slate-500">Cargá técnicos primero.</p>
                )}
                {tecnicos.map((t) => (
                  <label
                    key={t.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-slate-300 hover:bg-slate-800"
                  >
                    <input
                      type="checkbox"
                      checked={editandoCuadrilla.integrantes.includes(t.id)}
                      onChange={(e) =>
                        setEditandoCuadrilla((c) => ({
                          ...c,
                          integrantes: e.target.checked
                            ? [...c.integrantes, t.id]
                            : c.integrantes.filter((x) => x !== t.id),
                        }))
                      }
                      className="accent-sky-500"
                    />
                    {t.nombre}
                  </label>
                ))}
              </div>
            </Field>

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setEditandoCuadrilla(null)}>
                Cancelar
              </Button>
              <Button variante="primario" type="submit" cargando={guardando}>
                Guardar
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
