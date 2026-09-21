import { db, cargarRouter } from '../lib/db.js'
import * as mt from './mikrotikService.js'

/**
 * Devolverle el servicio a un abonado que pagó.
 *
 * ── Por qué esto vive en el servidor y no solo en la pantalla de cobro ──
 *
 * Porque hasta ahora el único que reactivaba era el navegador: la pantalla de
 * cobro lee los bloqueos del router, encuentra la IP y la borra. Eso funciona
 * mientras haya alguien mirando la pantalla. Un pago que llega por el webhook
 * de la pasarela a las once de la noche no tiene a nadie mirando, y el abonado
 * que pagó justo para volver a tener internet se queda cortado hasta la mañana
 * — que es exactamente el reclamo que el bot venía a evitar.
 *
 * Es lo mismo que hace `cortesPromesas` para el lado contrario, y por eso usa
 * las mismas piezas: `cargarRouter` descifra las credenciales, `mikrotikService`
 * elige el driver según el modo del equipo.
 *
 * ── Nunca es "no pasó nada" ──
 *
 * Cada camino devuelve una nota que se puede leer en voz alta: el abonado no
 * estaba bloqueado, no tiene router asignado, el router no contestó. Un
 * booleano suelto obliga a ir al log del servidor para saber por qué el cliente
 * sigue sin internet después de pagar.
 */

/**
 * @param clientId  el abonado
 * @param motivo    qué queda escrito en el rastro. Ej: "Pago confirmado #123"
 * @returns {{ ok: boolean, nota: string, estado?: string }}
 */
export async function reactivarServicio(clientId, { motivo = 'Pago registrado' } = {}) {
  const { data: cliente, error } = await db()
    .from('clientes')
    .select('id, nombre, estado, router_id, ip')
    .eq('id', clientId)
    .maybeSingle()

  if (error) return { ok: false, nota: `No se pudo leer la ficha del abonado: ${error.message}` }
  if (!cliente) return { ok: false, nota: 'No existe ese abonado.' }

  if (!cliente.router_id || !cliente.ip) {
    return {
      ok: false,
      nota: 'El abonado no tiene router o IP asignados: hay que reactivarlo a mano.',
      estado: cliente.estado,
    }
  }

  let quitada = false

  try {
    const equipo = await cargarRouter(cliente.router_id)
    const entradas = await mt.listarBloqueos(equipo)

    /**
     * La comparación contempla la máscara.
     *
     * En el address-list la misma IP puede figurar como `10.0.0.5` o como
     * `10.0.0.5/32` según quién la haya cargado. Comparar el texto pelado deja
     * afuera la mitad de los casos, y el abonado queda cortado con el sistema
     * diciendo que no estaba bloqueado.
     */
    const bloqueadas = (Array.isArray(entradas) ? entradas : []).filter((e) => {
      const dir = String(e.address ?? '').split('/')[0]
      return dir === cliente.ip
    })

    // Una entrada dinámica no se puede borrar: la puso otra cosa —un script del
    // router, una lista importada— y el equipo rechaza el DELETE. Se separan
    // para poder avisar en vez de fallar entero: las estáticas sí se quitan.
    const esDinamica = (e) => e.dynamic === 'true' || e.dynamic === true
    const estaticas = bloqueadas.filter((e) => !esDinamica(e))
    const dinamicas = bloqueadas.length - estaticas.length

    for (const entrada of estaticas) {
      await mt.desbloquear(equipo, entrada['.id'] ?? entrada.id)
      quitada = true
    }

    if (!bloqueadas.length) {
      // No estaba cortado en el router, pero la ficha puede decir lo contrario:
      // se sincroniza igual, si no el abonado figura cortado para siempre.
      await marcarActivo(cliente)
      return { ok: true, nota: 'No estaba bloqueado en el router.', estado: 'activo' }
    }

    if (!quitada && dinamicas > 0) {
      return {
        ok: false,
        nota: `La IP ${cliente.ip} está en una entrada dinámica del router: hay que quitarla desde el equipo.`,
        estado: cliente.estado,
      }
    }
  } catch (err) {
    return {
      ok: false,
      nota: `No se pudo desbloquear en el router: ${err.message}`,
      estado: cliente.estado,
    }
  }

  const errEstado = await marcarActivo(cliente)
  if (errEstado) {
    return {
      ok: false,
      nota: `Se quitó ${cliente.ip} del corte, pero el estado del abonado no se actualizó: ${errEstado}`,
      estado: cliente.estado,
    }
  }

  return { ok: true, nota: `Se quitó ${cliente.ip} del corte en el router. ${motivo}.`, estado: 'activo' }
}

/** Deja la ficha en `activo`. Devuelve el mensaje de error, o null si salió bien. */
async function marcarActivo(cliente) {
  if (cliente.estado === 'activo') return null
  // `cortado_en` se limpia junto con el estado: son el mismo hecho contado dos
  // veces, y dejarla puesta haría que el cuarto aviso le siga llegando a quien
  // ya tiene servicio.
  const { error } = await db()
    .from('clientes')
    .update({ estado: 'activo', cortado_en: null })
    .eq('id', cliente.id)
  return error?.message ?? null
}
