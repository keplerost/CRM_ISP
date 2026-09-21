import { db } from '../lib/db.js'
import { aAsciiParaEquipo } from '../lib/nombres.js'

/**
 * Lo que el técnico tiene que escribir en la ONT cuando no hay TR069.
 *
 * Varios de los modelos que usa este ISP no aceptan configuración remota. Con
 * esos, el alta automática deja la ONT registrada y con servicio, pero el
 * usuario y la clave PPPoE, la VLAN y el WiFi hay que cargarlos entrando a la
 * interfaz web del equipo.
 *
 * Hoy esos datos están en tres pantallas distintas y el técnico los junta a
 * mano arriba de una escalera. Acá salen juntos, en una sola ficha, en el mismo
 * momento en que hacen falta.
 *
 * Lo que NO hace: inventar datos que no existen. Si la instalación no tiene
 * usuario PPPoE, la ficha lo dice en vez de mostrar un campo vacío que se lee
 * como "no hace falta".
 */

/** Caracteres sin ambigüedad visual: nada de l/I/1 ni O/0. */
const ALFABETO = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * Una clave que se pueda dictar por teléfono.
 *
 * El soporte de un ISP dicta estas claves todo el día. Una "l" y un "1" en una
 * clave generada al azar significan una llamada más, y la llamada la paga el
 * ISP. Por eso el alfabeto excluye los caracteres que se confunden al leerlos.
 */
export function claveLegible(largo = 10) {
  let s = ''
  for (let i = 0; i < largo; i++) {
    s += ALFABETO[Math.floor(Math.random() * ALFABETO.length)]
  }
  return s
}

/**
 * El nombre de red que se le pone al equipo.
 *
 * Se arma con el nombre del ISP y algo que identifique al abonado, sin acentos
 * ni eñes: varios modelos de ONT los rechazan o los guardan mal, y el abonado
 * termina viendo una red con signos raros.
 */
export function ssidSugerido({ marca = 'WIFI', nombre, sn }) {
  const persona = aAsciiParaEquipo(String(nombre ?? '').trim())
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join('_')
    .toUpperCase()

  // Sin nombre, los últimos cuatro del serial: es feo pero es único, y una red
  // llamada solo "WIFI" en un barrio donde hay veinte iguales no le sirve a
  // nadie.
  const cola = persona || String(sn ?? '').slice(-4).toUpperCase()
  return `${aAsciiParaEquipo(marca).toUpperCase()}_${cola}`.slice(0, 32)
}

/**
 * ¿Este modelo acepta configuración remota?
 *
 *   true   sí, se intenta el aprovisionamiento automático
 *   false  no: se va derecho a la ficha manual
 *   null   no se sabe todavía — se intenta igual y se aprende del resultado
 *
 * El tercer caso es el que importa. Tratar "no lo sé" como "no soporta" haría
 * que un modelo nuevo nunca se aprovisione solo; tratarlo como "sí" hace perder
 * unos segundos y deja el dato aprendido para la próxima.
 */
export async function soportaTr069(modelo, marca = null) {
  if (!modelo) return null

  let q = db().from('tipos_ont').select('soporta_tr069').ilike('modelo', modelo)
  if (marca) q = q.ilike('marca', marca)

  const { data } = await q.maybeSingle()
  return data?.soporta_tr069 ?? null
}

/** Deja anotado lo que se aprendió del intento, para no repetirlo con cada ONT. */
export async function anotarSoporteTr069(modelo, funciono, marca = null) {
  if (!modelo) return
  const { data } = await db()
    .from('tipos_ont')
    .select('id, soporta_tr069')
    .ilike('modelo', modelo)
    .maybeSingle()

  // Solo se escribe cuando no se sabía. Un modelo marcado a mano por alguien
  // que probó de verdad vale más que la conclusión de un intento suelto, que
  // pudo fallar por la ONT apagada y no por el modelo.
  if (!data || data.soporta_tr069 != null) return
  await db().from('tipos_ont').update({ soporta_tr069: funciono }).eq('id', data.id)
}

/**
 * La ficha completa para cargar el equipo a mano.
 *
 * Recibe lo que ya se sabe y completa lo que falta. El SSID y la clave del WiFi
 * se generan si no vienen dados: que el técnico los invente en el momento es
 * cómo se termina con cincuenta redes llamadas "WIFI" y la clave "12345678".
 */
export async function armarFichaManual({
  onu,
  instalacion,
  vlan,
  gestion = null,
  marcaSsid = 'WIFI',
}) {
  const faltantes = []

  const usuario = instalacion?.usuario_ppp ?? null
  const clave = instalacion?.clave_ppp ?? null
  if (!usuario) faltantes.push('el usuario PPPoE')
  if (!clave) faltantes.push('la clave PPPoE')

  const ssid = onu?.ssid ?? ssidSugerido({ marca: marcaSsid, nombre: onu?.nombre_cliente, sn: onu?.sn })
  const claveWifi = onu?.clave_wifi ?? claveLegible()

  return {
    // --- Lo que va en la WAN de la ONT ---
    pppoe: { usuario, clave },
    vlan: vlan ?? null,
    modo: 'PPPoE',

    // --- Lo que va en el WiFi ---
    wifi: { ssid, clave: claveWifi },

    // --- La gestión, si la hay ---
    // Va aunque el equipo no acepte TR069: muchos modelos permiten cargarla a
    // mano y con eso el sistema después puede alcanzarlos igual.
    gestion: gestion
      ? {
          ip: gestion.ip,
          mascara: gestion.mascara ?? null,
          gateway: gestion.gateway ?? null,
          dns1: gestion.dns1 ?? null,
          dns2: gestion.dns2 ?? null,
          vlan: gestion.vlan ?? null,
        }
      : null,

    // Lo que la ficha NO puede completar. Se dice explícitamente: un campo
    // vacío se lee como "no hace falta" y el técnico lo saltea.
    faltantes,
    completa: faltantes.length === 0,
  }
}

/** Guarda en la ONU el WiFi que se le configuró, para poder dárselo al abonado después. */
export async function guardarConfiguracionManual(onuId, { ssid, clave_wifi, configurada_por = 'manual' }) {
  const campos = { configurada_por, configurada_at: new Date().toISOString() }
  if (ssid) campos.ssid = String(ssid).slice(0, 64)
  if (clave_wifi) campos.clave_wifi = String(clave_wifi).slice(0, 128)

  const { data, error } = await db()
    .from('onus')
    .update(campos)
    .eq('id', onuId)
    .select('id, ssid, clave_wifi, configurada_por, configurada_at')
    .maybeSingle()

  if (error) throw error
  return data
}
