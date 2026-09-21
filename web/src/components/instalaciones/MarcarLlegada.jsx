import { useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { CheckCircle2, MapPinCheck, Navigation } from 'lucide-react'
import { campoApi } from '../../lib/colaCampo'
import { RADIO_LLEGADA_M, distanciaEnMetros, ubicacionActual } from '../../lib/soporte'

/**
 * "Llegué al domicilio."
 *
 * ── Por qué hacía falta ──
 *
 * En un ticket esto ya existía: al tocar "Llegué" se toma el GPS, se compara
 * con la coordenada del abonado y queda registrado desde dónde se marcó. En una
 * instalación no había nada — se sabía cuándo se cerró, no cuándo se llegó.
 *
 * Es el mismo técnico, en el mismo domicilio, y en un caso quedaba constancia y
 * en el otro no. Esa asimetría no tiene defensa, y además rompe la única
 * pregunta que después se quiere hacer: cuánto tarda una visita.
 *
 * Usa las mismas funciones y las mismas columnas que el ticket, con los mismos
 * nombres. Así una consulta puede medir los dos sin distinguirlos.
 *
 * ── Lo que NO hace ──
 *
 * No bloquea. Si el GPS no responde —bajo techo, en un galpón, con el cielo
 * tapado— se marca igual y queda anotado que no hubo confirmación. Y si la
 * distancia da lejos, se avisa y se pide confirmar, pero se deja seguir: la
 * coordenada del abonado muchas veces se cargó mal, y negarle trabajar a quien
 * está parado en la puerta sería trasladarle un problema que no es suyo.
 */
export default function MarcarLlegada({ orden, onMarcada, onError }) {
  const confirmar = useConfirmar()
  const [ubicando, setUbicando] = useState(false)

  // Ya marcada: se muestra el hecho, no el botón. Volver a ofrecerlo invitaría
  // a marcar dos veces y a pisar la hora real de llegada con una posterior.
  if (orden.llegada_at) {
    const hora = new Date(orden.llegada_at).toLocaleTimeString('es-EC', {
      hour: '2-digit',
      minute: '2-digit',
    })
    const lejos =
      orden.llegada_lat && orden.latitud
        ? distanciaEnMetros(
            { lat: Number(orden.latitud), lng: Number(orden.longitud) },
            { lat: Number(orden.llegada_lat), lng: Number(orden.llegada_lng) },
          )
        : null

    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
        <CheckCircle2 size={17} className="shrink-0 text-emerald-400" />
        <p className="text-[13px] text-emerald-200">
          Llegaste a las {hora}
          {orden.llegada_lat ? (
            lejos != null && lejos > RADIO_LLEGADA_M ? (
              <span className="text-emerald-200/70"> · marcado a {lejos} m del punto</span>
            ) : (
              <span className="text-emerald-200/70"> · ubicación confirmada</span>
            )
          ) : (
            <span className="text-emerald-200/70"> · sin confirmación de GPS</span>
          )}
        </p>
      </div>
    )
  }

  async function marcar() {
    setUbicando(true)
    onError?.(null)

    try {
      const pos = await ubicacionActual()

      const metros =
        pos && orden.latitud && orden.longitud
          ? distanciaEnMetros(
              { lat: Number(orden.latitud), lng: Number(orden.longitud) },
              { lat: pos.lat, lng: pos.lng },
            )
          : null

      if (metros != null && metros > RADIO_LLEGADA_M) {
        const seguir = await confirmar(
          `Estás a ${metros} m de la dirección de la orden.\n\n` +
            'Puede ser que la coordenada esté mal cargada. ¿Marcar la llegada igual? ' +
            'Queda registrado desde dónde marcaste.',
        )
        if (!seguir) return
      }

      if (!pos) {
        const seguir = await confirmar(
          'No se pudo tomar la ubicación del dispositivo.\n\n' +
            '¿Marcar la llegada igual? La orden va a quedar sin confirmación de GPS.',
        )
        if (!seguir) return
      }

      /**
       * La llegada mueve la orden a "en curso".
       *
       * No es cosmético: es lo que le dice a la oficina que el técnico está
       * adentro. Sin eso, una orden se ve igual a las 8 de la mañana que a
       * mitad del trabajo, y quien atiende el teléfono no puede responder
       * "sí, ya está ahí".
       */
      const campos = {
        llegada_at: new Date().toISOString(),
        llegada_lat: pos?.lat ?? null,
        llegada_lng: pos?.lng ?? null,
        llegada_precision_m: pos?.precision ? Math.round(pos.precision) : null,
        estado: orden.estado === 'agendada' ? 'en_curso' : orden.estado,
      }

      // Por la cola: la puerta del cliente es justo donde falta señal.
      await campoApi.guardarOrden(orden.id, campos)
      await onMarcada?.(campos)
    } catch (err) {
      onError?.(err)
    } finally {
      setUbicando(false)
    }
  }

  return (
    <button
      type="button"
      onClick={marcar}
      disabled={ubicando}
      className="flex w-full items-center justify-center gap-2 rounded-xl border border-sky-500/40 bg-sky-500/10 py-3 text-[14px] font-semibold text-sky-300 active:bg-sky-500/20 disabled:opacity-60"
    >
      {ubicando ? (
        <>
          <Navigation size={17} className="animate-pulse" /> Tomando ubicación…
        </>
      ) : (
        <>
          <MapPinCheck size={17} /> Llegué al domicilio
        </>
      )}
    </button>
  )
}
