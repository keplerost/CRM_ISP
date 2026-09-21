import { useCallback, useEffect, useMemo, useState } from 'react'
import { History, Search } from 'lucide-react'
import {
  Badge,
  Card,
  ErrorBanner,
  Input,
  Select,
  SkeletonTabla,
  Stat,
  Table,
} from '../../components/ui'
import { TIPOS_MOVIMIENTO, inventarioApi } from '../../lib/inventario'

/**
 * La bitácora del inventario.
 *
 * Es la tabla que responde "¿por qué faltan tres ONT?". Cada renglón es
 * inmutable: una corrección no edita el pasado, agrega un ajuste — que también
 * queda acá, con su motivo y quién lo hizo.
 *
 * Se muestra el saldo del artículo al lado de cada movimiento? No. Se evaluó y
 * se descartó: obligaría a recalcular hacia atrás en el navegador y el número
 * quedaría mal apenas alguien filtre. El stock actual está en la otra pantalla;
 * ésta cuenta la historia.
 */
export default function MovimientosPage() {
  const [movimientos, setMovimientos] = useState([])
  const [almacenes, setAlmacenes] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const [busqueda, setBusqueda] = useState('')
  const [filtroTipo, setFiltroTipo] = useState('')
  const [filtroAlmacen, setFiltroAlmacen] = useState('')

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const [m, cat] = await Promise.all([
        inventarioApi.movimientos({ almacenId: filtroAlmacen || undefined, limite: 500 }),
        inventarioApi.catalogo(),
      ])
      setMovimientos(m)
      setAlmacenes(cat.almacenes)
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [filtroAlmacen])

  useEffect(() => {
    recargar()
  }, [recargar])

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    return movimientos.filter((m) => {
      if (filtroTipo && m.tipo !== filtroTipo) return false
      if (!q) return true
      return [m.articulo, m.serie, m.motivo, m.usuario_nombre, m.origen, m.destino]
        .filter(Boolean)
        .some((c) => String(c).toLowerCase().includes(q))
    })
  }, [movimientos, busqueda, filtroTipo])

  const contar = (t) => movimientos.filter((m) => m.tipo === t).length

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
          <History size={20} className="text-sky-400" />
          Movimientos de inventario
        </h1>
        <p className="text-sm text-slate-400">
          Todo lo que entró, salió y se movió. No se edita ni se borra: una corrección es un ajuste
          nuevo.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Ingresos" valor={contar('ingreso')} color="text-emerald-400" />
        <Stat label="Transferencias" valor={contar('transferencia')} color="text-sky-400" />
        <Stat label="Consumos" valor={contar('consumo')} color="text-sky-400" />
        <Stat label="Ajustes" valor={contar('ajuste')} color="text-red-400" />
      </div>

      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <Input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por artículo, serie, motivo o quién lo hizo"
              className="pl-9"
            />
          </div>
          <Select value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value)} className="w-44">
            <option value="">Todos los tipos</option>
            {Object.entries(TIPOS_MOVIMIENTO).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
          <Select
            value={filtroAlmacen}
            onChange={(e) => setFiltroAlmacen(e.target.value)}
            className="w-52"
          >
            <option value="">Todos los almacenes</option>
            {almacenes.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nombre}
              </option>
            ))}
          </Select>
        </div>

        {cargando ? (
          <SkeletonTabla filas={8} columnas={6} />
        ) : (
          <Table
            columnas={['Fecha', 'Tipo', 'Artículo', 'Cantidad', 'De → a', 'Quién']}
            filas={visibles}
            vacio="Todavía no hay movimientos registrados."
            renderFila={(m) => (
              <tr key={m.id} className="hover:bg-slate-800/40">
                <td className="whitespace-nowrap px-3 py-2 text-[12px] text-slate-400">
                  {new Date(m.creado_en).toLocaleString('es-EC', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </td>
                <td className="px-3 py-2">
                  <Badge color={TIPOS_MOVIMIENTO[m.tipo]?.color ?? 'gris'}>
                    {TIPOS_MOVIMIENTO[m.tipo]?.label ?? m.tipo}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  <div className="text-slate-200">{m.articulo}</div>
                  {m.serie && <div className="font-mono text-[11px] text-slate-500">{m.serie}</div>}
                  {m.motivo && <div className="text-[11px] text-slate-500">{m.motivo}</div>}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`tabular-nums ${
                      Number(m.cantidad) < 0 ? 'text-red-400' : 'text-slate-200'
                    }`}
                  >
                    {Number(m.cantidad).toLocaleString('es-EC')} {m.unidad}
                  </span>
                </td>
                <td className="px-3 py-2 text-[12px] text-slate-400">
                  {m.origen ?? '—'} → {m.destino ?? '—'}
                </td>
                <td className="px-3 py-2 text-[12px] text-slate-400">{m.usuario_nombre ?? '—'}</td>
              </tr>
            )}
          />
        )}
      </Card>
    </div>
  )
}
