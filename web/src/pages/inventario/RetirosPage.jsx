import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Box,
  Download,
  FileText,
  PackageCheck,
  RefreshCw,
  UserCheck,
  XCircle,
} from 'lucide-react'
import {
  Aviso,
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
  SkeletonTabla,
  Stat,
  Table,
  Tabs,
  Textarea,
} from '../../components/ui'
import { supabase } from '../../lib/supabaseClient'
import { dineroCero as dinero } from '../../lib/formato'
import { MOTIVOS_RETIRO, RESULTADOS_INTENTO, carteraApi } from '../../lib/cartera'
import { gestionesACSV } from '../../lib/carteraReporte'
import HistorialVisitas from '../../components/cartera/HistorialVisitas'
import { api } from '../../lib/apiNetwork'
import { abrirPdf } from '../../lib/pdf'

/**
 * Retiros de equipo.
 *
 * ── Qué es esta pantalla ──
 *
 * La lista de aparatos que están en casas que ya no pagan. Cada renglón es una
 * visita pendiente, y el trabajo es cerrarlos: recuperado vuelve al stock, no
 * recuperado queda contado como pérdida.
 *
 * ── Qué NO es ──
 *
 * Una lista de morosos. El que debe un mes no está acá: está en la cartera del
 * vendedor, que lo llama para que renueve. Acá entra el que ya llegó a la
 * condición de retiro configurada, y las órdenes las abre sola la tarea de
 * cartera.
 *
 * ── Sobre el valor ──
 *
 * Es lo que costó el equipo, congelado al abrir la orden. Sirve para dimensionar
 * lo que hay en la calle —"8 ONT × $50"— y para nada más: no se le descuenta a
 * nadie. El requerimiento lo prohíbe explícitamente y el sistema no tiene por
 * dónde hacerlo.
 */

const ABIERTAS = ['pendiente', 'asignado']
const CERRADAS = ['recuperado', 'no_recuperado', 'cancelado']

const ESTADOS = {
  pendiente: ['ambar', 'Pendiente'],
  asignado: ['azul', 'Asignada'],
  recuperado: ['verde', 'Recuperado'],
  no_recuperado: ['rojo', 'No recuperado'],
  cancelado: ['gris', 'Cancelada'],
}

export default function RetirosPage() {
  const [tab, setTab] = useState('abiertas')
  const [ordenes, setOrdenes] = useState([])
  const [resumen, setResumen] = useState(null)
  const [tecnicos, setTecnicos] = useState([])
  const [personas, setPersonas] = useState([])
  const [elegidas, setElegidas] = useState(() => new Set())
  const [enLote, setEnLote] = useState('')
  const [asignandoLote, setAsignandoLote] = useState(false)
  const [bajando, setBajando] = useState(false)
  const [fichas, setFichas] = useState([])
  const [cerrandoFicha, setCerrandoFicha] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [generando, setGenerando] = useState(false)

  // Los tres diálogos. Cada uno guarda la orden sobre la que trabaja.
  const [asignar, setAsignar] = useState(null)
  const [intento, setIntento] = useState(null)
  const [cierre, setCierre] = useState(null)
  const [guardando, setGuardando] = useState(false)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const estados = tab === 'abiertas' ? ABIERTAS : tab === 'cerradas' ? CERRADAS : undefined
      const [lista, filas] = await Promise.all([carteraApi.retiros({ estados }), carteraApi.resumen()])
      setOrdenes(lista)
      // La fila sin vendedor es el total: la vista la calcula con GROUPING SETS.
      setResumen(filas.find((f) => f.vendedor_id === null) ?? null)
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [tab])

  useEffect(() => {
    recargar()
  }, [recargar])

  /* Las fichas por cerrar se traen aparte de las órdenes: son el pendiente que
     queda DESPUÉS del retiro, y sobreviven al filtro de estados de la tabla. */
  const recargarFichas = useCallback(
    () => carteraApi.fichasPorCerrar().then(setFichas).catch(setError),
    [],
  )

  useEffect(() => {
    recargarFichas()
  }, [recargarFichas])

  useEffect(() => {
    supabase
      .from('tecnicos')
      .select('id, nombre')
      .eq('activo', true)
      .order('nombre')
      .then(({ data }) => setTecnicos(data ?? []))

    /* Quién puede hacerse cargo. No solo técnicos: el equipo lo va a buscar
       quien esté disponible, y a veces es el cobrador o el dueño. Por eso la
       lista sale de `usuarios_sistema` y no de `tecnicos`. */
    supabase
      .from('usuarios_sistema')
      .select('id, nombre, apellido, rol, tecnico_id')
      .eq('activo', true)
      .order('nombre')
      .then(({ data }) => setPersonas(data ?? []))
  }, [])

  /* La selección se limpia al cambiar de pestaña: dejar marcadas órdenes que ya
     no se ven es la forma de asignarle a alguien algo que no eligió. */
  useEffect(() => setElegidas(new Set()), [tab])

  const alternarUna = (id) =>
    setElegidas((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  const abiertasVisibles = ordenes.filter((o) => ABIERTAS.includes(o.estado))
  const todasMarcadas = abiertasVisibles.length > 0 && abiertasVisibles.every((o) => elegidas.has(o.id))

  const alternarTodas = () =>
    setElegidas(todasMarcadas ? new Set() : new Set(abiertasVisibles.map((o) => o.id)))

  /** Asigna el recorrido entero a la misma persona. */
  async function asignarEnLote() {
    setAsignandoLote(true)
    setError(null)
    try {
      const r = await carteraApi.asignarLote([...elegidas], enLote)
      setElegidas(new Set())
      setEnLote('')
      await recargar()
      if (r.salteadas > 0) {
        setError(
          new Error(
            `Se asignaron ${r.asignadas} y ${r.salteadas} quedaron afuera: ya estaban cerradas.`,
          ),
        )
      }
    } catch (err) {
      setError(err)
    } finally {
      setAsignandoLote(false)
    }
  }

  /**
   * Baja el reporte de lo que dijo cada abonado.
   *
   * Se pide en el momento y no se arma con lo que ya está en pantalla: la tabla
   * muestra una fila por orden y el reporte necesita una por CONTACTO, que es
   * donde está lo que el abonado contestó.
   */
  async function bajarReporte() {
    setBajando(true)
    setError(null)
    try {
      const estados = tab === 'abiertas' ? ABIERTAS : tab === 'cerradas' ? CERRADAS : null
      const filas = await carteraApi.gestiones(estados ? { estados } : {})
      if (!filas.length) throw new Error('No hay nada que exportar con este filtro.')

      const blob = new Blob(['﻿' + gestionesACSV(filas)], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `retiros-${tab}-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch (err) {
      setError(err)
    } finally {
      setBajando(false)
    }
  }

  /** Corre el generador a mano, para no esperar a la tarea de la noche. */
  async function generar() {
    setGenerando(true)
    setError(null)
    try {
      const { error: e } = await supabase.rpc('generar_retiros_equipo')
      if (e) throw e
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGenerando(false)
    }
  }

  async function guardarAsignacion(e) {
    e.preventDefault()
    setGuardando(true)
    try {
      await carteraApi.asignar(asignar.id, asignar.tecnico)
      setAsignar(null)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  /**
   * Abre el diálogo de visita con las anteriores a la vista.
   *
   * Sin el historial, el que va hoy no sabe que los dos que fueron antes
   * llegaron a las diez de la mañana y no había nadie. El contador de intentos no
   * dice eso; los renglones sí.
   */
  async function abrirIntento(orden) {
    setIntento({ id: orden.id, resultado: 'no_estaba', observacion: '', previos: null })
    try {
      const previos = await carteraApi.intentos(orden.id)
      setIntento((i) => (i && i.id === orden.id ? { ...i, previos } : i))
    } catch {
      // Que no se pueda leer el historial no impide anotar la visita de hoy.
      setIntento((i) => (i && i.id === orden.id ? { ...i, previos: [] } : i))
    }
  }

  async function guardarIntento(e) {
    e.preventDefault()
    setGuardando(true)
    try {
      await carteraApi.registrarIntento(intento.id, {
        resultado: intento.resultado,
        observacion: intento.observacion,
      })
      setIntento(null)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  async function guardarCierre(e) {
    e.preventDefault()
    setGuardando(true)
    try {
      await carteraApi.cerrar(cierre.id, {
        recuperado: cierre.recuperado,
        motivo: cierre.motivo,
        observacion: cierre.observacion,
        serie: cierre.serie,
      })
      setCierre(null)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  const pendientes = useMemo(
    () => ordenes.filter((o) => ABIERTAS.includes(o.estado)).length,
    [ordenes],
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="t-titulo text-lg font-bold text-slate-100">Retiros de equipo</h1>
          <p className="mt-0.5 max-w-3xl text-xs leading-snug text-slate-500">
            Los equipos que quedaron en casas que dejaron de renovar. La orden se abre sola cuando el
            abonado llega a la condición configurada en Comisiones e Incentivos.
          </p>
        </div>
        <Button icon={RefreshCw} onClick={generar} cargando={generando}>
          Buscar nuevos
        </Button>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {resumen && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Por recuperar"
            valor={resumen.pendientes ?? 0}
            sub={`${dinero(resumen.valor_en_riesgo)} en la calle`}
            icon={Box}
            color="text-amber-400"
          />
          <Stat
            label="Recuperados"
            valor={resumen.recuperados ?? 0}
            sub={`${dinero(resumen.valor_recuperado)} de vuelta en stock`}
            icon={PackageCheck}
            color="text-emerald-400"
          />
          <Stat
            label="No recuperados"
            valor={resumen.no_recuperados ?? 0}
            sub={`${dinero(resumen.valor_perdido)} dados por perdidos`}
            icon={XCircle}
            color="text-red-400"
          />
          <Stat
            label="Tasa de recuperación"
            valor={resumen.tasa_recuperacion == null ? '—' : `${resumen.tasa_recuperacion} %`}
            sub="Sobre las órdenes ya cerradas"
            icon={AlertTriangle}
            color="text-sky-400"
          />
        </div>
      )}

      <Tabs
        activa={tab}
        onCambiar={setTab}
        tabs={[
          { clave: 'abiertas', label: 'Abiertas', contador: pendientes || undefined },
          { clave: 'cerradas', label: 'Cerradas' },
          { clave: 'todas', label: 'Todas' },
          { clave: 'fichas', label: 'Fichas por cerrar', contador: fichas.length || undefined },
        ]}
      />

      {tab === 'fichas' ? (
        <FichasPorCerrar
          filas={fichas}
          onCerrar={setCerrandoFicha}
          onError={setError}
        />
      ) : (
      <Card>
        {/* La barra del lote. Aparece solo con algo marcado: un selector de
            persona flotando sin nada elegido invita a preguntarse qué asigna. */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {elegidas.size > 0 ? (
            <>
              <span className="text-xs text-slate-300">
                {elegidas.size} {elegidas.size === 1 ? 'orden marcada' : 'órdenes marcadas'}
              </span>
              <div className="w-52">
                <Select value={enLote} onChange={(e) => setEnLote(e.target.value)} className="py-1.5 text-xs">
                  <option value="">Asignar a…</option>
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {`${p.nombre} ${p.apellido ?? ''}`.trim()}
                      {p.tecnico_id ? '' : ` · ${p.rol}`}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                variante="primario"
                icon={UserCheck}
                disabled={!enLote}
                cargando={asignandoLote}
                onClick={asignarEnLote}
                className="py-1.5 text-xs"
              >
                Asignar el recorrido
              </Button>
              <Button onClick={() => setElegidas(new Set())} className="py-1.5 text-xs">
                Quitar la selección
              </Button>
            </>
          ) : (
            <span className="text-[11px] text-slate-500">
              Marcá varias órdenes para asignarlas juntas a una persona.
            </span>
          )}

          <Button
            icon={Download}
            onClick={bajarReporte}
            cargando={bajando}
            className="ml-auto py-1.5 text-xs"
          >
            Reporte de gestiones
          </Button>
        </div>

        {cargando ? (
          <SkeletonTabla filas={6} columnas={8} />
        ) : (
          <Table
            columnas={[
              <input
                key="todas"
                type="checkbox"
                checked={todasMarcadas}
                onChange={alternarTodas}
                disabled={abiertasVisibles.length === 0}
                title="Marcar todas las abiertas"
                className="accent-sky-500"
              />,
              'Abonado',
              'Equipo',
              'Valor',
              'Sin pagar',
              'Estado',
              'A cargo',
              '',
            ]}
            filas={ordenes}
            vacio={
              tab === 'abiertas'
                ? 'Ninguna orden abierta. Nadie llegó a la condición de retiro.'
                : 'Sin órdenes.'
            }
            renderFila={(o) => {
              const [color, texto] = ESTADOS[o.estado] ?? ['gris', o.estado]
              const abierta = ABIERTAS.includes(o.estado)

              return (
                <tr key={o.id} className="align-top">
                  <td className="px-3 py-2">
                    {/* Solo las abiertas se pueden asignar: marcar una cerrada
                        prometería algo que la base va a rechazar. */}
                    {abierta && (
                      <input
                        type="checkbox"
                        checked={elegidas.has(o.id)}
                        onChange={() => alternarUna(o.id)}
                        className="accent-sky-500"
                      />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <p className="font-medium text-slate-100">{o.cliente ?? '—'}</p>
                    <p className="text-[11px] text-slate-500">
                      {o.telefono || 'sin teléfono'}
                      {o.vendedor ? ` · vendió ${o.vendedor}` : ''}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    <p className="text-slate-200">{o.serie || 'sin serie'}</p>
                    <p className="text-[11px] text-slate-500">{o.modelo || 'modelo sin fichar'}</p>
                  </td>
                  <td className="px-3 py-2 text-slate-300">{dinero(o.valor)}</td>
                  <td className="px-3 py-2">
                    <p className="text-slate-300">{o.meses_sin_pago ?? '—'} meses</p>
                    <p className="text-[11px] text-slate-500">
                      {o.ultimo_pago ? `último pago ${o.ultimo_pago}` : 'nunca pagó'}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    <Badge color={color}>{texto}</Badge>
                    {/* El historial se abre desde acá, esté la orden abierta o
                        cerrada. Antes solo se veía adentro del diálogo de
                        "anotar visita", que no existe para una orden ya
                        cerrada: justo la que alguien va a mirar cuando el
                        vendedor pregunte por qué se dio de baja a su cliente. */}
                    <div className="mt-1">
                      <HistorialVisitas retiroId={o.id} intentos={o.intentos ?? 0} />
                    </div>
                    {o.motivo && <p className="mt-1 text-[11px] text-slate-500">{o.motivo}</p>}
                  </td>
                  <td className="px-3 py-2">
                    <p className="text-slate-300">{o.responsable ?? o.tecnico ?? '—'}</p>
                    {o.agendado_para && (
                      <p className="text-[11px] text-sky-400">
                        cita {new Date(o.agendado_para).toLocaleString('es-EC', {
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    )}
                    {abierta && (
                      <p className="text-[11px] text-slate-500">{o.dias_abierta} días abierta</p>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {abierta && (
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <Button
                          variante="fantasma"
                          icon={UserCheck}
                          onClick={() => setAsignar({ id: o.id, tecnico: o.tecnico_id ?? '' })}
                        >
                          Asignar
                        </Button>
                        <Button
                          variante="fantasma"
                          icon={FileText}
                          title="Ver el acta firmada"
                          onClick={() => abrirPdf(() => api.actas.retiro(o.id))}
                        />
                        <Button variante="fantasma" onClick={() => abrirIntento(o)}>
                          Anotar visita
                        </Button>
                        <Button
                          variante="exito"
                          onClick={() =>
                            setCierre({
                              id: o.id,
                              recuperado: true,
                              serie: o.serie ?? '',
                              motivo: '',
                              observacion: '',
                            })
                          }
                        >
                          Cerrar
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            }}
          />
        )}
      </Card>
      )}

      <CerrarFicha
        ficha={cerrandoFicha}
        onCerrar={() => setCerrandoFicha(null)}
        onListo={recargarFichas}
        onError={setError}
      />

      {/* ------------------------------------------------------- Asignar */}
      <Modal abierto={Boolean(asignar)} titulo="Asignar el retiro" onCerrar={() => setAsignar(null)}>
        {asignar && (
          <form onSubmit={guardarAsignacion} className="space-y-4">
            <Field label="Técnico" hint="Quien va a ir a buscar el equipo">
              <Select
                value={asignar.tecnico}
                onChange={(e) => setAsignar((a) => ({ ...a, tecnico: e.target.value }))}
                required
              >
                <option value="">Elegí un técnico…</option>
                {tecnicos.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.nombre}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setAsignar(null)}>
                Cancelar
              </Button>
              <Button variante="primario" type="submit" cargando={guardando} disabled={!asignar.tecnico}>
                Asignar
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* ------------------------------------------------------- Intento */}
      <Modal abierto={Boolean(intento)} titulo="Anotar la visita" onCerrar={() => setIntento(null)}>
        {intento && (
          <form onSubmit={guardarIntento} className="space-y-4">
            {intento.previos?.length > 0 && (
              <div className="t-card-sm p-3">
                <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">
                  Visitas anteriores
                </p>
                <ul className="space-y-1.5 text-xs text-slate-400">
                  {intento.previos.map((p) => (
                    <li key={p.id}>
                      <span className="text-slate-300">
                        {String(p.creado_en).slice(0, 16).replace('T', ' ')}
                      </span>{' '}
                      · {RESULTADOS_INTENTO.find((r) => r.clave === p.resultado)?.label ?? p.resultado}
                      {p.observacion ? ` — ${p.observacion}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Field label="Cómo salió">
              <Select
                value={intento.resultado}
                onChange={(e) => setIntento((i) => ({ ...i, resultado: e.target.value }))}
              >
                {RESULTADOS_INTENTO.map((r) => (
                  <option key={r.clave} value={r.clave}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Observación" hint="La hora y lo que pasó: es lo que explica el intento tres">
              <Textarea
                rows={3}
                value={intento.observacion}
                onChange={(e) => setIntento((i) => ({ ...i, observacion: e.target.value }))}
                placeholder="Fui a las 10, no había nadie. La vecina dice que trabajan de día."
              />
            </Field>

            <Aviso>
              Anotar la visita no cierra la orden. Si el equipo se recuperó, cerrala después para que
              vuelva al stock.
            </Aviso>

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setIntento(null)}>
                Cancelar
              </Button>
              <Button variante="primario" type="submit" cargando={guardando}>
                Guardar
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* ------------------------------------------------------- Cierre */}
      <Modal abierto={Boolean(cierre)} titulo="Cerrar la orden" onCerrar={() => setCierre(null)}>
        {cierre && (
          <form onSubmit={guardarCierre} className="space-y-4">
            <div className="flex gap-2">
              <Button
                type="button"
                variante={cierre.recuperado ? 'exito' : 'secundario'}
                onClick={() => setCierre((c) => ({ ...c, recuperado: true }))}
              >
                Se recuperó
              </Button>
              <Button
                type="button"
                variante={cierre.recuperado ? 'secundario' : 'peligro'}
                onClick={() => setCierre((c) => ({ ...c, recuperado: false }))}
              >
                No se recuperó
              </Button>
            </div>

            {cierre.recuperado ? (
              <>
                <Field
                  label="Serie del equipo"
                  hint="Confirmala mirando la etiqueta: es la que entra al stock"
                >
                  <Input
                    value={cierre.serie}
                    onChange={(e) => setCierre((c) => ({ ...c, serie: e.target.value }))}
                    placeholder="HWTC1234ABCD"
                  />
                </Field>
                <Aviso>
                  El equipo entra al almacén del técnico asignado con su movimiento de inventario. Si
                  no hay técnico, entra a la bodega central.
                </Aviso>
              </>
            ) : (
              <Field label="Motivo" hint="Sin esto no se puede analizar después por qué se pierden">
                <Select
                  value={cierre.motivo}
                  onChange={(e) => setCierre((c) => ({ ...c, motivo: e.target.value }))}
                  required
                >
                  <option value="">Elegí un motivo…</option>
                  {MOTIVOS_RETIRO.map((m) => (
                    <option key={m.clave} value={m.clave}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <Field label="Observaciones">
              <Textarea
                rows={3}
                value={cierre.observacion}
                onChange={(e) => setCierre((c) => ({ ...c, observacion: e.target.value }))}
              />
            </Field>

            {!cierre.recuperado && (
              <Aviso tipo="alerta">
                El equipo queda registrado como pérdida. No se le descuenta a nadie: es información
                para administración.
              </Aviso>
            )}

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setCierre(null)}>
                Cancelar
              </Button>
              <Button
                variante={cierre.recuperado ? 'exito' : 'peligro'}
                type="submit"
                cargando={guardando}
                disabled={!cierre.recuperado && !cierre.motivo}
              >
                Cerrar orden
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * Abonados que se quedaron sin equipo y siguen figurando como activos.
 *
 * ── Por qué esto es una solapa y no solo una notificación ──
 *
 * Porque una notificación se lee una vez y se va. Este pendiente sobrevive a
 * quien lo vio: mientras el abonado siga como activo sin equipo, la ficha
 * miente —le puede seguir facturando, aparece en la cartera del vendedor, entra
 * en los conteos— y alguien tiene que decidir.
 *
 * La decisión no la toma el sistema: puede estar mudándose, puede haber pedido
 * el equipo nuevo, puede deber plata que se quiere seguir gestionando.
 */
function FichasPorCerrar({ filas, onCerrar }) {
  if (filas.length === 0) {
    return (
      <Card>
        <Aviso>
          No hay fichas pendientes. Cuando vuelva un equipo o se dé uno por perdido, el abonado
          aparece acá hasta que se lo marque como retirado.
        </Aviso>
      </Card>
    )
  }

  return (
    <Card
      title="Abonados sin equipo que siguen activos"
      subtitle="Ya se cerró su retiro. Falta decidir si siguen siendo abonados."
    >
      <Table
        columnas={['Abonado', 'Estado', 'Qué pasó con el equipo', 'Cuándo', '']}
        filas={filas}
        renderFila={(f) => (
          <tr key={f.cliente_id} className="text-slate-300">
            <td className="px-3 py-2">
              <p className="font-medium text-slate-100">{f.nombre}</p>
              <p className="text-[11px] text-slate-500">
                {f.codigo != null ? String(f.codigo).padStart(6, '0') : ''}
                {f.zona ? ` · ${f.zona}` : ''}
                {f.telefono ? ` · ${f.telefono}` : ''}
              </p>
            </td>
            <td className="px-3 py-2">
              <Badge color={f.estado === 'activo' ? 'verde' : 'ambar'}>{f.estado}</Badge>
            </td>
            <td className="px-3 py-2 text-xs">
              {f.equipo_recuperado ? (
                <span className="text-emerald-400">Recuperado</span>
              ) : (
                <span className="text-red-400">No recuperado{f.categoria ? ` — ${f.categoria}` : ''}</span>
              )}
              {f.serie && <div className="text-[11px] text-slate-500">{f.serie}</div>}
            </td>
            <td className="px-3 py-2 text-[11px] text-slate-400">
              {f.cerrado_en ? new Date(f.cerrado_en).toLocaleDateString('es-EC') : '—'}
            </td>
            <td className="px-3 py-2 text-right">
              <Button
                variante="primario"
                icon={UserCheck}
                onClick={() => onCerrar(f)}
                className="py-1.5 text-xs"
              >
                Marcar retirado
              </Button>
            </td>
          </tr>
        )}
      />

      <p className="mt-3 text-[11px] text-slate-500">
        La ficha no se borra: los pagos, las facturas ya emitidas y las comisiones pagadas apuntan a
        ella, y el que se fue muchas veces vuelve. Se marca como retirado y queda escrito por qué.
      </p>
    </Card>
  )
}

// ---------------------------------------------------------------------------

/**
 * Marcar retirado a un abonado, con el historial a la vista.
 *
 * ── Por qué el historial va acá adentro y no en otra pantalla ──
 *
 * Porque es el momento exacto en que hay que decidir, y la decisión depende de
 * lo que encontró el técnico. Sin eso, quien cierra la ficha elige un motivo al
 * azar: "se mudó" y "se niega a entregarlo" se ven igual desde la oficina, y
 * son cosas distintas —una es pérdida, la otra es reclamable— que además
 * cuentan distinto en la calidad del vendedor.
 *
 * ── Y por qué se pueden copiar los comentarios a la nota ──
 *
 * Porque el día que el vendedor venga a reclamar por qué se dio de baja a su
 * cliente, la respuesta tiene que estar EN LA FICHA, no en una tabla que hay
 * que ir a buscar. Un botón que arrastra lo que dijeron los vecinos a la nota
 * de la baja convierte una discusión en una lectura.
 */
function CerrarFicha({ ficha, onCerrar, onListo, onError }) {
  const [motivos, setMotivos] = useState([])
  const [motivo, setMotivo] = useState('')
  const [nota, setNota] = useState('')
  const [visitas, setVisitas] = useState([])
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    if (!ficha) return
    setNota('')
    setVisitas([])

    carteraApi
      .motivosBaja()
      .then((m) => {
        setMotivos(m)
        setMotivo((v) => v || m[0]?.id || '')
      })
      .catch(onError)

    if (ficha.retiro_id) {
      carteraApi.intentos(ficha.retiro_id).then(setVisitas).catch(onError)
    }
  }, [ficha, onError])

  /** Arrastra lo que dijeron los técnicos a la nota de la baja. */
  const copiarComentarios = () => {
    const texto = visitas
      .filter((v) => v.observacion)
      .map((v) => {
        const cuando = new Date(v.creado_en).toLocaleDateString('es-EC')
        const quien = v.tecnicos?.nombre ?? 'el técnico'
        return `${cuando} · ${quien}: ${v.observacion}`
      })
      .join(' | ')

    setNota((n) => [n.trim(), texto].filter(Boolean).join(' — '))
  }

  async function guardar() {
    setGuardando(true)
    try {
      await carteraApi.cerrarFicha(ficha.cliente_id, { motivo, nota })
      onCerrar()
      await onListo()
    } catch (err) {
      onError(err)
    } finally {
      setGuardando(false)
    }
  }

  const elegido = motivos.find((m) => m.id === motivo)
  const conComentarios = visitas.some((v) => v.observacion)

  return (
    <Modal
      abierto={Boolean(ficha)}
      titulo={ficha ? `Marcar retirado a ${ficha.nombre}` : ''}
      onCerrar={onCerrar}
      ancho="max-w-2xl"
    >
      <div className="space-y-4">
        {/* ── Lo que pasó, antes de pedir la decisión ── */}
        <div>
          <p className="mb-1 text-xs font-medium text-slate-300">Qué encontró el técnico</p>

          {visitas.length === 0 ? (
            <p className="t-panel p-3 text-[11px] text-slate-500">
              No se registró ninguna visita en esta orden. Sin visitas anotadas, dar de baja es la
              palabra de alguien: conviene preguntar antes de cerrar.
            </p>
          ) : (
            <div className="max-h-52 space-y-1.5 overflow-y-auto t-panel p-2">
              {visitas.map((v) => (
                <div key={v.id} className="border-l-2 border-slate-700 pl-2">
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="text-slate-400">
                      {new Date(v.creado_en).toLocaleString('es-EC', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <Badge color={v.resultado === 'recuperado' ? 'verde' : 'ambar'}>
                      {RESULTADOS_INTENTO.find((r) => r.clave === v.resultado)?.label ?? v.resultado}
                    </Badge>
                    <span className="text-slate-500">
                      {v.tecnicos?.nombre ??
                        `${v.usuarios_sistema?.nombre ?? ''} ${v.usuarios_sistema?.apellido ?? ''}`.trim()}
                    </span>
                  </div>
                  {v.observacion && (
                    <p className="mt-0.5 text-xs leading-snug text-slate-200">“{v.observacion}”</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* El cierre de la orden dice por qué se dio por perdido. */}
          {ficha?.categoria && (
            <p className="mt-1.5 text-[11px] text-slate-400">
              La orden se cerró como <b className="text-red-400">{ficha.categoria}</b>.
            </p>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Motivo de la baja" hint="Decide si la pérdida le cuenta al vendedor">
            <Select value={motivo} onChange={(e) => setMotivo(e.target.value)}>
              {motivos.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nombre}
                </option>
              ))}
            </Select>
          </Field>

          <div className="flex items-end">
            {elegido && (
              <p
                className={`text-[11px] leading-snug ${
                  elegido.afecta_calidad ? 'text-amber-400' : 'text-slate-500'
                }`}
              >
                {elegido.afecta_calidad
                  ? 'Esta baja CUENTA contra la calidad de la cohorte del vendedor que lo trajo.'
                  : 'Esta baja no le cuenta al vendedor en su calidad.'}
              </p>
            )}
          </div>
        </div>

        <Field
          label="Nota de la baja"
          hint="Queda en la ficha del abonado, para siempre"
        >
          <Textarea rows={3} value={nota} onChange={(e) => setNota(e.target.value)} />
        </Field>

        {conComentarios && (
          <Button icon={Download} onClick={copiarComentarios} className="py-1.5 text-xs">
            Traer los comentarios de las visitas a la nota
          </Button>
        )}

        <Aviso>
          Además de lo que escribas, se agrega solo qué pasó con el equipo: si se recuperó y cuándo,
          o por qué no. El día que el vendedor pregunte por qué se dio de baja a su cliente, la
          respuesta está en la ficha.
        </Aviso>

        <div className="flex justify-end gap-2">
          <Button variante="secundario" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button variante="primario" onClick={guardar} cargando={guardando} disabled={!motivo}>
            Marcar retirado
          </Button>
        </div>
      </div>
    </Modal>
  )
}
