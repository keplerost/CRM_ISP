import { useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import {
  Activity,
  Gauge,
  Laptop,
  Lock,
  Map,
  Power,
  PowerOff,
  RefreshCw,
  Signal,
  Trash2,
  Unplug,
  Wrench,
  Zap,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { Aviso, Button, Card, Field, Input, Modal, Select } from '../ui'

/**
 * Las herramientas que hoy se usan entrando al Winbox, en la ficha del abonado.
 *
 * El valor no está en los comandos —eso ya se podía hacer— sino en que el
 * objetivo lo deduce el sistema de la ficha del cliente. Buscar la IP a mano y
 * pegarla en otra ventana es exactamente donde se cuela el error de reiniciarle
 * el equipo al vecino.
 *
 * Tres grupos, en el orden en que se usan durante un reclamo: primero se mira
 * (diagnóstico), después se toca el equipo, y al final se decide sobre el
 * servicio. Lo que corta o da de baja va en rojo y siempre pide confirmación.
 */

const fmtBytes = (b) => {
  const n = Number(b) || 0
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} Gbps`
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} Mbps`
  if (n > 1e3) return `${(n / 1e3).toFixed(0)} Kbps`
  return `${n} bps`
}

/** Un botón de la barra: icono arriba, nombre abajo, apretable con el pulgar. */
function Herramienta({ icon: Icon, label, onClick, cargando, tono = 'neutro', disabled }) {
  const tonos = {
    neutro: 'border-slate-700 text-slate-300 hover:border-sky-500/60 hover:text-sky-300',
    ok: 'border-emerald-600/40 text-emerald-300 hover:bg-emerald-500/10',
    alerta: 'border-amber-600/40 text-amber-300 hover:bg-amber-500/10',
    peligro: 'border-rose-600/40 text-rose-300 hover:bg-rose-500/10',
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || cargando}
      className={`flex flex-col items-center justify-center gap-1.5 rounded-xl border p-3 text-[11px] leading-tight transition disabled:cursor-not-allowed disabled:opacity-40 ${tonos[tono]}`}
    >
      <Icon size={20} className={cargando ? 'animate-spin' : ''} />
      <span className="text-center">{label}</span>
    </button>
  )
}

export default function HerramientasTecnicas({ cliente, onError, onGuardado }) {
  const confirmar = useConfirmar()
  const [corriendo, setCorriendo] = useState(null)
  const [consola, setConsola] = useState(null)
  const [wifi, setWifi] = useState(null)
  const [promesa, setPromesa] = useState(null)
  const [baja, setBaja] = useState(null)
  const [motivos, setMotivos] = useState([])
  const [guardando, setGuardando] = useState(false)

  /**
   * El catálogo de motivos de baja, que se carga recién al abrir el diálogo.
   *
   * Traerlo al montar la ficha sería una consulta más en cada abonado que
   * alguien mira, para una lista que se usa en el 1 % de las visitas.
   */
  useEffect(() => {
    if (!baja || motivos.length) return
    let vivo = true
    supabase
      .from('motivos_baja')
      .select('id, nombre, afecta_calidad')
      .eq('activo', true)
      .order('afecta_calidad')
      .order('orden')
      .then(({ data }) => {
        if (vivo) setMotivos(data ?? [])
      })
    return () => {
      vivo = false
    }
  }, [baja, motivos.length])

  /** Corre una herramienta y muestra el resultado en la consola modal. */
  // El parámetro se llama `aviso` y no `confirmar`: con ese nombre tapaba al
  // `confirmar` del hook, y la llamada terminaba invocando el texto como si
  // fuera una función.
  async function correr(clave, titulo, fn, { aviso } = {}) {
    if (aviso && !(await confirmar(aviso))) return

    setCorriendo(clave)
    onError?.(null)
    setConsola({ titulo, cargando: true })

    try {
      const r = await fn()
      setConsola({ titulo, resultado: r })
    } catch (err) {
      setConsola({ titulo, error: err.message, hint: err.hint })
    } finally {
      setCorriendo(null)
    }
  }

  // --- Acciones sobre el servicio, que van a la base y no a la red ----------

  async function cambiarEstado(estado, aviso) {
    if (!await confirmar(aviso)) return

    setGuardando(true)
    onError?.(null)
    try {
      const { error } = await supabase.from('clientes').update({ estado }).eq('id', cliente.id)
      if (error) throw error
      await onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  /**
   * Da de baja dejando dicho por qué.
   *
   * El motivo no es burocracia: decide si esa pérdida le cuenta o no al vendedor
   * en la calidad de su cohorte. Una mudanza fuera de cobertura y un abandono a
   * los dos meses son la misma baja para la red y cosas opuestas para quien
   * vendió.
   */
  async function darDeBaja(e) {
    e.preventDefault()
    setGuardando(true)
    onError?.(null)

    try {
      const { error } = await supabase.rpc('dar_de_baja_cliente', {
        p_cliente: cliente.id,
        p_motivo: baja.motivo || null,
        p_nota: baja.nota?.trim() || null,
      })
      if (error) throw error

      setBaja(null)
      await onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  async function crearPromesa(e) {
    e.preventDefault()
    setGuardando(true)
    onError?.(null)

    try {
      const { data: sesion } = await supabase.auth.getUser()
      const { error } = await supabase.from('promesas_pago').insert({
        client_id: cliente.id,
        monto: Number(promesa.monto) || null,
        fecha_promesa: promesa.fecha,
        nota: promesa.nota?.trim() || null,
        // Habilitar el servicio es la razón de ser de la promesa: el abonado
        // pide unos días y a cambio se le devuelve la conexión.
        activo_servicio: true,
        created_by: sesion?.user?.id ?? null,
      })
      if (error) throw error

      setPromesa(null)
      await onGuardado?.()
    } catch (err) {
      onError?.(
        err?.code === '23505'
          ? new Error(`${cliente.nombre} ya tiene una promesa activa. Cerrala antes de crear otra.`)
          : err,
      )
    } finally {
      setGuardando(false)
    }
  }

  async function guardarWifi(e) {
    e.preventDefault()
    setGuardando(true)
    onError?.(null)

    try {
      const r = await api.herramientas.wifi(cliente.id, {
        ssid: wifi.ssid?.trim() || undefined,
        clave: wifi.clave?.trim() || undefined,
      })
      setWifi(null)
      setConsola({ titulo: 'Cambio de WiFi', resultado: r })
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  const sinRouter = !cliente.router_id

  return (
    <>
      <Card
        title="Herramientas técnicas"
        icon={Wrench}
        subtitle="Diagnóstico y control sobre el equipo del abonado"
      >
        {sinRouter && (
          <Aviso tipo="alerta">
            Este abonado no tiene router MikroTik asignado en su ficha, así que las herramientas de
            red no pueden saber a qué equipo hablarle. Asignalo en la pestaña <b>Servicio</b>.
          </Aviso>
        )}

        <div className="space-y-4">
          <div>
            <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">
              Diagnóstico y red
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Herramienta
                icon={Zap}
                label="Hacé ping"
                disabled={sinRouter}
                cargando={corriendo === 'ping'}
                onClick={() =>
                  correr('ping', `Ping a ${cliente.ip ?? 'el abonado'}`, () =>
                    api.herramientas.ping(cliente.id),
                  )
                }
              />
              <Herramienta
                icon={Map}
                label="Traceroute"
                disabled={sinRouter}
                cargando={corriendo === 'trace'}
                onClick={() =>
                  correr('trace', 'Traceroute', () => api.herramientas.traceroute(cliente.id))
                }
              />
              <Herramienta
                icon={Signal}
                label="Señal / potencia"
                cargando={corriendo === 'senal'}
                onClick={() =>
                  correr('senal', 'Señal del abonado', () => api.herramientas.senal(cliente.id))
                }
              />
              <Herramienta
                icon={Gauge}
                label="Test de velocidad"
                disabled={sinRouter}
                cargando={corriendo === 'velocidad'}
                onClick={() =>
                  correr(
                    'velocidad',
                    'Test de velocidad interno',
                    () => api.herramientas.testVelocidad(cliente.id),
                    {
                      aviso:
                        'El test satura el enlace del abonado unos segundos. ¿Continuar?',
                    },
                  )
                }
              />
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">
              Control de equipos
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Herramienta
                icon={RefreshCw}
                label="Reiniciar router"
                tono="alerta"
                disabled={sinRouter}
                cargando={corriendo === 'reiniciar'}
                onClick={() =>
                  correr(
                    'reiniciar',
                    'Reinicio del equipo',
                    () => api.herramientas.reiniciar(cliente.id),
                    {
                      aviso:
                        'Reiniciar el equipo corta el servicio mientras arranca (30 a 90 segundos). ¿Continuar?',
                    },
                  )
                }
              />
              <Herramienta
                icon={Lock}
                label="Cambiar WiFi"
                disabled={sinRouter}
                onClick={() => setWifi({ ssid: '', clave: '' })}
              />
              <Herramienta
                icon={Unplug}
                label="Kick PPPoE"
                tono="alerta"
                disabled={sinRouter || !cliente.usuario_ppp}
                cargando={corriendo === 'kick'}
                onClick={() =>
                  correr(
                    'kick',
                    'Sesión PPPoE',
                    () => api.herramientas.kickPpp(cliente.id),
                    {
                      aviso:
                        'Se baja la sesión del abonado y reconecta en unos segundos. ¿Continuar?',
                    },
                  )
                }
              />
              <Herramienta
                icon={Laptop}
                label="Dispositivos en casa"
                disabled={sinRouter}
                cargando={corriendo === 'dispositivos'}
                onClick={() =>
                  correr('dispositivos', 'Dispositivos conectados', () =>
                    api.herramientas.dispositivos(cliente.id),
                  )
                }
              />
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">
              Estado del servicio
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Herramienta
                icon={Power}
                label="Activar servicio"
                tono="ok"
                disabled={cliente.estado === 'activo' || guardando}
                onClick={() =>
                  cambiarEstado(
                    'activo',
                    `¿Marcar a ${cliente.nombre} como activo? Recordá quitarlo de la lista de cortados en el router.`,
                  )
                }
              />
              <Herramienta
                icon={PowerOff}
                label="Suspender servicio"
                tono="peligro"
                disabled={cliente.estado === 'cortado' || guardando}
                onClick={() =>
                  cambiarEstado(
                    'cortado',
                    `¿Suspender el servicio de ${cliente.nombre}? Se queda sin internet.`,
                  )
                }
              />
              <Herramienta
                icon={Activity}
                label="Conceder promesa"
                tono="ok"
                onClick={() =>
                  setPromesa({
                    dias: 3,
                    fecha: enDiasHabiles(3),
                    monto: Number(cliente.saldo) > 0 ? Number(cliente.saldo).toFixed(2) : '',
                    nota: '',
                  })
                }
              />
              <Herramienta
                icon={Trash2}
                label="Dar de baja"
                tono="peligro"
                disabled={cliente.estado === 'baja' || guardando}
                onClick={() => setBaja({ motivo: '', nota: '' })}
              />
            </div>
          </div>
        </div>

        <p className="mt-4 text-[11px] text-slate-500">
          Cada ejecución queda registrada con quién la hizo, desde qué IP y qué contestó el equipo.
        </p>
      </Card>

      {/* ---------------------------------------------------- Consola */}
      <Modal
        abierto={Boolean(consola)}
        titulo={consola?.titulo ?? 'Resultado'}
        onCerrar={() => setConsola(null)}
        ancho="max-w-2xl"
      >
        {consola?.cargando ? (
          <p className="py-8 text-center text-sm text-slate-400">Ejecutando en el equipo…</p>
        ) : consola?.error ? (
          <div className="space-y-2">
            <Aviso tipo="alerta">{consola.error}</Aviso>
            {consola.hint && <p className="text-xs text-slate-500">{consola.hint}</p>}
          </div>
        ) : (
          <ResultadoComando datos={consola?.resultado} />
        )}
      </Modal>

      {/* ---------------------------------------------------- WiFi */}
      <Modal abierto={Boolean(wifi)} titulo="Cambiar red WiFi" onCerrar={() => setWifi(null)}>
        {wifi && (
          <form onSubmit={guardarWifi} className="space-y-4">
            <Field label="Nombre de la red (SSID)" hint="Dejalo vacío para no cambiarlo">
              <Input
                value={wifi.ssid}
                onChange={(e) => setWifi((w) => ({ ...w, ssid: e.target.value }))}
                placeholder={cliente.nombre?.split(' ')[0]}
              />
            </Field>

            <Field label="Clave" hint="Mínimo 8 caracteres. Vacío = no se cambia">
              <Input
                value={wifi.clave}
                onChange={(e) => setWifi((w) => ({ ...w, clave: e.target.value }))}
              />
            </Field>

            <Aviso tipo="alerta">
              Al cambiarla, todos los aparatos de la casa se desconectan y hay que reconectarlos con
              la clave nueva. Avisale al abonado antes de aplicar.
            </Aviso>

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setWifi(null)}>
                Cancelar
              </Button>
              <Button
                variante="primario"
                type="submit"
                cargando={guardando}
                disabled={!wifi.ssid?.trim() && !wifi.clave?.trim()}
              >
                Aplicar
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------------------------------------------------- Promesa */}
      <Modal
        abierto={Boolean(promesa)}
        titulo="Conceder promesa de pago"
        onCerrar={() => setPromesa(null)}
      >
        {promesa && (
          <form onSubmit={crearPromesa} className="space-y-4">
            <Field label="Días hábiles" hint="No cuenta sábados ni domingos">
              <Select
                value={promesa.dias}
                onChange={(e) => {
                  const dias = Number(e.target.value)
                  setPromesa((p) => ({ ...p, dias, fecha: enDiasHabiles(dias) }))
                }}
              >
                {[1, 2, 3, 5, 7, 10].map((d) => (
                  <option key={d} value={d}>
                    {d} {d === 1 ? 'día hábil' : 'días hábiles'}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Vence el">
                <Input
                  type="date"
                  value={promesa.fecha}
                  onChange={(e) => setPromesa((p) => ({ ...p, fecha: e.target.value }))}
                  required
                />
              </Field>
              <Field label="Monto prometido" hint="Lo que debe hoy">
                <Input
                  type="number"
                  step="0.01"
                  value={promesa.monto}
                  onChange={(e) => setPromesa((p) => ({ ...p, monto: e.target.value }))}
                />
              </Field>
            </div>

            <Field label="Nota">
              <Input
                value={promesa.nota}
                onChange={(e) => setPromesa((p) => ({ ...p, nota: e.target.value }))}
                placeholder="Pidió plazo hasta que le paguen"
              />
            </Field>

            <Aviso>
              Al vencer sin que pague, el corte automático lo vuelve a dejar sin servicio.
            </Aviso>

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setPromesa(null)}>
                Cancelar
              </Button>
              <Button variante="primario" type="submit" cargando={guardando}>
                Conceder
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------------------------------------------------- Baja */}
      <Modal abierto={Boolean(baja)} titulo="Dar de baja el servicio" onCerrar={() => setBaja(null)}>
        {baja && (
          <form onSubmit={darDeBaja} className="space-y-4">
            <p className="text-sm text-slate-300">
              {cliente.nombre} queda fuera de la facturación mensual y de los cortes. Su historial de
              facturas y pagos se conserva.
            </p>

            <Field
              label="Motivo"
              hint="Decide si la pérdida le cuenta al vendedor en la calidad de su cartera"
            >
              <Select
                value={baja.motivo}
                onChange={(e) => setBaja((b) => ({ ...b, motivo: e.target.value }))}
                required
              >
                <option value="">Elegí un motivo…</option>
                {motivos.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.nombre}
                    {m.afecta_calidad ? '' : ' — no afecta al vendedor'}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Nota" hint="Opcional, para el que lea esto dentro de un año">
              <Input
                value={baja.nota}
                onChange={(e) => setBaja((b) => ({ ...b, nota: e.target.value }))}
                placeholder="Se mudó a una zona sin cobertura"
              />
            </Field>

            <Aviso tipo="alerta">
              Elegir bien el motivo importa: los que no son responsabilidad del vendedor salen del
              cálculo de calidad en lugar de restarle.
            </Aviso>

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setBaja(null)}>
                Cancelar
              </Button>
              <Button variante="peligro" type="submit" cargando={guardando} disabled={!baja.motivo}>
                Dar de baja
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  )
}

/**
 * El día hábil número N contando desde mañana.
 *
 * Una promesa que vence un domingo no sirve: el abonado no tiene dónde pagar y
 * el corte del lunes lo agarra sin haber tenido la oportunidad.
 */
function enDiasHabiles(dias) {
  const d = new Date()
  let contados = 0
  while (contados < dias) {
    d.setDate(d.getDate() + 1)
    if (d.getDay() !== 0 && d.getDay() !== 6) contados++
  }
  return d.toISOString().slice(0, 10)
}

/** Muestra el resultado según qué comando fue, en vez de un JSON crudo. */
function ResultadoComando({ datos }) {
  if (!datos) return <p className="text-sm text-slate-500">Sin respuesta.</p>

  // Ping
  if (datos.enviados !== undefined) {
    const perdido = Number(datos.perdida) > 0
    return (
      <div className="space-y-3">
        <div
          className={`rounded-lg border p-4 text-center ${
            datos.recibidos === 0
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              : perdido
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
          }`}
        >
          <p className="font-mono text-sm">{datos.destino}</p>
          <p className="mt-1 text-2xl font-bold">
            {datos.recibidos === 0 ? 'No responde' : `${datos.ms_promedio} ms`}
          </p>
          <p className="text-xs opacity-80">
            {datos.recibidos} de {datos.enviados} paquetes · {datos.perdida ?? 0}% de pérdida
          </p>
        </div>

        {datos.recibidos > 0 && (
          <p className="text-center text-xs text-slate-500">
            mínimo {datos.ms_min} ms · máximo {datos.ms_max} ms
          </p>
        )}

        {datos.recibidos === 0 && (
          <Aviso tipo="alerta">
            El equipo no contesta. Puede estar apagado, sin energía o con el cable cortado — la
            potencia óptica dice cuál de las tres.
          </Aviso>
        )}
      </div>
    )
  }

  // Traceroute
  if (datos.saltos) {
    return (
      <ol className="space-y-1">
        {datos.saltos.map((s) => (
          <li
            key={s.salto}
            className="flex items-center gap-3 rounded border border-slate-800 px-3 py-2 text-sm"
          >
            <span className="w-6 text-right font-mono text-xs text-slate-500">{s.salto}</span>
            <span className="flex-1 font-mono text-slate-200">{s.direccion}</span>
            <span className="text-xs text-slate-400">{s.ms ?? '—'} ms</span>
          </li>
        ))}
      </ol>
    )
  }

  // Señal óptica o de radio
  if (datos.tipo === 'optica' || datos.tipo === 'radio') {
    const rx = Number(datos.rx_power_dbm ?? datos.rx ?? NaN)
    return (
      <div className="space-y-3">
        {Number.isFinite(rx) ? (
          <div
            className={`rounded-lg border p-4 text-center ${
              rx > -8 || rx < -27
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                : rx < -24
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                  : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
            }`}
          >
            <p className="text-3xl font-bold">{rx} dBm</p>
            <p className="text-xs opacity-80">
              {rx < -27 ? 'Fuera de rango: revisar la fibra' : rx < -24 ? 'Al límite' : 'Dentro de rango'}
            </p>
          </div>
        ) : (
          <p className="text-sm text-slate-300">
            {datos.alcanzable ? 'El equipo responde.' : 'El equipo no responde.'}
          </p>
        )}
        {datos.aviso && <p className="text-xs text-slate-500">{datos.aviso}</p>}
      </div>
    )
  }

  // Dispositivos conectados
  if (datos.dispositivos) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-slate-300">
          <b>{datos.total}</b> {datos.total === 1 ? 'equipo conectado' : 'equipos conectados'}
        </p>
        <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
          {datos.dispositivos.map((d) => (
            <li key={d.mac ?? d.ip} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="font-mono text-slate-200">{d.ip}</span>
              <span className="font-mono text-xs text-slate-500">{d.mac}</span>
            </li>
          ))}
        </ul>
        {datos.aviso && <p className="text-xs text-amber-400">{datos.aviso}</p>}
      </div>
    )
  }

  // Test de velocidad
  if (datos.subida !== undefined || datos.bajada !== undefined) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-slate-700 p-4 text-center">
            <p className="text-[11px] uppercase text-slate-500">Bajada</p>
            <p className="text-xl font-bold text-sky-300">{fmtBytes(datos.bajada)}</p>
          </div>
          <div className="rounded-lg border border-slate-700 p-4 text-center">
            <p className="text-[11px] uppercase text-slate-500">Subida</p>
            <p className="text-xl font-bold text-violet-300">{fmtBytes(datos.subida)}</p>
          </div>
        </div>
        {datos.aviso && <p className="text-xs text-slate-500">{datos.aviso}</p>}
      </div>
    )
  }

  // Reinicio, kick, wifi: un mensaje y listo.
  if (datos.mensaje) {
    return (
      <div className="space-y-2">
        <Aviso>{datos.mensaje}</Aviso>
        {datos.aviso && <p className="text-xs text-slate-500">{datos.aviso}</p>}
      </div>
    )
  }

  return (
    <pre className="max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-[11px] text-slate-300">
      {JSON.stringify(datos, null, 2)}
    </pre>
  )
}
