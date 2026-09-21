import { useState } from 'react'
import { dineroCero as dinero } from '../../lib/formato'
import { Accessibility, HandCoins, Save, Settings, Tag } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Aviso, Button, Card, Field, Input, Select } from '../ui'

/**
 * Cómo se le factura a este abonado.
 *
 * Son las reglas que usa la generación mensual y el corte por mora. Viven en el
 * cliente y no en un ajuste global porque conviven modalidades distintas: el
 * que paga adelantado, el institucional que paga a mes vencido y el que tiene
 * un acuerdo de más días de gracia.
 */

const CAMPOS = [
  'modalidad_pago',
  'dia_facturacion',
  'dia_generar_factura',
  'tipo_impuesto',
  'dias_gracia',
  'aplicar_corte',
  'cortar_tras_meses',
  'descuento_tipo',
  'descuento_porcentaje',
  'descuento_documento',
  'promo_porcentaje',
  'promo_meses',
  'promo_desde',
  'descuento_fijo',
  'descuento_fijo_motivo',
]

/**
 * El día del mes en que le corresponde el corte.
 *
 * Es el día de facturación —que también es el vencimiento— más los días de
 * gracia. Se muestra al lado del campo porque "3 días de gracia" no le dice a
 * nadie cuándo se corta, y "se corta el 9" sí.
 *
 * Cuando la suma se pasa del mes se dice así, en vez de mostrar un día 38: el
 * mes siguiente no tiene el mismo largo todos los meses y prometer una fecha
 * exacta sería mentir.
 */
function diaDeCorte({ dia_facturacion: dia, dias_gracia: gracia }) {
  const d = Number(dia) || 1
  const g = Number(gracia) || 0
  if (g === 0) return `${d}, el mismo día`
  const suma = d + g
  return suma <= 28 ? String(suma) : `${g} días después`
}

const hoy = () => new Date().toISOString().slice(0, 10)

/** Cuando termina la promocion: la fecha de inicio mas los meses pactados. */
function finDePromo(desde, meses) {
  if (!desde || !(Number(meses) > 0)) return null
  const d = new Date(`${String(desde).slice(0, 10)}T12:00:00`)
  d.setMonth(d.getMonth() + Number(meses))
  return d
}

const fechaLarga = (d) =>
  d?.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

export default function ConfigFacturacion({ cliente, onGuardado, onError }) {
  const [form, setForm] = useState(() =>
    Object.fromEntries(CAMPOS.map((c) => [c, cliente[c] ?? ''])),
  )
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)

  const set = (campo) => (e) => {
    setGuardado(false)
    const valor = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm((f) => ({ ...f, [campo]: valor }))
  }

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    onError?.(null)

    try {
      const cambios = {
        modalidad_pago: form.modalidad_pago || 'prepago',
        tipo_impuesto: form.tipo_impuesto || 'incluido',
        dia_facturacion: form.dia_facturacion === '' ? null : Number(form.dia_facturacion),
        dia_generar_factura:
          form.dia_generar_factura === '' ? null : Number(form.dia_generar_factura),
        dias_gracia: Number(form.dias_gracia) || 0,
        cortar_tras_meses: Number(form.cortar_tras_meses ?? 1),
        descuento_tipo: form.descuento_tipo || null,
        descuento_porcentaje: form.descuento_tipo ? Number(form.descuento_porcentaje) || 50 : null,
        descuento_documento: form.descuento_tipo
          ? form.descuento_documento?.trim() || null
          : null,
        // El de ley manda: cargar los dos dejaria en duda cual se aplica.
        promo_porcentaje: form.descuento_tipo ? null : Number(form.promo_porcentaje) || null,
        promo_meses: form.descuento_tipo ? null : Number(form.promo_meses) || null,
        promo_desde: form.descuento_tipo ? null : form.promo_desde || null,
        // Mismo criterio: si tiene el de ley, el acuerdo en plata no se guarda.
        descuento_fijo: form.descuento_tipo ? null : Number(form.descuento_fijo) || null,
        descuento_fijo_motivo:
          form.descuento_tipo || !Number(form.descuento_fijo)
            ? null
            : form.descuento_fijo_motivo?.trim() || null,
      }

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

  const dias = Array.from({ length: 28 }, (_, i) => i + 1)

  const precio = Number(cliente.precio_mensual ?? cliente.plan_precio ?? 0)
  const conDescuento = (pct) => precio * (1 - (Number(pct) || 0) / 100)
  const fin = finDePromo(form.promo_desde, form.promo_meses)
  const vencida = fin ? new Date() >= fin : false

  return (
    <Card title="Configuración de facturación" icon={Settings}>
      <form onSubmit={guardar} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label="Modalidad"
            hint={
              form.modalidad_pago === 'postpago'
                ? 'Se cobra el mes ya consumido.'
                : 'Se cobra el mes por adelantado.'
            }
          >
            <Select value={form.modalidad_pago || 'prepago'} onChange={set('modalidad_pago')}>
              <option value="prepago">Prepago (adelantado)</option>
              <option value="postpago">Postpago (mes vencido)</option>
            </Select>
          </Field>

          <Field label="Día de pago" hint="Vencimiento de la factura">
            <Select value={form.dia_facturacion ?? ''} onChange={set('dia_facturacion')}>
              <option value="">— sin definir —</option>
              {dias.map((d) => (
                <option key={d} value={d}>
                  {String(d).padStart(2, '0')} de cada mes
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Día de crear la factura"
            hint="Antes del día de pago, para que llegue con tiempo"
          >
            <Select value={form.dia_generar_factura ?? ''} onChange={set('dia_generar_factura')}>
              <option value="">— el mismo día de pago —</option>
              {dias.map((d) => (
                <option key={d} value={d}>
                  {String(d).padStart(2, '0')} de cada mes
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Tipo de impuesto"
            hint={
              form.tipo_impuesto === 'mas'
                ? 'Al precio del servicio se le suma el IVA.'
                : form.tipo_impuesto === 'ninguno'
                  ? 'No se le calcula impuesto.'
                  : 'El precio del servicio ya incluye el IVA.'
            }
          >
            <Select value={form.tipo_impuesto || 'incluido'} onChange={set('tipo_impuesto')}>
              <option value="incluido">Impuesto incluido</option>
              <option value="mas">Más impuestos</option>
              <option value="ninguno">Ninguno</option>
            </Select>
          </Field>

          {/* Este es el campo que decide la fecha de corte, y por eso dice el día
              exacto: "días de gracia" solo no le dice a nadie cuándo se corta. */}
          <Field
            label="Días de gracia"
            hint={
              form.dia_facturacion
                ? `Vence el ${form.dia_facturacion} · se corta el ${diaDeCorte(form)}`
                : 'Después del vencimiento, antes de cortar'
            }
          >
            <Input
              type="number"
              min={0}
              // Un año. Es donde vive el plazo del que paga cada varios meses,
              // desde que los meses dejaron de decidir el momento del corte.
              max={365}
              value={form.dias_gracia ?? 0}
              onChange={set('dias_gracia')}
            />
          </Field>

          {/**
           * Sí o no, y nada más.
           *
           * Antes acá se elegía "a los cuántos meses de atraso se le corta", y eso
           * competía con los días de gracia de al lado: dos campos para la misma
           * pregunta, y el corte usaba el equivocado. Con el umbral en un mes, el
           * que no pagaba el 5 se cortaba el 5 del mes siguiente.
           *
           * Desde la 154 el momento lo deciden los días de gracia, y esto quedó
           * como lo que siempre fue en la práctica: el interruptor del que no se
           * corta nunca —servicio gratis, enlace institucional, cámara—. Se sigue
           * guardando en `cortar_tras_meses` para no romper lo que ya está.
           */}
          <Field label="Se le corta por mora" hint="El que no se corta nunca: gratis, institucional">
            <Select
              value={(form.cortar_tras_meses ?? 1) > 0 ? 'si' : 'no'}
              onChange={(e) => {
                setGuardado(false)
                setForm((f) => ({ ...f, cortar_tras_meses: e.target.value === 'si' ? 1 : 0 }))
              }}
            >
              <option value="si">Sí, en su fecha de corte</option>
              <option value="no">No se corta nunca</option>
            </Select>
          </Field>
        </div>

        {/* --- Descuento de ley -------------------------------------------- */}
        <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/40 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Accessibility size={16} className="text-emerald-400" />
            Descuento por grupo prioritario
          </h3>
          <p className="text-xs text-slate-400">
            Tercera edad y discapacidad tienen derecho por ley al 50% sobre el servicio. No vence:
            se aplica a cada factura mientras esté cargado.
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Grupo">
              <Select
                value={form.descuento_tipo ?? ''}
                onChange={(e) => {
                  const tipo = e.target.value
                  setGuardado(false)
                  setForm((f) => ({
                    ...f,
                    descuento_tipo: tipo,
                    // Es el porcentaje de la norma: se propone y se puede cambiar.
                    descuento_porcentaje:
                      tipo && !f.descuento_porcentaje ? 50 : f.descuento_porcentaje,
                  }))
                }}
              >
                <option value="">— no aplica —</option>
                <option value="tercera_edad">Tercera edad</option>
                <option value="discapacidad">Discapacidad</option>
              </Select>
            </Field>

            <Field label="Porcentaje %" hint="Por norma, 50">
              <Input
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={form.descuento_porcentaje ?? ''}
                onChange={set('descuento_porcentaje')}
                disabled={!form.descuento_tipo}
              />
            </Field>

            <Field label="Documento de respaldo" hint="Carnet del CONADIS, cédula">
              <Input
                value={form.descuento_documento ?? ''}
                onChange={set('descuento_documento')}
                disabled={!form.descuento_tipo}
                placeholder="N° del documento"
              />
            </Field>
          </div>

          {form.descuento_tipo && precio > 0 && (
            <Aviso>
              Se le factura <b>{dinero(conDescuento(form.descuento_porcentaje))}</b> en vez de{' '}
              {dinero(precio)} — {Number(form.descuento_porcentaje) || 0}% de descuento, sin
              vencimiento.
            </Aviso>
          )}
        </section>

        {/* --- Promoción comercial ------------------------------------------ */}
        <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/40 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Tag size={16} className="text-fuchsia-400" />
            Promoción por tiempo limitado
          </h3>
          <p className="text-xs text-slate-400">
            Para el abonado que no pertenece a ningún grupo prioritario. Al cumplirse los meses
            pactados vuelve solo al precio de lista, sin que nadie tenga que acordarse.
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Descuento %">
              <Input
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={form.promo_porcentaje ?? ''}
                onChange={(e) => {
                  setGuardado(false)
                  const v = e.target.value
                  setForm((f) => ({
                    ...f,
                    promo_porcentaje: v,
                    // Sin fecha de inicio la promoción no corre: se propone hoy.
                    promo_desde: v && !f.promo_desde ? hoy() : f.promo_desde,
                    promo_meses: v && !f.promo_meses ? 3 : f.promo_meses,
                  }))
                }}
                disabled={Boolean(form.descuento_tipo)}
              />
            </Field>

            <Field label="Meses que dura">
              <Input
                type="number"
                min={1}
                max={36}
                value={form.promo_meses ?? ''}
                onChange={set('promo_meses')}
                disabled={Boolean(form.descuento_tipo)}
              />
            </Field>

            <Field label="Desde">
              <Input
                type="date"
                value={String(form.promo_desde ?? '').slice(0, 10)}
                onChange={set('promo_desde')}
                disabled={Boolean(form.descuento_tipo)}
              />
            </Field>
          </div>

          {form.descuento_tipo ? (
            <Aviso tipo="alerta">
              No se acumula con el descuento de ley. Este abonado ya tiene el de{' '}
              {form.descuento_tipo === 'tercera_edad' ? 'tercera edad' : 'discapacidad'}, que es el
              que se le aplica.
            </Aviso>
          ) : (
            fin && (
              <Aviso tipo={vencida ? 'alerta' : 'info'}>
                {vencida ? (
                  <>
                    La promoción terminó el <b>{fechaLarga(fin)}</b>: se está facturando el precio
                    de lista, {dinero(precio)}.
                  </>
                ) : (
                  <>
                    Paga <b>{dinero(conDescuento(form.promo_porcentaje))}</b> en vez de{' '}
                    {dinero(precio)} hasta el <b>{fechaLarga(fin)}</b>. Desde esa fecha se le
                    factura {dinero(precio)}.
                  </>
                )}
              </Aviso>
            )
          )}
        </section>

        {/* --- Acuerdo en plata ---------------------------------------------- */}
        <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/40 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <HandCoins size={16} className="text-sky-400" />
            Descuento acordado, en dólares
          </h3>
          <p className="text-xs text-slate-400">
            Para el acuerdo puntual: el abonado que vuelve y pide que se le respete lo que pagaba
            antes. Se carga <b>cuánto se le baja del total</b> —con IVA ya incluido— y se le
            factura así <b>todos los meses</b>, sin fecha de fin, hasta que alguien lo saque.
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Se le baja $" hint="Del total, IVA incluido">
              <Input
                type="number"
                min={0}
                step="0.01"
                placeholder="0.10"
                value={form.descuento_fijo ?? ''}
                onChange={set('descuento_fijo')}
                disabled={Boolean(form.descuento_tipo)}
              />
            </Field>

            <Field
              className="sm:col-span-2"
              label="Por qué"
              hint="Dentro de seis meses es lo único que lo justifica"
            >
              <Input
                placeholder="Cliente que regresa, se le respeta el precio anterior"
                maxLength={160}
                value={form.descuento_fijo_motivo ?? ''}
                onChange={set('descuento_fijo_motivo')}
                disabled={Boolean(form.descuento_tipo)}
              />
            </Field>
          </div>

          {form.descuento_tipo ? (
            <Aviso tipo="alerta">
              No se acumula con el descuento de ley. Este abonado ya tiene el de{' '}
              {form.descuento_tipo === 'tercera_edad' ? 'tercera edad' : 'discapacidad'}.
            </Aviso>
          ) : Number(form.descuento_fijo) > 0 ? (
            <Aviso tipo="info">
              Se le factura <b>{dinero(precio - Number(form.descuento_fijo))}</b> en vez de{' '}
              {dinero(precio)}, con IVA y descuento incluidos. Son{' '}
              <b>{dinero(Number(form.descuento_fijo) * 12)}</b> al año que se dejan de facturar.
              {Number(form.promo_porcentaje) > 0 && (
                <>
                  {' '}
                  <b>Manda sobre la promoción:</b> mientras esté cargado, es este el que se aplica.
                </>
              )}
            </Aviso>
          ) : null}
        </section>

        {Number(form.cortar_tras_meses ?? 1) === 0 && (
          <Aviso tipo="alerta">
            Este abonado queda fuera de los cortes automáticos: va a seguir conectado aunque deba.
            Es lo correcto para el servicio gratis o el institucional.
          </Aviso>
        )}

        {Number(form.cortar_tras_meses ?? 1) > 1 && (
          <Aviso>
            Se le corta recién a los {form.cortar_tras_meses} meses de atraso. Hasta entonces sigue
            conectado debiendo, que es lo que corresponde a quien paga cada varios meses.
          </Aviso>
        )}

        {guardado && <Aviso>Configuración guardada.</Aviso>}

        <div className="flex justify-end">
          <Button type="submit" variante="primario" icon={Save} cargando={guardando}>
            Guardar configuración
          </Button>
        </div>
      </form>
    </Card>
  )
}
