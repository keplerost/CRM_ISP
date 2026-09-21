import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, FileSpreadsheet, FileText } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { api } from '../lib/apiNetwork'
import { abrirPdf, descargar } from '../lib/pdf'
import { dineroCero as dinero } from '../lib/formato'
import { Aviso, Button, Card, Cargando, ErrorBanner, Field, Select, Table } from '../components/ui'

/**
 * El reporte que pide ARCOTEL.
 *
 * ── Qué lleva y por qué ──
 *
 * Las once columnas que exige el regulador, sobre las facturas AUTORIZADAS POR EL
 * SRI. No sobre las del sistema: el organismo cruza este listado contra lo que el
 * SRI tiene, así que incluir una factura que no llegó allá declara ingresos que
 * no existen para el Estado.
 *
 * ── Por qué se muestran los incompletos primero ──
 *
 * Porque un reporte al regulador con celdas vacías se devuelve, y descubrirlo
 * después de mandarlo cuesta una observación. Acá se ve antes de exportar, con el
 * nombre de a quién le falta qué.
 */
export default function ArcotelPage() {
  const [meses, setMeses] = useState([])
  const [prestadores, setPrestadores] = useState([])
  const [mes, setMes] = useState('')
  const [prestador, setPrestador] = useState('')
  const [filas, setFilas] = useState([])
  const [faltantes, setFaltantes] = useState([])
  const [resumen, setResumen] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    Promise.all([
      supabase.from('v_reporte_arcotel').select('mes').order('mes', { ascending: false }),
      supabase.from('prestadores').select('id, nombre, ruc').order('nombre'),
    ]).then(([m, p]) => {
      if (m.error) {
        setError(
          /does not exist/i.test(m.error.message)
            ? {
                message: 'Falta la vista del reporte',
                hint: 'Corré supabase/migracion-162-el-reporte-para-arcotel.sql',
              }
            : m.error,
        )
        setCargando(false)
        return
      }
      const unicos = [...new Set((m.data ?? []).map((x) => x.mes))]
      setMeses(unicos)
      setPrestadores(p.data ?? [])
      // El último mes con facturas: es el que casi siempre se quiere mandar.
      setMes(unicos[0] ?? '')
      if (!unicos.length) setCargando(false)
    })
  }, [])

  const cargar = useCallback(async () => {
    if (!mes) return
    setCargando(true)

    let q = supabase.from('v_reporte_arcotel').select('*').eq('mes', mes)
    let f = supabase.from('v_arcotel_incompletos').select('*').eq('mes', mes)
    if (prestador) {
      q = q.eq('prestador_id', prestador)
      f = f.eq('client_id', prestador) // se filtra abajo por los que quedaron
    }

    let g = supabase.from('v_arcotel_resumen').select('*').eq('mes', mes)
    if (prestador) g = g.eq('prestador_id', prestador)

    const [r, inc, res] = await Promise.all([
      q.order('usuario').limit(20000),
      f.limit(500),
      g.order('monto', { ascending: false }),
    ])
    setResumen(res.data ?? [])

    if (r.error) setError(r.error)
    setFilas(r.data ?? [])

    // Los incompletos se cruzan contra lo que de verdad va a salir: si se filtró
    // por prestador, los de la otra empresa no son problema de este reporte.
    const ids = new Set((r.data ?? []).map((x) => x.client_id))
    setFaltantes((inc.data ?? []).filter((x) => ids.has(x.client_id)))

    setCargando(false)
  }, [mes, prestador])

  useEffect(() => {
    cargar()
  }, [cargar])

  function bajar(formato) {
    const p = new URLSearchParams({ mes, formato })
    if (prestador) p.set('prestador', prestador)

    const traer = () => api.pagos.arcotel(p.toString())
    const nombre = `reporte-arcotel-${mes.replace('-', '')}.${formato === 'pdf' ? 'pdf' : 'xlsx'}`

    // El PDF se abre para mirarlo; el Excel se baja, porque no hay nada que
    // mirar dentro del navegador.
    const accion = formato === 'pdf' ? abrirPdf(traer) : descargar(traer, nombre)
    Promise.resolve(accion).catch(setError)
  }

  const total = filas.reduce((s, f) => s + Number(f.costo_con_impuestos ?? 0), 0)

  if (cargando && !filas.length && !error) return <Cargando />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Reporte ARCOTEL</h1>
          <p className="text-sm text-slate-500">
            Las facturas autorizadas por el SRI, con los campos que pide el regulador.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variante="secundario" icon={FileText} onClick={() => bajar('pdf')} disabled={!mes}>
            Ver en PDF
          </Button>
          <Button
            variante="primario"
            icon={FileSpreadsheet}
            onClick={() => bajar('excel')}
            disabled={!mes}
          >
            Descargar Excel
          </Button>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <Card>
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          <Field label="Mes" hint="Se toma del período de la factura">
            <Select value={mes} onChange={(e) => setMes(e.target.value)}>
              {!meses.length && <option value="">Sin facturas autorizadas</option>}
              {meses.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </Select>
          </Field>

          <Field label="Prestador" hint="Son dos RUC y el regulador los mira por separado">
            <Select value={prestador} onChange={(e) => setPrestador(e.target.value)}>
              <option value="">Todos</option>
              {prestadores.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}{p.ruc ? ` · ${p.ruc}` : ''}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Lo que va en el archivo">
            <div className="flex h-9 items-center gap-4 text-sm">
              <span className="text-slate-300">
                <b className="tabular-nums text-slate-100">{filas.length}</b> abonados
              </span>
              <span className="text-slate-300">
                <b className="tabular-nums text-slate-100">{dinero(total)}</b> facturado
              </span>
            </div>
          </Field>
        </div>
      </Card>

      {/* --- Cómo pagaron los que piden factura -------------------------------- */}
      {resumen.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {resumen.map((r) => (
            <div
              key={r.forma_pago}
              className={`rounded-lg border p-4 ${
                r.forma_pago === 'sin cobrar'
                  ? 'border-amber-900/50 bg-[#FFFBEB]'
                  : 'border-slate-800 bg-[#F6F8FB]'
              }`}
            >
              <p className="text-[11px] uppercase tracking-wider text-slate-500">
                {FORMAS[r.forma_pago] ?? r.forma_pago}
              </p>
              <p
                className={`mt-1 text-2xl font-semibold tabular-nums ${
                  r.forma_pago === 'sin cobrar' ? 'text-amber-300' : 'text-slate-100'
                }`}
              >
                {dinero(r.monto)}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {r.facturas} factura{Number(r.facturas) === 1 ? '' : 's'} · {r.abonados} abonado
                {Number(r.abonados) === 1 ? '' : 's'}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* --- Lo que hay que completar antes de mandarlo ------------------------ */}
      {faltantes.length > 0 && (
        <Card>
          <div className="flex items-start gap-2 border-b border-amber-900/40 px-4 py-3">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-400" />
            <div>
              <p className="text-sm font-medium text-slate-200">
                {faltantes.length} abonado{faltantes.length === 1 ? '' : 's'} saldría
                {faltantes.length === 1 ? '' : 'n'} con celdas vacías
              </p>
              <p className="text-xs text-slate-500">
                Un reporte incompleto al regulador se devuelve. Completá la ficha antes de
                exportar.
              </p>
            </div>
          </div>

          <div className="max-h-56 overflow-auto">
            <Table
              columnas={['Abonado', 'Le falta']}
              filas={faltantes}
              renderFila={(x) => (
                <tr key={x.client_id} className="text-slate-300">
                  <td className="px-3 py-2">
                    <Link to={`/clientes/${x.client_id}`} className="text-slate-100 hover:text-sky-400">
                      {x.usuario}
                    </Link>
                    {x.codigo != null && (
                      <span className="ml-2 text-xs text-slate-500">#{x.codigo}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-amber-400">
                    {(x.le_falta ?? []).join(' · ')}
                  </td>
                </tr>
              )}
            />
          </div>
        </Card>
      )}

      {/* --- La vista previa --------------------------------------------------- */}
      <Card>
        <Table
          columnas={[
            'Fecha', 'Hora', 'Documento', 'Usuario', 'Teléfono', 'Cantón', 'Parroquia',
            'Plan', 'Dirección', 'Costo', 'Down', 'Up', 'Compartición', 'Tecnología', 'Pagó con',
          ]}
          filas={filas.slice(0, 100)}
          vacio="No hay facturas autorizadas por el SRI en este mes."
          renderFila={(f) => (
            <tr key={f.factura_id} className="text-slate-300">
              <td className="whitespace-nowrap px-3 py-2 text-xs">{f.fecha}</td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums text-xs">{f.hora}</td>
              <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-400">{f.documento}</td>
              <td className="px-3 py-2 text-slate-100">{f.usuario}</td>
              <td className="px-3 py-2 text-xs">{f.telefono || <Vacio />}</td>
              <td className="px-3 py-2 text-xs">{f.canton || <Vacio />}</td>
              <td className="px-3 py-2 text-xs">{f.parroquia || <Vacio />}</td>
              <td className="px-3 py-2 text-xs">{f.plan || <Vacio />}</td>
              <td className="max-w-[220px] truncate px-3 py-2 text-xs" title={f.direccion ?? ''}>
                {f.direccion || <Vacio />}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{dinero(f.costo_con_impuestos)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs">{f.down_mbps ?? <Vacio />}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs">{f.up_mbps ?? <Vacio />}</td>
              {/* La compartición falta en el PLAN, no en el abonado: cargándola
                  una vez se arregla para todos los que tienen ese plan. */}
              <td className="px-3 py-2 text-right text-xs">{f.comparticion || <Vacio />}</td>
              <td className="whitespace-nowrap px-3 py-2 text-xs">
                {f.tecnologia === 'POR DEFINIR' ? (
                  <span className="text-amber-400">POR DEFINIR</span>
                ) : (
                  f.tecnologia
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-xs">
                {f.forma_pago === 'sin cobrar' ? (
                  <span className="text-slate-500">sin cobrar</span>
                ) : (
                  FORMAS[f.forma_pago] ?? f.forma_pago
                )}
              </td>
            </tr>
          )}
        />

        {filas.length > 100 && (
          <p className="border-t border-slate-800 px-4 py-2 text-xs text-slate-500">
            Se muestran los primeros 100. El archivo lleva los {filas.length}.
          </p>
        )}
      </Card>

      <Aviso>
        El reporte incluye solo las facturas <b>autorizadas por el SRI</b>. Las del sistema que
        no se emitieron electrónicamente no aparecen: el regulador cruza este listado contra lo
        que el SRI tiene.
      </Aviso>
    </div>
  )
}

/**
 * Cómo se nombra cada forma de pago.
 *
 * Se repite acá y en el exportador porque son dos procesos distintos —el
 * navegador y el servidor— y no comparten módulos. Si algún día divergen, lo que
 * manda es el archivo: es lo que ve el regulador.
 */
const FORMAS = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia',
  deposito: 'Depósito',
  tarjeta: 'Tarjeta',
  otro: 'Otro',
  mixto: 'Mixto',
  'sin cobrar': 'Todavía sin cobrar',
}

/** Una celda que va a salir vacía en el archivo. Se marca, no se disimula. */
const Vacio = () => <span className="text-amber-500">falta</span>
