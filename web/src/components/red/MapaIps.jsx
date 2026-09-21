import { useMemo, useState } from 'react'
import { ESTADOS_IP, MAXIMO_MAPA, mapaDe } from '../../lib/red'
import { Aviso } from '../ui'

/**
 * El bloque entero, una celda por dirección.
 *
 * Existe porque la pregunta "¿qué IP le doy?" no se contesta con una lista: se
 * contesta mirando dónde hay huecos. Una tabla de 254 filas ordenada por IP es
 * técnicamente la misma información y no sirve para lo mismo.
 *
 * Las libres no vienen de la base —no se guardan— sino de restar lo ocupado al
 * bloque. Y las vistas en la red sin dueño se pintan aparte: no son una
 * asignación, son el hallazgo de la auditoría.
 */
export default function MapaIps({ cidr, direcciones = [], onElegir }) {
  const [detalle, setDetalle] = useState(null)
  const mapa = useMemo(() => mapaDe(cidr, direcciones), [cidr, direcciones])

  if (!mapa) return <Aviso tipo="alerta">{cidr} no es un bloque IPv4 que se pueda dibujar.</Aviso>

  if (mapa.demasiado) {
    return (
      <Aviso tipo="alerta">
        {cidr} tiene {mapa.total.toLocaleString()} direcciones. El mapa se dibuja hasta{' '}
        {MAXIMO_MAPA.toLocaleString()}: más que eso el navegador tarda en pintar algo que nadie
        puede recorrer con la vista. Dividí el bloque en subredes más chicas.
      </Aviso>
    )
  }

  const cuenta = (estado) => mapa.celdas.filter((c) => c.estado === estado).length

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 text-[11px]">
        {Object.entries(ESTADOS_IP).map(([clave, e]) => (
          <span key={clave} className="inline-flex items-center gap-1.5">
            <span className={`inline-block h-3 w-3 rounded border ${e.clase}`} />
            {e.label}
            <span className="text-slate-600">({cuenta(clave)})</span>
          </span>
        ))}
      </div>

      <div className="flex flex-wrap gap-1">
        {mapa.celdas.map((c) => (
          <button
            key={c.ip}
            type="button"
            onClick={() => {
              setDetalle(c)
              onElegir?.(c)
            }}
            title={`${c.ip}${c.datos?.cliente ? ` · ${c.datos.cliente}` : ''}`}
            className={`h-7 w-9 rounded border text-[10px] font-medium transition hover:ring-2 hover:ring-sky-500/50 ${
              ESTADOS_IP[c.estado].clase
            } ${detalle?.ip === c.ip ? 'ring-2 ring-sky-400' : ''}`}
          >
            {c.corto}
          </button>
        ))}
      </div>

      {detalle && (
        <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-slate-100">{detalle.ip}</span>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] ${ESTADOS_IP[detalle.estado].clase}`}>
              {ESTADOS_IP[detalle.estado].label}
            </span>
          </div>

          {detalle.datos ? (
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              {detalle.datos.cliente && (
                <>
                  <dt className="text-slate-500">Abonado</dt>
                  <dd className="text-slate-200">{detalle.datos.cliente}</dd>
                </>
              )}
              {detalle.datos.descripcion && (
                <>
                  <dt className="text-slate-500">Descripción</dt>
                  <dd className="text-slate-200">{detalle.datos.descripcion}</dd>
                </>
              )}
              {detalle.datos.mac_address && (
                <>
                  <dt className="text-slate-500">MAC</dt>
                  <dd className="font-mono text-slate-200">{detalle.datos.mac_address}</dd>
                </>
              )}
              <dt className="text-slate-500">Origen</dt>
              <dd className="text-slate-200">{detalle.datos.origen}</dd>
              {detalle.datos.visto_at && (
                <>
                  <dt className="text-slate-500">Vista por última vez</dt>
                  <dd className="text-slate-200">
                    {new Date(detalle.datos.visto_at).toLocaleString()}
                  </dd>
                </>
              )}
            </dl>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              Libre: nadie la tiene asignada y no se la vio en la red.
            </p>
          )}

          {detalle.estado === 'sin_autorizar' && (
            <p className="mt-2 text-xs text-rose-300">
              Se la vio conectada pero no está asignada a ningún abonado. O es un equipo que nadie
              registró, o alguien se puso una IP que no le tocaba.
            </p>
          )}
        </div>
      )}

      <p className="text-[11px] text-slate-600">
        {mapa.total} direcciones utilizables · la de red ({mapa.rango.red != null ? '.0' : '—'}) y la
        de broadcast no se muestran porque no se le pueden dar a nadie.
      </p>
    </div>
  )
}
