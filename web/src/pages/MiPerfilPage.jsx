import { KeyRound, UserRound } from 'lucide-react'
import { useAuth, usePermisos } from '../lib/AuthContext'
import CambiarMiClave from '../components/CambiarMiClave'
import { Card } from '../components/ui'

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

export default function MiPerfilPage() {
  const { usuario } = useAuth()
  const { perfil } = usePermisos()

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
        <CambiarMiClave />
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
