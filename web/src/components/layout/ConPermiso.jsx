import { usePermisos } from '../../lib/AuthContext'
import SinPermiso from './SinPermiso'
import { Cargando } from '../ui'

/**
 * Envuelve algo que solo debe verse con cierto permiso.
 *
 * Casi todas las pantallas ya quedan cubiertas por el Layout, que consulta el
 * mapa de rutas. Esto es para las excepciones —lo que vive fuera del marco— y
 * para trozos sueltos dentro de una pantalla: una pestaña de facturación en la
 * ficha del cliente, que el técnico no tiene por qué ver aunque el cliente sí.
 *
 * `permiso` acepta un arreglo, y ahí alcanza con tener uno.
 * `envezDe` reemplaza la pantalla de "no tenés acceso" por lo que se pase —o
 * por nada, cuando lo correcto es que el trozo simplemente no esté.
 */
export default function ConPermiso({ permiso, children, envezDe, que }) {
  const { puede, perfil, cargandoPerfil } = usePermisos()

  // Mientras no se sabe quién entró no se decide — ni se muestra el contenido
  // ni el cartel de "no tenés acceso". `puede()` dice que no durante la carga, y
  // sin esta línea eso se leería como una negativa: a quien sí tiene el permiso
  // le aparecería el cartel por medio segundo en cada recarga.
  //
  // Devolvía `null`, y eso dejaba la PANTALLA EN BLANCO cuando la carga no
  // terminaba nunca — que es lo que pasaba sin señal, porque la consulta del
  // legajo no tenía tiempo límite. Un rectángulo que late dice "esperá"; una
  // pantalla vacía dice "se rompió".
  // Y solo la PRIMERA vez: con un perfil ya cargado, una recarga en segundo
  // plano —el token que Supabase renueva al volver a la pestaña— no puede
  // reemplazar el contenido por un cartel de espera. Hacerlo desmonta lo que
  // haya adentro y le borra el estado: un formulario a medio llenar, la sección
  // en la que estaba parado.
  if (cargandoPerfil && !perfil) {
    return envezDe !== undefined ? envezDe : <Cargando />
  }

  const claves = Array.isArray(permiso) ? permiso : [permiso]
  const habilitado = !permiso || claves.some((p) => puede(p))

  // El fragmento no es adorno: `children` puede ser varios elementos —dos
  // botones de una fila, por ejemplo— y devolverlos como arreglo suelto hace
  // que React pida claves para algo que nunca se reordena.
  if (habilitado) return <>{children}</>
  return envezDe !== undefined ? envezDe : <SinPermiso que={que} />
}
