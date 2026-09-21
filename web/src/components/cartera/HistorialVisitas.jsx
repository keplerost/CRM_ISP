import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, MessageSquare } from 'lucide-react'
import { carteraApi, RESULTADOS_INTENTO } from '../../lib/cartera'
import { Badge } from '../ui'

/**
 * Las visitas de una orden de retiro, con lo que dijo el abonado.
 *
 * ── Por qué esto es un componente y no está escrito en cada pantalla ──
 *
 * Porque hace falta en tres lugares distintos y por tres razones distintas:
 *
 *   EL TÉCNICO, antes de volver a tocar la puerta. Es el que más lo necesita y
 *   el que menos lo tenía: iba por segunda vez sin saber que la primera le
 *   habían dicho que el señor se mudó.
 *
 *   LA OFICINA, para decidir si se da de baja al abonado y con qué motivo.
 *
 *   EL QUE ATIENDE AL VENDEDOR cuando viene a reclamar por su cliente.
 *
 * Si estuviera escrito tres veces, en un mes dirían tres cosas distintas.
 *
 * ── Por qué se carga al abrirlo y no siempre ──
 *
 * Porque en una lista de veinte órdenes serían veinte consultas para algo que
 * casi nunca se mira todo junto. Se pide cuando alguien lo abre.
 */
export default function HistorialVisitas({ retiroId, intentos = 0, abiertoAlPrincipio = false }) {
  const [abierto, setAbierto] = useState(abiertoAlPrincipio)
  const [visitas, setVisitas] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!abierto || visitas || !retiroId) return
    carteraApi
      .intentos(retiroId)
      .then(setVisitas)
      .catch((e) => setError(e))
  }, [abierto, visitas, retiroId])

  // Sin visitas no hay nada que abrir, y un desplegable vacío es una promesa
  // incumplida. Se dice que no hubo ninguna y listo.
  if (intentos === 0 && !abiertoAlPrincipio) {
    return <p className="text-[11px] text-slate-600">Sin visitas registradas todavía.</p>
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setAbierto((a) => !a)}
        className="flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300"
      >
        {abierto ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <MessageSquare size={12} />
        {intentos === 1 ? '1 visita' : `${intentos} visitas`}
      </button>

      {abierto && (
        <div className="mt-1.5 space-y-1.5 t-panel p-2">
          {error && <p className="text-[11px] text-red-400">No se pudo leer el historial.</p>}
          {!visitas && !error && <p className="text-[11px] text-slate-500">Cargando…</p>}

          {visitas?.length === 0 && (
            <p className="text-[11px] text-slate-500">No hay visitas registradas.</p>
          )}

          {/* De la más vieja a la más nueva: es el orden en que pasó, y leer una
              historia al revés obliga a rearmarla en la cabeza. */}
          {[...(visitas ?? [])].reverse().map((v, i) => (
            <div key={v.id} className="border-l-2 border-slate-700 pl-2">
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-slate-500">{i + 1}ª</span>
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
    </div>
  )
}
