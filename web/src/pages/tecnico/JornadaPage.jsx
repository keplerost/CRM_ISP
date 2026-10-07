import { useCallback, useEffect, useState } from 'react'
import {
  Camera,
  Check,
  Siren,
  Fuel,
  Gauge,
  PlayCircle,
  Route,
  StopCircle,
  TriangleAlert,
  Wrench,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { usePermisos } from '../../lib/AuthContext'
import { hoyISO } from '../../lib/campo'
import { subirFotoEmergencia, subirFotoIngreso, ubicacionDelIngreso } from '../../lib/jornadaFoto'
import { ubicacionActual } from '../../lib/soporte'
import { RADIO_LLEGADA_M } from '../../lib/soporte'
import { cuantoFalta, urgencia } from '../../lib/mantenimiento'
import { Button, Field, Input, Select } from '../../components/ui'
import MiCuadrilla from '../../components/tecnico/MiCuadrilla'
import { useReparaciones } from '../../components/tecnico/ReparacionesCampo'

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

  /**
   * La cuadrilla de hoy (migración 208).
   *
   * En una cuadrilla con jefe de grupo, el vehículo y los km los carga SOLO el
   * jefe del día: tres técnicos en la misma camioneta cargando cada uno los
   * suyos sumaban el recorrido tres veces. Los demás marcan su ingreso —foto y
   * ubicación— para la asistencia. Sin cuadrilla, o en una cuadrilla sin jefe
   * definido, todo sigue como antes. `null` también si la 208 no corrió.
   */
  const [cuadrilla, setCuadrilla] = useState(null)
  const cargaKm = !cuadrilla || cuadrilla.sin_jefe || cuadrilla.soy_jefe

  /**
   * El vehículo con el que sale (migración 211): el de su cuadrilla, y si
   * trabaja suelto, el que tiene asignado en Vehículos. Viene puesto; elegir
   * otro queda para el día que se presta o está en el taller.
   */
  const vehiculoFijo =
    vehiculos.find((v) => v.id === cuadrilla?.vehiculo_id) ??
    vehiculos.find((v) => v.tecnico_id && v.tecnico_id === perfil?.tecnico_id) ??
    null
  const [otroVehiculo, setOtroVehiculo] = useState(false)
  // "Marcar ingreso ahora", para el día sin clientes (bodega, capacitación).
  const [ingresoAhora, setIngresoAhora] = useState(false)

  /**
   * Lo que le falta al vehículo de hoy.
   *
   * Se pide acá y no en el tablero de inicio porque el aviso solo tiene sentido
   * al lado del odómetro: el técnico está mirando el tablero del vehículo, que
   * es el único momento del día en que "faltan 300 km para el aceite" significa
   * algo concreto.
   */
  const [pendiente, setPendiente] = useState([])

  /**
   * La foto de ingreso.
   *
   * `foto` es lo que se sacó y todavía no subió; `subiendo` corta el doble
   * toque; `avisoFoto` es lo que se le dice al técnico cuando la subida
   * falla — que NO es un error de la jornada, porque la jornada ya se abrió.
   */
  const [foto, setFoto] = useState(null)
  const [subiendo, setSubiendo] = useState(false)
  const [avisoFoto, setAvisoFoto] = useState(null)

  const recargar = useCallback(async () => {
    if (!perfil?.tecnico_id) {
      setCargando(false)
      return
    }
    const [v, j, c] = await Promise.all([
      supabase.from('vehiculos').select('*').eq('activo', true).order('nombre'),
      supabase
        .from('v_jornadas')
        .select('*')
        .eq('tecnico_id', perfil.tecnico_id)
        .eq('fecha', hoyISO())
        .maybeSingle(),
      supabase.rpc('mi_cuadrilla_hoy', { p_fecha: hoyISO() }),
    ])
    setVehiculos(v.data ?? [])
    setJornada(j.data ?? null)
    setCuadrilla(c.error ? null : (c.data ?? null))
    if (j.data) {
      setForm({
        vehiculo_id: j.data.vehiculo_id ?? '',
        km_inicio: j.data.km_inicio ?? '',
        km_fin: j.data.km_fin ?? '',
      })
      // Lo que el vehículo tiene por hacer, vencido o por vencer.
      if (j.data.vehiculo_id) {
        const { data: mant } = await supabase
          .from('v_mantenimiento')
          .select('*')
          .eq('vehiculo_id', j.data.vehiculo_id)
        setPendiente(
          (mant ?? []).filter((m) => ['vencido', 'pronto'].includes(urgencia(m))),
        )
      }

      // Cuánto falta para la próxima carga de ESE vehículo.
      if (j.data.vehiculo_id) {
        const { data: est } = await supabase
          .from('v_vehiculos')
          .select('*')
          .eq('id', j.data.vehiculo_id)
          .maybeSingle()
        setEstado(est ?? null)
      }
    } else {
      // El de la cuadrilla, el asignado, o el único que hay: no se pregunta.
      const fijo =
        (v.data ?? []).find((x) => x.id === c.data?.vehiculo_id) ??
        (v.data ?? []).find((x) => x.tecnico_id && x.tecnico_id === perfil.tecnico_id) ??
        (v.data?.length === 1 ? v.data[0] : null)
      if (fijo) setForm((f) => ({ ...f, vehiculo_id: f.vehiculo_id || fijo.id }))
    }
    setCargando(false)
  }, [perfil?.tecnico_id])

  useEffect(() => {
    recargar()
  }, [recargar])

  async function abrir() {
    if (cargaKm && (!form.vehiculo_id || form.km_inicio === '')) return
    setGuardando(true)
    setError(null)
    try {
      /**
       * La ubicación se pide ANTES de escribir, y su demora se nota.
       *
       * El GPS puede tardar varios segundos; pedirlo después dejaría la jornada
       * ya abierta y la coordenada llegando tarde, o no llegando. Pedirlo antes
       * la deja guardada en la misma escritura.
       *
       * Si falla, devuelve todo en NULL y la jornada se abre igual: el técnico
       * sin señal o con el permiso de ubicación negado tiene que poder empezar.
       */
      const donde = await ubicacionDelIngreso(perfil.tecnico_id, hoyISO())

      // `upsert` sobre (tecnico_id, fecha), que es único: si el técnico toca dos
      // veces —o si un reintento llega tarde— actualiza en vez de duplicar.
      const { error: err } = await supabase.from('jornadas').upsert(
        {
          tecnico_id: perfil.tecnico_id,
          fecha: hoyISO(),
          // Quien no es jefe de grupo marca solo su ingreso: la base rechaza
          // vehículo y km que no le corresponden.
          vehiculo_id: cargaKm ? form.vehiculo_id : null,
          km_inicio: cargaKm ? Number(form.km_inicio) : null,
          inicio_at: new Date().toISOString(),
          lat_ingreso: donde.lat,
          lng_ingreso: donde.lng,
          precision_ingreso_m: donde.precision,
          primer_trabajo_id: donde.primerTrabajoId,
          distancia_ingreso_m: donde.distancia,
        },
        { onConflict: 'tecnico_id,fecha' },
      )
      if (err) throw err

      /**
       * La foto va DESPUÉS de que la jornada existe, y su fallo no la voltea.
       *
       * Necesita el id de la fila para saber en qué carpeta guardarse, así que
       * no puede ir antes. Y si no sube —sin señal, que es la mitad de los
       * días— la jornada igual quedó abierta: el técnico tiene que poder
       * empezar a trabajar, y la foto se reintenta desde acá mismo cuando
       * agarre cobertura.
       */
      const { data: nueva } = await supabase
        .from('jornadas')
        .select('id')
        .eq('tecnico_id', perfil.tecnico_id)
        .eq('fecha', hoyISO())
        .maybeSingle()

      if (foto && nueva?.id) {
        const r = await subirFotoIngreso(nueva.id, foto)
        if (r.ok) setFoto(null)
        else setAvisoFoto('La jornada quedó abierta, pero la foto no subió. Probá de nuevo cuando tengas señal.')
      }

      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  /**
   * La salida del vehículo, en la base (migración 212).
   *
   * Solo vehículo y km: no es el ingreso. Las horas cuentan desde el primer
   * cliente, y ahí se marca el ingreso con la foto. La jornada queda con
   * `inicio_at` vacío hasta entonces.
   */
  async function registrarSalida() {
    if (!form.vehiculo_id || form.km_inicio === '') return
    setGuardando(true)
    setError(null)
    const { error: err } = await supabase.from('jornadas').upsert(
      {
        tecnico_id: perfil.tecnico_id,
        fecha: hoyISO(),
        vehiculo_id: form.vehiculo_id,
        km_inicio: Number(form.km_inicio),
      },
      { onConflict: 'tecnico_id,fecha' },
    )
    setGuardando(false)
    if (err) return setError(err)
    await recargar()
  }

  /** Reintentar la foto, o sacarla de nuevo si salió movida. */
  async function guardarFoto() {
    if (!foto || !jornada?.id) return
    setSubiendo(true)
    setAvisoFoto(null)
    const r = await subirFotoIngreso(jornada.id, foto)
    setSubiendo(false)
    if (r.ok) {
      setFoto(null)
      await recargar()
    } else {
      setAvisoFoto('No se pudo subir. Si no tenés señal, vas a poder más tarde.')
    }
  }

  /** Quien no carga km cierra su jornada solo con la hora de salida. */
  async function marcarSalida() {
    setGuardando(true)
    setError(null)
    const { error: err } = await supabase
      .from('jornadas')
      .update({ fin_at: new Date().toISOString() })
      .eq('id', jornada.id)
    setGuardando(false)
    if (err) return setError(err)
    await recargar()
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

  if (cargaKm && !vehiculos.length) {
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

  const avisoPrimerCliente = (
    <p className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-3 text-[12px] leading-snug text-sky-200">
      Tu ingreso se marca solo al llegar a tu <b>primer cliente</b>: la app te pide la foto ahí,
      y tus horas cuentan desde ese momento.
    </p>
  )

  const marcarIngresoAhora = (
    <div className="border-t border-slate-800 pt-3">
      {!ingresoAhora ? (
        <button
          type="button"
          onClick={() => setIngresoAhora(true)}
          className="w-full text-center text-[12px] text-sky-400"
        >
          ¿Hoy no tenés clientes (bodega, capacitación)? Marcá tu ingreso ahora
        </button>
      ) : (
        <div className="space-y-3">
          <FotoIngreso foto={foto} onFoto={setFoto} />
          <Button
            variante="primario"
            icon={PlayCircle}
            className="w-full py-3"
            onClick={abrir}
            cargando={guardando}
            disabled={guardando || (cargaKm && (!form.vehiculo_id || form.km_inicio === ''))}
          >
            Marcar ingreso ahora
          </Button>
        </div>
      )}
    </div>
  )

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

      <AvisoMantenimiento items={pendiente} />

      <MiCuadrilla c={cuadrilla} />

      <section className="t-card p-4">
        <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <Gauge size={12} /> Jornada de hoy
        </p>

        {!jornada?.inicio_at && !cargaKm ? (
          <div className="space-y-3">
            {avisoPrimerCliente}
            <p className="text-[12px] leading-snug text-slate-400">
              El vehículo y los km los registra el jefe de grupo
              {cuadrilla?.jefe ? ` (${cuadrilla.jefe})` : ''} al salir de la base.
            </p>
            {marcarIngresoAhora}
          </div>
        ) : !jornada?.inicio_at && jornada?.km_inicio == null ? (
          <div className="space-y-3">
            {vehiculoFijo && !otroVehiculo && form.vehiculo_id === vehiculoFijo.id ? (
              <div className="flex items-center justify-between gap-2 t-panel px-3 py-2.5">
                <span className="text-[13px] text-slate-200">
                  <span className="block text-[10px] uppercase tracking-wide text-slate-500">
                    {cuadrilla?.vehiculo_id === vehiculoFijo.id ? 'Vehículo de la cuadrilla' : 'Tu vehículo'}
                  </span>
                  {vehiculoFijo.nombre}
                  {vehiculoFijo.placa ? ` · ${vehiculoFijo.placa}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => setOtroVehiculo(true)}
                  className="shrink-0 text-[11px] text-sky-400"
                >
                  ¿Salís con otro?
                </button>
              </div>
            ) : (
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
            )}
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
              icon={Route}
              className="w-full py-3"
              onClick={registrarSalida}
              cargando={guardando}
              disabled={!form.vehiculo_id || form.km_inicio === '' || guardando}
            >
              Registrar salida del vehículo
            </Button>
            {avisoPrimerCliente}
            {marcarIngresoAhora}
          </div>
        ) : (
          <div className="space-y-3">
            {jornada.km_inicio == null ? (
              <p className="text-center text-[13px] text-slate-300">
                Ingreso marcado a las{' '}
                {new Date(jornada.inicio_at).toLocaleTimeString('es-EC', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {jornada.fin_at &&
                  ` · salida ${new Date(jornada.fin_at).toLocaleTimeString('es-EC', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}`}
              </p>
            ) : (
            <>
            <div className="grid grid-cols-2 gap-2 text-center">
              <Dato label="Salida" valor={`${jornada.km_inicio} km`} />
              <Dato
                label="Recorrido"
                valor={jornada.km_recorridos != null ? `${jornada.km_recorridos} km` : '—'}
              />
            </div>
            <p className="text-center text-[11px] text-slate-500">
              {jornada.vehiculo}
              {jornada.placa ? ` · ${jornada.placa}` : ''}
              {jornada.inicio_at
                ? ` · ingreso a las ${new Date(jornada.inicio_at).toLocaleTimeString('es-EC', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}`
                : ' · salió de la base'}
            </p>
            {!jornada.inicio_at && avisoPrimerCliente}
            </>
            )}

            <DistanciaIngreso j={jornada} />

            {/* La foto, ya con la jornada abierta: dice si está o no, y deja
                reintentar. Aparece también con la jornada cerrada — quien
                trabajó todo el día sin señal la sube al volver. */}
            {!jornada.inicio_at ? (
              marcarIngresoAhora
            ) : jornada.foto_ingreso ? (
              <p className="flex items-center justify-center gap-1.5 text-[11px] font-medium text-emerald-400">
                <Check size={13} /> Foto de ingreso subida
              </p>
            ) : (
              <div className="space-y-2">
                <FotoIngreso foto={foto} onFoto={setFoto} />
                {foto && (
                  <Button
                    icon={Camera}
                    className="w-full"
                    onClick={guardarFoto}
                    cargando={subiendo}
                  >
                    Subir la foto
                  </Button>
                )}
              </div>
            )}

            {avisoFoto && (
              <p className="text-center text-[11px] leading-snug text-amber-400">{avisoFoto}</p>
            )}

            {jornada.km_inicio == null ? (
              !jornada.fin_at && (
                <Button
                  icon={StopCircle}
                  className="w-full py-3"
                  onClick={marcarSalida}
                  cargando={guardando}
                  disabled={guardando}
                >
                  Marcar salida
                </Button>
              )
            ) : jornada.km_fin == null ? (
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

            {jornada.km_inicio != null && (
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
            )}
          </div>
        )}
      </section>

      <SalidaEmergencia
        tecnicoId={perfil.tecnico_id}
        // Salió de la base o ya marcó ingreso: es el día normal, no una emergencia.
        enJornada={Boolean(jornada && !jornada.fin_at && (jornada.inicio_at || jornada.km_inicio != null))}
        cargaKm={cargaKm}
        vehiculos={vehiculos}
        vehiculoFijo={vehiculoFijo}
      />

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

/**
 * La salida de emergencia (migración 210).
 *
 * ── Para qué ──
 *
 * Sin ingreso no se puede iniciar ningún trabajo. Pero la fibra se corta a las
 * once de la noche y la torre se apaga un domingo: con la jornada cerrada, el
 * técnico marca una salida de emergencia —motivo, foto y ubicación, como el
 * ingreso— y mientras esté abierta puede trabajar. Al volver la cierra.
 *
 * Las horas quedan aparte de la jornada: son las que la oficina paga o
 * compensa, y mezclarlas con el día normal las haría invisibles.
 *
 * Con la jornada abierta no se muestra: la emergencia es un trabajo más del día.
 */
function SalidaEmergencia({ tecnicoId, enJornada, cargaKm, vehiculos, vehiculoFijo }) {
  const [abierta, setAbierta] = useState(undefined)
  const [form, setForm] = useState(null)
  const [foto, setFoto] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)
  const [aviso, setAviso] = useState(null)
  // Por qué no puede salir por emergencia ahora (migración 215): en horario
  // laboral, sin haber cerrado la jornada. null = puede.
  const [bloqueo, setBloqueo] = useState(null)
  const { filas: reparaciones } = useReparaciones()

  const recargar = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('v_salidas_emergencia')
      .select('*')
      .eq('tecnico_id', tecnicoId)
      .is('fin_at', null)
      .maybeSingle()
    // Sin la 210 no hay emergencias: la sección no se dibuja.
    setAbierta(err ? undefined : (data ?? null))
    const { data: motivo, error: errMotivo } = await supabase.rpc('motivo_sin_emergencia')
    setBloqueo(errMotivo ? null : (motivo ?? null))
  }, [tecnicoId])

  useEffect(() => {
    recargar()
  }, [recargar])

  if (abierta === undefined) return null
  if (!abierta && enJornada) return null

  async function salir() {
    setGuardando(true)
    setError(null)
    try {
      const pos = await ubicacionActual()
      const { data: id, error: err } = await supabase.rpc('abrir_emergencia', {
        p_motivo: form.motivo,
        p_reparacion: form.reparacion_id || null,
        p_lat: pos?.lat ?? null,
        p_lng: pos?.lng ?? null,
        p_vehiculo: cargaKm && form.vehiculo_id ? form.vehiculo_id : null,
        p_km_inicio: cargaKm && form.vehiculo_id && form.km_inicio !== '' ? Number(form.km_inicio) : null,
      })
      if (err) throw err
      if (foto) {
        const r = await subirFotoEmergencia(id, foto)
        if (r.ok) setFoto(null)
        else setAviso('La emergencia quedó abierta, pero la foto no subió. Probá de nuevo cuando tengas señal.')
      }
      setForm(null)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  async function terminar() {
    setGuardando(true)
    setError(null)
    const { error: err } = await supabase.rpc('cerrar_emergencia', {
      p_nota: form?.nota ?? null,
      p_km_fin: form?.km_fin ? Number(form.km_fin) : null,
    })
    setGuardando(false)
    if (err) return setError(err)
    setForm(null)
    await recargar()
  }

  async function guardarFoto() {
    setGuardando(true)
    const r = await subirFotoEmergencia(abierta.id, foto)
    setGuardando(false)
    if (r.ok) {
      setFoto(null)
      setAviso(null)
      await recargar()
    } else setAviso('No se pudo subir. Si no tenés señal, vas a poder más tarde.')
  }

  const hora = (f) => new Date(f).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })

  return (
    <section className={`t-card border p-4 ${abierta ? 'border-rose-500/50' : 'border-slate-800'}`}>
      <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-rose-400">
        <Siren size={12} /> Emergencia fuera de horario
      </p>

      {error && <p className="mb-2 text-[12px] text-rose-400">{error.message}</p>}
      {aviso && <p className="mb-2 text-[11px] text-amber-400">{aviso}</p>}

      {abierta ? (
        <div className="space-y-3">
          <p className="text-[13px] text-slate-200">
            En emergencia desde las <b>{hora(abierta.inicio_at)}</b>
            <span className="block text-[12px] text-slate-400">{abierta.motivo}</span>
          </p>
          <p className="text-[11px] text-slate-500">
            Mientras esté abierta podés salir a los trabajos y reportar la reparación. Cerrala cuando
            vuelvas.
          </p>

          {!abierta.foto_ingreso && (
            <div className="space-y-2">
              <FotoIngreso foto={foto} onFoto={setFoto} />
              {foto && (
                <Button icon={Camera} className="w-full" onClick={guardarFoto} cargando={guardando}>
                  Subir la foto
                </Button>
              )}
            </div>
          )}

          <Field label="Qué se hizo" hint="Opcional. Lo lee la oficina junto con las horas.">
            <Input
              value={form?.nota ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, nota: e.target.value }))}
              placeholder="Ej: empalme de la troncal, torre energizada"
            />
          </Field>
          {abierta.km_inicio != null && (
            <Field label="Kilometraje al volver">
              <Input
                type="number"
                inputMode="numeric"
                value={form?.km_fin ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, km_fin: e.target.value }))}
                placeholder={`Más de ${abierta.km_inicio}`}
              />
            </Field>
          )}
          <Button
            icon={StopCircle}
            className="w-full py-3"
            onClick={terminar}
            cargando={guardando}
            disabled={guardando || (abierta.km_inicio != null && !form?.km_fin)}
          >
            Terminar emergencia
          </Button>
        </div>
      ) : !form && bloqueo ? (
        <p className="text-[12px] leading-snug text-slate-400">{bloqueo}</p>
      ) : !form ? (
        <div className="space-y-3">
          <p className="text-[12px] leading-snug text-slate-400">
            ¿Se cayó una torre o se cortó la fibra y tu jornada ya terminó (o todavía no empezó)?
            Marcá la salida de emergencia: con eso podés trabajar, y las horas quedan registradas
            aparte.
          </p>
          <Button
            icon={Siren}
            className="w-full py-3"
            onClick={() =>
              setForm({
                reparacion_id: reparaciones[0]?.id ?? '',
                motivo: '',
                vehiculo_id: vehiculoFijo?.id ?? (vehiculos.length === 1 ? vehiculos[0].id : ''),
                km_inicio: '',
              })
            }
          >
            Salir por emergencia
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {reparaciones.length > 0 && (
            <Field label="Reparación asignada">
              <Select
                value={form.reparacion_id}
                onChange={(e) => setForm({ ...form, reparacion_id: e.target.value })}
              >
                <option value="">— Otra emergencia —</option>
                {reparaciones.map((r) => (
                  <option key={r.id} value={r.id}>
                    #{r.numero} · {r.titulo}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field
            label="Motivo"
            hint={form.reparacion_id ? 'Opcional: ya va la reparación.' : 'Qué se cayó o quién te llamó.'}
          >
            <Input
              value={form.motivo}
              onChange={(e) => setForm({ ...form, motivo: e.target.value })}
              placeholder="Ej: torre norte apagada, me llamó la oficina"
            />
          </Field>
          {cargaKm && vehiculos.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Vehículo" hint="Si salís manejando">
                <Select
                  value={form.vehiculo_id}
                  onChange={(e) => setForm({ ...form, vehiculo_id: e.target.value })}
                >
                  <option value="">— Ninguno —</option>
                  {vehiculos.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.nombre}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Km al salir">
                <Input
                  type="number"
                  inputMode="numeric"
                  value={form.km_inicio}
                  onChange={(e) => setForm({ ...form, km_inicio: e.target.value })}
                  disabled={!form.vehiculo_id}
                />
              </Field>
            </div>
          )}
          <FotoIngreso foto={foto} onFoto={setFoto} />
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => setForm(null)}>
              Volver
            </Button>
            <Button
              variante="primario"
              icon={Siren}
              className="flex-1"
              onClick={salir}
              cargando={guardando}
              disabled={
                guardando ||
                (!form.reparacion_id && !form.motivo.trim()) ||
                Boolean(cargaKm && form.vehiculo_id && form.km_inicio === '')
              }
            >
              Salir ahora
            </Button>
          </div>
        </div>
      )}
    </section>
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

/**
 * Sacar la foto de ingreso.
 *
 * `capture="user"` abre la cámara FRONTAL: la foto es de quien está marcando,
 * y con la trasera la sacaría apuntando a otro lado. Es lo contrario de las
 * fotos del expediente, que son de un documento y usan la de atrás.
 *
 * La vista previa se arma con `URL.createObjectURL` y se libera al cambiar: sin
 * eso, un técnico que saca cinco fotos hasta que sale bien deja cinco imágenes
 * retenidas en memoria.
 */
function FotoIngreso({ foto, onFoto }) {
  const [previa, setPrevia] = useState(null)

  useEffect(() => {
    if (!foto) return setPrevia(null)
    const url = URL.createObjectURL(foto)
    setPrevia(url)
    return () => URL.revokeObjectURL(url)
  }, [foto])

  return (
    <div>
      <span className="mb-1 block text-xs font-semibold text-slate-400">Foto de ingreso</span>

      <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-slate-700 p-3 transition active:bg-slate-800">
        {previa ? (
          <img src={previa} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
        ) : (
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-slate-800">
            <Camera size={20} className="text-slate-500" />
          </span>
        )}
        <span className="min-w-0 text-[13px] leading-snug text-slate-300">
          {previa ? 'Tocá para sacarla de nuevo' : 'Tocá para sacar la foto'}
          <span className="mt-0.5 block text-[11px] text-slate-500">
            Queda con la hora de inicio. Si no tenés señal ahora, la subís después.
          </span>
        </span>
        <input
          type="file"
          accept="image/*"
          capture="user"
          className="hidden"
          onChange={(e) => onFoto(e.target.files?.[0] ?? null)}
        />
      </label>
    </div>
  )
}

/**
 * A qué distancia del primer trabajo quedó el ingreso.
 *
 * ── Por qué se le muestra al técnico y no solo al jefe ──
 *
 * Porque si el número solo lo ve la oficina, el técnico se entera de que algo
 * estaba mal cuando ya no puede explicarlo. Viéndolo en el momento, el que
 * marcó desde la esquina equivocada lo sabe ahí y puede decirlo.
 *
 * ── Por qué la precisión se muestra al lado ──
 *
 * Una distancia de 300 m con un GPS que informa 400 m de error no significa
 * nada, y sin ese dato parecería que sí. Cuando el error es mayor que la
 * distancia, el cartel lo dice en vez de acusar.
 */
function DistanciaIngreso({ j }) {
  if (j?.distancia_ingreso_m == null) {
    // Sin dato no se dibuja nada. Un "no se pudo medir" permanente arriba de la
    // pantalla es ruido: el técnico no puede hacer nada al respecto.
    return null
  }

  const d = j.distancia_ingreso_m
  const err = j.precision_ingreso_m
  const dudoso = err != null && err >= d
  const lejos = d > RADIO_LLEGADA_M && !dudoso

  return (
    <p
      className={`text-center text-[11px] leading-snug ${
        lejos ? 'text-amber-400' : 'text-slate-500'
      }`}
    >
      {dudoso
        ? `Marcaste a ${d} m del primer trabajo, pero el GPS informó ${err} m de error: el dato no alcanza para concluir nada.`
        : lejos
          ? `Marcaste a ${d} m del primer trabajo del día.`
          : `Marcaste a ${d} m del primer trabajo. Dentro del rango.`}
    </p>
  )
}

/**
 * Lo que el vehículo necesita, dicho al técnico.
 *
 * ── Por qué acá y no en un listado aparte ──
 *
 * Porque una pantalla de "mantenimientos pendientes" es una que el técnico no
 * abre nunca: no es su trabajo, es el del que administra. Lo que sí hace todos
 * los días es escribir el kilometraje del tablero — y ahí, con el número del
 * odómetro delante, "faltan 300 km para el aceite" es accionable.
 *
 * ── Por qué no bloquea ──
 *
 * Porque el técnico no decide cuándo se lleva la camioneta al taller. Avisarle
 * sirve para que lo diga; impedirle trabajar por algo que no depende de él solo
 * lo dejaría parado.
 */
function AvisoMantenimiento({ items }) {
  if (!items?.length) return null

  return (
    <div className="campo-borde flex items-start gap-2.5 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
      <Wrench size={18} className="mt-0.5 shrink-0 text-amber-400" />
      <div className="min-w-0">
        <p className="text-[14px] font-semibold text-slate-100">
          {items.length === 1 ? 'El vehículo necesita un servicio' : `El vehículo necesita ${items.length} servicios`}
        </p>
        <ul className="mt-1 space-y-0.5">
          {items.map((m) => (
            <li key={m.tipo_id} className="text-[11px] text-slate-500">
              <b className="text-slate-400">{m.tipo}</b> · {cuantoFalta(m)}
            </li>
          ))}
        </ul>
        <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
          Avisale a la oficina para que lo agenden.
        </p>
      </div>
    </div>
  )
}

