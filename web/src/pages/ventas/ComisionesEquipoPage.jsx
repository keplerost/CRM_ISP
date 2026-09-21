import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  Award,
  BadgeCheck,
  Ban,
  Box,
  CheckCircle2,
  Info,
  Layers,
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
import { ESTADOS_COMISION, ESTADOS_PERIODO, comisionesApi } from '../../lib/comisiones'

/**
 * Inteligencia comercial: comisiones e incentivos.
 *
 * ── Qué contesta ──
 *
 *   cuánto cuesta el canal comercial este mes · quién construye cartera y quién
 *   construye trabajo para cobranza · qué se está vendiendo · qué hay que
 *   autorizar.
 *
 * ── Por qué esto no es un ranking ──
 *
 * La tabla de vendedores ordena por ventas comisionables porque hay que
 * ordenarla por algo, pero las columnas que importan son las tasas: el punto 19
 * existe para ver al que ingresa 48 solicitudes y retiene el 71 %, no para
 * premiar al que aparece primero. Y el sistema no sanciona a nadie solo: acá se
 * mira y se decide.
 *
 * ── Sobre "proyectada" ──
 *
 * El mes en curso todavía no tiene una cifra cerrada. La proyección se calcula
 * con el motor —la misma función que después congela la liquidación— y se suma
 * en esta pantalla en vez de guardarse en ningún lado: guardar un número que
 * cambia con cada venta sería inventar un pasivo que todavía no existe.
 */

const hoyPeriodo = () => `${new Date().toISOString().slice(0, 7)}-01`

const mesLargo = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('es-EC', { month: 'long', year: 'numeric' })

const pct = (v) => (v == null ? '—' : `${v} %`)

export default function ComisionesEquipoPage() {
  const { puede } = usePermisos()
  const puedeAprobar = puede('comisiones.aprobar')
  const puedePagar = puede('comisiones.pagar')
  const puedeAnular = puede('comisiones.anular')

  const [periodo, setPeriodo] = useState(hoyPeriodo)
  const [datos, setDatos] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [moviendo, setMoviendo] = useState(null)
  const [anulando, setAnulando] = useState(null)
  const [guardando, setGuardando] = useState(false)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const [kpis, equipo, planes, cartera, liquidaciones, resumen, ventas] = await Promise.all([
        comisionesApi.kpis(),
        comisionesApi.equipo({ periodo }),
        comisionesApi.porPlan({ periodo }),
        comisionesApi.carteraKpis(),
        comisionesApi.liquidaciones(),
        comisionesApi.resumen({ periodo }),
        comisionesApi.ventas({ periodo }),
      ])
      setDatos({ kpis, equipo, planes, cartera, liquidaciones, resumen, ventas })
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [periodo])

  useEffect(() => {
    recargar()
  }, [recargar])

  async function mover(e) {
    e.preventDefault()
    setGuardando(true)
    try {
      await comisionesApi.moverPeriodo(moviendo.id, moviendo.destino, moviendo.nota)
      setMoviendo(null)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  /**
   * Anula una venta comisionable.
   *
   * Existe acá porque el punto 11 pide que las excepciones —fraude, duplicidad,
   * error de carga— se resuelvan por "un proceso administrativo autorizado y
   * auditable, nunca mediante modificaciones silenciosas del sistema". Sin esta
   * puerta, la única forma de corregir una comisión mal generada sería editar la
   * base a mano: exactamente la modificación silenciosa que se quiere evitar.
   */
  async function anular(e) {
    e.preventDefault()
    setGuardando(true)
    try {
      await comisionesApi.anularVenta(anulando.id, anulando.motivo)
      setAnulando(null)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  const delMes = useMemo(
    () => datos?.kpis?.find((k) => k.periodo === periodo) ?? null,
    [datos, periodo],
  )

  const periodos = useMemo(() => {
    const set = new Set([hoyPeriodo(), ...(datos?.kpis ?? []).map((k) => k.periodo)])
    return [...set].sort().reverse()
  }, [datos])

  // Lo proyectado del período: la suma de lo que el motor calcula hoy para cada
  // vendedor. Para un mes ya cerrado coincide con lo congelado; para el mes en
  // curso es la única cifra que existe.
  const proyectada = useMemo(
    () => (datos?.resumen ?? []).reduce((t, r) => t + Number(r.monto || 0), 0),
    [datos],
  )

  const liquidacionesDelMes = useMemo(
    () => (datos?.liquidaciones ?? []).filter((l) => l.periodo === periodo),
    [datos, periodo],
  )

  if (cargando && !datos) return <Cargando texto="Juntando los números del equipo…" />

  const cartera = datos?.cartera
  const sinPermiso = !datos?.kpis?.length && !datos?.equipo?.length && !cartera

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Comisiones del equipo</h1>
          <p className="mt-0.5 max-w-3xl text-xs leading-snug text-slate-500">
            Lo que cuesta el canal comercial, cómo se comporta la cartera que trae cada uno y qué
            está esperando autorización.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={periodo} onChange={(e) => setPeriodo(e.target.value)} className="w-44">
            {periodos.map((p) => (
              <option key={p} value={p}>
                {mesLargo(p)}
              </option>
            ))}
          </Select>
          {/* El camino natural: se ve lo que cuesta, y de ahí se prueba qué
              pasaría con otras reglas antes de cambiarlas. */}
          <Link to="/ajustes/comisiones/simulador">
            <Button variante="fantasma">Simulador</Button>
          </Link>
          <Link to="/ajustes/comisiones">
            <Button variante="fantasma">Configuración</Button>
          </Link>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {sinPermiso && (
        <Aviso tipo="alerta">
          No tenés permiso para ver las comisiones del equipo. Con{' '}
          <code className="text-slate-300">comisiones.ver_todas</code> se habilita esta pantalla.
        </Aviso>
      )}

      {/* --------------------------------------------------- El mes */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Solicitudes ingresadas"
          valor={delMes?.solicitudes ?? 0}
          sub={`${delMes?.ganadas ?? 0} cerradas por el vendedor`}
          icon={Layers}
          color="text-sky-400"
        />
        <Stat
          label="Ventas comisionables"
          valor={delMes?.comisionables ?? 0}
          sub={
            delMes?.en_cortesia
              ? `${delMes.en_cortesia} esperando el primer pago`
              : `de ${delMes?.registradas ?? 0} registradas`
          }
          icon={BadgeCheck}
          color="text-emerald-400"
        />
        <Stat
          label="Comisión proyectada"
          valor={dinero(proyectada)}
          sub={`cerrada: ${dinero(delMes?.comision_cerrada)} · bonos: ${dinero(delMes?.bonos)}`}
          icon={Wallet}
          color="text-amber-400"
        />
        <Stat
          label="Ticket promedio"
          valor={dinero(delMes?.ticket_promedio)}
          sub={`base comisionable: ${dinero(delMes?.base_total)}`}
          icon={Award}
          color="text-violet-400"
        />
      </div>

      {/* Costo por cliente adquirido: la pregunta que ordena todo el esquema. */}
      {delMes?.comisionables > 0 && (
        <Aviso>
          <span className="inline-flex items-center gap-1.5">
            <Info size={14} />
            Costo comercial por cliente adquirido:{' '}
            <strong className="text-slate-100">
              {dinero((proyectada + Number(delMes.bonos || 0)) / delMes.comisionables)}
            </strong>{' '}
            — comisión más bonos, dividido por las ventas que ya cumplieron todos los requisitos.
          </span>
        </Aviso>
      )}

      {/* --------------------------------------------------- Foto de hoy */}
      {cartera && (
        <Card
          title="Ahora mismo"
          subtitle="No es del mes elegido: es el estado de hoy"
          icon={AlertTriangle}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Mini
              label="Sin renovar"
              valor={cartera.clientes_1_mes}
              nota="Un período sin pagar. Todavía se recuperan."
              tono="text-amber-300"
            />
            <Mini
              label="En condición de retiro"
              valor={cartera.clientes_2_meses}
              nota="Llegaron al umbral configurado."
              tono="text-red-300"
            />
            <Mini
              label="ONT por recuperar"
              valor={cartera.ont_pendientes}
              nota={`${dinero(cartera.valor_en_riesgo)} en la calle`}
              tono="text-amber-300"
            />
            <Mini
              label="ONT no recuperadas"
              valor={cartera.ont_no_recuperadas}
              nota={`${dinero(cartera.valor_perdido)} dados por perdidos`}
              tono="text-slate-300"
            />
            <Mini
              label="Reactivaciones del mes"
              valor={cartera.reactivaciones_mes}
              nota="No cuentan como venta nueva"
              tono="text-emerald-300"
            />
            <Mini
              label="Bajas tempranas (12 meses)"
              valor={cartera.bajas_tempranas}
              nota="Se perdieron dentro del seguimiento de su cohorte"
              tono="text-red-300"
            />
            <Mini
              label="Períodos por autorizar"
              valor={cartera.periodos_por_aprobar}
              nota={`${dinero(cartera.monto_por_aprobar)} esperando firma`}
              tono="text-sky-300"
            />
            <Mini
              label="Validaciones abiertas"
              valor={cartera.validaciones_abiertas}
              nota="Solicitudes esperando admisión"
              tono="text-slate-300"
            />
          </div>
          <p className="mt-3 text-[11px] leading-snug text-slate-500">
            Ninguno de estos números descuenta nada a nadie. Las bajas y los equipos perdidos afectan
            bonos de calidad futuros, nunca una comisión ya cerrada.
          </p>
        </Card>
      )}

      {/* --------------------------------------------------- El equipo */}
      <Card
        title="Cómo vende cada uno"
        subtitle="Ingresar muchas solicitudes no es lo mismo que traer buenos clientes"
        icon={Users}
      >
        <Table
          columnas={[
            'Vendedor',
            'Solicitudes',
            'Cerradas',
            'Instaladas',
            'Primer pago',
            'Comisionables',
            'Conversión',
            'Retención 90 días',
            'Reactiv.',
          ]}
          filas={datos?.equipo ?? []}
          vacio="Sin actividad comercial en este período."
          renderFila={(v) => (
            <tr key={v.vendedor_id}>
              <td className="px-3 py-2 font-medium text-slate-100">{v.vendedor}</td>
              <td className="px-3 py-2 text-slate-300">{v.solicitudes}</td>
              <td className="px-3 py-2 text-slate-300">{v.ganadas}</td>
              <td className="px-3 py-2 text-slate-300">{v.instaladas}</td>
              <td className="px-3 py-2 text-slate-300">{v.primeros_pagos}</td>
              <td className="px-3 py-2 font-semibold text-emerald-300">{v.comisionables}</td>
              <td className="px-3 py-2 text-slate-300">{pct(v.tasa_conversion)}</td>
              <td className="px-3 py-2">
                {v.retencion == null ? (
                  <span className="text-slate-500">—</span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Badge
                      color={v.retencion >= 90 ? 'verde' : v.retencion >= 70 ? 'ambar' : 'rojo'}
                    >
                      {v.retencion} %
                    </Badge>
                    <span className="text-[11px] text-slate-500">
                      {v.cohorte_evaluables} evaluados
                      {v.cohorte_estado === 'abierta' ? ' · en curso' : ''}
                    </span>
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-slate-400">{v.reactivaciones}</td>
            </tr>
          )}
        />
        <p className="mt-3 text-[11px] leading-snug text-slate-500">
          La retención sale de la cohorte de ese mes: cuántos de los clientes que trajo seguían
          siendo clientes al terminar el seguimiento. Una cohorte en curso todavía puede cambiar.
        </p>
      </Card>

      {/* --------------------------------------------------- Planes */}
      <Card title="Qué se vende" subtitle="Ventas comisionables por plan" icon={Box}>
        <Table
          columnas={['Plan', 'Precio', 'Ventas', 'Comisionables', 'Base promedio', 'Base total']}
          filas={datos?.planes ?? []}
          vacio="Sin ventas en este período."
          renderFila={(p) => (
            <tr key={p.plan_id ?? p.plan}>
              <td className="px-3 py-2 text-slate-200">{p.plan}</td>
              <td className="px-3 py-2 text-slate-400">{dinero(p.precio_plan)}</td>
              <td className="px-3 py-2 text-slate-300">{p.ventas}</td>
              <td className="px-3 py-2 text-slate-300">{p.comisionables}</td>
              <td className="px-3 py-2 text-slate-300">{dinero(p.base_promedio)}</td>
              <td className="px-3 py-2 text-slate-300">{dinero(p.base_total)}</td>
            </tr>
          )}
        />
      </Card>

      {/* --------------------------------------------------- Liquidaciones */}
      <Card
        title="Liquidaciones del período"
        subtitle="Autorizar y pagar son dos firmas distintas"
        icon={Wallet}
      >
        <Table
          columnas={['Vendedor', 'Ventas', 'Nivel', 'Comisión', 'Bono', 'Total', 'Estado', '']}
          filas={liquidacionesDelMes}
          vacio="Este período todavía no se cerró. El cierre corre el día configurado del mes siguiente."
          renderFila={(l) => {
            const e = ESTADOS_PERIODO[l.estado] ?? { label: l.estado, color: 'gris' }
            return (
              <tr key={l.id}>
                <td className="px-3 py-2 text-slate-100">{l.vendedor}</td>
                <td className="px-3 py-2 text-slate-300">{l.ventas_validas}</td>
                <td className="px-3 py-2 text-slate-400">
                  {l.nivel ?? '—'}
                  {l.porcentaje ? ` · ${l.porcentaje} %` : ''}
                </td>
                <td className="px-3 py-2 text-slate-300">{dinero(l.monto)}</td>
                <td className="px-3 py-2 text-slate-300">{dinero(l.bono)}</td>
                <td className="px-3 py-2 font-semibold text-slate-100">{dinero(l.total_a_pagar)}</td>
                <td className="px-3 py-2">
                  <Badge color={e.color}>{e.label}</Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  {l.estado === 'cerrado' && puedeAprobar && (
                    <Button
                      variante="exito"
                      icon={CheckCircle2}
                      onClick={() => setMoviendo({ id: l.id, destino: 'aprobado', nota: '', fila: l })}
                    >
                      Aprobar
                    </Button>
                  )}
                  {l.estado === 'aprobado' && puedePagar && (
                    <Button
                      variante="primario"
                      onClick={() => setMoviendo({ id: l.id, destino: 'pagado', nota: '', fila: l })}
                    >
                      Marcar pagada
                    </Button>
                  )}
                </td>
              </tr>
            )
          }}
        />
        <p className="mt-3 text-[11px] leading-snug text-slate-500">
          Una liquidación aprobada no se recalcula: queda con el nivel, el porcentaje y las reglas
          con las que se cerró. Las bajas posteriores afectan el bono de calidad, no lo ya aprobado.
        </p>
      </Card>

      {/* --------------------------------------------------- Ventas del mes */}
      <Card
        title="Ventas del período"
        subtitle="Una fila por venta, con qué le falta a cada una"
        icon={BadgeCheck}
      >
        <Table
          columnas={['Abonado', 'Vendedor', 'Plan', 'Base', 'Estado', 'Qué le falta', '']}
          filas={datos?.ventas ?? []}
          vacio="Sin ventas registradas en este período."
          renderFila={(v) => {
            const e = ESTADOS_COMISION[v.estado] ?? { label: v.estado, color: 'gris' }
            return (
              <tr key={v.id}>
                <td className="px-3 py-2 text-slate-200">{v.cliente ?? v.prospecto ?? '—'}</td>
                <td className="px-3 py-2 text-slate-400">{v.vendedor ?? '—'}</td>
                <td className="px-3 py-2 text-slate-400">{v.plan ?? '—'}</td>
                <td className="px-3 py-2 text-slate-300">{dinero(v.base)}</td>
                <td className="px-3 py-2">
                  <Badge color={e.color}>{e.label}</Badge>
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {v.le_falta ? <span className="text-amber-400">{v.le_falta}</span> : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  {puedeAnular && v.estado !== 'anulada' && (
                    <Button
                      variante="fantasma"
                      icon={Ban}
                      onClick={() => setAnulando({ id: v.id, motivo: '', fila: v })}
                    >
                      Anular
                    </Button>
                  )}
                </td>
              </tr>
            )
          }}
        />
        <p className="mt-3 text-[11px] leading-snug text-slate-500">
          Anular es para fraude, duplicidad o error de carga, con motivo escrito y registro de quién
          lo hizo. Una comisión no se anula porque el cliente después se dé de baja: eso afecta el
          bono de calidad, no lo ya ganado.
        </p>
      </Card>

      {/* --------------------------------------------------- Confirmación */}
      <Modal
        abierto={Boolean(moviendo)}
        titulo={moviendo?.destino === 'pagado' ? 'Marcar como pagada' : 'Aprobar la liquidación'}
        onCerrar={() => setMoviendo(null)}
      >
        {moviendo && (
          <form onSubmit={mover} className="space-y-4">
            <p className="text-sm text-slate-300">
              {moviendo.fila.vendedor} · {mesLargo(moviendo.fila.periodo)} ·{' '}
              <strong className="text-slate-100">{dinero(moviendo.fila.total_a_pagar)}</strong>
            </p>

            <Field label="Nota" hint="Queda en la auditoría junto a tu nombre y la fecha">
              <Input
                value={moviendo.nota}
                onChange={(e) => setMoviendo((m) => ({ ...m, nota: e.target.value }))}
                placeholder={
                  moviendo.destino === 'pagado' ? 'Transferencia del 5/9' : 'Revisado y autorizado'
                }
              />
            </Field>

            <Aviso tipo="alerta">
              {moviendo.destino === 'pagado'
                ? 'Marca la comisión como liquidada. Es el último paso de la cadena.'
                : 'Autoriza el gasto. Después de esto el período ya no se recalcula.'}
            </Aviso>

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setMoviendo(null)}>
                Cancelar
              </Button>
              <Button
                variante={moviendo.destino === 'pagado' ? 'primario' : 'exito'}
                type="submit"
                cargando={guardando}
              >
                {moviendo.destino === 'pagado' ? 'Marcar pagada' : 'Aprobar'}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* --------------------------------------------------- Anular */}
      <Modal abierto={Boolean(anulando)} titulo="Anular la comisión" onCerrar={() => setAnulando(null)}>
        {anulando && (
          <form onSubmit={anular} className="space-y-4">
            <p className="text-sm text-slate-300">
              {anulando.fila.cliente ?? anulando.fila.prospecto} · {anulando.fila.vendedor} ·{' '}
              base {dinero(anulando.fila.base)}
            </p>

            <Field
              label="Motivo"
              hint="Obligatorio. Queda en la auditoría con tu nombre y la fecha."
            >
              <Input
                value={anulando.motivo}
                onChange={(e) => setAnulando((a) => ({ ...a, motivo: e.target.value }))}
                placeholder="Cargada dos veces: el mismo abonado ya figura en la venta anterior"
                required
              />
            </Field>

            <Aviso tipo="alerta">
              Esto saca la venta del cálculo y no se deshace desde la pantalla. Es para fraude,
              duplicidad o error de carga — no para una baja posterior del cliente.
            </Aviso>

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setAnulando(null)}>
                Cancelar
              </Button>
              <Button
                variante="peligro"
                type="submit"
                cargando={guardando}
                disabled={!anulando.motivo.trim()}
              >
                Anular
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}

/** Una cifra chica con su explicación. */
function Mini({ label, valor, nota, tono = 'text-slate-200' }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <p className="text-[11px] leading-tight text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${tono}`}>{valor ?? 0}</p>
      <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{nota}</p>
    </div>
  )
}
