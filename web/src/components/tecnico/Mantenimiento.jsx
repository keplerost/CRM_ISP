import { useCallback, useEffect, useState } from 'react'
import { Check, Wrench } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Badge, Button, ErrorBanner, Field, Input, Modal, SkeletonTabla } from '../ui'
import { fechaLocal } from '../../lib/abonados'
import { cuantoFalta, urgencia } from '../../lib/mantenimiento'

/**
 * Qué le falta a cada vehículo, y registrar lo que se le hizo.
 *
 * ── Por qué esto no es una lista de fechas ──
 *
 * Porque el que olvida el cambio de aceite no olvida una fecha: olvida que
 * pasaron cinco mil kilómetros. La pregunta que hay que contestar no es "cuándo
 * fue el último" sino "cuánto falta para el próximo", y eso solo se sabe
 * cruzando el último servicio con el odómetro de hoy — que sale de las jornadas
 * que el técnico ya carga.
 *
 * ── Por qué "sin registro" no es "vencido" ──
 *
 * Un vehículo al que nunca se le anotó un cambio de aceite no está atrasado:
 * está sin registrar. Pintarlos a todos de rojo el día que se estrena la
 * pantalla es la forma más rápida de que nadie la vuelva a mirar.
 */

const COLOR = {
  vencido: 'rojo',
  pronto: 'ambar',
  ok: 'verde',
  sin_registro: 'gris',
  sin_dato: 'gris',
}

const ETIQUETA = {
  vencido: 'Vencido',
  pronto: 'Pronto',
  ok: 'Al día',
  sin_registro: 'Sin registro',
  sin_dato: 'Sin datos',
}

export default function Mantenimiento() {
  const [filas, setFilas] = useState(null)
  const [error, setError] = useState(null)
  const [registrando, setRegistrando] = useState(null)

  const cargar = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('v_mantenimiento')
      .select('*')
      .order('vehiculo')
      .order('orden')

    if (err) {
      setError(
        err.code === '42P01'
          ? {
              message: 'Falta la migración 191',
              hint: 'Corré supabase/migracion-191-el-mantenimiento-de-los-vehiculos.sql en el SQL Editor.',
            }
          : err,
      )
      setFilas([])
      return
    }
    setError(null)
    setFilas(data ?? [])
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  // Agrupado por vehículo: la pregunta es "qué le falta a la camioneta", no
  // "quién necesita aceite".
  const porVehiculo = (filas ?? []).reduce((acc, m) => {
    ;(acc[m.vehiculo_id] ??= { nombre: m.vehiculo, placa: m.placa, items: [] }).items.push(m)
    return acc
  }, {})

  const urgentes = (filas ?? []).filter((m) => ['vencido', 'pronto'].includes(urgencia(m)))

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {urgentes.length > 0 && (
        <div className="t-panel flex items-start gap-2.5 p-3">
          <Wrench size={16} className="mt-0.5 shrink-0 text-amber-400" />
          <p className="text-[13px] text-slate-300">
            <b className="text-slate-100">
              {urgentes.length} {urgentes.length === 1 ? 'servicio' : 'servicios'} por hacer
            </b>{' '}
            entre todos los vehículos.
          </p>
        </div>
      )}

      {filas === null ? (
        <SkeletonTabla filas={4} columnas={3} />
      ) : filas.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">
          No hay vehículos activos, o todavía no se definió ningún tipo de servicio.
        </p>
      ) : (
        Object.entries(porVehiculo).map(([id, v]) => (
          <div key={id} className="t-panel p-4">
            <p className="t-titulo mb-3 text-[13px] font-bold text-slate-100">
              {v.nombre}
              {v.placa && <span className="t-dato ml-2 text-[11px] text-slate-500">{v.placa}</span>}
            </p>

            <div className="space-y-2">
              {v.items.map((m) => {
                const u = urgencia(m)
                return (
                  <div
                    key={m.tipo_id}
                    className="flex flex-wrap items-center justify-between gap-2 border-t border-[rgba(15,23,42,0.06)] pt-2 first:border-0 first:pt-0"
                  >
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-slate-200">{m.tipo}</p>
                      <p className="t-dato mt-0.5 text-[11px] text-slate-500">
                        {cuantoFalta(m)}
                        {m.cada_km && ` · cada ${m.cada_km.toLocaleString('es-EC')} km`}
                        {m.cada_meses && ` · cada ${m.cada_meses} meses`}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge color={COLOR[u]}>{ETIQUETA[u]}</Badge>
                      <Button
                        icon={Check}
                        className="py-1 text-xs"
                        onClick={() =>
                          setRegistrando({ ...m, odometro: m.odometro_actual ?? '', costo: '', taller: '', nota: '' })
                        }
                      >
                        Registrar
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))
      )}

      <RegistrarServicio
        m={registrando}
        onCerrar={() => setRegistrando(null)}
        onHecho={async () => {
          setRegistrando(null)
          await cargar()
        }}
        onError={setError}
      />
    </div>
  )
}

/**
 * Anotar un servicio que ya se hizo.
 *
 * El odómetro viene sugerido con el actual —que es lo que va a ser casi
 * siempre— pero se puede corregir: el cambio de aceite puede haberse hecho el
 * jueves pasado y anotarse hoy, y entonces el número es el de aquel día. Contar
 * los próximos cinco mil desde el de hoy estiraría el intervalo sin que nadie
 * lo note.
 */
function RegistrarServicio({ m, onCerrar, onHecho, onError }) {
  const [form, setForm] = useState(null)
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    // `fechaLocal` y no `toISOString()`: en Ecuador (UTC-5) el segundo
    // sugiere el día siguiente a partir de las 19:00, y el servicio quedaría
    // anotado mañana.
    setForm(m ? { fecha: fechaLocal(), ...m } : null)
  }, [m])

  async function guardar() {
    setGuardando(true)
    const { error } = await supabase.from('mantenimientos').insert({
      vehiculo_id: m.vehiculo_id,
      tipo_id: m.tipo_id,
      fecha: form.fecha,
      odometro: form.odometro === '' ? null : Number(form.odometro),
      costo: form.costo === '' ? null : Number(form.costo),
      taller: form.taller?.trim() || null,
      nota: form.nota?.trim() || null,
    })
    setGuardando(false)
    if (error) return onError(error)
    onHecho()
  }

  if (!m || !form) return null

  return (
    <Modal abierto titulo={`${m.tipo} · ${m.vehiculo}`} onCerrar={onCerrar}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Fecha">
            <Input
              type="date"
              value={form.fecha}
              onChange={(e) => setForm({ ...form, fecha: e.target.value })}
            />
          </Field>
          <Field
            label="Odómetro"
            hint={
              m.cada_km
                ? 'Desde acá se cuentan los próximos kilómetros.'
                : 'Opcional: este servicio va por fecha.'
            }
          >
            <Input
              type="number"
              inputMode="numeric"
              value={form.odometro}
              onChange={(e) => setForm({ ...form, odometro: e.target.value })}
            />
          </Field>
          <Field label="Costo">
            <Input
              type="number"
              inputMode="decimal"
              value={form.costo}
              onChange={(e) => setForm({ ...form, costo: e.target.value })}
              placeholder="Opcional"
            />
          </Field>
          <Field label="Taller">
            <Input
              value={form.taller}
              onChange={(e) => setForm({ ...form, taller: e.target.value })}
              placeholder="Opcional"
            />
          </Field>
        </div>

        <Field label="Nota">
          <Input
            value={form.nota}
            onChange={(e) => setForm({ ...form, nota: e.target.value })}
            placeholder="Qué se cambió, qué quedó pendiente…"
          />
        </Field>

        {m.cada_km && form.odometro === '' && (
          <p className="text-[11px] leading-snug text-amber-400">
            Sin odómetro, este servicio no va a poder avisar por kilómetros: solo por fecha, si
            tiene intervalo en meses.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variante="fantasma" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button variante="primario" icon={Check} onClick={guardar} cargando={guardando}>
            Registrar
          </Button>
        </div>
      </div>
    </Modal>
  )
}

