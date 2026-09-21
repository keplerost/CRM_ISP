import { useCallback, useEffect, useState } from 'react'
import { Fuel, Gauge, PlayCircle, Route, StopCircle, TriangleAlert } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { usePermisos } from '../../lib/AuthContext'
import { hoyISO } from '../../lib/campo'
import { Button, Field, Input, Select } from '../../components/ui'

/**
 * Mi jornada: con qué salí y cuánto marcaba el tablero.
 *
 * ── Por qué se pide a mano y no se calcula ──
 *
 * Se evaluó sumar las distancias entre las coordenadas de llegada de cada
 * trabajo. No sirve: son líneas rectas —el camino real entre dos casas no lo
 * es— e ignora todo lo que no es una parada registrada: ir a bodega, volver al
 * taller, la vuelta a casa. Puede ser la mitad del día.
 *
 * Un número que parece kilómetros y no lo es se usa para decidir, y decide mal.
 * Dos lecturas del tablero son diez segundos y son ciertas.
 *
 * ── Qué hace posible ──
 *
 * Responder "cada cuántos kilómetros hay que cargar", que se preguntó
 * expresamente. Ese cálculo necesita el odómetro sí o sí: el combustible es del
 * vehículo, no de la ruta.
 */
export default function JornadaPage() {
  const { perfil } = usePermisos()
  const [vehiculos, setVehiculos] = useState([])
  const [jornada, setJornada] = useState(null)
  const [estado, setEstado] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [guardando, setGuardando] = useState(false)

  const [form, setForm] = useState({ vehiculo_id: '', km_inicio: '', km_fin: '' })
  const [carga, setCarga] = useState(null)

  const recargar = useCallback(async () => {
    if (!perfil?.tecnico_id) {
      setCargando(false)
      return
    }
    const [v, j] = await Promise.all([
      supabase.from('vehiculos').select('*').eq('activo', true).order('nombre'),
      supabase
        .from('v_jornadas')
        .select('*')
        .eq('tecnico_id', perfil.tecnico_id)
        .eq('fecha', hoyISO())
        .maybeSingle(),
    ])
    setVehiculos(v.data ?? [])
    setJornada(j.data ?? null)
    if (j.data) {
      setForm({
        vehiculo_id: j.data.vehiculo_id ?? '',
        km_inicio: j.data.km_inicio ?? '',
        km_fin: j.data.km_fin ?? '',
      })
      // Cuánto falta para la próxima carga de ESE vehículo.
      if (j.data.vehiculo_id) {
        const { data: est } = await supabase
          .from('v_vehiculos')
          .select('*')
          .eq('id', j.data.vehiculo_id)
          .maybeSingle()
        setEstado(est ?? null)
      }
    } else if (v.data?.length === 1) {
      // Con un solo vehículo no se pregunta: se elige solo.
      setForm((f) => ({ ...f, vehiculo_id: v.data[0].id }))
    }
    setCargando(false)
  }, [perfil?.tecnico_id])

  useEffect(() => {
    recargar()
  }, [recargar])

  async function abrir() {
    if (!form.vehiculo_id || form.km_inicio === '') return
    setGuardando(true)
    setError(null)
    try {
      // `upsert` sobre (tecnico_id, fecha), que es único: si el técnico toca dos
      // veces —o si un reintento llega tarde— actualiza en vez de duplicar.
      const { error: err } = await supabase.from('jornadas').upsert(
        {
          tecnico_id: perfil.tecnico_id,
          fecha: hoyISO(),
          vehiculo_id: form.vehiculo_id,
          km_inicio: Number(form.km_inicio),
          inicio_at: new Date().toISOString(),
        },
        { onConflict: 'tecnico_id,fecha' },
      )
      if (err) throw err
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  async function cerrar() {
    if (form.km_fin === '') return
    if (Number(form.km_fin) < Number(jornada.km_inicio)) {
      return setError(
        new Error(
          `El tablero no puede marcar menos que al salir (${jornada.km_inicio} km). Revisá el número.`,
        ),
      )
    }
    setGuardando(true)
    setError(null)
    try {
      const { error: err } = await supabase
        .from('jornadas')
        .update({ km_fin: Number(form.km_fin), fin_at: new Date().toISOString() })
        .eq('id', jornada.id)
      if (err) throw err
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  if (cargando) return <div className="h-40 animate-pulse rounded-2xl bg-[#F6F8FB]" />

  if (!perfil?.tecnico_id) {
    return (
      <p className="py-16 text-center text-[14px] text-slate-400">
        Tu usuario no está vinculado a un técnico, así que no se puede registrar jornada.
      </p>
    )
  }

  if (!vehiculos.length) {
    return (
      <div className="py-16 text-center">
        <Route size={28} className="mx-auto mb-2 text-slate-700" />
        <p className="text-slate-400">No hay vehículos cargados.</p>
        <p className="mt-1 text-[12px] text-slate-600">
          La oficina tiene que darlos de alta antes de poder registrar kilómetros.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-lg space-y-3">
      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-[13px] text-rose-300">
          {error.message}
        </div>
      )}

      {/* Cuánto falta para cargar. Es la respuesta a la pregunta que originó
          todo esto, y sale del promedio real de ESTE vehículo — una camioneta y
          una moto no cargan cada los mismos kilómetros. */}
      {estado?.km_para_cargar != null && (
        <div
          className={`flex items-start gap-2.5 rounded-2xl border p-4 ${
            estado.km_para_cargar <= 50
              ? 'border-amber-500/40 bg-amber-500/10'
              : 'border-slate-800 bg-[#F6F8FB]'
          }`}
        >
          <Fuel
            size={18}
            className={`mt-0.5 shrink-0 ${
              estado.km_para_cargar <= 50 ? 'text-amber-400' : 'text-slate-500'
            }`}
          />
          <div>
            <p className="text-[14px] font-semibold text-slate-100">
              {estado.km_para_cargar <= 50
                ? `Cargá pronto: quedan unos ${estado.km_para_cargar} km`
                : `Quedan unos ${estado.km_para_cargar} km para cargar`}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Este vehículo hace {estado.km_promedio_tanque} km por tanque en promedio. Llevás{' '}
              {estado.km_desde_la_carga} km desde la última carga.
            </p>
          </div>
        </div>
      )}

      <section className="t-card p-4">
        <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <Gauge size={12} /> Jornada de hoy
        </p>

        {!jornada?.inicio_at ? (
          <div className="space-y-3">
            <Field label="Vehículo">
              <Select
                value={form.vehiculo_id}
                onChange={(e) => setForm({ ...form, vehiculo_id: e.target.value })}
              >
                <option value="">— elegí con cuál salís —</option>
                {vehiculos.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.nombre}
                    {v.placa ? ` · ${v.placa}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Kilometraje al salir" hint="El número del tablero, tal cual.">
              <Input
                type="number"
                inputMode="numeric"
                value={form.km_inicio}
                onChange={(e) => setForm({ ...form, km_inicio: e.target.value })}
                placeholder="Ej: 84520"
              />
            </Field>
            <Button
              variante="primario"
              icon={PlayCircle}
              className="w-full py-3"
              onClick={abrir}
              cargando={guardando}
              disabled={!form.vehiculo_id || form.km_inicio === '' || guardando}
            >
              Iniciar jornada
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-center">
              <Dato label="Salida" valor={`${jornada.km_inicio} km`} />
              <Dato
                label="Recorrido"
                valor={jornada.km_recorridos != null ? `${jornada.km_recorridos} km` : '—'}
              />
            </div>
            <p className="text-center text-[11px] text-slate-500">
              {jornada.vehiculo}
              {jornada.placa ? ` · ${jornada.placa}` : ''} · desde las{' '}
              {new Date(jornada.inicio_at).toLocaleTimeString('es-EC', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>

            {jornada.km_fin == null ? (
              <>
                <Field label="Kilometraje al volver">
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={form.km_fin}
                    onChange={(e) => setForm({ ...form, km_fin: e.target.value })}
                    placeholder={`Más de ${jornada.km_inicio}`}
                  />
                </Field>
                <Button
                  icon={StopCircle}
                  className="w-full py-3"
                  onClick={cerrar}
                  cargando={guardando}
                  disabled={form.km_fin === '' || guardando}
                >
                  Cerrar jornada
                </Button>
              </>
            ) : (
              <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-center text-[13px] text-emerald-300">
                Jornada cerrada · {jornada.km_recorridos} km
              </p>
            )}

            <button
              type="button"
              onClick={() =>
                setCarga({ odometro: form.km_fin || jornada.km_inicio, litros: '', monto: '' })
              }
              className="w-full rounded-xl border border-slate-700 py-2.5 text-[13px] text-slate-300 active:bg-slate-800"
            >
              <Fuel size={14} className="mr-1.5 inline" />
              Registrar carga de combustible
            </button>
          </div>
        )}
      </section>

      {carga && (
        <CargaCombustible
          jornada={jornada}
          tecnicoId={perfil.tecnico_id}
          inicial={carga}
          onCerrar={() => setCarga(null)}
          onError={setError}
          onGuardado={async () => {
            setCarga(null)
            await recargar()
          }}
        />
      )}
    </div>
  )
}

const Dato = ({ label, valor }) => (
  <div className="t-panel py-3">
    <p className="text-lg font-semibold tabular-nums text-slate-100">{valor}</p>
    <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
  </div>
)

/**
 * La carga de combustible.
 *
 * ── Por qué el odómetro es obligatorio y los litros no ──
 *
 * Sin odómetro, la carga solo dice cuánta plata se gastó. Con odómetro se puede
 * decir "hicimos 340 km con el tanque anterior", que es de donde sale el aviso
 * de cuándo volver a cargar.
 *
 * Los litros y el monto son opcionales porque a veces se carga "lo que entre" y
 * el ticket se pierde. Exigirlos haría que la carga no se registre, y perder el
 * odómetro por no tener el monto es perder lo que importa por lo que no.
 *
 * ── Esta pantalla necesita señal ──
 *
 * No pasa por la cola. Una carga se hace en una estación de servicio, que está
 * sobre una ruta; y a diferencia de una instalación, si no se registra en el
 * momento se puede cargar después sin perder nada: el odómetro sigue escrito en
 * el ticket.
 */
function CargaCombustible({ jornada, tecnicoId, inicial, onCerrar, onError, onGuardado }) {
  const [f, setF] = useState(inicial)
  const [guardando, setGuardando] = useState(false)

  async function guardar() {
    if (!f.odometro) return
    setGuardando(true)
    try {
      // Se busca antes de insertar: dos cargas del mismo vehículo con el mismo
      // odómetro son la misma carga cargada dos veces, y duplicarla arruinaría
      // el promedio de rendimiento.
      const { data: repetida } = await supabase
        .from('cargas_combustible')
        .select('id')
        .eq('vehiculo_id', jornada.vehiculo_id)
        .eq('odometro', Number(f.odometro))
        .maybeSingle()

      if (repetida) {
        onError?.(new Error('Ya hay una carga registrada con ese kilometraje.'))
        return
      }

      const { error } = await supabase.from('cargas_combustible').insert({
        vehiculo_id: jornada.vehiculo_id,
        tecnico_id: tecnicoId,
        odometro: Number(f.odometro),
        litros: f.litros === '' ? null : Number(f.litros),
        monto: f.monto === '' ? null : Number(f.monto),
      })
      if (error) throw error
      await onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <section className="t-card p-4">
      <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <Fuel size={12} /> Carga de combustible
      </p>
      <div className="space-y-3">
        <Field
          label="Kilometraje al cargar"
          hint="Es lo que permite saber cuánto rindió el tanque anterior."
        >
          <Input
            type="number"
            inputMode="numeric"
            value={f.odometro}
            onChange={(e) => setF({ ...f, odometro: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Litros" hint="Opcional">
            <Input
              type="number"
              step="0.01"
              inputMode="decimal"
              value={f.litros}
              onChange={(e) => setF({ ...f, litros: e.target.value })}
            />
          </Field>
          <Field label="Monto" hint="Opcional">
            <Input
              type="number"
              step="0.01"
              inputMode="decimal"
              value={f.monto}
              onChange={(e) => setF({ ...f, monto: e.target.value })}
            />
          </Field>
        </div>
        {!navigator.onLine && (
          <p className="flex items-start gap-1.5 text-[11px] text-amber-400">
            <TriangleAlert size={12} className="mt-0.5 shrink-0" />
            Sin señal esto no se guarda. Anotá el kilometraje del ticket y cargalo después.
          </p>
        )}
        <div className="flex gap-2">
          <Button className="flex-1" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variante="primario"
            className="flex-1"
            onClick={guardar}
            cargando={guardando}
            disabled={!f.odometro || guardando}
          >
            Guardar
          </Button>
        </div>
      </div>
    </section>
  )
}
