import { useEffect, useState } from 'react'
import { dineroCero as dinero } from '../../lib/formato'
import { Link } from 'react-router-dom'
import { Ban, CalendarClock, CreditCard, Printer, Receipt } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { imprimirTirilla } from '../../lib/tirilla'
import { Aviso, Badge, Button, Card, Cargando, Stat, Table } from '../ui'

/** Lo que el abonado pagó y lo que prometió pagar. */

const fecha = (f) => (f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString() : '—')

const COLOR_PROMESA = { activa: 'azul', cumplida: 'verde', incumplida: 'rojo', anulada: 'gris' }

async function abrirPdf(descargar) {
  const blob = await descargar()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export default function FichaCobros({ cliente, onError }) {
  const [pagos, setPagos] = useState([])
  const [promesas, setPromesas] = useState([])
  const [cargando, setCargando] = useState(true)

  useEffect(() => {
    let vigente = true

    async function cargar() {
      const [pg, pr] = await Promise.all([
        supabase
          .from('v_pagos')
          .select('*')
          .eq('client_id', cliente.id)
          .order('fecha_pago', { ascending: false }),
        supabase
          .from('v_promesas_pago')
          .select('*')
          .eq('client_id', cliente.id)
          .order('fecha_promesa', { ascending: false }),
      ])

      if (!vigente) return
      if (pg.error) onError?.(pg.error)

      setPagos(pg.data ?? [])
      setPromesas(pr.data ?? [])
      setCargando(false)
    }

    cargar()
    return () => {
      vigente = false
    }
  }, [cliente.id, onError])

  if (cargando) return <Cargando />

  const validos = pagos.filter((p) => !p.anulado)
  const total = validos.reduce((s, p) => s + Number(p.monto), 0)
  const incumplidas = promesas.filter((p) => p.estado === 'incumplida').length

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Pagos registrados" valor={validos.length} icon={CreditCard} />
        <Stat label="Total pagado" valor={dinero(total)} color="text-emerald-400" />
        <Stat label="Último pago" valor={fecha(cliente.ultimo_pago)} />
        <Stat
          label="Promesas incumplidas"
          valor={incumplidas}
          color={incumplidas ? 'text-red-400' : 'text-slate-400'}
        />
      </div>

      <Card
        title="Pagos"
        icon={CreditCard}
        actions={
          <Link to="/pagos" className="text-xs text-sky-400 hover:underline">
            Registrar un pago →
          </Link>
        }
      >
        {pagos.length === 0 ? (
          <Aviso>Todavía no se le registró ningún pago.</Aviso>
        ) : (
          <Table
            columnas={['Recibo', 'Fecha', 'Comprobante', 'Forma', 'Cuenta', 'Monto', '']}
            filas={pagos}
            renderFila={(p) => (
              <tr key={p.id} className={`text-slate-300 ${p.anulado ? 'opacity-50' : ''}`}>
                <td className="px-3 py-2 font-mono text-xs text-slate-100">
                  {String(p.numero ?? '').padStart(6, '0')}
                </td>
                <td className="px-3 py-2 text-xs">{fecha(p.fecha_pago)}</td>
                <td className="px-3 py-2 font-mono text-[11px]">{p.numero_comprobante ?? '—'}</td>
                <td className="px-3 py-2 text-xs capitalize">{p.forma_pago}</td>
                <td className="px-3 py-2 text-xs">{p.cuenta ?? '—'}</td>
                <td className="px-3 py-2">
                  <b className={p.anulado ? 'line-through' : 'text-emerald-300'}>
                    {dinero(p.monto)}
                  </b>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-2">
                    {p.anulado && (
                      <span
                        className="flex items-center gap-1 text-[11px] text-red-300"
                        title={p.motivo_anulacion ?? ''}
                      >
                        <Ban size={12} /> anulado
                      </span>
                    )}
                    <Button
                      variante="fantasma"
                      icon={Printer}
                      title="Recibo del cobro"
                      onClick={() => abrirPdf(() => api.pagos.comprobante(p.id)).catch(onError)}
                    >
                      Recibo
                    </Button>
                    {/* La tirilla para la térmica del mostrador: es el mismo
                        cobro, sin gastar una hoja entera por cada pago. */}
                    <Button
                      variante="fantasma"
                      icon={Receipt}
                      title="Imprimir en la térmica del mostrador"
                      onClick={() =>
                        api.documentos
                          .reciboPos(p.id)
                          .then((texto) => imprimirTirilla(texto))
                          .catch(onError)
                      }
                    >
                      Tirilla
                    </Button>
                  </div>
                </td>
              </tr>
            )}
          />
        )}
      </Card>

      <Card title="Promesas de pago" icon={CalendarClock}>
        {promesas.length === 0 ? (
          <Aviso>Nunca pidió plazo.</Aviso>
        ) : (
          <Table
            columnas={['Se comprometió a', 'Monto', 'Comprobante', 'Estado', '']}
            filas={promesas}
            renderFila={(p) => (
              <tr key={p.id} className={`text-slate-300 ${p.vencida ? 'bg-red-500/5' : ''}`}>
                <td className="px-3 py-2 text-xs">
                  {fecha(p.fecha_promesa)}
                  {p.vencida && <span className="ml-2 text-red-400">vencida</span>}
                </td>
                <td className="px-3 py-2">{p.monto == null ? '—' : dinero(p.monto)}</td>
                <td className="px-3 py-2 font-mono text-[11px]">{p.numero_comprobante ?? '—'}</td>
                <td className="px-3 py-2">
                  <Badge color={COLOR_PROMESA[p.estado] ?? 'gris'}>{p.estado}</Badge>
                </td>
                <td className="px-3 py-2 text-right text-[11px] text-slate-500">
                  {p.activo_servicio ? 'habilitó el servicio' : ''}
                </td>
              </tr>
            )}
          />
        )}
      </Card>
    </div>
  )
}
