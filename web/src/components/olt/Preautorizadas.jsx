import { useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { Check, Clock, Plus, RotateCcw, Trash2, Zap } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, ErrorBanner, Field, Input, Select, Table } from '../ui'

/**
 * ONTs cargadas antes de que lleguen.
 *
 * Hoy, autorizar exige que alguien esté mirando la pantalla justo cuando el
 * técnico conecta la ONT. Cargándola de antemano —serie, plantilla y nombre del
 * abonado— el técnico conecta y el sistema la autoriza solo, en el barrido
 * siguiente.
 *
 * Es lo único del sistema que escribe en un equipo de producción sin que nadie
 * apriete nada, así que la pantalla dice exactamente qué va a pasar y con qué
 * datos.
 */
export default function Preautorizadas({ olt, presets = [], planes = [], onListo }) {
  const confirmar = useConfirmar()
  const [lista, setLista] = useState([])
  const [nueva, setNueva] = useState(null)
  const [error, setError] = useState(null)
  const [guardando, setGuardando] = useState(false)

  async function cargar() {
    try {
      setLista(await api.olt.preautorizadas(olt ? { olt_id: olt.id } : {}))
    } catch (err) {
      setError(err)
    }
  }

  useEffect(() => {
    cargar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [olt?.id])

  const enBlanco = () => ({
    sn: '',
    preset_id: presets.find((p) => p.predeterminado)?.id ?? '',
    nombre: '',
    comentario: '',
    plan_id: '',
    vlan: '',
    slot: '',
    puerto: '',
    automatica: true,
    vence_at: '',
  })

  async function guardar() {
    setGuardando(true)
    setError(null)
    try {
      const preset = presets.find((p) => p.id === nueva.preset_id)
      await api.olt.cargarPreautorizada(olt.id, {
        ...nueva,
        // Lo que no se escribió lo pone la plantilla.
        vlan: nueva.vlan || preset?.vlan || '',
        plan_id: nueva.plan_id || preset?.plan_id || null,
        vence_at: nueva.vence_at || null,
      })
      setNueva(null)
      await cargar()
      onListo?.()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  async function borrar(p) {
    if (!await confirmar(`Sacar ${p.sn} de la lista?\n\nSi ya está autorizada, la ONT no se toca.`)) return
    try {
      await api.olt.borrarPreautorizada(p.id)
      await cargar()
    } catch (err) {
      setError(err)
    }
  }

  async function reactivar(p) {
    try {
      await api.olt.reactivarPreautorizada(p.id)
      await cargar()
    } catch (err) {
      setError(err)
    }
  }

  const preset = nueva ? presets.find((p) => p.id === nueva.preset_id) : null
  const sinVlan = nueva && !nueva.vlan && !preset?.vlan

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-xs leading-relaxed text-slate-500">
          Se cargan con la serie del equipo antes de instalarlo. Cuando el técnico lo conecta, el
          barrido las encuentra y las autoriza con estos datos, sin que nadie tenga que estar
          mirando.
        </p>
        {olt && (
          <Button variante="primario" icon={Plus} onClick={() => setNueva(enBlanco())}>
            Cargar ONU
          </Button>
        )}
      </div>

      {nueva && (
        <div className="space-y-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Serie de la ONT" hint="La de la etiqueta, como HWTC1234ABCD">
              <Input
                value={nueva.sn}
                onChange={(e) => setNueva({ ...nueva, sn: e.target.value.toUpperCase().trim() })}
                className="font-mono"
              />
            </Field>
            <Field label="Plantilla">
              <Select
                value={nueva.preset_id ?? ''}
                onChange={(e) => setNueva({ ...nueva, preset_id: e.target.value })}
              >
                <option value="">— sin plantilla —</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}
                    {p.vlan ? ` · VLAN ${p.vlan}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="VLAN" hint={preset?.vlan ? `la plantilla trae ${preset.vlan}` : null}>
              <Input
                type="number"
                value={nueva.vlan}
                placeholder={preset?.vlan ?? ''}
                onChange={(e) => setNueva({ ...nueva, vlan: e.target.value })}
              />
            </Field>

            <Field label="Abonado" className="sm:col-span-2">
              <Input
                value={nueva.nombre}
                onChange={(e) => setNueva({ ...nueva, nombre: e.target.value })}
              />
            </Field>
            <Field label="Plan">
              <Select
                value={nueva.plan_id ?? ''}
                onChange={(e) => setNueva({ ...nueva, plan_id: e.target.value })}
              >
                <option value="">{preset?.plan_id ? 'el de la plantilla' : 'Sin plan'}</option>
                {planes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Dirección / referencia" className="sm:col-span-2">
              <Input
                value={nueva.comentario}
                onChange={(e) => setNueva({ ...nueva, comentario: e.target.value })}
              />
            </Field>
            <Field label="Vence" hint="opcional: hasta cuándo esperarla">
              <Input
                type="date"
                value={nueva.vence_at}
                onChange={(e) => setNueva({ ...nueva, vence_at: e.target.value })}
              />
            </Field>

            <Field label="Placa esperada" hint="opcional">
              <Input
                type="number"
                value={nueva.slot}
                onChange={(e) => setNueva({ ...nueva, slot: e.target.value })}
              />
            </Field>
            <Field label="Puerto esperado" hint="opcional">
              <Input
                type="number"
                value={nueva.puerto}
                onChange={(e) => setNueva({ ...nueva, puerto: e.target.value })}
              />
            </Field>
          </div>

          <label className="flex items-start gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={nueva.automatica}
              onChange={(e) => setNueva({ ...nueva, automatica: e.target.checked })}
              className="mt-0.5 accent-sky-500"
            />
            <span>
              Autorizarla sola cuando aparezca.
              <span className="block text-[11px] text-slate-500">
                Sin esto, cuando se conecte queda lista para autorizar con un clic pero no se
                toca el equipo.
              </span>
            </span>
          </label>

          {sinVlan && (
            <Aviso tipo="alerta">
              Falta la VLAN. Sin ella la ONT se registraría sin service-port: quedaría conectada y
              sin pasar tráfico, que es lo más difícil de diagnosticar porque desde el lado GPON se
              ve todo bien.
            </Aviso>
          )}

          {nueva.slot === '' && nueva.puerto === '' && nueva.automatica && (
            <p className="text-[11px] leading-snug text-slate-500">
              Sin placa ni puerto esperados, se autoriza donde sea que aparezca. Cargándolos, si
              aparece en otro lado no se toca y queda avisado — que es lo que conviene si el equipo
              puede terminar en manos de otro.
            </p>
          )}

          <div className="flex gap-2">
            <Button
              variante="primario"
              icon={Check}
              cargando={guardando}
              disabled={!nueva.sn?.trim() || sinVlan}
              onClick={guardar}
            >
              Cargar
            </Button>
            <Button variante="fantasma" onClick={() => setNueva(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {lista.length === 0 ? (
        <p className="px-1 py-6 text-center text-sm text-slate-500">
          No hay ONUs cargadas esperando.
        </p>
      ) : (
        <Table
          columnas={['Serie', 'Abonado', 'Estado', 'VLAN', 'Modo', '']}
          filas={lista}
          renderFila={(p) => (
            <tr key={p.id} className="text-slate-300">
              <td className="px-3 py-2 font-mono text-xs text-slate-100">
                {p.sn}
                {!olt && <span className="block text-[11px] text-slate-500">{p.olt}</span>}
              </td>
              <td className="px-3 py-2 text-xs">
                {p.nombre ?? p.instalacion_nombre ?? '—'}
                {p.preset && <span className="block text-[11px] text-slate-500">{p.preset}</span>}
              </td>
              <td className="px-3 py-2 text-xs">
                <EstadoCarga p={p} />
              </td>
              <td className="px-3 py-2 font-mono text-xs">{p.vlan ?? '—'}</td>
              <td className="px-3 py-2 text-xs">
                {p.automatica ? (
                  <span className="flex items-center gap-1 text-sky-300">
                    <Zap size={11} /> sola
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-slate-500">
                    <Clock size={11} /> a mano
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-right">
                <div className="flex justify-end gap-1.5">
                  {p.estado === 'fallada' && (
                    <Button variante="fantasma" icon={RotateCcw} onClick={() => reactivar(p)}>
                      Reintentar
                    </Button>
                  )}
                  <Button variante="fantasma" icon={Trash2} onClick={() => borrar(p)}>
                    Quitar
                  </Button>
                </div>
              </td>
            </tr>
          )}
        />
      )}

      {lista.some((p) => p.estado === 'fallada') && (
        <Aviso tipo="alerta">
          Las falladas no se reintentan solas. Si el equipo rechazó el alta, repetir el mismo
          comando cada cinco minutos no la va a hacer entrar: hay que mirar el error.
        </Aviso>
      )}
    </div>
  )
}

function EstadoCarga({ p }) {
  if (p.estado === 'autorizada') return <Badge color="verde">autorizada</Badge>
  if (p.estado === 'cancelada') return <Badge color="gris">cancelada</Badge>
  if (p.estado === 'fallada') {
    return (
      <span>
        <Badge color="rojo">falló</Badge>
        <span className="mt-0.5 block text-[11px] leading-snug text-rose-300/70">
          {p.ultimo_error}
        </span>
      </span>
    )
  }
  if (p.vencida) return <Badge color="gris">vencida</Badge>
  if (p.ya_conectada) return <Badge color="azul">conectada, entrando</Badge>
  return <Badge color="gris">esperando que la conecten</Badge>
}
