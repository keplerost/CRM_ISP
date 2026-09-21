import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Badge, Input } from '../ui'

/**
 * Buscador de clientes para cobrar.
 *
 * En el mostrador el abonado dice cualquier cosa: su nombre, la cédula, el
 * número de la factura que trae en la mano o la IP que le anotaron. Por eso se
 * busca por todo a la vez y no con un campo por criterio.
 *
 * Los resultados se piden a Supabase mientras se escribe, con una espera corta:
 * una consulta por tecla satura la conexión y devuelve resultados de una
 * búsqueda vieja después de la nueva.
 */

const COLOR_ESTADO = {
  activo: 'verde',
  cortado: 'rojo',
  suspendido: 'ambar',
  baja: 'gris',
}

/** PostgREST separa los filtros con comas y paréntesis: hay que sacarlos. */
const limpiar = (texto) => texto.replace(/[,()%*\\]/g, ' ').trim()

export default function BuscadorCliente({ onElegir, autoFocus = true }) {
  const [modo, setModo] = useState('cliente')
  const [texto, setTexto] = useState('')
  const [resultados, setResultados] = useState([])
  const [buscando, setBuscando] = useState(false)
  const [error, setError] = useState(null)

  // Descarta la respuesta de una búsqueda que quedó vieja.
  const ultimaBusqueda = useRef(0)

  useEffect(() => {
    const q = limpiar(texto)
    if (q.length < 2) {
      setResultados([])
      return
    }

    const id = ++ultimaBusqueda.current
    const temporizador = setTimeout(async () => {
      setBuscando(true)
      setError(null)
      try {
        const filas = modo === 'cliente' ? await buscarClientes(q) : await buscarPorComprobante(q)
        if (id === ultimaBusqueda.current) setResultados(filas)
      } catch (err) {
        if (id === ultimaBusqueda.current) setError(err)
      } finally {
        if (id === ultimaBusqueda.current) setBuscando(false)
      }
    }, 300)

    return () => clearTimeout(temporizador)
  }, [texto, modo])

  async function buscarClientes(q) {
    const { data, error: err } = await supabase
      .from('clientes')
      .select('*')
      .or(
        [
          `nombre.ilike.%${q}%`,
          `identificacion.ilike.%${q}%`,
          `ip.ilike.%${q}%`,
          `usuario_ppp.ilike.%${q}%`,
        ].join(','),
      )
      .order('nombre')
      .limit(8)

    if (err) throw err
    return data ?? []
  }

  /** Buscar por el número que trae impreso la factura. */
  async function buscarPorComprobante(q) {
    const { data, error: err } = await supabase
      .from('v_facturas_por_cobrar')
      .select('client_id, numero, importe_total, saldo, razon_social_comprador')
      .ilike('numero', `%${q}%`)
      .limit(8)
    if (err) throw err
    if (!data?.length) return []

    const ids = [...new Set(data.map((f) => f.client_id).filter(Boolean))]
    if (!ids.length) return []

    const { data: clientes, error: err2 } = await supabase.from('clientes').select('*').in('id', ids)
    if (err2) throw err2
    return clientes ?? []
  }

  function elegir(cliente) {
    setTexto('')
    setResultados([])
    onElegir(cliente)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-center gap-5 text-sm">
        {[
          ['cliente', 'Buscar cliente'],
          ['comprobante', 'Buscar N° comprobante'],
        ].map(([valor, label]) => (
          <label key={valor} className="flex cursor-pointer items-center gap-2 text-slate-300">
            <input
              type="radio"
              checked={modo === valor}
              onChange={() => {
                setModo(valor)
                setResultados([])
              }}
              className="accent-sky-500"
            />
            {label}
          </label>
        ))}
      </div>

      <div className="relative mx-auto max-w-2xl">
        <Search
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
        />
        <Input
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          autoFocus={autoFocus}
          className="pl-9"
          placeholder={
            modo === 'cliente'
              ? 'Nombre, cédula/RUC, IP o usuario PPPoE'
              : 'Número de comprobante, por ejemplo 001-001-000000008'
          }
        />
        {texto && (
          <button
            type="button"
            onClick={() => setTexto('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
          >
            <X size={15} />
          </button>
        )}

        {(resultados.length > 0 || buscando || error || limpiar(texto).length >= 2) && (
          <div className="absolute z-20 mt-1 w-full overflow-hidden t-card-sm shadow-xl">
            {error && <p className="px-3 py-2 text-xs text-red-300">{error.message}</p>}

            {!error && buscando && <p className="px-3 py-2 text-xs text-slate-500">Buscando…</p>}

            {!error && !buscando && resultados.length === 0 && (
              <p className="px-3 py-2 text-xs text-slate-500">
                Nadie coincide con “{texto}”.
              </p>
            )}

            {resultados.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => elegir(c)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-slate-800"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-slate-100">{c.nombre}</span>
                  <span className="block truncate text-[11px] text-slate-500">
                    {c.identificacion ?? 'sin identificación'}
                    {c.ip ? ` · ${c.ip}` : ''}
                    {c.usuario_ppp ? ` · ${c.usuario_ppp}` : ''}
                  </span>
                </span>
                <Badge color={COLOR_ESTADO[c.estado] ?? 'gris'}>{c.estado}</Badge>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export { COLOR_ESTADO }
