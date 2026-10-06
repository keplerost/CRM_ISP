import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../lib/confirmar'
import { HardHat, Pencil, Plus, Star, Trash2, Truck, UserCheck, Users } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { hoyISO } from '../lib/campo'
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
 *
 * Los técnicos con usuario NO se cargan acá: su ficha la crea y la mantiene
 * Ajustes → Personal (migración 208). Acá se agregan solo los que no usan el
 * sistema, y se arman las cuadrillas con su jefe de grupo.
 *
 * ── El jefe de grupo y su reemplazo ──
 *
 * El jefe de grupo es el integrante con rol `lider`: carga el vehículo y los
 * km de la cuadrilla. Si falta, administración o un jefe técnico designa un
 * reemplazo SOLO PARA HOY; mañana vuelve el titular sin tocar nada.
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

const CUADRILLA_VACIA = { nombre: '', zona: '', vehiculo: '', vehiculo_id: '', activo: true, lider: '' }

export default function TecnicosPage() {
  const confirmar = useConfirmar()
  const [tecnicos, setTecnicos] = useState([])
  const [cuadrillas, setCuadrillas] = useState([])
  const [miembros, setMiembros] = useState([])
  const [vehiculos, setVehiculos] = useState([])
  const [reemplazos, setReemplazos] = useState([])
  const [dirige, setDirige] = useState(false)
  // { cuadrilla, tecnico_id } mientras se elige el reemplazo de hoy
  const [eligiendoReemplazo, setEligiendoReemplazo] = useState(null)
  const [error, setError] = useState(null)
  const [cargando, setCargando] = useState(true)

  const [editandoTecnico, setEditandoTecnico] = useState(null)
  const [editandoCuadrilla, setEditandoCuadrilla] = useState(null)
  const [guardando, setGuardando] = useState(false)

  const recargar = useCallback(async () => {
    setCargando(true)
    const [t, c, m, r, d, v] = await Promise.all([
      supabase.from('tecnicos').select('*').order('nombre'),
      supabase.from('cuadrillas').select('*').order('nombre'),
      supabase.from('cuadrilla_miembros').select('*'),
      // Sin la migración 208 estas dos fallan y la pantalla sigue como antes.
      supabase.from('cuadrilla_reemplazos').select('*').eq('fecha', hoyISO()),
      supabase.rpc('dirige_cuadrillas'),
      supabase.from('vehiculos').select('id, nombre, placa').eq('activo', true).order('nombre'),
    ])
    if (t.error) setError(t.error)
    setTecnicos(t.data ?? [])
    setCuadrillas(c.data ?? [])
    setMiembros(m.data ?? [])
    setReemplazos(r.error ? [] : (r.data ?? []))
    setDirige(Boolean(d.data))
    setVehiculos(v.data ?? [])
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
      const { id, integrantes = [], lider, ...datos } = editandoCuadrilla
      const fila = {
        nombre: datos.nombre.trim(),
        zona: datos.zona?.trim() || null,
        activo: Boolean(datos.activo),
      }
      // El vehículo es el de Vehículos (migración 211). El texto se sigue
      // guardando con su nombre, para lo que todavía lo lee.
      if (vehiculos.length) {
        const v = vehiculos.find((x) => x.id === datos.vehiculo_id)
        fila.vehiculo_id = v?.id ?? null
        fila.vehiculo = v ? [v.nombre, v.placa].filter(Boolean).join(' · ') : null
      } else {
        fila.vehiculo = datos.vehiculo?.trim() || null
      }

      const { data: guardada, error: err } = id
        ? await supabase.from('cuadrillas').update(fila).eq('id', id).select().single()
        : await supabase.from('cuadrillas').insert(fila).select().single()
      if (err) throw err

      // Se reemplaza la lista entera: es más simple que calcular altas y bajas,
      // y son tres filas.
      await supabase.from('cuadrilla_miembros').delete().eq('cuadrilla_id', guardada.id)
      if (integrantes.length) {
        const { error: errM } = await supabase.from('cuadrilla_miembros').insert(
          integrantes.map((tecnico_id) => ({
            cuadrilla_id: guardada.id,
            tecnico_id,
            rol: tecnico_id === lider ? 'lider' : 'tecnico',
          })),
        )
        if (errM) throw errM
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
  const liderDe = (cuadrillaId) =>
    miembros.find((m) => m.cuadrilla_id === cuadrillaId && m.rol === 'lider')?.tecnico_id ?? ''
  const reemplazoDe = (cuadrillaId) =>
    reemplazos.find((r) => r.cuadrilla_id === cuadrillaId)?.tecnico_id ?? null
  const nombreDe = (id) => tecnicos.find((t) => t.id === id)?.nombre ?? '—'

  /** El reemplazo vale solo para hoy: mañana vuelve el titular solo. */
  async function guardarReemplazo(e) {
    e.preventDefault()
    const { cuadrilla, tecnico_id } = eligiendoReemplazo
    setGuardando(true)
    setError(null)
    const { error: err } = tecnico_id
      ? await supabase
          .from('cuadrilla_reemplazos')
          .upsert(
            { cuadrilla_id: cuadrilla.id, fecha: hoyISO(), tecnico_id },
            { onConflict: 'cuadrilla_id,fecha' },
          )
      : await supabase
          .from('cuadrilla_reemplazos')
          .delete()
          .eq('cuadrilla_id', cuadrilla.id)
          .eq('fecha', hoyISO())
    setGuardando(false)
    if (err) return setError(err)
    setEligiendoReemplazo(null)
    await recargar()
  }

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
        subtitle="Los que tienen usuario se crean solos desde Ajustes → Personal. Acá se agregan los que no usan el sistema." 
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
              <td className="px-3 py-2 text-slate-200">
                {t.nombre}
                {t.user_id && (
                  <span
                    className="ml-2 inline-flex items-center gap-1 rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-400"
                    title="Tiene usuario: nombre, correo y celular se editan en Ajustes → Personal"
                  >
                    <UserCheck size={11} /> con usuario
                  </span>
                )}
              </td>
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
          columnas={['Nombre', 'Zona', 'Vehículo', 'Integrantes', 'Jefe de grupo', '']}
          filas={cargando ? [] : cuadrillas}
          vacio="Sin cuadrillas. Se puede asignar a técnicos sueltos igual."
          renderFila={(c) => {
            const ids = integrantesDe(c.id)
            return (
              <tr key={c.id} className="border-t border-slate-800">
                <td className="px-3 py-2 text-slate-200">{c.nombre}</td>
                <td className="px-3 py-2 text-xs">{c.zona ?? '—'}</td>
                <td className="px-3 py-2 text-xs">
                  {c.vehiculo ?? '—'}
                  {c.vehiculo && !c.vehiculo_id && vehiculos.length > 0 && (
                    <span className="block text-[10px] text-amber-400">elegilo de la lista</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-slate-400">
                  {ids.length
                    ? tecnicos
                        .filter((t) => ids.includes(t.id))
                        .map((t) => t.nombre)
                        .join(', ')
                    : 'sin integrantes'}
                </td>
                <td className="px-3 py-2 text-xs">
                  {liderDe(c.id) ? (
                    <span className="flex items-center gap-1 text-slate-200">
                      <Star size={12} className="text-amber-400" />
                      {nombreDe(liderDe(c.id))}
                    </span>
                  ) : (
                    <span className="text-slate-500">sin definir</span>
                  )}
                  {reemplazoDe(c.id) && (
                    <span className="mt-0.5 block font-semibold text-amber-400">
                      Hoy: {nombreDe(reemplazoDe(c.id))} (reemplazo)
                    </span>
                  )}
                  {dirige && ids.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setEligiendoReemplazo({ cuadrilla: c, tecnico_id: reemplazoDe(c.id) ?? '' })
                      }
                      className="mt-1 block text-[11px] font-semibold text-sky-400 hover:underline"
                    >
                      {reemplazoDe(c.id) ? 'Cambiar reemplazo de hoy' : 'Reemplazo de hoy'}
                    </button>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <ConPermiso permiso="usuarios.editar" envezDe={null}>
                      <Button
                        variante="fantasma"
                        icon={Pencil}
                        onClick={() =>
                          setEditandoCuadrilla({ ...c, vehiculo_id: c.vehiculo_id ?? '', integrantes: ids, lider: liderDe(c.id) })
                        }
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
              <Field
                label="Vehículo"
                hint={vehiculos.length ? 'El jefe de grupo sale con este sin tener que elegirlo.' : undefined}
              >
                {vehiculos.length ? (
                  <Select
                    value={editandoCuadrilla.vehiculo_id ?? ''}
                    onChange={(e) => setEditandoCuadrilla((c) => ({ ...c, vehiculo_id: e.target.value }))}
                  >
                    <option value="">— Sin vehículo fijo —</option>
                    {vehiculos.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.nombre}
                        {v.placa ? ` · ${v.placa}` : ''}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    value={editandoCuadrilla.vehiculo ?? ''}
                    onChange={(e) => setEditandoCuadrilla((c) => ({ ...c, vehiculo: e.target.value }))}
                  />
                )}
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

            <Field
              label="Jefe de grupo"
              hint="Carga el vehículo y los km de la cuadrilla. Los demás marcan solo su ingreso."
            >
              <Select
                value={
                  editandoCuadrilla.integrantes.includes(editandoCuadrilla.lider)
                    ? editandoCuadrilla.lider
                    : ''
                }
                onChange={(e) => setEditandoCuadrilla((c) => ({ ...c, lider: e.target.value }))}
              >
                <option value="">— sin definir (todos cargan vehículo y km) —</option>
                {tecnicos
                  .filter((t) => editandoCuadrilla.integrantes.includes(t.id))
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.nombre}
                    </option>
                  ))}
              </Select>
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

      {/* --- Modal reemplazo de hoy --- */}
      <Modal
        abierto={Boolean(eligiendoReemplazo)}
        titulo={`Reemplazo de hoy · ${eligiendoReemplazo?.cuadrilla.nombre ?? ''}`}
        onCerrar={() => setEligiendoReemplazo(null)}
      >
        {eligiendoReemplazo && (
          <form onSubmit={guardarReemplazo} className="space-y-4">
            <p className="text-xs text-slate-400">
              Vale solo para hoy. Mañana el jefe de grupo vuelve a ser{' '}
              <b>
                {liderDe(eligiendoReemplazo.cuadrilla.id)
                  ? nombreDe(liderDe(eligiendoReemplazo.cuadrilla.id))
                  : 'el titular'}
              </b>{' '}
              sin que haga falta cambiar nada.
            </p>
            <Field label="Quién hace de jefe de grupo hoy">
              <Select
                value={eligiendoReemplazo.tecnico_id}
                onChange={(e) => setEligiendoReemplazo((r) => ({ ...r, tecnico_id: e.target.value }))}
              >
                <option value="">— sin reemplazo (el titular) —</option>
                {tecnicos
                  .filter(
                    (t) =>
                      integrantesDe(eligiendoReemplazo.cuadrilla.id).includes(t.id) &&
                      t.id !== liderDe(eligiendoReemplazo.cuadrilla.id),
                  )
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.nombre}
                    </option>
                  ))}
              </Select>
            </Field>
            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setEligiendoReemplazo(null)}>
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
