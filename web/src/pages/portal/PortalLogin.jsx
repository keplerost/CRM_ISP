import { useState } from 'react'
import { ArrowLeft, KeyRound, Loader2 } from 'lucide-react'
import { portalApi, guardarToken } from '../../lib/portalApi'
import { useMarca } from '../../lib/useMarca'

/**
 * La entrada del abonado.
 *
 * Primero la cédula, y después una de dos puertas:
 *
 *   SU CONTRASEÑA, si ya la definió. Es lo que usa el que entra seguido y no
 *   depende de que le llegue nada.
 *
 *   UN CÓDIGO al celular, para la primera vez —cuando todavía no hay
 *   contraseña que poner— y para el que la olvidó. Un abonado entra una vez al
 *   mes: la contraseña olvidada es la regla, no la excepción, y sin esta puerta
 *   cada una sería una llamada a la oficina.
 *
 * Todo está pensado para un pulgar en una pantalla chica: campos grandes,
 * teclado numérico, y el código se pega solo si el celular lo ofrece.
 */
export default function PortalLogin({ onEntrar }) {
  const marca = useMarca()
  const [paso, setPaso] = useState('cedula')
  const [identificacion, setIdentificacion] = useState('')
  const [clave, setClave] = useState('')
  const [codigo, setCodigo] = useState('')
  const [aDonde, setADonde] = useState(null)
  const [error, setError] = useState(null)
  const [cargando, setCargando] = useState(false)

  async function pedir(e) {
    e.preventDefault()
    setCargando(true)
    setError(null)
    try {
      const r = await portalApi.pedirCodigo(identificacion)
      setADonde(r.destino ?? null)
      setPaso('codigo')
    } catch (err) {
      setError(err.message)
    } finally {
      setCargando(false)
    }
  }

  async function conClave(e) {
    e.preventDefault()
    setCargando(true)
    setError(null)
    try {
      const r = await portalApi.entrarConClave(identificacion, clave)
      guardarToken(r.token)
      onEntrar()
    } catch (err) {
      setError(err.message)
      setClave('')
    } finally {
      setCargando(false)
    }
  }

  async function confirmar(e) {
    e.preventDefault()
    setCargando(true)
    setError(null)
    try {
      const r = await portalApi.entrar(identificacion, codigo)
      guardarToken(r.token)
      onEntrar()
    } catch (err) {
      setError(err.message)
      setCodigo('')
    } finally {
      setCargando(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#F6F8FB] p-5">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          {marca.logo_b64 ? (
            <img src={marca.logo_b64} alt="" className="mx-auto mb-3 max-h-16" />
          ) : (
            <div className="mx-auto mb-3 grid size-14 place-items-center rounded-2xl bg-sky-600 text-xl font-bold text-white">
              {marca.nombre_sistema.trim().charAt(0).toUpperCase()}
            </div>
          )}
          <h1 className="text-xl font-semibold text-slate-100">{marca.nombre_sistema}</h1>
          <p className="mt-1 text-sm text-slate-500">Consultá tu cuenta</p>
        </div>

        {paso === 'clave' ? (
          <form onSubmit={conClave} className="space-y-4">
            <button
              type="button"
              onClick={() => { setPaso('cedula'); setError(null); setClave('') }}
              className="flex items-center gap-1 text-sm text-slate-400"
            >
              <ArrowLeft size={15} /> Cambiar la cédula
            </button>

            <div>
              <label className="mb-1.5 block text-sm text-slate-400">Tu contraseña</label>
              <input
                type="password"
                autoComplete="current-password"
                value={clave}
                onChange={(e) => setClave(e.target.value)}
                required
                autoFocus
                className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3.5 text-lg text-slate-100 outline-none focus:border-sky-500"
              />
            </div>

            {error && <p className="text-sm text-rose-400">{error}</p>}

            <button
              type="submit"
              disabled={cargando || !clave}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 py-3.5 text-base font-medium text-white disabled:opacity-40"
            >
              {cargando && <Loader2 size={18} className="animate-spin" />}
              Entrar
            </button>

            {/* La salida cuando la olvidó. Sin esto, un abonado sin contraseña
                queda afuera de su cuenta y tiene que llamar a la oficina — que
                es justo lo que el portal venía a evitar. */}
            <button
              type="button"
              onClick={pedir}
              disabled={cargando}
              className="w-full text-center text-sm text-sky-400"
            >
              Olvidé mi contraseña — entrar con un código
            </button>
          </form>
        ) : paso === 'cedula' ? (
          <form onSubmit={pedir} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm text-slate-400">Tu cédula o RUC</label>
              <input
                // inputMode numérico: en el celular abre el teclado de números
                // directo, sin que nadie tenga que cambiarlo.
                inputMode="numeric"
                autoComplete="username"
                value={identificacion}
                onChange={(e) => setIdentificacion(e.target.value.replace(/\D/g, ''))}
                placeholder="1712345678"
                required
                className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3.5 text-lg text-slate-100 outline-none focus:border-sky-500"
              />
            </div>

            {error && <p className="text-sm text-rose-400">{error}</p>}

            {/* La contraseña primero: es lo que usa el que entra seguido, y no
                depende de que le llegue nada. El código queda como la segunda
                puerta — para la primera vez y para el que la olvidó. */}
            <button
              type="button"
              onClick={() => { setPaso('clave'); setError(null) }}
              disabled={identificacion.length < 5}
              className="w-full rounded-xl bg-sky-600 py-3.5 text-base font-medium text-white disabled:opacity-40"
            >
              Continuar con mi contraseña
            </button>

            <button
              type="submit"
              disabled={cargando || identificacion.length < 5}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 py-3.5 text-base text-slate-300 disabled:opacity-40"
            >
              {cargando ? <Loader2 size={18} className="animate-spin" /> : <KeyRound size={18} />}
              Enviarme un código
            </button>

            <p className="text-center text-xs leading-relaxed text-slate-500">
              ¿Primera vez? Pedí el código: te llega al celular que tenés registrado con nosotros.
            </p>
          </form>
        ) : (
          <form onSubmit={confirmar} className="space-y-4">
            <button
              type="button"
              onClick={() => {
                setPaso('cedula')
                setError(null)
                setCodigo('')
              }}
              className="flex items-center gap-1 text-sm text-slate-400"
            >
              <ArrowLeft size={15} /> Cambiar la cédula
            </button>

            <div>
              <label className="mb-1.5 block text-sm text-slate-400">
                Código que te llegó{aDonde ? ` a ${aDonde}` : ''}
              </label>
              <input
                inputMode="numeric"
                // El celular ofrece pegar el código del SMS/WhatsApp sin
                // copiarlo a mano. Es la diferencia entre entrar y abandonar.
                autoComplete="one-time-code"
                maxLength={6}
                value={codigo}
                onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                required
                autoFocus
                className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3.5 text-center font-mono text-3xl tracking-[0.4em] text-slate-100 outline-none focus:border-sky-500"
              />
            </div>

            {error && <p className="text-sm text-rose-400">{error}</p>}

            <button
              type="submit"
              disabled={cargando || codigo.length !== 6}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 py-3.5 text-base font-medium text-white disabled:opacity-40"
            >
              {cargando && <Loader2 size={18} className="animate-spin" />}
              Entrar
            </button>

            <button
              type="button"
              onClick={pedir}
              disabled={cargando}
              className="w-full text-center text-sm text-slate-400"
            >
              No me llegó — enviar otro
            </button>

            <p className="text-center text-xs leading-relaxed text-slate-500">
              El código vence en 10 minutos. No se lo des a nadie: con él se entra a tu cuenta.
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
