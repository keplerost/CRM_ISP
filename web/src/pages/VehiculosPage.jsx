import { useCallback, useEffect, useState } from 'react'
import { Car, Fuel, Pencil, Plus, Power, Wrench } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import Mantenimiento from '../components/tecnico/Mantenimiento'
import {
  Aviso,
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
  SkeletonTabla,
  Table,
} from '../components/ui'

/**
 * Los vehículos, y cuánto rinde cada uno.
 *
 * ── Por qué el consumo se calcula y no se carga ──
 *
 * Nadie sabe de memoria cuántos kilómetros hace su camioneta por tanque, y el
 * número que alguien pondría a mano sería el que recuerda de hace dos años.
 *
 * Sale de las cargas: cada una se compara con la anterior del mismo vehículo, y
 * la diferencia de odómetro son los kilómetros que se hicieron con lo cargado
 * la vez pasada. Después de tres o cuatro cargas el promedio ya sirve, y a
 * partir de ahí el técnico ve "quedan unos 120 km para cargar" sin que nadie
 * haya configurado nada.
 *
 * La PRIMERA carga de cada vehículo no tiene con qué compararse y queda en
 * blanco. Es correcto: no se puede saber cuánto rindió un tanque del que no se
 * sabe dónde empezó.
 */

const VACIO = { nombre: '', placa: '', tecnico_id: '', notas: '', activo: true }

export default function VehiculosPage() {
  const [vehiculos, setVehiculos] = useState([])
  const [tecnicos, setTecnicos] = useState([])
  const [cargas, setCargas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [editando, setEditando] = useState(null)
  const [guardando, setGuardando] = useState(false)

  const recargar = useCallback(async () => {
    setCargando(true)
    const [v, t, c] = await Promise.all([
      supabase.from('v_vehiculos').select('*').order('nombre'),
      supabase.from('tecnicos').select('id,nombre').eq('activo', true).order('nombre'),
      supabase.from('v_combustible').select('*').order('fecha', { ascending: false }).limit(20),
    ])
    setError(v.error ?? null)
    setVehiculos(v.data ?? [])
    setTecnicos(t.data ?? [])
    setCargas(c.data ?? [])
    setCargando(false)
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  async function guardar() {
    if (!editando.nombre.trim()) return setError(new Error('Ponele un nombre al vehículo'))
    setGuardando(true)
    try {
      const fila = {
        nombre: editando.nombre.trim(),
        placa: editando.placa.trim() || null,
        tecnico_id: editando.tecnico_id || null,
        notas: editando.notas?.trim() || null,
        activo: editando.activo,
      }
      const { error: err } = editando.id
        ? await supabase.from('vehiculos').update(fila).eq('id', editando.id)
        : await supabase.from('vehiculos').insert(fila)
      if (err) throw err
      setEditando(null)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Vehículos</h1>
          <p className="text-sm text-slate-400">
            Con qué sale cada técnico, cuántos kilómetros lleva y cuánto rinde por tanque.
          </p>
        </div>
        <Button variante="primario" icon={Plus} onClick={() => setEditando({ ...VACIO })}>
          Nuevo vehículo
        </Button>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {!cargando && vehiculos.length === 0 && (
        <Aviso>
          Sin al menos un vehículo, el técnico no puede registrar su jornada — y sin jornada no hay
          kilómetros ni aviso de cuándo cargar combustible.
        </Aviso>
      )}

      <Card>
        {cargando ? (
          <SkeletonTabla filas={3} columnas={6} />
        ) : (
          <Table
            columnas={['Vehículo', 'Asignado a', 'Odómetro', 'Desde la carga', 'Rinde', 'Estado', '']}
            filas={vehiculos}
            vacio="Todavía no hay vehículos."
            renderFila={(v) => (
              <tr key={v.id} className="hover:bg-slate-800/40">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Car size={15} className="shrink-0 text-slate-500" />
                    <div>
                      <p className="font-medium text-slate-100">{v.nombre}</p>
                      {v.placa && <p className="text-[11px] text-slate-500">{v.placa}</p>}
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2 text-slate-300">{v.tecnico ?? '—'}</td>
                <td className="px-3 py-2 tabular-nums text-slate-300">
                  {v.odometro_actual != null ? `${v.odometro_actual} km` : '—'}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {v.km_desde_la_carga != null ? (
                    <>
                      <span className="text-slate-200">{v.km_desde_la_carga} km</span>
                      {v.km_para_cargar != null && (
                        <span
                          className={`block text-[11px] ${
                            v.km_para_cargar <= 50 ? 'text-amber-400' : 'text-slate-500'
                          }`}
                        >
                          quedan ~{v.km_para_cargar}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </td>
                <td className="px-3 py-2 tabular-nums text-slate-300">
                  {v.km_promedio_tanque != null ? (
                    `${v.km_promedio_tanque} km/tanque`
                  ) : (
                    // Se dice por qué falta, en vez de un guión mudo: es lo que
                    // evita que alguien piense que el módulo no anda.
                    <span className="text-[11px] text-slate-600">
                      hacen falta 2 cargas para calcularlo
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge color={v.activo ? 'verde' : 'gris'}>{v.activo ? 'Activo' : 'De baja'}</Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-1">
                    <Button variante="fantasma" onClick={() => setEditando({ ...v })} title="Editar">
                      <Pencil size={15} />
                    </Button>
                    <Button
                      variante="fantasma"
                      title={v.activo ? 'Dar de baja' : 'Reactivar'}
                      onClick={async () => {
                        await supabase
                          .from('vehiculos')
                          .update({ activo: !v.activo })
                          .eq('id', v.id)
                        await recargar()
                      }}
                    >
                      <Power size={15} />
                    </Button>
                  </div>
                </td>
              </tr>
            )}
          />
        )}
      </Card>

      {/* El mantenimiento va ANTES de las cargas: una carga de combustible es
          algo que ya pasó, y esto es algo que hay que hacer. Lo pendiente
          primero. */}
      <Card
        title="Mantenimiento"
        subtitle="Qué le falta a cada vehículo, contando desde el odómetro de las jornadas"
        icon={Wrench}
      >
        <Mantenimiento />
      </Card>

      <Card title="Últimas cargas" subtitle="Cada una comparada con la anterior del mismo vehículo">
        {cargas.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">Todavía no se registró ninguna.</p>
        ) : (
          <Table
            columnas={['Fecha', 'Vehículo', 'Odómetro', 'Del tanque', 'Litros', 'Rendimiento', 'Técnico']}
            filas={cargas}
            renderFila={(c) => (
              <tr key={c.id} className="hover:bg-slate-800/40">
                <td className="px-3 py-2 text-slate-400">
                  {new Date(`${c.fecha}T12:00:00`).toLocaleDateString('es-EC', {
                    day: '2-digit',
                    month: 'short',
                  })}
                </td>
                <td className="px-3 py-2 text-slate-300">{c.vehiculo}</td>
                <td className="px-3 py-2 tabular-nums text-slate-300">{c.odometro} km</td>
                <td className="px-3 py-2 tabular-nums text-slate-200">
                  {c.km_del_tanque != null ? (
                    `${c.km_del_tanque} km`
                  ) : (
                    <span className="text-[11px] text-slate-600">primera carga</span>
                  )}
                </td>
                <td className="px-3 py-2 tabular-nums text-slate-400">{c.litros ?? '—'}</td>
                <td className="px-3 py-2 tabular-nums text-slate-300">
                  {c.km_por_litro != null ? `${c.km_por_litro} km/l` : '—'}
                </td>
                <td className="px-3 py-2 text-slate-400">{c.tecnico ?? '—'}</td>
              </tr>
            )}
          />
        )}
      </Card>

      {editando && (
        <Modal
          abierto
          titulo={editando.id ? 'Editar vehículo' : 'Nuevo vehículo'}
          onCerrar={() => setEditando(null)}
        >
          <div className="space-y-3">
            <Field label="Nombre" hint="Como lo llaman: «Camioneta blanca», «Moto 1».">
              <Input
                value={editando.nombre}
                onChange={(e) => setEditando({ ...editando, nombre: e.target.value })}
              />
            </Field>
            <Field label="Placa">
              <Input
                value={editando.placa ?? ''}
                onChange={(e) => setEditando({ ...editando, placa: e.target.value })}
              />
            </Field>
            <Field
              label="Asignado a"
              hint="No es exclusivo: la jornada guarda con cuál salió cada día, porque se prestan."
            >
              <Select
                value={editando.tecnico_id ?? ''}
                onChange={(e) => setEditando({ ...editando, tecnico_id: e.target.value })}
              >
                <option value="">— sin asignar —</option>
                {tecnicos.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.nombre}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Notas">
              <Input
                value={editando.notas ?? ''}
                onChange={(e) => setEditando({ ...editando, notas: e.target.value })}
              />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button onClick={() => setEditando(null)}>Cancelar</Button>
              <Button variante="primario" onClick={guardar} cargando={guardando}>
                {editando.id ? 'Guardar' : 'Crear'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      <p className="flex items-start gap-2 px-1 text-[11px] text-slate-500">
        <Fuel size={13} className="mt-0.5 shrink-0" />
        El rendimiento se calcula solo a partir de las cargas: cada una se compara con la anterior
        del mismo vehículo. Después de dos o tres, el técnico empieza a ver cuántos kilómetros le
        quedan antes de tener que cargar.
      </p>
    </div>
  )
}
