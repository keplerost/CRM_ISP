import { useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ScanSearch } from 'lucide-react'
import { Badge, Button, Card } from '../ui'

/**
 * Resultado de la auditoría de coherencia.
 *
 * Cada hallazgo dice tres cosas: qué está mal, por qué importa y qué hacer. Un
 * listado de problemas sin la tercera parte se lee una vez y se ignora para
 * siempre.
 */

const SEVERIDADES = {
  alta: {
    color: 'rojo',
    label: 'Alta',
    borde: 'border-rose-500/40 bg-rose-500/5',
    ayuda: 'Está afectando o va a afectar el servicio.',
  },
  media: {
    color: 'ambar',
    label: 'Media',
    borde: 'border-amber-500/40 bg-amber-500/5',
    ayuda: 'No rompe hoy, pero deja al sistema sin poder hacer su trabajo.',
  },
  baja: {
    color: 'gris',
    label: 'Baja',
    borde: 'border-slate-700 bg-slate-900/40',
    ayuda: 'Prolijidad: ensucia listados y reportes.',
  },
}

function Hallazgo({ h }) {
  const [abierto, setAbierto] = useState(false)
  const sev = SEVERIDADES[h.severidad] ?? SEVERIDADES.baja
  const tieneDetalle = h.ejemplos?.length > 0

  return (
    <div className={`rounded-lg border px-4 py-3 ${sev.borde}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge color={sev.color}>{sev.label}</Badge>
            <span className="text-sm font-medium text-slate-100">{h.titulo}</span>
            {h.olt && <span className="text-[11px] text-slate-500">· {h.olt}</span>}
          </div>

          <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{h.detalle}</p>

          {h.sugerencia && (
            <p className="mt-1.5 text-xs text-sky-300/90">
              <span className="text-slate-500">Qué hacer: </span>
              {h.sugerencia}
            </p>
          )}

          {tieneDetalle && abierto && (
            <ul className="mt-2 space-y-0.5 rounded bg-black/30 p-2 font-mono text-[11px] text-slate-400">
              {h.ejemplos.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>

        {tieneDetalle && (
          <button
            type="button"
            onClick={() => setAbierto((a) => !a)}
            className="shrink-0 text-slate-500 hover:text-slate-300"
            title={abierto ? 'Ocultar ejemplos' : 'Ver ejemplos'}
          >
            <ChevronDown size={16} className={`transition-transform ${abierto ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>
    </div>
  )
}

export default function Inconsistencias({ datos, onCerrar }) {
  const { hallazgos = [], por_severidad: sev = {}, olts, onus, profundo } = datos

  return (
    <Card
      title="Inconsistencias de configuración"
      subtitle={`${olts} OLTs y ${onus} ONUs revisadas${profundo ? ' · incluyendo consulta a los equipos' : ''}`}
      icon={ScanSearch}
      actions={
        onCerrar && (
          <Button variante="fantasma" onClick={onCerrar}>
            Cerrar
          </Button>
        )
      }
    >
      {hallazgos.length === 0 ? (
        <div className="flex items-start gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-400" />
          <div>
            <p className="text-sm font-medium text-emerald-300">Nada que corregir</p>
            <p className="mt-0.5 text-xs text-slate-400">
              Los planes, perfiles y ONUs son coherentes con lo que dice la base.
              {!profundo && ' Esta revisión no consultó a los equipos.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <AlertTriangle size={14} className="text-amber-400" />
            <span>
              {hallazgos.length} hallazgos —{' '}
              {[
                sev.alta && `${sev.alta} de severidad alta`,
                sev.media && `${sev.media} media`,
                sev.baja && `${sev.baja} baja`,
              ]
                .filter(Boolean)
                .join(', ')}
            </span>
          </div>

          {hallazgos.map((h, i) => (
            <Hallazgo key={`${h.clave}-${h.olt_id ?? i}`} h={h} />
          ))}
        </div>
      )}
    </Card>
  )
}
