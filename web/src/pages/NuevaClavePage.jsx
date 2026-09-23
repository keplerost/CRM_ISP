import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShieldCheck } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { useMarca } from '../lib/useMarca'
import { Aviso, Button, ErrorBanner, Field, Input } from '../components/ui'

/**
 * Elegir una contraseña nueva desde el enlace del correo.
 *
 * ── Cómo se llega ──
 *
 * Desde el enlace que manda Supabase al pedir recuperación. Ese enlace trae un
 * token en la dirección; el cliente de Supabase lo detecta solo, abre una
 * sesión de recuperación y avisa con el evento `PASSWORD_RECOVERY`.
 *
 * Por eso esta pantalla no pide la contraseña actual: quien llegó acá ya probó
 * tener acceso al correo de la cuenta, que es justamente lo que no podía probar
 * cuando la olvidó.
 *
 * ── Por qué está fuera del marco del sistema ──
 *
 * La sesión de recuperación es una sesión como cualquier otra, así que quien
 * abre el enlace podría navegar a cualquier pantalla. Dejando esto afuera del
 * menú, el camino queda a la vista: poner la contraseña y seguir.
 *
 * ── Por qué se espera al evento ──
 *
 * El token se procesa de forma asíncrona al cargar la página. Si se dibujara el
 * formulario de una, alguien podría escribir su contraseña antes de que exista
 * la sesión, y el guardado fallaría con un error que no explica nada.
 */

export default function NuevaClavePage() {
  const marca = useMarca()
  const navegar = useNavigate()

  const [listaLaSesion, setListaLaSesion] = useState(false)
  const [nueva, setNueva] = useState('')
  const [repetida, setRepetida] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)
  const [hecho, setHecho] = useState(false)

  useEffect(() => {
    // Puede que la sesión ya esté abierta cuando esto monta —depende de qué
    // llegue primero— así que se mira además de escuchar.
    supabase.auth.getSession().then(({ data }) => {
      if (data?.session) setListaLaSesion(true)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((evento, sesion) => {
      if (evento === 'PASSWORD_RECOVERY' || sesion) setListaLaSesion(true)
    })

    return () => sub?.subscription?.unsubscribe()
  }, [])

  const corta = nueva.length > 0 && nueva.length < 8
  const distinta = repetida.length > 0 && nueva !== repetida
  const puedeGuardar = nueva.length >= 8 && nueva === repetida

  async function guardar(e) {
    e.preventDefault()
    if (!puedeGuardar || guardando) return

    setGuardando(true)
    setError(null)
    try {
      const { error: err } = await supabase.auth.updateUser({ password: nueva })
      if (err) throw new Error(err.message)
      setHecho(true)
      // Se entra directo: ya tiene sesión, y mandarlo a escribir la contraseña
      // que acaba de elegir sería pedirle que la pruebe sin motivo.
      setTimeout(() => navegar('/', { replace: true }), 1500)
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10 sm:px-6">
      <div className="w-full max-w-sm">
        <div className="mb-7 text-center">
          {marca.logo_b64 ? (
            <img
              src={marca.logo_b64}
              alt={marca.nombre_sistema}
              className="mx-auto mb-4 h-auto max-h-24 w-auto max-w-[72%] object-contain sm:max-h-32"
            />
          ) : (
            <h1 className="t-titulo text-xl font-bold text-slate-100">{marca.nombre_sistema}</h1>
          )}
          <p className="mt-1 text-sm text-slate-500">Elegí tu contraseña nueva</p>
        </div>

        {hecho ? (
          <div className="t-card p-6">
            <Aviso tipo="exito">Contraseña guardada. Entrando…</Aviso>
          </div>
        ) : !listaLaSesion ? (
          <div className="t-card p-6">
            <Aviso>
              Verificando el enlace… Si esto no avanza, el enlace puede haber vencido: pedí uno
              nuevo desde <b>¿Olvidaste tu contraseña?</b> en la pantalla de entrada.
            </Aviso>
          </div>
        ) : (
          <form onSubmit={guardar} className="space-y-4 t-card p-6">
            <ErrorBanner error={error} onCerrar={() => setError(null)} />

            <Field label="Contraseña nueva" hint="Mínimo 8 caracteres.">
              <Input
                type="password"
                value={nueva}
                onChange={(e) => setNueva(e.target.value)}
                autoComplete="new-password"
                autoFocus
              />
            </Field>

            <Field label="Repetila">
              <Input
                type="password"
                value={repetida}
                onChange={(e) => setRepetida(e.target.value)}
                autoComplete="new-password"
              />
            </Field>

            {corta && <Aviso tipo="alerta">Necesita al menos 8 caracteres.</Aviso>}
            {distinta && <Aviso tipo="alerta">Las dos contraseñas no coinciden.</Aviso>}

            <Button
              type="submit"
              variante="primario"
              icon={ShieldCheck}
              cargando={guardando}
              className="w-full"
              disabled={!puedeGuardar}
            >
              Guardar y entrar
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
