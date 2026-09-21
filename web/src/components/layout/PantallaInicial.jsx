import { Navigate } from 'react-router-dom'
import Dashboard from '../../pages/Dashboard'
import TableroTecnico from '../../pages/tecnico/InicioPage'
import TableroRecaudacion from '../../pages/recaudacion/InicioPage'
import SinPermiso from './SinPermiso'
import { usePermisos } from '../../lib/AuthContext'
import { puedeEntrar } from '../../lib/rutasPermisos'

/**
 * Qué se ve al entrar al sistema.
 *
 * ── Por qué no es siempre la misma pantalla ──
 *
 * El Dashboard es el estado de la red: OLTs, routers y ONUs con señal baja. Para
 * quien opera la red es la pantalla desde la que empieza el día. Para un
 * vendedor no dice absolutamente nada — y peor, es lo primero que ve al entrar,
 * así que el sistema abre dándole información que no puede usar y escondiendo la
 * que sí.
 *
 * Acá cada uno cae en la pantalla que le corresponde. No es una preferencia
 * configurable a propósito: se deduce de los permisos, así que un usuario nuevo
 * ya entra bien sin que nadie tenga que acordarse de configurarlo.
 *
 * ── El orden de la lista ──
 *
 * Es el orden en que alguien "vive" en el sistema, de más específico a más
 * general: quien vende abre el tablero comercial; quien atiende reclamos, los
 * tickets; quien cobra, los cobros. Gana el primero que pueda abrir.
 */
const DESTINOS = [
  // El técnico primero: es el único rol cuya pantalla propia está fuera del
  // layout de escritorio, así que si no se nombra acá cae en `/soporte` y
  // trabaja todo el día dentro del marco pensado para una computadora.
  '/campo',
  '/ventas/tablero',
  '/soporte',
  '/inventario/stock',
  '/clientes/instalaciones',
  '/pagos',
  '/facturacion',
  '/clientes',
  // Últimos, y no por importancia: son los que quedan cuando alguien no tiene
  // una pantalla propia. Bodega cae acá porque su módulo todavía no existe —
  // tiene los permisos de inventario y ninguna pantalla que los use.
  '/estadisticas',
  '/ajustes',
]

export default function PantallaInicial() {
  const { puede } = usePermisos()

  // Quien opera la red se queda en el Dashboard de siempre: sigue siendo la
  // pantalla de inicio y su URL no cambia, así que ningún enlace guardado se
  // rompe.
  if (puede('red.olts_ver')) return <Dashboard />

  /**
   * El técnico tiene tablero propio, y se dibuja ACÁ ADENTRO en vez de
   * mandarlo a `/campo`.
   *
   * La primera versión redirigía, y eso lo dejaba sin tablero en la web: entrar
   * desde una computadora lo sacaba del marco de escritorio y le abría la app
   * de celular a pantalla completa. Su menú, además, arrancaba en "Clientes"
   * porque el ítem "Dashboard" pedía un permiso de red que él no tiene.
   *
   * Es el mismo componente que usa la app de campo, no una copia: si divergen,
   * divergen los dos a la vez. Lo único que cambia es el marco — acá el menú
   * lateral, allá la barra de abajo.
   */
  /**
   * El punto de recaudación tiene su propia pantalla, y es la única que ve.
   *
   * Se reconoce por lo que NO puede: cobra pero no abre el listado de abonados.
   * Deducirlo de los permisos y no del nombre del rol es lo que hace que siga
   * funcionando el día que alguien arme un rol parecido con otro nombre.
   *
   * Va antes que el técnico porque son excluyentes y este es más específico: pide
   * cobrar Y no poder navegar la cartera.
   */
  if (puede('pagos.registrar') && !puede('clientes.ver') && !puede('facturacion.emitir')) {
    return <TableroRecaudacion />
  }

  if (puede('instalaciones.asignadas') || puede('soporte.asignados')) {
    /**
     * ── Salvo que esté en un teléfono ──
     *
     * El marco de escritorio no es responsive: el menú lateral ocupa 240 px
     * fijos y no se pliega solo. En un iPhone eso deja la app inutilizable —
     * hay que hacer zoom para tocar cualquier cosa.
     *
     * Así que en pantalla angosta se lo manda a `/campo`, que es la misma
     * información con el marco que corresponde. No es detección de dispositivo
     * —eso siempre se equivoca con alguien— sino del ancho, que es lo que de
     * verdad determina si el menú lateral entra.
     *
     * Y no queda encerrado: desde Perfil hay un enlace a la versión de
     * escritorio, para el caso de la tablet apaisada o el monitor de la
     * oficina.
     */
    // `?escritorio=1` es la salida. Sin ella, el enlace "Ver la versión de
    // escritorio" del Perfil rebotaría de vuelta acá y quedaría en bucle: el
    // técnico tocaría un botón que no hace nada.
    const forzado = new URLSearchParams(window.location.search).has('escritorio')

    if (!forzado && window.matchMedia('(max-width: 767px)').matches) {
      return <Navigate to="/campo" replace />
    }
    return <TableroTecnico />
  }

  const destino = DESTINOS.find((r) => puedeEntrar(puede, r))

  // Sin ningún destino, el usuario tiene sesión y ningún permiso. Mandarlo a
  // otra ruta lo dejaría rebotando; es mejor decírselo, que además nombra a
  // quién pedirle el acceso.
  return destino ? <Navigate to={destino} replace /> : <SinPermiso que="ninguna sección" />
}
