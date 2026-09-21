const BASE = (import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/$/, '')

/**
 * El cliente del portal del abonado.
 *
 * Aparte del `api` del personal a propósito: aquel manda el token de Supabase,
 * este manda el del abonado. Si compartieran el cliente, un descuido haría que
 * el token del personal viaje al portal o al revés.
 *
 * El token vive en localStorage y no en memoria: el abonado entra desde el
 * celular, cierra la aplicación y vuelve la semana siguiente. Pedirle el código
 * cada vez lo haría dejar de entrar.
 */

const LLAVE = 'portal_token'

export const tokenGuardado = () => localStorage.getItem(LLAVE)
export const guardarToken = (t) => localStorage.setItem(LLAVE, t)
export const olvidarToken = () => localStorage.removeItem(LLAVE)

export class PortalError extends Error {
  constructor(mensaje, { status, hint, sesion_vencida } = {}) {
    super(mensaje)
    this.status = status
    this.hint = hint
    this.sesionVencida = sesion_vencida
  }
}

async function pedir(metodo, ruta, cuerpo) {
  const token = tokenGuardado()

  let res
  try {
    res = await fetch(`${BASE}/api/portal${ruta}`, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    })
  } catch {
    throw new PortalError('No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.')
  }

  const texto = await res.text()
  let json = null
  try {
    json = texto ? JSON.parse(texto) : null
  } catch {
    /* respuesta sin JSON: se usa el status */
  }

  if (!res.ok) {
    // La sesión vencida se limpia sola. Dejar un token muerto guardado haría
    // que cada pantalla falle sola hasta que alguien borre los datos del
    // navegador — y nadie sabe hacer eso.
    if (res.status === 401) olvidarToken()

    throw new PortalError(json?.error || 'Algo salió mal. Intentá de nuevo en un momento.', {
      status: res.status,
      hint: json?.hint,
      sesion_vencida: json?.sesion_vencida,
    })
  }

  return json
}

export const portalApi = {
  pedirCodigo: (identificacion) => pedir('POST', '/codigo', { identificacion }),
  entrar: (identificacion, codigo) => pedir('POST', '/entrar', { identificacion, codigo }),
  entrarConClave: (identificacion, clave) => pedir('POST', '/entrar-clave', { identificacion, clave }),
  cambiarClave: (actual, nueva) => pedir('POST', '/clave', { actual, nueva }),
  salir: () => pedir('POST', '/salir'),

  miCuenta: () => pedir('GET', '/mi-cuenta'),
  facturas: () => pedir('GET', '/facturas'),
  consumo: () => pedir('GET', '/consumo'),
  tickets: () => pedir('GET', '/tickets'),
  abrirTicket: (tipo, descripcion) => pedir('POST', '/tickets', { tipo, descripcion }),
  guardarContacto: (datos) => pedir('PUT', '/contacto', datos),
  solicitudWifi: () => pedir('GET', '/wifi'),
  cambiarWifi: (datos) => pedir('POST', '/wifi', datos),
}
