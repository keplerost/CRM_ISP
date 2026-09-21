import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { dineroCero as dinero } from '../../lib/formato'
import { Link } from 'react-router-dom'
import { CalendarClock, Play } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Button, Card, Cargando, Stat, Table } from '../ui'

/**
 * Generación mensual de facturas.
 *
 * Corre todos los días —no una vez al mes— porque cada abonado tiene su propio
 * día de facturación: el 1, el 15, el 28. Lo que decide es la fecha de cada
 * cliente, no la del calendario.
 *
 * Acá se ve a quién le toca hoy y se puede correr a mano. No emite nada ante el
 * SRI: crea la factura del sistema, y el comprobante fiscal se emite después,
 * revisado, desde "Por facturar".
 */


export default function FacturasDelMes({ onError }) {
  const confirmar = useConfirmar()
  const [datos, setDatos] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [corriendo, setCorriendo] = useState(false)
  const [resultado, setResultado] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      setDatos(await api.sri.facturasDelMes())
    } catch (err) {
      onError?.(err)
    } finally {
      setCargando(false)
    }
  }, [onError])

  useEffect(() => {
    recargar()
  }, [recargar])

  async function generar() {
    const cuantas = datos?.pendientes?.length ?? 0
    const total = (datos?.pendientes ?? []).reduce((s, p) => s + Number(p.total), 0)

    if (
      !await confirmar(
        `Se van a crear ${cuantas} factura(s) por ${dinero(total)}.\n\n` +
          'Son facturas del sistema: no se envía nada al SRI todavía.\n\n¿Continuar?',
      )
    )
      return

    setCorriendo(true)
    setResultado(null)
    onError?.(null)
    try {
      const r = await api.sri.generarFacturasDelMes({})
      setResultado(r)
      await recargar()
    } catch (err) {
      onError?.(err)
    } finally {
      setCorriendo(false)
    }
  }

  if (cargando) return <Cargando />

  const pendientes = datos?.pendientes ?? []
  const total = pendientes.reduce((s, p) => s + Number(p.total), 0)

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Les toca factura hoy" valor={pendientes.length} icon={CalendarClock} />
        <Stat label="Total a facturar" valor={dinero(total)} color="text-emerald-400" />
        <Stat label="Omitidos" valor={datos?.omitidos?.length ?? 0} color="text-amber-400" />
      </div>

      {resultado && (
        <Card title="Resultado de la generación">
          <Aviso tipo={resultado.fallidas?.length ? 'alerta' : 'info'}>
            Se crearon <b>{resultado.creadas?.length ?? 0}</b> factura(s).
            {resultado.fallidas?.length > 0 && (
              <> {resultado.fallidas.length} fallaron: {resultado.fallidas[0].error}</>
            )}
          </Aviso>
        </Card>
      )}

      <Card
        title="Facturas de hoy"
        subtitle={
          datos?.automatica
            ? `Se generan solas todos los días a las ${datos.hora}`
            : 'La generación automática está apagada'
        }
        icon={CalendarClock}
        actions={
          <Button
            variante="primario"
            icon={Play}
            cargando={corriendo}
            disabled={!pendientes.length}
            onClick={generar}
          >
            Generar ahora ({pendientes.length})
          </Button>
        }
      >
        {!datos?.automatica && (
          <div className="mb-3">
            <Aviso>
              Para que corran solas, poné <code className="text-slate-300">FACTURACIÓN_AUTOMATICA=true</code>{' '}
              —sin tilde: <code className="text-slate-300">FACTURACION_AUTOMATICA</code>— en el{' '}
              <code className="text-slate-300">.env</code> del middleware y reinicialo. Mientras
              tanto, el botón las crea a mano.
            </Aviso>
          </div>
        )}

        {pendientes.length === 0 ? (
          <Aviso>
            Hoy no le toca factura a nadie. Cada abonado se factura en su día, configurado en su
            ficha → <b>Facturación → Configuración</b>.
          </Aviso>
        ) : (
          <Table
            columnas={['Cliente', 'Concepto', 'Período', 'Vence', 'Subtotal', 'Impuesto', 'Total']}
            filas={pendientes}
            renderFila={(p) => (
              <tr key={p.cliente.id} className="text-slate-300">
                <td className="px-3 py-2">
                  <Link
                    to={`/clientes/${p.cliente.id}`}
                    className="text-slate-100 hover:text-sky-400 hover:underline"
                  >
                    {p.cliente.nombre}
                  </Link>
                </td>
                <td className="px-3 py-2 text-xs">{p.concepto}</td>
                <td className="px-3 py-2 text-xs">
                  {p.periodo.desde} → {p.periodo.hasta}
                </td>
                <td className="px-3 py-2 text-xs">{p.vencimiento}</td>
                <td className="px-3 py-2 text-xs">{dinero(p.subtotal)}</td>
                <td className="px-3 py-2 text-xs">{dinero(p.impuesto)}</td>
                <td className="px-3 py-2">
                  <b className="text-emerald-300">{dinero(p.total)}</b>
                </td>
              </tr>
            )}
          />
        )}
      </Card>

      {datos?.omitidos?.length > 0 && (
        <Card title="Omitidos" subtitle="Por qué no se les factura hoy">
          <div className="space-y-1 text-xs">
            {datos.omitidos.slice(0, 20).map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-amber-400">!</span>
                <Link to={`/clientes/${o.id}`} className="text-slate-200 hover:underline">
                  {o.nombre}
                </Link>
                <span className="text-slate-500">— {o.motivo}</span>
              </div>
            ))}
            {datos.omitidos.length > 20 && (
              <p className="text-slate-500">y {datos.omitidos.length - 20} más…</p>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}
