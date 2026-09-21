import { db } from '../lib/db.js'
import { AppError } from '../lib/errors.js'
import * as mt from './mikrotikService.js'

/**
 * Preparar un MikroTik para cortar y limitar en IPv6.
 *
 * ── Qué problema resuelve ──
 *
 * El sistema corta metiendo la IP del moroso en un `address-list` de
 * `/ip/firewall`. Eso es IPv4 y nada más. El día que el ISP entregue IPv6, el
 * cortado queda bloqueado en v4 y **sigue navegando por v6** — y como Google,
 * YouTube y Netflix responden por IPv6, para él no cambia casi nada. El sistema
 * anota el corte como hecho y el cliente sigue conectado.
 *
 * ── Por qué en dos pasos ──
 *
 * Es el mismo criterio que usa `reparar` y que usa `adopcionCorte`: primero se
 * muestra qué se va a tocar y recién después se toca. Acá se escribe en el
 * firewall de un equipo con abonados adentro, así que ver antes no es una
 * cortesía — es la diferencia entre un cambio y un susto.
 *
 * ── Por qué sirve para radioenlace igual que para fibra ──
 *
 * Todo lo que hace son reglas de capa 3 en el router. No mira la OLT, ni la
 * ONU, ni el tipo de conexión del abonado. Un cliente por radio con un prefijo
 * IPv6 delegado se corta exactamente igual que uno de fibra.
 */

/** Lo que el sistema deja puesto. Se reconoce por el comentario. */
const REGLAS = [
  {
    comentario: 'SmartOLT-CorteMorosos-v6-salida',
    campo: 'src-address-list',
    porque: 'corta lo que el moroso intenta sacar a internet',
  },
  {
    comentario: 'SmartOLT-CorteMorosos-v6-entrada',
    campo: 'dst-address-list',
    porque:
      'corta lo que entra hacia su prefijo. En IPv6 no hay NAT: sin esta regla, ' +
      'el cortado sigue siendo alcanzable desde afuera y contestando',
  },
]

async function equipo(id) {
  const { data, error } = await db().from('routers_mikrotik').select('*').eq('id', id).single()
  if (error || !data) throw new AppError('No se encontró el router', { status: 404 })
  return data
}

/**
 * El script de RouterOS equivalente, para poder leerlo antes de aplicarlo.
 *
 * No se ejecuta: el sistema aplica cada cambio por la API, que es idempotente y
 * puede informar qué hizo. Esto está para que quien aprieta el botón vea
 * exactamente qué le va a quedar al equipo —y para poder pegarlo a mano si
 * alguna vez hace falta hacerlo sin el sistema.
 */
export function scriptDe(lista) {
  return [
    '# Corte de morosos en IPv6 — lo deja SmartOLT',
    '# Se puede pegar en New Terminal. Es idempotente: correrlo dos veces no duplica.',
    '',
    ...REGLAS.flatMap((r) => [
      `# ${r.porque}`,
      `/ipv6 firewall filter`,
      `add chain=forward ${r.campo}=${lista} action=drop comment="${r.comentario}" \\`,
      `    place-before=[find where chain=forward and action=accept]`,
      '',
    ]),
    '# La lista se llena sola: el sistema mete y saca los prefijos al cortar y al cobrar.',
  ].join('\n')
}

/**
 * Qué falta en este router. No toca nada.
 */
export async function revisar(id) {
  const router = await equipo(id)
  const lista = router.ipv6_lista_morosos || 'CORTE_MOROSOS_V6'

  const soporte = await mt.soportaIpv6(router)
  if (!soporte.disponible) {
    return {
      router: { id: router.id, nombre: router.nombre, ipv6_activo: router.ipv6_activo },
      lista,
      soportaIpv6: false,
      motivo: soporte.motivo,
      sugerencia: soporte.sugerencia,
      faltan: [],
      script: scriptDe(lista),
    }
  }

  const reglas = await mt.listarReglasFilterIpv6(router)
  const puestas = REGLAS.map((r) => ({
    ...r,
    existe: reglas.some((x) => x.comment === r.comentario),
  }))

  const enLista = await mt.listarBloqueosIpv6(router, lista).catch(() => [])

  return {
    router: { id: router.id, nombre: router.nombre, ipv6_activo: router.ipv6_activo },
    lista,
    soportaIpv6: true,
    reglas: puestas,
    faltan: puestas.filter((r) => !r.existe),
    listo: puestas.every((r) => r.existe),
    cortadosAhora: enLista.length,
    preparado_at: router.ipv6_preparado_at,
    script: scriptDe(lista),
  }
}

/**
 * Deja las reglas puestas y marca el router como preparado.
 *
 * `encender` prende además el interruptor de la ficha: sin eso las reglas
 * existen pero el sistema no las usa al cortar, que es peor que no tenerlas
 * —parece configurado y no corta—.
 */
export async function preparar(id, { encender = true } = {}) {
  const router = await equipo(id)
  const lista = router.ipv6_lista_morosos || 'CORTE_MOROSOS_V6'

  const soporte = await mt.soportaIpv6(router)
  if (!soporte.disponible) {
    throw new AppError(`${router.nombre} no responde en IPv6`, {
      status: 409,
      hint: soporte.sugerencia,
    })
  }

  const resultado = await mt.asegurarReglaCorteIpv6(router, lista)

  const cambios = { ipv6_preparado_at: new Date().toISOString() }
  if (encender) cambios.ipv6_activo = true

  const { error } = await db().from('routers_mikrotik').update(cambios).eq('id', id)
  if (error) {
    /**
     * Las reglas quedaron puestas pero la ficha no se enteró.
     *
     * Se avisa en vez de fallar en silencio: el equipo está bien y lo único que
     * falta es un campo. Volver a apretar el botón lo arregla, y mientras tanto
     * nada se rompió — las reglas de más no cortan a nadie porque la lista está
     * vacía.
     */
    return {
      ...resultado,
      aviso: `Las reglas quedaron en ${router.nombre}, pero no se pudo marcar la ficha: ${error.message}`,
    }
  }

  return { ...resultado, ipv6_activo: encender, lista }
}

/** Apaga el uso de IPv6 sin tocar el equipo. */
export async function apagar(id) {
  const { error } = await db()
    .from('routers_mikrotik')
    .update({ ipv6_activo: false })
    .eq('id', id)
  if (error) throw new AppError(`No se pudo apagar: ${error.message}`, { status: 502 })

  return {
    ipv6_activo: false,
    // Las reglas se dejan: borrarlas obligaría a rehacerlas al volver a
    // encender, y con la lista vacía no cortan a nadie.
    aviso: 'El sistema deja de usar IPv6 en este router. Las reglas quedan en el equipo, inactivas.',
  }
}
