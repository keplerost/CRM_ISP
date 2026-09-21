import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Ban, FileText, Pencil, Printer, Receipt } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { usePermisos } from '../lib/AuthContext'
import { api } from '../lib/apiNetwork'
import { abrirPdf } from '../lib/pdf'
import { imprimirTirilla } from '../lib/tirilla'
import { dineroCero as dinero } from '../lib/formato'
import { MOTIVOS_ANULACION } from '../lib/motivos'
import {
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Field,
  Input,
  PedirMotivo,
  Select,
  Table,
} from '../components/ui'

/**
 * Transacciones: el cierre de caja.
 *
 * ── Qué pregunta responde ──
 *
 * No "cobrarle a este abonado" —eso es Pagos— sino "cuánto entró hoy, por qué
 * punto de cobro, y quién lo cobró". Es la pantalla que se abre al final del
 * día, cuando alguien tiene que entregar la recaudación y firmar por ella.
 *
 * ── Por qué los totales no se suman acá ──
 *
 * Porque la tabla muestra una página. Sumar lo que está a la vista da el total de
 * quince cobros y parece correcto: es exactamente como se cuadra mal una caja.
 * Los totales los calcula la base sobre TODO lo filtrado, con la misma función
 * que usa el PDF, así que la pantalla y el papel no pueden discrepar.
 */

/** El primer día del mes en curso y hoy: el período que casi siempre se quiere. */
function mesEnCurso() {
  const hoy = new Date()
  const primero = new Date(hoy.getFullYear(), hoy.getMonth(), 1)
  const iso = (d) => d.toISOString().slice(0, 10)
  return { desde: iso(primero), hasta: iso(hoy) }
}

/** La fecha y la hora como se leen en Ecuador. */
function fechaHora(valor) {
  if (!valor) return ''
  const d = new Date(valor)
  if (Number.isNaN(d.getTime())) return String(valor)
  return d.toLocaleString('es-EC', {
    timeZone: 'America/Guayaquil',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/**
 * Las columnas, en el orden en que se leen al cuadrar caja.
 *
 * `buscar` es el campo por el que filtra la casilla de abajo del encabezado.
 * `valor` es lo que se muestra y también lo que se compara al ordenar: si fueran
 * dos cosas distintas, ordenar por "Cobrado" ordenaría alfabéticamente y $9.00
 * quedaría después de $80.00.
 */
const COLUMNAS = [
  { clave: 'numero', titulo: 'ID', ancho: 'w-16', valor: (t) => t.numero },
  { clave: 'cliente', titulo: 'Cliente', valor: (t) => t.cliente ?? '' },
  {
    clave: 'numero_factura',
    titulo: '# Factura',
    valor: (t) => (t.numero_factura ? String(t.numero_factura).padStart(8, '0') : ''),
  },
  { clave: 'numero_comprobante', titulo: '# Legal', valor: (t) => t.numero_comprobante ?? '' },
  { clave: 'n_transaccion', titulo: '# Transacción', valor: (t) => t.n_transaccion ?? '' },
  { clave: 'tipo', titulo: 'Tipo', valor: (t) => t.tipo ?? '' },
  { clave: 'registrado_en', titulo: 'Fecha y hora', valor: (t) => fechaHora(t.registrado_en) },
  { clave: 'operador', titulo: 'Operador', valor: (t) => t.operador ?? '' },
  { clave: 'cobrado', titulo: 'Cobrado', derecha: true, valor: (t) => Number(t.cobrado ?? 0) },
]

export default function TransaccionesPage() {
  const { puede, perfil } = usePermisos()
  // Quién consolida y quién solo ve lo suyo. `perfil.id` es el legajo, que es lo
  // que la vista guarda como operador — no el id de autenticación.
  const verTodos = puede('finanzas.ver_todos')
  const yo = perfil?.id ?? null

  const [filtros, setFiltros] = useState(() => ({
    ...mesEnCurso(),
    forma_pago: '',
    operador: '',
    router: '',
    ubicacion: '',
    cuenta: '',
    anulados: false,
  }))

  const [filas, setFilas] = useState([])
  // Lo que se está por anular. Mientras sea null, la ventana no existe.
  const [aAnular, setAAnular] = useState(null)
  const [anulando, setAnulando] = useState(false)
  const [totales, setTotales] = useState(null)
  const [opciones, setOpciones] = useState({ operadores: [], routers: [], ubicaciones: [], cuentas: [] })
  const [busquedas, setBusquedas] = useState({})
  const [orden, setOrden] = useState({ campo: 'registrado_en', asc: false })
  const [porPagina, setPorPagina] = useState(15)
  const [pagina, setPagina] = useState(1)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  // --- Las opciones de los filtros -----------------------------------------
  useEffect(() => {
    ;(async () => {
      const [ops, rts, ubs, ctas] = await Promise.all([
        supabase.from('usuarios_sistema').select('id, nombre, apellido').eq('activo', true).order('nombre'),
        supabase.from('routers_mikrotik').select('id, nombre').order('nombre'),
        supabase.from('v_ubicaciones_con_cobros').select('ubicacion'),
        supabase.from('cuentas_pago').select('id, nombre').eq('activa', true).order('nombre'),
      ])

      setOpciones({
        operadores: (ops.data ?? []).map((u) => ({
          id: u.id,
          nombre: [u.nombre, u.apellido].filter(Boolean).join(' '),
        })),
        routers: rts.data ?? [],
        ubicaciones: (ubs.data ?? []).map((x) => x.ubicacion),
        cuentas: ctas.data ?? [],
      })
    })()
  }, [])

  // --- Los datos ------------------------------------------------------------
  const buscar = useCallback(async () => {
    setCargando(true)
    setError(null)

    let q = supabase.from('v_transacciones').select('*')

    /**
     * Sin permiso de consolidar, solo lo propio.
     *
     * La pantalla ya no se le ofrece a quien no puede consolidar, pero eso es el
     * mapa de rutas y el mapa es cortesía: quien escribe la URL entra igual. Acá
     * el filtro se aplica igual, y el PDF lo vuelve a aplicar del lado del
     * servidor, que es lo único que de verdad protege.
     */
    if (!verTodos && yo) q = q.eq('operador_id', yo)

    if (filtros.desde) q = q.gte('fecha_pago', filtros.desde)
    if (filtros.hasta) q = q.lte('fecha_pago', filtros.hasta)
    if (filtros.forma_pago) q = q.eq('forma_pago', filtros.forma_pago)
    if (filtros.operador) q = q.eq('operador_id', filtros.operador)
    if (filtros.router) q = q.eq('router_id', filtros.router)
    if (filtros.ubicacion) q = q.eq('ubicacion', filtros.ubicacion)
    if (filtros.cuenta) q = q.eq('cuenta_id', filtros.cuenta)
    if (!filtros.anulados) q = q.eq('anulado', false)

    const { data, error: e } = await q.order('registrado_en', { ascending: false }).limit(5000)

    if (e) {
      setError(
        /does not exist/i.test(e.message)
          ? {
              message: 'Falta la vista de transacciones',
              hint: 'Corré supabase/migracion-157-la-pantalla-de-transacciones.sql',
            }
          : e,
      )
      setFilas([])
      setCargando(false)
      return
    }

    setFilas(data ?? [])
    setPagina(1)

    /**
     * Los totales, de la base y no de `data`.
     *
     * `data` viene con tope de 5000 filas. Con un padrón grande y un mes entero,
     * sumar lo traído diría menos plata de la que entró y nadie se enteraría.
     */
    const { data: tot } = await supabase.rpc('totales_transacciones', {
      p_desde: filtros.desde || null,
      p_hasta: filtros.hasta || null,
      /**
       * Los totales van con el MISMO alcance que la tabla.
       *
       * Sin esto, quien solo ve lo suyo tendría una lista con sus cobros y un
       * total con los de todos — que es peor que no mostrar el total: parece que
       * le falta plata en la caja.
       */
      p_operador: verTodos ? (filtros.operador || null) : yo,
      p_router: filtros.router || null,
      p_ubicacion: filtros.ubicacion || null,
      p_forma_pago: filtros.forma_pago || null,
      p_cuenta: filtros.cuenta || null,
      p_anulados: filtros.anulados,
    })

    setTotales(tot?.[0] ?? null)
    setCargando(false)
  }, [filtros, verTodos, yo])

  useEffect(() => {
    buscar()
  }, [buscar])

  const set = (campo) => (e) => {
    const v = e?.target?.type === 'checkbox' ? e.target.checked : e.target.value
    setFiltros((f) => ({ ...f, [campo]: v }))
  }

  // --- Búsqueda por columna y orden ----------------------------------------
  const visibles = useMemo(() => {
    let r = filas

    for (const [clave, texto] of Object.entries(busquedas)) {
      if (!texto?.trim()) continue
      const col = COLUMNAS.find((c) => c.clave === clave)
      const buscado = texto.trim().toLowerCase()
      r = r.filter((t) => String(col.valor(t) ?? '').toLowerCase().includes(buscado))
    }

    const col = COLUMNAS.find((c) => c.clave === orden.campo)
    if (col) {
      r = [...r].sort((a, b) => {
        const x = col.valor(a)
        const y = col.valor(b)
        // Los números se comparan como números: si no, $9 va después de $80.
        const cmp =
          typeof x === 'number' && typeof y === 'number'
            ? x - y
            : String(x).localeCompare(String(y), 'es')
        return orden.asc ? cmp : -cmp
      })
    }

    return r
  }, [filas, busquedas, orden])

  const paginas = Math.max(1, Math.ceil(visibles.length / porPagina))
  const pagActual = Math.min(pagina, paginas)
  const enPantalla = visibles.slice((pagActual - 1) * porPagina, pagActual * porPagina)

  function ordenarPor(clave) {
    setOrden((o) => (o.campo === clave ? { campo: clave, asc: !o.asc } : { campo: clave, asc: true }))
  }

  async function anular(motivo) {
    const t = aAnular
    setAnulando(true)
    const { error: e } = await supabase
      .from('pagos')
      .update({
        anulado: true,
        motivo_anulacion: motivo.trim() || 'Sin motivo indicado',
        anulado_at: new Date().toISOString(),
      })
      .eq('id', t.id)

    setAnulando(false)
    if (e) setError(e)
    else {
      setAAnular(null)
      await buscar()
    }
  }

  function resumenPdf() {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(filtros)) {
      if (k === 'anulados') { if (v) p.set('anulados', '1'); continue }
      if (v) p.set(k, v)
    }
    abrirPdf(() => api.pagos.transaccionesPdf(p.toString())).catch(setError)
  }

  if (cargando && !filas.length && !error) return <Cargando />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Transacciones</h1>
          <p className="text-sm text-slate-500">
            Todo lo cobrado, para cerrar caja por sitio y por operador.
          </p>
        </div>

        <Button variante="secundario" onClick={resumenPdf} icon={FileText}>
          Resumen PDF
        </Button>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {/* --- Filtros --------------------------------------------------------- */}
      <Card>
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Tipo de pago">
            <Select value={filtros.forma_pago} onChange={set('forma_pago')}>
              <option value="">Cualquiera</option>
              <option value="efectivo">Efectivo</option>
              <option value="transferencia">Transferencia</option>
              <option value="deposito">Depósito</option>
              <option value="tarjeta">Tarjeta</option>
              <option value="otro">Otro</option>
            </Select>
          </Field>

          {verTodos && (
          <Field label="Operador" hint="Quién registró el cobro">
            <Select value={filtros.operador} onChange={set('operador')}>
              <option value="">Cualquiera</option>
              {opciones.operadores.map((o) => (
                <option key={o.id} value={o.id}>{o.nombre}</option>
              ))}
            </Select>
          </Field>
          )}

          <Field label="Desde">
            <Input type="date" value={filtros.desde} onChange={set('desde')} />
          </Field>

          <Field label="Hasta">
            <Input type="date" value={filtros.hasta} onChange={set('hasta')} />
          </Field>

          <Field label="Router">
            <Select value={filtros.router} onChange={set('router')}>
              <option value="">Cualquiera</option>
              {opciones.routers.map((r) => (
                <option key={r.id} value={r.id}>{r.nombre}</option>
              ))}
            </Select>
          </Field>

          <Field label="Ubicación">
            <Select value={filtros.ubicacion} onChange={set('ubicacion')}>
              <option value="">Cualquiera</option>
              {opciones.ubicaciones.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </Select>
          </Field>

          <Field label="Cuenta" hint="Dónde entró la plata">
            <Select value={filtros.cuenta} onChange={set('cuenta')}>
              <option value="">Cualquiera</option>
              {opciones.cuentas.map((c) => (
                <option key={c.id} value={c.id}>{c.nombre}</option>
              ))}
            </Select>
          </Field>

          <Field label="Anulados" hint="Se listan tachados, fuera del total">
            <label className="flex h-9 cursor-pointer items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={filtros.anulados}
                onChange={set('anulados')}
                className="size-4 cursor-pointer"
              />
              Mostrarlos
            </label>
          </Field>
        </div>
      </Card>

      {/* --- Totales --------------------------------------------------------- */}
      {totales && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Caja titulo="Comprobantes" valor={String(totales.cantidad ?? 0)} />
          <Caja titulo="Total cobrado" valor={dinero(totales.cobrado)} />
          <Caja titulo="Total comisión" valor={dinero(totales.comision)} />
          <Caja
            titulo="Total neto"
            valor={dinero(totales.neto)}
            destacado
            nota={
              Number(totales.anulados) > 0
                ? `${totales.anulados} anulado${Number(totales.anulados) === 1 ? '' : 's'} por ${dinero(totales.anulado_monto)}, fuera del total`
                : null
            }
          />
        </div>
      )}

      {/* --- La tabla -------------------------------------------------------- */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-2.5">
          <label className="flex items-center gap-2 text-xs text-slate-500">
            Mostrar
            <select
              value={porPagina}
              onChange={(e) => { setPorPagina(Number(e.target.value)); setPagina(1) }}
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-200"
            >
              {[15, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            de {visibles.length}
          </label>

          {paginas > 1 && (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Button variante="secundario" onClick={() => setPagina((p) => Math.max(1, p - 1))} disabled={pagActual === 1}>
                Anterior
              </Button>
              <span>{pagActual} / {paginas}</span>
              <Button variante="secundario" onClick={() => setPagina((p) => Math.min(paginas, p + 1))} disabled={pagActual === paginas}>
                Siguiente
              </Button>
            </div>
          )}
        </div>

        <Table
          columnas={[
            ...COLUMNAS.map((c) => (
              <button
                key={c.clave}
                type="button"
                onClick={() => ordenarPor(c.clave)}
                className={`flex items-center gap-1 font-medium uppercase tracking-wider hover:text-slate-300 ${
                  c.derecha ? 'ml-auto' : ''
                }`}
              >
                {c.titulo}
                {orden.campo === c.clave && <span className="text-sky-400">{orden.asc ? '▲' : '▼'}</span>}
              </button>
            )),
            'Acción',
          ]}
          /* Una casilla por columna, como la pantalla que se venía usando: es lo
             que permite encontrar un comprobante suelto sin rehacer el filtro. */
          bajoEncabezado={
            <>
              {COLUMNAS.map((c) => (
                <th key={c.clave} className="px-2 py-1.5">
                  <input
                    value={busquedas[c.clave] ?? ''}
                    onChange={(e) => setBusquedas((b) => ({ ...b, [c.clave]: e.target.value }))}
                    placeholder="Buscar"
                    className="w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 text-xs font-normal normal-case tracking-normal text-slate-200 placeholder:text-slate-600"
                  />
                </th>
              ))}
              <th />
            </>
          }
          filas={enPantalla}
          vacio="No hubo cobros con estos filtros."
          renderFila={(t) => (
            <tr key={t.id} className={t.anulado ? 'text-rose-400/70' : 'text-slate-300'}>
              {COLUMNAS.map((c) => (
                <td
                  key={c.clave}
                  className={`px-3 py-2 ${c.derecha ? 'text-right tabular-nums' : ''} ${
                    c.clave === 'cliente' ? 'text-slate-100' : ''
                  }`}
                >
                  {c.clave === 'cobrado' ? (
                    <span className={t.anulado ? 'line-through' : ''}>{dinero(t.cobrado)}</span>
                  ) : c.clave === 'cliente' && t.client_id ? (
                    <Link to={`/clientes/${t.client_id}`} className="hover:text-sky-400">
                      {c.valor(t)}
                    </Link>
                  ) : (
                    c.valor(t)
                  )}
                </td>
              ))}

              <td className="px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <Accion
                    icon={Printer}
                    titulo="Imprimir recibo"
                    onClick={() => abrirPdf(() => api.pagos.comprobante(t.id)).catch(setError)}
                  />
                  <Accion
                    icon={Receipt}
                    titulo="Recibo en tirilla"
                    onClick={() =>
                      api.documentos.reciboPos(t.id).then(imprimirTirilla).catch(setError)
                    }
                  />
                  {/* La ficha del abonado es donde se corrige un cobro: acá no se
                      edita en el lugar a propósito, porque tocar un monto sin ver
                      las facturas que saldó deja la imputación inconsistente. */}
                  <Link
                    to={`/clientes/${t.client_id}`}
                    title="Ver en la ficha del abonado"
                    className="rounded p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
                  >
                    <Pencil size={15} />
                  </Link>
                  {!t.anulado && (
                    <Accion icon={Ban} titulo="Anular" peligro onClick={() => setAAnular(t)} />
                  )}
                </div>
              </td>
            </tr>
          )}
        />
      </Card>

      <PedirMotivo
        abierto={!!aAnular}
        titulo="Anular el cobro"
        etiquetaAccion="Anular el cobro"
        icon={Ban}
        cargando={anulando}
        advertencia="El pago no se borra: queda anulado con el motivo, y la factura vuelve a figurar por cobrar."
        datos={
          aAnular
            ? [
                ['Abonado', aAnular.cliente],
                ['Monto', dinero(aAnular.cobrado)],
                ['Fecha', aAnular.fecha ? new Date(`${String(aAnular.fecha).slice(0, 10)}T12:00:00`).toLocaleDateString('es-EC') : '—'],
                ['Forma de pago', aAnular.forma_pago ?? '—'],
              ]
            : []
        }
        sugerencias={MOTIVOS_ANULACION}
        onCancelar={() => setAAnular(null)}
        onConfirmar={anular}
      />
    </div>
  )
}

function Caja({ titulo, valor, nota = null, destacado = false }) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        destacado ? 'border-sky-800/60 bg-sky-950/30' : 'border-slate-800 bg-slate-900/40'
      }`}
    >
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{titulo}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${destacado ? 'text-sky-300' : 'text-slate-100'}`}>
        {valor}
      </p>
      {nota && <p className="mt-1 text-[11px] text-rose-400">{nota}</p>}
    </div>
  )
}

function Accion({ icon: Icon, titulo, onClick, peligro = false }) {
  return (
    <button
      type="button"
      title={titulo}
      onClick={onClick}
      className={`rounded p-1.5 text-slate-500 hover:bg-slate-800 ${
        peligro ? 'hover:text-rose-400' : 'hover:text-slate-200'
      }`}
    >
      <Icon size={15} />
    </button>
  )
}
