import { useState } from 'react'
import { AlertTriangle, Crosshair, MapPin, Pencil } from 'lucide-react'
import { Aviso, Badge, Button, Field, Input } from '../ui'

/**
 * Captura la ubicación del domicilio.
 *
 * ── La regla que hace cumplible "no fingir que se capturó" ──
 *
 * El botón grande usa la API del navegador y guarda lo que ella devuelve,
 * incluida la PRECISIÓN en metros. Ese dato solo lo entrega la API: un número
 * escrito a mano no lo tiene. La base tiene un CHECK que rechaza una ubicación
 * marcada como `gps` sin precisión, así que no hay forma de que una coordenada
 * tipeada entre haciéndose pasar por una captura.
 *
 * La carga manual existe —hay casas sin señal, y sótanos— pero queda marcada
 * como manual, con quién la puso y cuándo.
 *
 * Lo que esto NO es: una prueba de que el vendedor estuvo ahí. Quien quiera
 * puede falsear la geolocalización de su propio navegador y ningún sistema web
 * lo impide. Lo que sí garantiza es que el sistema nunca AFIRME captura cuando
 * hubo tipeo.
 */

/** Arriba de esto la lectura no sirve para mandar a un técnico. */
const PRECISION_ACEPTABLE = 50

export default function CapturaUbicacion({ expediente, onGuardar, onError }) {
  const [midiendo, setMidiendo] = useState(false)
  const [lectura, setLectura] = useState(null)
  const [manual, setManual] = useState(null)

  const yaTiene = expediente.latitud != null && expediente.longitud != null

  const tomar = () => {
    if (!navigator.geolocation) {
      return onError?.(
        new Error('Este dispositivo no ofrece geolocalización. Cargala a mano con el otro botón.'),
      )
    }
    setMidiendo(true)
    onError?.(null)

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLectura({
          latitud: Number(pos.coords.latitude.toFixed(7)),
          longitud: Number(pos.coords.longitude.toFixed(7)),
          precision: pos.coords.accuracy,
        })
        setMidiendo(false)
      },
      (err) => {
        setMidiendo(false)
        // Se distingue el permiso denegado del resto: es lo que le pasa al 90%
        // y tiene una solución que el vendedor puede aplicar solo.
        onError?.(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? 'Le dijiste que no al permiso de ubicación. Habilitalo en el candado de la barra de direcciones y volvé a intentar.'
              : err.code === err.TIMEOUT
                ? 'El GPS tardó demasiado. Probá al aire libre, o cargala a mano.'
                : 'No se pudo leer la ubicación. Probá de nuevo o cargala a mano.',
          ),
        )
      },
      // `enableHighAccuracy` enciende el GPS del teléfono en vez de estimar por
      // antenas: la diferencia es entre 10 metros y 2 kilómetros.
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    )
  }

  const confirmar = async (datos, origen) => {
    try {
      await onGuardar({ ...datos, origen })
      setLectura(null)
      setManual(null)
    } catch (err) {
      onError?.(err)
    }
  }

  return (
    <div className="space-y-4">
      {yaTiene && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <MapPin size={16} className="text-emerald-400" />
            <span className="campo-txt font-mono">
              {Number(expediente.latitud).toFixed(6)}, {Number(expediente.longitud).toFixed(6)}
            </span>
            <Badge color={expediente.ubicacion_origen === 'gps' ? 'verde' : 'ambar'}>
              {expediente.ubicacion_origen === 'gps'
                ? `GPS ±${Math.round(expediente.precision_m)} m`
                : 'Cargada a mano'}
            </Badge>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            {new Date(expediente.ubicacion_en).toLocaleString('es-EC')}
          </p>
          <a
            href={`https://www.google.com/maps?q=${expediente.latitud},${expediente.longitud}`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-[12px] text-sky-400 underline"
          >
            Ver en el mapa
          </a>
        </div>
      )}

      {/* El botón grande es el camino principal: en la vereda, con una mano. */}
      <button
        type="button"
        onClick={tomar}
        disabled={midiendo}
        className="campo-acento flex w-full items-center justify-center gap-3 rounded-2xl px-4 py-5 text-base font-semibold transition disabled:opacity-60"
      >
        <Crosshair size={22} className={midiendo ? 'animate-pulse' : ''} />
        {midiendo ? 'Buscando el GPS…' : yaTiene ? 'Tomar de nuevo' : 'Tomar ubicación actual'}
      </button>

      {midiendo && (
        <p className="campo-tenue text-center text-[12px]">
          Puede tardar unos segundos. Al aire libre es más rápido y más preciso.
        </p>
      )}

      {lectura && (
        <div className="campo-sup campo-borde space-y-3 rounded-xl border p-3">
          <div className="campo-txt text-[13px]">
            <span className="font-mono">
              {lectura.latitud.toFixed(6)}, {lectura.longitud.toFixed(6)}
            </span>
            <span className="campo-suave ml-2">±{Math.round(lectura.precision)} m</span>
          </div>

          {/* Una lectura de ±800 m manda al técnico a otra cuadra. Se avisa, pero
              no se bloquea: a veces es lo único que hay. */}
          {lectura.precision > PRECISION_ACEPTABLE && (
            <Aviso tipo="alerta">
              <b>Precisión baja</b> (±{Math.round(lectura.precision)} m). Con esto el técnico puede
              terminar en otra casa. Salí al aire libre y tomala de nuevo, si podés.
            </Aviso>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Button variante="fantasma" onClick={() => setLectura(null)}>
              Descartar
            </Button>
            <Button variante="primario" onClick={() => confirmar(lectura, 'gps')}>
              Guardar
            </Button>
          </div>
        </div>
      )}

      {/* La salida de emergencia, deliberadamente menos vistosa que el botón
          principal: es la excepción, no la costumbre. */}
      {!manual ? (
        <button
          type="button"
          onClick={() => setManual({ latitud: '', longitud: '' })}
          className="campo-borde campo-suave flex w-full items-center justify-center gap-2 rounded-xl border py-3 text-[13px]"
        >
          <Pencil size={14} /> No hay señal: cargar a mano
        </button>
      ) : (
        <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="flex items-start gap-2 text-[12px] text-amber-200">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>
              Va a quedar marcada como <b>cargada a mano</b>, con tu nombre y la hora. No se
              registra como captura de GPS.
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Latitud">
              <Input
                inputMode="decimal"
                value={manual.latitud}
                onChange={(e) => setManual({ ...manual, latitud: e.target.value })}
                placeholder="-0.9302"
              />
            </Field>
            <Field label="Longitud">
              <Input
                inputMode="decimal"
                value={manual.longitud}
                onChange={(e) => setManual({ ...manual, longitud: e.target.value })}
                placeholder="-79.2214"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variante="fantasma" onClick={() => setManual(null)}>
              Cancelar
            </Button>
            <Button
              disabled={!manual.latitud || !manual.longitud}
              onClick={() =>
                confirmar(
                  { latitud: Number(manual.latitud), longitud: Number(manual.longitud) },
                  'manual',
                )
              }
            >
              Guardar a mano
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
