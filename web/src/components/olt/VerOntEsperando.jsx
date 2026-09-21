import { useEffect, useState } from 'react'
import { AlertTriangle, ClipboardList, KeyRound, RefreshCw } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, Cargando, ErrorBanner } from '../ui'

/**
 * La ficha de una ONT que todavía nadie autorizó.
 *
 * Sirve para mirar antes de decidir. La pregunta que contesta no es "¿qué
 * modelo es?" —eso ya está en la lista— sino "¿esta ONT quién es?":
 *
 *   - ¿la sigue viendo el equipo AHORA, o se desconectó desde el último barrido?
 *   - ¿se acaba de conectar, o lleva días esperando que alguien la mire?
 *   - ¿hay una orden de instalación con esta serie?
 *   - ¿ya está dada de alta en algún lado?
 *
 * Las dos últimas son las que evitan el error caro: autorizar como nueva la ONT
 * de un abonado que se mudó, o darla de alta dos veces.
 */
export default function VerOntEsperando({ oltId, sn, onAutorizar, onCambio, onCerrar }) {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [resync, setResync] = useState(null)
  const [resincronizando, setResincronizando] = useState(false)

  async function cargar() {
    setCargando(true)
    setError(null)
    try {
      setDatos(await api.olt.verEsperando(oltId, sn))
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }

  useEffect(() => {
    cargar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oltId, sn])

  async function resincronizar() {
    setResincronizando(true)
    setError(null)
    setResync(null)
    try {
      const r = await api.olt.resyncEsperando(oltId, sn)
      setResync(r)
      onCambio?.()
      if (r.sigue) await cargar()
    } catch (err) {
      setError(err)
    } finally {
      setResincronizando(false)
    }
  }

  if (cargando && !datos) {
    return (
      <Cargando texto="Preguntándole al equipo…" />
    )
  }

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {resync && (
        <Aviso tipo={resync.sigue ? 'info' : 'alerta'}>
          {resync.sigue
            ? `El equipo la sigue viendo en ${resync.slot}/${resync.puerto}.`
            : resync.aviso}
        </Aviso>
      )}

      {datos && (
        <>
          {datos.en_la_cola === false && (
            <Aviso tipo="alerta">
              El equipo ya no la ve en la cola. Puede que la haya autorizado alguien más o que la
              hayan desconectado. Resincronizá para sacarla de la lista.
            </Aviso>
          )}
          {datos.en_la_cola === null && (
            <Aviso tipo="alerta">
              No se pudo preguntarle al equipo. Lo de abajo es lo último que se guardó, no
              necesariamente lo de ahora.
            </Aviso>
          )}

          {/* --- Lo que hay que mirar antes de autorizar --- */}
          {datos.ya_dada_de_alta?.length > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
              <h4 className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-300">
                <AlertTriangle size={13} />
                Esta serie ya está dada de alta
              </h4>
              <ul className="space-y-1 text-xs text-amber-200/80">
                {datos.ya_dada_de_alta.map((o) => (
                  <li key={o.id}>
                    {o.nombre_cliente ?? 'sin nombre'} · placa {o.slot} puerto {o.puerto} · ONT{' '}
                    {o.onu_index}
                    {o.es_esta_olt ? ' · en esta misma OLT' : ' · en OTRA OLT'}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] leading-snug text-amber-300/70">
                Autorizarla de nuevo la duplicaría. Si es un abonado que se mudó, primero hay que
                dar de baja la vieja.
              </p>
            </div>
          )}

          {datos.instalacion && (
            <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
              <h4 className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-sky-300">
                <ClipboardList size={13} />
                Tiene orden de instalación
              </h4>
              <p className="text-sm text-slate-100">{datos.instalacion.nombre}</p>
              <p className="mt-0.5 text-xs text-slate-400">
                {datos.instalacion.direccion ?? 'sin dirección'} · {datos.instalacion.estado}
              </p>
              <p className="mt-1.5 text-[11px] text-sky-300/70">
                El formulario de autorización se llena solo con estos datos.
              </p>
            </div>
          )}

          {/* --- Lo que dice el equipo --- */}
          <div className="rounded-lg border border-slate-800">
            <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              Lo que dice el equipo
            </div>
            <dl className="divide-y divide-slate-800/70 text-sm">
              <Dato k="Serie" v={datos.sn} mono />
              <Dato k="En hexadecimal" v={datos.sn_hex} mono ayuda="Como la escribe la CLI" />
              <Dato k="Ubicación" v={`placa ${datos.slot} · puerto ${datos.puerto}`} />
              <Dato k="Modelo" v={datos.modelo} />
              <Dato k="Fabricante" v={datos.fabricante} />
              <Dato k="Versión de hardware" v={datos.version_hw} />
              <Dato k="Versión de software" v={datos.version_sw} />
              <Dato k="MAC" v={datos.mac} mono />
              <Dato k="LOID" v={datos.loid} mono />
              <Dato
                k="Detectada"
                v={datos.detectada ? new Date(datos.detectada).toLocaleString('es-EC') : null}
                ayuda={
                  datos.detectada
                    ? `esperando desde hace ${desdeHace(datos.detectada)}`
                    : 'el equipo no informó desde cuándo'
                }
              />
              <Dato
                k="En la cola ahora"
                v={
                  datos.en_la_cola === true ? (
                    <Badge color="verde">sí</Badge>
                  ) : datos.en_la_cola === false ? (
                    <Badge color="rojo">no</Badge>
                  ) : (
                    <Badge color="gris">no se pudo preguntar</Badge>
                  )
                }
              />
            </dl>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
            <Button
              variante="exito"
              icon={KeyRound}
              disabled={datos.en_la_cola === false}
              onClick={() => onAutorizar?.(datos)}
            >
              Autorizar
            </Button>
            <Button icon={RefreshCw} cargando={resincronizando} onClick={resincronizar}>
              Resincronizar
            </Button>
            {onCerrar && (
              <Button variante="fantasma" onClick={onCerrar}>
                Cerrar
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Dato({ k, v, mono, ayuda }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 px-3 py-1.5">
      <dt className="w-44 shrink-0 text-xs text-slate-500">{k}</dt>
      <dd className={`flex-1 text-slate-200 ${mono ? 'font-mono text-xs' : 'text-sm'}`}>
        {v ?? <span className="text-slate-600">no informado</span>}
        {ayuda && <span className="ml-2 text-[11px] text-slate-600">{ayuda}</span>}
      </dd>
    </div>
  )
}

/** "6 días", "2 horas". Redondeado a propósito: el minuto exacto no cambia nada. */
function desdeHace(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const minutos = Math.floor(ms / 60000)
  if (minutos < 60) return `${minutos} min`
  const horas = Math.floor(minutos / 60)
  if (horas < 48) return `${horas} h`
  return `${Math.floor(horas / 24)} días`
}
