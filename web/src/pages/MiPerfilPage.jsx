import { useState } from 'react'
import { KeyRound, ShieldCheck, UserRound } from 'lucide-react'
import { useAuth, usePermisos } from '../lib/AuthContext'
import { supabase } from '../lib/supabaseClient'
import { modoDemo } from '../lib/demo'
import { Aviso, Button, Card, ErrorBanner, Field, Input } from '../components/ui'

/**
 * Mi perfil: quién soy y mi contraseña.
 *
 * ── Por qué hace falta ──
 *
 * Al dar de alta a alguien, quien administra le pone una contraseña y se la
 * dicta. Hasta acá esa contraseña era la definitiva: no había forma de
 * cambiarla salvo pidiéndole al administrador que pusiera otra — que también
 * la vería.
 *
 * Una contraseña que conocen dos personas no identifica a ninguna. Y la
 * auditoría del sistema registra quién hizo cada cosa: si dos saben la clave de
 * finanzas, ese registro deja de servir justo cuando se lo necesita.
 *
 * ── Por qué se pide la contraseña actual ──
 *
 * Supabase no la exige para cambiarla: con la sesión abierta alcanza. Se pide
 * igual, y se comprueba entrando con ella.
 *
 * El motivo es concreto: una sesión abierta en una computadora compartida —la
 * de la ventanilla, el celular que quedó sobre el mostrador— le alcanzaría a
 * cualquiera para quedarse con la cuenta. Pedir la actual convierte ese
 * descuido en un intento fallido.
 */

const MINIMO = 8

export default function MiPerfilPage() {
  const { usuario } = useAuth()
  const { perfil } = usePermisos()

  const [actual, setActual] = useState('')
  const [nueva, setNueva] = useState('')
  const [repetida, setRepetida] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [listo, setListo] = useState(false)
  const [error, setError] = useState(null)

  const corta = nueva.length > 0 && nueva.length < MINIMO
  const distinta = repetida.length > 0 && nueva !== repetida
  const igualALaActual = nueva.length > 0 && nueva === actual
  const puedeGuardar =
    actual.length > 0 && nueva.length >= MINIMO && nueva === repetida && !igualALaActual

  async function cambiar(e) {
    e.preventDefault()
    if (!puedeGuardar || guardando) return

    setGuardando(true)
    setError(null)
    setListo(false)

    try {
      if (modoDemo) throw new Error('En modo demo no se cambian contraseñas.')

      /*
        Se comprueba la actual entrando con ella.
        Es el mismo usuario, así que la sesión que devuelve reemplaza a la que
        ya había sin efecto visible. Si la contraseña está mal, falla acá y no
        se toca nada.
      */
      const { error: errEntrar } = await supabase.auth.signInWithPassword({
        email: usuario?.email,
        password: actual,
      })
      if (errEntrar) throw new Error('La contraseña actual no es correcta.')

      const { error: errCambio } = await supabase.auth.updateUser({ password: nueva })
      if (errCambio) throw new Error(errCambio.message)

      setListo(true)
      setActual('')
      setNueva('')
      setRepetida('')
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  const nombre = [perfil?.nombre, perfil?.apellido].filter(Boolean).join(' ')

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card title="Mi perfil" icon={UserRound}>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Dato etiqueta="Nombre" valor={nombre || '—'} />
          <Dato etiqueta="Usuario" valor={perfil?.usuario ?? '—'} />
          <Dato etiqueta="Correo" valor={usuario?.email ?? '—'} />
          <Dato etiqueta="Rol" valor={perfil?.rol ?? '—'} />
        </dl>

        <p className="mt-4 text-xs leading-snug text-slate-500">
          El nombre, el correo y el rol los administra quien gestiona el personal. Si algo está
          mal, pedíselo — desde acá solo se cambia la contraseña.
        </p>
      </Card>

      <Card title="Cambiar mi contraseña" icon={KeyRound}>
        <form onSubmit={cambiar} className="space-y-4">
          <ErrorBanner error={error} onCerrar={() => setError(null)} />

          {listo && (
            <Aviso tipo="exito">
              Contraseña cambiada. La próxima vez que entres, usá la nueva.
            </Aviso>
          )}

          <Field
            label="Contraseña actual"
            hint="Se pide para confirmar que sos vos, no solo que la sesión está abierta."
          >
            <Input
              type="password"
              value={actual}
              onChange={(e) => setActual(e.target.value)}
              autoComplete="current-password"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Contraseña nueva" hint={`Mínimo ${MINIMO} caracteres.`}>
              <Input
                type="password"
                value={nueva}
                onChange={(e) => setNueva(e.target.value)}
                autoComplete="new-password"
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
          </div>

          {corta && (
            <Aviso tipo="alerta">La contraseña necesita al menos {MINIMO} caracteres.</Aviso>
          )}
          {distinta && <Aviso tipo="alerta">Las dos contraseñas no coinciden.</Aviso>}
          {igualALaActual && (
            <Aviso tipo="alerta">La nueva es igual a la actual. Poné una distinta.</Aviso>
          )}

          <Button
            type="submit"
            variante="primario"
            icon={ShieldCheck}
            cargando={guardando}
            disabled={!puedeGuardar}
          >
            Cambiar mi contraseña
          </Button>

          <p className="text-xs leading-snug text-slate-500">
            Nadie más va a poder verla, tampoco quien administra el sistema: solo se guarda su
            huella. Si la olvidás, se te asigna una nueva — no se recupera la anterior.
          </p>
        </form>
      </Card>
    </div>
  )
}

function Dato({ etiqueta, valor }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-slate-500">{etiqueta}</dt>
      <dd className="mt-0.5 text-sm text-slate-100">{valor}</dd>
    </div>
  )
}
