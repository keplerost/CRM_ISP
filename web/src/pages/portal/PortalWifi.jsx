import { useEffect, useState } from 'react'
import { CheckCircle2, Clock, Eye, EyeOff, Loader2, Wifi } from 'lucide-react'
import { portalApi } from '../../lib/portalApi'
import { Cargando, Tarjeta } from './PortalApp'

/**
 * El WiFi del abonado.
 *
 * Cuando el equipo habla con el servidor de gestión, el cambio se aplica en el
 * momento y se le dice que está hecho. Cuando no —el equipo apagado, sin camino
 * de red— queda pedido y se le dice ESO.
 *
 * Nunca al revés. Decirle "listo" sin haberlo hecho lo deja sin WiFi: se
 * desconecta para reconectar con la clave nueva y no entra ni con una ni con la
 * otra, en su casa, un domingo a la noche.
 */

/** Por qué no se puede tocar el equipo, dicho para el abonado. */
const MOTIVOS = {
  sin_equipo: 'Tu equipo no permite cambiar la clave desde acá.',
  sin_acs: 'El cambio de clave desde el portal todavía no está habilitado.',
  acs_no_responde: 'No podemos consultar tu equipo en este momento.',
  equipo_desconocido: 'Tu equipo todavía no se reportó a nuestro sistema de gestión.',
}

export default function PortalWifi({ cuenta }) {
  const [datos, setDatos] = useState(null)
  const [clave, setClave] = useState('')
  const [ssid, setSsid] = useState('')
  const [verClave, setVerClave] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [error, setError] = useState(null)

  const cargar = () => portalApi.solicitudWifi().then(setDatos).catch(() => setDatos({ equipo: {}, pedidos: [] }))

  useEffect(() => {
    cargar()
  }, [])

  async function enviar(e) {
    e.preventDefault()
    setEnviando(true)
    setError(null)
    setResultado(null)
    try {
      const r = await portalApi.cambiarWifi({ clave: clave || undefined, ssid: ssid || undefined })
      setResultado(r)
      setClave('')
      setSsid('')
      await cargar()
    } catch (err) {
      setError(err.message)
    } finally {
      setEnviando(false)
    }
  }

  if (!datos) return <Cargando />

  const equipo = datos.equipo ?? {}
  const pendiente = (datos.pedidos ?? []).find((s) => s.estado === 'pendiente')

  // Sin equipo propio no hay nada que ofrecer: mostrar el formulario sería
  // pedirle que escriba una clave que nadie va a aplicar.
  if (equipo.motivo === 'sin_equipo') {
    return (
      <Tarjeta>
        <p className="text-sm leading-relaxed text-slate-400">
          {MOTIVOS.sin_equipo} Mandanos un reclamo desde <b className="text-slate-300">Ayuda</b> y
          lo hacemos nosotros.
        </p>
      </Tarjeta>
    )
  }

  return (
    <div className="space-y-3">
      {/* Las redes que el equipo reportó de verdad. Es lo que el abonado ve al
          buscar WiFi en su celular, así que reconoce cuál es la suya. */}
      {equipo.gestionable && equipo.redes?.length > 0 ? (
        <Tarjeta titulo="Tus redes">
          <div className="space-y-3">
            {equipo.redes.map((r) => (
              <div key={r.indice} className="flex items-center gap-3">
                <Wifi size={18} className={r.habilitada ? 'text-sky-400' : 'text-slate-700'} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-200">{r.ssid}</p>
                  <p className="text-xs text-slate-500">
                    {r.tiene_clave ? 'Protegida con clave' : 'Sin clave — cualquiera puede entrar'}
                    {!r.habilitada && ' · apagada'}
                  </p>
                </div>
              </div>
            ))}
            {equipo.ultimo_contacto && (
              <p className="text-[11px] text-slate-600">
                Según lo último que reportó tu equipo:{' '}
                {new Date(equipo.ultimo_contacto).toLocaleString('es-EC')}
              </p>
            )}
          </div>
        </Tarjeta>
      ) : (
        <Tarjeta titulo="Tu red">
          <div className="flex items-center gap-3">
            <Wifi size={20} className="text-slate-600" />
            <div>
              <p className="text-sm text-slate-200">
                {equipo.ssid || cuenta.equipo?.ssid || 'Sin nombre cargado'}
              </p>
              <p className="text-xs text-slate-500">
                {MOTIVOS[equipo.motivo] ?? 'No pudimos consultar tu equipo.'}
              </p>
            </div>
          </div>
        </Tarjeta>
      )}

      {pendiente && (
        <div className="rounded-2xl border border-sky-500/30 bg-sky-500/5 p-4">
          <div className="flex gap-3">
            <Clock size={18} className="mt-0.5 shrink-0 text-sky-400" />
            <div>
              <p className="text-sm font-medium text-sky-200">Tu cambio está en camino</p>
              <p className="mt-1 text-xs leading-relaxed text-sky-200/80">
                Lo aplicamos apenas tu equipo esté disponible. Mientras tanto,{' '}
                <b>seguí usando la clave actual</b>: nada cambió todavía.
              </p>
            </div>
          </div>
        </div>
      )}

      <form onSubmit={enviar} className="space-y-4">
        <Tarjeta titulo="Cambiar la clave">
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm text-slate-400">Clave nueva</label>
              <div className="relative">
                <input
                  type={verClave ? 'text' : 'password'}
                  value={clave}
                  onChange={(e) => setClave(e.target.value)}
                  placeholder="Al menos 8 caracteres"
                  minLength={8}
                  maxLength={63}
                  autoComplete="new-password"
                  className="w-full t-card-sm px-4 py-3 pr-12 text-base text-slate-100 outline-none focus:border-sky-500"
                />
                {/* Poder verla no es un lujo: una clave de WiFi se escribe una
                    vez y después se dicta a las visitas. Escribirla a ciegas en
                    un celular es como se generan las claves con un error. */}
                <button
                  type="button"
                  onClick={() => setVerClave((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500"
                  aria-label={verClave ? 'Ocultar' : 'Ver'}
                >
                  {verClave ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-slate-500">
                Mínimo 8 caracteres: es lo que exige el WiFi, no un capricho nuestro.
              </p>
            </div>

            <div>
              <label className="mb-1.5 block text-sm text-slate-400">
                Nombre de la red <span className="text-slate-600">(opcional)</span>
              </label>
              <input
                value={ssid}
                onChange={(e) => setSsid(e.target.value)}
                placeholder={equipo.redes?.[0]?.ssid || cuenta.equipo?.ssid || 'Mi WiFi'}
                maxLength={32}
                className="w-full t-card-sm px-4 py-3 text-base text-slate-100 outline-none focus:border-sky-500"
              />
            </div>
          </div>
        </Tarjeta>

        {error && <p className="text-sm text-rose-400">{error}</p>}

        {/* El resultado distingue los dos casos, porque son distintos para el
            abonado: uno significa "andá a reconectar tus dispositivos" y el
            otro "no toques nada todavía". */}
        {resultado && (
          <div
            className={`flex gap-2.5 rounded-xl p-3.5 ${
              resultado.estado === 'aplicada'
                ? 'bg-emerald-500/10 text-emerald-300'
                : 'bg-sky-500/10 text-sky-300'
            }`}
          >
            {resultado.estado === 'aplicada' ? (
              <CheckCircle2 size={18} className="mt-0.5 shrink-0" />
            ) : (
              <Clock size={18} className="mt-0.5 shrink-0" />
            )}
            <p className="text-sm leading-relaxed">{resultado.mensaje}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={enviando || (clave.length < 8 && !ssid)}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 py-3.5 text-base font-medium text-white disabled:opacity-40"
        >
          {enviando && <Loader2 size={18} className="animate-spin" />}
          {equipo.gestionable ? 'Cambiar ahora' : 'Pedir el cambio'}
        </button>

        <p className="px-2 text-center text-xs leading-relaxed text-slate-500">
          Cuando se aplique, todos tus dispositivos van a pedirte la clave nueva. Anotala antes.
        </p>
      </form>
    </div>
  )
}
