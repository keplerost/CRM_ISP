import { useEffect, useState } from 'react'
import { AlertTriangle, BellOff, Save, Send } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import {
  COMBINACIONES_FACTURA, OPCIONES_DIAS, OPCIONES_PANTALLA,
  avisosEnOrden, canalesDeCombinacion, combinacionDe, describirDias,
} from '../../lib/avisos'
import { Aviso, Button, Card, Field, Select } from '../ui'

/**
 * Qué avisos quiere recibir este abonado.
 *
 * ── Por qué esto vive en el abonado y no en un ajuste general ──
 *
 * Porque las molestias son personales. Hay quien agradece el recordatorio y hay
 * quien lo vive como acoso; hay quien quiere que le escriban solo por WhatsApp,
 * y hay quien pide el último aviso un día antes del corte y no cinco días
 * después de vencer.
 *
 * Un ISP que no puede respetar eso termina con abonados pidiendo que los saquen
 * de todo — y ahí pierde también el aviso que sí servía.
 *
 * ── Lo que estas opciones NO cambian ──
 *
 * El corte. Apagar los avisos es dejar de molestar, no dejar de cobrar. Está
 * dicho en la pantalla porque es exactamente lo que alguien podría entender mal
 * al desactivarlos.
 */

const CANALES = [
  { valor: 'whatsapp', titulo: 'WhatsApp', campo: 'telefono_movil' },
  { valor: 'sms', titulo: 'SMS', campo: 'telefono_movil' },
  { valor: 'email', titulo: 'Correo', campo: 'email' },
  { valor: 'telegram', titulo: 'Telegram', campo: 'telegram_chat_id' },
]

const AVISOS = [
  {
    campo: 'aviso_dias_1',
    titulo: 'Primer aviso',
    para: 'Antes de que venza. Todavía no debe nada.',
  },
  {
    campo: 'aviso_dias_2',
    titulo: 'Segundo aviso',
    para: 'Ya vencido, con saldo pendiente.',
  },
  {
    campo: 'aviso_dias_3',
    titulo: 'Último aviso',
    para: 'El de antes del corte. Poné un día antes si querés que le llegue justo a tiempo.',
  },
]

export default function ConfigAvisos({ cliente, onGuardado, onError }) {
  const [form, setForm] = useState(() => ({
    avisos_activos: cliente.avisos_activos !== false,
    avisos_pantalla: cliente.avisos_pantalla !== false,
    // `null` es "por los que se pueda". Se conserva la diferencia con la lista
    // vacía, que es "por ninguno".
    avisos_canales: cliente.avisos_canales ?? null,
    aviso_factura: combinacionDe(cliente.aviso_factura_canales ?? null),
    aviso_pantalla_dias: cliente.aviso_pantalla_dias ?? '',
    aviso_dias_1: cliente.aviso_dias_1 ?? '',
    aviso_dias_2: cliente.aviso_dias_2 ?? '',
    aviso_dias_3: cliente.aviso_dias_3 ?? '',
  }))
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)

  /**
   * Los días generales, para poder decir a qué equivale "usar el valor general".
   *
   * Sin esto, esa opción es una incógnita: alguien la elige sin saber si son
   * tres días antes o cinco después, que es justo lo que se está decidiendo.
   */
  const [generales, setGenerales] = useState({})

  useEffect(() => {
    supabase
      .from('config_avisos_pago')
      .select('dias_aviso_1, dias_aviso_2, dias_aviso_3')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data }) =>
        setGenerales({
          aviso_dias_1: data?.dias_aviso_1,
          aviso_dias_2: data?.dias_aviso_2,
          aviso_dias_3: data?.dias_aviso_3,
        }),
      )
  }, [])

  const set = (campo, v) => {
    setGuardado(false)
    setForm((f) => ({ ...f, [campo]: v }))
  }

  /** Marcar o desmarcar un canal, respetando que `null` significa "todos". */
  const alternarCanal = (canal) => {
    const actuales = form.avisos_canales ?? CANALES.map((c) => c.valor)
    const nuevos = actuales.includes(canal)
      ? actuales.filter((c) => c !== canal)
      : [...actuales, canal]

    // Si quedaron todos marcados, vuelve a `null`: es más honesto guardar "los
    // que se pueda" que una lista congelada que no incluiría un canal futuro.
    set('avisos_canales', nuevos.length === CANALES.length ? null : nuevos)
  }

  const marcado = (canal) => !form.avisos_canales || form.avisos_canales.includes(canal)

  /** Si el abonado tiene cargado el dato que ese canal necesita. */
  const alcanzable = (c) => !!cliente[c.campo]

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    onError?.(null)
    try {
      const numero = (v) => (v === '' || v == null ? null : Number(v))
      const { error } = await supabase
        .from('clientes')
        .update({
          avisos_activos: form.avisos_activos,
          avisos_pantalla: form.avisos_pantalla,
          avisos_canales: form.avisos_canales,
          aviso_factura_canales: canalesDeCombinacion(form.aviso_factura),
          aviso_pantalla_dias: numero(form.aviso_pantalla_dias),
          aviso_dias_1: numero(form.aviso_dias_1),
          aviso_dias_2: numero(form.aviso_dias_2),
          aviso_dias_3: numero(form.aviso_dias_3),
        })
        .eq('id', cliente.id)

      if (error) throw error
      setGuardado(true)
      onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  const canalesElegidos = CANALES.filter((c) => marcado(c.valor) && alcanzable(c))
  const sinSalida = form.avisos_activos && canalesElegidos.length === 0

  /**
   * El orden se juzga sobre los días EFECTIVOS.
   *
   * El problema es del resultado, no de dónde salió cada número: dejar el
   * primero en "general" y adelantar el último igual puede dejarlos cruzados.
   */
  const efectivo = (campo) => (form[campo] === '' || form[campo] == null ? generales[campo] : form[campo])
  const desordenados = avisosEnOrden({
    dias1: efectivo('aviso_dias_1'),
    dias2: efectivo('aviso_dias_2'),
    dias3: efectivo('aviso_dias_3'),
  })

  return (
    <Card title="Avisos" icon={Send} subtitle="Qué le mandamos a este abonado, y por dónde.">
      <form onSubmit={guardar} className="space-y-4 p-4">
        <label className="flex items-start gap-2 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={form.avisos_activos}
            onChange={(e) => set('avisos_activos', e.target.checked)}
            className="mt-1"
          />
          <span>
            Recibe avisos automáticos
            <span className="block text-[11px] leading-snug text-slate-500">
              Apagado, no se le manda ningún recordatorio de pago. Para el que pidió que no lo
              molesten.
            </span>
          </span>
        </label>

        {/* Lo que alguien podría entender mal justo al apagar el interruptor. */}
        {!form.avisos_activos && (
          <Aviso tipo="alerta">
            <BellOff size={13} className="mr-1 inline" />
            Apagar los avisos no impide el corte: si no paga, se le corta igual, solo que sin
            recordatorios previos. Y el corte sin aviso genera justamente la llamada que los avisos
            evitan.
          </Aviso>
        )}

        {form.avisos_activos && (
          <>
            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-300">Por dónde</p>
              <div className="flex flex-wrap gap-3">
                {CANALES.map((c) => (
                  <label
                    key={c.valor}
                    className={`flex items-center gap-1.5 text-xs ${
                      alcanzable(c) ? 'text-slate-300' : 'text-slate-600'
                    }`}
                    title={
                      alcanzable(c)
                        ? undefined
                        : `Este abonado no tiene ${c.campo.replace('_', ' ')} cargado`
                    }
                  >
                    <input
                      type="checkbox"
                      checked={marcado(c.valor)}
                      onChange={() => alternarCanal(c.valor)}
                    />
                    {c.titulo}
                    {!alcanzable(c) && <span className="text-[10px]">(sin dato)</span>}
                  </label>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                Se usa el primero que se pueda, empezando por el preferido de su ficha.
              </p>
            </div>

            {/* Marcar canales de los que no se tiene el dato deja al abonado sin
                aviso y al sistema conforme. Se dice acá, no al enviar. */}
            {sinSalida && (
              <Aviso tipo="alerta">
                <AlertTriangle size={13} className="mr-1 inline" />
                No hay ningún canal utilizable: o están todos desmarcados, o de los marcados no
                tenemos el dato de contacto. Este abonado no va a recibir ningún aviso.
              </Aviso>
            )}

            {/* El aviso de la factura nueva. Va aparte de los tres de cobranza
                porque no recuerda una deuda: informa que se emitió, y se le
                manda a TODOS. La opción de apagarlo existe solo para el abonado
                que lo pide. */}
            <Field
              label="Aviso de nueva factura"
              hint="Se manda a todos cuando se crea la factura. No tiene que ver con la factura electrónica del SRI."
            >
              <Select
                value={form.aviso_factura ?? ''}
                onChange={(e) => set('aviso_factura', e.target.value || null)}
                className="max-w-sm"
              >
                {COMBINACIONES_FACTURA.map((c) => (
                  <option key={String(c.valor)} value={c.valor ?? ''}>
                    {c.titulo}
                  </option>
                ))}
              </Select>
            </Field>

            <label className="flex items-start gap-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={form.avisos_pantalla}
                onChange={(e) => set('avisos_pantalla', e.target.checked)}
                className="mt-1"
              />
              <span>
                Ve las pantallas de aviso y de corte en el navegador
                <span className="block text-[11px] leading-snug text-slate-500">
                  Apagado, cuando esté cortado ve el error de conexión de siempre en vez de la
                  página que le explica cuánto debe y dónde pagar. Se corta igual.
                </span>
              </span>
            </label>

            {/* La pantalla de ANTES del corte: la que le avisa mientras todavía
                tiene servicio. Es un rango y no un día porque no es un mensaje
                que se manda una vez, es un estado que dura hasta el vencimiento. */}
            {form.avisos_pantalla && (
              <Field
                label="Pantalla de aviso antes del corte"
                hint="Mientras todavía tiene servicio, para que se entere antes de quedarse sin internet."
              >
                <Select
                  value={form.aviso_pantalla_dias}
                  onChange={(e) =>
                    set('aviso_pantalla_dias', e.target.value === '' ? '' : Number(e.target.value))
                  }
                  className="max-w-sm"
                >
                  {OPCIONES_PANTALLA.map((o) => (
                    <option key={String(o.valor)} value={o.valor}>
                      {o.titulo}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-300">Cuándo</p>
              <div className="space-y-2">
                {AVISOS.map((a) => (
                  <Field key={a.campo} label={a.titulo} hint={a.para}>
                    {/* Se elige de una lista y no se escribe: el número es en
                        días respecto del vencimiento y el signo lo cambia todo.
                        Un menos que falta convierte "avisale un día antes" en
                        "avisale un día tarde", y eso no se ve revisando la
                        ficha — se ve cuando el abonado llama diciendo que le
                        cortaron sin avisar. */}
                    <Select
                      value={form[a.campo]}
                      onChange={(e) =>
                        set(a.campo, e.target.value === '' ? '' : Number(e.target.value))
                      }
                      className="max-w-xs"
                    >
                      {OPCIONES_DIAS.map((o) => (
                        <option key={String(o.valor)} value={o.valor}>
                          {o.titulo}
                          {o.valor === '' && generales[a.campo] != null
                            ? ` (${describirDias(generales[a.campo])})`
                            : ''}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ))}
              </div>

              {/* La lista impide escribir mal un número, no ponerlos en
                  desorden. Y el desorden no da error: un aviso que quedó fuera
                  de secuencia simplemente no se manda nunca, y nada lo dice. */}
              {desordenados.length > 0 && (
                <Aviso tipo="alerta">
                  <AlertTriangle size={13} className="mr-1 inline" />
                  {desordenados.join(' ')}
                </Aviso>
              )}
            </div>
          </>
        )}

        <div className="flex items-center gap-2 border-t border-slate-800 pt-3">
          <Button type="submit" variante="primario" icon={Save} cargando={guardando}>
            Guardar
          </Button>
          {guardado && <span className="text-xs text-emerald-400">Guardado</span>}
        </div>
      </form>
    </Card>
  )
}
