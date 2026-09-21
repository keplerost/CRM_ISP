import { useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { AlertTriangle, CloudOff, RefreshCw, Trash2, Upload, WifiOff } from 'lucide-react'
import {
  alCambiar,
  contarPendientes,
  descartar,
  despachar,
  reintentar,
  trabados,
} from '../../lib/cola'

/**
 * La franja que dice si el trabajo llegó o no.
 *
 * ── Por qué esto no es un detalle ──
 *
 * Sin esto, la app sin conexión es una trampa: el técnico aprieta guardar, la
 * pantalla dice que guardó, y él se va. Lo que guardó está en su teléfono. Si el
 * teléfono se pierde, se rompe o simplemente nunca vuelve a tener señal en un
 * lugar con cobertura, ese trabajo no existió — y él va a jurar que lo cerró.
 *
 * Por eso mientras hay algo en la cola, la app lo dice todo el tiempo, arriba, y
 * no se puede cerrar el aviso. Es incómodo a propósito: la incomodidad es
 * proporcional al riesgo real.
 */
export default function EstadoConexion() {
  const confirmar = useConfirmar()
  const [enLinea, setEnLinea] = useState(navigator.onLine)
  const [pendientes, setPendientes] = useState(0)
  const [frenados, setFrenados] = useState([])
  const [enviando, setEnviando] = useState(false)
  const [abierto, setAbierto] = useState(false)

  useEffect(() => {
    const refrescar = async () => {
      setPendientes(await contarPendientes())
      setFrenados(await trabados())
    }
    refrescar()

    const soltar = alCambiar(refrescar)
    const arriba = () => setEnLinea(true)
    const abajo = () => setEnLinea(false)
    window.addEventListener('online', arriba)
    window.addEventListener('offline', abajo)
    return () => {
      soltar()
      window.removeEventListener('online', arriba)
      window.removeEventListener('offline', abajo)
    }
  }, [])

  const enviarAhora = async () => {
    setEnviando(true)
    try {
      await despachar()
    } finally {
      setEnviando(false)
    }
  }

  // Todo bien y nada pendiente: no se muestra nada. Un cartel verde permanente
  // de "conectado" se vuelve invisible en dos días, y entonces el rojo tampoco
  // se ve.
  if (enLinea && pendientes === 0) return null

  const hayTrabados = frenados.length > 0
  const tono = hayTrabados
    ? 'border-rose-500/40 bg-rose-500/15 text-rose-200'
    : !enLinea
      ? 'border-amber-500/40 bg-amber-500/15 text-amber-200'
      : 'border-sky-500/40 bg-sky-500/15 text-sky-200'

  return (
    <div className={`border-b px-4 py-2 text-[12px] ${tono}`}>
      <div className="mx-auto flex max-w-6xl items-center gap-2">
        {hayTrabados ? (
          <AlertTriangle size={15} className="shrink-0" />
        ) : !enLinea ? (
          <WifiOff size={15} className="shrink-0" />
        ) : (
          <CloudOff size={15} className="shrink-0" />
        )}

        <span className="min-w-0 flex-1">
          {hayTrabados ? (
            <>
              {frenados.length}{' '}
              {frenados.length === 1 ? 'cosa no se pudo enviar' : 'cosas no se pudieron enviar'}
            </>
          ) : !enLinea ? (
            <>
              Sin conexión.{' '}
              {pendientes > 0
                ? `${pendientes} ${pendientes === 1 ? 'cosa espera' : 'cosas esperan'} para enviarse.`
                : 'Podés seguir trabajando.'}
            </>
          ) : (
            <>
              {pendientes} {pendientes === 1 ? 'cosa falta enviar' : 'cosas faltan enviar'}
            </>
          )}
        </span>

        {enLinea && pendientes > 0 && !hayTrabados && (
          <button
            type="button"
            onClick={enviarAhora}
            disabled={enviando}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-current/30 px-2 py-1 font-medium disabled:opacity-50"
          >
            {enviando ? (
              <RefreshCw size={12} className="animate-spin" />
            ) : (
              <Upload size={12} />
            )}
            Enviar
          </button>
        )}

        {hayTrabados && (
          <button
            type="button"
            onClick={() => setAbierto((v) => !v)}
            className="shrink-0 rounded-lg border border-current/30 px-2 py-1 font-medium"
          >
            {abierto ? 'Ocultar' : 'Ver'}
          </button>
        )}
      </div>

      {/* El detalle de lo trabado. No se muestra por defecto —ocuparía media
          pantalla— pero tiene que estar a un toque: si algo no se envió, el
          técnico necesita poder decirle a la oficina qué fue. */}
      {abierto && hayTrabados && (
        <div className="mx-auto mt-2 max-w-6xl space-y-1.5">
          {frenados.map((op) => (
            <div key={op.id} className="rounded-lg bg-slate-950/40 p-2">
              <p className="font-medium">{DESCRIPCION[op.tipo] ?? op.tipo}</p>
              <p className="mt-0.5 text-[11px] opacity-70">{op.error}</p>
              <p className="text-[10px] opacity-50">
                {new Date(op.creado).toLocaleString('es-EC')} · {op.intentos} intentos
              </p>
              <div className="mt-1.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => reintentar(op.id)}
                  className="flex items-center gap-1 rounded border border-current/30 px-2 py-0.5 text-[11px]"
                >
                  <RefreshCw size={11} /> Reintentar
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    // Confirmación explícita: descartar es perder el trabajo del
                    // técnico, y perderlo en silencio sería lo peor que puede
                    // hacer esta pantalla.
                    if (await confirmar('Se va a perder lo que quedó sin enviar. ¿Descartar?')) {
                      descartar(op.id)
                    }
                  }}
                  className="flex items-center gap-1 rounded border border-current/30 px-2 py-0.5 text-[11px] opacity-70"
                >
                  <Trash2 size={11} /> Descartar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const DESCRIPCION = {
  'instalacion.guardar': 'Avance de una instalación',
  'instalacion.finalizar': 'Cierre de una instalación',
  'material.consumir': 'Descuento de material',
  'ticket.cerrar': 'Cierre de un ticket',
  'ticket.estado': 'Cambio de estado de un ticket',
}
