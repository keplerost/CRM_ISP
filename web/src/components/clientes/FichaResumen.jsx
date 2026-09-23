import { useEffect, useState } from 'react'
import { dineroCero as dinero } from '../../lib/formato'
import {
  AlertTriangle,
  Ban,
  CalendarClock,
  CalendarDays,
  MapPin,
  MessageSquare,
  PiggyBank,
  Save,
  Wallet,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import IdentidadCliente from './IdentidadCliente'
import { Aviso, Button, Card, Field, Input, Select, Textarea } from '../ui'

/**
 * Datos del cliente y su situación de cuenta.
 *
 * Es la pantalla que se abre cuando alguien llama: a la izquierda lo que hay
 * que corregir o dictar, a la derecha lo que hay que contestar —cuánto debe,
 * cuándo paga, si está por cortarse—.
 */

const fecha = (f) => (f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString() : '—')

/** Campos que se pueden editar desde acá. El resto vive en su propia pantalla. */
const EDITABLES = [
  'nombre',
  'tipo_identificacion',
  'identificacion',
  'direccion',
  'referencia_servicio',
  'zona',
  'telefono',
  'telefono_movil',
  'email',
  'pasarela',
  'codigo_pago',
  'factura_electronica',
  // El estado y el precio no se editan acá: el estado lo mueven los cortes y
  // las instalaciones, y el precio vive en la pestaña Servicio junto al plan
  // que lo determina. Tenerlos en dos lugares llevaba a que se pisaran.
  'dia_facturacion',
  'latitud',
  'longitud',
  'notas',
]

export default function FichaResumen({ cliente, onGuardado, onError }) {
  const [form, setForm] = useState(() =>
    Object.fromEntries(EDITABLES.map((c) => [c, cliente[c] ?? ''])),
  )
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)

  // Lo que necesitan las tarjetas del resumen y no viene en la ficha.
  const [diaMaximo, setDiaMaximo] = useState(5)
  const [promesa, setPromesa] = useState(null)
  const [aFavor, setAFavor] = useState(0)

  useEffect(() => {
    let vigente = true

    Promise.all([
      supabase.from('sri_config').select('dia_maximo_pago').limit(1).maybeSingle(),
      supabase
        .from('promesas_pago')
        .select('*')
        .eq('client_id', cliente.id)
        .eq('estado', 'activa')
        .maybeSingle(),
      // Cobros que no se aplicaron a ninguna factura: plata del abonado que
      // está a su favor hasta que se le impute a una.
      //
      // Se mira `factura_id`, no `document_id`: este último es el comprobante
      // del SRI, y un cobro imputado a una factura sin comprobante fiscal —lo
      // normal en quien no pide factura— no es un saldo a favor.
      supabase
        .from('pagos')
        .select('monto')
        .eq('client_id', cliente.id)
        .is('factura_id', null)
        .eq('anulado', false),

      // Y lo que pagó de más sobre facturas que ya estaban cubiertas: si trae
      // $50 por una factura de $34.50, esos $15.50 también son suyos.
      supabase.from('v_facturas').select('saldo').eq('client_id', cliente.id),
    ]).then(([cfg, prom, abonos, facturas]) => {
      if (!vigente) return
      setDiaMaximo(cfg.data?.dia_maximo_pago ?? 5)
      setPromesa(prom.data ?? null)

      const sinImputar = (abonos.data ?? []).reduce((s, p) => s + Number(p.monto ?? 0), 0)
      const sobrepagos = (facturas.data ?? []).reduce(
        (s, f) => s + Math.max(0, -Number(f.saldo ?? 0)),
        0,
      )

      setAFavor(Math.round((sinImputar + sobrepagos) * 100) / 100)
    })

    return () => {
      vigente = false
    }
  }, [cliente.id])

  const set = (campo) => (e) => {
    setGuardado(false)
    setForm((f) => ({ ...f, [campo]: e.target.value }))
  }

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    onError?.(null)

    try {
      // Los numéricos vacíos van como NULL: '' rompe una columna numérica.
      //
      // Solo se tocan los que este formulario edita. Convertir uno que no está
      // en el formulario daría NaN, que viaja como null y borraría el dato —el
      // precio mensual, por ejemplo, que ahora se edita en Servicio—.
      const cambios = { ...form }
      for (const campo of ['dia_facturacion', 'latitud', 'longitud']) {
        if (!(campo in cambios)) continue
        cambios[campo] = cambios[campo] === '' ? null : Number(cambios[campo])
      }
      for (const campo of EDITABLES) {
        if (cambios[campo] === '') cambios[campo] = null
      }
      // El interruptor es booleano: false no es "vacío".
      cambios.factura_electronica = Boolean(form.factura_electronica)

      const { error } = await supabase.from('clientes').update(cambios).eq('id', cliente.id)
      if (error) throw error

      setGuardado(true)
      await onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  /** Toma la ubicación del navegador: más rápido que buscar las coordenadas. */
  function ubicacionActual() {
    if (!navigator.geolocation) {
      return onError?.(new Error('Este navegador no puede dar la ubicación.'))
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        setForm((f) => ({
          ...f,
          latitud: pos.coords.latitude.toFixed(7),
          longitud: pos.coords.longitude.toFixed(7),
        })),
      (err) => onError?.(new Error(`No se pudo obtener la ubicación: ${err.message}`)),
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
      <Card title="Datos del cliente">
        {/* Lo que no se escribe: quién es, cómo está y con qué entra. Va fuera
            del formulario porque no se guarda con él. */}
        <IdentidadCliente
          cliente={cliente}
          promesa={promesa}
          onGuardado={onGuardado}
          onError={onError}
        />

        <form onSubmit={guardar} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cliente" className="sm:col-span-2">
              <Input value={form.nombre} onChange={set('nombre')} required />
            </Field>

            <Field label="Tipo de identificación">
              <Select value={form.tipo_identificacion || '05'} onChange={set('tipo_identificacion')}>
                <option value="05">Cédula</option>
                <option value="04">RUC</option>
                <option value="06">Pasaporte</option>
                <option value="07">Consumidor final</option>
                <option value="08">Identificación del exterior</option>
              </Select>
            </Field>
            <Field label="N° de identificación" hint="Sin esto no se le puede facturar">
              <Input value={form.identificacion} onChange={set('identificacion')} />
            </Field>

            <Field label="Dirección principal" className="sm:col-span-2">
              <Input value={form.direccion} onChange={set('direccion')} />
            </Field>

            {/*
              Para qué es este servicio, cuando la misma persona tiene más de
              uno: la casa y el local. Antes eso se decía pegándole un "-2" al
              apellido, que salía impreso en la factura y en el contrato.

              Esto no sale en ninguno de los dos: el nombre y la dirección son
              lo que se imprime, y esto se ve solo por dentro y en el selector
              del portal del abonado.
            */}
            <Field
              label="Referencia del servicio"
              hint="Casa, Local, Bodega. Para distinguirlo por dentro: no sale en la factura."
              className="sm:col-span-2"
            >
              <Input
                value={form.referencia_servicio ?? ''}
                onChange={set('referencia_servicio')}
                placeholder="Casa"
                maxLength={40}
              />
            </Field>

            {/* La zona es de gestión, no de red: es con la que se arma a quién
                llamar y a quién ir a visitar. Se escribe libre porque cada ISP
                divide su cobertura como le sirve. */}
            <Field label="Zona" hint="Con la que se filtra el listado y se arman las visitas">
              <Input value={form.zona} onChange={set('zona')} placeholder="La Maná, Centro…" />
            </Field>

            <Field label="Teléfono fijo">
              <Input value={form.telefono} onChange={set('telefono')} />
            </Field>
            <Field label="Teléfono móvil">
              <Input value={form.telefono_movil} onChange={set('telefono_movil')} />
            </Field>

            <Field label="E-mail" hint="Ahí llegan la factura y el RIDE">
              <Input type="email" value={form.email} onChange={set('email')} />
            </Field>
            {/* La pasarela y el código van juntos: el mismo número no
                significa lo mismo en dos plataformas distintas, y quien
                concilia los cobros del mes necesita saber contra qué reporte
                cruzarlo. La lista sugiere, no obliga. */}
            <Field label="Pasarela de cobro" hint="Dónde paga">
              <Input
                value={form.pasarela}
                onChange={set('pasarela')}
                list="pasarelas-conocidas"
                placeholder="Cuentadigital, ventanilla…"
              />
              <datalist id="pasarelas-conocidas">
                <option value="Cuentadigital" />
                <option value="Cobro Digital" />
                <option value="PayPhone" />
                <option value="Datafast" />
                <option value="Payu" />
                <option value="Deuna" />
                <option value="Transferencia" />
                <option value="Ventanilla" />
              </datalist>
            </Field>
            <Field label="N° de código de pago" hint="El que usa para pagar ahí">
              <Input value={form.codigo_pago} onChange={set('codigo_pago')} />
            </Field>

            <Field label="Día de facturación" hint="Día del mes en que se le emite">
              <Select value={form.dia_facturacion ?? ''} onChange={set('dia_facturacion')}>
                <option value="">— sin definir —</option>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {String(d).padStart(2, '0')} de cada mes
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Ubicación" hint="Latitud y longitud: es lo que lo pone en el mapa">
              <div className="flex gap-2">
                <Input
                  value={form.latitud}
                  onChange={set('latitud')}
                  placeholder="-0.9376"
                  className="min-w-0"
                />
                <Input
                  value={form.longitud}
                  onChange={set('longitud')}
                  placeholder="-79.2270"
                  className="min-w-0"
                />
                <Button
                  type="button"
                  variante="secundario"
                  icon={MapPin}
                  onClick={ubicacionActual}
                  title="Usar la ubicación de este dispositivo"
                />
              </div>
            </Field>

            {/* Decide si sus cobros entran a la cola de facturación
                electrónica. Hay abonados que no quieren factura y se llevan
                solo el recibo. */}
            <div className="sm:col-span-2 t-panel p-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={Boolean(form.factura_electronica)}
                  onChange={(e) => {
                    setGuardado(false)
                    setForm((f) => ({ ...f, factura_electronica: e.target.checked }))
                  }}
                  className="accent-sky-500"
                />
                Emitirle factura electrónica
              </label>
              <p className="mt-1 text-[11px] text-slate-500">
                {form.factura_electronica
                  ? 'Cada cobro suyo entra a Facturación → Por facturar, para revisarlo y enviarlo al SRI al cierre.'
                  : 'Solo se le entrega el recibo del cobro. No se le emite comprobante electrónico.'}
              </p>
              {form.factura_electronica && !form.identificacion && (
                <p className="mt-1 text-[11px] text-amber-400">
                  Falta la identificación: el SRI no acepta el comprobante sin cédula o RUC.
                </p>
              )}
            </div>

            <Field label="Notas" className="sm:col-span-2">
              <Textarea rows={3} value={form.notas} onChange={set('notas')} />
            </Field>
          </div>

          {guardado && <Aviso>Datos guardados.</Aviso>}

          <div className="flex justify-end">
            <Button type="submit" variante="primario" icon={Save} cargando={guardando}>
              Guardar datos
            </Button>
          </div>
        </form>
      </Card>

      <ResumenCuenta cliente={cliente} diaMaximo={diaMaximo} promesa={promesa} aFavor={aFavor} />
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * Fecha de corte de un mes.
 *
 * Es el día máximo de pago configurado, corrido tantos meses como haga falta.
 * `mes + n` con día fijo lo resuelve Date sin tablas de días por mes.
 */
function fechaCorte(diaMaximo, mesesDesplazado = 0, hoy = new Date()) {
  return new Date(hoy.getFullYear(), hoy.getMonth() + mesesDesplazado, diaMaximo, 12)
}

/** Lo que hay que poder contestar sin buscar en otra pantalla. */
function ResumenCuenta({ cliente, diaMaximo, promesa, aFavor }) {
  const debe = Number(cliente.saldo) > 0
  const hoy = new Date()

  // El último corte que ya pasó y el próximo que viene. Si hoy todavía no
  // llegó al día de corte de este mes, el vencido es el del mes anterior.
  const corteDeEsteMes = fechaCorte(diaMaximo, 0, hoy)
  const yaPaso = hoy > corteDeEsteMes
  const vencido = yaPaso ? corteDeEsteMes : fechaCorte(diaMaximo, -1, hoy)
  const proximo = yaPaso ? fechaCorte(diaMaximo, 1, hoy) : corteDeEsteMes

  // Una promesa activa corre el corte hasta la fecha acordada.
  const conPromesa = promesa && promesa.estado === 'activa'

  const tarjetas = [
    {
      icon: CalendarDays,
      color: 'bg-sky-600',
      titulo: cliente.dia_facturacion
        ? `${String(cliente.dia_facturacion).padStart(2, '0')} de cada mes`
        : 'Sin definir',
      sub: 'Día de pago',
    },
    {
      icon: Wallet,
      color: debe ? 'bg-red-600' : 'bg-emerald-600',
      titulo: dinero(cliente.saldo),
      sub: debe
        ? `Deuda actual · ${cliente.facturas_pendientes} factura(s)`
        : 'Sin deuda pendiente',
    },
    {
      icon: PiggyBank,
      color: aFavor > 0 ? 'bg-fuchsia-600' : 'bg-slate-700',
      titulo: dinero(aFavor),
      sub: aFavor > 0 ? 'Saldos a favor · abonos sin factura' : 'Saldos',
    },
    {
      icon: CalendarDays,
      color: 'bg-slate-700',
      titulo: fecha(cliente.ultimo_pago),
      sub: 'Último pago',
    },
    {
      icon: MessageSquare,
      color: 'bg-violet-600',
      titulo: fecha(proximo.toISOString().slice(0, 10)),
      // No hay módulo de SMS: decir la fecha sin aclararlo haría creer que el
      // aviso salió.
      sub: 'Aviso SMS · sin configurar',
    },
    {
      icon: Ban,
      color: debe && yaPaso ? 'bg-red-600' : 'bg-slate-700',
      titulo: fecha(vencido.toISOString().slice(0, 10)),
      sub: debe && yaPaso ? 'Corte de servicio · mes vencido' : 'Corte de servicio / mes vencido',
    },
    {
      icon: conPromesa ? CalendarClock : Ban,
      color: conPromesa ? 'bg-amber-600' : 'bg-orange-600',
      titulo: conPromesa
        ? fecha(promesa.fecha_promesa)
        : fecha(proximo.toISOString().slice(0, 10)),
      sub: conPromesa
        ? `Próximo corte · prorrogado por promesa${promesa.monto ? ` de ${dinero(promesa.monto)}` : ''}`
        : 'Próximo corte de servicio',
    },
    {
      icon: AlertTriangle,
      color: cliente.estado === 'activo' ? 'bg-emerald-600' : 'bg-amber-600',
      titulo: cliente.estado,
      sub: 'Estado del servicio',
    },
  ]

  return (
    <div className="space-y-4">
      <Card title="Resumen">
        <div className="grid gap-3 sm:grid-cols-2">
          {tarjetas.map((t, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 rounded-lg ${t.color} px-3 py-2.5 text-white`}
            >
              <t.icon size={20} className="shrink-0 opacity-90" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold capitalize">{t.titulo}</p>
                <p className="truncate text-[11px] opacity-80">{t.sub}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Contrato vigente">
        {cliente.contrato_id ? (
          <div className="space-y-1 text-sm text-slate-300">
            <p>
              N° <b className="text-slate-100">{cliente.contrato_numero ?? 'sin número'}</b>
            </p>
            <p>
              Precio pactado:{' '}
              <b className="text-slate-100">{dinero(cliente.contrato_precio)}</b> por mes
            </p>
          </div>
        ) : (
          <Aviso>
            No tiene contrato cargado. Se crea desde la pestaña <b>Contratos</b>.
          </Aviso>
        )}
      </Card>
    </div>
  )
}
