import { db, cargarRouter } from '../lib/db.js'
import * as mt from './mikrotikService.js'

/**
 * Mantener al día el address-list del aviso previo.
 *
 * ── Qué es el aviso previo ──
 *
 * La pantalla que ve el abonado ANTES de que se le corte, mientras todavía tiene
 * servicio: "tu factura vence en dos días, podés pagarla acá". Es el aviso más
 * barato que existe —no cuesta un mensaje— y llega justo cuando el abonado está
 * usando internet, que es cuando más le importa no perderlo.
 *
 * ── Por qué esto es una sincronización y no una acción ──
 *
 * Porque la respuesta cambia sola con el calendario: hoy le toca a este abonado
 * y pasado mañana ya no, sin que nadie haya hecho nada. Lo que hay que hacer no
 * es "avisarle", es dejar la lista del router igual a la lista que dice la base:
 * meter a los que entraron a su ventana y sacar a los que salieron.
 *
 * ── Los tres motivos por los que alguien sale ──
 *
 * Pagó, se le cortó, o se le apagó el aviso en su ficha. El del corte importa
 * especialmente: si quedara en las dos listas, la primera regla que coincida
 * decide qué página ve — y bien podría ser la de "tu factura está por vencer"
 * cuando ya se quedó sin servicio.
 */

const MARCA = 'Aviso de pago'

/**
 * ¿Este router redirige de verdad esa lista?
 *
 * Meter abonados en una lista que ninguna regla mira no hace nada, y lo peor es
 * que no falla: las entradas se acumulan en el equipo y el abonado nunca ve la
 * página. Ya nos pasó con la lista de morosos.
 *
 * Se consulta una vez por router y por corrida.
 */
async function redirigeDeVerdad(equipo, lista, cache) {
  const clave = `${equipo.id}:${lista}`
  if (cache.has(clave)) return cache.get(clave)

  let respuesta = false
  try {
    const nat = await mt.listarReglasNat(equipo)
    respuesta = (nat ?? []).some(
      (r) =>
        String(r.disabled ?? 'false') !== 'true' &&
        ['redirect', 'dst-nat'].includes(r.action) &&
        String(r['src-address-list'] ?? '').toLowerCase() === String(lista).toLowerCase(),
    )
  } catch {
    // No se pudieron leer las reglas: se asume que sí, para no dejar de avisarle
    // a nadie por un problema de lectura. Lo peor que pasa es una entrada que no
    // se ve; lo contrario sería no avisar y creer que se avisó.
    respuesta = true
  }

  cache.set(clave, respuesta)
  return respuesta
}

/**
 * Deja el router igual a lo que dice la base.
 *
 * @param simular  true = devuelve qué haría, sin tocar nada
 */
export async function sincronizarAvisoPantalla({ simular = false } = {}) {
  const [rPoner, rSacar] = await Promise.all([
    db().from('v_aviso_pantalla_a_poner').select('*'),
    db().from('v_aviso_pantalla_a_sacar').select('*'),
  ])

  if (rPoner.error) {
    const falta = /does not exist/i.test(rPoner.error.message)
    if (falta) return { puestos: [], sacados: [], sinMigracion: true }
    throw new Error(`No se pudo leer a quién avisar: ${rPoner.error.message}`)
  }
  if (rSacar.error) throw new Error(`No se pudo leer a quién sacar: ${rSacar.error.message}`)

  const aPoner = rPoner.data ?? []
  const aSacar = rSacar.data ?? []

  if (simular) return { simulado: true, pendientes_poner: aPoner, pendientes_sacar: aSacar }

  const routers = new Map()
  const equipo = async (id) => {
    if (!routers.has(id)) routers.set(id, await cargarRouter(id))
    return routers.get(id)
  }

  const cache = new Map()
  const puestos = []
  const sacados = []
  const fallidos = []

  /**
   * Primero SACAR y después poner.
   *
   * Al revés, un abonado que acaba de cortarse podría quedar un instante en las
   * dos listas, y ahí la página que ve depende de cuál regla coincida primero.
   */
  for (const s of aSacar) {
    try {
      const eq = await equipo(s.router_id)
      if (s.routeros_id) {
        await mt.desbloquear(eq, s.routeros_id)
      } else {
        const entradas = await mt.listarBloqueos(eq, s.lista || eq.lista_aviso)
        for (const e of entradas.filter((x) => x.address === s.ip)) {
          await mt.desbloquear(eq, e['.id'])
        }
      }
      await db().from('firewall_bloqueos').update({ activo: false }).eq('id', s.bloqueo_id)
      sacados.push({ cliente: s.nombre, ip: s.ip, porque: s.estado })
    } catch (err) {
      fallidos.push({ accion: 'sacar', cliente: s.nombre, ip: s.ip, error: err.message })
    }
  }

  for (const p of aPoner) {
    try {
      const eq = await equipo(p.router_id)

      if (!(await redirigeDeVerdad(eq, p.lista_aviso, cache))) {
        fallidos.push({
          accion: 'poner',
          cliente: p.nombre,
          ip: p.ip,
          error: `El router no tiene ninguna regla que redirija la lista "${p.lista_aviso}": el abonado no vería nada`,
        })
        continue
      }

      const dias = Math.abs(Number(p.dias ?? 0))
      const respuesta = await mt.bloquearIp(eq, {
        address: p.ip,
        lista: p.lista_aviso,
        comment: `${MARCA} · vence en ${dias} ${dias === 1 ? 'día' : 'días'}`,
      })
      const entrada = Array.isArray(respuesta) ? respuesta[0] : respuesta

      await db().from('firewall_bloqueos').insert({
        router_id: p.router_id,
        cliente_id: p.cliente_id,
        cliente_ip: p.ip,
        // Es la acción que ya existía para esto: al abonado no se lo corta, se
        // lo redirige a una página.
        tipo_accion: 'REDIRECCION_PAGO',
        comentario: `${MARCA} · vence en ${dias} ${dias === 1 ? 'día' : 'días'}`,
        lista: p.lista_aviso,
        routeros_id: entrada?.ret ?? entrada?.['.id'] ?? null,
        activo: true,
      })

      puestos.push({ cliente: p.nombre, ip: p.ip, dias: p.dias, saldo: p.saldo })
    } catch (err) {
      fallidos.push({ accion: 'poner', cliente: p.nombre, ip: p.ip, error: err.message })
    }
  }

  return { puestos, sacados, fallidos }
}
