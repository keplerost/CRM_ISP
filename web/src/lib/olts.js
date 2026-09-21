import { supabase } from './supabaseClient'

/**
 * Vocabulario y utilidades de la ficha de OLT.
 *
 * El listado se lee de `v_olts` (trae contadores y estado de alcance) pero esa
 * vista tiene joins y por lo tanto no se puede escribir. Las modificaciones van
 * derecho a `olts`, que es lo que hacen las funciones de acá.
 */

export const TR069_INTERFACES = {
  mgmt_ip: { label: 'IP de gestión (recomendada)', ayuda: 'La ONU responde por su IP de administración.' },
  wan_ip: { label: 'IP del WAN', ayuda: 'Se usa la dirección del servicio, no la de gestión.' },
  loopback: { label: 'Loopback', ayuda: 'Interfaz virtual del equipo.' },
  ninguna: { label: 'Ninguna', ayuda: 'TR069 desactivado para las ONUs de esta OLT.' },
}

/** Qué sabe leer el sistema de cada marca hoy. */
export const CAPACIDADES = {
  Huawei: {
    salud: true,
    placas: true,
    puertosPon: true,
    nota: 'Relevado contra un MA5800-X7 con firmware R018.',
  },
  VSOL: {
    salud: false,
    placas: false,
    puertosPon: false,
    nota: 'Falta relevar los comandos contra el equipo. Usá la pestaña de cada área para preguntarle qué acepta.',
  },
}

export const capacidadesDe = (marca) =>
  CAPACIDADES[marca] ?? { salud: false, placas: false, puertosPon: false, nota: 'Marca sin relevar.' }

// --- Escritura ---------------------------------------------------------------

export async function guardarOlt(id, cambios) {
  const { error } = await supabase.from('olts').update(cambios).eq('id', id)
  if (error) throw traducir(error)
}

export async function eliminarOlt(id) {
  const { error } = await supabase.from('olts').delete().eq('id', id)
  if (error) throw traducir(error)
}

function traducir(err) {
  const e = new Error(err.message)
  e.hint = err.hint ?? err.details
  if (err.code === '23503') {
    e.message = 'La OLT tiene registros que dependen de ella'
    e.hint = 'Eliminá o reasigná sus ONUs antes de borrarla.'
  }
  return e
}

// --- Exportación -------------------------------------------------------------

const COLUMNAS_CSV = [
  ['numero', 'ID'],
  ['nombre', 'Nombre'],
  ['marca', 'Marca'],
  ['ip_host', 'IP de gestion'],
  ['puerto_ssh', 'Puerto TCP'],
  ['snmp_puerto', 'Puerto SNMP UDP'],
  ['usuario', 'Usuario'],
  ['hw_version', 'Version de hardware'],
  ['sw_version', 'Version de software'],
  ['pon_tipos', 'Tipos PON'],
  ['estado', 'Estado'],
  ['estado_latencia_ms', 'Latencia ms'],
  ['onus_total', 'ONUs'],
  ['onus_online', 'ONUs online'],
  ['via_vpn', 'Por VPN'],
  ['snmp_trap', 'Escucha traps'],
  ['iptv', 'IPTV'],
  ['ntp_servers', 'Servidores NTP'],
  ['tr069_perfil', 'Perfil TR069'],
  ['activo', 'Activa'],
]

/**
 * CSV para Excel.
 *
 * Separador punto y coma y BOM al principio: con coma, Excel en español mete
 * todo en una sola columna, y sin BOM se come los acentos. Son las dos cosas que
 * hacen que un export "ande" o que llegue ilegible.
 */
export function aCsv(filas) {
  const escapar = (v) => {
    if (v == null) return ''
    const s = typeof v === 'boolean' ? (v ? 'si' : 'no') : String(v)
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  const lineas = [
    COLUMNAS_CSV.map(([, titulo]) => titulo).join(';'),
    ...filas.map((f) => COLUMNAS_CSV.map(([clave]) => escapar(f[clave])).join(';')),
  ]

  return `﻿${lineas.join('\r\n')}`
}

export function descargar(nombre, contenido, tipo = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }))
  const a = document.createElement('a')
  a.href = url
  a.download = nombre
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Sin esto el blob queda retenido en memoria hasta que se recargue la página.
  URL.revokeObjectURL(url)
}

/** "hace 3 min" — un estado de hace tres horas no es un estado. */
export function hace(segundos) {
  if (segundos == null) return 'nunca'
  if (segundos < 60) return 'recién'
  const min = Math.floor(segundos / 60)
  if (min < 60) return `hace ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `hace ${h} h`
  return `hace ${Math.floor(h / 24)} d`
}
