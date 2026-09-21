import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfirmar } from '../lib/confirmar'
import { Link } from 'react-router-dom'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  ExternalLink,
  Filter,
  ListPlus,
  Pencil,
  Plus,
  RotateCcw,
  Rows3,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react'
import { useTabla } from '../lib/useTabla'
import { supabase } from '../lib/supabaseClient'
import {
  CAMPOS_FILTRO,
  COLUMNAS_ABONADOS,
  COLUMNAS_EXPORT,
  COLUMNAS_POR_DEFECTO,
  aCSV,
  antiguedad,
  enlace,
  filtrarAbonados,
  filtrarPorCampo,
  filtrarPorColumnas,
  filtrosActivos,
  necesitaCuentas,
  nombreArchivo,
  resumirCuentas,
  seleccionarParaExportar,
} from '../lib/abonados'
import ClienteForm from '../components/clientes/ClienteForm'
import ConPermiso from '../components/layout/ConPermiso'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Input,
  Modal,
  Select,
  Stat,
  Table,
} from '../components/ui'

/**
 * El estado del abonado, como se lee.
 *
 * `baja` se muestra "retirado" porque es la palabra que se usa hablando: el
 * abonado se retiró, o se le retiró el equipo. En la base sigue siendo `baja`,
 * que es lo que escriben las funciones y lo que miran las políticas — cambiar
 * el valor guardado por una cuestión de vocabulario obligaría a tocar media
 * docena de migraciones para no ganar nada.
 */
const ESTADO = {
  activo: { label: 'activo', color: 'verde' },
  cortado: { label: 'cortado', color: 'rojo' },
  suspendido: { label: 'suspendido', color: 'ambar' },
  baja: { label: 'retirado', color: 'gris' },
}

const RECUERDO = 'abonados.columnas'
const RECUERDO_PAGINA = 'abonados.porPagina'

/** Sin tope. No es 0 ni Infinity para que no se confunda con "ninguno". */
const TODOS = -1

const CUANTOS = [
  { valor: 15, label: '15 registros' },
  { valor: 25, label: '25 registros' },
  { valor: 50, label: '50 registros' },
  { valor: 100, label: '100 registros' },
  { valor: 200, label: '200 registros' },
  { valor: 300, label: '300 registros' },
  { valor: TODOS, label: 'Mostrar todos' },
]

/**
 * Todos los abonados en una tabla que cada uno arma como la necesita.
 *
 * ── Por qué lee la vista y escribe la tabla ──
 *
 * El listado necesita el plan, el router, la ONU y la deuda, que viven en cinco
 * tablas distintas: pedirlos por separado serían cinco viajes y una pantalla que
 * se arma de a pedazos. `v_clientes_ficha` ya los trae resueltos.
 *
 * Pero esa vista tiene joins y Postgres no deja escribir sobre ella. Por eso las
 * altas, las ediciones y las bajas van directo a `clientes` y después se
 * recarga. Es la única forma de tener las dos cosas.
 *
 * ── Por qué el estado ya no se edita desde acá ──
 *
 * Porque un desplegable en cada fila invita a cortar a alguien de un clic, y
 * ese cambio no corta nada de verdad: el servicio lo maneja el router. Acá el
 * estado se lee. Se cambia donde se aplica —Cortes/morosos, el alta, la baja—,
 * que es donde además queda registrado por qué.
 */
export default function ClientesPage() {
  const confirmar = useConfirmar()
  const {
    filas: clientes,
    cargando,
    error,
    recargar,
    setError,
  } = useTabla('v_clientes_ficha', { orderBy: 'codigo', ascending: true })

  const [busqueda, setBusqueda] = useState('')
  const [filtroEstado, setFiltroEstado] = useState('')
  const [enFormulario, setEnFormulario] = useState(null)
  const [exportando, setExportando] = useState(false)

  /* Dos filtros que se suman, y son dos cosas distintas:

     · La fila de casillas debajo de los encabezados está SIEMPRE. Es la de
       todos los días: se busca donde se está mirando.
     · El panel de "Seleccionar campo" se abre con el botón. Sirve para filtrar
       por una columna que no se tiene puesta, sin tener que encenderla. */
  const [filtrosCol, setFiltrosCol] = useState({})
  const [filtroAbierto, setFiltroAbierto] = useState(false)
  const [campo, setCampo] = useState('')
  const [valor, setValor] = useState('')

  const [pagina, setPagina] = useState(1)
  const [porPagina, setPorPagina] = useState(() => {
    const n = Number(localStorage.getItem(RECUERDO_PAGINA))
    return CUANTOS.some((c) => c.valor === n) ? n : 15
  })

  useEffect(() => {
    try {
      localStorage.setItem(RECUERDO_PAGINA, String(porPagina))
    } catch {
      // Igual que con las columnas: no poder recordarlo no rompe la pantalla.
    }
  }, [porPagina])

  /* La elección de columnas se recuerda: quien arma su tabla para cobrar no
     tiene por qué volver a armarla cada mañana. */
  const [visibles, setVisibles] = useState(() => {
    try {
      const guardado = JSON.parse(localStorage.getItem(RECUERDO) ?? 'null')
      if (Array.isArray(guardado) && guardado.length) return guardado
    } catch {
      // Un localStorage corrupto no puede dejar la pantalla sin tabla.
    }
    return COLUMNAS_POR_DEFECTO
  })

  useEffect(() => {
    try {
      localStorage.setItem(RECUERDO, JSON.stringify(visibles))
    } catch {
      // Sin espacio o en modo privado: la tabla igual funciona, no se recuerda.
    }
  }, [visibles])

  /* Las cuentas solo se piden si hay alguna columna que las use. Traer las
     facturas de todos para una columna apagada sería un viaje al pedo. */
  const [cuentas, setCuentas] = useState({})
  const hacenFalta = necesitaCuentas(visibles)

  useEffect(() => {
    if (!hacenFalta) return
    let vigente = true

    Promise.all([
      supabase.from('v_facturas_por_cobrar').select('client_id, fecha_vencimiento'),
      supabase.from('pagos').select('client_id, monto').is('factura_id', null).eq('anulado', false),
    ]).then(([f, p]) => {
      if (!vigente) return
      setCuentas(resumirCuentas({ facturas: f.data ?? [], cobrosSinImputar: p.data ?? [] }))
    })

    return () => {
      vigente = false
    }
  }, [hacenFalta])

  const ctx = useMemo(() => ({ cuentas, ahora: new Date() }), [cuentas])

  /* Solo se filtra por las casillas de columnas que están a la vista. Si
     alguien escribe en "Coordenadas" y después apaga esa columna, seguir
     filtrando por ella dejaría una lista recortada por algo que ya no se ve en
     ninguna parte de la pantalla. */
  const filtrosVigentes = useMemo(
    () => Object.fromEntries(Object.entries(filtrosCol).filter(([k]) => visibles.includes(k))),
    [filtrosCol, visibles],
  )

  const filas = useMemo(
    () =>
      filtrarPorCampo(
        filtrarPorColumnas(
          filtrarAbonados(clientes, { busqueda, estado: filtroEstado }),
          filtrosVigentes,
          ctx,
        ),
        { campo, valor },
        ctx,
      ),
    [clientes, busqueda, filtroEstado, filtrosVigentes, campo, valor, ctx],
  )

  /* El orden lo manda el catálogo, no el orden en que se marcaron: si no, la
     tabla se reordena sola cada vez que alguien enciende una columna. */
  const columnas = useMemo(
    () => COLUMNAS_ABONADOS.filter((c) => visibles.includes(c.clave)),
    [visibles],
  )

  /**
   * Cuántos se muestran y en qué página.
   *
   * Volver a la primera cada vez que cambia lo que se está mirando no es un
   * detalle: quedarse en la página 4 de un filtro que ahora devuelve dos
   * abonados muestra una tabla vacía, y eso se lee como "no hay ninguno".
   */
  useEffect(() => setPagina(1), [busqueda, filtroEstado, filtrosVigentes, campo, valor, porPagina])

  /* Y si la lista se achicó por debajo de la página en la que estábamos —se
     borró un abonado, cambió el estado de varios— se retrocede hasta la última
     que existe. Si no, la tabla queda vacía sin motivo aparente. */
  useEffect(() => {
    if (porPagina === TODOS) return
    const ultima = Math.max(1, Math.ceil(filas.length / porPagina))
    setPagina((p) => Math.min(p, ultima))
  }, [filas.length, porPagina])

  const enPantalla = useMemo(() => {
    if (porPagina === TODOS) return filas
    const desde = (pagina - 1) * porPagina
    return filas.slice(desde, desde + porPagina)
  }, [filas, pagina, porPagina])

  const contar = (estado) => clientes.filter((c) => c.estado === estado).length

  /* Solo cuentan las de las columnas que están a la vista: una casilla llena
     bajo una columna que después se apagó no filtra nada, y contarla haría
     prometer un filtro que no existe. */
  const activos = filtrosActivos(filtrosCol, visibles)

  const limpiarFiltro = () => setFiltrosCol({})

  const limpiarPanel = () => {
    setCampo('')
    setValor('')
  }

  const escribir = useCallback(
    async (accion) => {
      try {
        const { error: err } = await accion()
        if (err) throw err
        await recargar()
      } catch (err) {
        setError(err)
      }
    },
    [recargar, setError],
  )

  const borrar = async (c) =>
    (await confirmar(`¿Eliminar a "${c.nombre}" del sistema?`)) &&
    escribir(() => supabase.from('clientes').delete().eq('id', c.id))

  const alternar = (clave) =>
    setVisibles((v) => (v.includes(clave) ? v.filter((x) => x !== clave) : [...v, clave]))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="t-titulo text-lg font-bold text-slate-100">Clientes</h1>
          <p className="text-xs text-slate-500">Abonados registrados en el sistema</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button icon={Download} onClick={() => setExportando(true)}>
            Exportar
          </Button>
          <ConPermiso permiso="clientes.importar" envezDe={null}>
            <Link to="/clientes/importar">
              <Button icon={Upload}>Importar de otro sistema</Button>
            </Link>
          </ConPermiso>
          <ConPermiso permiso="clientes.crear" envezDe={null}>
            <Button variante="primario" icon={Plus} onClick={() => setEnFormulario({})}>
              Nuevo cliente
            </Button>
          </ConPermiso>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {cargando ? (
        <Cargando />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Total" valor={clientes.length} icon={Users} />
            <Stat label="Activos" valor={contar('activo')} color="text-emerald-400" />
            <Stat label="Cortados" valor={contar('cortado')} color="text-red-400" />
            <Stat label="Suspendidos" valor={contar('suspendido')} color="text-amber-400" />
          </div>

          {clientes.length === 0 ? (
            <Aviso>
              Todavía no hay clientes. Podés traerlos desde un MikroTik en la sección{' '}
              <b>Importar</b>, que los busca en los PPPoE, las colas simples, los leases DHCP y las
              listas de cortes.
            </Aviso>
          ) : (
            <Card
              title="Listado"
              icon={Users}
              subtitle={
                filas.length === clientes.length
                  ? `${clientes.length} abonados`
                  : `${filas.length} de ${clientes.length}`
              }
            >
              {/* La barra de la tabla: todo lo que la arma a la izquierda y lo
                  que la busca a la derecha. Van juntos en una sola fila y no en
                  la cabecera de la tarjeta para que el orden sea el mismo en
                  pantalla ancha y en angosta. */}
              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                <MenuMostrar valor={porPagina} onElegir={setPorPagina} />

                <MenuColumnas
                  titulo="Columnas"
                  icono={Columns3}
                  opciones={COLUMNAS_ABONADOS.filter((c) => c.grupo === 'principal')}
                  visibles={visibles}
                  onAlternar={alternar}
                />
                <MenuColumnas
                  titulo="Más columnas"
                  icono={ListPlus}
                  opciones={COLUMNAS_ABONADOS.filter((c) => c.grupo === 'extra')}
                  visibles={visibles}
                  onAlternar={alternar}
                  marcado
                  pie="Las de facturación se calculan con las facturas pendientes y los cobros sin imputar."
                />

                <IconoBoton
                  icono={Filter}
                  etiqueta="Filtrar"
                  ayuda="filtrar por una columna que no tenés puesta"
                  activo={filtroAbierto}
                  marcado={Boolean(campo && valor)}
                  onClick={() => setFiltroAbierto((a) => !a)}
                />

                {/* ── Por qué el ancho va en un div y no en el campo ──

                    `Input` y `Select` traen `w-full` adentro, y en el CSS
                    compilado `.w-full` se define DESPUÉS de `.w-28`, así que
                    gana aunque la clase se escriba después en el JSX: el orden
                    del atributo no decide nada, el del archivo sí. Poner el
                    ancho en un contenedor es lo único que funciona sin tocar el
                    componente, que lo usan otras treinta pantallas. */}
                <div className="w-28 shrink-0">
                  <Select
                    value={filtroEstado}
                    onChange={(e) => setFiltroEstado(e.target.value)}
                    className="py-1.5 text-xs"
                    title="Mostrar solo los abonados en este estado"
                  >
                    <option value="">Todos</option>
                    <option value="activo">Activos</option>
                    <option value="cortado">Cortados</option>
                    <option value="suspendido">Suspendidos</option>
                    <option value="baja">Retirados</option>
                  </Select>
                </div>

                {/* `ml-auto` lo empuja hasta el borde derecho de la fila. */}
                <div className="ml-auto w-56 shrink-0">
                  <Input
                    value={busqueda}
                    onChange={(e) => setBusqueda(e.target.value)}
                    placeholder="Nombre, cédula, ID, IP…"
                    className="py-1.5 text-xs"
                  />
                </div>
              </div>

              {/* El panel del botón: filtrar por una columna que no se tiene
                  puesta, sin tener que encenderla para escribir en su casilla. */}
              {filtroAbierto ? (
                <div className="mb-3 flex flex-wrap items-end gap-2 t-panel p-3">
                  <label className="w-48 text-[11px] uppercase tracking-wide text-slate-500">
                    Seleccionar campo
                    <Select
                      value={campo}
                      onChange={(e) => setCampo(e.target.value)}
                      className="mt-1 py-1.5 text-xs"
                    >
                      <option value="">— elegí uno —</option>
                      {CAMPOS_FILTRO.map((c) => (
                        <option key={c.clave} value={c.clave}>
                          {c.titulo}
                        </option>
                      ))}
                    </Select>
                  </label>

                  <label className="w-56 text-[11px] uppercase tracking-wide text-slate-500">
                    Buscar
                    <Input
                      value={valor}
                      onChange={(e) => setValor(e.target.value)}
                      disabled={!campo}
                      placeholder={
                        campo
                          ? `${CAMPOS_FILTRO.find((c) => c.clave === campo)?.titulo}…`
                          : 'Elegí primero el campo'
                      }
                      className="mt-1 py-1.5 text-xs"
                    />
                  </label>

                  <IconoBoton
                    icono={RotateCcw}
                    etiqueta="Resetear filtro"
                    disabled={!campo && !valor}
                    onClick={limpiarPanel}
                    className="mb-px"
                  />
                </div>
              ) : (
                /* Cerrado pero filtrando: sin esto la lista queda recortada por
                   algo que no se ve en ninguna parte de la pantalla. */
                campo &&
                valor && (
                  <div className="mb-3 flex items-center gap-2 text-xs text-slate-400">
                    <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-sky-300">
                      {CAMPOS_FILTRO.find((c) => c.clave === campo)?.titulo}: {valor}
                      <button
                        type="button"
                        onClick={limpiarPanel}
                        className="text-sky-300/70 hover:text-sky-200"
                        title="Quitar el filtro"
                      >
                        <X size={12} />
                      </button>
                    </span>
                    filtro activo con el panel cerrado
                  </div>
                )
              )}

              <Table
                columnas={[...columnas.map((c) => c.titulo), '']}
                filas={enPantalla}
                vacio="Ningún abonado coincide con el filtro."
                bajoEncabezado={
                  <>
                    {columnas.map((col) => (
                        <th key={col.clave} className="px-2 py-1.5 font-normal">
                          <input
                            value={filtrosCol[col.clave] ?? ''}
                            onChange={(e) =>
                              setFiltrosCol((f) => ({ ...f, [col.clave]: e.target.value }))
                            }
                            placeholder="Busca"
                            title={`Buscar en ${col.titulo}${col.exacto ? ' (coincidencia exacta)' : ''}`}
                            className="w-full min-w-[4.5rem] rounded border border-slate-700 bg-slate-950/60 px-1.5 py-1 text-[11px] font-normal normal-case tracking-normal text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
                          />
                        </th>
                      ))}
                    <th className="px-2 py-1.5">
                      <IconoBoton
                        icono={RotateCcw}
                        etiqueta="Limpiar las búsquedas de las columnas"
                        disabled={activos === 0}
                        onClick={limpiarFiltro}
                        className="!p-1"
                      />
                    </th>
                  </>
                }
                renderFila={(c) => (
                  <Fila
                    key={c.id}
                    c={c}
                    columnas={columnas}
                    ctx={ctx}
                    onBorrar={borrar}
                    onEditar={setEnFormulario}
                  />
                )}
              />

              <Paginador
                total={filas.length}
                pagina={pagina}
                porPagina={porPagina}
                onPagina={setPagina}
              />

              <p className="mt-3 text-[11px] text-slate-500">
                El estado se muestra al lado del nombre y acá no se edita: lo mueven los cortes, el
                alta y la baja, que son las pantallas donde además queda escrito el motivo.
              </p>
            </Card>
          )}
        </>
      )}

      <Modal
        abierto={enFormulario !== null}
        titulo={enFormulario?.id ? `Editar ${enFormulario.nombre}` : 'Nuevo cliente'}
        onCerrar={() => setEnFormulario(null)}
        ancho="max-w-3xl"
      >
        <ClienteForm
          key={enFormulario?.id ?? 'nuevo'}
          cliente={enFormulario?.id ? enFormulario : null}
          onCancelar={() => setEnFormulario(null)}
          onGuardado={async (datos) => {
            await escribir(() =>
              enFormulario?.id
                ? supabase.from('clientes').update(datos).eq('id', enFormulario.id)
                : supabase.from('clientes').insert(datos),
            )
            setEnFormulario(null)
          }}
        />
      </Modal>

      <ExportarAbonados
        abierto={exportando}
        clientes={clientes}
        onCerrar={() => setExportando(false)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * Un botón de barra: solo el icono, con el nombre en el `title`.
 *
 * El `aria-label` va aparte del `title` a propósito. El title es para el mouse;
 * el aria-label es lo que lee un lector de pantalla, que no tiene mouse con el
 * que descubrir para qué sirve un dibujo.
 */
function IconoBoton({ icono: Icono, etiqueta, ayuda, activo, marcado, className = '', ...props }) {
  return (
    <button
      type="button"
      title={ayuda ? `${etiqueta} — ${ayuda}` : etiqueta}
      aria-label={etiqueta}
      {...props}
      className={`relative rounded-lg border p-2 transition disabled:cursor-not-allowed disabled:opacity-40 ${
        activo
          ? 'border-sky-500/40 bg-sky-500/15 text-sky-300'
          : 'border-slate-700 bg-slate-800 text-slate-200 enabled:hover:bg-slate-700'
      } ${className}`}
    >
      <Icono size={16} />
      {marcado && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-sky-400" />}
    </button>
  )
}

/**
 * Un botón que despliega un panel.
 *
 * Se cierra al hacer clic afuera y con Escape. Sin eso queda abierto tapando la
 * tabla, que es justo lo que se está tratando de mirar.
 *
 * El panel se ancla a la izquierda del botón: estos viven pegados al borde
 * izquierdo de la pantalla, y anclarlo a la derecha lo mandaría afuera.
 */
function Desplegable({ etiqueta, ayuda, icono: Icono, marcado, ancho = 'w-64', children }) {
  const [abierto, setAbierto] = useState(false)
  const caja = useRef(null)

  useEffect(() => {
    if (!abierto) return
    const afuera = (e) => !caja.current?.contains(e.target) && setAbierto(false)
    const escape = (e) => e.key === 'Escape' && setAbierto(false)
    document.addEventListener('mousedown', afuera)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', afuera)
      document.removeEventListener('keydown', escape)
    }
  }, [abierto])

  return (
    <div ref={caja} className="relative">
      {/* Solo el icono. El nombre y el estado van en el `title`, que es lo que
          aparece al dejar el mouse encima: con seis controles en la barra, el
          texto de cada uno ocupaba más que la tabla. */}
      <button
        type="button"
        title={ayuda ? `${etiqueta} — ${ayuda}` : etiqueta}
        aria-label={etiqueta}
        onClick={() => setAbierto((a) => !a)}
        className={`relative rounded-lg border p-2 transition ${
          abierto
            ? 'border-sky-500/40 bg-sky-500/15 text-sky-300'
            : 'border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700'
        }`}
      >
        <Icono size={16} />
        {/* Un punto, no un número: dice "acá hay algo puesto" sin ocupar
            lugar. Sin él, un filtro o unas columnas activas no se notan. */}
        {marcado && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-sky-400" />
        )}
      </button>

      {abierto && (
        <div
          onClick={(e) => e.target.closest('button') && setAbierto(false)}
          className={`absolute left-0 z-30 mt-1 max-h-[70vh] ${ancho} overflow-y-auto t-card p-1.5 shadow-xl`}
        >
          {children}
        </div>
      )}
    </div>
  )
}

/** Cuántos abonados se muestran de una vez. */
function MenuMostrar({ valor, onElegir }) {
  const actual = CUANTOS.find((c) => c.valor === valor)

  return (
    <Desplegable
      etiqueta="Mostrar"
      ayuda={`cuántos por página (${actual?.label ?? ''})`}
      icono={Rows3}
      ancho="w-44"
    >
      {CUANTOS.map((c) => (
        <button
          key={c.valor}
          type="button"
          onClick={() => onElegir(c.valor)}
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-slate-800 ${
            c.valor === valor ? 'text-sky-300' : 'text-slate-300'
          }`}
        >
          <span className="w-3">{c.valor === valor && <Check size={11} />}</span>
          {c.label}
        </button>
      ))}
    </Desplegable>
  )
}

/** Qué columnas se ven. */
function MenuColumnas({ titulo, icono, opciones, visibles, onAlternar, pie, marcado }) {
  const encendidas = opciones.filter((o) => visibles.includes(o.clave)).length

  return (
    <Desplegable
      etiqueta={titulo}
      ayuda={`${encendidas} de ${opciones.length} puestas`}
      icono={icono}
      marcado={marcado ? encendidas > 0 : undefined}
    >
      <div onClick={(e) => e.stopPropagation()}>
          {opciones.map((o) => {
            const puesta = visibles.includes(o.clave)
            return (
              <button
                key={o.clave}
                type="button"
                disabled={o.fija}
                onClick={() => onAlternar(o.clave)}
                title={o.fija ? 'El nombre no se puede sacar: es por donde se abre la ficha.' : undefined}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${
                  o.fija ? 'cursor-default text-slate-500' : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    puesta ? 'border-sky-500 bg-sky-500/20 text-sky-300' : 'border-slate-700'
                  }`}
                >
                  {puesta && <Check size={11} />}
                </span>
                {o.titulo}
              </button>
            )
          })}
          {pie && (
            <p className="mt-1 border-t border-slate-800 px-2 pt-1.5 text-[10px] leading-snug text-slate-500">
              {pie}
            </p>
          )}
      </div>
    </Desplegable>
  )
}

// ---------------------------------------------------------------------------

/**
 * Cuántos se están viendo y de cuántos.
 *
 * La frase completa —"del 1 al 15 de un total de 87"— y no solo el número de
 * página: es lo que evita que alguien mire quince filas y crea que ese es todo
 * su padrón.
 *
 * Con pocas páginas se listan todas; con muchas se muestra una ventana
 * alrededor de la actual, porque doscientos botones no ayudan a nadie.
 */
function Paginador({ total, pagina, porPagina, onPagina }) {
  if (porPagina === TODOS || total === 0) {
    return total === 0 ? null : (
      <p className="mt-3 text-[11px] text-slate-500">Mostrando los {total} abonados.</p>
    )
  }

  const paginas = Math.max(1, Math.ceil(total / porPagina))
  const desde = (pagina - 1) * porPagina + 1
  const hasta = Math.min(pagina * porPagina, total)

  const ventana = []
  for (let p = Math.max(1, pagina - 2); p <= Math.min(paginas, pagina + 2); p++) ventana.push(p)

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <p className="text-[11px] text-slate-500">
        Mostrando del {desde} al {hasta} de un total de {total}
      </p>

      {paginas > 1 && (
        <div className="flex items-center gap-1">
          <Paso icono={ChevronLeft} disabled={pagina === 1} onClick={() => onPagina(pagina - 1)} />
          {ventana[0] > 1 && (
            <>
              <NumPagina n={1} actual={pagina} onClick={onPagina} />
              {ventana[0] > 2 && <span className="px-1 text-slate-600">…</span>}
            </>
          )}
          {ventana.map((p) => (
            <NumPagina key={p} n={p} actual={pagina} onClick={onPagina} />
          ))}
          {ventana.at(-1) < paginas && (
            <>
              {ventana.at(-1) < paginas - 1 && <span className="px-1 text-slate-600">…</span>}
              <NumPagina n={paginas} actual={pagina} onClick={onPagina} />
            </>
          )}
          <Paso
            icono={ChevronRight}
            disabled={pagina === paginas}
            onClick={() => onPagina(pagina + 1)}
          />
        </div>
      )}
    </div>
  )
}

const NumPagina = ({ n, actual, onClick }) => (
  <button
    type="button"
    onClick={() => onClick(n)}
    className={`min-w-[1.75rem] rounded-lg px-2 py-1 text-xs transition ${
      n === actual
        ? 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30'
        : 'text-slate-400 hover:bg-slate-800'
    }`}
  >
    {n}
  </button>
)

const Paso = ({ icono: Icono, disabled, onClick }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className="rounded-lg p-1.5 text-slate-400 transition enabled:hover:bg-slate-800 disabled:opacity-30"
  >
    <Icono size={14} />
  </button>
)

// ---------------------------------------------------------------------------

function Fila({ c, columnas, ctx, onBorrar, onEditar }) {
  return (
    <tr className="text-slate-300">
      {columnas.map((col) => (
        <td
          key={col.clave}
          className={[
            'px-3 py-2',
            col.mono ? 'font-mono text-[11px]' : 'text-xs',
            col.centro ? 'text-center' : '',
            col.derecha ? 'text-right' : '',
            col.ancho ? 'max-w-[16rem] truncate' : '',
          ].join(' ')}
          title={col.ancho ? col.texto(c, ctx) : undefined}
        >
          <Celda col={col} c={c} ctx={ctx} />
        </td>
      ))}

      <td className="px-3 py-2">
        <div className="flex justify-end gap-1">
          <Link
            to={`/clientes/${c.id}`}
            className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
            title="Abrir la ficha completa"
          >
            <ExternalLink size={15} />
          </Link>
          <ConPermiso permiso="clientes.editar" envezDe={null}>
            <Button variante="fantasma" icon={Pencil} title="Editar" onClick={() => onEditar(c)} />
          </ConPermiso>
          <ConPermiso permiso="clientes.eliminar" envezDe={null}>
            <Button variante="fantasma" icon={Trash2} onClick={() => onBorrar(c)} />
          </ConPermiso>
        </div>
      </td>
    </tr>
  )
}

/**
 * Lo que se pinta en cada celda.
 *
 * Casi todas son el texto que ya calculó el catálogo. Las cuatro que no lo son
 * están acá y no allá porque son JSX: el nombre abre la ficha, el estado y el
 * enlace son etiquetas de color, y la deuda se pinta en rojo solo si la hay.
 */
function Celda({ col, c, ctx }) {
  const texto = col.texto(c, ctx)

  if (col.clave === 'nombre') {
    const e = ESTADO[c.estado] ?? { label: c.estado, color: 'gris' }
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <Link
          to={`/clientes/${c.id}`}
          className="font-medium text-slate-100 hover:text-sky-400 hover:underline"
        >
          {c.nombre}
        </Link>
        <Badge color={e.color}>{e.label}</Badge>
      </div>
    )
  }

  if (col.clave === 'estatus') {
    const link = enlace(c)
    return link ? <Badge color={link.color}>{link.texto}</Badge> : <span className="text-slate-600">—</span>
  }

  if (col.clave === 'cedula' && !texto) {
    return (
      <span className="text-amber-400" title="Sin identificación no se puede facturar">
        falta
      </span>
    )
  }

  if ((col.clave === 'deuda' || col.clave === 'total_cobrar') && Number(texto) > 0) {
    return <span className="font-medium text-red-400">{texto}</span>
  }

  if (col.clave === 'fecha_suspendido' && texto) {
    return (
      <span title={`Lleva ${antiguedad(c.estado_desde, ctx.ahora)}`}>
        {texto}
        <span className="ml-1 text-slate-600">({antiguedad(c.estado_desde, ctx.ahora)})</span>
      </span>
    )
  }

  return texto ? <>{texto}</> : <span className="text-slate-600">—</span>
}

// ---------------------------------------------------------------------------

/**
 * El archivo para salir a recuperar.
 *
 * Dos modos porque son dos preguntas: por antigüedad se arma la ruta de visitas
 * —"los que llevan dos meses o más"— y por rango se mide un mes cerrado. La
 * cuenta se muestra antes de descargar: bajar un archivo vacío y abrirlo para
 * enterarse es la peor forma de decir que no hay nadie.
 */
function ExportarAbonados({ abierto, clientes, onCerrar }) {
  const [modo, setModo] = useState('antiguedad')
  const [estado, setEstado] = useState('suspendido')
  const [meses, setMeses] = useState(2)
  const [desde, setDesde] = useState('')
  const [hasta, setHasta] = useState('')

  const criterio = { modo, estado, meses, desde, hasta }
  const elegidos = useMemo(
    () => (abierto ? seleccionarParaExportar(clientes, criterio) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [abierto, clientes, modo, estado, meses, desde, hasta],
  )

  function descargar() {
    const ahora = new Date()
    const blob = new Blob(['﻿' + aCSV(elegidos, ahora, COLUMNAS_EXPORT)], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = nombreArchivo(criterio, ahora)
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    onCerrar()
  }

  return (
    <Modal abierto={abierto} titulo="Exportar abonados" onCerrar={onCerrar} ancho="max-w-xl">
      <div className="space-y-4">
        <div className="flex gap-1.5">
          {[
            { clave: 'antiguedad', label: 'Por antigüedad' },
            { clave: 'rango', label: 'Por fechas' },
          ].map((m) => (
            <button
              key={m.clave}
              type="button"
              onClick={() => setModo(m.clave)}
              className={`rounded-lg px-3 py-1.5 text-xs transition ${
                modo === m.clave
                  ? 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30'
                  : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-slate-400">
            Estado
            <Select value={estado} onChange={(e) => setEstado(e.target.value)} className="mt-1">
              <option value="suspendido">Suspendidos</option>
              <option value="cortado">Cortados</option>
              <option value="activo">Activos</option>
              <option value="baja">Retirados</option>
              <option value="">Todos</option>
            </Select>
          </label>

          {modo === 'antiguedad' ? (
            <label className="text-xs text-slate-400">
              Llevan al menos
              <Select
                value={meses}
                onChange={(e) => setMeses(Number(e.target.value))}
                className="mt-1"
              >
                <option value={0}>cualquier antigüedad</option>
                <option value={1}>1 mes</option>
                <option value={2}>2 meses</option>
                <option value={3}>3 meses</option>
                <option value={6}>6 meses</option>
                <option value={12}>un año</option>
              </Select>
            </label>
          ) : (
            <>
              <label className="text-xs text-slate-400">
                Desde
                <Input
                  type="date"
                  value={desde}
                  onChange={(e) => setDesde(e.target.value)}
                  className="mt-1"
                />
              </label>
              <label className="text-xs text-slate-400">
                Hasta
                <Input
                  type="date"
                  value={hasta}
                  onChange={(e) => setHasta(e.target.value)}
                  className="mt-1"
                />
              </label>
            </>
          )}
        </div>

        <div className="t-panel p-3 text-xs text-slate-400">
          {modo === 'antiguedad' ? (
            <>
              Los que están <b>{estado ? (ESTADO[estado]?.label ?? estado) : 'en cualquier estado'}</b>
              {Number(meses) > 0 ? ` desde hace ${meses} ${meses === 1 ? 'mes' : 'meses'} o más` : ''}
              , del más viejo al más nuevo.
            </>
          ) : (
            <>
              Los que quedaron{' '}
              <b>{estado ? (ESTADO[estado]?.label ?? estado) : 'en cualquier estado'}</b> entre{' '}
              <b>{desde || 'el principio'}</b> y <b>{hasta || 'hoy'}</b>.
            </>
          )}
          <div className="mt-1 text-slate-200">
            {elegidos.length === 0
              ? 'No hay ninguno que cumpla eso.'
              : `${elegidos.length} ${elegidos.length === 1 ? 'abonado' : 'abonados'}.`}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variante="secundario" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variante="primario"
            icon={Download}
            onClick={descargar}
            disabled={elegidos.length === 0}
          >
            Descargar CSV
          </Button>
        </div>
      </div>
    </Modal>
  )
}
