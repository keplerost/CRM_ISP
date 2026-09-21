import { useCallback, useEffect, useState } from 'react'
import { MapPin, Radar, Save } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { FACTIBILIDAD, TECNOLOGIAS } from '../../lib/instalaciones'
import { Aviso, Badge, Button, Card, Cargando, Field, Input, Select, Textarea } from '../ui'

/**
 * Validación de cobertura.
 *
 * La pregunta que hay que contestar antes de prometerle una fecha a nadie: si a
 * esa dirección le llega el servicio y desde dónde. La cuenta la hace la base
 * —`cobertura_cercana`— y no el navegador, porque necesita cruzar la ocupación
 * real de cada punto: los abonados colgados más las instalaciones que ya
 * reservaron un puerto y todavía no se hicieron.
 *
 * Sin ese segundo grupo, dos ventas del mismo día terminan asignadas a la misma
 * caja de ocho puertos que tenía uno libre.
 */

/** A partir de acá el tendido deja de ser una acometida normal. */
const DISTANCIA_COMODA_M = 250

export default function FactibilidadPanel({ instalacion, onError, onGuardado }) {
  const [puntos, setPuntos] = useState([])
  const [buscando, setBuscando] = useState(false)
  const [guardando, setGuardando] = useState(false)
  const [form, setForm] = useState({
    factibilidad: instalacion.factibilidad ?? 'pendiente',
    punto_id: instalacion.nap_id ?? instalacion.torre_id ?? '',
    puerto_nap: instalacion.puerto_nap ?? '',
    distancia_nodo_m: instalacion.distancia_nodo_m ?? '',
    factibilidad_notas: instalacion.factibilidad_notas ?? '',
  })

  const esFibra = instalacion.tecnologia !== 'wireless'
  const tieneCoordenadas = instalacion.latitud != null && instalacion.longitud != null
  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  const buscar = useCallback(async () => {
    if (!tieneCoordenadas) return

    setBuscando(true)
    const { data, error } = await supabase.rpc('cobertura_cercana', {
      p_lat: Number(instalacion.latitud),
      p_lng: Number(instalacion.longitud),
      p_tecnologia: instalacion.tecnologia ?? 'ftth',
      p_limite: 6,
    })
    setBuscando(false)

    if (error) return onError?.(error)
    setPuntos(data ?? [])
  }, [instalacion.latitud, instalacion.longitud, instalacion.tecnologia, tieneCoordenadas, onError])

  useEffect(() => {
    buscar()
  }, [buscar])

  /** Elegir un punto trae su distancia: es el dato que decide si hay obra. */
  function elegirPunto(p) {
    setForm((f) => ({
      ...f,
      punto_id: p.id,
      distancia_nodo_m: p.distancia_m ?? '',
      factibilidad:
        f.factibilidad !== 'pendiente'
          ? f.factibilidad
          : p.disponibles === 0
            ? 'con_obra'
            : p.distancia_m > DISTANCIA_COMODA_M
              ? 'con_obra'
              : 'factible',
    }))
  }

  async function guardar() {
    setGuardando(true)
    onError?.(null)

    try {
      const cambios = {
        factibilidad: form.factibilidad,
        factibilidad_notas: form.factibilidad_notas.trim() || null,
        factibilidad_at: new Date().toISOString(),
        distancia_nodo_m: form.distancia_nodo_m === '' ? null : Number(form.distancia_nodo_m),
        // El punto se guarda en la columna que corresponde a la tecnología: la
        // ficha del abonado lee `nap_id` para fibra y `conectado_a_id` para
        // radio, y mezclarlas haría que el mapa de la red muestre antenas
        // colgando de cajas ópticas.
        nap_id: esFibra ? form.punto_id || null : null,
        torre_id: esFibra ? null : form.punto_id || null,
        puerto_nap: esFibra ? form.puerto_nap.trim() || null : null,
      }

      // Un trabajo que no es factible no puede quedar en la agenda esperando a
      // un técnico que no va a poder hacer nada.
      if (form.factibilidad === 'no_factible' && instalacion.estado === 'agendada') {
        cambios.estado = 'prospecto'
      }

      const { error } = await supabase.from('instalaciones').update(cambios).eq('id', instalacion.id)
      if (error) throw error

      await onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  const elegido = puntos.find((p) => p.id === form.punto_id)

  return (
    <Card
      title="Factibilidad y cobertura"
      subtitle={`Desde qué ${TECNOLOGIAS[instalacion.tecnologia ?? 'ftth'].punto} se le puede dar servicio`}
      icon={Radar}
      actions={
        tieneCoordenadas && (
          <Button variante="fantasma" icon={Radar} onClick={buscar} cargando={buscando}>
            Volver a buscar
          </Button>
        )
      }
    >
      <div className="space-y-4">
        {!tieneCoordenadas ? (
          <Aviso tipo="alerta">
            El pedido no tiene coordenadas cargadas, así que la cobertura no se puede calcular.
            Cargalas en el pedido o marcá la factibilidad a mano con lo que sepa el técnico de zona.
          </Aviso>
        ) : buscando ? (
          <Cargando texto="Buscando puntos de red cercanos…" />
        ) : puntos.length === 0 ? (
          <Aviso tipo="alerta">
            No hay ninguna {TECNOLOGIAS[instalacion.tecnologia ?? 'ftth'].punto} con coordenadas
            cargadas. Se cargan en OLT / GPON → Perfiles y planes → Puntos de red.
          </Aviso>
        ) : (
          <div className="space-y-2">
            {puntos.map((p) => {
              const lejos = p.distancia_m > DISTANCIA_COMODA_M
              const lleno = p.disponibles === 0
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => elegirPunto(p)}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition ${
                    form.punto_id === p.id
                      ? 'border-sky-500/60 bg-sky-500/10'
                      : 'border-slate-800 bg-[#F6F8FB] hover:border-slate-700'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate text-sm text-slate-100">
                      <MapPin size={14} className="shrink-0 text-slate-500" />
                      {p.nombre}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {p.direccion || `Punto de tipo ${p.tipo}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge color={lejos ? 'ambar' : 'verde'}>{p.distancia_m} m</Badge>
                    {p.capacidad == null ? (
                      <Badge color="gris">sin tope</Badge>
                    ) : (
                      <Badge color={lleno ? 'rojo' : p.disponibles <= 2 ? 'ambar' : 'verde'}>
                        {p.disponibles} de {p.capacidad} libres
                      </Badge>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {elegido?.disponibles === 0 && (
          <Aviso tipo="alerta">
            <b>{elegido.nombre}</b> está sin puertos libres. Hay que ampliarla o colgar de otra
            antes de mandar al técnico: llegar y no tener dónde conectar es una visita perdida.
          </Aviso>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Resultado" hint={FACTIBILIDAD[form.factibilidad]?.ayuda}>
            <Select value={form.factibilidad} onChange={set('factibilidad')}>
              {Object.entries(FACTIBILIDAD).map(([valor, f]) => (
                <option key={valor} value={valor}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Field>

          {esFibra && (
            <Field label="Puerto de la caja" hint="En qué salida de la NAP queda">
              <Input value={form.puerto_nap} onChange={set('puerto_nap')} placeholder="3" />
            </Field>
          )}

          <Field label="Distancia al punto" hint="Metros de tendido estimados">
            <Input
              type="number"
              min={0}
              value={form.distancia_nodo_m}
              onChange={set('distancia_nodo_m')}
            />
          </Field>

          <Field label="Observaciones" className="sm:col-span-2 lg:col-span-4">
            <Textarea
              rows={2}
              value={form.factibilidad_notas}
              onChange={set('factibilidad_notas')}
              placeholder="Hay que cruzar la calle, falta un poste, el dueño autoriza el paso…"
            />
          </Field>
        </div>

        <Button variante="primario" icon={Save} onClick={guardar} cargando={guardando}>
          Guardar factibilidad
        </Button>
      </div>
    </Card>
  )
}
