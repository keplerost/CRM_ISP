import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  Calculator,
  Check,
  Layers,
  Plus,
  RefreshCw,
  Trash2,
  Trophy,
  Users,
  Wallet,
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
  Stat,
  Table,
} from '../../components/ui'
import { usePermisos } from '../../lib/AuthContext'
import { dineroCero as dinero } from '../../lib/formato'
import { MODOS, comisionesApi } from '../../lib/comisiones'
import { escenarioReal, simular } from '../../lib/simulador'

/**
 * Simulador de comisiones.
 *
 * ── Para qué existe ──
 *
 * Para poder contestar "¿y si pago 50 % desde las 31 ventas?" antes de
 * prometérselo a nadie. Un esquema de incentivos se define una vez y después se
 * paga todos los meses: equivocarse en un porcentaje cuesta plata durante un año
 * y corregirlo hacia abajo es una conversación muy mala.
 *
 * ── Lo que NO hace ──
 *
 * Tocar la configuración. Se puede mover todo, probar veinte combinaciones y
 * cerrar la pantalla: no queda nada. La única puerta a la realidad es "Aplicar
 * configuración", que crea una versión nueva con su auditoría — y está detrás de
 * `comisiones.configurar`, no de `comisiones.simular`.
 *
 * ── Por qué compara contra el esquema vigente ──
 *
 * Porque un total suelto no permite decidir. "$1.842" no dice nada; "$1.842, o
 * $310 más que hoy, y el costo por cliente sube de $12,40 a $14,80" sí. El
 * escenario se corre dos veces —con las reglas editadas y con las de verdad— y
 * lo que se muestra es la diferencia.
 */

const VACIO = { nombre: '', ventas: 15, calidad: 90 }

export default function SimuladorComisionesPage() {
  const { perfil, puede } = usePermisos()
  const puedeAplicar = puede('comisiones.configurar')

  const [esquema, setEsquema] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [aviso, setAviso] = useState(null)

  // ── El escenario ──
  const [vendedores, setVendedores] = useState([])
  const [mezcla, setMezcla] = useState([])
  const [esReal, setEsReal] = useState(false)
  const [lote, setLote] = useState({ cantidad: 4, ventas: 15 })

  // ── Las reglas editadas ──
  const [modo, setModo] = useState('retroactivo')
  const [niveles, setNiveles] = useState([])
  const [bonos, setBonos] = useState([])
  const [minClientes, setMinClientes] = useState(10)

  const [aplicando, setAplicando] = useState(null)
  const [guardando, setGuardando] = useState(false)

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      const periodo = `${new Date().toISOString().slice(0, 7)}-01`
      const [esq, equipo, planes] = await Promise.all([
        comisionesApi.esquema(),
        // Las dos piden `comisiones.ver_todas`. Sin el permiso vienen vacías y el
        // simulador arranca con un escenario de ejemplo: se puede usar igual.
        comisionesApi.equipo({ periodo }).catch(() => []),
        comisionesApi.porPlan({ periodo }).catch(() => []),
      ])

      if (!esq) {
        setError(new Error('No hay un esquema de comisiones vigente para simular.'))
        return
      }

      setEsquema(esq)
      setModo(esq.modo)
      setNiveles(esq.niveles.map((n) => ({ ...n })))
      setBonos(esq.bonos.map((b) => ({ ...b })))
      setMinClientes(esq.min_clientes_cohorte ?? 10)

      const real = escenarioReal({ equipo, planes, bases: esq.bases })
      setEsReal(real.real)
      setMezcla(real.mezcla.length ? real.mezcla : [])
      setVendedores(
        real.vendedores.length
          ? real.vendedores
          : Array.from({ length: 4 }, (_, i) => ({ ...VACIO, nombre: `Vendedor ${i + 1}` })),
      )

      // Sin ventas reales, la mezcla arranca repartida en partes iguales: es
      // menos falso que poner todo en un plan elegido por orden alfabético.
      if (!real.real && real.mezcla.length) {
        const parejo = Math.round(100 / real.mezcla.length)
        setMezcla(real.mezcla.map((m) => ({ ...m, pct: parejo })))
      }

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

  // ── Los dos escenarios: el editado y el que rige hoy ──
  const editado = useMemo(
    () => simular({ modo, niveles, bonos, minClientes, mezcla, vendedores }),
    [modo, niveles, bonos, minClientes, mezcla, vendedores],
  )

  const vigente = useMemo(() => {
    if (!esquema) return null
    // Mismo escenario, reglas de verdad: incluida la base de cada plan, que es
    // lo que más se toca en el simulador.
    const mezclaReal = mezcla.map((m) => ({
      ...m,
      base: Number(esquema.bases.find((b) => b.plan_id === m.plan_id)?.base ?? m.base),
    }))
    return simular({
      modo: esquema.modo,
      niveles: esquema.niveles,
      bonos: esquema.bonos,
      minClientes: esquema.min_clientes_cohorte,
      mezcla: mezclaReal,
      vendedores,
    })
  }, [esquema, mezcla, vendedores])

  const delta = useMemo(() => {
    if (!vigente) return null
    return {
      total: editado.totales.total - vigente.totales.total,
      porCliente: editado.totales.porCliente - vigente.totales.porCliente,
    }
  }, [editado, vigente])

  const sumaMezcla = mezcla.reduce((t, m) => t + (Number(m.pct) || 0), 0)

  const setFila = (setter) => (i, campo, valor) =>
    setter((filas) => filas.map((f, j) => (j === i ? { ...f, [campo]: valor } : f)))

  const setVendedor = setFila(setVendedores)
  const setMezclaFila = setFila(setMezcla)
  const setNivel = setFila(setNiveles)
  const setBono = setFila(setBonos)

  /** Rehace el equipo con N vendedores parejos. Sirve para tantear rápido. */
  function rehacerEquipo() {
    setVendedores(
      Array.from({ length: Math.max(1, Number(lote.cantidad) || 1) }, (_, i) => ({
        nombre: `Vendedor ${i + 1}`,
        ventas: Number(lote.ventas) || 0,
        calidad: 90,
      })),
    )
    setEsReal(false)
  }

  async function aplicar(e) {
    e.preventDefault()
    setGuardando(true)
    try {
      await comisionesApi.aplicarSimulacion(
        {
          nombre: aplicando.nombre,
          desde: aplicando.desde,
          modo,
          niveles,
          bonos,
          mezcla,
          minClientes,
        },
        perfil,
      )
      setAplicando(null)
      setAviso('Configuración aplicada como versión nueva. Los períodos cerrados no se tocaron.')
      await cargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  if (cargando) return <Cargando texto="Cargando el esquema…" />

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Link
        to="/ajustes/comisiones"
        className="inline-flex items-center gap-1 text-sm text-slate-400"
      >
        <ArrowLeft size={15} /> Volver a Comisiones e incentivos
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Simulador de comisiones</h1>
          <p className="mt-0.5 max-w-3xl text-xs leading-snug text-slate-500">
            Mové lo que quieras: nada de esto toca la configuración hasta que la apliques. Los
            números se recalculan solos.
          </p>
        </div>
        <div className="flex gap-2">
          <Button icon={RefreshCw} onClick={cargar}>
            Reiniciar
          </Button>
          {puedeAplicar && (
            <Button
              variante="primario"
              icon={Check}
              onClick={() =>
                setAplicando({
                  nombre: `Plan de comisiones ${new Date().getFullYear()} — ajuste`,
                  desde: new Date().toISOString().slice(0, 10),
                })
              }
            >
              Aplicar configuración
            </Button>
          )}
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />
      {aviso && <Aviso>{aviso}</Aviso>}

      {!esReal && (
        <Aviso tipo="alerta">
          Este escenario es un ejemplo, no el mes real: todavía no hay ventas comisionables
          suficientes para armarlo con datos propios. Ajustá el equipo y la mezcla a lo que esperás.
        </Aviso>
      )}

      {/* ------------------------------------------------- El resultado */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Costo total de incentivos"
          valor={dinero(editado.totales.total)}
          sub={
            delta
              ? `${delta.total >= 0 ? '+' : ''}${dinero(delta.total)} vs el esquema vigente`
              : undefined
          }
          icon={Wallet}
          color="text-amber-400"
        />
        <Stat
          label="Comisión comercial"
          valor={dinero(editado.totales.comision)}
          sub={`${editado.totales.ventas} ventas · base ${dinero(editado.promedio)} promedio`}
          icon={Calculator}
          color="text-sky-400"
        />
        <Stat
          label="Bonos de calidad"
          valor={dinero(editado.totales.bono)}
          sub={`${editado.filas.filter((f) => f.bono > 0).length} de ${
            editado.filas.length
          } vendedores lo alcanzan`}
          icon={Trophy}
          color="text-violet-400"
        />
        <Stat
          label="Costo por cliente adquirido"
          valor={dinero(editado.totales.porCliente)}
          sub={
            delta
              ? `${delta.porCliente >= 0 ? '+' : ''}${dinero(delta.porCliente)} vs hoy`
              : undefined
          }
          icon={Users}
          color="text-emerald-400"
        />
      </div>

      <Card title="Comisión por vendedor" icon={Users}>
        <Table
          columnas={['Vendedor', 'Ventas', 'Calidad', 'Nivel', 'Comisión', 'Bono', 'Total', '']}
          filas={editado.filas}
          vacio="Agregá al menos un vendedor."
          renderFila={(f, i) => (
            <tr key={f.id}>
              <td className="px-3 py-1.5">
                <Input
                  value={vendedores[i]?.nombre ?? ''}
                  onChange={(e) => setVendedor(i, 'nombre', e.target.value)}
                  className="w-36"
                />
              </td>
              <td className="px-3 py-1.5">
                <Input
                  type="number"
                  min="0"
                  value={vendedores[i]?.ventas ?? 0}
                  onChange={(e) => setVendedor(i, 'ventas', e.target.value)}
                  className="w-20"
                />
              </td>
              <td className="px-3 py-1.5">
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={vendedores[i]?.calidad ?? 0}
                  onChange={(e) => setVendedor(i, 'calidad', e.target.value)}
                  className="w-20"
                />
              </td>
              <td className="px-3 py-1.5">
                {f.nivel ? (
                  <Badge color="azul">
                    {f.nivel} · {f.porcentaje} %
                  </Badge>
                ) : (
                  <span className="text-xs text-slate-500">sin nivel</span>
                )}
              </td>
              <td className="px-3 py-1.5 text-slate-300">{dinero(f.comision)}</td>
              <td className="px-3 py-1.5 text-slate-300">{dinero(f.bono)}</td>
              <td className="px-3 py-1.5 font-semibold text-slate-100">{dinero(f.total)}</td>
              <td className="px-3 py-1.5 text-right">
                <Button
                  variante="fantasma"
                  icon={Trash2}
                  onClick={() => setVendedores((v) => v.filter((_, j) => j !== i))}
                />
              </td>
            </tr>
          )}
        />

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Button
            icon={Plus}
            onClick={() => setVendedores((v) => [...v, { ...VACIO, nombre: `Vendedor ${v.length + 1}` }])}
          >
            Agregar vendedor
          </Button>

          <div className="flex items-end gap-2">
            <Field label="Equipo parejo" className="w-24">
              <Input
                type="number"
                min="1"
                value={lote.cantidad}
                onChange={(e) => setLote((l) => ({ ...l, cantidad: e.target.value }))}
              />
            </Field>
            <Field label="Ventas cada uno" className="w-28">
              <Input
                type="number"
                min="0"
                value={lote.ventas}
                onChange={(e) => setLote((l) => ({ ...l, ventas: e.target.value }))}
              />
            </Field>
            <Button onClick={rehacerEquipo}>Rehacer</Button>
          </div>
        </div>
      </Card>

      {/* ------------------------------------------------- Mezcla de planes */}
      <Card
        title="Mezcla de planes"
        subtitle="Qué se vende y cuánto vale para el vendedor cada uno"
        icon={Layers}
      >
        <Table
          columnas={['Plan', 'Base comisionable', 'Participación']}
          filas={mezcla}
          vacio="El esquema no tiene ningún plan con base comisionable."
          renderFila={(m, i) => (
            <tr key={m.plan_id}>
              <td className="px-3 py-1.5 text-slate-200">{m.nombre}</td>
              <td className="px-3 py-1.5">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={m.base}
                  onChange={(e) => setMezclaFila(i, 'base', e.target.value)}
                  className="w-24"
                />
              </td>
              <td className="px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={m.pct}
                    onChange={(e) => setMezclaFila(i, 'pct', e.target.value)}
                    className="w-20"
                  />
                  <span className="text-xs text-slate-500">%</span>
                </div>
              </td>
            </tr>
          )}
        />
        <p className="mt-2 text-[11px] text-slate-500">
          {sumaMezcla === 100
            ? 'La participación suma 100 %.'
            : `La participación suma ${sumaMezcla} %. No hace falta que dé 100: se toma como proporción.`}{' '}
          Base promedio de una venta: <strong className="text-slate-300">{dinero(editado.promedio)}</strong>.
        </p>
      </Card>

      {/* ------------------------------------------------- Reglas */}
      <Card
        title="Escalones"
        subtitle="Rangos y porcentajes. Cambiarlos acá no toca la configuración."
        icon={Trophy}
        actions={
          <Select value={modo} onChange={(e) => setModo(e.target.value)} className="w-52">
            {Object.entries(MODOS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        }
      >
        <p className="mb-3 text-[11px] leading-snug text-slate-500">{MODOS[modo]?.ayuda}</p>

        {modo === 'progresivo' && (
          <Aviso>
            En progresivo, el simulador reparte los tramos usando la base promedio de la mezcla. El
            motor usa la base real de cada venta según el orden en que se volvieron comisionables, así
            que el total del mes puede diferir por centavos cuando se mezclan planes de valor muy
            distinto. El nivel y el porcentaje son los mismos.
          </Aviso>
        )}
        <Table
          columnas={['Nivel', 'Desde', 'Hasta', 'Porcentaje']}
          filas={niveles}
          vacio="El esquema no tiene escalones cargados."
          renderFila={(n, i) => (
            <tr key={n.id}>
              <td className="px-3 py-1.5 text-slate-200">{n.nombre}</td>
              <td className="px-3 py-1.5">
                <Input
                  type="number"
                  min="0"
                  value={n.desde_ventas ?? ''}
                  onChange={(e) => setNivel(i, 'desde_ventas', e.target.value)}
                  className="w-20"
                />
              </td>
              <td className="px-3 py-1.5">
                <Input
                  type="number"
                  min="0"
                  value={n.hasta_ventas ?? ''}
                  onChange={(e) => setNivel(i, 'hasta_ventas', e.target.value)}
                  placeholder="sin techo"
                  className="w-24"
                />
              </td>
              <td className="px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={n.porcentaje ?? ''}
                    onChange={(e) => setNivel(i, 'porcentaje', e.target.value)}
                    className="w-24"
                  />
                  <span className="text-xs text-slate-500">%</span>
                </div>
              </td>
            </tr>
          )}
        />
      </Card>

      <Card
        title="Bono de calidad"
        subtitle="Cuánto se paga según la retención de la cohorte"
        icon={Trophy}
        actions={
          <Field label="Mínimo de clientes" className="w-32">
            <Input
              type="number"
              min="0"
              value={minClientes}
              onChange={(e) => setMinClientes(e.target.value)}
            />
          </Field>
        }
      >
        <Table
          columnas={['Desde', 'Hasta', 'Bono']}
          filas={bonos}
          vacio="El esquema no tiene tramos de bono."
          renderFila={(b, i) => (
            <tr key={b.id}>
              <td className="px-3 py-1.5">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={b.desde_pct ?? ''}
                  onChange={(e) => setBono(i, 'desde_pct', e.target.value)}
                  className="w-24"
                />
              </td>
              <td className="px-3 py-1.5">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={b.hasta_pct ?? ''}
                  onChange={(e) => setBono(i, 'hasta_pct', e.target.value)}
                  className="w-24"
                />
              </td>
              <td className="px-3 py-1.5">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={b.monto ?? ''}
                  onChange={(e) => setBono(i, 'monto', e.target.value)}
                  className="w-24"
                />
              </td>
            </tr>
          )}
        />
        <p className="mt-2 text-[11px] leading-snug text-slate-500">
          Con menos de {minClientes || 0} clientes evaluables el bono es cero aunque la calidad sea
          del 100 %. Es lo que evita que el bono premie a quien vendió tres.
        </p>
      </Card>

      {/* ------------------------------------------------- Comparación */}
      {vigente && (
        <Card title="Contra el esquema vigente" subtitle={esquema.nombre} icon={Calculator}>
          <Table
            columnas={['', 'Vigente', 'Simulado', 'Diferencia']}
            filas={[
              ['Comisión comercial', vigente.totales.comision, editado.totales.comision],
              ['Bonos', vigente.totales.bono, editado.totales.bono],
              ['Costo total', vigente.totales.total, editado.totales.total],
              ['Por cliente', vigente.totales.porCliente, editado.totales.porCliente],
            ]}
            vacio=""
            renderFila={([label, a, b]) => (
              <tr key={label}>
                <td className="px-3 py-2 text-slate-400">{label}</td>
                <td className="px-3 py-2 text-slate-300">{dinero(a)}</td>
                <td className="px-3 py-2 font-medium text-slate-100">{dinero(b)}</td>
                <td
                  className={`px-3 py-2 font-medium ${
                    b - a > 0 ? 'text-amber-300' : b - a < 0 ? 'text-emerald-300' : 'text-slate-500'
                  }`}
                >
                  {b - a > 0 ? '+' : ''}
                  {dinero(b - a)}
                </td>
              </tr>
            )}
          />
          <p className="mt-2 text-[11px] leading-snug text-slate-500">
            Las dos columnas usan el MISMO escenario: la diferencia es solo de reglas, no de ventas.
          </p>
        </Card>
      )}

      {/* ------------------------------------------------- Aplicar */}
      <Modal
        abierto={Boolean(aplicando)}
        titulo="Aplicar como versión nueva"
        onCerrar={() => setAplicando(null)}
      >
        {aplicando && (
          <form onSubmit={aplicar} className="space-y-4">
            <Field label="Nombre de la versión">
              <Input
                value={aplicando.nombre}
                onChange={(e) => setAplicando((a) => ({ ...a, nombre: e.target.value }))}
                required
              />
            </Field>
            <Field label="Vigente desde" hint="El esquema actual se cierra el día anterior">
              <Input
                type="date"
                value={aplicando.desde}
                onChange={(e) => setAplicando((a) => ({ ...a, desde: e.target.value }))}
                required
              />
            </Field>

            <Aviso tipo="alerta">
              Se crea una versión nueva con estos valores. Los períodos ya cerrados conservan las
              reglas con las que se pagaron: no se recalcula nada hacia atrás.
            </Aviso>

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setAplicando(null)}>
                Cancelar
              </Button>
              <Button variante="primario" type="submit" cargando={guardando}>
                Aplicar
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
