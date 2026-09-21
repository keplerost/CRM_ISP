import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  HardDrive,
  Power,
  RefreshCw,
  Thermometer,
  Waves,
} from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, Card, Cargando, ErrorBanner } from '../ui'

/**
 * Estado de una OLT.
 *
 * Contesta la pregunta que la pantalla de OLTs no contestaba: ¿está bien?
 * Y sobre todo las que avisan ANTES de que se caiga el servicio:
 *
 *  - Una placa de reserva en falla es invisible hasta que se necesita.
 *  - Un módulo óptico caído tira todos los abonados de ese puerto a la vez, y
 *    desde la ficha de cada uno parece un problema distinto.
 *  - La temperatura sube de a poco durante meses y nadie la mira hasta que el
 *    equipo apaga placas solo.
 *
 * Lo que el equipo no sabe contestar se dice explícitamente. Un hueco en la
 * pantalla se lee como "está en cero", y en un tablero de salud eso es peor que
 * no mostrar nada.
 */

/** Verde hasta 50 °C, ámbar hasta 60, rojo arriba: ahí empiezan a sufrir. */
const colorTemp = (c) =>
  c == null ? 'text-slate-500' : c >= 60 ? 'text-rose-400' : c >= 50 ? 'text-amber-400' : 'text-emerald-400'

function Dato({ icono: Icono, etiqueta, valor, sub, color = 'text-slate-100' }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-slate-500">{etiqueta}</span>
        {Icono && <Icono size={15} className="text-slate-600" />}
      </div>
      <p className={`mt-1.5 text-xl font-semibold ${color}`}>{valor}</p>
      {sub && <p className="mt-0.5 text-[11px] text-slate-500">{sub}</p>}
    </div>
  )
}

/**
 * Con `auto` en false no consulta al montarse y espera a que se lo pidan.
 *
 * Importa dentro de la ficha: son nueve comandos por la CLI, y abrir una
 * pestaña no debería costar una sesión contra el equipo si el que la abrió venía
 * a mirar otra cosa.
 */
export default function SaludOlt({ olt, onCerrar, auto = true }) {
  const [salud, setSalud] = useState(null)
  const [cargando, setCargando] = useState(auto)
  const [error, setError] = useState(null)

  const consultar = useCallback(async () => {
    setCargando(true)
    setError(null)
    try {
      setSalud(await api.olt.salud(olt.id))
    } catch (err) {
      setError(err)
      setSalud(null)
    } finally {
      setCargando(false)
    }
  }, [olt.id])

  useEffect(() => {
    if (auto) consultar()
  }, [auto, consultar])

  const r = salud?.resumen

  return (
    <Card
      title={`Estado de ${olt.nombre}`}
      subtitle={
        salud?.version
          ? `${salud.version.modelo} · ${salud.version.firmware}${salud.version.parche ? ` (${salud.version.parche})` : ''}`
          : olt.ip_host
      }
      icon={HardDrive}
      actions={
        <div className="flex gap-2">
          <Button icon={RefreshCw} onClick={consultar} cargando={cargando}>
            Actualizar
          </Button>
          {onCerrar && (
            <Button variante="fantasma" onClick={onCerrar}>
              Cerrar
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {cargando && !salud ? (
          <Cargando texto="Consultando el equipo… tarda unos segundos" />
        ) : !salud ? (
          !error && (
            <p className="py-2 text-xs leading-relaxed text-slate-500">
              Temperatura, placas, consumo y puertos PON se leen en vivo del equipo. Son varios
              comandos por la CLI, así que se piden cuando hacen falta y no en cada carga de la
              página. Apretá <b className="text-slate-300">Actualizar</b>.
            </p>
          )
        ) : (
          <>
            {/* El veredicto primero: es lo que se viene a mirar. */}
            <div
              className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${
                r.sano
                  ? 'border-emerald-500/40 bg-emerald-500/10'
                  : 'border-amber-500/40 bg-amber-500/10'
              }`}
            >
              {r.sano ? (
                <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-400" />
              ) : (
                <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-400" />
              )}
              <div>
                <p className={`font-semibold ${r.sano ? 'text-emerald-300' : 'text-amber-300'}`}>
                  {r.sano ? 'Sin problemas' : 'Requiere atención'}
                </p>
                <p className="mt-0.5 text-sm text-slate-400">
                  {r.sano
                    ? `${r.placas} placas en orden y ${r.puertos_pon} puertos PON con su módulo óptico activo.`
                    : [
                        r.placas_con_falla && `${r.placas_con_falla} placas con falla`,
                        r.puertos_caidos && `${r.puertos_caidos} puertos PON caídos`,
                        r.temperatura_alta && `temperatura alta (${r.temperatura_max} °C)`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Dato
                icono={Clock}
                etiqueta="Encendida hace"
                valor={salud.uptime?.texto ?? '—'}
                sub={
                  salud.uptime && salud.uptime.dias < 1
                    ? 'Se reinició hace poco'
                    : salud.uptime
                      ? `${salud.uptime.dias} días sin reiniciar`
                      : 'El equipo no lo reporta'
                }
              />
              <Dato
                icono={Thermometer}
                etiqueta="Temperatura máxima"
                valor={r.temperatura_max != null ? `${r.temperatura_max} °C` : '—'}
                sub={`de ${salud.temperaturas.length} placas medidas`}
                color={colorTemp(r.temperatura_max)}
              />
              <Dato
                icono={Power}
                etiqueta="Consumo"
                valor={salud.potencia ? `${salud.potencia.watts} W` : '—'}
                sub={salud.potencia ? 'Máximo del bastidor' : 'El equipo no lo reporta'}
              />
              <Dato
                icono={Waves}
                etiqueta="Puertos PON"
                valor={r.puertos_pon}
                sub={r.puertos_caidos ? `${r.puertos_caidos} sin módulo óptico` : 'todos activos'}
                color={r.puertos_caidos ? 'text-rose-400' : 'text-slate-100'}
              />
            </div>

            {/* El reloj no rompe nada hoy, pero deja los eventos del equipo sin
                poder cruzarse con los del resto del sistema. */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-slate-800 bg-slate-950/40 px-4 py-2.5 text-xs">
              <span className="text-slate-400">
                Hora del equipo:{' '}
                <span className="font-mono text-slate-200">{salud.hora?.texto ?? '—'}</span>
              </span>
              {salud.hora?.desfase_segundos != null && (
                <span className={r.reloj_desfasado ? 'text-amber-300' : 'text-slate-500'}>
                  {r.reloj_desfasado
                    ? `desfasada ${Math.round(Math.abs(salud.hora.desfase_segundos) / 60)} min — los eventos no se van a poder cruzar con el resto del sistema`
                    : 'en hora'}
                </span>
              )}
              {salud.frame && (
                <span className="text-slate-400">
                  Bastidor: <span className="text-slate-200">{salud.frame.tipo}</span>{' '}
                  <Badge color={salud.frame.ok ? 'verde' : 'rojo'}>{salud.frame.estado}</Badge>
                </span>
              )}
            </div>

            {/* --- Placas --- */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Placas
              </h3>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {salud.placas.map((p) => {
                  const temp = salud.temperaturas.find((t) => t.slot === p.slot)
                  return (
                    <div
                      key={p.slot}
                      className={`flex items-center justify-between rounded-lg border px-3 py-2 ${
                        p.ok ? 'border-slate-800 bg-slate-950/40' : 'border-rose-500/50 bg-rose-500/10'
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-slate-100">
                          <span className="text-slate-500">Slot {p.slot}</span> {p.placa}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          {p.estado}
                          {p.reserva && ' · en espera, es lo correcto'}
                        </p>
                      </div>
                      {temp && (
                        <span className={`shrink-0 text-sm font-medium ${colorTemp(temp.celsius)}`}>
                          {temp.celsius}°
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* --- Puertos PON --- */}
            {salud.tarjetas.map((t) => (
              <div key={t.slot}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Puertos PON · slot {t.slot} · {t.placa}
                  {t.alimentacion && (
                    <span className="ml-2 font-normal normal-case text-slate-600">
                      {t.alimentacion}
                    </span>
                  )}
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {t.puertos.map((p) => (
                    <span
                      key={p.puerto}
                      title={`Puerto ${p.puerto} · ${p.tipo} · módulo ${p.modulo_optico} · alcance ${p.distancia_max_km} km`}
                      className={`inline-flex h-8 w-11 flex-col items-center justify-center rounded border text-[10px] leading-none ${
                        p.ok
                          ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                          : 'border-rose-500/50 bg-rose-500/15 text-rose-300'
                      }`}
                    >
                      <span className="font-semibold">{p.puerto}</span>
                      <span className="opacity-70">{p.ok ? 'ok' : 'off'}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}

            {salud.no_reportado?.length > 0 && (
              <Aviso>
                <span className="flex items-start gap-2">
                  <Cpu size={14} className="mt-0.5 shrink-0" />
                  <span>
                    Este modelo no reporta: <b>{salud.no_reportado.join(', ')}</b>. No es que estén
                    en cero — el equipo no tiene el comando. Se dice para que un hueco en la
                    pantalla no se lea como una medición.
                  </span>
                </span>
              </Aviso>
            )}
          </>
        )}
      </div>
    </Card>
  )
}
