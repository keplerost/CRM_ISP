import { useState } from 'react'
import { AlertTriangle, Eye, MailWarning } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, ErrorBanner } from '../ui'

/**
 * Ver a quién le llegaría un aviso de pago, sin mandarlo.
 *
 * ── Por qué esto va antes del interruptor ──
 *
 * Porque un aviso de cobranza mal redactado, o una regla de días mal puesta,
 * sale para todos los abonados a la vez y no se puede desenviar. El costo de
 * equivocarse acá no es un error en pantalla: es el teléfono sonando toda la
 * mañana y la confianza del abonado, que es lo que hace que el siguiente aviso
 * lo lea.
 *
 * Lo que más importa de esta lista no son los que reciben: son los que NO
 * pueden recibir. Un abonado sin correo ni celular no se entera de nada, y eso
 * no se ve mirando un total de enviados.
 */
export default function AvisosPagoPrueba() {
  const [filas, setFilas] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState(null)

  const mirar = async () => {
    setCargando(true)
    setError(null)
    try {
      setFilas(await api.tareas.avisosPagoPendientes())
    } catch (e) {
      setError(e)
    } finally {
      setCargando(false)
    }
  }

  const sinCanal = (filas ?? []).filter((f) => !f.canales?.length)
  const porNivel = (n) => (filas ?? []).filter((f) => f.nivel === n).length

  return (
    <div className="mt-2 space-y-2">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <Button icon={Eye} cargando={cargando} onClick={mirar} className="py-1.5 text-xs">
        Ver a quién le llegaría hoy
      </Button>

      {filas && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <MailWarning size={13} className="text-slate-500" />
            <b className="text-slate-200">{filas.length}</b> abonados
            <Badge color="azul">{porNivel(1)} por vencer</Badge>
            <Badge color="ambar">{porNivel(2)} vencidos</Badge>
            <Badge color="rojo">{porNivel(3)} último aviso</Badge>
          </div>

          {/* El hallazgo que no se ve en los totales. */}
          {sinCanal.length > 0 && (
            <Aviso tipo="alerta">
              <AlertTriangle size={13} className="mr-1 inline" />
              <b>{sinCanal.length}</b> no tienen correo, celular ni Telegram cargados: no se van a
              enterar de nada. {sinCanal.slice(0, 5).map((f) => f.nombre).join(', ')}
              {sinCanal.length > 5 && ` y ${sinCanal.length - 5} más`}.
            </Aviso>
          )}

          {filas.length === 0 && (
            <p className="text-xs text-slate-500">
              Hoy no le toca a nadie. Puede ser que no haya facturas vencidas, o que a todos ya se
              les haya mandado su aviso.
            </p>
          )}

          {filas.length > 0 && (
            <div className="max-h-64 overflow-auto rounded-lg border border-slate-800">
              <table className="w-full text-xs">
                <tbody>
                  {filas.map((f) => (
                    <tr key={f.cliente_id} className="border-b border-slate-800/60 last:border-0">
                      <td className="px-2 py-1.5">
                        <Badge
                          color={f.nivel === 3 ? 'rojo' : f.nivel === 2 ? 'ambar' : 'azul'}
                        >
                          {f.nivel}
                        </Badge>
                      </td>
                      <td className="px-2 py-1.5 text-slate-200">{f.nombre}</td>
                      <td className="px-2 py-1.5 tabular-nums text-slate-400">
                        ${Number(f.saldo).toFixed(2)}
                      </td>
                      <td className="px-2 py-1.5 text-slate-500">
                        {f.dias > 0 ? `venció hace ${f.dias} días` : `vence en ${-f.dias} días`}
                      </td>
                      <td className="px-2 py-1.5">
                        {f.canales?.length ? (
                          <span className="text-slate-400">por {f.canales[0]}</span>
                        ) : (
                          <span className="text-rose-400">sin forma de contacto</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
