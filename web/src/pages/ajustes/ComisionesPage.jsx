import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  BadgeDollarSign,
  Calculator,
  CircleCheck,
  GitBranch,
  History,
  Layers,
  Pencil,
  Plus,
  Save,
  ShieldCheck,
  Trophy,
} from 'lucide-react'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
} from '../../components/ui'
import ConPermiso from '../../components/layout/ConPermiso'
import { usePermisos } from '../../lib/AuthContext'
import { dineroCero as dinero } from '../../lib/formato'
import { comisionesApi, calcular, MODOS, REQUISITOS } from '../../lib/comisiones'

/**
 * Configuración → Ventas → Comisiones e Incentivos.
 *
 * ── Qué se puede tocar acá ──
 *
 * Todo lo que decide cuánto cobra un vendedor: la base de cada plan, los
 * escalones, los bonos de calidad y las reglas del período. Nada de esto vive
 * en código.
 *
 * ── Por qué la pantalla muestra la cuenta mientras se edita ──
 *
 * Porque un porcentaje solo no dice nada. "45 %" no permite decidir; "26 ventas
 * de tus planes = $170,82 de comisión y $6,57 de costo por cliente" sí. El
 * simulador completo es una fase posterior, pero la cuenta básica tiene que
 * estar acá o cada cambio es a ciegas.
 *
 * ── Guardar y versionar son dos cosas distintas ──
 *
 * Guardar corrige el esquema vigente —para un valor mal tipeado el mismo día—.
 * Crear versión cierra el actual y abre otro desde una fecha, que es lo único
 * que deja intactos los períodos ya cerrados. La pantalla lo dice así de
 * explícito porque la diferencia recién se entiende cuando alguien reclama.
 */
export default function ComisionesPage() {
  const { perfil, puede } = usePermisos()

  const [esquema, setEsquema] = useState(null)
  const [versiones, setVersiones] = useState([])
  const [motivos, setMotivos] = useState([])
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)
  const [guardado, setGuardado] = useState(false)
  const [versionando, setVersionando] = useState(false)
  const [nuevaV, setNuevaV] = useState({ nombre: '', desde: '' })

  // Copias editables. El estado original queda intacto para poder comparar.
  const [form, setForm] = useState(null)

  const soloLectura = !puede('comisiones.configurar')

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      const [e, v, m] = await Promise.all([
        comisionesApi.esquema(),
        comisionesApi.versiones(),
        comisionesApi.motivosBaja(),
      ])
      setEsquema(e)
      setVersiones(v)
      setMotivos(m)
      setForm(
        e
          ? {
              nombre: e.nombre,
              modo: e.modo,
              niveles: e.niveles.map((n) => ({ ...n })),
              bases: e.bases.map((b) => ({ ...b })),
              bonos: e.bonos.map((b) => ({ ...b })),
              reglas: Object.fromEntries(
                [
                  ...REQUISITOS.map((r) => r.campo),
                  'dia_cortesia_desde',
                  'pago_ventana_desde',
                  'pago_ventana_hasta',
                  'dia_cierre',
                  'dias_cohorte',
                  'min_clientes_cohorte',
                  'meses_sin_pago_suspension',
                  'meses_sin_pago_retiro',
                ].map((c) => [c, e[c]]),
              ),
            }
          : null,
      )
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  const editar = (grupo, id, campo, valor) =>
    setForm((f) => ({
      ...f,
      [grupo]: f[grupo].map((x) => ((x.id ?? x.plan_id) === id ? { ...x, [campo]: valor } : x)),
    }))

  const setRegla = (campo, valor) =>
    setForm((f) => ({ ...f, reglas: { ...f.reglas, [campo]: valor } }))

  /**
   * La base promedio de los planes que comisionan.
   *
   * Es la cifra con la que se puede razonar sobre el esquema sin tener ventas
   * cargadas todavía. Cuando el motor esté andando, la cuenta real usa la base
   * de cada venta.
   */
  const basePromedio = useMemo(() => {
    const activos = (form?.bases ?? []).filter((b) => b.comisiona)
    if (!activos.length) return 0
    return activos.reduce((t, b) => t + Number(b.base || 0), 0) / activos.length
  }, [form])

  const proyeccion = useMemo(() => {
    if (!form) return []
    return (form.niveles ?? []).map((n) => {
      const ventas = Number(n.desde_ventas) || 0
      const baseTotal = basePromedio * ventas
      const r = calcular({ niveles: form.niveles, modo: form.modo }, ventas, baseTotal)
      return {
        nivel: n.nombre,
        ventas,
        baseTotal,
        porcentaje: r.porcentaje,
        monto: r.monto,
        porCliente: ventas ? r.monto / ventas : 0,
      }
    })
  }, [form, basePromedio])

  const guardar = async () => {
    setGuardando(true)
    setGuardado(false)
    try {
      await comisionesApi.guardar(
        { id: esquema.id, nombre: form.nombre, modo: form.modo },
        form,
        perfil,
      )
      setGuardado(true)
      await cargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  const crearVersion = async () => {
    setGuardando(true)
    try {
      await comisionesApi.nuevaVersion(nuevaV, perfil)
      setVersionando(false)
      setNuevaV({ nombre: '', desde: '' })
      await cargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  if (cargando) return <Cargando texto="Cargando el esquema de comisiones…" />

  if (!esquema) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Volver />
        <ErrorBanner error={error} onCerrar={() => setError(null)} />
        <Aviso tipo="alerta">
          No hay ningún esquema de comisiones cargado. Corré{' '}
          <code className="font-mono">supabase/migracion-97-comisiones-configuracion.sql</code> en
          el SQL Editor.
        </Aviso>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Volver />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="t-titulo text-lg font-bold text-slate-100">Comisiones e incentivos</h1>
          <p className="text-xs text-slate-500">
            {esquema.nombre} · vigente desde {esquema.vigente_desde}
            {esquema.vigente_hasta ? ` hasta ${esquema.vigente_hasta}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* El simulador antes que guardar: conviene probar el cambio en el
              escenario real antes de aplicárselo a la gente. */}
          <ConPermiso permiso={['comisiones.simular', 'comisiones.configurar']} envezDe={null}>
            <Link to="/ajustes/comisiones/simulador">
              <Button icon={Calculator}>Simulador</Button>
            </Link>
          </ConPermiso>
          <ConPermiso permiso="comisiones.configurar" envezDe={null}>
            <Button icon={GitBranch} onClick={() => setVersionando(true)}>
              Crear versión
            </Button>
            <Button variante="primario" icon={Save} cargando={guardando} onClick={guardar}>
              Guardar cambios
            </Button>
          </ConPermiso>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />
      {guardado && <Aviso>Esquema actualizado. Queda registrado en la auditoría.</Aviso>}

      {soloLectura && (
        <Aviso>
          Podés ver el esquema pero no editarlo. Hace falta el permiso{' '}
          <code className="font-mono">comisiones.configurar</code>.
        </Aviso>
      )}

      {/* ── Modo de cálculo ─────────────────────────────────────────────── */}
      <Card
        title="Cómo se aplica el porcentaje"
        icon={Calculator}
        subtitle="Se puede cambiar sin reprogramar nada: es un dato, no dos motores distintos."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {Object.entries(MODOS).map(([k, v]) => (
            <button
              key={k}
              type="button"
              disabled={soloLectura}
              onClick={() => setForm((f) => ({ ...f, modo: k }))}
              className={`rounded-xl border p-3 text-left transition disabled:opacity-60 ${
                form.modo === k
                  ? 'border-sky-500/60 bg-sky-500/10'
                  : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'
              }`}
            >
              <p className="flex items-center gap-2 text-sm font-medium text-slate-100">
                {form.modo === k && <CircleCheck size={15} className="text-sky-400" />}
                {v.label}
              </p>
              <p className="mt-1 text-[12px] leading-snug text-slate-400">{v.ayuda}</p>
            </button>
          ))}
        </div>
      </Card>

      {/* ── Bases por plan ──────────────────────────────────────────────── */}
      <Card
        title="Base comisionable por plan"
        icon={BadgeDollarSign}
        subtitle="Lo que vale cada plan para el vendedor. Es independiente del precio y de las promociones: una promo del 50 % no baja la base."
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-2 py-2">Plan</th>
                <th className="px-2 py-2 text-right">Precio comercial</th>
                <th className="px-2 py-2 text-right">Base</th>
                <th className="px-2 py-2 text-right">% del precio</th>
                <th className="px-2 py-2">Comisiona</th>
              </tr>
            </thead>
            <tbody>
              {form.bases.map((b) => {
                const pct = Number(b.precio_comercial)
                  ? (Number(b.base) / Number(b.precio_comercial)) * 100
                  : null
                return (
                  <tr key={b.plan_id} className="border-b border-slate-800/60">
                    <td className="px-2 py-2">
                      <span className="text-slate-100">{b.plan}</span>
                      {!b.plan_activo && (
                        <Badge color="gris">
                          <span className="text-[10px]">plan inactivo</span>
                        </Badge>
                      )}
                      <p className="text-[11px] text-slate-500">
                        {Math.round(b.bajada_kbps / 1024)} Mbps
                      </p>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-400">
                      {dinero(b.precio_comercial)}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        disabled={soloLectura}
                        value={b.base ?? ''}
                        onChange={(e) => editar('bases', b.plan_id, 'base', e.target.value)}
                        className="w-24 text-right"
                      />
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-500">
                      {pct == null ? '—' : `${pct.toFixed(0)} %`}
                    </td>
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        disabled={soloLectura}
                        checked={!!b.comisiona}
                        onChange={(e) => editar('bases', b.plan_id, 'comisiona', e.target.checked)}
                        className="h-4 w-4 accent-sky-500"
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[12px] text-slate-500">
          Base promedio de los planes que comisionan: <b>{dinero(basePromedio)}</b>. Es la cifra con
          la que se calculan las proyecciones de abajo.
        </p>
      </Card>

      {/* ── Escalones ───────────────────────────────────────────────────── */}
      <Card
        title="Escalones"
        icon={Trophy}
        subtitle="Cuántas ventas válidas hacen falta para cada nivel, y qué porcentaje paga."
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-2 py-2">Nivel</th>
                <th className="px-2 py-2 text-right">Desde</th>
                <th className="px-2 py-2 text-right">Hasta</th>
                <th className="px-2 py-2 text-right">%</th>
              </tr>
            </thead>
            <tbody>
              {form.niveles.map((n) => (
                <tr key={n.id} className="border-b border-slate-800/60">
                  <td className="px-2 py-2">
                    <Input
                      disabled={soloLectura}
                      value={n.nombre}
                      onChange={(e) => editar('niveles', n.id, 'nombre', e.target.value)}
                      className="w-32"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Input
                      type="number"
                      min="0"
                      disabled={soloLectura}
                      value={n.desde_ventas ?? ''}
                      onChange={(e) => editar('niveles', n.id, 'desde_ventas', e.target.value)}
                      className="w-20 text-right"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Input
                      type="number"
                      min="0"
                      placeholder="sin techo"
                      disabled={soloLectura}
                      value={n.hasta_ventas ?? ''}
                      onChange={(e) => editar('niveles', n.id, 'hasta_ventas', e.target.value)}
                      className="w-24 text-right"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      disabled={soloLectura}
                      value={n.porcentaje ?? ''}
                      onChange={(e) => editar('niveles', n.id, 'porcentaje', e.target.value)}
                      className="w-20 text-right"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* La cuenta, mientras se edita. Un porcentaje solo no permite decidir. */}
        <div className="mt-4 t-panel p-3">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">
            Qué paga cada nivel, con la base promedio de {dinero(basePromedio)}
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] text-slate-500">
                  <th className="py-1 pr-3">Nivel</th>
                  <th className="py-1 pr-3 text-right">Ventas</th>
                  <th className="py-1 pr-3 text-right">Base total</th>
                  <th className="py-1 pr-3 text-right">Comisión</th>
                  <th className="py-1 text-right">Por cliente</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {proyeccion.map((p) => (
                  <tr key={p.nivel} className="border-t border-slate-800/60">
                    <td className="py-1.5 pr-3 text-slate-300">{p.nivel}</td>
                    <td className="py-1.5 pr-3 text-right text-slate-400">{p.ventas}</td>
                    <td className="py-1.5 pr-3 text-right text-slate-400">{dinero(p.baseTotal)}</td>
                    <td className="py-1.5 pr-3 text-right font-medium text-emerald-300">
                      {dinero(p.monto)}
                    </td>
                    <td className="py-1.5 text-right text-slate-400">{dinero(p.porCliente)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] leading-snug text-slate-500">
            "Por cliente" es tu costo comercial de adquisición por abonado en ese nivel. Es el número
            que conviene mirar antes de subir un porcentaje.
          </p>
        </div>
      </Card>

      {/* ── Bono de calidad ─────────────────────────────────────────────── */}
      <Card
        title="Bono de calidad de cartera"
        icon={Layers}
        subtitle="Se paga por cohorte, según cuántos clientes de ese grupo siguen andando al final del período de seguimiento."
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-2 py-2 text-right">Calidad desde</th>
                <th className="px-2 py-2 text-right">Hasta</th>
                <th className="px-2 py-2 text-right">Bono</th>
              </tr>
            </thead>
            <tbody>
              {form.bonos.map((b) => (
                <tr key={b.id} className="border-b border-slate-800/60">
                  <td className="px-2 py-2 text-right">
                    <Input
                      type="number"
                      step="0.01"
                      disabled={soloLectura}
                      value={b.desde_pct ?? ''}
                      onChange={(e) => editar('bonos', b.id, 'desde_pct', e.target.value)}
                      className="w-24 text-right"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Input
                      type="number"
                      step="0.01"
                      disabled={soloLectura}
                      value={b.hasta_pct ?? ''}
                      onChange={(e) => editar('bonos', b.id, 'hasta_pct', e.target.value)}
                      className="w-24 text-right"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      disabled={soloLectura}
                      value={b.monto ?? ''}
                      onChange={(e) => editar('bonos', b.id, 'monto', e.target.value)}
                      className="w-24 text-right"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field
            label="Días de seguimiento de la cohorte"
            hint="Cuánto se espera antes de medir la calidad de un grupo de ventas."
          >
            <Input
              type="number"
              min="30"
              max="365"
              disabled={soloLectura}
              value={form.reglas.dias_cohorte ?? ''}
              onChange={(e) => setRegla('dias_cohorte', e.target.value)}
            />
          </Field>
          <Field
            label="Mínimo de clientes evaluables"
            hint="Con menos que esto no se calcula bono: dos bajas sobre tres ventas darían 33 % y no significa nada."
          >
            <Input
              type="number"
              min="0"
              disabled={soloLectura}
              value={form.reglas.min_clientes_cohorte ?? ''}
              onChange={(e) => setRegla('min_clientes_cohorte', e.target.value)}
            />
          </Field>
        </div>
      </Card>

      {/* ── Reglas del período ──────────────────────────────────────────── */}
      <Card
        title="Cuándo una venta comisiona"
        subtitle="Cada requisito se enciende cuando el módulo que lo alimenta tiene datos reales. Encender uno no afecta períodos ya cerrados."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {REQUISITOS.map((r) => (
            <label
              key={r.campo}
              className="flex cursor-pointer items-start gap-2.5 t-card-sm p-2.5"
            >
              <input
                type="checkbox"
                disabled={soloLectura}
                checked={!!form.reglas[r.campo]}
                onChange={(e) => setRegla(r.campo, e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-sky-500"
              />
              <div className="min-w-0">
                <p className="text-[13px] text-slate-200">{r.label}</p>
                {r.ayuda && <p className="text-[11px] leading-snug text-slate-500">{r.ayuda}</p>}
              </div>
            </label>
          ))}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Cortesía desde el día" hint="Instalado de acá en adelante, el pago se espera el mes siguiente.">
            <Input
              type="number"
              min="1"
              max="31"
              disabled={soloLectura}
              value={form.reglas.dia_cortesia_desde ?? ''}
              onChange={(e) => setRegla('dia_cortesia_desde', e.target.value)}
            />
          </Field>
          <Field label="Ventana de pago: desde">
            <Input
              type="number"
              min="1"
              max="31"
              disabled={soloLectura}
              value={form.reglas.pago_ventana_desde ?? ''}
              onChange={(e) => setRegla('pago_ventana_desde', e.target.value)}
            />
          </Field>
          <Field label="hasta">
            <Input
              type="number"
              min="1"
              max="31"
              disabled={soloLectura}
              value={form.reglas.pago_ventana_hasta ?? ''}
              onChange={(e) => setRegla('pago_ventana_hasta', e.target.value)}
            />
          </Field>
          <Field label="Día de cierre" hint="Del mes siguiente. No el último día del mes.">
            <Input
              type="number"
              min="1"
              max="28"
              disabled={soloLectura}
              value={form.reglas.dia_cierre ?? ''}
              onChange={(e) => setRegla('dia_cierre', e.target.value)}
            />
          </Field>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Períodos sin pago para suspender">
            <Input
              type="number"
              min="1"
              disabled={soloLectura}
              value={form.reglas.meses_sin_pago_suspension ?? ''}
              onChange={(e) => setRegla('meses_sin_pago_suspension', e.target.value)}
            />
          </Field>
          <Field label="Períodos sin pago para retirar el equipo">
            <Input
              type="number"
              min="2"
              disabled={soloLectura}
              value={form.reglas.meses_sin_pago_retiro ?? ''}
              onChange={(e) => setRegla('meses_sin_pago_retiro', e.target.value)}
            />
          </Field>
        </div>

        {!form.reglas.requiere_primer_pago && (
          <Aviso tipo="alerta">
            El requisito de <b>primer pago</b> está apagado. Es lo correcto mientras no haya cobros
            cargados —encenderlo hoy dejaría a todos los vendedores en cero— pero acordate de
            prenderlo cuando facturación esté operando.
          </Aviso>
        )}
      </Card>

      {/* ── Motivos de baja ─────────────────────────────────────────────── */}
      <MotivosBaja
        motivos={motivos}
        soloLectura={soloLectura}
        onGuardado={cargar}
        onError={setError}
      />

      {/* ── Versiones ───────────────────────────────────────────────────── */}
      <Card
        title="Versiones"
        icon={History}
        subtitle="Cada período cerrado guarda con qué versión se pagó. Cambiar reglas crea una nueva; no reescribe las viejas."
      >
        <div className="space-y-1.5">
          {versiones.map((v) => (
            <div
              key={v.id}
              className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${
                v.activo ? 'border-sky-500/40 bg-sky-500/5' : 'border-slate-800 bg-slate-900/40'
              }`}
            >
              <div className="min-w-0">
                <p className="truncate text-[13px] text-slate-200">{v.nombre}</p>
                <p className="text-[11px] text-slate-500">
                  {v.vigente_desde} → {v.vigente_hasta ?? 'sin fin'} ·{' '}
                  {MODOS[v.modo]?.label ?? v.modo} · {v.niveles} niveles · bono máximo{' '}
                  {dinero(v.bono_maximo)}
                </p>
              </div>
              {v.activo && <Badge color="azul">vigente</Badge>}
            </div>
          ))}
        </div>
      </Card>

      {/* ── Revisión y auditoría ────────────────────────────────────────── */}
      <Revision />
      <Auditoria />

      <Modal
        abierto={versionando}
        titulo="Crear una versión nueva"
        onCerrar={() => setVersionando(false)}
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-400">
            El esquema actual se cierra el día anterior y el nuevo arranca copiando todos sus
            valores. Los períodos ya cerrados siguen apuntando al suyo: no cambian.
          </p>
          <Field label="Nombre">
            <Input
              value={nuevaV.nombre}
              onChange={(e) => setNuevaV((v) => ({ ...v, nombre: e.target.value }))}
              placeholder="Plan de comisiones 2027 — V1"
            />
          </Field>
          <Field label="Vigente desde" hint="Tiene que ser posterior al inicio de la versión actual.">
            <Input
              type="date"
              value={nuevaV.desde}
              onChange={(e) => setNuevaV((v) => ({ ...v, desde: e.target.value }))}
            />
          </Field>
          <div className="flex gap-2">
            <Button
              variante="primario"
              icon={GitBranch}
              cargando={guardando}
              disabled={!nuevaV.nombre.trim() || !nuevaV.desde}
              onClick={crearVersion}
              className="flex-1"
            >
              Crear versión
            </Button>
            <Button onClick={() => setVersionando(false)} disabled={guardando}>
              Cancelar
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function Volver() {
  return (
    <Link
      to="/ajustes"
      className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200"
    >
      <ArrowLeft size={16} /> Configuración
    </Link>
  )
}

/**
 * La revisión del módulo.
 *
 * ── Por qué es un botón y no algo que corre solo ──
 *
 * Porque son trece consultas que recorren comisiones, cohortes y equipos, y no
 * hay ninguna razón para pagarlas cada vez que alguien abre la configuración a
 * mirar un porcentaje. Se corre cuando importa: antes de aprobar el mes, después
 * de cambiar reglas, o cuando algo no cuadra.
 */
function Revision() {
  const [filas, setFilas] = useState(null)
  const [corriendo, setCorriendo] = useState(false)
  const [error, setError] = useState(null)

  async function correr() {
    setCorriendo(true)
    setError(null)
    try {
      setFilas(await comisionesApi.verificar())
    } catch (err) {
      setError(err)
    } finally {
      setCorriendo(false)
    }
  }

  // Las columnas llegan con prefijo `res_`: la función las nombra así para que un
// parámetro de salida no tape una columna `estado` de las tablas que revisa.
  const problemas = filas?.filter((f) => f.res_estado !== 'ok').length ?? 0

  return (
    <Card
      title="Revisión del módulo"
      icon={ShieldCheck}
      subtitle="Duplicados, cierres que no cuadran, bonos sin liquidar, firmas que faltan y equipos recuperados que no volvieron al stock."
      actions={
        <Button icon={ShieldCheck} cargando={corriendo} onClick={correr}>
          Revisar ahora
        </Button>
      }
    >
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {!filas && !error && (
        <p className="text-sm text-slate-500">
          Sin correr todavía. Conviene hacerlo antes de aprobar las liquidaciones del mes.
        </p>
      )}

      {filas && (
        <>
          <Aviso tipo={problemas ? 'alerta' : 'info'}>
            {problemas === 0
              ? `Las ${filas.length} pruebas pasaron.`
              : `${problemas} de ${filas.length} pruebas piden revisión. Ninguna bloquea nada: son señales, no errores del sistema.`}
          </Aviso>

          <div className="mt-3 space-y-1.5">
            {filas.map((f) => (
              <div
                key={f.res_prueba}
                className={`flex flex-wrap items-start justify-between gap-2 rounded-lg border px-3 py-2 ${
                  f.res_estado === 'ok'
                    ? 'border-slate-800 bg-slate-900/40'
                    : 'border-amber-600/40 bg-amber-500/5'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-slate-200">{f.res_prueba}</p>
                  <p className="text-[11px] leading-snug text-slate-500">{f.res_detalle}</p>
                </div>
                <Badge color={f.res_estado === 'ok' ? 'verde' : 'ambar'}>
                  {f.res_estado === 'ok' ? 'ok' : `${f.res_casos} para revisar`}
                </Badge>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  )
}

/**
 * El rastro de lo que pasó.
 *
 * Junta las dos capas: los cambios de reglas que registran los disparadores de
 * la base —imposibles de saltear— y las acciones que registran las funciones
 * —validar, cerrar, aprobar, pagar, anular—. Es el punto 26 en pantalla.
 */
function Auditoria() {
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)

  useEffect(() => {
    comisionesApi
      .auditoria({ limite: 30 })
      .then(setFilas)
      .catch(() => setFilas([]))
      .finally(() => setCargando(false))
  }, [])

  if (cargando) return null

  return (
    <Card
      title="Últimos movimientos"
      icon={History}
      subtitle="Quién cambió qué, cuándo y con qué valores. No se puede editar ni borrar."
    >
      {filas.length === 0 ? (
        <p className="text-sm text-slate-500">
          Sin movimientos registrados todavía, o sin permiso para verlos.
        </p>
      ) : (
        <div className="space-y-1.5">
          {filas.map((a) => (
            <div key={a.id} className="t-card-sm px-3 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[13px] text-slate-200">{a.descripcion}</p>
                <p className="text-[11px] text-slate-500">
                  {String(a.creado_en).slice(0, 16).replace('T', ' ')} · {a.usuario_nombre}
                </p>
              </div>
              {a.campos && (
                <p className="mt-1 font-mono text-[11px] leading-snug text-slate-400">
                  {Object.entries(a.campos).map(([campo, [antes, despues]]) => (
                    <span key={campo} className="mr-3 inline-block">
                      {campo}: <span className="text-slate-500">{String(antes ?? '—')}</span> →{' '}
                      <span className="text-slate-200">{String(despues ?? '—')}</span>
                    </span>
                  ))}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------

/**
 * Los motivos de baja, editables.
 *
 * ── Por qué esto vive en la pantalla de comisiones ──
 *
 * Porque acá es donde importan. Un motivo de baja parece un dato del abonado,
 * pero lo que decide es plata de otro: si le cuenta al vendedor en la calidad
 * de su cohorte, y con eso su bono. Ponerlo junto a los escalones y los bonos
 * es lo que hace evidente que cambiar una casilla acá cambia lo que alguien
 * cobra.
 *
 * ── Por qué se desactivan y no se borran ──
 *
 * Porque las fichas ya dadas de baja apuntan a su motivo. Borrar uno dejaría
 * bajas viejas sin explicación, y la explicación es justamente lo que se le
 * muestra al vendedor cuando reclama. Desactivar lo saca de la lista para las
 * bajas nuevas y no toca la historia.
 */
function MotivosBaja({ motivos, soloLectura, onGuardado, onError }) {
  const [editando, setEditando] = useState(null)
  const [guardando, setGuardando] = useState(false)

  const guardar = async (motivo) => {
    setGuardando(true)
    try {
      await comisionesApi.guardarMotivo(motivo)
      setEditando(null)
      await onGuardado()
    } catch (err) {
      onError(err)
    } finally {
      setGuardando(false)
    }
  }

  const activos = motivos.filter((m) => m.activo)
  const inactivos = motivos.filter((m) => !m.activo)

  return (
    <>
      <Card
        title="Motivos de baja"
        subtitle="Cuáles le cuentan al vendedor en la calidad de su cohorte y cuáles no."
        actions={
          !soloLectura && (
            <Button
              icon={Plus}
              onClick={() =>
                setEditando({ nombre: '', afecta_calidad: true, activo: true, orden: 99 })
              }
            >
              Nuevo motivo
            </Button>
          )
        }
      >
        <div className="grid gap-1.5 sm:grid-cols-2">
          {activos.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-2 t-card-sm px-3 py-2"
            >
              <span className="min-w-0 truncate text-[13px] text-slate-200" title={m.nombre}>
                {m.nombre}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                {/* La etiqueta ES el interruptor: es lo unico que se cambia
                    seguido, y abrir un dialogo para tocar una casilla sobra. */}
                <button
                  type="button"
                  disabled={soloLectura}
                  onClick={() => guardar({ id: m.id, afecta_calidad: !m.afecta_calidad })}
                  title={soloLectura ? undefined : 'Cambiar si le cuenta al vendedor'}
                  className={soloLectura ? '' : 'cursor-pointer'}
                >
                  <Badge color={m.afecta_calidad ? 'ambar' : 'verde'}>
                    {m.afecta_calidad ? 'afecta calidad' : 'no le cuenta'}
                  </Badge>
                </button>
                {!soloLectura && (
                  <Button
                    variante="fantasma"
                    icon={Pencil}
                    title="Editar"
                    onClick={() => setEditando(m)}
                  />
                )}
              </div>
            </div>
          ))}
        </div>

        {inactivos.length > 0 && (
          <div className="mt-3 border-t border-slate-800 pt-2">
            <p className="mb-1 text-[11px] text-slate-500">
              Desactivados — no se ofrecen para bajas nuevas, pero las fichas que ya los usan los
              siguen mostrando:
            </p>
            <div className="flex flex-wrap gap-1">
              {inactivos.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  disabled={soloLectura}
                  onClick={() => guardar({ id: m.id, activo: true })}
                  className="rounded-md bg-slate-800 px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200"
                  title="Volver a activarlo"
                >
                  {m.nombre}
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="mt-3 text-[12px] text-slate-500">
          Que un abonado se mude fuera de cobertura o que la empresa no haya podido sostener el
          servicio no es culpa de quien vendió. Sin esta distinción, el bono terminaría castigando a
          quien vende en las zonas más difíciles.
        </p>
      </Card>

      <FormularioMotivo
        motivo={editando}
        guardando={guardando}
        onCerrar={() => setEditando(null)}
        onGuardar={guardar}
      />
    </>
  )
}

function FormularioMotivo({ motivo, guardando, onCerrar, onGuardar }) {
  const [form, setForm] = useState({ nombre: '', afecta_calidad: true, activo: true })

  useEffect(() => {
    if (motivo) setForm({ ...motivo })
  }, [motivo])

  return (
    <Modal
      abierto={Boolean(motivo)}
      titulo={motivo?.id ? 'Editar el motivo' : 'Nuevo motivo de baja'}
      onCerrar={onCerrar}
    >
      <div className="space-y-3">
        <Field label="Nombre" hint="Es lo que se lee en la ficha del abonado dentro de un año">
          <Input
            value={form.nombre ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))}
            placeholder="Se mudó sin avisar y no devolvió el equipo"
          />
        </Field>

        <label className="flex cursor-pointer items-start gap-2 t-panel p-3">
          <input
            type="checkbox"
            checked={Boolean(form.afecta_calidad)}
            onChange={(e) => setForm((f) => ({ ...f, afecta_calidad: e.target.checked }))}
            className="mt-0.5 accent-sky-500"
          />
          <span className="text-xs text-slate-300">
            Le cuenta al vendedor en la calidad de su cohorte
            <span className="mt-0.5 block text-[11px] text-slate-500">
              Marcalo cuando la pérdida tenga que ver con la venta —abandono temprano, nunca pagó,
              documentación irregular—. Dejalo sin marcar cuando no sea culpa de quien vendió: una
              mudanza fuera de cobertura, un problema de la empresa, un fallecimiento.
            </span>
          </span>
        </label>

        {motivo?.id && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={Boolean(form.activo)}
              onChange={(e) => setForm((f) => ({ ...f, activo: e.target.checked }))}
              className="accent-sky-500"
            />
            Se ofrece para bajas nuevas
          </label>
        )}

        <Aviso>
          Cambiar si un motivo afecta la calidad no reescribe las cohortes ya cerradas. Se aplica
          desde la próxima evaluación —y al instante en las bajas que se hagan de ahora en más—.
        </Aviso>

        <div className="flex justify-end gap-2">
          <Button variante="secundario" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variante="primario"
            onClick={() => onGuardar(form)}
            cargando={guardando}
            disabled={!form.nombre?.trim()}
          >
            Guardar
          </Button>
        </div>
      </div>
    </Modal>
  )
}
