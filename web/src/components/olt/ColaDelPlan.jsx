import { useState } from 'react'
import { Save, SlidersHorizontal } from 'lucide-react'
import { Aviso, Button, Field, Input, Modal, Select } from '../ui'

/**
 * Cómo se traduce un plan a una cola del router.
 *
 * Son decisiones comerciales, no técnicas: cuánto puede un abonado pasarse de
 * su plan, por cuántos segundos, qué se le garantiza cuando la red está cargada
 * y a quién se atiende primero cuando no alcanza para todos. Por eso se
 * configuran acá y no tienen un valor por defecto.
 *
 * Todo se escribe en megas, que es como se habla y como se vende. La base los
 * guarda en kbps y el router los quiere al revés —subida primero—, pero eso es
 * asunto del middleware: acá se escribe "60 de bajada" porque eso es lo que uno
 * quiere decir.
 */

const VACIO = {
  burst_bajada: '',
  burst_subida: '',
  umbral_bajada: '',
  umbral_subida: '',
  segundos_bajada: '',
  segundos_subida: '',
  garantizado_bajada: '',
  garantizado_subida: '',
  prioridad: '',
}

const aMegas = (kbps) => (kbps == null ? '' : String(kbps / 1000))
const aKbps = (megas) => (megas === '' || megas == null ? null : Math.round(Number(megas) * 1000))

/** Un par bajada/subida, que es como se piensan todos estos valores. */
function Par({ titulo, ayuda, unidad = 'Mbps', bajada, subida, onBajada, onSubida, paso = 'any' }) {
  return (
    <div>
      <p className="text-xs font-medium text-slate-300">{titulo}</p>
      {ayuda && <p className="mb-2 mt-0.5 text-[11px] text-slate-500">{ayuda}</p>}
      <div className="grid grid-cols-2 gap-2">
        <Field label={`Bajada (${unidad})`}>
          <Input type="number" min={0} step={paso} value={bajada} onChange={onBajada} />
        </Field>
        <Field label={`Subida (${unidad})`}>
          <Input type="number" min={0} step={paso} value={subida} onChange={onSubida} />
        </Field>
      </div>
    </div>
  )
}

export default function ColaDelPlan({ plan, onGuardar, onCerrar }) {
  const [form, setForm] = useState(() =>
    plan
      ? {
          burst_bajada: aMegas(plan.burst_bajada_kbps),
          burst_subida: aMegas(plan.burst_subida_kbps),
          umbral_bajada: aMegas(plan.umbral_bajada_kbps),
          umbral_subida: aMegas(plan.umbral_subida_kbps),
          segundos_bajada: plan.burst_segundos_bajada ?? '',
          segundos_subida: plan.burst_segundos_subida ?? '',
          garantizado_bajada: aMegas(plan.garantizado_bajada_kbps),
          garantizado_subida: aMegas(plan.garantizado_subida_kbps),
          prioridad: plan.prioridad ?? '',
        }
      : VACIO,
  )
  const [guardando, setGuardando] = useState(false)

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  const bajadaPlan = plan ? plan.bajada_kbps / 1000 : 0
  const subidaPlan = plan ? plan.subida_kbps / 1000 : 0

  // Los mismos controles que aplica el middleware, mostrados mientras se
  // escribe. Enterarse de que la ráfaga está mal al apretar "aplicar a 200
  // clientes" es tarde.
  const cargados = [
    form.burst_bajada,
    form.burst_subida,
    form.umbral_bajada,
    form.umbral_subida,
    form.segundos_bajada,
    form.segundos_subida,
  ].filter((v) => v !== '').length

  const problemas = []
  if (cargados > 0 && cargados < 6) {
    problemas.push(
      'La ráfaga necesita los seis valores. Con uno solo de menos, el router rechaza la cola entera y el abonado se queda sin que se le aplique ni su velocidad.',
    )
  }
  if (cargados === 6) {
    if (Number(form.burst_bajada) < bajadaPlan || Number(form.burst_subida) < subidaPlan) {
      problemas.push(`La ráfaga tiene que ser mayor que el plan (${bajadaPlan}/${subidaPlan} Mbps).`)
    }
    if (Number(form.umbral_bajada) > bajadaPlan || Number(form.umbral_subida) > subidaPlan) {
      problemas.push('El umbral no puede superar la velocidad del plan: la ráfaga estaría siempre activa.')
    }
  }
  if (form.garantizado_bajada !== '' && Number(form.garantizado_bajada) > bajadaPlan) {
    problemas.push('El caudal garantizado no puede ser mayor que el plan.')
  }

  async function guardar() {
    setGuardando(true)
    try {
      await onGuardar({
        burst_bajada_kbps: aKbps(form.burst_bajada),
        burst_subida_kbps: aKbps(form.burst_subida),
        umbral_bajada_kbps: aKbps(form.umbral_bajada),
        umbral_subida_kbps: aKbps(form.umbral_subida),
        burst_segundos_bajada: form.segundos_bajada === '' ? null : Number(form.segundos_bajada),
        burst_segundos_subida: form.segundos_subida === '' ? null : Number(form.segundos_subida),
        garantizado_bajada_kbps: aKbps(form.garantizado_bajada),
        garantizado_subida_kbps: aKbps(form.garantizado_subida),
        prioridad: form.prioridad === '' ? null : Number(form.prioridad),
      })
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Modal
      abierto={Boolean(plan)}
      titulo={`Cola de ${plan?.nombre ?? ''}`}
      onCerrar={onCerrar}
      ancho="max-w-2xl"
    >
      <div className="space-y-5">
        <p className="text-sm text-slate-400">
          El plan da <b className="text-slate-200">{bajadaPlan} Mbps</b> de bajada y{' '}
          <b className="text-slate-200">{subidaPlan}</b> de subida. Todo lo de acá abajo es opcional:
          sin nada configurado, la cola es solo ese límite.
        </p>

        <Par
          titulo="Ráfaga"
          ayuda="Hasta cuánto se le deja pasar por un rato. Tiene que ser mayor que el plan."
          bajada={form.burst_bajada}
          subida={form.burst_subida}
          onBajada={set('burst_bajada')}
          onSubida={set('burst_subida')}
        />

        <Par
          titulo="Umbral de la ráfaga"
          ayuda="Por debajo de este promedio se le habilita. Poner algo menos que el plan evita que la ráfaga la tenga siempre el que ya usa todo su caudal."
          bajada={form.umbral_bajada}
          subida={form.umbral_subida}
          onBajada={set('umbral_bajada')}
          onSubida={set('umbral_subida')}
        />

        <Par
          titulo="Duración de la ráfaga"
          ayuda="Cuántos segundos dura. Es lo que hace que una página abra rápido sin regalar una descarga entera."
          unidad="segundos"
          paso={1}
          bajada={form.segundos_bajada}
          subida={form.segundos_subida}
          onBajada={set('segundos_bajada')}
          onSubida={set('segundos_subida')}
        />

        <Par
          titulo="Caudal garantizado"
          ayuda="Lo que se le asegura aunque la red esté saturada. Es la diferencia entre vender “hasta 100 megas” y vender “100 megas”."
          bajada={form.garantizado_bajada}
          subida={form.garantizado_subida}
          onBajada={set('garantizado_bajada')}
          onSubida={set('garantizado_subida')}
        />

        <Field
          label="Prioridad"
          hint="A quién se atiende primero cuando no alcanza para todos. 1 es la más alta."
          className="max-w-xs"
        >
          <Select value={form.prioridad} onChange={set('prioridad')}>
            <option value="">Sin definir (el router usa 8)</option>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n}
                {n === 1 ? ' — la más alta' : n === 8 ? ' — la más baja' : ''}
              </option>
            ))}
          </Select>
        </Field>

        {problemas.map((p) => (
          <Aviso key={p} tipo="alerta">
            {p}
          </Aviso>
        ))}

        <div className="grid gap-2 sm:grid-cols-2">
          <Button onClick={onCerrar}>Cancelar</Button>
          <Button
            variante="primario"
            icon={Save}
            cargando={guardando}
            disabled={problemas.length > 0}
            onClick={guardar}
          >
            Guardar
          </Button>
        </div>

        <p className="flex items-start gap-2 text-[11px] text-slate-500">
          <SlidersHorizontal size={13} className="mt-0.5 shrink-0" />
          Guardar no cambia nada en los equipos. Para que llegue a los abonados hay que usar
          “A los clientes”.
        </p>
      </div>
    </Modal>
  )
}
