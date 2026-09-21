import { useCallback, useEffect, useState } from 'react'
import { CalendarClock, RotateCw, Save } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Aviso, Button, ErrorBanner, Field, Input } from '../ui'

/**
 * Cuándo sale cada uno de los cuatro avisos de pago.
 *
 * ── Por qué esto existe ──
 *
 * Los días vivían solo en `config_avisos_pago`, sin pantalla: para correr el
 * segundo aviso un día había que entrar al SQL Editor. Eso no es configuración,
 * es una constante con pasos extra — y el que decide cuándo escribirle a un
 * moroso es el que cobra, no el que sabe SQL.
 *
 * ── Por qué está acá y no en Ajustes ──
 *
 * Porque al lado está la prueba en seco, que dice a quién le llegaría con estos
 * números. Cambiar un día y ver en la misma pantalla a cuántos afecta es la
 * diferencia entre configurar y adivinar.
 *
 * ── Lo que NO se toca desde acá ──
 *
 * El texto de cada aviso, que vive en Ajustes → Plantillas. Son dos preguntas
 * distintas —cuándo y qué— y mezclarlas hace una pantalla donde nadie encuentra
 * ninguna de las dos.
 */

/**
 * Los cuatro escalones.
 *
 * Los tres primeros se cuentan contra el VENCIMIENTO de la factura y aceptan
 * negativos: −3 es tres días antes. El cuarto se cuenta contra el CORTE, y ahí
 * un negativo no significa nada —no se le puede escribir "ya está suspendido" a
 * quien todavía no lo está—, así que arranca en 0.
 */
const ESCALONES = [
  {
    campo: 'dias_aviso_1',
    titulo: '1 · Por vencer',
    ancla: 'del vencimiento',
    min: -30,
    ayuda: 'Negativo es antes. −3 = tres días antes de que venza.',
  },
  {
    campo: 'dias_aviso_2',
    titulo: '2 · Vencida',
    ancla: 'del vencimiento',
    min: -30,
    ayuda: 'Ya venció y figura pendiente.',
  },
  {
    campo: 'dias_aviso_3',
    titulo: '3 · Último antes del corte',
    ancla: 'del vencimiento',
    min: -30,
    ayuda: 'El que evita el reclamo de "nunca me avisaron".',
  },
  {
    campo: 'dias_aviso_4',
    titulo: '4 · Ya cortado',
    ancla: 'del corte',
    min: 0,
    ayuda: 'Solo le llega a quien el sistema tiene como cortado.',
  },
]

export default function EscalonesAvisoPago() {
  const [form, setForm] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)
  const [aviso, setAviso] = useState(null)

  const cargar = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('config_avisos_pago')
      .select('dias_aviso_1, dias_aviso_2, dias_aviso_3, dias_aviso_4, repetir_cada_4')
      .eq('id', 1)
      .maybeSingle()

    if (err) {
      // La 187 agrega las dos columnas del cuarto escalón. Sin ella la consulta
      // falla entera, y el cartel tiene que decir qué correr — no "error 42703".
      setError(
        err.code === '42703'
          ? {
              message: 'Falta la migración 187',
              hint: 'Corré supabase/migracion-187-el-cuarto-aviso-al-que-ya-esta-cortado.sql en el SQL Editor.',
            }
          : err,
      )
      return
    }
    setForm(data ?? {})
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  const set = (campo, valor) => {
    setAviso(null)
    setForm((f) => ({ ...f, [campo]: valor }))
  }

  async function guardar() {
    setGuardando(true)
    setError(null)
    setAviso(null)

    // Vacío no se guarda como 0: un campo en blanco es "no lo toqué", y
    // escribir 0 ahí movería el aviso al día del vencimiento sin que nadie lo
    // haya pedido.
    const n = (v, porDefecto) => (v === '' || v == null ? porDefecto : Number(v))

    const fila = {
      id: 1,
      dias_aviso_1: n(form.dias_aviso_1, -3),
      dias_aviso_2: n(form.dias_aviso_2, 1),
      dias_aviso_3: n(form.dias_aviso_3, 5),
      dias_aviso_4: n(form.dias_aviso_4, 10),
      repetir_cada_4: n(form.repetir_cada_4, 15),
    }

    const { error: err } = await supabase.from('config_avisos_pago').upsert(fila)
    setGuardando(false)

    if (err) {
      // El tope de 7 días lo pone la base, no esta pantalla: así vale también
      // para quien lo cambie por SQL.
      setError(
        err.message?.includes('repetir_cada_4_check')
          ? {
              message: 'La repetición tiene que ser de 7 días o más',
              hint: 'Poné 0 si querés que el cuarto aviso salga una sola vez y no se repita.',
            }
          : err,
      )
      return
    }
    setAviso('Guardado. Los días nuevos valen desde la próxima corrida.')
    await cargar()
  }

  if (error && !form) return <ErrorBanner error={error} onCerrar={() => setError(null)} />
  if (!form) return null

  const repeticion = Number(form.repetir_cada_4 ?? 15)

  return (
    <div className="t-panel mt-3 p-4">
      <div className="mb-3 flex items-center gap-2">
        <CalendarClock size={14} className="text-sky-400" />
        <p className="t-titulo text-xs font-bold text-slate-200">Cuándo sale cada aviso</p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {ESCALONES.map((e) => (
          <Field key={e.campo} label={e.titulo} hint={e.ayuda}>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={e.min}
                max={365}
                value={form[e.campo] ?? ''}
                onChange={(ev) => set(e.campo, ev.target.value)}
                className="w-20"
              />
              <span className="shrink-0 text-[11px] leading-tight text-slate-500">
                días
                <span className="block">{e.ancla}</span>
              </span>
            </div>
          </Field>
        ))}
      </div>

      {/* La repetición cuelga del cuarto escalón, no es un escalón más. */}
      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-[rgba(15,23,42,0.06)] pt-4">
        <Field
          label="Repetir el 4 cada"
          hint="Mientras siga cortado y debiendo. 0 = una sola vez."
          className="w-44"
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={365}
              value={form.repetir_cada_4 ?? ''}
              onChange={(ev) => set('repetir_cada_4', ev.target.value)}
              className="w-20"
            />
            <span className="shrink-0 text-[11px] text-slate-500">días</span>
          </div>
        </Field>

        <div className="flex items-center gap-2">
          <Button icon={Save} variante="primario" onClick={guardar} cargando={guardando}>
            Guardar
          </Button>
          <Button icon={RotateCw} variante="fantasma" onClick={cargar} disabled={guardando}>
            Deshacer
          </Button>
        </div>
      </div>

      {aviso && (
        <p className="mt-3 text-[11px] font-medium text-emerald-400">{aviso}</p>
      )}

      {/* Un número mal puesto acá no rompe una pantalla: le escribe a gente. */}
      {repeticion > 0 && repeticion < 15 && (
        <div className="mt-3">
          <Aviso tipo="alerta">
            Cada {repeticion} días es bastante seguido. Al que no contesta, insistirle más no lo
            hace contestar antes — lo acostumbra a no abrir los mensajes, y después no lee el que
            sí importa.
          </Aviso>
        </div>
      )}

      <p className="mt-3 text-[11px] leading-snug text-slate-500">
        Cada abonado puede tener sus propios días desde su ficha; estos son los que se usan cuando
        no los tiene. El texto de cada aviso se edita en Ajustes → Plantillas.
      </p>
    </div>
  )
}
