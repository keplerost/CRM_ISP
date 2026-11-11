import { GRUPOS_ICONOS, ICONOS, svgIcono } from '../../lib/iconos'

/**
 * Elegir un ícono de telecomunicaciones (migración 236), agrupados como en una
 * leyenda de planos: postes, cajas y empalmes, nodos, canalización, marcas.
 *
 * `vacio`: el texto de la opción "no elegir" (hereda de la capa o del tipo).
 */
export function IconoSvg({ clave, color, tamano = 22, className = '' }) {
  return (
    <span
      className={`inline-flex shrink-0 ${className}`}
      // El SVG sale de nuestro catálogo y el color se valida adentro.
      dangerouslySetInnerHTML={{ __html: svgIcono(clave, color, tamano) }}
    />
  )
}

export default function SelectorIcono({ valor, color = '#475569', onCambio, vacio = null }) {
  return (
    <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-slate-800 p-2">
      {vacio && (
        <button
          type="button"
          onClick={() => onCambio(null)}
          className={`w-full rounded px-2 py-1 text-left text-[11px] ${!valor ? 'bg-sky-500/15 text-sky-300' : 'text-slate-400'}`}
        >
          {vacio}
        </button>
      )}
      {GRUPOS_ICONOS.map((g) => (
        <div key={g}>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{g}</p>
          <div className="grid grid-cols-6 gap-1">
            {Object.entries(ICONOS)
              .filter(([, i]) => i.grupo === g)
              .map(([k, i]) => (
                <button
                  key={k}
                  type="button"
                  title={i.nombre}
                  aria-label={i.nombre}
                  onClick={() => onCambio(k)}
                  className={`flex items-center justify-center rounded-md border p-1 ${
                    valor === k ? 'border-sky-500 bg-sky-500/15' : 'border-transparent hover:border-slate-700'
                  }`}
                >
                  <IconoSvg clave={k} color={color} tamano={24} />
                </button>
              ))}
          </div>
        </div>
      ))}
      {valor && ICONOS[valor] && <p className="text-[11px] text-slate-400">Elegido: {ICONOS[valor].nombre}</p>}
    </div>
  )
}
