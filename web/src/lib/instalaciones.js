/**
 * Reglas del ciclo de vida de una instalación.
 *
 * Viven acá porque las comparten tres pantallas —la agenda de la oficina, el
 * asistente del celular y la ficha del abonado— y porque son reglas del
 * negocio, no decisiones de diseño: un trabajo no se puede cerrar sin que
 * alguien haya medido la señal, y eso tiene que valer igual en las tres.
 */
import { supabase } from './supabaseClient'

/**
 * Los estados de una orden de instalación.
 *
 * ── Por qué son once y no cinco ──
 *
 * Los cinco originales alcanzaban cuando la orden la cargaba la misma persona
 * que la despachaba. Desde que la venta llega sola desde el expediente del
 * vendedor, hay una etapa entera que antes no existía: alguien tiene que
 * REVISAR lo que llegó —que la cédula se lea, que la ubicación tenga sentido—
 * antes de comprometer a un técnico.
 *
 * `nueva` y `revisando` son eso. Y `en_ruta`, `no_realizada` y `reprogramada`
 * son lo que pasa de verdad en la calle: el técnico salió, no había nadie, y
 * hay que volver otro día. Antes todo eso caía en `cancelada`, que mezclaba
 * "el cliente desistió" con "no estaba en la casa" — dos cosas que se atienden
 * distinto.
 */
export const ESTADOS = {
  nueva: {
    label: 'Nueva',
    color: 'violeta',
    clase: 'bg-violet-500/15 text-violet-300 border-violet-500/40',
    ayuda: 'Llegó del vendedor con el expediente completo. Falta revisarla.',
  },
  revisando: {
    label: 'Revisando',
    color: 'ambar',
    clase: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
    ayuda: 'Alguien está verificando la documentación y la ubicación.',
  },
  lista_asignar: {
    label: 'Lista para asignar',
    color: 'azul',
    clase: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
    ayuda: 'Documentación aprobada. Falta elegir técnico y fecha.',
  },
  prospecto: {
    label: 'Prospecto',
    color: 'gris',
    clase: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
    ayuda: 'Pidió el servicio. Falta saber si le llega.',
  },
  agendada: {
    label: 'Agendada',
    color: 'azul',
    clase: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
    ayuda: 'Es factible, tiene día y tiene quién vaya.',
  },
  en_curso: {
    label: 'En curso',
    color: 'ambar',
    clase: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
    ayuda: 'El técnico está en el domicilio instalando.',
  },
  hecha: {
    label: 'Hecha',
    color: 'verde',
    clase: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
    ayuda: 'Quedó instalado y el abonado pasó a Usuarios.',
  },
  en_ruta: {
    label: 'En ruta',
    color: 'ambar',
    clase: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
    ayuda: 'El técnico salió para allá.',
  },
  no_realizada: {
    label: 'No realizada',
    color: 'rojo',
    clase: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
    ayuda: 'Fue y no se pudo: no había nadie, faltaba material, no era factible.',
  },
  reprogramada: {
    label: 'Reprogramada',
    color: 'gris',
    clase: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
    ayuda: 'Se pasó para otro día. Vuelve a la agenda con fecha nueva.',
  },
  cancelada: {
    label: 'Cancelada',
    color: 'rojo',
    clase: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
    ayuda: 'No se hizo y no se va a hacer: el cliente desistió.',
  },
}

/** Las que todavía requieren trabajo de alguien. */
export const ESTADOS_ABIERTOS_INST = [
  'nueva', 'revisando', 'lista_asignar', 'prospecto', 'agendada', 'en_ruta', 'en_curso', 'reprogramada',
]

/** Las que esperan una decisión del backoffice, no del técnico. */
export const ESTADOS_BACKOFFICE = ['nueva', 'revisando', 'lista_asignar']

export const FACTIBILIDAD = {
  pendiente: {
    label: 'Sin revisar',
    color: 'gris',
    ayuda: 'Todavía nadie miró si hay cobertura en esa dirección.',
  },
  factible: {
    label: 'Factible',
    color: 'verde',
    ayuda: 'Hay caja o torre cerca con lugar libre.',
  },
  con_obra: {
    label: 'Con obra',
    color: 'ambar',
    ayuda: 'Llega, pero hay que tender, poner un poste o ampliar la caja.',
  },
  no_factible: {
    label: 'No factible',
    color: 'rojo',
    ayuda: 'Fuera de alcance. Queda registrado para cuando se amplíe la red.',
  },
}

export const TECNOLOGIAS = {
  ftth: { label: 'Fibra (FTTH)', equipo: 'ONT', punto: 'caja NAP' },
  wireless: { label: 'Inalámbrico', equipo: 'antena CPE', punto: 'torre' },
}

export const TIPOS = [
  { valor: 'nueva', label: 'Instalación nueva' },
  { valor: 'traslado', label: 'Traslado' },
  { valor: 'reparacion', label: 'Reparación' },
  { valor: 'revision', label: 'Revisión' },
  { valor: 'retiro', label: 'Retiro de equipos' },
]

export const FRANJAS = {
  manana: 'Mañana (08:00 – 12:00)',
  tarde: 'Tarde (13:00 – 18:00)',
  exacta: 'Hora exacta',
}

/** Los cinco pasos del asistente, en orden. */
export const PASOS = [
  { n: 1, titulo: 'Lectura del equipo', corto: 'Equipo' },
  { n: 2, titulo: 'Autenticación y potencia', corto: 'Señal' },
  { n: 3, titulo: 'Parámetros de red', corto: 'Red' },
  { n: 4, titulo: 'Test de salida', corto: 'Pruebas' },
  // Antes del cierre y no después: una vez que el alta se finaliza, el
  // asistente se cierra y el técnico ya está guardando la escalera. Lo que no
  // se descuenta acá no se descuenta nunca, y el inventario empieza a mentir.
  { n: 5, titulo: 'Material utilizado', corto: 'Material' },
  { n: 6, titulo: 'Cierre y alta', corto: 'Cierre' },
]

/**
 * Umbrales del semáforo.
 *
 * ── De dónde salen ──
 *
 * De `parametros_tecnicos`, la tabla de una fila que creó la migración 84. Los
 * valores de acá abajo son solo el arranque: lo que se muestra hasta que llega
 * la respuesta del servidor, y la red de seguridad si esa consulta falla.
 *
 * Se cargan una vez por sesión, en `cargarParametros()`, y no con un hook. El
 * umbral no cambia mientras alguien instala; volverlo reactivo obligaría a
 * convertir en componente cada función que hoy calcula un color, a cambio de
 * nada. Es el mismo criterio que el símbolo de la moneda en `formato.js`.
 *
 * ── Por qué el técnico los necesita en el navegador ──
 *
 * Porque tiene que ver el color EN EL MOMENTO de la lectura, parado en la
 * vereda y antes de guardar nada. Si el color solo viniera de la vista, tendría
 * que grabar para saber si la instalación quedó bien.
 */
export const OPTICA = { optimo: -25, limite: -27, saturado: -8 }
export const RADIO = { optimo: -70, limite: -80, ccqMinimo: 80 }

/** Qué se considera una entrega bien hecha. Mismo origen, misma lógica. */
export const PRUEBAS = {
  pingBuenoMs: 30,
  pingLimiteMs: 80,
  perdidaMaximaPct: 2,
  velocidadMinimaPct: 80,
}

let parametrosCargados = false

/**
 * Trae los umbrales configurados y los deja aplicados.
 *
 * Muta los objetos en lugar de reemplazarlos porque media docena de módulos ya
 * los importaron por referencia. Reasignar `OPTICA = {...}` los dejaría a todos
 * mirando el objeto viejo, que es la clase de error que no da ningún síntoma:
 * el sistema sigue andando y sigue usando los números de antes.
 *
 * Si falla, no pasa nada: quedan los de arranque, que son los que el sistema
 * usó siempre. Un semáforo con los valores por defecto es infinitamente mejor
 * que una pantalla que no abre.
 */
export async function cargarParametros() {
  if (parametrosCargados) return { OPTICA, RADIO, PRUEBAS }
  // Sin red no se intenta: dejaría una consulta colgada en el arranque, que es
  // justo el momento en que el técnico está mirando una pantalla vacía. Los
  // valores de fábrica alcanzan hasta que vuelva la señal.
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { OPTICA, RADIO, PRUEBAS }
  try {
    const { data, error } = await supabase
      .from('parametros_tecnicos')
      .select('*')
      .eq('id', 1)
      .maybeSingle()
    if (error || !data) throw error ?? new Error('sin parámetros')

    OPTICA.optimo = Number(data.optica_optimo)
    OPTICA.limite = Number(data.optica_limite)
    OPTICA.saturado = Number(data.optica_saturado)

    RADIO.optimo = Number(data.radio_optimo)
    RADIO.limite = Number(data.radio_limite)
    RADIO.ccqMinimo = Number(data.radio_ccq_minimo)

    PRUEBAS.pingBuenoMs = Number(data.ping_bueno_ms)
    PRUEBAS.pingLimiteMs = Number(data.ping_limite_ms)
    PRUEBAS.perdidaMaximaPct = Number(data.perdida_maxima_pct)
    PRUEBAS.velocidadMinimaPct = Number(data.velocidad_minima_pct)

    parametrosCargados = true
  } catch (err) {
    console.warn('No se pudieron leer los parámetros técnicos, se usan los de fábrica:', err)
  }
  return { OPTICA, RADIO, PRUEBAS }
}

/**
 * El semáforo de una prueba de salida.
 *
 * Estaba sin hacer: el paso de pruebas guardaba ping y velocidad y no decía si
 * estaban bien. El técnico anotaba 45 Mbps en un plan de 100 y se iba.
 */
export function semaforoPruebas({ ping_ms, ping_perdida, test_bajada_mbps }, planMbps) {
  if (ping_ms == null && test_bajada_mbps == null) return null

  if (
    (ping_ms != null && ping_ms > PRUEBAS.pingLimiteMs) ||
    (ping_perdida != null && ping_perdida > PRUEBAS.perdidaMaximaPct) ||
    (planMbps > 0 &&
      test_bajada_mbps != null &&
      test_bajada_mbps < (planMbps * PRUEBAS.velocidadMinimaPct) / 100)
  ) {
    return 'rojo'
  }
  if (ping_ms != null && ping_ms > PRUEBAS.pingBuenoMs) return 'ambar'
  return 'verde'
}

export function semaforoOptico(rx) {
  if (rx == null) return null
  if (rx < OPTICA.limite || rx > OPTICA.saturado) return 'rojo'
  if (rx < OPTICA.optimo) return 'ambar'
  return 'verde'
}

export function semaforoRadio(senal, ccq) {
  if (senal == null) return null
  if (senal < RADIO.limite) return 'rojo'
  if (senal < RADIO.optimo || (ccq != null && ccq < RADIO.ccqMinimo)) return 'ambar'
  return 'verde'
}

export const semaforoDe = (i) =>
  i?.tecnologia === 'wireless'
    ? semaforoRadio(i?.senal_dbm, i?.ccq)
    : semaforoOptico(i?.rx_power_dbm)

export const COLOR_SEMAFORO = {
  verde: { clase: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40', label: 'Óptimo' },
  ambar: { clase: 'bg-amber-500/15 text-amber-300 border-amber-500/40', label: 'Justo' },
  rojo: { clase: 'bg-rose-500/15 text-rose-300 border-rose-500/40', label: 'Atenuado' },
  // "No se pudo medir" no es un color del semáforo óptico: es la ausencia de
  // medición. Antes caía en rojo y el técnico revisaba conectores sanos porque
  // el equipo no había contestado.
  gris: { clase: 'bg-slate-500/15 text-slate-300 border-slate-500/40', label: 'Sin medición' },
}

/**
 * Qué falta para poder dar de alta.
 *
 * Es la misma lista que valida `finalizar_alta_instalacion` en la base. Se
 * repite acá para poder mostrarla mientras el técnico trabaja, en vez de
 * dejarlo llegar al final y recibir un error.
 */
export function faltantes(i) {
  if (!i) return []
  const falta = []

  if (!i.equipo_sn && !i.equipo_mac) falta.push('Leer la serie o la MAC del equipo')
  if (!i.lectura_at) falta.push('Medir la señal contra la OLT o la radio')

  if (i.tipo_conexion === 'pppoe') {
    if (!i.usuario_ppp) falta.push('Asignar el usuario PPPoE')
  } else if (i.tipo_ip === 'fija' && !i.ip) {
    falta.push('Asignar la IP')
  }

  if (!i.pruebas_at) falta.push('Correr el test de salida')
  if (!i.firma_b64) falta.push('Tomar la firma de conformidad')

  return falta
}

/** Hasta qué paso llegó de verdad, mirando los datos y no el contador. */
export function pasoAlcanzado(i) {
  if (!i) return 1
  // La firma manda sobre las pruebas: si ya firmó, el trabajo está en el
  // cierre. El material se salta acá a propósito — se llega a él avanzando,
  // no se rebobina a alguien que ya está por finalizar.
  if (i.firma_b64) return 6
  if (i.pruebas_at) return 5
  if (i.usuario_ppp || i.ip) return 4
  if (i.lectura_at) return 3
  if (i.equipo_sn || i.equipo_mac) return 2
  return 1
}

/**
 * Normaliza lo que devolvió el escáner.
 *
 * Los QR de las ONT no traen solo la serie: vienen con etiquetas ("SN:"), con
 * la MAC pegada abajo, o como una URL del fabricante. Sacar eso a mano en la
 * calle es donde se cuela el error que después hace que "la ONT no aparezca".
 */
export function leerEtiqueta(texto) {
  const crudo = String(texto ?? '').trim()
  if (!crudo) return { sn: null, mac: null }

  const mac = crudo.match(/([0-9A-F]{2}[:-]){5}[0-9A-F]{2}/i)?.[0] ?? null

  // Serie GPON: cuatro letras del fabricante y ocho hexadecimales.
  const gpon = crudo.match(/\b([A-Z]{4}[0-9A-F]{8})\b/i)?.[0] ?? null

  const etiquetada = crudo.match(/\b(?:SN|S\/N|SERIE|SERIAL)\s*[:=]?\s*([A-Z0-9-]{6,32})\b/i)?.[1] ?? null

  // Sin etiqueta ni patrón conocido, si lo escaneado es una sola palabra se
  // toma entera: es lo que pasa con los códigos de barras, que traen la serie
  // pelada.
  const suelto = /^[A-Z0-9-]{6,32}$/i.test(crudo) ? crudo : null

  return {
    sn: (gpon ?? etiquetada ?? suelto)?.toUpperCase() ?? null,
    mac: mac ? mac.toUpperCase().replace(/-/g, ':') : null,
  }
}

/** Una MAC como la escribe RouterOS: mayúsculas y separada por dos puntos. */
export function normalizarMac(texto) {
  const hex = String(texto ?? '').replace(/[^0-9A-F]/gi, '').toUpperCase()
  if (hex.length !== 12) return null
  return hex.match(/.{2}/g).join(':')
}

// NFD separa la tilde de la letra y `\p{Diacritic}` la borra. Escrito como
// rango de caracteres serían marcas que se dibujan encima de la letra anterior
// y en el editor quedan invisibles.
const sinTildes = (t) =>
  String(t ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/**
 * El usuario PPPoE que se propone.
 *
 * "nombre.apellido" es lo que se dicta por teléfono sin deletrear. Cuando no
 * hay nombre cargado se cae a la cédula, que siempre es única: un secret
 * repetido en el router deja a los dos abonados peleando la misma sesión.
 */
export function usuarioSugerido({ nombre, identificacion } = {}) {
  const partes = sinTildes(nombre).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)

  if (!partes.length) return String(identificacion ?? '').replace(/\D/g, '') || ''
  if (partes.length === 1) return partes[0].slice(0, 40)

  // "Jefferson Fabián Oña Riera" → jefferson.ona. Con cuatro palabras el
  // apellido es el tercero, porque acá se usan dos nombres y dos apellidos;
  // con menos, el segundo. El técnico lo puede corregir de todos modos.
  const apellido = partes.length >= 4 ? partes[2] : partes[1]
  return `${partes[0]}.${apellido}`.slice(0, 40)
}

/**
 * Una clave PPPoE que se pueda dictar.
 *
 * Sin caracteres que se confunden al leerlos en voz alta —ni 0/O ni 1/l/I— ni
 * símbolos, que en el teclado de una ONT vieja a veces no se pueden escribir.
 */
export function claveSugerida(largo = 8) {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(largo))
  return Array.from(bytes, (b) => alfabeto[b % alfabeto.length]).join('')
}

/** "-24.5 dBm", "84 %", "12.3 ms" — vacío se muestra como raya, no como cero. */
export const conUnidad = (valor, unidad, decimales = 1) =>
  valor == null || valor === '' ? '—' : `${Number(valor).toFixed(decimales)} ${unidad}`
