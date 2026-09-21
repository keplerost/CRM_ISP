import { db, cargarOlt } from '../lib/db.js'
import * as olts from './oltService.js'

/**
 * El desarme del origen en un traslado de domicilio.
 *
 * ── Qué problema resuelve ──
 *
 * Cuando un abonado se muda, el sistema tiene que hacer dos cosas en dos
 * lugares: dar de alta el servicio en el sector nuevo y darlo de baja en el
 * viejo. La primera la hace el técnico parado en la casa nueva. La segunda no
 * la puede hacer nadie que esté ahí: necesita las credenciales de la OLT de
 * origen, que puede ser un equipo distinto en otro cantón.
 *
 * Hasta ahora esa segunda mitad era una llamada por teléfono a la oficina. Esto
 * la hace sola, en el único momento en que se sabe con certeza que el abonado
 * ya no está en la dirección vieja: cuando su ONT aparece autorizada en la nueva.
 *
 * ── Por qué acá es seguro borrar y en un cambio de ONT no ──
 *
 * En el cambio de equipo la ONT vieja se borra con el abonado esperando: si
 * algo sale mal, queda sin servicio en su casa. Acá no. En el momento en que
 * esto corre, la fibra del domicilio viejo ya está desconectada —el abonado se
 * mudó, su ONT está enchufada en otro lado— así que la ONT de origen no le está
 * dando servicio a nadie. Es un registro colgado, no un cliente conectado.
 */

/** Dos series son la misma aunque estén escritas en distinta notación. */
const normalizar = (sn) =>
  String(sn ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s:-]/g, '')

/**
 * ¿Esta instalación cierra un traslado que todavía tiene la ONT vieja viva?
 *
 * ── Por qué exige `tipo = 'traslado'` ──
 *
 * Sin eso alcanzaba con que el abonado tuviera una mudanza agendada para que
 * CUALQUIER autorización suya desarmara el domicilio viejo — por ejemplo la de
 * una reparación hecha en la casa vieja tres días antes de la mudanza, que le
 * habría borrado la ONT que estaba usando en ese momento.
 *
 * Se busca primero por la orden y después por el abonado: la orden se puede
 * haber recreado a mano, y el traslado sigue siendo el mismo.
 */
export async function pendienteDe(inst) {
  if (!inst?.client_id || inst.tipo !== 'traslado') return null

  const base = () =>
    db().from('traslados').select('*').eq('estado', 'abierto').eq('pendiente_baja', true)

  const { data: porOrden } = await base().eq('instalacion_id', inst.id).maybeSingle()
  if (porOrden) return porOrden

  const { data } = await base()
    .eq('cliente_id', inst.client_id)
    .order('creado_en', { ascending: false })
    .limit(1)
    .maybeSingle()

  return data ?? null
}

/** ¿El abonado se llevó el mismo aparato? */
export const mismoEquipo = (traslado, sn) =>
  Boolean(traslado?.sn_anterior) && normalizar(traslado.sn_anterior) === normalizar(sn)

/**
 * Saca la ONT vieja de su OLT y libera lo que ocupaba.
 *
 * ── Por qué no tira el alta cuando falla ──
 *
 * Porque son dos cosas independientes y la que importa ya salió bien: el
 * abonado tiene internet en su casa nueva. Que no se haya podido limpiar el
 * origen —la OLT vieja sin responder, por ejemplo— es trabajo de oficina, y
 * hacer fracasar el alta por eso sería castigar al cliente por un problema que
 * no es suyo.
 *
 * Lo que sí se hace es dejarlo dicho: el traslado sigue `pendiente_baja` y
 * vuelve a aparecer en la cola del tablero GPON con el motivo.
 */
export async function bajarOrigen(traslado, { motivo = 'traslado de domicilio' } = {}) {
  const resultado = {
    intentado: true,
    ont_borrada: false,
    ip_liberada: false,
    error: null,
    detalle: null,
  }

  if (!traslado?.onu_anterior_id && !traslado?.sn_anterior) {
    resultado.intentado = false
    resultado.detalle = 'El abonado no tenía ninguna ONT enlazada.'
    await marcarBaja(traslado, resultado.detalle)
    return resultado
  }

  // ── 1. La OLT ──
  //
  // El puerto y el índice salen de la foto que sacó `iniciar_traslado()` antes
  // de que el servicio se moviera. Ese es el motivo de que esa foto exista: acá
  // ya no se puede preguntar dónde estaba.
  if (traslado.olt_anterior_id && traslado.onu_index_anterior != null) {
    try {
      const equipo = await cargarOlt(traslado.olt_anterior_id)
      await olts.eliminarOnu(equipo, {
        frame: 0,
        slot: traslado.slot_anterior ?? 0,
        puerto: traslado.puerto_anterior,
        onuId: traslado.onu_index_anterior,
      })
      resultado.ont_borrada = true
    } catch (err) {
      resultado.error = err.message
    }
  } else {
    // Sin el índice de la ONT no se puede borrar: el comando de la OLT lo pide,
    // y probar con uno cualquiera borraría el equipo de otro abonado del mismo
    // puerto. Se dice y se deja para que lo saque una persona.
    resultado.detalle = traslado.olt_anterior_id
      ? 'No se guardó el índice de la ONT en la OLT: hay que sacarla a mano.'
      : 'No se sabía en qué OLT estaba: hay que sacarla a mano.'
  }

  // ── 2. La fila de la ONU ──
  //
  // Solo si el equipo confirmó la baja. Borrarla igual dejaría al sistema
  // diciendo que esa ONT no existe mientras sigue ocupando un índice en la OLT
  // — y entonces nadie la encuentra nunca más.
  if (resultado.ont_borrada && traslado.onu_anterior_id) {
    await db().from('onus').delete().eq('id', traslado.onu_anterior_id)
  }

  // ── 3. La dirección IP ──
  //
  // Vuelve al pool. Sin esto, cada mudanza deja una IP ocupada por nadie, y a
  // los seis meses el IPAM dice que el segmento está lleno cuando tiene lugar.
  //
  // Se libera aunque la OLT haya fallado: son dos recursos distintos y la IP no
  // depende de que la ONT se haya podido borrar.
  if (traslado.ip_anterior && traslado.router_anterior_id) {
    const { error } = await db()
      .from('ip_addresses')
      .update({ estado: 'libre', onu_id: null })
      .eq('router_id', traslado.router_anterior_id)
      .eq('ip_address', traslado.ip_anterior)
    resultado.ip_liberada = !error
  }

  // ── 4. El registro ──
  //
  // Sale de la cola SOLO si el equipo confirmó la baja. Cualquier otra cosa
  // —la OLT sin responder, o no saber el índice— deja una ONT autorizada que
  // nadie va a volver a mirar si la sacamos de la lista. Y la lista es
  // exactamente "ONTs viejas que siguen vivas": esta sigue viva.
  //
  // La tentación es marcarla resuelta cuando no hay nada que reintentar
  // automáticamente. Es al revés: cuando no hay nada automático que hacer es
  // cuando más hace falta que una persona lo vea.
  if (resultado.ont_borrada) {
    await marcarBaja(
      traslado,
      [
        `Baja automática al autorizar en el destino (${motivo}).`,
        `ONT ${traslado.sn_anterior} borrada de la OLT.`,
        resultado.ip_liberada ? `IP ${traslado.ip_anterior} liberada.` : null,
      ]
        .filter(Boolean)
        .join(' '),
    )
  } else {
    await db()
      .from('traslados')
      .update({
        baja_detalle: resultado.error
          ? `No se pudo dar de baja: ${resultado.error}`
          : resultado.detalle,
      })
      .eq('id', traslado.id)
  }

  return resultado
}

async function marcarBaja(traslado, detalle) {
  await db()
    .from('traslados')
    .update({
      pendiente_baja: false,
      baja_at: new Date().toISOString(),
      baja_detalle: detalle,
    })
    .eq('id', traslado.id)
}

/**
 * El aviso para el técnico, en su idioma.
 *
 * Nunca dice "listo" cuando quedó algo colgado: una ONT fantasma en la OLT
 * vieja es invisible hasta el día que alguien intenta usar ese índice.
 */
export function avisoDeBaja(r) {
  if (!r || r.intentado === false) return null
  if (r.ont_borrada) {
    return `La ONT anterior (${r.sn ?? 'la del domicilio viejo'}) se dio de baja sola.${
      r.ip_liberada ? ' Su IP volvió al pool.' : ''
    }`
  }
  return (
    'El servicio quedó andando, pero NO se pudo dar de baja la ONT del domicilio anterior' +
    (r.error ? ` (${r.error})` : '') +
    '. Quedó en la cola del tablero GPON para que la saquen desde la oficina.'
  )
}
