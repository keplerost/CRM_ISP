import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { modoDemo, sesionDemo } from './demo'
import { personalApi } from './personal'
import { TODO, tienePermiso } from './permisos'
import { cargarParametros } from './instalaciones'
import { limpiarCache } from './cacheLocal'

const AuthContext = createContext({ sesion: null, usuario: null, cargando: true })

/* ── El perfil guardado, para poder arrancar sin señal ───────────────────── */

const CLAVE_PERFIL = 'legajo-cache'

/**
 * Guarda el legajo junto al `auth_id` de quien es.
 *
 * El `auth_id` no es decorativo: es lo que impide que en un teléfono que se
 * presta, el perfil del anterior le pinte la pantalla al siguiente.
 */
function guardarPerfil(fila, authId) {
  try {
    if (!fila || !authId) return
    localStorage.setItem(CLAVE_PERFIL, JSON.stringify({ authId, fila }))
  } catch {
    /* modo privado: se sigue sin caché, que es como estaba antes */
  }
}

function leerPerfil(authId) {
  try {
    if (!authId) return null
    const crudo = localStorage.getItem(CLAVE_PERFIL)
    if (!crudo) return null
    const { authId: de, fila } = JSON.parse(crudo)
    return de === authId ? fila : null
  } catch {
    return null
  }
}

const olvidarPerfil = () => {
  try {
    localStorage.removeItem(CLAVE_PERFIL)
  } catch {
    /* nada que hacer */
  }
}

export function AuthProvider({ children }) {
  const [sesion, setSesion] = useState(null)
  const [cargando, setCargando] = useState(true)
  // El legajo: quién es y qué puede. Es distinto de `usuario`, que es lo que
  // sabe Supabase Auth — ahí solo hay correo e id, y con eso no se decide nada.
  const [perfil, setPerfil] = useState(null)
  const [cargandoPerfil, setCargandoPerfil] = useState(true)
  // No es lo mismo "no tiene legajo" que "no se pudo averiguar". Sin esta
  // distinción, un corte de red se leía como lo primero y abría todo.
  const [errorPerfil, setErrorPerfil] = useState(null)

  useEffect(() => {
    // En modo demo no hay Supabase: se entra con una sesión falsa.
    if (modoDemo) {
      setSesion(sesionDemo)
      setCargando(false)
      return
    }

    supabase.auth
      .getSession()
      .then(({ data }) => setSesion(data.session ?? null))
      // Si Supabase no es alcanzable no podemos quedarnos colgados en "cargando":
      // sin sesión la app manda al login, que es donde se explica qué falta.
      .catch((err) => console.warn('No se pudo leer la sesión de Supabase:', err))
      .finally(() => setCargando(false))

    /**
     * La sesión se reemplaza solo si de verdad CAMBIÓ.
     *
     * ── El error que esto arregla ──
     *
     * Supabase renueva el token cuando la pestaña vuelve a tener el foco, y avisa
     * con un objeto de sesión nuevo aunque sea el mismo usuario. Antes eso
     * disparaba toda la cadena: sesión nueva → recargar el legajo →
     * `cargandoPerfil` en true → el Layout deja de dibujar la página y muestra
     * "Cargando" → cuando vuelve, la pantalla se monta de cero y pierde en qué
     * estaba.
     *
     * En la práctica: entrabas a un abonado, abrías otra pestaña del navegador
     * para cualquier cosa, volvías, y el sistema te había devuelto de Facturación
     * a Resumen. Nada fallaba y nada lo explicaba.
     *
     * Comparar el token corta la cadena en el origen: renovarlo no es cambiar de
     * usuario.
     */
    const { data: sub } = supabase.auth.onAuthStateChange((_evento, nuevaSesion) => {
      setSesion((anterior) => {
        const mismoUsuario = anterior?.user?.id === nuevaSesion?.user?.id
        const mismoToken = anterior?.access_token === nuevaSesion?.access_token

        // El token renovado sí se guarda —las llamadas al middleware lo
        // necesitan— pero sin cambiar la identidad del objeto para el resto de
        // la app: eso es lo que evitaba el remontaje.
        if (mismoUsuario && !mismoToken && anterior) {
          Object.assign(anterior, nuevaSesion)
          return anterior
        }

        return mismoUsuario && mismoToken ? anterior : nuevaSesion
      })
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const recargarPerfil = useCallback(async () => {
    if (!sesion) {
      setPerfil(null)
      // El error se limpia junto con el perfil: si no, un fallo de red viejo
      // sobreviviría al cambio de sesión y quien entre después arrancaría con
      // la pantalla de "no se pudo verificar" sin haber fallado nada.
      setErrorPerfil(null)
      setCargandoPerfil(false)
      return null
    }
    setCargandoPerfil(true)
    try {
      const fila = await personalApi.yo()
      setPerfil(fila)
      setErrorPerfil(null)
      guardarPerfil(fila, sesion.user?.id)
      return fila
    } catch (err) {
      console.warn('No se pudo leer el legajo del usuario:', err)

      /**
       * Plan B: el último perfil conocido.
       *
       * Sin esto, el técnico que abre la app en una zona rural ve una pantalla
       * en blanco: el sistema no puede decidir qué mostrarle porque no sabe
       * quién es. Pasó de verdad.
       *
       * El perfil guardado NO relaja ninguna seguridad. Decide qué OFRECE la
       * pantalla, nada más: cada consulta la sigue filtrando RLS del lado del
       * servidor. Alguien que edite el almacenamiento del navegador para darse
       * permisos vería menús de más y cero datos detrás de ellos.
       *
       * Se valida que sea de la sesión actual: en un teléfono compartido, el
       * perfil del anterior no puede pintarle la pantalla al siguiente.
       */
      const guardado = leerPerfil(sesion.user?.id)
      if (guardado) {
        setPerfil(guardado)
        setErrorPerfil(null)
        return guardado
      }

      setPerfil(null)
      // Se guarda el error en vez de tragárselo. Quien dibuja la pantalla tiene
      // que poder decir "no se pudo verificar quién sos" en vez de decidir a
      // ciegas — y decidir a ciegas, acá, significaba abrir todo.
      setErrorPerfil(err)
      return null
    } finally {
      setCargandoPerfil(false)
    }
  }, [sesion])

  useEffect(() => {
    let vivo = true
    recargarPerfil().then((fila) => {
      // Sellar el último acceso solo cuando hay legajo, y sin esperar: es un
      // dato de reporte, no algo que deba demorar la entrada a la app.
      if (vivo && fila) personalApi.marcarAcceso()
      // Los umbrales del semáforo, una vez por sesión. Va acá y no en cada
      // pantalla porque el técnico abre el asistente sin pasar por ninguna
      // otra: si dependiera de una pantalla previa, en campo mediría con los
      // valores de fábrica sin enterarse.
      if (vivo && fila) cargarParametros()
    })
    return () => {
      vivo = false
    }
  }, [recargarPerfil])

  const cerrarSesion = () => {
    // Se olvida el legajo guardado. Si no, el próximo que entre en ese teléfono
    // arrancaría con los permisos del anterior hasta que responda el servidor —
    // y sin señal, para siempre.
    olvidarPerfil()
    // Y los datos guardados: son del que se va. En un teléfono compartido,
    // el siguiente no puede ver la ruta del anterior.
    limpiarCache()
    return modoDemo ? setSesion(null) : supabase.auth.signOut()
  }
  const entrarDemo = () => setSesion(sesionDemo)

  /**
   * ¿Puede hacer esto?
   *
   * ── El error que tenía esto, y por qué ──
   *
   * Devolvía `true` mientras el legajo cargaba. El razonamiento era evitar que
   * el menú parpadeara y que a alguien con permiso le apareciera "no tenés
   * acceso" por medio segundo.
   *
   * La consecuencia se veía en la calle: al recargar la página, el vendedor
   * veía DURANTE UNOS SEGUNDOS el menú completo de administrador —Clientes,
   * Finanzas, OLT, Ajustes— y después desaparecía. Le enseñaba que esas
   * pantallas existen, le daba una ventana para hacer clic, y lo dejaba con la
   * sensación de que el sistema le esconde cosas.
   *
   * El error de fondo es tratar como binario algo que tiene tres estados. La
   * respuesta a "¿puede?" cuando todavía no se sabe quién es no es "sí": es
   * "esperá". Ahora `puede()` dice que no mientras no sabe, y quien pregunta
   * —el menú, el guardián de rutas— mira `cargandoPerfil` y muestra un
   * esqueleto en vez de decidir. Nadie parpadea y nadie ve de más.
   *
   * Sin legajo —una instalación vieja que todavía no corrió la migración 66— se
   * permite todo. Eso sí se mantiene: si no, actualizar dejaría a todos afuera
   * de golpe, y ahí el sistema queda inutilizable sin forma de arreglarlo desde
   * adentro.
   */
  const puede = useCallback(
    (clave) => {
      if (modoDemo) return true
      // Todavía no se sabe quién es. No se ofrece nada.
      if (cargandoPerfil) return false
      // Se intentó averiguar y falló. Tampoco se ofrece nada: la pantalla lo
      // dice y ofrece reintentar, que es mejor que adivinar para cualquier lado.
      if (errorPerfil) return false
      if (!perfil) return true
      return tienePermiso(perfil, clave)
    },
    [perfil, cargandoPerfil, errorPerfil],
  )

  return (
    <AuthContext.Provider
      value={{
        sesion,
        usuario: sesion?.user ?? null,
        perfil,
        rol: perfil?.rol ?? null,
        esSuperAdmin: perfil?.rol === 'super_admin' || perfil?.permisos?.includes(TODO) === true,
        puede,
        recargarPerfil,
        cargando,
        cargandoPerfil,
        errorPerfil,
        cerrarSesion,
        entrarDemo,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)

/**
 * Atajo para las pantallas que solo necesitan preguntar por un permiso.
 *
 * `cargandoPerfil` viene incluido y no es opcional mirarlo en el menú ni en el
 * guardián de rutas: sin él, `puede()` diciendo que no durante la carga se
 * confunde con "no tiene permiso", que es el parpadeo que se quiso evitar.
 */
export const usePermisos = () => {
  const { puede, perfil, rol, esSuperAdmin, cargandoPerfil, errorPerfil } =
    useContext(AuthContext)
  return { puede, perfil, rol, esSuperAdmin, cargandoPerfil, errorPerfil }
}
