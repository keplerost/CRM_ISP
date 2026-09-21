import { supabase } from './supabaseClient'
import { modoDemo } from './demo'
import { ROLES, TODO, permisosDeRol } from './permisos'

/**
 * El acceso a los datos de personal y auditoría.
 *
 * Leer va directo a Supabase: RLS ya deja leer el legajo a quien tiene sesión,
 * y pasarlo por el middleware solo agregaría un salto. Escribir va por el
 * middleware, siempre — ahí vive la service_role key y ahí se verifica quién
 * puede crear a quién, que en el navegador se saltea con la consola abierta.
 */

const BASE = (import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/$/, '')

/**
 * En modo demo no hay Supabase ni middleware: se arma un plantel de mentira en
 * memoria. Sin esto la pantalla de personal sería la única del sistema que la
 * demo no puede mostrar, que es justo la que más se quiere mostrar al vender.
 */
const demo = {
  usuarios: ROLES.slice(0, 6).map((rol, i) => ({
    id: `demo-${rol.clave}`,
    nombre: ['Ana', 'Carlos', 'Lucía', 'Marco', 'Sofía', 'Diego'][i],
    apellido: ['Rojas', 'Pineda', 'Vera', 'Cedeño', 'Marín', 'Torres'][i],
    usuario: ['arojas', 'cpineda', 'lvera', 'mcedeno', 'smarin', 'dtorres'][i],
    email: `demo${i}@ejemplo.com`,
    celular: `09${80000000 + i * 111111}`,
    rol: rol.clave,
    activo: i !== 5,
    todas_las_zonas: i < 2,
    dos_factores: i < 2,
    permisos: permisosDeRol(rol.clave),
    ultimo_acceso: null,
    creado_en: new Date(2025, i, 3).toISOString(),
  })),
  auditoria: [],
}

async function pedir(metodo, ruta, cuerpo) {
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token

  const res = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  }).catch(() => {
    throw new Error(`No se puede contactar al middleware en ${BASE}. ¿Está corriendo?`)
  })

  const texto = await res.text()
  let json = null
  try {
    json = texto ? JSON.parse(texto) : null
  } catch {
    /* respuesta que no es JSON: se informa el texto crudo abajo */
  }
  if (!res.ok) {
    const err = new Error(json?.error || json?.mensaje || texto || `Error ${res.status}`)
    err.hint = json?.hint
    err.status = res.status
    throw err
  }
  return json
}

export const personalApi = {
  /** El plantel completo. Incluye a los inactivos: filtrarlos es de la pantalla. */
  async listar() {
    if (modoDemo) return demo.usuarios
    const { data, error } = await supabase
      .from('usuarios_sistema')
      .select('*')
      .order('activo', { ascending: false })
      .order('nombre')
    if (error) throw error
    return data ?? []
  },

  /**
   * El legajo de quien tiene la sesión abierta.
   *
   * ── Por qué distingue "no hay legajo" de "no se pudo leer" ──
   *
   * Antes ignoraba el `error` de la consulta y devolvía `null` en los dos
   * casos. Y `null` significa, para el resto del sistema, "instalación vieja sin
   * la migración 66" — que abre todos los permisos para no dejar a nadie afuera
   * al actualizar.
   *
   * O sea que un corte de red de un segundo le daba a un vendedor el sistema
   * completo hasta que recargara. Silencioso, y del lado peligroso.
   *
   * Ahora `null` es solo lo que de verdad es null: la consulta anduvo y no hay
   * fila. Si la consulta falla, esto revienta y quien llama decide — que no es
   * lo mismo que suponer.
   */
  async yo() {
    if (modoDemo) return { ...demo.usuarios[0], rol: 'super_admin', permisos: [TODO] }

    // `getSession` lee del almacenamiento local; `getUser` pregunta al servidor.
    // Sin señal, el segundo se cuelga y con él toda la app: hay que saber quién
    // entró para dibujar cualquier cosa.
    const { data: ses } = await supabase.auth.getSession()
    const authId = ses?.session?.user?.id
    if (!authId) return null

    /**
     * Sin red, ni se intenta.
     *
     * Es el primer paso de todo el arranque, así que cada segundo que espere
     * acá es un segundo de pantalla vacía. Cuando `navigator.onLine` dice que
     * no hay red, no se equivoca —el dispositivo no tiene ninguna interfaz— y
     * conviene fallar en el acto para que `AuthContext` use el perfil guardado.
     */
    if (!navigator.onLine) {
      const err = new Error('Sin conexión')
      err.sinRed = true
      throw err
    }

    /**
     * Y con red dudosa, cinco segundos.
     *
     * Sin este límite, en una zona de una raya la consulta no falla: espera. Y
     * mientras espera, `cargandoPerfil` sigue en true y la pantalla queda en
     * blanco — que es exactamente lo que le pasó al técnico en el campo.
     *
     * Fallar rápido es lo que permite pasar al plan B: el perfil guardado.
     */
    const corte = new AbortController()
    const reloj = setTimeout(() => corte.abort(), 5000)
    try {
      const { data: fila, error } = await supabase
        .from('usuarios_sistema')
        .select('*')
        .eq('auth_id', authId)
        .abortSignal(corte.signal)
        .maybeSingle()
      if (error) throw error
      return fila ?? null
    } finally {
      clearTimeout(reloj)
    }
  },

  crear: (usuario) => (modoDemo ? Promise.resolve({ usuario }) : pedir('POST', '/api/personal', usuario)),

  editar: (id, cambios) =>
    modoDemo ? Promise.resolve({ usuario: cambios }) : pedir('PATCH', `/api/personal/${id}`, cambios),

  eliminar: (id) => (modoDemo ? Promise.resolve({ ok: true }) : pedir('DELETE', `/api/personal/${id}`)),

  cambiarClave: (id, clave) =>
    modoDemo ? Promise.resolve({ ok: true }) : pedir('POST', `/api/personal/${id}/clave`, { clave }),

  /** Sella el último acceso al entrar. Que falle no puede impedir usar la app. */
  marcarAcceso: () =>
    modoDemo ? Promise.resolve({ ok: true }) : pedir('POST', '/api/personal/acceso').catch(() => null),

  /**
   * La auditoría. `usuarioId` la acota al historial de una persona, que es como
   * se la consulta el 90% de las veces: alguien pregunta qué hizo fulano.
   */
  async auditoria({ usuarioId, accion, desde, limite = 200 } = {}) {
    if (modoDemo) return demo.auditoria
    let q = supabase
      .from('auditoria_sistema')
      .select('*')
      .order('creado_en', { ascending: false })
      .limit(limite)
    if (usuarioId) q = q.eq('usuario_id', usuarioId)
    if (accion) q = q.like('accion', `${accion}%`)
    if (desde) q = q.gte('creado_en', desde)
    const { data, error } = await q
    if (error) throw error
    return data ?? []
  },

  /**
   * Deja un hecho registrado desde cualquier pantalla.
   *
   * No lanza: una acción que ya sucedió no puede fallar porque no se pudo
   * escribir su renglón. Lo que sí hace es avisar por consola.
   */
  registrar: (accion, descripcion, extra = {}) =>
    modoDemo
      ? Promise.resolve()
      : pedir('POST', '/api/personal/auditoria', { accion, descripcion, ...extra }).catch((err) =>
          console.warn('[auditoria] no se registró:', err.message),
        ),
}
