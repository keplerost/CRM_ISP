import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { LogIn } from 'lucide-react'
import { supabase, supabaseConfigurado } from '../lib/supabaseClient'
import { modoDemo } from '../lib/demo'
import { useAuth } from '../lib/AuthContext'
import { Button, ErrorBanner, Field, Input, Aviso, Cargando } from '../components/ui'
import AvisoLicencia from '../components/AvisoLicencia'
import { useLicencia } from '../lib/useLicencia'
import { useMarca } from '../lib/useMarca'

export default function Login() {
  const { sesion, cargando, entrarDemo } = useAuth()
  // La licencia se pregunta acá y no adentro: si venció, no tiene sentido
  // dejar entrar para mostrar el mismo cartel en cada pantalla.
  const { licencia, vencida } = useLicencia()
  const marca = useMarca()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [enviando, setEnviando] = useState(false)

  if (cargando) return <Cargando texto="Verificando sesión…" />
  if (sesion) return <Navigate to="/" replace />

  async function entrar(e) {
    e.preventDefault()
    setError(null)
    setEnviando(true)
    const { error: err } = await supabase.auth.signInWithPassword({ email, password })
    setEnviando(false)
    if (err) {
      setError({
        message: err.message,
        hint:
          err.message === 'Invalid login credentials'
            ? 'Creá el usuario de prueba en Supabase → Authentication → Users → Add user.'
            : undefined,
      })
    }
  }

  return (
    <div className="grid h-full place-items-center p-6">
      <AvisoLicencia licencia={licencia} />

      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          {/* El logo del ISP si lo cargó; si no, su inicial. Nunca una marca
              ajena: el técnico que entra todos los días tiene que ver la suya. */}
          {marca.logo_b64 ? (
            <img src={marca.logo_b64} alt="" className="mx-auto mb-3 max-h-14" />
          ) : (
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-sky-600 text-lg font-bold text-white">
              {marca.nombre_sistema.trim().charAt(0).toUpperCase()}
            </div>
          )}
          <h1 className="text-lg font-semibold text-slate-100">{marca.nombre_sistema}</h1>
          {marca.lema && <p className="mt-1 text-xs text-slate-500">{marca.lema}</p>}
        </div>

        {modoDemo ? (
          <div className="mb-4 space-y-3">
            <Aviso>
              <b>Modo demo activo.</b> Se entra sin Supabase, con datos de ejemplo en memoria. Todo
              lo que crees se pierde al recargar y no se conecta a ningún equipo real.
            </Aviso>
            <Button variante="primario" icon={LogIn} className="w-full" onClick={entrarDemo}>
              Entrar en modo demo
            </Button>
          </div>
        ) : (
          !supabaseConfigurado && (
            <div className="mb-4">
              <Aviso tipo="alerta">
                Falta configurar <code className="text-amber-100">web/.env</code> con{' '}
                <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_ANON_KEY</code>. Copiá{' '}
                <code>.env.example</code> y completá los valores del proyecto de Supabase.
              </Aviso>
            </div>
          )
        )}

        <form
          onSubmit={entrar}
          className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/60 p-6"
        >
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="usuario@taller.local"
              autoComplete="username"
              required
            />
          </Field>

          <Field label="Contraseña">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>

          <ErrorBanner error={error} onCerrar={() => setError(null)} />

          <Button
            type="submit"
            variante="primario"
            icon={LogIn}
            cargando={enviando}
            className="w-full"
            disabled={!supabaseConfigurado || vencida}
          >
            Entrar
          </Button>

          {/* Se puede activar sin entrar: si la licencia venció, exigir sesión
              para renovarla sería cerrar la puerta con la llave adentro. */}
          {vencida && (
            <a
              href="/licencia"
              className="block pt-1 text-center text-xs text-sky-400 hover:text-sky-300"
            >
              Ya tengo el código de licencia — activarlo
            </a>
          )}
        </form>
      </div>
    </div>
  )
}
