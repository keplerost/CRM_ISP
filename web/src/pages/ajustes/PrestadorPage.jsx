import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Building2, Check, ExternalLink, Info, Save, ShieldCheck } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Aviso, Button, Card, Cargando, ErrorBanner, Field, Input, Select, Textarea } from '../../components/ui'
import ClausulasContrato from '../../components/contratos/ClausulasContrato'

/**
 * El prestador del servicio, para el contrato de adhesión.
 *
 * ── Por qué esta pantalla existe si ya está la de Empresa ──
 *
 * Porque son dos trámites ante dos reguladores distintos. "Empresa" son los
 * datos con los que se factura ante el SRI; esto es con quién se firma el
 * contrato ante la ARCOTEL.
 *
 * Casi siempre son el mismo negocio, y por eso los seis campos que comparten
 * —razón social, nombre comercial, RUC, teléfono, correo y dirección— se
 * heredan solos de Empresa y acá se muestran en gris: se editan allá una vez y
 * valen en los dos lados.
 *
 * Lo que sí se carga acá es lo que el SRI no sabe, empezando por la fecha en que
 * este ISP inscribió su modelo de contrato. Sin eso, el contrato sale avisando
 * que no se puede contrastar contra un modelo aprobado.
 */

const VACIO = {
  provincia: '',
  canton: '',
  ciudad: '',
  parroquia: '',
  web: '',
  reclamos_email: '',
  reclamos_telefono: '',
  reclamos_oficinas: '',
  reclamos_horario: '',
  modelo_inscrito_el: '',
  vigencia_meses: 24,
  permanencia_meses: 24,
  valor_instalacion: 0,
  plazo_instalacion: '24 horas',
  beneficios_permanencia: '',
  beneficio_anexo: '',
  costo_no_permanencia: '',
  arbitraje_por_defecto: true,
}

/** Un dato que viene de Empresa y acá solo se muestra. */
function Heredado({ label, valor }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-0.5 truncate text-sm text-slate-300">{valor || '— sin cargar —'}</p>
    </div>
  )
}

export default function PrestadorPage() {
  const [prestadores, setPrestadores] = useState([])
  /**
   * Cuál se está editando.
   *
   * Hay ISP con más de uno —el que factura y el que firma los contratos pueden
   * ser entidades distintas, y cada abonado pertenece a una—. Sin este selector,
   * el segundo prestador no se podría completar nunca y sus contratos saldrían
   * para siempre avisando que falta la fecha de inscripción.
   */
  const [elegido, setElegido] = useState(null)
  const [prestador, setPrestador] = useState(null)
  const [form, setForm] = useState(VACIO)
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)
  const [error, setError] = useState(null)

  const set = (campo) => (e) => {
    setGuardado(false)
    setForm((f) => ({ ...f, [campo]: e.target.value }))
  }

  const cargar = useCallback(async () => {
    setCargando(true)
    // De `v_prestadores_listos` y no de la tabla: trae además qué le falta y si
    // sus datos de identidad se mantienen solos desde Empresa.
    const { data: todos, error: err } = await supabase
      .from('v_prestadores_listos')
      .select('*')
      .order('predeterminado', { ascending: false })

    if (err) setError(err)
    setPrestadores(todos ?? [])

    // Se conserva el que se estaba editando al recargar después de guardar; la
    // primera vez, el predeterminado.
    const data = (todos ?? []).find((p) => p.id === elegido) ?? todos?.[0] ?? null
    aplicar(data)
    setCargando(false)
  }, [elegido])

  /** Pone en el formulario los datos de un prestador ya traído. */
  function aplicar(data) {
    setElegido(data?.id ?? null)
    setPrestador(data)
    setGuardado(false)
    if (!data) return

    setForm({
      ...VACIO,
      ...Object.fromEntries(Object.keys(VACIO).map((k) => [k, data[k] ?? VACIO[k]])),
      // La fecha llega como timestamp y el input la quiere como AAAA-MM-DD.
      modelo_inscrito_el: data.modelo_inscrito_el
        ? String(data.modelo_inscrito_el).slice(0, 10)
        : '',
    })
  }

  useEffect(() => {
    cargar()
    // Deliberadamente sin `cargar` en las dependencias: cambia con `elegido`, y
    // encadenarlo volvería a leer la base en cada cambio de selección en vez de
    // usar lo que ya se trajo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)

    try {
      const { error: err } = await supabase
        .from('prestadores')
        .update({
          provincia: form.provincia.trim() || null,
          canton: form.canton.trim() || null,
          ciudad: form.ciudad.trim() || null,
          parroquia: form.parroquia.trim() || null,
          web: form.web.trim() || null,
          reclamos_email: form.reclamos_email.trim() || null,
          reclamos_telefono: form.reclamos_telefono.trim() || null,
          reclamos_oficinas: form.reclamos_oficinas.trim() || null,
          reclamos_horario: form.reclamos_horario.trim() || null,
          modelo_inscrito_el: form.modelo_inscrito_el || null,
          vigencia_meses: Number(form.vigencia_meses) || 0,
          permanencia_meses: Number(form.permanencia_meses) || 0,
          valor_instalacion: Number(form.valor_instalacion) || 0,
          plazo_instalacion: form.plazo_instalacion.trim() || null,
          beneficios_permanencia: form.beneficios_permanencia.trim() || null,
          beneficio_anexo: form.beneficio_anexo.trim() || null,
          costo_no_permanencia: form.costo_no_permanencia.trim() || null,
          arbitraje_por_defecto: form.arbitraje_por_defecto === true
            || form.arbitraje_por_defecto === 'true',
          actualizado_en: new Date().toISOString(),
        })
        .eq('id', prestador.id)
      if (err) throw err

      setGuardado(true)
      await cargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  if (cargando) return <Cargando />

  if (!prestador) {
    return (
      <div className="space-y-4">
        <Link to="/ajustes" className="inline-flex items-center gap-2 text-sm text-slate-400">
          <ArrowLeft size={16} /> Ajustes
        </Link>
        <Aviso>
          Todavía no hay ningún prestador. Cargá los datos de la empresa en{' '}
          <Link to="/ajustes/empresa" className="font-medium underline">
            Ajustes → Empresa
          </Link>{' '}
          y el sistema crea uno con esos datos; después volvé acá a completar lo que falta.
        </Aviso>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Link
          to="/ajustes"
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200"
        >
          <ArrowLeft size={16} /> Ajustes
        </Link>
        {guardado && (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <Check size={14} /> Guardado
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="t-titulo text-lg font-bold text-slate-100">Prestador del servicio</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Lo que va en el contrato de adhesión y sus anexos. Es un trámite distinto del SRI: acá
            se carga lo que la configuración de facturación no puede saber.
          </p>
        </div>

        {/* Solo cuando hay más de uno: un selector de una opción es ruido. */}
        {prestadores.length > 1 && (
          <Field label="Editando">
            <Select
              value={elegido ?? ''}
              onChange={(e) => aplicar(prestadores.find((p) => p.id === e.target.value))}
            >
              {prestadores.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre_comercial || p.razon_social}
                  {p.predeterminado ? ' (predeterminado)' : ''}
                  {p.le_falta.length ? ` — le faltan ${p.le_falta.length}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {/*
        Qué falta, arriba de todo y con nombre y apellido.

        La lista sale de la base, no de esta pantalla: si mañana el contrato
        necesita un campo más, aparece acá solo.
      */}
      {prestador.le_falta?.length > 0 ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-200">
            <Info size={15} /> Falta esto para poder emitir contratos
          </p>
          <ul className="space-y-1 text-xs text-amber-100/80">
            {prestador.le_falta.map((f) => (
              <li key={f} className="flex items-start gap-2">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber-400" />
                {f}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-200">
          <ShieldCheck size={16} /> Los contratos salen completos.
        </div>
      )}

      <Card title="Identidad" icon={Building2} subtitle="Se carga en Ajustes → Empresa">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Heredado label="Razón social" valor={prestador.razon_social} />
          <Heredado label="Nombre comercial" valor={prestador.nombre_comercial} />
          <Heredado label="RUC" valor={prestador.ruc} />
          <Heredado label="Dirección" valor={prestador.direccion} />
          <Heredado label="Teléfono" valor={prestador.telefono} />
          <Heredado label="Correo" valor={prestador.email} />
        </div>

        <p className="mt-3 flex items-center gap-2 text-xs text-slate-500">
          {prestador.hereda_del_sri ? (
            <>
              Estos seis se mantienen al día solos desde{' '}
              <Link to="/ajustes/empresa" className="inline-flex items-center gap-1 underline">
                Empresa <ExternalLink size={11} />
              </Link>
              , porque el RUC coincide con el de facturación.
            </>
          ) : (
            <>
              Este prestador tiene un RUC distinto del de facturación, así que sus datos no se
              heredan: se editan solo acá.
            </>
          )}
        </p>
      </Card>

      <form onSubmit={guardar} className="space-y-4">
        <Card
          title="Domicilio"
          subtitle="La cláusula primera lo pide desglosado, no como un texto suelto"
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Provincia">
              <Input value={form.provincia} onChange={set('provincia')} placeholder="Cotopaxi" />
            </Field>
            <Field label="Cantón">
              <Input value={form.canton} onChange={set('canton')} placeholder="La Maná" />
            </Field>
            <Field label="Ciudad">
              <Input value={form.ciudad} onChange={set('ciudad')} placeholder="La Maná" />
            </Field>
            <Field label="Parroquia">
              <Input value={form.parroquia} onChange={set('parroquia')} placeholder="La Maná" />
            </Field>
          </div>
        </Card>

        <Card
          title="Reclamos y soporte"
          subtitle="Cláusula décima: por dónde el abonado reclama cuando algo sale mal"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Correo de reclamos"
              hint="Puede ser distinto del de facturación"
            >
              <Input
                type="email"
                value={form.reclamos_email}
                onChange={set('reclamos_email')}
                placeholder="soporte@miisp.ec"
              />
            </Field>
            <Field label="Teléfono de reclamos">
              <Input value={form.reclamos_telefono} onChange={set('reclamos_telefono')} />
            </Field>
            <Field label="Oficinas de atención">
              <Input value={form.reclamos_oficinas} onChange={set('reclamos_oficinas')} />
            </Field>
            <Field label="Horario de atención">
              <Input
                value={form.reclamos_horario}
                onChange={set('reclamos_horario')}
                placeholder="08:00am a 18:00pm"
              />
            </Field>
            <Field
              label="Sitio web"
              hint="El anexo 1f lo pide dos veces: tarifas y calidad del servicio"
              className="sm:col-span-2"
            >
              <Input value={form.web} onChange={set('web')} placeholder="https://miisp.ec/" />
            </Field>
          </div>
        </Card>

        <Card
          title="El modelo inscrito"
          subtitle="Lo que hace que el contrato sea verificable"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              label="Inscrito ante la ARCOTEL el"
              hint="Se imprime al pie de cada hoja"
            >
              <Input
                type="date"
                value={form.modelo_inscrito_el}
                onChange={set('modelo_inscrito_el')}
              />
            </Field>
            <Field label="Vigencia (meses)" hint="Cláusula cuarta">
              <Input
                type="number"
                min={0}
                value={form.vigencia_meses}
                onChange={set('vigencia_meses')}
              />
            </Field>
            <Field label="Permanencia mínima (meses)" hint="Cláusula quinta">
              <Input
                type="number"
                min={0}
                value={form.permanencia_meses}
                onChange={set('permanencia_meses')}
              />
            </Field>
          </div>

          {/*
            El arbitraje se PROPONE, no se impone. El contrato dice que el
            abonado "deberá señalarlo en forma expresa" y que puede significarle
            costos; además firma una raya aparte para eso.
          */}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field
              label="Arbitraje al vender"
              hint="Con qué valor aparece propuesta la casilla. El abonado la firma aparte."
            >
              <Select
                value={String(form.arbitraje_por_defecto)}
                onChange={(e) =>
                  setForm((f) => ({ ...f, arbitraje_por_defecto: e.target.value === 'true' }))
                }
              >
                <option value="true">Propuesto en SÍ</option>
                <option value="false">Propuesto en NO</option>
              </Select>
            </Field>
          </div>
        </Card>

        <Card title="Tarifas y permanencia" subtitle="Anexo 1f">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Valor de instalación (USD)" hint="Se cobra una sola vez">
              <Input
                type="number"
                step="0.01"
                min={0}
                value={form.valor_instalacion}
                onChange={set('valor_instalacion')}
              />
            </Field>
            <Field label="Plazo para instalar / activar">
              <Input
                value={form.plazo_instalacion}
                onChange={set('plazo_instalacion')}
                placeholder="24 horas"
              />
            </Field>

            <Field
              label="Beneficios de la permanencia"
              hint="Uno por línea. Se numeran en la cláusula quinta"
              className="sm:col-span-2"
            >
              <Textarea
                rows={2}
                value={form.beneficios_permanencia}
                onChange={set('beneficios_permanencia')}
                placeholder={'Instalación de servicio de internet\nSoporte técnico inmediato'}
              />
            </Field>

            <Field label="Beneficio que acredita el anexo 1f">
              <Input
                value={form.beneficio_anexo}
                onChange={set('beneficio_anexo')}
                placeholder="INSTALACIÓN GRATIS"
              />
            </Field>
            <Field label="Si no cumple la permanencia">
              <Input
                value={form.costo_no_permanencia}
                onChange={set('costo_no_permanencia')}
                placeholder='EL ABONADO PAGARÁ EL COSTO DE INSTALACIÓN'
              />
            </Field>
          </div>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" variante="primario" icon={Save} cargando={guardando}>
            Guardar
          </Button>
        </div>
      </form>

      {/*
        Fuera del formulario: las cláusulas se guardan de a una, no con el botón
        de arriba. Meterlas adentro haría que "Guardar" prometa guardar también
        lo que está abierto en el editor, y no es así.
      */}
      <ClausulasContrato prestador={prestador} onError={setError} />
    </div>
  )
}
