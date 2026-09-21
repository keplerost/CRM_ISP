import { useEffect, useState } from 'react'
import { dineroCero as dinero } from '../../lib/formato'
import { Link } from 'react-router-dom'
import { FileText, Printer, Receipt, Settings, Wallet } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, Card, Cargando, Stat, Table } from '../ui'
import FacturasCliente from './FacturasCliente'
import ConfigFacturacion from './ConfigFacturacion'
import ConfigAvisos from './ConfigAvisos'

/**
 * Facturación del abonado, en tres secciones.
 *
 * `Facturas` es lo que el negocio le cobra —exista o no comprobante fiscal—;
 * `Facturas SRI` son los comprobantes electrónicos; `Configuración` son las
 * reglas con las que se le factura. Separarlas evita la confusión de mirar una
 * lista de comprobantes buscando una deuda que quizá nunca se facturó.
 */

const SECCIONES = [
  { id: 'facturas', label: 'Facturas', icon: Wallet },
  { id: 'sri', label: 'Facturas SRI', icon: Receipt },
  { id: 'config', label: 'Configuración', icon: Settings },
]

export default function FichaFacturacion({ cliente, onError, onGuardado }) {
  const [seccion, setSeccion] = useState('facturas')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1">
        {SECCIONES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setSeccion(id)}
            className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition ${
              seccion === id
                ? 'bg-sky-600/15 font-medium text-sky-300'
                : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {seccion === 'facturas' && (
        <FacturasCliente cliente={cliente} onError={onError} onGuardado={onGuardado} />
      )}
      {seccion === 'sri' && <FacturasSri cliente={cliente} onError={onError} />}
      {seccion === 'config' && (
        <div className="space-y-4">
          <ConfigFacturacion cliente={cliente} onError={onError} onGuardado={onGuardado} />
          {/* Los avisos van acá y no en otra pestaña: quien está definiendo cómo
              se le factura a alguien es el mismo que decide si quiere que se le
              recuerde, y son dos caras de la misma conversación con el abonado. */}
          <ConfigAvisos cliente={cliente} onError={onError} onGuardado={onGuardado} />
        </div>
      )}
    </div>
  )
}

/** Comprobantes emitidos al abonado, con lo que quedó pendiente de cada uno. */

const COLOR_ESTADO = {
  BORRADOR: 'gris',
  FIRMADO: 'azul',
  ENVIADO: 'ambar',
  AUTORIZADO: 'verde',
  NO_AUTORIZADO: 'rojo',
  ANULADO: 'rojo',
}


/** Abre un PDF que llega como blob: el pedido lleva el token en la cabecera. */
async function abrirPdf(descargar) {
  const blob = await descargar()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Los comprobantes electrónicos emitidos ante el SRI. */
function FacturasSri({ cliente, onError }) {
  const [docs, setDocs] = useState([])
  const [saldos, setSaldos] = useState({})
  const [cargando, setCargando] = useState(true)

  useEffect(() => {
    let vigente = true

    async function cargar() {
      const [d, f] = await Promise.all([
        supabase
          .from('v_electronic_documents')
          .select('*')
          .eq('client_id', cliente.id)
          .order('fecha_emision', { ascending: false }),
        supabase.from('v_facturas_por_cobrar').select('id, saldo').eq('client_id', cliente.id),
      ])

      if (!vigente) return
      if (d.error) onError?.(d.error)

      setDocs(d.data ?? [])
      setSaldos(Object.fromEntries((f.data ?? []).map((x) => [x.id, Number(x.saldo)])))
      setCargando(false)
    }

    cargar()
    return () => {
      vigente = false
    }
  }, [cliente.id, onError])

  if (cargando) return <Cargando />

  const total = docs.reduce((s, d) => s + Number(d.importe_total ?? 0), 0)
  const autorizadas = docs.filter((d) => d.estado === 'AUTORIZADO').length

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Comprobantes" valor={docs.length} icon={Receipt} />
        <Stat label="Autorizados" valor={autorizadas} color="text-emerald-400" />
        <Stat label="Facturado" valor={dinero(total)} />
        <Stat
          label="Pendiente de cobro"
          valor={dinero(cliente.saldo)}
          color={Number(cliente.saldo) > 0 ? 'text-red-400' : 'text-emerald-400'}
        />
      </div>

      <Card
        title="Comprobantes emitidos"
        icon={Receipt}
        actions={
          <Link to="/facturacion" className="text-xs text-sky-400 hover:underline">
            Emitir una factura →
          </Link>
        }
      >
        {docs.length === 0 ? (
          <Aviso>
            Todavía no se le emitió ningún comprobante. Se hace desde <b>Facturación → Nueva
            factura</b>.
          </Aviso>
        ) : (
          <Table
            columnas={['Número', 'Fecha', 'Total', 'Pendiente', 'Estado', '']}
            filas={docs}
            renderFila={(d) => (
              <tr key={d.id} className="text-slate-300">
                <td className="px-3 py-2 font-mono text-xs text-slate-100">
                  {d.numero_comprobante}
                </td>
                <td className="px-3 py-2 text-xs">{d.fecha_emision}</td>
                <td className="px-3 py-2">{dinero(d.importe_total)}</td>
                <td className="px-3 py-2">
                  {saldos[d.id] ? (
                    <b className="text-red-300">{dinero(saldos[d.id])}</b>
                  ) : d.estado === 'AUTORIZADO' ? (
                    <span className="text-emerald-400">pagada</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge color={COLOR_ESTADO[d.estado] ?? 'gris'}>{d.estado}</Badge>
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <Button
                      variante="fantasma"
                      icon={Printer}
                      title="Representación impresa"
                      onClick={() => abrirPdf(() => api.sri.ride(d.id)).catch(onError)}
                    >
                      RIDE
                    </Button>
                    <Button
                      variante="fantasma"
                      icon={FileText}
                      title="Ver el XML"
                      onClick={() =>
                        api.sri
                          .xml(d.id)
                          .then((r) => {
                            const w = window.open('', '_blank', 'noopener')
                            if (w) w.document.write(`<pre>${r.xml.replace(/</g, '&lt;')}</pre>`)
                          })
                          .catch(onError)
                      }
                    />
                  </div>
                </td>
              </tr>
            )}
          />
        )}
      </Card>
    </div>
  )
}
