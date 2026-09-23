import { supabase } from './supabaseClient'
import { modoDemo, demoApi } from './demo'

/**
 * Cliente del API Middleware (todo lo que toca la red: OLTs y MikroTik).
 *
 * Supabase se consulta directo desde el navegador (RLS protege los datos), pero
 * SSH y la REST API de RouterOS no son alcanzables desde el browser — eso pasa
 * siempre por acá.
 */

const BASE = (import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/$/, '')

/** Error del middleware que conserva la pista de qué hacer. */
export class ApiError extends Error {
  constructor(message, { status, hint, detalle, ...extra } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.hint = hint
    this.detalle = detalle
    // Lo que el middleware haya adjuntado al error: la lista de OLTs para poder
    // elegir una, la foto de una ONT que quedó a medias. Descartarlo hacía
    // falsos los mensajes que dicen "está en la respuesta".
    Object.assign(this, extra)
  }
}

async function request(metodo, ruta, body) {
  if (modoDemo) {
    const respuesta = await demoApi(metodo, ruta, body)
    if (respuesta === undefined) {
      throw new ApiError(`El modo demo no simula ${metodo} ${ruta}`, {
        hint: 'Configurá Supabase y el middleware para usar esta función de verdad.',
      })
    }
    return respuesta
  }

  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token

  let res
  try {
    res = await fetch(`${BASE}${ruta}`, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(`No se puede contactar al middleware en ${BASE}`, {
      hint: 'Verificá que esté corriendo (npm run dev en middleware/) y que VITE_API_URL apunte ahí.',
    })
  }

  const texto = await res.text()
  let json = null
  try {
    json = texto ? JSON.parse(texto) : null
  } catch {
    throw new ApiError('El middleware devolvió una respuesta que no es JSON', {
      status: res.status,
      detalle: texto.slice(0, 200),
    })
  }

  if (!res.ok) {
    const { error: _e, ...resto } = json ?? {}
    // `mensaje` además de `error`: algunas rutas contestan un estado del trabajo
    // —"la OLT no ve la ONT"— con `res.status(409).json({ mensaje })` en vez de
    // lanzar. Sin este segundo intento, al técnico le llegaba "Error 409" y el
    // texto que explicaba qué hacer se perdía en el camino.
    throw new ApiError(json?.error || json?.mensaje || `Error ${res.status}`, {
      ...resto,
      status: res.status,
    })
  }

  return json
}

/**
 * Descarga binaria — el RIDE en PDF.
 *
 * No se puede resolver con un `<a href>`: el middleware exige el token de
 * Supabase en la cabecera y un enlace común no la manda. Se trae como blob y la
 * página decide si lo abre o lo baja.
 */
async function archivo(ruta, body) {
  if (modoDemo) {
    throw new ApiError('El modo demo no genera archivos', {
      hint: 'Configurá Supabase y el middleware para descargar el RIDE.',
    })
  }

  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token

  let res
  try {
    // Con cuerpo va por POST: la plantilla del padrón se arma a partir de lo que
    // se acaba de elegir, y eso no entra cómodo en una URL.
    res = await fetch(`${BASE}${ruta}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  } catch {
    throw new ApiError(`No se puede contactar al middleware en ${BASE}`, {
      hint: 'Verificá que esté corriendo (npm run dev en middleware/).',
    })
  }

  if (!res.ok) {
    // Los errores sí vienen en JSON: el PDF solo sale cuando todo salió bien.
    let json = null
    try {
      json = JSON.parse(await res.text())
    } catch {
      // Se queda con el mensaje genérico de abajo.
    }
    throw new ApiError(json?.error || `Error ${res.status}`, {
      status: res.status,
      hint: json?.hint,
      detalle: json?.detalle,
    })
  }

  return res.blob()
}

const get = (ruta) => request('GET', ruta)
const post = (ruta, body) => request('POST', ruta, body)
const del = (ruta) => request('DELETE', ruta)
const put = (ruta, body) => request('PUT', ruta, body)

const qs = (params) => {
  const limpio = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  return limpio.length ? `?${new URLSearchParams(limpio)}` : ''
}

export const api = {
  health: () => get('/api/health'),

  /**
   * La licencia de esta instalación.
   *
   * Se puede consultar y activar sin sesión: el que quedó bloqueado tiene que
   * poder pegar el código nuevo sin poder entrar primero.
   */
  licencia: {
    estado: () => get('/api/licencia/estado'),
    activar: (token) => post('/api/licencia/activar', { token }),
    renovar: () => post('/api/licencia/renovar'),
  },

  /** Traer la base de abonados de otro sistema. Siempre revisar antes de importar. */
  migracion: {
    opciones: () => get('/api/migracion/abonados/opciones'),
    // La plantilla lleva adentro el router al que pertenecen estos abonados.
    plantilla: (datos) => archivo('/api/migracion/abonados/plantilla', datos),
    revisarAbonados: (datos) => post('/api/migracion/abonados/revisar', datos),
    importarAbonados: (datos) => post('/api/migracion/abonados/importar', datos),
  },

  /**
   * Tipos de ONU — el catálogo de modelos.
   *
   * Fuera de /api/olt/:id a propósito: un modelo es el mismo en todas las OLTs.
   */
  tiposOnu: {
    listar: () => get('/api/tipos-onu'),
    crear: (datos) => post('/api/tipos-onu', datos),
    editar: (id, datos) => put(`/api/tipos-onu/${id}`, datos),
    borrar: (id, forzar) => del(`/api/tipos-onu/${id}${qs({ forzar: forzar ? 'true' : '' })}`),
    importar: (datos) => post('/api/tipos-onu/importar', datos),
  },

  /** Cifra una contraseña de equipo antes de guardarla en Supabase. */
  cifrar: (password) => post('/api/crypto/encrypt', { password }),

  /**
   * TR-069 de TODAS las OLTs.
   *
   * Fuera de /api/olt/:id a propósito, igual que los tipos de ONU: un ACS sirve
   * al padrón entero. Definir el mismo perfil equipo por equipo es cómo se llega
   * a que una OLT apunte a una dirección y otra a una que quedó vieja.
   */
  tr069: {
    perfiles: () => get('/api/tr069/perfiles'),
    crearPerfil: (datos) => post('/api/tr069/perfiles', datos),
    estado: () => get('/api/tr069/estado'),
    ont: ({ oltId, frame, slot, puerto, onuId }) =>
      get(`/api/tr069/ont${qs({ oltId, frame, slot, puerto, onuId })}`),
    asignar: (datos) => post('/api/tr069/ont', datos),
  },

  mikrotik: {
    test: (id) => get(`/api/mikrotik/${id}/test`),

    pools: (id) => get(`/api/mikrotik/${id}/pools`),
    crearPool: (id, datos) => post(`/api/mikrotik/${id}/pools`, datos),
    borrarPool: (id, poolId) => del(`/api/mikrotik/${id}/pools/${encodeURIComponent(poolId)}`),

    interfaces: (id) => get(`/api/mikrotik/${id}/interfaces`),
    addresses: (id) => get(`/api/mikrotik/${id}/addresses`),
    crearAddress: (id, datos) => post(`/api/mikrotik/${id}/addresses`, datos),
    borrarAddress: (id, addrId) =>
      del(`/api/mikrotik/${id}/addresses/${encodeURIComponent(addrId)}`),

    bloqueos: (id) => get(`/api/mikrotik/${id}/bloqueos`),
    bloquear: (id, datos) => post(`/api/mikrotik/${id}/bloqueos`, datos),
    desbloquear: (id, entradaId) =>
      del(`/api/mikrotik/${id}/bloqueos/${encodeURIComponent(entradaId)}`),
    redireccionPago: (id, datos) => post(`/api/mikrotik/${id}/redireccion-pago`, datos),

    filter: (id) => get(`/api/mikrotik/${id}/firewall/filter`),
    nat: (id) => get(`/api/mikrotik/${id}/firewall/nat`),

    queues: (id) => get(`/api/mikrotik/${id}/queues`),
    crearQueue: (id, datos) => post(`/api/mikrotik/${id}/queues`, datos),

    /** Los perfiles PPP del equipo: en PPPoE son los que aplican la velocidad. */
    perfilesPpp: (id) => get(`/api/mikrotik/${id}/ppp-profiles`),

    // Clientes: importar del router, exportar hacia él, sincronizar cortes
    // Deja el router igual a lo que dice el sistema: secrets que faltan, IPs
    // que no coinciden, y morosos que ya pagaron y siguen bloqueados.
    // IPv6: revisar qué falta, dejarlo puesto, y apagar su uso sin tocar el equipo.
    revisarIpv6: (id) => get(`/api/mikrotik/${id}/ipv6`),
    prepararIpv6: (id, datos) => post(`/api/mikrotik/${id}/ipv6`, datos),
    apagarIpv6: (id) => del(`/api/mikrotik/${id}/ipv6`),

    // Dejar un equipo nuevo listo para operar. `revisar` no toca nada.
    revisarConfiguracion: (id, red) =>
      get(`/api/mikrotik/${id}/configurar${red ? `?red=${encodeURIComponent(red)}` : ''}`),
    configurar: (id, datos) => post(`/api/mikrotik/${id}/configurar`, datos),
    revisarReparacion: (id) => get(`/api/mikrotik/${id}/reparar`),
    reparar: (id, datos) => post(`/api/mikrotik/${id}/reparar`, datos),

    escaneo: (id, { lista, fuentes } = {}) =>
      get(`/api/mikrotik/${id}/escaneo${qs({ lista, fuentes: fuentes?.join(',') })}`),
    importar: (id, clientes) => post(`/api/mikrotik/${id}/importar`, { clientes }),
    exportar: (id, datos) => post(`/api/mikrotik/${id}/exportar`, datos),
    migrarLista: (id, datos) => post(`/api/mikrotik/${id}/migrar-lista`, datos),
    sincronizarMorosos: (id, datos) => post(`/api/mikrotik/${id}/sincronizar-morosos`, datos),
  },

  /**
   * Herramientas técnicas sobre un abonado.
   *
   * Reciben el id del CLIENTE, no el del router: el objetivo lo deduce el
   * middleware leyendo su ficha. Mandar la IP desde acá haría que un id
   * equivocado le reinicie el equipo al vecino.
   */
  herramientas: {
    ping: (clientId, datos = {}) => post(`/api/herramientas/${clientId}/ping`, datos),
    traceroute: (clientId, datos = {}) => post(`/api/herramientas/${clientId}/traceroute`, datos),
    senal: (clientId) => post(`/api/herramientas/${clientId}/senal`, {}),
    testVelocidad: (clientId, datos = {}) =>
      post(`/api/herramientas/${clientId}/test-velocidad`, datos),

    reiniciar: (clientId) => post(`/api/herramientas/${clientId}/reiniciar`, { confirmar: true }),
    kickPpp: (clientId) => post(`/api/herramientas/${clientId}/kick-ppp`, {}),
    wifi: (clientId, datos) => post(`/api/herramientas/${clientId}/wifi`, datos),
    dispositivos: (clientId) => get(`/api/herramientas/${clientId}/dispositivos`),
  },

  /**
   * Alta autónoma del técnico en campo.
   *
   * Reciben el id de la INSTALACIÓN, no el del equipo: a qué OLT preguntarle y
   * en qué router escribir sale de la orden de trabajo. Mandarlo desde el
   * celular haría que un alta con el nodo mal elegido escriba configuración
   * sobre los abonados de otro sector.
   */
  instalaciones: {
    /** Le pregunta a la OLT o a la radio cómo llegó la señal. */
    /**
     * Le pregunta al equipo cómo llegó la señal.
     *
     * `donde` lleva la OLT cuando la orden no la trae —el técnico la elige en el
     * momento— y queda guardada para no volver a preguntarla.
     */
    lectura: (id, donde = {}) => post(`/api/instalaciones/${id}/lectura`, donde),

    /**
     * Qué segmento de red le toca a la instalación según dónde apareció la ONT.
     * Sale de la cadena puerto PON → VLAN → subred, sin preguntarle al técnico.
     */
    segmentoSugerido: (id) => get(`/api/instalaciones/${id}/segmento-sugerido`),

    /**
     * Autoriza la ONT desde el campo, con los datos de la orden de trabajo.
     * Es lo único que le falta al técnico cuando la fibra ya llegó.
     */
    autorizar: (id, datos) => post(`/api/instalaciones/${id}/autorizar`, datos),

    /** La siguiente dirección libre del pool o del segmento del nodo. */
    // Todos los segmentos entre los que el técnico puede elegir, con su torre.
    segmentos: (id) => get(`/api/instalaciones/${id}/segmentos`),

    ipLibre: (id, { pool, red, router_id } = {}) =>
      get(`/api/instalaciones/${id}/ip-libre${qs({ pool, red, router_id })}`),

    /** Deja al abonado configurado en el router: secret PPPoE o reserva DHCP. */
    aprovisionar: (id, datos) => post(`/api/instalaciones/${id}/aprovisionar`, datos),

    /** Ping y test de ancho de banda contra el equipo recién instalado. */
    pruebas: (id, datos = {}) => post(`/api/instalaciones/${id}/pruebas`, datos),
  },

  /**
   * Cambio de ONT: el paso de la OLT.
   *
   * Va solo el id del reemplazo. El puerto, el perfil y la VLAN los lee el
   * servidor de la ONU anterior — el técnico no elige ninguno, que es lo que
   * separa "cambiar un equipo" de "configurar la OLT desde el celular".
   */
  reemplazos: {
    aprovisionar: (id) => post(`/api/reemplazos/${id}/aprovisionar`, {}),
  },

  /**
   * Aplicar un plan a los abonados que ya lo tienen.
   *
   * Cambiar la velocidad en la base no le cambia nada a nadie: eso vive en los
   * equipos, y llega distinto según cómo se conecte cada abonado.
   */
  planes: {
    /** A cuántos afectaría y en qué equipos. No toca nada. */
    impacto: (id) => get(`/api/planes/${id}/impacto`),

    /** Reescribe la Simple Queue de cada abonado del plan. */
    sincronizar: (id) => post(`/api/planes/${id}/sincronizar`, {}),

    /** En qué routers está disponible el plan y cómo quedó su perfil. */
    routers: (id) => get(`/api/planes/${id}/routers`),

    /**
     * Crea o corrige el perfil PPP del plan en los routers asignados.
     *
     * El perfil queda SIN rate-limit a propósito: en fibra el caudal lo pone la
     * traffic table de la OLT.
     */
    aprovisionar: (id) => post(`/api/planes/${id}/aprovisionar`, {}),
  },

  /**
   * IPAM: qué direcciones existen y quién ocupa cada una.
   *
   * `sincronizar` trae lo que el router tiene CONFIGURADO; `escanear` averigua
   * qué hay CONECTADO. La diferencia entre las dos listas es la auditoría.
   */
  ipam: {
    // Deja el pool del router igual al rango declarado en el bloque. El rango
    // vive en los dos lados y el que manda es el router.
    sincronizarPool: (subredId) => post(`/api/ipam/subredes/${subredId}/sincronizar-pool`),
    // Reconstruye los bloques leyendo los pools del router. Es lo que evita
    // cargar a mano la red de un ISP que llega con todo armado.
    importarBloques: (routerId, datos) =>
      post(`/api/ipam/routers/${routerId}/importar-bloques`, datos),
    sincronizar: (subredId) => post(`/api/ipam/subredes/${subredId}/sincronizar`, {}),
    escanear: (subredId, datos = {}) => post(`/api/ipam/subredes/${subredId}/escanear`, datos),
    libre: (subredId) => get(`/api/ipam/subredes/${subredId}/libre`),

    /**
     * ¿Está libre esta IP?
     *
     * Contesta con el NOMBRE de quien la tiene, no con un sí o un no: "está
     * ocupada" obliga a ir a buscar por quién, y el que está dando de alta a un
     * abonado con el técnico esperando en el poste no va a ir a buscar nada.
     */
    verificarIp: (ip, { router, excluir } = {}) =>
      get(`/api/ipam/ips/${encodeURIComponent(ip)}${qs({ router, excluir })}`),

    /**
     * Comparar las IPs del sistema con las del router.
     *
     * Se corre después de migrar un padrón: el sistema cree saber qué IP tiene
     * cada abonado —la que decía el archivo— y el router sabe otra cosa.
     */
    conciliarIps: (routerId) => get(`/api/ipam/routers/${routerId}/conciliar-ips`),

    /**
     * Hacerse cargo del corte que ya existe en el router.
     *
     * Va en dos pasos siempre: `planCorte` mira y no toca nada, `adoptarCorte`
     * ejecuta. Lo que está del otro lado es el firewall de un equipo con
     * abonados conectados.
     */
    planCorte: (routerId) => get(`/api/ipam/routers/${routerId}/corte`),
    adoptarCorte: (routerId, datos) => post(`/api/ipam/routers/${routerId}/corte`, datos),

    /** Estado de cada CCR con su carga de CPU y memoria. */
    saludRouters: () => get('/api/ipam/routers/salud'),
  },

  /** Monitoreo de la red en vivo. */
  nms: {
    estado: () => get('/api/nms/estado'),
    sondear: () => post('/api/nms/sondear', {}),
    /** Prueba suelta de un nodo: no registra nada en el historial. */
    probar: (nodoId) => post(`/api/nms/nodos/${nodoId}/probar`, {}),
  },

  /** Mensajes al abonado. El envío necesita credenciales que no van al navegador. */
  /** El portal del abonado, administrado desde la oficina. */
  /**
   * Las plantillas aprobadas de WhatsApp.
   *
   * `revisar` contesta si Meta la va a rechazar, sin guardarla: es lo que evita
   * la vuelta entera de pegar el texto en el Administrador de WhatsApp y esperar.
   */
  plantillasWhatsapp: {
    listar: () => get('/api/plantillas-whatsapp'),
    revisar: (cuerpo_meta, variables) =>
      post('/api/plantillas-whatsapp/revisar', { cuerpo_meta, variables }),
    guardar: (id, datos) => put(`/api/plantillas-whatsapp/${id}`, datos),
  },

  /**
   * Cortes masivos y mantenimientos programados.
   *
   * `previsualizar` es la llamada importante: dice a cuántos abonados alcanzaría
   * un alcance ANTES de que exista algo que se pueda abrir de un clic.
   */
  incidencias: {
    listar: (estado = 'abierta') => get(`/api/incidencias${qs({ estado })}`),
    previsualizar: (alcance) => post('/api/incidencias/previsualizar', alcance),
    crear: (datos) => post('/api/incidencias', datos),
    abrir: (id) => post(`/api/incidencias/${id}/abrir`, {}),
    resolver: (id) => post(`/api/incidencias/${id}/resolver`, {}),
    cancelar: (id, motivo) => post(`/api/incidencias/${id}/cancelar`, { motivo }),
    avisos: (id) => get(`/api/incidencias/${id}/avisos`),
    enviarPendientes: (lote = 40) => post('/api/incidencias/enviar-pendientes', { lote }),
  },

  /**
   * Las llaves con las que entran los sistemas externos, y la bandeja de pagos
   * que reportaron.
   *
   * Ojo con `crear`: la respuesta trae la llave EN CLARO y es la única vez. No
   * se guarda en ningún lado — quien la reciba tiene que copiarla ahí mismo.
   */
  integraciones: {
    llaves: () => get('/api/integracion-admin/llaves'),
    crear: (datos) => post('/api/integracion-admin/llaves', datos),
    /**
     * Genera una llave copiando los permisos de un usuario del personal.
     *
     * Es una FOTO: cambiarle después los permisos a esa persona no cambia
     * los de la llave, y desactivar su usuario no la apaga.
     */
    crearDesdeUsuario: (datos) => post('/api/integracion-admin/llaves/desde-usuario', datos),
    guardar: (id, datos) => put(`/api/integracion-admin/llaves/${id}`, datos),
    revocar: (id, motivo = null) =>
      request('DELETE', `/api/integracion-admin/llaves/${id}`, { motivo }),
    llamadas: (filtros = {}) => get(`/api/integracion-admin/llamadas${qs(filtros)}`),

    reportados: (estado = 'pendiente') =>
      get(`/api/integracion-admin/pagos-reportados${qs({ estado })}`),
    confirmar: (id, datos = {}) =>
      post(`/api/integracion-admin/pagos-reportados/${id}/confirmar`, datos),
    rechazar: (id, motivo) =>
      post(`/api/integracion-admin/pagos-reportados/${id}/rechazar`, { motivo }),
  },

  portalAdmin: {
    resumen: () => get('/api/portal-admin/resumen'),
    buscar: (q) => get(`/api/portal-admin/buscar?q=${encodeURIComponent(q)}`),
    resetear: (id) => post(`/api/portal-admin/abonados/${id}/resetear`),
    // Genera una clave y la deja legible en la ficha, para dictarla por teléfono.
    fijarClave: (id) => post(`/api/portal-admin/abonados/${id}/clave`),
    cerrarSesiones: (id) => post(`/api/portal-admin/abonados/${id}/cerrar-sesiones`),
    solicitudes: (estado = 'pendiente') => get(`/api/portal-admin/solicitudes?estado=${estado}`),
    marcarSolicitud: (id, estado) => post(`/api/portal-admin/solicitudes/${id}`, { estado }),
  },

  /** La marca del sistema. Se lee sin sesión: el login la necesita. */
  general: {
    config: () => get('/api/general'),
    guardar: (datos) => put('/api/general', datos),
  },

  /** Los automatismos. Guardar reprograma: no hace falta reiniciar. */
  tareas: {
    estado: () => get('/api/tareas'),
    guardar: (datos) => put('/api/tareas', datos),

    /**
     * Los avisos de pago, antes de mandarlos.
     *
     * Un aviso mal redactado sale para todos los abonados a la vez y no se puede
     * desenviar. Estas dos contestan "¿a quién le llegaría hoy?" sin escribirle
     * a nadie.
     */
    simularAvisosPago: () => post('/api/tareas/avisos-pago/simular'),
    avisosPagoPendientes: () => get('/api/tareas/avisos-pago/pendientes'),

    /** El corte por mora, sin tocar el router. Es la que deja gente sin internet. */
    simularMora: () => post('/api/tareas/mora/simular'),
  },

  /**
   * Las actas firmadas, en PDF.
   *
   * Vienen como blob y no como enlace: la ruta exige el token de la sesión, y
   * un `<a href>` no lo manda. Es el mismo camino que el RIDE y el recibo.
   */
  actas: {
    retiro: (id) => archivo(`/api/actas/retiro/${id}`),
    entrega: (id) => archivo(`/api/actas/entrega/${id}`),
  },

  /**
   * Los documentos que el ISP escribe en el editor de plantillas.
   *
   * `?texto=1` devuelve el texto ya reemplazado en vez del PDF: es la vista
   * previa del editor, y va por `get` porque es JSON, no un archivo.
   */
  documentos: {
    /**
     * `contratoId` sirve para reimprimir uno viejo: sale con las condiciones
     * que tenía cuando se firmó, no con las de hoy. Sin él se imprime el
     * vigente.
     */
    contrato: (clienteId, { contratoId = null, descargar = false } = {}) =>
      archivo(`/api/documentos/contrato/${clienteId}${qs({
        contrato: contratoId,
        descargar: descargar ? '1' : null,
      })}`),
    /**
     * El contrato de adhesión de la ARCOTEL, con sus cuatro anexos.
     *
     * `origen` es 'cliente' o 'orden': el contrato se firma ANTES del alta, así
     * que tiene que poder salir de una orden de trabajo — de alguien que
     * todavía no es abonado— con los datos que cargó el vendedor.
     */
    contratoArcotel: (id, { origen = 'cliente', contratoId = null, descargar = false } = {}) =>
      archivo(`/api/documentos/contrato-arcotel/${origen === 'orden' ? 'orden/' : ''}${id}${qs({
        contrato: contratoId,
        descargar: descargar ? '1' : null,
      })}`),

    /** Qué quedaría en blanco, para avisarlo ANTES de imprimir las nueve hojas. */
    revisarContrato: (id, origen = 'cliente') =>
      get(`/api/documentos/contrato-arcotel/${origen === 'orden' ? 'orden/' : ''}${id}?revisar=1`),

    instalacion: (id, descargar = false) =>
      archivo(`/api/documentos/instalacion/${id}${descargar ? '?descargar=1' : ''}`),
    ticket: (id, descargar = false) =>
      archivo(`/api/documentos/ticket/${id}${descargar ? '?descargar=1' : ''}`),
    recibo: (pagoId, descargar = false) =>
      archivo(`/api/documentos/recibo/${pagoId}${descargar ? '?descargar=1' : ''}`),

    /**
     * El recibo para la térmica: llega como TEXTO, no como PDF.
     *
     * Una tirilla de 58 mm no se pagina; mandarle un PDF abriría el diálogo de
     * impresión con márgenes de hoja A4, que es lo que estorba en el mostrador.
     */
    reciboPos: (pagoId, ancho = 32) =>
      archivo(`/api/documentos/recibo-pos/${pagoId}?ancho=${ancho}`).then((b) => b.text()),

    /** La vista previa del editor, con datos reales de ese abonado o ese cobro. */
    previa: (tipo, id) => get(`/api/documentos/${tipo}/${id}?texto=1`),
  },

  /**
   * La firma del contrato: electrónica por API, o en papel.
   *
   * `solicitar` NO falla cuando el proveedor no responde: devuelve el trámite
   * con `hay_que_firmar_en_papel` en true y el motivo. Es a propósito — el que
   * vende está con el cliente delante y lo que necesita es seguir, no un error.
   */
  firmas: {
    config: () => get('/api/firmas/config'),
    guardarConfig: (datos) => put('/api/firmas/config', datos),
    /** Prueba la conexión sin crear ningún trámite. */
    probar: (api_url = null) => post('/api/firmas/probar', { api_url }),
    de: ({ instalacionId = null, clienteId = null } = {}) =>
      get(`/api/firmas${qs({ instalacion: instalacionId, cliente: clienteId })}`),
    solicitar: (datos) => post('/api/firmas/solicitar', datos),
    autorizarManual: (id, motivo = null) =>
      post(`/api/firmas/${id}/autorizar-manual`, { motivo }),
    registrarManual: (id, datos) => post(`/api/firmas/${id}/registrar-manual`, datos),
    vencer: () => post('/api/firmas/vencer', {}),
  },

  /** Las alertas en tiempo real: estado del canal y prueba de destinos. */
  alertas: {
    estado: () => get('/api/alertas/estado'),
    probar: (id) => post(`/api/alertas/destinos/${id}/probar`, {}),
    correr: () => post('/api/alertas/correr', {}),
  },

  comunicaciones: {
    canales: () => get('/api/comunicaciones/canales'),
    config: () => get('/api/comunicaciones/config'),
    guardarConfig: (datos) => put('/api/comunicaciones/config', datos),
    probar: (canal, destino) => post('/api/comunicaciones/probar', { canal, destino }),
    vistaPrevia: (datos) => post('/api/comunicaciones/vista-previa', datos),
    /**
     * El correo entero como va a salir: tarjeta, logo, cuentas y botón.
     *
     * La otra previa devuelve solo el texto con los marcadores reemplazados, que
     * no alcanza para saber si el mensaje quedó bien: el párrafo puede leerse
     * perfecto y repetir un dato que la tabla ya muestra.
     */
    vistaPreviaCorreo: (datos) => post('/api/comunicaciones/vista-previa-correo', datos),
    enviar: (datos) => post('/api/comunicaciones/enviar', datos),
    marcarEnviado: (id) => post(`/api/comunicaciones/${id}/marcar-enviado`, {}),
  },

  /** Consumo medido de los abonados. */
  consumo: {
    estado: () => get('/api/consumo/estado'),
    recolectar: (datos = {}) => post('/api/consumo/recolectar', datos),
    sincronizarSesiones: () => post('/api/consumo/sesiones/sincronizar', {}),
    reporte: (clientId, mes, descargar = false) =>
      archivo(`/api/consumo/${clientId}/reporte?mes=${mes}${descargar ? '&descargar=1' : ''}`),
  },

  sri: {
    config: () => get('/api/sri/config'),
    guardarConfig: (datos) => request('PUT', '/api/sri/config', datos),
    catalogos: () => get('/api/sri/catalogos'),
    preview: (detalles) => post('/api/sri/preview', { detalles }),
    emitirFactura: (datos) => post('/api/sri/facturas', datos),
    xml: (id) => get(`/api/sri/documentos/${id}/xml`),
    /** RIDE en PDF: lo que se le entrega al abonado. */
    ride: (id) => archivo(`/api/sri/documentos/${id}/ride`),

    /** Emite las facturas de los cobros del cierre y las manda al SRI. */
    facturarLote: (datos) => post('/api/sri/facturar-lote', datos),

    /** Devuelve el número de un comprobante que nunca salió, para reutilizarlo. */
    liberarNumero: (id, datos) => post(`/api/sri/documentos/${id}/liberar-numero`, datos),

    /** Generación mensual de las facturas del sistema. */
    facturasDelMes: () => get('/api/sri/facturas-mes'),
    generarFacturasDelMes: (datos) => post('/api/sri/facturas-mes', datos),

    certificado: () => get('/api/sri/certificado'),
    subirCertificado: (datos) => post('/api/sri/certificado', datos),
    borrarCertificado: () => del('/api/sri/certificado'),
    probarFirma: () => post('/api/sri/probar-firma'),
    firmar: (id) => post(`/api/sri/documentos/${id}/firmar`),
    enviar: (id) => post(`/api/sri/documentos/${id}/enviar`),
    autorizacion: (id) => post(`/api/sri/documentos/${id}/autorizacion`),
    procesar: (id, opciones) => post(`/api/sri/documentos/${id}/procesar`, opciones),

    /** Manda el XML autorizado y el RIDE al comprador. */
    email: (id, datos) => post(`/api/sri/documentos/${id}/email`, datos),
    probarSmtp: (datos) => post('/api/sri/probar-smtp', datos),
  },

  pagos: {
    /**
     * El comprobante que se le entrega al cliente por un cobro.
     *
     * Qué papel sale lo decide el servidor según el cobro: la factura saldada
     * —con la banda que dice PAGADO— cuando saldó una, y el recibo cuando no hay
     * factura que mostrar. Elegirlo en cada pantalla hacía que el mismo cobro
     * saliera distinto según por dónde se lo pidiera.
     */
    comprobante: (id) => archivo(`/api/pagos/${id}/comprobante`),

    /** El recibo de cobro pelado, para cuando se lo quiere sí o sí. */
    recibo: (id) => archivo(`/api/pagos/${id}/recibo`),

    /** Estado de cuenta de una factura: sus pagos, excedentes y saldo. */
    facturaPdf: (id) => archivo(`/api/pagos/facturas/${id}/pdf`),

    /**
     * El cierre de caja: todo lo cobrado con estos filtros, con sus totales.
     *
     * Los filtros viajan como texto de query y el filtrado se rehace del lado del
     * servidor. Mandar las filas que se ven en pantalla haría un cierre de quince
     * cobros con un total que parece correcto.
     */
    transaccionesPdf: (query = '') =>
      archivo(`/api/pagos/transacciones/pdf${query ? `?${query}` : ''}`),

    /**
     * Conciliación bancaria: el extracto contra lo cobrado.
     *
     * El archivo va en base64 dentro del cuerpo, como el certificado de firma. El
     * middleware lo lee, lo cruza con los cobros del período que trae el propio
     * extracto y devuelve las tres listas.
     */
    conciliar: (datos) => post('/api/pagos/conciliacion', datos),

    /**
     * El mismo informe en PDF, para archivar y para salir a llamar.
     *
     * Se manda el archivo de nuevo y no el resultado: el papel se vuelve a armar
     * del lado del servidor, así que no puede decir algo distinto de la pantalla
     * porque el navegador haya tocado la respuesta.
     */
    conciliacionPdf: (datos) => archivo('/api/pagos/conciliacion/pdf', datos),

    /**
     * El reporte de ARCOTEL, en Excel o en PDF.
     *
     * El formato viaja en la query y no en dos funciones distintas: los dos
     * papeles salen de la misma consulta y de la misma lista de columnas del lado
     * del servidor, así que separarlos acá sugeriría que pueden diferir.
     */
    arcotel: (query = '') => archivo(`/api/pagos/arcotel${query ? `?${query}` : ''}`),

    /** Estado del corte automático y a quién cortaría si corriera ahora. */
    cortes: () => get('/api/pagos/cortes'),
    ejecutarCortes: (datos) => post('/api/pagos/cortes/ejecutar', datos),
  },

  olt: {
    test: (id) => get(`/api/olt/${id}/test`),

    /**
     * Estado del equipo: temperatura, placas, consumo y puertos PON.
     *
     * Se lee en vivo y tarda —son varios comandos contra la CLI— así que la
     * pantalla no lo pide sola: lo trae cuando alguien abre el panel.
     */
    salud: (id) => get(`/api/olt/${id}/salud`),

    onus: (id, { frame, slot, puerto }) =>
      get(`/api/olt/${id}/onus${qs({ frame, slot, puerto })}`),

    autofind: (id, { frame, slot, puerto, puertos }) =>
      get(`/api/olt/${id}/autofind${qs({ frame, slot, puerto, puertos })}`),

    registrar: (id, datos) => post(`/api/olt/${id}/onus`, datos),
    configurarServicio: (id, datos) => post(`/api/olt/${id}/onus/servicio`, datos),

    eliminar: (id, onuId, { frame, slot, puerto }) =>
      del(`/api/olt/${id}/onus/${onuId}${qs({ frame, slot, puerto })}`),

    metricas: (id, onuId, { frame, slot, puerto }) =>
      get(`/api/olt/${id}/onus/${onuId}/metricas${qs({ frame, slot, puerto })}`),

    crearLineProfile: (id, datos) => post(`/api/olt/${id}/line-profiles`, datos),
    aplicarPlan: (id, datos) => post(`/api/olt/${id}/traffic-tables`, datos),

    cli: (id, comandos) => post(`/api/olt/${id}/cli`, { comandos }),


    // --- Ficha del equipo ---------------------------------------------------

    /**
     * Alcance. Es un TCP contra el puerto de gestión, no una sesión CLI: el
     * listado necesita saber si el equipo contesta, no hablar con él.
     */
    estado: (id) => get(`/api/olt/${id}/estado`),
    estados: () => post('/api/olt/estados'),

    /** Lee modelo y firmware del equipo y los deja guardados en la ficha. */
    versiones: (id) => post(`/api/olt/${id}/versiones`),

    placas: (id) => get(`/api/olt/${id}/cards`),
    puertosPon: (id, { slot } = {}) => get(`/api/olt/${id}/pon-ports${qs({ slot })}`),

    /**
     * Estado detallado por puerto: potencia Tx del módulo de la OLT, su
     * temperatura, ONU rogue y cuándo se cayó por última vez.
     *
     * Es un comando por puerto, así que va bajo demanda.
     */
    /**
     * Puertos de subida con las VLANs que pasan por cada uno. Un comando por
     * placa más uno por puerto, así que va bajo demanda.
     */
    uplinks: (id, { slots } = {}) => get(`/api/olt/${id}/uplinks${qs({ slots })}`),

    /**
     * Agrega o quita VLANs de un troncal.
     *
     * Quitar una VLAN con abonados los deja sin salida a todos a la vez: el
     * middleware se niega salvo que se insista con `forzar`, y devuelve cuántos
     * son para que la pantalla lo pueda decir.
     */
    cambiarVlansUplink: (id, datos) =>
      post(`/api/olt/${id}/uplinks/vlans`, { confirmar: true, ...datos }),

    estadoPuertos: (id, { slot, puertos } = {}) =>
      get(`/api/olt/${id}/pon-ports/estado${qs({ slot, puertos })}`),

    /**
     * Acciones masivas sobre todos los puertos de una placa.
     * `accion`: encender · apagar · autofind_on · autofind_off · reiniciar_onts
     */
    accionPuertos: (id, { slot, accion, puertos }) =>
      post(`/api/olt/${id}/pon-ports/acciones`, { confirmar: true, slot, accion, puertos }),

    /** Reinicia las ONTs de un puerto. Corta el servicio de sus abonados. */
    reiniciarPuerto: (id, { slot, puerto, graceful = true }) =>
      post(`/api/olt/${id}/pon-ports/${slot}/${puerto}/reiniciar`, { confirmar: true, graceful }),

    /**
     * Le pregunta al equipo qué comandos entiende de un área y devuelve la
     * salida cruda. Es el paso previo a escribir el parser, no su reemplazo.
     */
    relevar: (id, area) => post(`/api/olt/${id}/relevar/${area}`),
    areas: () => get('/api/olt/areas'),

    historial: (id, { limite } = {}) => get(`/api/olt/${id}/historial${qs({ limite })}`),

    backups: (id) => get(`/api/olt/${id}/backups`),
    respaldar: (id, datos) => post(`/api/olt/${id}/backups`, datos ?? {}),
    verBackup: (id, backupId) => get(`/api/olt/${id}/backups/${backupId}`),
    borrarBackup: (id, backupId) => del(`/api/olt/${id}/backups/${backupId}`),

    // --- SNMP: lectura masiva -----------------------------------------------

    /**
     * Le pregunta la comunidad SNMP al equipo y la guarda cifrada. Nunca
     * devuelve el valor, solo cuántos caracteres tiene.
     */
    detectarComunidad: (id) => post(`/api/olt/${id}/snmp/detectar`),

    /**
     * Potencia óptica de todas las ONTs de una sola vez.
     *
     * Por defecto solo la RX, que es la que dispara alertas. `completo` agrega
     * temperatura, voltaje y corriente del láser, pero cuesta cinco recorridos
     * en vez de uno.
     */
    potencias: (id, { guardar, completo } = {}) =>
      get(`/api/olt/${id}/potencias${qs({ guardar: guardar ? 1 : undefined, completo: completo ? 1 : undefined })}`),

    /**
     * ONTs conectadas que nadie autorizó todavía. Va bajo demanda: son varios
     * comandos por la CLI y consumen la sesión del equipo.
     */
    esperando: (id) => get(`/api/olt/${id}/esperando`),

    /**
     * Dispara el barrido de todas las OLTs y lo deja guardado. La pantalla lee
     * el resultado de la base, no de acá: así abrir el tablero es instantáneo.
     */
    escanearEsperando: () => post('/api/olt/esperando/escanear'),

    /**
     * Ficha completa de una ONU: lo guardado y lo que dice el equipo ahora, en
     * bloques separados. Cuesta una sesión SSH, por eso va a pedido.
     */
    fichaOnu: (oltId, onuId) => get(`/api/olt/${oltId}/onus/${onuId}/ficha`),

    /**
     * Relee del equipo y corrige NUESTRA copia. No le manda nada a la ONT.
     * La que sí le escribe es reprovisionarOnu.
     */
    actualizarFichaOnu: (oltId, onuId) =>
      post(`/api/olt/${oltId}/onus/${onuId}/actualizar-ficha`),

    /**
     * Le vuelve a ENVIAR la configuración a la ONT.
     * Para cuando el TR069 no la aplicó y el abonado quedó sin servicio.
     */
    reprovisionarOnu: (oltId, onuId) =>
      post(`/api/olt/${oltId}/onus/${onuId}/reprovisionar`, { confirmar: true }),

    /**
     * Cambia el perfil de servicio o el de línea de una ONT ya autorizada.
     * Es el equivalente al "Change ONU type": corrige el perfil sin dar de baja
     * al abonado ni cambiarle el ONT-ID.
     */
    /**
     * Perfil TR-069 y/o IP de gestión de una ONT ya autorizada.
     * Las dos partes son opcionales, pero de a una sirven poco: un perfil sin
     * IP no llega al ACS, y una IP sin perfil deja a la ONT sin quién la
     * configure.
     */
    /**
     * Los perfiles TR-069 de UNA OLT.
     *
     * Distinto de `api.tr069.perfiles()` —que pregunta a todas y agrupa por ACS—
     * y del resumen `/:id/tr069`, que corre tres `display current-configuration`
     * para contar ONTs. Acá se corre uno solo: el desplegable necesita los
     * nombres y los ids, no las estadísticas.
     */
    tr069DeLaOlt: (oltId) => get(`/api/olt/${oltId}/tr069/perfiles`),

    /** Cómo sale a internet una ONT, y los perfiles de WAN de su OLT. */
    wanOnu: (oltId, onuId) => get(`/api/olt/${oltId}/onus/${onuId}/wan`),

    /** Configura o saca la WAN. Cambia el servicio del abonado. */
    configurarWanOnu: (oltId, onuId, datos) =>
      post(`/api/olt/${oltId}/onus/${onuId}/wan`, { confirmar: true, ...datos }),

    /**
     * La dirección, el PPPoE o el DHCP de la WAN, por TR-069.
     *
     * Es lo que el perfil de la OLT no guarda: `wanOnu` ya trae esto en
     * `datos.tr069` para mostrarlo, y esto es el pedido de cambiarlo.
     */
    configurarWanTr069Onu: (oltId, onuId, datos) =>
      post(`/api/olt/${oltId}/onus/${onuId}/wan/tr069`, { confirmar: true, ...datos }),

    gestionOnu: (oltId, onuId, datos) =>
      post(`/api/olt/${oltId}/onus/${onuId}/gestion`, datos),

    cambiarPerfilesOnu: (oltId, onuId, { srv_profile_id, line_profile_id }) =>
      post(`/api/olt/${oltId}/onus/${onuId}/perfiles`, {
        confirmar: true,
        srv_profile_id,
        line_profile_id,
      }),

    /** Devuelve la ONT a fábrica: borra el wifi y todo lo del abonado. */
    restaurarFabricaOnu: (oltId, onuId, completamente = false) =>
      post(`/api/olt/${oltId}/onus/${onuId}/restaurar-fabrica`, { confirmar: true, completamente }),

    /** La configuración que el equipo tiene en ejecución para esa ONT. */
    configActivaOnu: (oltId, onuId) => get(`/api/olt/${oltId}/onus/${onuId}/config-activa`),

    /** Los puertos de adentro de la ONT: ethernet de la casa y teléfono. */
    puertosOnu: (oltId, onuId) => get(`/api/olt/${oltId}/onus/${onuId}/puertos`),

    /** Modelo, firmware y fabricante, en vivo. */
    softwareOnu: (oltId, onuId) => get(`/api/olt/${oltId}/onus/${onuId}/software`),

    /**
     * Velocidad en vivo. Se consulta repetidamente: la primera respuesta no
     * trae Mbps porque hacen falta dos lecturas para restar.
     */
    traficoOnu: (oltId, onuId) => get(`/api/olt/${oltId}/onus/${onuId}/trafico`),

    /** Reinicia UNA ONT. Corta el servicio un par de minutos. */
    reiniciarOnu: (oltId, onuId) =>
      post(`/api/olt/${oltId}/onus/${onuId}/reiniciar`, { confirmar: true }),

    /**
     * Cajas NAP. `proponerNaps` devuelve candidatas para revisar, no un mapa:
     * la OLT no puede saber de qué caja cuelga un abonado.
     */
    naps: (oltId) => get(`/api/olt/naps${qs({ olt_id: oltId })}`),
    proponerNaps: (oltId) => get(`/api/olt/${oltId}/naps/proponer`),
    crearNap: (oltId, datos) => post(`/api/olt/${oltId}/naps`, datos),
    borrarNap: (napId) => del(`/api/olt/naps/${napId}`),
    asignarANap: (napId, onu_ids, verificada = false) =>
      post(`/api/olt/naps/${napId}/onus`, { onu_ids, verificada }),

    /** Relee del equipo la ficha de TODAS las ONUs. Arranca y contesta ya. */
    resyncMasivo: (oltId, todas = false) => post(`/api/olt/${oltId}/resync-masivo`, { todas }),
    estadoResyncMasivo: () => get('/api/olt/resync-masivo/estado'),
    detenerResyncMasivo: () => post('/api/olt/resync-masivo/detener'),

    /**
     * Perfiles de velocidad (traffic tables) de varias OLTs a la vez.
     *
     * El índice es de cada equipo: el 12 de una OLT no tiene por qué ser la
     * misma velocidad que el 12 de otra. Por eso se listan por equipo.
     */
    velocidades: (oltIds) => get(`/api/olt/velocidades${qs({ olt_ids: (oltIds ?? []).join(',') })}`),
    crearVelocidad: (datos) => post('/api/olt/velocidades', datos),

    /**
     * Crea un plan comercial a partir de un par de tablas que ya existe.
     *
     * Es el camino inverso al del formulario de planes, y el que sirve en una
     * red que ya está andando: las tablas están desde hace años y lo único que
     * falta es el nombre comercial y el precio.
     */
    crearPlanDesdeTablas: (oltId, datos) => post(`/api/olt/${oltId}/velocidades/plan`, datos),
    borrarVelocidad: (index, oltIds) =>
      del(`/api/olt/velocidades/${index}${qs({ olt_ids: (oltIds ?? []).join(',') })}`),

    /**
     * Las VLANs de la OLT: las del equipo más lo que sabemos de ellas.
     *
     * Lo que el equipo no puede decir —para qué se usa cada una y de qué puerto
     * PON es la predeterminada— es lo que después permite que una instalación
     * elija sola su segmento de red.
     */
    vlans: (oltId) => get(`/api/olt/${oltId}/vlans`),
    // La misma información al revés: los puertos de cada placa con su VLAN. Es
    // la vista con la que se configura, porque muestra también los puertos
    // vacíos — que son justamente los que falta configurar.
    vlansPorPuerto: (oltId) => get(`/api/olt/${oltId}/vlans/puertos`),

    // Pools de IP para las ONUs: las de gestión (TR069) y las WAN estáticas.
    // No tocan el equipo: son el registro de qué direcciones hay y cuáles
    // están libres, que hoy se resuelve mirando la OLT a mano.
    poolsIp: (oltId, proposito) => get(`/api/olt/${oltId}/pools-ip${qs({ proposito })}`),
    poolIps: (oltId, subredId, params = {}) =>
      get(`/api/olt/${oltId}/pools-ip/${subredId}/ips${qs(params)}`),
    revisarPoolIp: (oltId, datos) => post(`/api/olt/${oltId}/pools-ip/revisar`, datos),
    crearPoolIp: (oltId, datos) => post(`/api/olt/${oltId}/pools-ip`, datos),
    editarPoolIp: (oltId, subredId, datos) => put(`/api/olt/${oltId}/pools-ip/${subredId}`, datos),
    ampliarPoolIp: (oltId, subredId, datos) =>
      post(`/api/olt/${oltId}/pools-ip/${subredId}/ampliar`, datos),
    borrarPoolIp: (oltId, subredId, forzar) =>
      del(`/api/olt/${oltId}/pools-ip/${subredId}${qs({ forzar: forzar ? 'true' : '' })}`),
    siguienteIpPool: (oltId, subredId) =>
      get(`/api/olt/${oltId}/pools-ip/${subredId}/siguiente`),
    // Trae las IPs de gestión que las ONTs ya tienen puestas. Es el paso de una
    // migración: sin esto el primer alta entrega una dirección repetida.
    importarIpsGestion: (oltId, datos) => post(`/api/olt/${oltId}/pools-ip/importar`, datos),
    // Lo caro: preguntarle al equipo cómo está armado. Es un botón aparte
    // porque tarda ~30 s y casi todo es hardware que no cambia.
    relevarPuertos: (oltId) => post(`/api/olt/${oltId}/vlans/puertos/relevar`),
    // Traer al sistema lo que el equipo ya tiene. No escribe en la OLT: lo
    // único que toca son nuestras anotaciones.
    importarVlans: (oltId, datos) => post(`/api/olt/${oltId}/vlans/importar`, datos),
    // La VLAN de un puerto vive aparte de la VLAN en sí: varios puertos pueden
    // compartir una, y con la clave puesta en la VLAN solo entraba uno.
    asignarPuerto: (oltId, slot, puerto, datos) =>
      put(`/api/olt/${oltId}/puertos/${slot}/${puerto}`, datos),
    desasignarPuerto: (oltId, slot, puerto) =>
      del(`/api/olt/${oltId}/puertos/${slot}/${puerto}`),
    crearVlans: (oltId, datos) => post(`/api/olt/${oltId}/vlans`, datos),
    borrarVlans: (oltId, datos) => post(`/api/olt/${oltId}/vlans/borrar`, datos),
    anotarVlan: (oltId, vlan, datos) => put(`/api/olt/${oltId}/vlans/${vlan}`, datos),
    vlansCorrelativas: (oltId, datos) => post(`/api/olt/${oltId}/vlans/correlativas`, datos),
    // El esquema por puerto va en dos pasos: primero se calcula y se contrasta
    // con lo que ya existe sin tocar nada, y recién después se crea. Dieciséis
    // subredes salidas de un solo botón son demasiadas para no verlas antes.
    esquemaSimular: (oltId, datos) => post(`/api/olt/${oltId}/vlans/esquema/simular`, datos),
    esquemaAplicar: (oltId, datos) => post(`/api/olt/${oltId}/vlans/esquema/aplicar`, datos),
    // Deshacer: el bloque, el pool y la VLAN del puerto, de una. Crear son tres
    // cosas y deshacerlas eran tres pantallas distintas.
    esquemaDeshacer: (oltId, datos) => post(`/api/olt/${oltId}/vlans/esquema/deshacer`, datos),
    // Un perfil PPP por VLAN, con el gateway de cada bloque.
    perfilesPorVlan: (oltId, datos) => post(`/api/olt/${oltId}/perfiles-por-vlan`, datos),

    /** Las traffic tables de UNA OLT, para elegir desde un plan. */
    trafficTables: (oltId) => get(`/api/olt/${oltId}/traffic-tables`),

    /** Comprueba los planes contra las tablas que el equipo tiene de verdad. */
    verificarPlanes: (oltId, guardar = false) =>
      get(`/api/olt/${oltId}/planes/verificar${guardar ? '?guardar=1' : ''}`),

    /** Perfiles de línea y de servicio que tiene cargados el equipo. */
    perfilesOnt: (id) => get(`/api/olt/${id}/perfiles`),

    /**
     * Plantillas de autorización: el juego de datos que se repite en todas las
     * altas de una zona.
     */
    presets: (oltId) => get(`/api/olt/presets${qs({ olt_id: oltId })}`),
    guardarPreset: (datos) => post('/api/olt/presets', datos),
    borrarPreset: (id) => del(`/api/olt/presets/${id}`),

    /** ONTs cargadas antes de estar conectadas. */
    preautorizadas: (filtros) => get(`/api/olt/preautorizadas${qs(filtros ?? {})}`),
    cargarPreautorizada: (oltId, datos) => post(`/api/olt/${oltId}/preautorizar`, datos),
    borrarPreautorizada: (id) => del(`/api/olt/preautorizadas/${id}`),
    reactivarPreautorizada: (id) => post(`/api/olt/preautorizadas/${id}/reactivar`),

    /**
     * Ficha de una ONT que espera autorización: quién es, desde cuándo está y
     * si esa serie ya figura en una orden de instalación o en otra OLT.
     */
    verEsperando: (id, sn) => get(`/api/olt/${id}/esperando/${encodeURIComponent(sn)}`),

    /**
     * Vuelve a preguntarle al equipo por UNA ONT. Puede sacarla de la cola si el
     * equipo ya no la ve, por eso es POST.
     */
    resyncEsperando: (id, sn) => post(`/api/olt/${id}/esperando/${encodeURIComponent(sn)}/resync`),

    /**
     * Todo lo que hace falta para llenar el formulario de autorización: la
     * orden de instalación que coincide con esa serie, los perfiles del equipo,
     * los planes y qué proponer en cada campo.
     */
    datosAutorizacion: (id, sn) => get(`/api/olt/${id}/autorizar/datos${qs({ sn })}`),

    /** Registra la ONT en la OLT y le crea su service-port. */
    autorizar: (id, datos) => post(`/api/olt/${id}/autorizar`, datos),

    /** Vista previa de la importación: no escribe nada. */
    inventario: (id) => get(`/api/olt/${id}/inventario`),
    importarOnus: (id) => post(`/api/olt/${id}/inventario`),

    /** Enlace ONT↔abonado. `crear` da de alta las fichas que faltan. */
    abonados: (id) => get(`/api/olt/${id}/abonados`),
    enlazarAbonados: (id, { crear } = {}) => post(`/api/olt/${id}/abonados`, { crear: Boolean(crear) }),

    // --- Operaciones sobre una ONT instalada --------------------------------

    /** Cambia la velocidad. No corta el servicio. */
    cambiarPlanOnu: (id, onuId, planId) =>
      post(`/api/olt/${id}/onus/${onuId}/plan`, { plan_id: planId }),

    /** Suspende o reactiva. Reversible: la configuración queda intacta. */
    suspenderOnu: (id, onuId, activar) =>
      post(`/api/olt/${id}/onus/${onuId}/suspender`, { activar }),

    /** Cómo está configurada la ONT en el equipo, tal cual. */
    configOnu: (id, onuId) => get(`/api/olt/${id}/onus/${onuId}/config`),

    /** Mueve la ONT a otro puerto. Es borrar y recrear: corta el servicio. */
    moverOnu: (id, onuId, { slot, puerto }) =>
      post(`/api/olt/${id}/onus/${onuId}/mover`, { confirmar: true, slot, puerto }),

    /** Baja definitiva: borra la ONT del equipo y de la base. */
    darDeBajaOnu: (id, onuId) => del(`/api/olt/${id}/onus/${onuId}/baja?confirmar=true`),

    /** Coherencia entre lo que dice la base y lo que hay configurado. */
    inconsistencias: ({ profundo } = {}) =>
      get(`/api/olt/inconsistencias${qs({ profundo: profundo ? 1 : undefined })}`),
  },
}
