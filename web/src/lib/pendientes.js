/**
 * Los pendientes administrativos, del lado del navegador (migración 225).
 *
 * Sin imports a propósito: se prueba con el runner del middleware.
 *
 * Un pendiente NO es un ticket: no va a la ruta, no tiene plazo de atención ni
 * cuenta en el desempeño. Es "acordate de hacer esto con este abonado".
 */

export const TIPOS_PENDIENTE = [
  { valor: 'cambio_plan', label: 'Cambio de plan' },
  { valor: 'firma_contrato', label: 'Firma del contrato' },
  { valor: 'copia_cedula', label: 'Copia de cédula' },
  { valor: 'cobro', label: 'Cobro' },
  { valor: 'cambio_datos', label: 'Cambio de datos' },
  { valor: 'reconexion', label: 'Reconexión' },
  { valor: 'otro', label: 'Otro' },
]

export const etiquetaPendiente = (v) => TIPOS_PENDIENTE.find((t) => t.valor === v)?.label ?? v ?? 'Otro'

/**
 * Cómo está un pendiente hoy.
 *
 *   'hecho'      ya se hizo
 *   'vencido'    tenía fecha y ya pasó
 *   'hoy'        es para hoy
 *   'proximo'    tiene fecha más adelante
 *   'sin_fecha'  cuando se pueda
 *
 * @param hoy  'AAAA-MM-DD' local
 */
export function estadoPendiente(p, hoy) {
  if (p?.hecho_at) return 'hecho'
  if (!p?.vence_el) return 'sin_fecha'
  const f = String(p.vence_el).slice(0, 10)
  if (f < hoy) return 'vencido'
  if (f === hoy) return 'hoy'
  return 'proximo'
}

const PESO = { vencido: 0, hoy: 1, proximo: 2, sin_fecha: 3, hecho: 4 }

/**
 * Lo más urgente arriba: vencidos, de hoy, con fecha, sin fecha y al final los
 * hechos (el último hecho primero). Dentro de cada grupo, por fecha.
 */
export function ordenarPendientes(lista = [], hoy) {
  return [...lista].sort((a, b) => {
    const ea = estadoPendiente(a, hoy)
    const eb = estadoPendiente(b, hoy)
    if (PESO[ea] !== PESO[eb]) return PESO[ea] - PESO[eb]
    if (ea === 'hecho') return String(b.hecho_at).localeCompare(String(a.hecho_at))
    return String(a.vence_el ?? '9999').localeCompare(String(b.vence_el ?? '9999')) ||
      String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
  })
}

const normal = (v) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

/**
 * ¿Este pendiente es del mismo abonado que este ticket?
 *
 * Por la ficha si los dos la tienen; si no, por la cédula; y si tampoco, por el
 * nombre completo igual (sin tildes ni mayúsculas). Casi todos los tickets no
 * tienen ficha —los abonados siguen en MikroWISP—, así que el nombre es lo que
 * más va a coincidir.
 */
export function esDelMismoAbonado(pendiente, ticket) {
  if (pendiente.client_id && ticket.client_id) return pendiente.client_id === ticket.client_id
  const ced = (v) => String(v ?? '').replace(/\D/g, '')
  if (ced(pendiente.identificacion).length >= 10 && ced(ticket.identificacion).length >= 10) {
    return ced(pendiente.identificacion) === ced(ticket.identificacion)
  }
  return normal(pendiente.nombre) !== '' && normal(pendiente.nombre) === normal(ticket.nombre)
}

/**
 * ¿Es probable que este ticket no sea soporte?
 *
 * Para sugerir "pasarlo a Pendientes" en la bandeja: solo palabras que en un
 * reclamo técnico no aparecen. No decide nada; quien lo ve lo pasa o no.
 */
const ADMINISTRATIVO = [
  /cambi\w* (de )?plan/, /cambiar a \$/, /\$\s?\d+[.,]\d{2}/, /firm\w* (el |del )?contrato/,
  /copia (de )?(la )?cedula/, /reconexion/, /cobr(ar|o)\b/, /cambio de (nombre|titular|datos)/,
]
export function pareceAdministrativo(ticket) {
  const texto = normal([ticket?.descripcion, ticket?.incidencia_otro].join(' '))
  return ADMINISTRATIVO.some((r) => r.test(texto))
}
