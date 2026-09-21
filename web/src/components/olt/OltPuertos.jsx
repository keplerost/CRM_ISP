import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { AlertTriangle, Power, RefreshCw, Search, ShieldAlert, Waves } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { dbm, nivel } from '../../lib/optica'
import { hace } from '../../lib/olts'
import { Aviso, Badge, Button, Card, ErrorBanner, Select, SkeletonTabla, Table } from '../ui'

/**
 * Puertos PON de una OLT.
 *
 * La pantalla del tramo, no la del abonado. Cuando algo se rompe en la fibra
 * —un empalme flojo, un conector sucio, un módulo óptico muriéndose— caen todos
 * los abonados de un puerto a la vez, y desde la ficha de cada uno parece un
 * problema distinto. Acá se ve que son quince reclamos con una sola causa.
 *
 * Dos velocidades a propósito:
 *
 *  - Lo de la base (cuántas ONTs tiene cada puerto, su señal promedio) sale al
 *    instante.
 *  - Lo del equipo (potencia Tx del módulo, temperatura, ONU rogue, última
 *    caída) cuesta un comando por puerto, así que va con su botón.
 */

const CAPACIDAD = 128

/**
 * Estructura provisoria a partir de lo que sabe la base.
 *
 * Solo conoce los puertos que tienen abonados: los vacíos aparecen recién
 * cuando contesta el equipo. Es a propósito — inventar los dieciséis mostraría
 * puertos que quizá no existen en esa placa.
 */
function armarDesdeConteos(conteos) {
  const porSlot = new Map()
  for (const c of conteos) {
    if (!porSlot.has(c.slot)) porSlot.set(c.slot, { slot: c.slot, puertos: [] })
    porSlot.get(c.slot).puertos.push({ puerto: c.puerto, tipo: 'GPON', ok: true })
  }
  return [...porSlot.values()]
    .map((t) => ({ ...t, puertos: t.puertos.sort((a, b) => a.puerto - b.puerto) }))
    .sort((a, b) => a.slot - b.slot)
}

/** Barra de ocupación del puerto. */
function Carga({ ocupados }) {
  const pct = Math.round((ocupados / CAPACIDAD) * 100)
  const color = pct >= 90 ? 'bg-rose-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <div className="min-w-[120px]">
      <div className="h-2 overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full ${color}`} style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
      <p className="mt-0.5 text-[10px] text-slate-500">
        {ocupados} / {CAPACIDAD} ({pct}%)
      </p>
    </div>
  )
}

export default function OltPuertos({ olt }) {
  const confirmar = useConfirmar()
  const [tarjetas, setTarjetas] = useState(null)
  const [conteos, setConteos] = useState([])
  const [detalle, setDetalle] = useState(new Map())
  const [slot, setSlot] = useState('')
  const [cargando, setCargando] = useState(true)
  const [actualizando, setActualizando] = useState(false)
  const [reiniciando, setReiniciando] = useState(null)
  const [enAccion, setEnAccion] = useState(null)
  const [error, setError] = useState(null)
  const [aviso, setAviso] = useState(null)

  /**
   * En dos tiempos, y el orden importa.
   *
   * Primero la base, que contesta al instante y ya deja la tabla usable con los
   * puertos que tienen abonados. Después la estructura completa del equipo, que
   * sale de la CLI y tarda unos quince segundos — pero para entonces el
   * operador ya está mirando datos en vez de una pantalla vacía.
   */
  const cargar = useCallback(async () => {
    setError(null)

    const { data } = await supabase.from('v_pon_puertos').select('*').eq('olt_id', olt.id)
    setConteos(data ?? [])

    // Con esto solo ya se puede dibujar: los puertos que tienen ONTs se
    // conocen sin preguntarle a nadie.
    if (data?.length) {
      setTarjetas((previas) => previas ?? armarDesdeConteos(data))
      setSlot((actual) => actual || String(data[0].slot))
    }

    setCargando(true)
    try {
      const r = await api.olt.puertosPon(olt.id)
      setTarjetas(r.tarjetas ?? [])
      setSlot((actual) => actual || (r.tarjetas?.length ? String(r.tarjetas[0].slot) : ''))
    } catch (err) {
      setError(err)
      setTarjetas((previas) => previas ?? [])
    } finally {
      setCargando(false)
    }
    // `slot` NO va en las dependencias: se escribe acá adentro, y tenerlo
    // haría que elegir la placa recreara esta función y disparara otra carga.
    // No sería solo desperdicio — `puertosPon` habla con la OLT por la CLI.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [olt.id])

  useEffect(() => {
    cargar()
  }, [cargar])

  /** Lo caro: un comando por puerto contra el equipo. */
  async function actualizarDetalle() {
    if (!slot) return
    setActualizando(true)
    setError(null)
    try {
      const r = await api.olt.estadoPuertos(olt.id, { slot: Number(slot) })
      const m = new Map(detalle)
      for (const p of r.puertos ?? []) m.set(`${p.slot}/${p.puerto}`, p)
      setDetalle(m)
    } catch (err) {
      setError(err)
    } finally {
      setActualizando(false)
    }
  }

  /**
   * Acciones sobre TODOS los puertos de la placa.
   *
   * Cada una avisa exactamente qué va a pasar y a cuántos abonados afecta. Un
   * "¿estás seguro?" genérico se aprieta sin leer; uno que dice "91 abonados
   * sin servicio" se lee.
   */
  const ACCIONES = {
    encender: {
      label: 'Encender todos los puertos',
      variante: 'secundario',
      icono: Power,
      confirmar: () =>
        `Encender el láser de los 16 puertos de la placa ${slot}.\n\n` +
        'Los que ya estaban encendidos no cambian. Los apagados vuelven a dar servicio.\n\n¿Continuar?',
      hecho: (r) => `${r.hechos.length} puertos encendidos.`,
    },
    autofind_on: {
      label: 'Activar autofind',
      variante: 'secundario',
      icono: Search,
      confirmar: () =>
        `Activar el auto-find en los 16 puertos de la placa ${slot}.\n\n` +
        'Sin auto-find, una ONT nueva se conecta y el equipo no la reporta: el técnico la instala y nadie se entera.\n\n¿Continuar?',
      hecho: (r) => `Auto-find activado en ${r.hechos.length} puertos.`,
    },
    reiniciar_onts: {
      label: 'Reiniciar TODAS las ONTs',
      variante: 'peligro',
      icono: AlertTriangle,
      confirmar: (total) =>
        `⚠ Reiniciar TODAS las ONTs de la placa ${slot}.\n\n` +
        `Son ${total} abonados que van a quedar sin servicio uno o dos minutos, TODOS a la vez.\n\n` +
        'Se hace de forma ordenada (graceful), pero es lo más disruptivo que hace esta pantalla.\n\n' +
        '¿Seguro que querés continuar?',
      hecho: (r) => `Reinicio enviado a ${r.hechos.length} puertos.`,
    },
  }

  async function accionMasiva(clave) {
    const a = ACCIONES[clave]
    const total = conteos
      .filter((c) => c.slot === Number(slot))
      .reduce((x, c) => x + Number(c.onus), 0)

    if (!await confirmar(a.confirmar(total))) return

    setEnAccion(clave)
    setError(null)
    setAviso(null)
    try {
      const r = await api.olt.accionPuertos(olt.id, { slot: Number(slot), accion: clave })
      setAviso(
        a.hecho(r) +
          (r.fallos.length
            ? ` ${r.fallos.length} fallaron: ${r.fallos.map((f) => `puerto ${f.puerto} (${f.motivo})`).join(', ')}`
            : ''),
      )
    } catch (err) {
      setError(err)
    } finally {
      setEnAccion(null)
    }
  }

  async function reiniciar(p) {
    const cuantas = conteo(p.slot, p.puerto)?.onus ?? 0
    if (
      !await confirmar(
        `Reiniciar TODAS las ONTs de la placa ${p.slot} puerto ${p.puerto}.\n\n` +
          `Son ${cuantas} abonados que van a quedar sin servicio uno o dos minutos.\n\n` +
          'Se hace de forma ordenada (graceful): se les avisa antes de tirarlas.\n\n¿Continuar?',
      )
    ) {
      return
    }

    setReiniciando(`${p.slot}/${p.puerto}`)
    setError(null)
    setAviso(null)
    try {
      const r = await api.olt.reiniciarPuerto(olt.id, { slot: p.slot, puerto: p.puerto })
      setAviso(
        `Reinicio enviado a la placa ${r.slot} puerto ${r.puerto}. Las ONTs vuelven en uno o dos minutos.`,
      )
    } catch (err) {
      setError(err)
    } finally {
      setReiniciando(null)
    }
  }

  const slots = useMemo(() => [...new Set((tarjetas ?? []).map((t) => t.slot))], [tarjetas])
  const conteo = (s, p) => conteos.find((c) => c.slot === s && c.puerto === p)
  const visible = (tarjetas ?? []).filter((t) => !slot || t.slot === Number(slot))

  const rogue = [...detalle.values()].filter((d) => d.rogue_detectada)

  return (
    <Card
      title="Puertos PON"
      subtitle={
        tarjetas
          ? `${visible.reduce((a, t) => a + (t.puertos?.length ?? 0), 0)} puertos · ${conteos.reduce((a, c) => a + Number(c.onus), 0)} ONTs`
          : olt.ip_host
      }
      icon={Waves}
      actions={
        <div className="flex flex-wrap gap-2">
          {slots.length > 1 && (
            <Select value={slot} onChange={(e) => setSlot(e.target.value)} className="w-auto">
              {slots.map((s) => (
                <option key={s} value={s}>
                  Placa {s}
                </option>
              ))}
            </Select>
          )}
          <Button icon={RefreshCw} onClick={cargar} cargando={cargando}>
            Recargar
          </Button>
          <Button
            variante="primario"
            icon={Waves}
            onClick={actualizarDetalle}
            cargando={actualizando}
          >
            Actualizar info del equipo
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Acciones sobre toda la placa. Van juntas y separadas de la tabla:
            son de otra naturaleza que mirar un puerto. */}
        <div className="flex flex-wrap items-center gap-2 t-panel px-3 py-2">
          <span className="text-[11px] uppercase tracking-wider text-slate-500">
            Placa {slot || '—'}
          </span>
          {Object.entries(ACCIONES).map(([clave, a]) => (
            <Button
              key={clave}
              variante={a.variante}
              icon={a.icono}
              onClick={() => accionMasiva(clave)}
              cargando={enAccion === clave}
              disabled={!slot || enAccion !== null}
            >
              {a.label}
            </Button>
          ))}
        </div>

        <ErrorBanner error={error} onCerrar={() => setError(null)} />
        {aviso && <Aviso>{aviso}</Aviso>}

        {/* La detección de ONU rogue no se puede activar ni desactivar en este
            firmware: `rogue-ont` no existe como comando. Ya viene siempre
            activa y se lee del estado de cada puerto. Decirlo evita buscar un
            botón que no puede existir. */}
        {detalle.size > 0 && rogue.length === 0 && (
          <p className="text-[11px] text-slate-500">
            Detección de ONU rogue: <b className="text-emerald-400">sin novedades</b> en los{' '}
            {detalle.size} puertos consultados. Este equipo la trae siempre activa — no se
            enciende ni se apaga, se consulta.
          </p>
        )}

        {rogue.length > 0 && (
          <Aviso tipo="alerta">
            <span className="flex items-start gap-2">
              <ShieldAlert size={15} className="mt-0.5 shrink-0" />
              <span>
                <b>ONU rogue detectada</b> en{' '}
                {rogue.map((r) => `placa ${r.slot} puerto ${r.puerto}`).join(', ')}. Una ONU rogue
                transmite fuera de su turno y degrada a <b>todos</b> los abonados del puerto — es
                de las averías más difíciles de encontrar sin este aviso.
              </span>
            </span>
          </Aviso>
        )}

        {detalle.size === 0 && !actualizando && (
          <Aviso>
            La tabla muestra lo que sabe la base: ONTs por puerto y señal promedio. La potencia del
            módulo de la OLT, su temperatura, la detección de ONU rogue y la última caída de cada
            puerto se leen del equipo con <b>Actualizar info del equipo</b> — es un comando por
            puerto, así que tarda alrededor de un minuto.
          </Aviso>
        )}

        {cargando && !tarjetas ? (
          <SkeletonTabla filas={8} columnas={7} />
        ) : (
          <Table
            columnas={[
              'Puerto',
              'Tipo',
              'Estado',
              'ONTs',
              'Carga',
              'Señal media',
              'Tx OLT',
              'Módulo',
              'Última caída',
              '',
            ]}
            filas={visible.flatMap((t) => (t.puertos ?? []).map((p) => ({ ...p, slot: t.slot })))}
            vacio="Esta placa no reporta puertos PON."
            renderFila={(p) => {
              const c = conteo(p.slot, p.puerto)
              const d = detalle.get(`${p.slot}/${p.puerto}`)
              const n = nivel(c?.rx_promedio)
              const clave = `${p.slot}/${p.puerto}`

              return (
                <tr
                  key={clave}
                  className={`text-slate-300 ${d?.rogue_detectada ? 'bg-rose-500/10' : ''}`}
                >
                  <td className="px-3 py-2 font-mono text-sm text-slate-100">{p.puerto}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{p.tipo}</td>

                  <td className="px-3 py-2">
                    <Badge color={p.ok ? 'verde' : 'rojo'}>
                      {d?.estado ?? (p.ok ? 'Online' : 'Down')}
                    </Badge>
                    {d?.autofind === true && (
                      <span className="ml-1 text-[10px] text-sky-400">autofind</span>
                    )}
                    {d?.autofind === false && (
                      <span className="ml-1 text-[10px] text-slate-600">sin autofind</span>
                    )}
                  </td>

                  <td className="px-3 py-2 text-xs">
                    {c ? (
                      <>
                        <span className="text-emerald-400">{c.online}</span>
                        <span className="text-slate-600"> / {c.onus}</span>
                      </>
                    ) : (
                      <span className="text-slate-600">0</span>
                    )}
                  </td>

                  <td className="px-3 py-2">
                    <Carga ocupados={Number(c?.onus ?? 0)} />
                  </td>

                  <td className="px-3 py-2 text-xs">
                    {c?.rx_promedio != null ? (
                      <span className={n.punto === 'bg-rose-500' ? 'text-rose-300' : ''}>
                        {dbm(c.rx_promedio)}
                      </span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                    {c?.senal_critica > 0 && (
                      <span className="ml-1 text-[10px] text-rose-400">
                        {c.senal_critica} bajas
                      </span>
                    )}
                  </td>

                  {/* La potencia del módulo de la OLT: si baja, el problema es
                      del puerto y no de los equipos de los abonados. */}
                  <td className="px-3 py-2 text-xs">
                    {d?.modulo?.tx_dbm != null ? (
                      `${d.modulo.tx_dbm} dBm`
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>

                  <td className="px-3 py-2 text-xs">
                    {d?.modulo ? (
                      <span className={d.modulo.ok ? 'text-slate-400' : 'text-rose-300'}>
                        {d.modulo.temperatura_c != null ? `${d.modulo.temperatura_c} °C` : ''}
                        {d.modulo.clase ? ` · ${d.modulo.clase}` : ''}
                        {d.modulo.distancia_max_km ? ` · ${d.modulo.distancia_max_km} km` : ''}
                      </span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>

                  {/* Un puerto que está arriba pero se cayó tres veces esta
                      semana es un problema. La foto sola no lo dice. */}
                  <td className="px-3 py-2 text-xs">
                    {d?.ultima_caida ? (
                      <span
                        title={new Date(d.ultima_caida).toLocaleString('es-EC')}
                        className="text-slate-400"
                      >
                        {hace(Math.floor((Date.now() - new Date(d.ultima_caida)) / 1000))}
                        {d.ultima_caida_causa && (
                          <span className="ml-1 text-amber-400/80">{d.ultima_caida_causa}</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>

                  <td className="px-3 py-2 text-right">
                    <Button
                      variante="fantasma"
                      icon={Power}
                      title={`Reinicia las ${c?.onus ?? 0} ONTs de este puerto`}
                      className="text-amber-400 hover:bg-amber-500/10"
                      cargando={reiniciando === clave}
                      disabled={!c?.onus}
                      onClick={() => reiniciar(p)}
                    >
                      Reiniciar ONTs
                    </Button>
                  </td>
                </tr>
              )
            }}
          />
        )}

        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-500">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-500/70" />
          <span>
            <b className="text-slate-400">Reiniciar ONTs</b> deja sin servicio a todos los abonados
            del puerto por uno o dos minutos. Se hace de forma ordenada —se les avisa antes de
            tirarlas— y sirve cuando muchas quedaron colgadas después de un corte de fibra y no
            reenganchan solas.
          </span>
        </p>
      </div>
    </Card>
  )
}
