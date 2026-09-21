import { useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { AlertTriangle, Minus, Plus } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Button, ErrorBanner, Field, Input } from '../ui'

/**
 * Agregar o quitar VLANs de un troncal.
 *
 * Es la operación más disruptiva del sistema. Quitar una VLAN con abonados los
 * deja sin salida a TODOS en el mismo segundo — y desde el lado GPON no se ve
 * nada: las ONTs siguen online, con buena señal y su service-port creado. Por
 * eso el middleware se niega a hacerlo salvo que se insista, y dice cuántos son.
 *
 * Agregar, en cambio, es inofensivo: una VLAN de más en el troncal no molesta a
 * nadie. La pantalla trata las dos cosas de forma distinta a propósito.
 */

/** "200,205-210" → [200, 205, 206, ..., 210] */
function parsearLista(texto) {
  const vlans = []
  for (const trozo of String(texto ?? '').split(',')) {
    const t = trozo.trim()
    if (!t) continue

    const rango = t.match(/^(\d+)\s*-\s*(\d+)$/)
    if (rango) {
      const [a, b] = [Number(rango[1]), Number(rango[2])]
      if (b - a > 500) return { error: `El rango ${t} es demasiado grande` }
      for (let v = a; v <= b; v++) vlans.push(v)
      continue
    }
    if (!/^\d+$/.test(t)) return { error: `"${t}" no es una VLAN ni un rango` }
    vlans.push(Number(t))
  }

  const fuera = vlans.filter((v) => v < 1 || v > 4094)
  if (fuera.length) return { error: `Fuera de rango: ${fuera.join(', ')}` }
  return { vlans: [...new Set(vlans)] }
}

export default function EditarVlansUplink({ olt, puerto, onListo, onCerrar }) {
  const confirmar = useConfirmar()
  const [texto, setTexto] = useState('')
  const [trabajando, setTrabajando] = useState(null)
  const [error, setError] = useState(null)
  const [resultado, setResultado] = useState(null)

  const parsed = parsearLista(texto)
  const vlans = parsed.vlans ?? []
  const yaEstan = vlans.filter((v) => puerto.vlans?.includes(v))
  const noEstan = vlans.filter((v) => !puerto.vlans?.includes(v))

  async function aplicar(quitar, forzar = false) {
    setTrabajando(quitar ? 'quitar' : 'agregar')
    setError(null)
    try {
      const r = await api.olt.cambiarVlansUplink(olt.id, {
        slot: puerto.slot,
        puertos: [puerto.puerto],
        vlans,
        quitar,
        forzar,
      })
      setResultado(r)
      setTexto('')
      onListo?.()
    } catch (err) {
      // El 409 con abonados no es un error del operador: es la protección
      // haciendo su trabajo. Se muestra como una pregunta, no como una falla.
      setError(err)
    } finally {
      setTrabajando(null)
    }
  }

  const bloqueoPorAbonados = error?.status === 409 && /abonados colgando/i.test(error.message ?? '')

  return (
    <div className="space-y-4">
      <div className="t-panel px-4 py-3">
        <p className="font-mono text-sm text-slate-100">
          0/{puerto.slot}/{puerto.puerto}
        </p>
        <p className="mt-1 font-mono text-xs text-slate-400">
          <span className="text-slate-500">Ahora: </span>
          {puerto.rangos || 'ninguna'}
        </p>
        <p className="mt-0.5 text-[11px] text-slate-600">
          {puerto.vlans?.length ?? 0} VLANs · nativa {puerto.nativa ?? '—'} ·{' '}
          {puerto.online ? 'con enlace' : 'sin enlace'}
        </p>
      </div>

      {resultado && (
        <Aviso>
          Listo. El puerto quedó con:{' '}
          <span className="font-mono">{resultado.puertos?.[0]?.rangos || 'ninguna'}</span>
          <span className="mt-1 block font-mono text-[11px] opacity-70">{resultado.comando}</span>
        </Aviso>
      )}

      {!bloqueoPorAbonados && <ErrorBanner error={error} onCerrar={() => setError(null)} />}

      {bloqueoPorAbonados && (
        <div className="rounded-lg border border-rose-500/50 bg-rose-500/10 px-4 py-3">
          <p className="flex items-start gap-2 text-sm font-medium text-rose-200">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            {error.message}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-rose-300/80">{error.hint}</p>
          <div className="mt-3 flex gap-2">
            <Button
              variante="peligro"
              icon={Minus}
              cargando={trabajando === 'quitar'}
              onClick={async () => {
                if (
                  await confirmar(
                    `${error.detalle}\n\nEsos abonados van a quedar sin internet inmediatamente.\n\n¿Seguro?`,
                  )
                ) {
                  aplicar(true, true)
                }
              }}
            >
              Quitarlas igual
            </Button>
            <Button variante="fantasma" onClick={() => setError(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      <Field
        label="VLANs"
        hint="Una lista o rangos: 300 · 300,301 · 240-250 · 300,310-315"
      >
        <Input
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder="300, 310-315"
          autoFocus
        />
      </Field>

      {parsed.error && <p className="text-xs text-rose-300">{parsed.error}</p>}

      {vlans.length > 0 && !parsed.error && (
        <p className="text-[11px] text-slate-500">
          {vlans.length} VLANs.
          {yaEstan.length > 0 && (
            <span className="text-amber-400"> {yaEstan.length} ya están en el troncal.</span>
          )}
          {noEstan.length > 0 && <span> {noEstan.length} no están.</span>}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-800 pt-3">
        {onCerrar && (
          <Button variante="fantasma" onClick={onCerrar}>
            Cerrar
          </Button>
        )}
        <Button
          variante="peligro"
          icon={Minus}
          disabled={!vlans.length || parsed.error || trabajando}
          cargando={trabajando === 'quitar'}
          onClick={() => aplicar(true)}
        >
          Quitar del troncal
        </Button>
        <Button
          variante="exito"
          icon={Plus}
          disabled={!vlans.length || parsed.error || trabajando}
          cargando={trabajando === 'agregar'}
          onClick={() => aplicar(false)}
        >
          Agregar al troncal
        </Button>
      </div>

      <p className="text-[11px] leading-relaxed text-slate-500">
        Agregar una VLAN de más al troncal no molesta a nadie. Quitar una que tenga abonados los
        deja sin internet a todos a la vez, y desde el lado GPON no se nota: las ONTs siguen
        online. Por eso el sistema se niega y hay que insistir.
      </p>
    </div>
  )
}
