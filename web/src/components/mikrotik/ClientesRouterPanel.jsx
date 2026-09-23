import { useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import {
  ArrowRightLeft,
  Download,
  RefreshCcw,
  Upload,
  Users,
} from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, Card, Cargando, ErrorBanner, Field, Input, Select, Stat, Table, EnlaceIp } from '../ui'

/**
 * Gestión de clientes de un router concreto.
 *
 * Tres operaciones, cada una en su pestaña porque son flujos distintos:
 *   Importar   → traer al sistema lo que ya está en el RB
 *   Exportar   → crear en el RB las colas o secrets de los clientes del sistema
 *   Morosos    → dejar el address-list de cortes igual que el estado del sistema
 */

const FUENTES = [
  { id: 'simple-queue', label: 'Colas simples', ayuda: 'Clientes con IP fija y cola de velocidad' },
  { id: 'ppp-secret', label: 'PPPoE', ayuda: 'Usuarios de PPPoE (secrets y sesiones activas)' },
  { id: 'dhcp-lease', label: 'Leases DHCP', ayuda: 'Aporta MAC y a veces el nombre' },
  { id: 'address-list', label: 'Lista de cortes', ayuda: 'Crea clientes con los que solo figuran ahí' },
]

const PESTANAS = [
  { id: 'importar', label: 'Importar del RB', icon: Download },
  { id: 'exportar', label: 'Exportar al RB', icon: Upload },
  { id: 'morosos', label: 'Sincronizar morosos', icon: RefreshCcw },
]

export default function ClientesRouterPanel({ router }) {
  const [pestana, setPestana] = useState('importar')
  const [error, setError] = useState(null)

  return (
    <Card title="Clientes de este router" icon={Users}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1 border-b border-slate-800 pb-3">
          {PESTANAS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => {
                setPestana(id)
                setError(null)
              }}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${
                pestana === id
                  ? 'bg-sky-600/15 font-medium text-sky-300'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>

        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {pestana === 'importar' && <Importar router={router} onError={setError} />}
        {pestana === 'exportar' && <Exportar router={router} onError={setError} />}
        {pestana === 'morosos' && <Morosos router={router} onError={setError} />}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------

function Importar({ router, onError }) {
  const [lista, setLista] = useState(router.lista_morosos || 'CORTE_MOROSOS')
  const [fuentes, setFuentes] = useState(FUENTES.map((f) => f.id))
  const [escaneo, setEscaneo] = useState(null)
  const [seleccion, setSeleccion] = useState(new Set())
  const [escaneando, setEscaneando] = useState(false)
  const [importando, setImportando] = useState(false)
  const [resultado, setResultado] = useState(null)

  const alternarFuente = (id) =>
    setFuentes((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]))

  async function escanear() {
    setEscaneando(true)
    onError(null)
    setResultado(null)
    try {
      const r = await api.mikrotik.escaneo(router.id, { lista, fuentes })
      setEscaneo(r)
      setSeleccion(new Set(r.clientes.map((_, i) => i)))
    } catch (err) {
      onError(err)
      setEscaneo(null)
    } finally {
      setEscaneando(false)
    }
  }

  async function importar() {
    const elegidos = escaneo.clientes.filter((_, i) => seleccion.has(i))
    if (!elegidos.length) return onError(new Error('No hay ningún cliente seleccionado'))
    setImportando(true)
    onError(null)
    try {
      setResultado(await api.mikrotik.importar(router.id, elegidos))
    } catch (err) {
      onError(err)
    } finally {
      setImportando(false)
    }
  }

  const alternar = (i) =>
    setSeleccion((s) => {
      const n = new Set(s)
      n.has(i) ? n.delete(i) : n.add(i)
      return n
    })

  const todos = escaneo && seleccion.size === escaneo.clientes.length

  return (
    <div className="space-y-4">
      <Aviso>
        El escaneo es de solo lectura. Elegí de dónde leer según cómo administre los clientes este
        router: con colas simples sobre IP fija, con PPPoE, o ambas.
      </Aviso>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {FUENTES.map((f) => (
          <label
            key={f.id}
            className={`cursor-pointer rounded-lg border p-3 text-xs transition ${
              fuentes.includes(f.id)
                ? 'border-sky-500/40 bg-sky-500/10'
                : 'border-slate-800 bg-[#F6F8FB] opacity-60'
            }`}
          >
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={fuentes.includes(f.id)}
                onChange={() => alternarFuente(f.id)}
                className="accent-sky-500"
              />
              <span className="font-medium text-slate-100">{f.label}</span>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">{f.ayuda}</p>
          </label>
        ))}
      </div>

      <div className="grid items-end gap-3 sm:grid-cols-3">
        <Field
          label="Lista de cortes del router"
          hint="La que ya usa este equipo, ej. Moroso"
          className="sm:col-span-2"
        >
          <Input value={lista} onChange={(e) => setLista(e.target.value)} />
        </Field>
        <div className="pb-2">
          <Button
            variante="primario"
            icon={Download}
            onClick={escanear}
            cargando={escaneando}
            disabled={fuentes.length === 0}
            className="w-full"
          >
            Escanear
          </Button>
        </div>
      </div>

      {escaneando && <Cargando texto="Leyendo el router…" />}

      {escaneo && !escaneando && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Encontrados" valor={escaneo.resumen.total} />
            <Stat
              label="Cortados"
              valor={escaneo.resumen.cortados}
              color={escaneo.resumen.cortados ? 'text-red-400' : 'text-emerald-400'}
            />
            <Stat label="Con velocidad" valor={escaneo.resumen.conVelocidad} />
            <Stat label="Sin IP" valor={escaneo.resumen.sinIp} />
          </div>

          <div className="flex flex-wrap gap-2 text-xs">
            {Object.entries(escaneo.resumen.fuentes).map(([f, n]) => (
              <Badge key={f} color={n > 0 ? 'azul' : 'gris'}>
                {f}: {n}
              </Badge>
            ))}
          </div>

          {resultado && (
            <Aviso>
              <b>{resultado.creados} creados</b> y {resultado.actualizados} actualizados.
              {resultado.errores && (
                <span className="mt-1 block text-amber-300">{resultado.errores.join(' · ')}</span>
              )}
            </Aviso>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">
              {seleccion.size} de {escaneo.clientes.length} seleccionados
            </span>
            <div className="flex gap-2">
              <Button
                onClick={() =>
                  setSeleccion(todos ? new Set() : new Set(escaneo.clientes.map((_, i) => i)))
                }
              >
                {todos ? 'Desmarcar todos' : 'Marcar todos'}
              </Button>
              <Button
                variante="primario"
                icon={Download}
                onClick={importar}
                cargando={importando}
                disabled={seleccion.size === 0}
              >
                Importar
              </Button>
            </div>
          </div>

          <Table
            columnas={['', 'Cliente', 'IP', 'PPPoE', 'Velocidad', 'Estado', 'Fuentes']}
            filas={escaneo.clientes}
            vacio="Nada encontrado con las fuentes elegidas."
            renderFila={(c, i) => (
              <tr
                key={`${c.ip ?? c.usuario_ppp ?? c.nombre}-${i}`}
                className={`text-slate-300 ${seleccion.has(i) ? '' : 'opacity-40'}`}
              >
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={seleccion.has(i)}
                    onChange={() => alternar(i)}
                    className="accent-sky-500"
                  />
                </td>
                <td className="px-3 py-2 font-medium text-slate-100">{c.nombre}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  <EnlaceIp ip={c.ip} />
                </td>
                <td className="px-3 py-2 text-xs">{c.usuario_ppp ?? '—'}</td>
                <td className="px-3 py-2 text-xs">{c.velocidad_cruda ?? '—'}</td>
                <td className="px-3 py-2">
                  <Badge
                    color={
                      c.estado === 'cortado' ? 'rojo' : c.estado === 'suspendido' ? 'ambar' : 'verde'
                    }
                  >
                    {c.estado}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-[11px] text-slate-500">{c.origenes?.join(', ')}</td>
              </tr>
            )}
          />
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function Exportar({ router, onError }) {
  const confirmar = useConfirmar()
  const [modo, setModo] = useState('simple-queue')
  const [enviando, setEnviando] = useState(false)
  const [resultado, setResultado] = useState(null)

  async function exportar() {
    if (
      !await confirmar(
        `Esto CREA configuración en ${router.nombre}. Lo que ya exista se saltea. ¿Continuar?`,
      )
    )
      return
    setEnviando(true)
    onError(null)
    setResultado(null)
    try {
      setResultado(await api.mikrotik.exportar(router.id, { modo }))
    } catch (err) {
      onError(err)
    } finally {
      setEnviando(false)
    }
  }

  return (
    <div className="space-y-4">
      <Aviso tipo="alerta">
        Esta operación <b>escribe en el router</b>: crea colas simples o usuarios PPPoE a partir de
        los clientes del sistema. Lo que ya existe se saltea, así que se puede repetir sin duplicar.
      </Aviso>

      <div className="grid items-end gap-3 sm:grid-cols-3">
        <Field label="Qué crear" className="sm:col-span-2">
          <Select value={modo} onChange={(e) => setModo(e.target.value)}>
            <option value="simple-queue">Colas simples (necesita IP y velocidad)</option>
            <option value="ppp-secret">Usuarios PPPoE (necesita usuario PPPoE)</option>
          </Select>
        </Field>
        <div className="pb-2">
          <Button
            variante="primario"
            icon={Upload}
            onClick={exportar}
            cargando={enviando}
            className="w-full"
          >
            Exportar
          </Button>
        </div>
      </div>

      {resultado && (
        <div className="space-y-2">
          <Aviso tipo={resultado.fallidos?.length ? 'alerta' : 'info'}>
            <b>{resultado.creados.length} creados</b>
            {resultado.salteados.length > 0 && `, ${resultado.salteados.length} ya existían`}
            {resultado.fallidos.length > 0 && `, ${resultado.fallidos.length} con problemas`}.
          </Aviso>

          {resultado.fallidos?.length > 0 && (
            <Table
              columnas={['Cliente', 'Por qué no se pudo']}
              filas={resultado.fallidos}
              renderFila={(f, i) => (
                <tr key={i} className="text-slate-300">
                  <td className="px-3 py-2">{f.nombre}</td>
                  <td className="px-3 py-2 text-xs text-amber-300">{f.error}</td>
                </tr>
              )}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function Morosos({ router, onError }) {
  const confirmar = useConfirmar()
  const [lista, setLista] = useState(router.lista_morosos || 'CORTE_MOROSOS')
  const [plan, setPlan] = useState(null)
  const [quitarDesconocidos, setQuitarDesconocidos] = useState(false)
  const [cargando, setCargando] = useState(false)
  const [aplicando, setAplicando] = useState(false)
  const [resultado, setResultado] = useState(null)

  async function verPlan() {
    setCargando(true)
    onError(null)
    setResultado(null)
    try {
      const r = await api.mikrotik.sincronizarMorosos(router.id, { lista, aplicar: false })
      setPlan(r.plan)
    } catch (err) {
      onError(err)
      setPlan(null)
    } finally {
      setCargando(false)
    }
  }

  async function aplicar() {
    const aQuitar = quitarDesconocidos ? plan.quitar : plan.quitar.filter((q) => q.conocido)
    const detalle = [
      plan.agregar.length ? `cortar ${plan.agregar.length}` : null,
      aQuitar.length ? `restaurar ${aQuitar.length}` : null,
    ]
      .filter(Boolean)
      .join(' y ')

    if (!await confirmar(`Se va a ${detalle} en ${router.nombre}. ¿Continuar?`)) return

    setAplicando(true)
    onError(null)
    try {
      const r = await api.mikrotik.sincronizarMorosos(router.id, {
        lista,
        aplicar: true,
        quitarDesconocidos,
      })
      setResultado(r)
      setPlan(r.plan)
    } catch (err) {
      onError(err)
    } finally {
      setAplicando(false)
    }
  }

  const desconocidos = plan?.quitar.filter((q) => !q.conocido).length ?? 0

  return (
    <div className="space-y-4">
      <Aviso>
        Deja el address-list del router igual que el estado de los clientes en el sistema. Primero
        se muestra el plan: nada se aplica hasta confirmarlo.
      </Aviso>

      <div className="grid items-end gap-3 sm:grid-cols-3">
        <Field label="Address-list de cortes" className="sm:col-span-2">
          <Input value={lista} onChange={(e) => setLista(e.target.value)} />
        </Field>
        <div className="pb-2">
          <Button
            icon={RefreshCcw}
            onClick={verPlan}
            cargando={cargando}
            className="w-full"
            variante="primario"
          >
            Ver qué cambiaría
          </Button>
        </div>
      </div>

      {plan && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="A cortar" valor={plan.agregar.length} color="text-red-400" />
            <Stat label="A restaurar" valor={plan.quitar.length} color="text-emerald-400" />
            <Stat label="Ya coinciden" valor={plan.yaCoinciden} />
            <Stat label="Sin IP" valor={plan.sinIp.length} color="text-amber-400" />
          </div>

          {plan.sinCambios ? (
            <Aviso>El router ya está sincronizado con el sistema. No hay nada que cambiar.</Aviso>
          ) : (
            <>
              {plan.agregar.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-red-400">
                    Se van a cortar ({plan.agregar.length})
                  </h4>
                  <Table
                    columnas={['IP', 'Cliente']}
                    filas={plan.agregar}
                    renderFila={(a, i) => (
                      <tr key={i} className="text-slate-300">
                        <td className="px-3 py-2 font-mono text-xs">{a.address}</td>
                        <td className="px-3 py-2">{a.nombre}</td>
                      </tr>
                    )}
                  />
                </div>
              )}

              {plan.quitar.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-emerald-400">
                    Se les restauraría el servicio ({plan.quitar.length})
                  </h4>
                  <Table
                    columnas={['IP', 'Cliente', 'Por qué']}
                    filas={plan.quitar}
                    renderFila={(q, i) => (
                      <tr key={i} className={`text-slate-300 ${q.conocido ? '' : 'opacity-60'}`}>
                        <td className="px-3 py-2 font-mono text-xs">{q.address}</td>
                        <td className="px-3 py-2">
                          {q.nombre ?? <span className="text-slate-500">desconocido</span>}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-400">{q.motivo}</td>
                      </tr>
                    )}
                  />
                </div>
              )}

              {desconocidos > 0 && (
                <Aviso tipo="alerta">
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      checked={quitarDesconocidos}
                      onChange={(e) => setQuitarDesconocidos(e.target.checked)}
                      className="mt-0.5 accent-amber-500"
                    />
                    <span>
                      Quitar también los {desconocidos} bloqueo(s) que no corresponden a ningún
                      cliente del sistema. <b>Desmarcado no se tocan</b>: suelen ser cortes puestos a
                      mano y quitarlos les devolvería el servicio.
                    </span>
                  </label>
                </Aviso>
              )}

              {plan.sinIp.length > 0 && (
                <Aviso tipo="alerta">
                  {plan.sinIp.length} cliente(s) figuran como cortados pero no tienen IP registrada,
                  así que no se pueden bloquear por address-list:{' '}
                  {plan.sinIp.map((s) => s.nombre).join(', ')}
                </Aviso>
              )}

              <div className="flex justify-end">
                <Button
                  variante="peligro"
                  icon={ArrowRightLeft}
                  onClick={aplicar}
                  cargando={aplicando}
                >
                  Aplicar en el router
                </Button>
              </div>
            </>
          )}
        </>
      )}

      {resultado?.aplicado && (
        <Aviso>
          <b>{resultado.resultado.agregadas.length} cortados</b> y{' '}
          {resultado.resultado.quitadas.length} restaurados.
          {resultado.aviso && <span className="mt-1 block text-amber-300">{resultado.aviso}</span>}
          {resultado.resultado.fallidas?.length > 0 && (
            <span className="mt-1 block text-amber-300">
              {resultado.resultado.fallidas.length} fallaron:{' '}
              {resultado.resultado.fallidas.map((f) => `${f.address} (${f.error})`).join(', ')}
            </span>
          )}
        </Aviso>
      )}
    </div>
  )
}
