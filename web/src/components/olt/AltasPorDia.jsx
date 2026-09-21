import { useMemo, useState } from 'react'

/**
 * Altas de ONT por día.
 *
 * Barras dibujadas a mano en vez de traer una librería de gráficos: son
 * rectángulos con una altura proporcional, y una dependencia más para esto
 * costaría más de lo que resuelve.
 *
 * Los días SIN altas se dibujan igual, vacíos. Un gráfico que solo muestra los
 * días que tuvieron movimiento comprime el tiempo y hace parecer constante algo
 * que fueron tres altas sueltas en dos meses.
 */
export default function AltasPorDia({ filas, dias = 45 }) {
  const [ventana, setVentana] = useState(dias)

  const barras = useMemo(() => {
    if (!filas?.length) return []

    // Se suman las OLTs: el gráfico es del sistema entero.
    const porDia = new Map()
    for (const f of filas) {
      if (!f.dia) continue
      porDia.set(f.dia, (porDia.get(f.dia) ?? 0) + Number(f.altas))
    }
    if (!porDia.size) return []

    const fechas = [...porDia.keys()].sort()
    const ultima = new Date(`${fechas[fechas.length - 1]}T00:00:00`)

    const salida = []
    for (let i = ventana - 1; i >= 0; i--) {
      const d = new Date(ultima)
      d.setDate(d.getDate() - i)
      const clave = d.toISOString().slice(0, 10)
      salida.push({ dia: clave, altas: porDia.get(clave) ?? 0 })
    }
    return salida
  }, [filas, ventana])

  if (!barras.length) {
    return (
      <p className="py-6 text-center text-sm text-slate-500">
        Ninguna ONT tiene fecha de autorización. La trae la descripción del equipo al importarla.
      </p>
    )
  }

  const max = Math.max(...barras.map((b) => b.altas), 1)
  const total = barras.reduce((a, b) => a + b.altas, 0)
  const conAltas = barras.filter((b) => b.altas > 0).length

  const etiqueta = (dia) => {
    const d = new Date(`${dia}T00:00:00`)
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-400">
          <span className="font-semibold text-slate-200">{total}</span> altas en {conAltas} días
        </p>
        <div className="flex gap-1">
          {[30, 45, 90, 365].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setVentana(n)}
              className={`rounded px-2 py-0.5 text-[11px] transition ${
                ventana === n
                  ? 'bg-sky-600/20 text-sky-300'
                  : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
              }`}
            >
              {n === 365 ? '1 año' : `${n} d`}
            </button>
          ))}
        </div>
      </div>

      <div className="flex h-36 items-end gap-[2px] overflow-x-auto t-panel p-2">
        {barras.map((b) => (
          <div
            key={b.dia}
            title={`${b.dia}: ${b.altas} ${b.altas === 1 ? 'alta' : 'altas'}`}
            className="group flex min-w-[4px] flex-1 flex-col justify-end"
            style={{ height: '100%' }}
          >
            <div
              className={`w-full rounded-sm transition group-hover:bg-sky-400 ${
                b.altas ? 'bg-sky-600' : 'bg-slate-800/60'
              }`}
              // Los días vacíos conservan una línea mínima visible: si no, el eje
              // desaparece y no se ve cuánto tiempo pasó sin movimiento.
              style={{ height: b.altas ? `${Math.max((b.altas / max) * 100, 6)}%` : '2px' }}
            />
          </div>
        ))}
      </div>

      <div className="flex justify-between text-[10px] text-slate-600">
        <span>{etiqueta(barras[0].dia)}</span>
        <span>máximo en un día: {max}</span>
        <span>{etiqueta(barras[barras.length - 1].dia)}</span>
      </div>
    </div>
  )
}
