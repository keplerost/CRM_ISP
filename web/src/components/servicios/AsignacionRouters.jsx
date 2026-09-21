import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Router as RouterIcon, UploadCloud } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { ESTADO_APROVISIONAMIENTO } from '../../lib/planes'
import { Aviso, Badge, Button, Cargando, ErrorBanner, Modal } from '../ui'

/**
 * En qué routers se vende el plan, y si su perfil ya existe en cada equipo.
 *
 * Son dos cosas distintas y la pantalla las separa a propósito: marcar el
 * router dice "acá se ofrece"; aprovisionar es lo que crea el perfil en el
 * equipo. Entre una y otra hay un rato en el que el plan está vendido y el
 * abonado no lo puede tomar, y ese estado tiene que verse.
 */
export default function AsignacionRouters({ plan, onCerrar }) {
  const [routers, setRouters] = useState([])
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [aprovisionando, setAprovisionando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [error, setError] = useState(null)

  const recargar = useCallback(async () => {
    if (!plan) return
    setCargando(true)
    try {
      const r = await api.planes.routers(plan.id)
      setRouters(r.routers ?? [])
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [plan])

  useEffect(() => {
    recargar()
  }, [recargar])

  /**
   * Marcar o desmarcar un equipo.
   *
   * Desasignar borra la fila pero NO borra el perfil del router: puede haber
   * abonados conectados con él, y quitárselo los dejaría con el de por defecto
   * en la próxima reconexión. Se dice en la pantalla.
   */
  async function alternar(r) {
    setGuardando(true)
    setError(null)
    try {
      const { error: err } = r.asignado
        ? await supabase.from('plan_routers').delete().eq('plan_id', plan.id).eq('router_id', r.id)
        : await supabase.from('plan_routers').insert({ plan_id: plan.id, router_id: r.id })

      if (err) throw err
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  async function aprovisionar() {
    setAprovisionando(true)
    setError(null)
    setResultado(null)
    try {
      setResultado(await api.planes.aprovisionar(plan.id))
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setAprovisionando(false)
    }
  }

  const asignados = routers.filter((r) => r.asignado)
  const pendientes = asignados.filter((r) => r.estado !== 'aplicado')

  return (
    <Modal
      abierto={Boolean(plan)}
      titulo={`Routers de ${plan?.nombre ?? ''}`}
      onCerrar={onCerrar}
      ancho="max-w-2xl"
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <p className="text-sm text-slate-400">
          Marcá en qué equipos se ofrece el plan. El perfil PPP se llama{' '}
          <b className="text-slate-200">{plan?.perfil_ppp || plan?.nombre}</b> y se crea{' '}
          <b>sin rate-limit</b>: en fibra el caudal lo controla la traffic table de la OLT.
        </p>

        {cargando ? (
          <Cargando />
        ) : routers.length === 0 ? (
          <Aviso>No hay routers cargados todavía.</Aviso>
        ) : (
          <div className="space-y-2">
            {routers.map((r) => (
              <div
                key={r.id}
                className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition ${
                  r.asignado ? 'border-sky-500/50 bg-sky-500/10' : 'border-slate-800 bg-slate-950/40'
                }`}
              >
                <label className="flex flex-1 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={r.asignado}
                    disabled={guardando}
                    onChange={() => alternar(r)}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-sky-500"
                  />
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm text-slate-100">
                      <RouterIcon size={14} className="text-slate-500" />
                      {r.nombre}
                      {!r.activo && <span className="text-[10px] text-slate-500">(inactivo)</span>}
                    </p>
                    <p className="text-[11px] text-slate-500">{r.ip_host}</p>
                  </div>
                </label>

                {r.asignado && (
                  <div className="shrink-0 text-right">
                    <Badge color={ESTADO_APROVISIONAMIENTO[r.estado ?? 'pendiente']?.color ?? 'gris'}>
                      {ESTADO_APROVISIONAMIENTO[r.estado ?? 'pendiente']?.label ?? r.estado}
                    </Badge>
                    {r.aprovisionado_at && (
                      <p className="mt-0.5 text-[10px] text-slate-500">
                        {new Date(r.aprovisionado_at).toLocaleString()}
                      </p>
                    )}
                    {r.error && (
                      <p className="mt-0.5 max-w-[14rem] text-[10px] text-rose-300">{r.error}</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {pendientes.length > 0 && (
          <Aviso tipo="alerta">
            {pendientes.length}{' '}
            {pendientes.length === 1 ? 'equipo tiene el plan asignado' : 'equipos tienen el plan asignado'}{' '}
            pero sin el perfil creado. Hasta que se aprovisione, un abonado PPPoE que se dé de alta
            ahí va a conectar con el perfil por defecto.
          </Aviso>
        )}

        {resultado && (
          <Aviso tipo={resultado.ok ? 'info' : 'alerta'}>
            {resultado.mensaje}
            <span className="mt-1 block text-xs opacity-80">{resultado.regla}</span>
            {resultado.fallidos?.length > 0 && (
              <ul className="mt-1 list-inside list-disc text-xs">
                {resultado.fallidos.map((f, i) => (
                  <li key={i}>
                    {f.router} — {f.error}
                  </li>
                ))}
              </ul>
            )}
          </Aviso>
        )}

        <div className="grid gap-2 sm:grid-cols-2">
          <Button onClick={onCerrar}>Cerrar</Button>
          <Button
            variante="primario"
            icon={asignados.length ? UploadCloud : CheckCircle2}
            onClick={aprovisionar}
            cargando={aprovisionando}
            disabled={asignados.length === 0}
          >
            {asignados.length === 0
              ? 'Elegí al menos un router'
              : `Aprovisionar en ${asignados.length}`}
          </Button>
        </div>

        <p className="text-[11px] text-slate-500">
          Desmarcar un router lo saca de la lista de venta pero no borra el perfil del equipo:
          puede haber abonados conectados con él, y quitárselo los dejaría con el de por defecto en
          la próxima reconexión.
        </p>
      </div>
    </Modal>
  )
}
