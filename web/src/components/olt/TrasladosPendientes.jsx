import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Truck, Check, ArrowRight } from 'lucide-react'
import { Button } from '../ui'
import { trasladosApi } from '../../lib/traslados'

/**
 * Mudanzas con la ONT vieja todavía viva en su OLT de origen.
 *
 * ── Por qué esto es distinto de los reemplazos pendientes ──
 *
 * Acá el abonado NO está sin servicio: sigue conectado en el domicilio viejo
 * hasta que se mude. No es una urgencia, es una tarea — pero es la tarea que
 * TRABA el traslado. Si el abonado se lleva el mismo equipo, la OLT del destino
 * lo va a rechazar mientras esta ONT siga autorizada, porque una serie no puede
 * estar viva en dos puertos.
 *
 * Eso es exactamente lo que hoy se resuelve por teléfono: el técnico llega a la
 * casa nueva, no puede autorizar, y llama a la oficina para que alguien busque
 * dónde estaba y la borre. Esta lista es esa llamada, escrita antes de que haga
 * falta.
 *
 * Se muestra todo lo que hace falta para darla de baja a mano —OLT, puerto,
 * índice, serie— porque el dato importante es justamente el que se pierde
 * cuando el abonado se muda.
 */
export default function TrasladosPendientes({ onError }) {
  const [filas, setFilas] = useState([])
  const [marcando, setMarcando] = useState(null)

  const cargar = useCallback(async () => {
    try {
      setFilas(await trasladosApi.pendientes())
    } catch (err) {
      // Sin la migración 94 esta tarjeta simplemente no existe.
      if (err?.code !== '42P01') onError?.(err)
    }
  }, [onError])

  useEffect(() => {
    cargar()
  }, [cargar])

  const marcar = async (t) => {
    setMarcando(t.id)
    try {
      await trasladosApi.marcarBaja(
        t.id,
        `Dada de baja a mano: ${t.sn_anterior ?? 'ONT'} en ${t.olt_anterior ?? 'la OLT'}` +
          (t.puerto_anterior != null ? ` puerto ${t.puerto_anterior}` : ''),
      )
      await cargar()
    } catch (err) {
      onError?.(err)
    } finally {
      setMarcando(null)
    }
  }

  if (!filas.length) return null

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
      <div className="flex items-start gap-3">
        <Truck size={18} className="mt-0.5 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-amber-200">
            {filas.length === 1
              ? 'Un traslado con la ONT vieja todavía autorizada'
              : `${filas.length} traslados con la ONT vieja todavía autorizada`}
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            El abonado sigue con servicio en el domicilio viejo. Pero si se lleva el mismo equipo,
            no se va a poder autorizar en el destino hasta que esta se dé de baja.
          </p>

          <ul className="mt-3 space-y-2">
            {filas.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700/70 bg-[#F6F8FB] px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-slate-100">{t.cliente}</p>
                  <p className="text-[11px] text-slate-500">
                    <b className="text-slate-300">{t.sn_anterior ?? 'sin serie'}</b> en{' '}
                    {t.olt_anterior ?? 'OLT desconocida'}
                    {t.slot_anterior != null || t.puerto_anterior != null
                      ? ` · ${t.slot_anterior ?? 0}/${t.puerto_anterior ?? '?'}/${t.onu_index_anterior ?? '?'}`
                      : ''}
                    {t.vlan_anterior != null ? ` · VLAN ${t.vlan_anterior}` : ''}
                  </p>
                  <p className="truncate text-[11px] text-slate-600">
                    {t.direccion_anterior ?? 's/d'} → {t.direccion_nueva ?? 's/d'}
                    {' · '}
                    {espera(t.dias_esperando)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    icon={Check}
                    cargando={marcando === t.id}
                    title="Ya la borré desde la OLT"
                    onClick={() => marcar(t)}
                  >
                    Ya la di de baja
                  </Button>
                  {t.instalacion_id && (
                    <Link
                      to={`/clientes/instalaciones/${t.instalacion_id}`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
                    >
                      {t.orden_numero ? `Orden #${t.orden_numero}` : 'La orden'}{' '}
                      <ArrowRight size={14} />
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <p className="mt-2 text-[11px] text-slate-500">
            "Ya la di de baja" no borra nada en el equipo: solo deja de reclamarlo. Borrala primero
            desde la OLT.
          </p>
        </div>
      </div>
    </div>
  )
}

function espera(dias) {
  if (dias == null) return 'sin fecha'
  // Un reloj adelantado no puede imprimir "hace -1 días".
  if (dias < 1) return 'de hoy'
  if (dias === 1) return 'de ayer'
  return `hace ${dias} días`
}
