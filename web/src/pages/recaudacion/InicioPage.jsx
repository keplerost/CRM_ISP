import { useCallback, useEffect, useState } from 'react'
import { FileText, Search, Wallet } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { abrirPdf } from '../../lib/pdf'
import { dineroCero as dinero } from '../../lib/formato'
import BuscadorCliente from '../../components/pagos/BuscadorCliente'
import FormPago from '../../components/pagos/FormPago'
import { Button, Card, Cargando, ErrorBanner } from '../../components/ui'

/**
 * La pantalla del punto de recaudación.
 *
 * ── Por qué es tan chica ──
 *
 * Porque hace una sola cosa: buscar al abonado que llegó y cobrarle. Todo lo demás
 * que se pueda tocar en un mostrador donde no hay a quién preguntarle es
 * superficie para equivocarse.
 *
 * No hay listado de abonados a propósito. El punto de recaudación no navega la
 * cartera del ISP: atiende a quien se para enfrente y dice su nombre. Es la
 * diferencia entre cobrar y poder llevarse el padrón entero.
 *
 * ── Los dos números de arriba ──
 *
 * Salen de la misma cuenta que el cierre de caja del administrador. Es a propósito:
 * cuando se entrega la recaudación, los dos tienen que estar mirando el mismo
 * número, y cualquier diferencia de criterio —contar o no los anulados, por fecha
 * de pago o de registro— aparecería como plata faltante en una discusión donde
 * nadie se equivocó.
 */
export default function RecaudacionInicioPage() {
  const [resumen, setResumen] = useState(null)
  const [cliente, setCliente] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const recargar = useCallback(async () => {
    const { data, error: e } = await supabase.from('v_mi_recaudacion').select('*').maybeSingle()

    if (e) {
      setError(
        /does not exist/i.test(e.message)
          ? {
              message: 'Falta la vista de recaudación',
              hint: 'Corré supabase/migracion-160-el-punto-de-recaudacion.sql',
            }
          : e,
      )
    }
    setResumen(data ?? null)
  }, [])

  useEffect(() => {
    recargar().finally(() => setCargando(false))
  }, [recargar])

  /** Mi reporte: lo mismo que ve el administrador, filtrado a lo mío. */
  function miReporte() {
    const hoy = new Date().toISOString().slice(0, 10)
    const p = new URLSearchParams({ desde: hoy, hasta: hoy })
    abrirPdf(() => api.pagos.transaccionesPdf(p.toString())).catch(setError)
  }

  if (cargando) return <Cargando />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Recaudación</h1>
          <p className="text-sm text-slate-500">
            Buscá al abonado por nombre, cédula o contrato y cobrale.
          </p>
        </div>

        <Button variante="secundario" icon={FileText} onClick={miReporte}>
          Mi reporte de hoy
        </Button>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {resumen && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Caja
            titulo="Cobrado hoy"
            valor={dinero(resumen.hoy)}
            nota={`${resumen.cobros_hoy} cobro${Number(resumen.cobros_hoy) === 1 ? '' : 's'}`}
            destacado
            /* Lo anulado se dice siempre. Es la respuesta a "imprimí diez
               comprobantes y entrego el valor de nueve": sin ese número, la
               diferencia parece un faltante de caja. */
            alerta={
              Number(resumen.anulados_hoy) > 0
                ? `${resumen.anulados_hoy} anulado${Number(resumen.anulados_hoy) === 1 ? '' : 's'} por ${dinero(resumen.anulado_hoy)}`
                : null
            }
          />
          <Caja
            titulo="Cobrado en total"
            valor={dinero(resumen.total)}
            nota={
              resumen.desde
                ? `${resumen.cobros_total} cobros desde ${resumen.desde}`
                : `${resumen.cobros_total} cobros`
            }
          />
        </div>
      )}

      {/* Buscar y cobrar en la misma pantalla: es el único trabajo que hace este
          rol, y mandarlo a otra pantalla para completarlo agrega un clic a lo que
          repite cincuenta veces por día. */}
      {cliente ? (
        <Card title={cliente.nombre} subtitle={cliente.identificacion ?? ''}>
          <div className="p-4">
            <FormPago
              cliente={cliente}
              onError={setError}
              onCancelar={() => setCliente(null)}
              onRegistrado={() => {
                setCliente(null)
                // Los totales cambiaron: se vuelven a leer en vez de sumarlos acá,
                // para que sigan saliendo de la misma cuenta que ve el
                // administrador.
                recargar()
              }}
            />
          </div>
        </Card>
      ) : (
        <Card title="Cobrar" icon={Search} subtitle="Nombre, cédula o número de contrato">
          <div className="p-4">
            <BuscadorCliente onElegir={setCliente} />
          </div>
        </Card>
      )}
    </div>
  )
}

function Caja({ titulo, valor, nota, alerta = null, destacado = false }) {
  return (
    <div
      className={`rounded-lg border p-5 ${
        destacado ? 'border-emerald-800/60 bg-[#ECFDF5]' : 'border-slate-800 bg-[#F6F8FB]'
      }`}
    >
      <div className="flex items-center gap-2">
        <Wallet size={15} className={destacado ? 'text-emerald-400' : 'text-slate-500'} />
        <p className="text-[11px] uppercase tracking-wider text-slate-500">{titulo}</p>
      </div>
      <p
        className={`mt-1 text-3xl font-semibold tabular-nums ${
          destacado ? 'text-emerald-300' : 'text-slate-100'
        }`}
      >
        {valor}
      </p>
      <p className="mt-0.5 text-xs text-slate-500">{nota}</p>
      {alerta && <p className="mt-1 text-xs text-rose-400">{alerta}</p>}
    </div>
  )
}
