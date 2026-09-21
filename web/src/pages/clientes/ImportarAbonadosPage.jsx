import { useEffect, useState } from 'react'
import {
  AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, Download, FileUp, Minus, Plus, Router,
  Upload,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, Card, ErrorBanner, Field, Input, Select } from '../../components/ui'

/**
 * Traer la base de abonados de otro sistema.
 *
 * ── Por qué son dos columnas y no un asistente de cinco pasos ──
 *
 * Porque son dos trabajos distintos, con días distintos en el medio. A la
 * izquierda se arma la plantilla para un router; después alguien la llena —eso
 * puede llevar una tarde o una semana— y recién ahí, a la derecha, se sube.
 * Encadenarlos en un solo asistente obligaría a rehacer las elecciones del
 * principio cada vez que se vuelve a la pantalla.
 *
 * ── Por qué el router se elige al GENERAR y no al importar ──
 *
 * Porque el mismo archivo se sube más de una vez: una prueba, una corrección, el
 * que mandó otra persona. Si el router se preguntara al subir, basta que una de
 * esas veces se conteste distinto para que media base quede colgada del router
 * equivocado — y eso se descubre cuando el corte por mora no funciona. Yendo
 * adentro del archivo, subirlo dos veces da lo mismo dos veces.
 */
export default function ImportarAbonadosPage() {
  const [opciones, setOpciones] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.migracion.opciones().then(setOpciones).catch(setError)
  }, [])

  return (
    <div className="space-y-4">
      <Link to="/clientes" className="inline-flex items-center gap-1 text-sm text-slate-400">
        <ArrowLeft size={15} /> Volver a los abonados
      </Link>

      <div>
        <h1 className="text-lg font-semibold text-slate-100">Importar de otro sistema</h1>
        <p className="mt-0.5 max-w-3xl text-xs leading-snug text-slate-500">
          Generá la plantilla para un router, llenala con tus abonados y subila. También podés subir
          directamente el archivo que exporta tu sistema actual, en Excel o en CSV.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <GenerarFormato opciones={opciones} />
        <ImportarClientes opciones={opciones} />
      </div>
    </div>
  )
}

/** Un paso numerado, como el formulario de un trámite. */
function Paso({ n, titulo, children, ultimo = false }) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-sky-700 bg-slate-900 text-xs text-sky-300">
          {n}
        </span>
        {/* La línea que une los pasos: es lo que hace leer la columna como una
            secuencia y no como cinco campos sueltos. */}
        {!ultimo && <span className="mt-1 w-px flex-1 bg-slate-800" />}
      </div>
      <div className="min-w-0 flex-1 pb-5">
        <p className="mb-1.5 text-xs font-medium text-sky-300">{titulo}</p>
        {children}
      </div>
    </div>
  )
}

/** Un bloque de campos que arranca cerrado, para no llenar la pantalla. */
function Desplegable({ abierto, onCambiar, children, resumen }) {
  return (
    <div>
      <button
        type="button"
        onClick={() => onCambiar(!abierto)}
        className="flex items-center gap-1.5 rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
      >
        {abierto ? <Minus size={12} /> : <Plus size={12} />}
        {abierto ? 'Ocultar' : resumen}
      </button>
      {abierto && <div className="mt-2 grid gap-3 sm:grid-cols-2">{children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel izquierdo: armar la plantilla
// ---------------------------------------------------------------------------

function GenerarFormato({ opciones }) {
  const [routerId, setRouterId] = useState('')
  const [tipoConexion, setTipoConexion] = useState('ip')
  const [planId, setPlanId] = useState('')
  const [verFacturacion, setVerFacturacion] = useState(false)
  const [verNotificaciones, setVerNotificaciones] = useState(false)
  const [generando, setGenerando] = useState(false)
  const [error, setError] = useState(null)

  const [facturacion, setFacturacion] = useState({
    modalidad_pago: 'prepago',
    dia_generar_factura: '',
    dias_gracia: '',
    factura_electronica: false,
    cortar_tras_meses: 1,
  })
  const [notificaciones, setNotificaciones] = useState({ canal_preferido: 'whatsapp' })

  const cambiarF = (campo, valor) => setFacturacion((f) => ({ ...f, [campo]: valor }))

  async function generar() {
    setGenerando(true)
    setError(null)
    try {
      const blob = await api.migracion.plantilla({
        router_id: routerId,
        plan_id: planId || null,
        tipo_conexion: tipoConexion,
        facturacion: {
          ...facturacion,
          dia_generar_factura: facturacion.dia_generar_factura || null,
          dias_gracia: facturacion.dias_gracia === '' ? null : Number(facturacion.dias_gracia),
        },
        notificaciones,
      })

      const nombre = opciones?.routers.find((r) => r.id === routerId)?.nombre ?? 'padron'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `padron-${nombre.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err)
    } finally {
      setGenerando(false)
    }
  }

  const conexion = opciones?.tipos_conexion?.find((t) => t.valor === tipoConexion)

  return (
    <Card title="Generar formato">
      <div className="p-4">
        <Aviso>
          Antes de generar la plantilla, registrá el router en{' '}
          <b>Red → Routers</b> y creá los planes de velocidad en <b>Servicios → Planes</b>.
        </Aviso>

        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <div className="mt-4">
          {/* El router es el único paso sin el que la plantilla no sirve: es lo
              que ata a cada abonado con el equipo que lo corta y lo limita. */}
          <Paso n={1} titulo="Router">
            <Select value={routerId} onChange={(e) => setRouterId(e.target.value)}>
              <option value="">Elegí el router…</option>
              {(opciones?.routers ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.nombre}
                  {r.ip_host ? ` · ${r.ip_host}` : ''}
                  {r.activo === false ? ' (inactivo)' : ''}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              Todos los abonados de esta plantilla van a quedar en este router. El router viaja
              adentro del archivo: si lo subís dos veces, van al mismo lado las dos veces.
            </p>
          </Paso>

          <Paso n={2} titulo="Tipo de conexión">
            <Select value={tipoConexion} onChange={(e) => setTipoConexion(e.target.value)}>
              {(opciones?.tipos_conexion ?? []).map((t) => (
                <option key={t.valor} value={t.valor}>
                  {t.titulo}
                </option>
              ))}
            </Select>
            {conexion && (
              <p className="mt-1 text-[11px] leading-snug text-slate-500">{conexion.ayuda}</p>
            )}
          </Paso>

          {/* Acá va el plan y no un "control de velocidad" suelto: en este
              sistema el caudal lo define el plan —y el plan sabe si lo aplica la
              OLT o el MikroTik—, así que elegir las dos cosas por separado
              dejaría que se contradigan. */}
          <Paso n={3} titulo="Plan por defecto">
            <Select value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">Sin plan por defecto</option>
              {(opciones?.planes ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre} · ${p.precio} ·{' '}
                  {p.control_pppoe === 'olt' ? 'velocidad en la OLT' : 'velocidad en el MikroTik'}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              Se usa en las filas que dejen la columna Plan vacía. Si tu planilla trae el plan de
              cada abonado, ese manda.
            </p>
          </Paso>

          <Paso n={4} titulo="Facturación">
            <Desplegable
              abierto={verFacturacion}
              onCambiar={setVerFacturacion}
              resumen={`${facturacion.modalidad_pago}${Number(facturacion.cortar_tras_meses) > 0 ? ` · corta a los ${facturacion.cortar_tras_meses} meses` : ' · sin corte'}`}
            >
              <Field label="Modalidad">
                <Select
                  value={facturacion.modalidad_pago}
                  onChange={(e) => cambiarF('modalidad_pago', e.target.value)}
                >
                  {(opciones?.modalidades ?? []).map((m) => (
                    <option key={m.valor} value={m.valor}>
                      {m.titulo}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Día que se genera la factura" hint="del 1 al 28; vacío = el del sistema">
                <Input
                  type="number"
                  min={1}
                  max={28}
                  value={facturacion.dia_generar_factura}
                  onChange={(e) => cambiarF('dia_generar_factura', e.target.value)}
                />
              </Field>

              <Field label="Días de gracia" hint="antes de cortar por mora">
                <Input
                  type="number"
                  min={0}
                  value={facturacion.dias_gracia}
                  onChange={(e) => cambiarF('dias_gracia', e.target.value)}
                />
              </Field>

              <div className="space-y-2 pt-5">
                <Field label="Aplica corte" hint="A los cuántos meses de atraso se les corta">
                  <Select
                    value={String(facturacion.cortar_tras_meses)}
                    onChange={(e) => cambiarF('cortar_tras_meses', Number(e.target.value))}
                  >
                    <option value="0">No cortar nunca</option>
                    {[1, 2, 3, 4, 5, 6, 8, 10, 12].map((m) => (
                      <option key={m} value={m}>
                        {m} {m === 1 ? 'mes vencido' : 'meses vencidos'}
                      </option>
                    ))}
                  </Select>
                </Field>
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={facturacion.factura_electronica}
                    onChange={(e) => cambiarF('factura_electronica', e.target.checked)}
                  />
                  Emitirles factura electrónica
                </label>
              </div>
            </Desplegable>
          </Paso>

          <Paso n={5} titulo="Notificaciones">
            <Desplegable
              abierto={verNotificaciones}
              onCambiar={setVerNotificaciones}
              resumen={`por ${notificaciones.canal_preferido}`}
            >
              <Field label="Por dónde avisarles" hint="se puede cambiar después, abonado por abonado">
                <Select
                  value={notificaciones.canal_preferido}
                  onChange={(e) => setNotificaciones({ canal_preferido: e.target.value })}
                >
                  {(opciones?.canales ?? []).map((c) => (
                    <option key={c.valor} value={c.valor}>
                      {c.titulo}
                    </option>
                  ))}
                </Select>
              </Field>
            </Desplegable>
          </Paso>

          <Paso n={6} titulo="Descargar" ultimo>
            <Button
              variante="primario"
              icon={Download}
              cargando={generando}
              disabled={!routerId}
              onClick={generar}
            >
              Generar plantilla
            </Button>
            {!routerId && (
              <p className="mt-1 text-[11px] text-slate-500">Elegí primero el router.</p>
            )}
          </Paso>
        </div>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Panel derecho: subir el archivo
// ---------------------------------------------------------------------------

/**
 * El archivo, en base64.
 *
 * Se manda tal cual llegó y no como texto: un .xlsx es binario, y leerlo con
 * `f.text()` lo destruye. Y aun con un CSV, dejar que el navegador lo decodifique
 * asume UTF-8 — el que sale de Excel en Windows viene en Latin-1 y "OÑA RIERA"
 * llegaría roto. Los bytes viajan intactos y el middleware, que sabe distinguir,
 * los interpreta.
 */
async function aBase64(f) {
  const bytes = new Uint8Array(await f.arrayBuffer())
  let binario = ''
  // De a pedazos: pasarle 300.000 bytes de una a `String.fromCharCode` revienta
  // la pila del navegador, y un padrón entero llega a ese tamaño sin esfuerzo.
  for (let i = 0; i < bytes.length; i += 8192) {
    binario += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binario)
}

function ImportarClientes({ opciones }) {
  const [archivo, setArchivo] = useState(null)
  const [base64, setBase64] = useState('')
  const [sistema, setSistema] = useState('mikrowisp')
  const [routerId, setRouterId] = useState('')
  const [revision, setRevision] = useState(null)
  const [hecho, setHecho] = useState(null)
  const [error, setError] = useState(null)
  const [trabajando, setTrabajando] = useState(false)

  async function elegir(e) {
    const f = e.target.files?.[0]
    if (!f) return
    setError(null)
    setRevision(null)
    setHecho(null)
    setArchivo(f)
    setBase64(await aBase64(f))
  }

  const correr = async (aplicar, router = routerId) => {
    setTrabajando(true)
    setError(null)
    try {
      const datos = {
        archivo: { nombre: archivo?.name, base64 },
        sistema_origen: sistema,
        // Solo hace falta cuando el archivo no lo trae. Lo que diga el archivo
        // manda sobre esto.
        ajustes: router ? { router_id: router } : undefined,
      }
      const r = aplicar
        ? await api.migracion.importarAbonados(datos)
        : await api.migracion.revisarAbonados(datos)
      if (aplicar) setHecho(r)
      else setRevision(r)
    } catch (err) {
      setError(err)
    } finally {
      setTrabajando(false)
    }
  }

  /**
   * Elegir el router rehace la revisión.
   *
   * Si no, la pantalla seguiría mostrando "falta el router" con el router ya
   * elegido, y el botón de importar quedaría apagado sin motivo visible.
   */
  function elegirRouter(id) {
    setRouterId(id)
    if (id && revision) correr(false, id)
  }

  if (hecho) {
    return (
      <Card title="Importación terminada">
        <div className="space-y-2 p-4 text-sm">
          <p className="font-medium text-emerald-300">
            {hecho.importados} abonados importados
            {hecho.facturas_de_saldo > 0 && ` · ${hecho.facturas_de_saldo} con su saldo anterior`}
            {hecho.onus_vinculadas > 0 && ` · ${hecho.onus_vinculadas} enganchados con su ONT`}
          </p>
          {hecho.comunes?.router && (
            <p className="text-xs text-slate-400">
              <Router size={12} className="mr-1 inline" />
              Quedaron en el router <b className="text-slate-200">{hecho.comunes.router}</b>
            </p>
          )}
          {hecho.salteados > 0 && (
            <p className="text-xs text-amber-400">
              {hecho.salteados} filas se saltearon por tener problemas.
            </p>
          )}
          {hecho.fallidos?.length > 0 && (
            <div className="text-xs text-rose-400">
              {hecho.fallidos.map((f) => (
                <p key={f.fila}>
                  Fila {f.fila} · {f.nombre}: {f.motivo}
                </p>
              ))}
            </div>
          )}
          {hecho.aviso && <Aviso tipo="alerta">{hecho.aviso}</Aviso>}
          <div className="flex gap-2 pt-1">
            <Link to="/clientes">
              <Button variante="primario">Ver los abonados</Button>
            </Link>
            <Button variante="fantasma" onClick={() => { setHecho(null); setArchivo(null); setBase64('') }}>
              Importar otro archivo
            </Button>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card title="Importar clientes">
      <div className="p-4">
        {/* No es una formalidad: importar mal quinientos abonados no se deshace
            fila por fila, y el respaldo es lo único que lo revierte. */}
        <Aviso tipo="alerta">
          Antes de importar, generá un respaldo de la base de datos y de tu MikroTik, para poder
          revertir cualquier cambio no deseado.
        </Aviso>

        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <div className="mt-4">
          <Paso n={1} titulo="Plantilla">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs text-slate-100 hover:bg-slate-700">
              <FileUp size={13} />
              Seleccionar plantilla
              <input
                type="file"
                accept=".csv,.txt,.tsv,.xlsx,.xlsm,text/csv"
                onChange={elegir}
                className="hidden"
              />
            </label>
            {archivo && (
              <p className="mt-1.5 text-[11px] text-slate-400">
                {archivo.name} · {Math.round(archivo.size / 1024)} KB
              </p>
            )}
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              La plantilla que generaste acá, o el archivo que exporta tu sistema actual (Excel o
              CSV).
            </p>
          </Paso>

          <Paso n={2} titulo="Importar" ultimo>
            <div className="space-y-3">
              <Field label="De qué sistema viene" hint="para no mezclar identificadores de dos ISPs">
                <Input
                  value={sistema}
                  onChange={(e) => setSistema(e.target.value)}
                  placeholder="mikrowisp"
                  className="max-w-xs"
                />
              </Field>

              {/* Solo aparece cuando el archivo no trae router adentro: es el
                  caso del export de otro sistema, que no sabe nada del nuestro.
                  Se pide DESPUÉS de leer el archivo porque antes no se sabe si
                  hace falta — la plantilla generada acá ya lo trae. */}
              {revision && !revision.comunes?.viene_del_archivo && (
                <Field
                  label="A qué router pertenecen"
                  hint="este archivo no lo trae adentro; la plantilla generada acá sí"
                >
                  <Select
                    value={routerId}
                    onChange={(e) => elegirRouter(e.target.value)}
                    className="max-w-xs"
                  >
                    <option value="">Elegí el router…</option>
                    {(opciones?.routers ?? []).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.nombre}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  icon={FileUp}
                  cargando={trabajando && !revision}
                  disabled={!archivo}
                  onClick={() => correr(false)}
                >
                  Ver qué se va a importar
                </Button>
              </div>
              <p className="text-[11px] text-slate-500">
                Este proceso puede tardar algunos minutos.
              </p>
            </div>
          </Paso>
        </div>

        {revision && (
          <Revision
            revision={revision}
            trabajando={trabajando}
            onAplicar={() => correr(true)}
            onVolver={() => setRevision(null)}
          />
        )}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// La revisión, que es lo que se mira antes de apretar el botón
// ---------------------------------------------------------------------------

function Revision({ revision, trabajando, onAplicar, onVolver }) {
  const [soloProblemas, setSoloProblemas] = useState(true)
  const [abierta, setAbierta] = useState(false)
  const r = revision.resumen
  // "Lo que hay que mirar" son las dos cosas: lo que impide importar la fila y lo
  // que la va a importar mal. Mostrar solo lo primero escondería justamente los
  // avisos que después no se pueden deshacer.
  const visibles = soloProblemas
    ? revision.filas.filter((f) => f.problemas.length || f.avisos?.length)
    : revision.filas

  return (
    <div className="mt-4 space-y-3 border-t border-slate-800 pt-4">
      {/* Sin router el abonado queda cargado y sin existir para el sistema: no
          se corta por mora, no se le sube la cola, no aparece en ningún tablero. */}
      {revision.comunes?.falta_router && (
        <Aviso tipo="alerta">
          <AlertTriangle size={14} className="mr-1 inline" />
          Este archivo no dice a qué router pertenecen estos abonados. Elegilo arriba antes de
          importar: sin router no se les aplica el corte por mora ni aparecen en el tablero del
          equipo.
        </Aviso>
      )}

      {/* Adónde van. Es la línea que hay que leer antes que ninguna otra. */}
      {revision.comunes?.router && (
        <div className="rounded-lg border border-sky-900/60 bg-sky-950/30 p-3 text-xs text-slate-300">
          <Router size={13} className="mr-1 inline text-sky-400" />
          Van al router <b className="text-slate-100">{revision.comunes.router}</b>
          {revision.comunes.plan && <> · plan por defecto <b>{revision.comunes.plan}</b></>}
          {revision.comunes.tipo_conexion && <> · conexión <b>{revision.comunes.tipo_conexion}</b></>}
          <p className="mt-0.5 text-[11px] text-slate-500">
            {revision.comunes.viene_del_archivo
              ? 'Viene adentro del archivo, así que volver a subirlo da lo mismo.'
              : 'Lo elegiste acá: si volvés a subir este archivo, acordate de elegir el mismo.'}
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metrica titulo="Se crean" valor={r.se_crean} color="text-emerald-400" />
        <Metrica titulo="Se actualizan" valor={r.se_actualizan} />
        <Metrica
          titulo="Con problemas"
          valor={r.con_problemas}
          color={r.con_problemas ? 'text-amber-400' : undefined}
        />
        <Metrica titulo="Con deuda" valor={r.con_deuda} ayuda={`$${r.deuda_total} en total`} />
      </div>

      {/* Cada columna que no se entendió puede ser un dato importante con un
          nombre inesperado. Se listan en vez de descartarlas en silencio. */}
      {revision.sin_reconocer?.length > 0 && (
        <Aviso>
          No se reconocieron estas columnas y no se van a importar:{' '}
          <b>{revision.sin_reconocer.join(', ')}</b>. Si alguna importa, decinos cómo se llama y la
          agregamos.
        </Aviso>
      )}

      {r.sin_plan > 0 && (
        <Aviso tipo="alerta">
          {r.sin_plan} abonados traen un plan que no existe en el sistema. Esas filas no se importan:
          creá esos planes primero, o el abonado quedaría sin velocidad ni precio.
        </Aviso>
      )}

      {/* Lo que no se puede reconstruir después de migrar. */}
      {r.sin_instalacion > 0 && (
        <Aviso tipo="alerta">
          <AlertTriangle size={14} className="mr-1 inline" />
          {r.sin_instalacion} abonados vienen <b>sin fecha de instalación</b>. Se pueden importar
          igual, pero esa antigüedad no se recupera después.
        </Aviso>
      )}

      {/* El aviso que evita la mañana mala. */}
      {r.sin_ultimo_pago > 0 && (
        <Aviso tipo="alerta">
          <AlertTriangle size={14} className="mr-1 inline" />
          {r.sin_ultimo_pago} abonados vienen <b>sin fecha de último pago</b>. Para el sistema van a
          ser morosos desde el día en que se instalaron, y la cartera les va a abrir orden de retiro
          la primera noche.
        </Aviso>
      )}

      {(r.con_onu > 0 || r.serie_sin_onu > 0) && (
        <Aviso>
          {r.con_onu > 0 && (
            <>
              <b>{r.con_onu}</b> quedan enganchados con su ONT por número de serie
              {r.serie_sin_onu > 0 && '. '}
            </>
          )}
          {r.serie_sin_onu > 0 && (
            <>
              <b>{r.serie_sin_onu}</b> traen una serie que no está en la OLT: esos quedan sin ONT
              asociada y hay que vincularlos a mano.
            </>
          )}
        </Aviso>
      )}

      {r.a_favor > 0 && (
        <Aviso tipo="alerta">
          <AlertTriangle size={14} className="mr-1 inline" />
          {r.a_favor} abonados traen saldo <b>a favor</b> y no se va a importar. Eso es plata que ya
          entregaron: hay que cargarla como pago, con su fecha y forma de cobro.
        </Aviso>
      )}

      {r.con_deuda > 0 && (
        <Aviso>
          Los {r.con_deuda} con deuda —${r.deuda_total} en total— van a quedar con una{' '}
          <b>factura de saldo anterior</b>, que se cobra y aparece en su estado de cuenta como
          cualquier otra. No se crea dos veces si reimportás.
        </Aviso>
      )}

      <div className="rounded-lg border border-slate-800">
        <button
          type="button"
          onClick={() => setAbierta(!abierta)}
          className="flex w-full items-center justify-between px-3 py-2 text-xs text-slate-300"
        >
          <span className="flex items-center gap-1.5">
            {abierta ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            Ver el detalle de las {revision.filas.length} filas
          </span>
          {r.con_problemas + r.con_avisos > 0 && (
            <Badge color="ambar">{r.con_problemas + r.con_avisos} para mirar</Badge>
          )}
        </button>

        {abierta && (
          <div className="border-t border-slate-800">
            <div className="flex items-center justify-end px-3 pt-2 text-xs text-slate-400">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={soloProblemas}
                  onChange={(e) => setSoloProblemas(e.target.checked)}
                />
                ver solo las que hay que mirar
              </label>
            </div>
            <div className="max-h-80 overflow-auto p-3 pt-2">
              <table className="w-full text-xs">
                <tbody>
                  {visibles.length === 0 ? (
                    <tr>
                      <td className="py-6 text-center text-slate-500">
                        Ninguna fila tiene nada que mirar.
                      </td>
                    </tr>
                  ) : (
                    visibles.map((f) => (
                      <tr key={f.fila} className="border-b border-slate-800/60 align-top last:border-0">
                        {/* El número de línea de la planilla: es lo que permite
                            ir a corregirla sin buscar por nombre entre quinientas. */}
                        <td className="py-1 pr-2 text-slate-600">L{f.fila}</td>
                        <td className="py-1 pr-2 font-mono text-slate-400">
                          {f.codigo_externo ?? '—'}
                        </td>
                        <td className="py-1 pr-2 text-slate-200">
                          {f.nombre || '(sin nombre)'}
                          {f.fecha_instalacion && (
                            <span className="ml-1.5 text-[11px] text-slate-600">
                              desde {f.fecha_instalacion}
                            </span>
                          )}
                        </td>
                        <td className="py-1 pr-2">
                          {f.deuda ? <Badge color="ambar">debe ${f.deuda}</Badge> : null}
                          {f.a_favor ? <Badge color="azul">a favor ${f.a_favor}</Badge> : null}
                          {f.onu_id ? <Badge color="verde">ONT</Badge> : null}
                        </td>
                        <td className="py-1">
                          {/* Los problemas frenan la fila; los avisos la dejan
                              pasar pero cambian lo que va a quedar cargado. */}
                          {f.problemas.length > 0 && (
                            <span className="text-rose-400">{f.problemas.join(' · ')}</span>
                          )}
                          {f.avisos?.length > 0 && (
                            <span
                              className={f.problemas.length ? 'block text-amber-400' : 'text-amber-400'}
                            >
                              {f.avisos.join(' · ')}
                            </span>
                          )}
                          {!f.problemas.length && !f.avisos?.length && (
                            <span className="text-slate-600">{f.accion}</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variante="primario"
          icon={Upload}
          cargando={trabajando}
          disabled={(!r.se_crean && !r.se_actualizan) || revision.comunes?.falta_router}
          onClick={onAplicar}
        >
          {revision.comunes?.falta_router
            ? 'Elegí el router para poder importar'
            : `Iniciar importación de ${r.se_crean + r.se_actualizan}`}
        </Button>
        <Button variante="fantasma" onClick={onVolver}>
          Elegir otro archivo
        </Button>
      </div>
    </div>
  )
}

function Metrica({ titulo, valor, color, ayuda }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3" title={ayuda}>
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{titulo}</p>
      <p className={`mt-1 text-xl font-semibold ${color ?? 'text-slate-100'}`}>{valor}</p>
      {ayuda && <p className="text-[11px] text-slate-500">{ayuda}</p>}
    </div>
  )
}
