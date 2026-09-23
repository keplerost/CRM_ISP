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
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10 sm:px-6">
      <AvisoLicencia licencia={licencia} />

      <div className="w-full max-w-sm">
        <div className="mb-7 text-center sm:mb-8">
          {/* El logo del ISP si lo cargó; si no, su inicial. Nunca una marca
              ajena: el técnico que entra todos los días tiene que ver la suya. */}
          {marca.logo_b64 ? (
            <>
              {/*
                Con logo, el nombre NO se repite debajo.
                Casi todos los logos de ISP ya llevan el nombre dentro —el de
                CNET dice "CNET S.A"—, así que escribirlo otra vez lo duplica y
                le roba tamaño al logo, que es lo que se reconoce de un vistazo.
                Sigue estando para quien usa lector de pantalla: va en el `alt`
                y en un h1 que no se ve pero se lee.

                La altura crece con la pantalla en vez de ser fija, y el ancho
                se topa al 72% para que un logo apaisado no toque los bordes en
                un teléfono.
              */}
              <img
                src={marca.logo_b64}
                alt={marca.nombre_sistema}
                className="mx-auto mb-4 h-auto max-h-24 w-auto max-w-[72%] object-contain sm:max-h-32"
              />
              <h1 className="sr-only">{marca.nombre_sistema}</h1>
            </>
          ) : (
            <>
              <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-sky-600 text-xl font-bold text-white sm:h-16 sm:w-16 sm:text-2xl">
                {marca.nombre_sistema.trim().charAt(0).toUpperCase()}
              </div>
              <h1 className="t-titulo text-xl font-bold text-slate-100">{marca.nombre_sistema}</h1>
            </>
          )}
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
          className="space-y-4 t-card p-6"
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
