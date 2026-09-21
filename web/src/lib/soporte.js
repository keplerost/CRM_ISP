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

export const etiquetaIncidencia = (v) =>
  INCIDENCIAS.find((i) => i.valor === v)?.label ?? v ?? '—'

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
export { aWhatsApp as aWhatsapp, enlaceWhatsApp as enlaceWhatsapp } from './telefono'

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
    return app === 'waze'
      ? `https://waze.com/ul?ll=${latitud},${longitud}&navigate=yes`
      : `https://www.google.com/maps/dir/?api=1&destination=${latitud},${longitud}`
  }

  const texto = [direccion, sector, canton].filter(Boolean).join(', ')
  if (!texto) return null

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
