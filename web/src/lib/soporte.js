/**
 * Reglas del ciclo de vida de un ticket.
 *
 * Viven acá y no dentro de un componente porque las usan tres pantallas —el
 * listado, la ficha del técnico y el formulario— y porque el orden de los
 * estados es una regla del negocio, no una decisión de diseño: un ticket no
 * puede pasar de "abierto" a "resuelto" sin que nadie haya ido.
 */

export const ESTADOS = {
  abierto: {
    label: 'Abierto',
    color: 'gris',
    clase: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
    ayuda: 'Entró el reclamo. Falta decidir quién va.',
  },
  asignado: {
    label: 'Asignado',
    color: 'azul',
    clase: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
    ayuda: 'Tiene técnico y fecha. Todavía no salió.',
  },
  en_ruta: {
    label: 'En ruta',
    color: 'ambar',
    clase: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
    ayuda: 'El técnico va camino al domicilio.',
  },
  en_proceso: {
    label: 'En proceso',
    color: 'violeta',
    clase: 'bg-violet-500/15 text-violet-300 border-violet-500/40',
    ayuda: 'Está trabajando en el lugar.',
  },
  resuelto: {
    label: 'Resuelto',
    color: 'verde',
    clase: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
    ayuda: 'Se solucionó y el abonado firmó conforme.',
  },
  cancelado: {
    label: 'Cancelado',
    color: 'rojo',
    clase: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
    ayuda: 'No se hizo: nadie en casa, el abonado desistió, se duplicó.',
  },
}

/**
 * A dónde puede ir cada estado.
 *
 * Se puede cancelar desde cualquier lado —el abonado desiste, no había nadie—
 * pero no se puede volver atrás desde resuelto: para eso se abre otro ticket, y
 * así queda la historia de que el problema volvió.
 */
export const TRANSICIONES = {
  abierto: ['asignado', 'cancelado'],
  asignado: ['en_ruta', 'en_proceso', 'abierto', 'cancelado'],
  en_ruta: ['en_proceso', 'asignado', 'cancelado'],
  en_proceso: ['resuelto', 'en_ruta', 'cancelado'],
  resuelto: [],
  cancelado: ['abierto'],
}

export const PRIORIDADES = {
  alta: { label: 'Alta', clase: 'bg-rose-500/15 text-rose-300 border-rose-500/40' },
  media: { label: 'Media', clase: 'bg-amber-500/15 text-amber-300 border-amber-500/40' },
  baja: { label: 'Baja', clase: 'bg-slate-500/15 text-slate-300 border-slate-500/40' },
}

export const INCIDENCIAS = [
  { valor: 'sin_internet', label: 'Sin internet', tecnologia: null },
  { valor: 'lentitud', label: 'Lentitud', tecnologia: null },
  { valor: 'intermitencia', label: 'Intermitencia / se corta', tecnologia: null },
  { valor: 'fibra_cortada', label: 'Fibra cortada', tecnologia: 'ftth' },
  { valor: 'potencia_baja', label: 'Potencia baja', tecnologia: 'ftth' },
  { valor: 'senal_baja', label: 'Señal baja', tecnologia: 'wireless' },
  { valor: 'equipo_danado', label: 'Equipo dañado', tecnologia: null },
  { valor: 'cambio_clave', label: 'Cambio de clave WiFi', tecnologia: null },
  { valor: 'traslado', label: 'Traslado de domicilio', tecnologia: null },
  { valor: 'instalacion', label: 'Instalación nueva', tecnologia: null },
  { valor: 'retiro', label: 'Retiro de equipos', tecnologia: null },
  { valor: 'otro', label: 'Otro', tecnologia: null },
]

/**
 * El nombre del tipo de incidencia. Con "Otro" y el detalle de cuál (221),
 * "Otro: cambio de router": "Otro" a secas no le dice nada al técnico.
 */
export const etiquetaIncidencia = (v, otro = null) => {
  const label = INCIDENCIAS.find((i) => i.valor === v)?.label ?? v ?? '—'
  return v === 'otro' && String(otro ?? '').trim() ? `${label}: ${String(otro).trim()}` : label
}

export const FRANJAS = {
  manana: 'Mañana (08:00 – 12:00)',
  tarde: 'Tarde (13:00 – 18:00)',
  exacta: 'Hora exacta',
}

/**
 * Lo que el técnico verifica antes de irse, según la tecnología.
 *
 * Se guarda el objeto entero en el ticket: si mañana se agrega un punto, los
 * tickets viejos conservan la lista con la que se cerraron en vez de aparecer
 * incompletos.
 */
export const CHECKLIST = {
  ftth: [
    { clave: 'potencia_ok', label: 'Potencia óptica dentro de rango (-8 a -27 dBm)' },
    { clave: 'conectores', label: 'Conectores limpios y bien insertados' },
    { clave: 'navegacion', label: 'Navegación probada en el equipo del abonado' },
    { clave: 'wifi', label: 'WiFi configurado y probado' },
    { clave: 'orden', label: 'Cableado ordenado y sujetado' },
    { clave: 'capacitacion', label: 'Se le explicó al abonado cómo reiniciar el equipo' },
  ],
  wireless: [
    { clave: 'senal_ok', label: 'Señal dentro de rango (mejor que -70 dBm)' },
    { clave: 'alineacion', label: 'Antena alineada y ajustada' },
    { clave: 'aterrizaje', label: 'Aterrizaje / protección contra descargas' },
    { clave: 'navegacion', label: 'Navegación probada en el equipo del abonado' },
    { clave: 'wifi', label: 'WiFi configurado y probado' },
    { clave: 'capacitacion', label: 'Se le explicó al abonado cómo reiniciar el equipo' },
  ],
}

// La conversión del número se mudó a `telefono.js`: estaba escrita cuatro veces
// y solo esta la hacía bien. Se reexporta con el nombre viejo para no tocar las
// pantallas de soporte, que ya la importan así.
// La extensión va explícita para que este archivo se pueda importar desde el
// runner de node, que a diferencia de Vite no resuelve rutas sin extensión.
// Es lo que permite probar la regla de la ruta sin montar un navegador.
export { aWhatsApp as aWhatsapp, enlaceWhatsApp as enlaceWhatsapp } from './telefono.js'

/**
 * A dónde tiene que ir el técnico.
 *
 * Con coordenadas se navega al punto exacto; sin ellas, a la dirección escrita,
 * que en un barrio sin nomenclatura no siempre cae bien —pero es mejor que
 * nada—. Waze y Google Maps toman formatos distintos.
 */
export function enlaceMapa(ticket, app = 'google') {
  const { latitud, longitud, direccion, sector, canton } = ticket ?? {}

  if (latitud && longitud) {
    /**
     * `geo:` deja que el teléfono elija.
     *
     * En Android abre el selector del sistema con las aplicaciones de mapas
     * instaladas, que es lo que pidió quien usa dos. iOS lo ignora — por eso
     * esta opción no es la de fábrica y la pantalla donde se elige lo aclara.
     *
     * El `?q=` repetido no es un error: sin él, varias aplicaciones abren el
     * mapa centrado en el punto pero sin marcador ni destino cargado.
     */
    if (app === 'sistema') return `geo:${latitud},${longitud}?q=${latitud},${longitud}`

    return app === 'waze'
      ? `https://waze.com/ul?ll=${latitud},${longitud}&navigate=yes`
      : `https://www.google.com/maps/dir/?api=1&destination=${latitud},${longitud}`
  }

  const texto = [direccion, sector, canton].filter(Boolean).join(', ')
  if (!texto) return null

  // Sin coordenadas solo queda buscar por texto, y `geo:` no sabe hacerlo:
  // ahí cae a Google, que es el que resuelve una dirección escrita.
  return app === 'waze'
    ? `https://waze.com/ul?q=${encodeURIComponent(texto)}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(texto)}`
}

/**
 * Achica la foto antes de subirla.
 *
 * El técnico está en la calle con datos móviles: una foto de 4 MB del celular
 * tarda y a veces no sube. A 1280 px y calidad 0.7 una lectura de potencia se
 * lee perfecto y pesa unos 200 KB.
 */
export async function comprimirImagen(archivo, { max = 1280, calidad = 0.7 } = {}) {
  const bitmap = await createImageBitmap(archivo)
  const escala = Math.min(1, max / Math.max(bitmap.width, bitmap.height))

  const lienzo = document.createElement('canvas')
  lienzo.width = Math.round(bitmap.width * escala)
  lienzo.height = Math.round(bitmap.height * escala)
  lienzo.getContext('2d').drawImage(bitmap, 0, 0, lienzo.width, lienzo.height)

  const blob = await new Promise((r) => lienzo.toBlob(r, 'image/jpeg', calidad))
  bitmap.close?.()
  return blob ?? archivo
}

/**
 * Metros entre dos coordenadas.
 *
 * Sirve para decirle al técnico, en el momento, si está donde dice el ticket.
 * Es la misma cuenta que hace la vista: acá se calcula para no tener que ir y
 * volver a la base solo para mostrar un número.
 */
export function distanciaEnMetros(a, b) {
  if (!a?.lat || !a?.lng || !b?.lat || !b?.lng) return null
  const rad = (g) => (Number(g) * Math.PI) / 180

  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2

  return Math.round(6371000 * 2 * Math.asin(Math.sqrt(h)))
}

/**
 * A partir de cuántos metros se considera que el técnico no está en el
 * domicilio.
 *
 * 250 m es holgado a propósito: la coordenada del abonado muchas veces se cargó
 * desde la vereda o desde el poste, y un GPS bajo techo se va cincuenta metros
 * sin esfuerzo. El número no bloquea nada, solo avisa.
 */
export const RADIO_LLEGADA_M = 250

/** La ubicación del dispositivo, o null si no se pudo. */
export function ubicacionActual({ timeout = 12_000 } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null)

    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          precision: pos.coords.accuracy,
        }),
      // No se rechaza: que el GPS falle no puede impedir que el técnico
      // empiece a trabajar. Queda registrado que no hubo confirmación.
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 30_000 },
    )
  })
}

/** "12 min", "1 h 20 min" — para los tiempos de viaje y de trabajo. */
export function duracion(minutos) {
  const m = Math.round(Number(minutos) || 0)
  if (m < 1) return 'menos de 1 min'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} min`
}

/** "hace 3 h", "hace 2 d" — el técnico mira cuánto lleva esperando el abonado. */
export function haceCuanto(horas) {
  const h = Number(horas) || 0
  if (h < 1) return `hace ${Math.max(1, Math.round(h * 60))} min`
  if (h < 24) return `hace ${Math.round(h)} h`
  const d = Math.floor(h / 24)
  return `hace ${d} ${d === 1 ? 'día' : 'días'}`
}

/**
 * En qué pestaña de la app del técnico va un ticket.
 *
 *   'hoy'       asignado y le toca hoy: con visita hoy o antes, o sin fecha
 *   'proximos'  asignado para un día que todavía no llega, o esperando que la
 *               oficina le ponga fecha nueva
 *   'curso'     en camino o en el sitio
 *   'cerrados'  resuelto o cancelado
 *
 * "Hoy" es la misma regla que arma la ruta del día (`items_de_ruta`, 216): así
 * el número de la pestaña coincide con el de la tarjeta de la ruta. Antes
 * "Asignados" mezclaba lo de hoy con lo de la semana y el técnico creía que
 * tenía todo eso para el día.
 *
 * @param hoy  'AAAA-MM-DD' en la hora local
 */
export function grupoDeCampo(t, hoy) {
  if (t.estado === 'en_ruta' || t.estado === 'en_proceso') return 'curso'
  if (t.estado === 'resuelto' || t.estado === 'cancelado') return 'cerrados'
  if (t.estado !== 'asignado') return null
  if (t.fecha_visita) return String(t.fecha_visita).slice(0, 10) <= hoy ? 'hoy' : 'proximos'
  return t.reprogramar_desde ? 'proximos' : 'hoy'
}

/** La fecha de hoy en la hora del teléfono, como la guarda la base. */
export const hoyLocal = (ahora = new Date()) =>
  `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}`

/** Sin tildes ni mayúsculas: "Oña" se encuentra escribiendo "ona". */
const normal = (v) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/**
 * ¿Este ticket es el que se busca?
 *
 * Por lo que uno recuerda cuando no recuerda el número: el nombre (o parte, en
 * cualquier orden: "masapanta luis"), la cédula, el teléfono, la dirección, el
 * sector, el técnico o la cuadrilla. Y por número: "41" o "000041".
 */
export function coincideTicket(t, texto) {
  const q = normal(texto).trim()
  if (!q) return true

  // Solo cifras: el número del ticket, o una cédula o teléfono que lo contenga.
  if (/^\d+$/.test(q)) {
    if (Number(q) === Number(t.numero)) return true
    const cifras = [t.identificacion, t.telefono, t.telefono_whatsapp]
      .map((v) => String(v ?? '').replace(/\D/g, ''))
      .join(' ')
    return q.length >= 4 && cifras.includes(q)
  }

  const donde = normal(
    [
      t.nombre, t.cliente, t.identificacion, t.telefono, t.telefono_whatsapp,
      t.direccion, t.referencia, t.sector, t.tecnico, t.cuadrilla,
      t.descripcion, t.incidencia_otro,
    ].join(' '),
  )
  return q.split(/\s+/).every((palabra) => donde.includes(palabra))
}

/**
 * De quién es un ticket, mirado por un técnico.
 *
 *   'mio'        asignado a él, aunque además tenga cuadrilla
 *   'cuadrilla'  asignado a su cuadrilla (sin técnico, o a un compañero)
 */
export const deQuien = (t, miTecnicoId) =>
  miTecnicoId && t.tecnico_id === miTecnicoId ? 'mio' : 'cuadrilla'

/**
 * Qué está haciendo cada técnico hoy, para el panel.
 *
 * Antes el panel miraba solo las instalaciones: con un día lleno de tickets
 * todos salían "Libre". Ahora cuenta las dos cosas, y los tickets de una
 * cuadrilla son de cada uno de sus integrantes.
 *
 * @param tecnicos       [{ id, nombre }]
 * @param tickets        los de hoy (y los que están en camino o en sitio)
 * @param instalaciones  las de hoy, con tecnico_id
 * @param miembros       [{ cuadrilla_id, tecnico_id }]
 * @returns por técnico { id, nombre, estado, actual, total, hechas, pendientes },
 *          con estado 'en_sitio' | 'en_camino' | 'con_ruta' | 'libre';
 *          primero los que están trabajando
 */
export function personalEnCampo(tecnicos = [], { tickets = [], instalaciones = [], miembros = [] } = {}) {
  const cuadrillasDe = new Map()
  for (const m of miembros) {
    if (!cuadrillasDe.has(m.tecnico_id)) cuadrillasDe.set(m.tecnico_id, new Set())
    cuadrillasDe.get(m.tecnico_id).add(m.cuadrilla_id)
  }

  const trabajos = [
    ...tickets
      .filter((t) => t.estado !== 'cancelado')
      .map((t) => ({
        tecnico_id: t.tecnico_id,
        cuadrilla_id: t.cuadrilla_id,
        nombre: t.nombre ?? t.cliente,
        en_sitio: t.estado === 'en_proceso',
        en_camino: t.estado === 'en_ruta',
        hecha: t.estado === 'resuelto',
      })),
    ...instalaciones
      .filter((i) => !['cancelada', 'reprogramada', 'no_realizada'].includes(i.estado))
      .map((i) => ({
        tecnico_id: i.tecnico_id,
        cuadrilla_id: null,
        nombre: i.cliente ?? i.nombre,
        en_sitio: i.estado === 'en_curso',
        en_camino: i.estado === 'en_ruta',
        hecha: i.estado === 'hecha',
      })),
  ]

  const ORDEN = { en_sitio: 0, en_camino: 1, con_ruta: 2, libre: 3 }
  return tecnicos
    .map((tec) => {
      const suyas = cuadrillasDe.get(tec.id) ?? new Set()
      const mios = trabajos.filter(
        (w) => w.tecnico_id === tec.id || (!w.tecnico_id && w.cuadrilla_id && suyas.has(w.cuadrilla_id)),
      )
      const sitio = mios.find((w) => w.en_sitio)
      const camino = mios.find((w) => w.en_camino)
      const hechas = mios.filter((w) => w.hecha).length
      const pendientes = mios.length - hechas
      const estado = sitio ? 'en_sitio' : camino ? 'en_camino' : pendientes ? 'con_ruta' : 'libre'
      return { id: tec.id, nombre: tec.nombre, estado, actual: (sitio ?? camino)?.nombre ?? null, total: mios.length, hechas, pendientes }
    })
    .sort((a, b) => ORDEN[a.estado] - ORDEN[b.estado] || b.pendientes - a.pendientes)
}
