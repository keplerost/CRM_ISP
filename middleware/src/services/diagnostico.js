import { db, cargarRouter, cargarOlt } from '../lib/db.js'
import { badRequest } from '../lib/errors.js'
import * as mk from './mikrotikService.js'
import * as olt from './oltService.js'
import { incidenciaActivaDe } from './incidencias.js'

/**
 * El diagnóstico que contesta "¿por qué no tengo internet?".
 *
 * ── Por qué esto no es "exponer las herramientas técnicas por la API" ──
 *
 * Porque el bot no necesita un traceroute: necesita una CONCLUSIÓN. Si se le
 * devuelve la salida cruda de RouterOS, quien tiene que interpretarla es el
 * proveedor del CRM —que no sabe de GPON— y va a terminar mandándosela al
 * abonado o inventando una traducción propia. La primera vez que un bot le diga
 * a alguien "rx_power_dbm: -31.4" ya perdimos.
 *
 * Así que acá se decide, en el mismo orden en que lo haría alguien de soporte:
 *
 *   1. ¿Hay una avería conocida en su sector?  → se lo decimos y no hay ticket.
 *   2. ¿Está cortado por deuda?                → se lo decimos, con el monto.
 *   3. ¿Su equipo está apagado o sin fibra?    → es de su casa, hay algo que hacer.
 *   4. ¿La señal está baja?                    → hay que ir, pero no es urgencia.
 *   5. Todo bien de nuestro lado.              → recién acá vale abrir un ticket.
 *
 * El orden importa más que las mediciones. Preguntarle a la OLT por la potencia
 * de una ONT que está adentro de un corte de fibra troncal es gastar una sesión
 * SSH para enterarse de lo que ya se sabía.
 *
 * ── Rápido y profundo ──
 *
 * El diagnóstico rápido no toca ningún equipo: usa lo que la base ya sabe. Es
 * el que contesta el 90% de los mensajes y puede correr cien veces por minuto.
 * El profundo abre SSH contra la OLT y pinguea desde el router; es el que se
 * usa cuando el rápido dice "todo bien de nuestro lado" y el abonado insiste.
 */

/**
 * Los cortes de siempre en GPON. Por encima de −25 dBm está bien.
 *
 * Se exporta para poder probar los umbrales: son el límite entre "mandamos un
 * técnico" y "decile que reinicie", y moverlos medio dB cambia a quién se
 * visita esta semana.
 */
export function calidadOptica(dbm) {
  if (dbm == null) return null
  const n = Number(dbm)
  if (!Number.isFinite(n)) return null
  if (n >= -25) return { nivel: 'buena', dbm: n }
  if (n >= -28) return { nivel: 'regular', dbm: n }
  return { nivel: 'mala', dbm: n }
}

/**
 * @param clienteId  el abonado
 * @param profundo   true = habla con la OLT y con el router. Tarda segundos.
 */
export async function diagnosticar(clienteId, { profundo = false } = {}) {
  const { data: cliente } = await db()
    .from('clientes')
    .select('id, nombre, estado, ip, router_id, onu_id, usuario_ppp, tipo_conexion, zona')
    .eq('id', clienteId)
    .maybeSingle()

  if (!cliente) throw badRequest('No existe ese abonado.')

  const pasos = []

  // --- 1. La avería conocida -------------------------------------------------
  //
  // Va PRIMERO y corta el diagnóstico. Es el paso que descarga el canal de
  // soporte: si ya sabemos que se cortó la fibra de su sector, medirle la señal
  // no aporta nada y contestar tarde es lo que hace que vuelva a escribir.
  const incidencia = await incidenciaActivaDe(cliente.id)
  if (incidencia) {
    return {
      resultado: 'averia_zona',
      mensaje: incidencia.mensaje,
      accion: 'informar',
      abrir_ticket: false,
      incidencia,
      pasos,
    }
  }

  // --- 2. El corte por deuda -------------------------------------------------
  const { data: saldo } = await db()
    .from('v_saldo_clientes')
    .select('saldo, facturas_pendientes')
    .eq('client_id', cliente.id)
    .maybeSingle()

  const debe = Number(saldo?.saldo ?? 0)
  pasos.push({ paso: 'deuda', valor: debe })

  if (cliente.estado === 'cortado') {
    return {
      resultado: 'corte_por_deuda',
      mensaje:
        debe > 0
          ? `Tu servicio está suspendido por un saldo pendiente de $${debe.toFixed(2)}. Se reactiva apenas registremos el pago.`
          : 'Tu servicio figura suspendido. Escribinos para revisarlo: puede que el pago ya esté y falte reactivarlo.',
      accion: debe > 0 ? 'cobrar' : 'escalar',
      abrir_ticket: debe <= 0,
      deuda: debe,
      pasos,
    }
  }

  // --- 3. El equipo del abonado ----------------------------------------------
  if (!cliente.onu_id && !cliente.router_id) {
    return {
      resultado: 'sin_datos',
      mensaje: 'No podemos revisar tu conexión automáticamente. Un técnico la va a mirar.',
      accion: 'escalar',
      abrir_ticket: true,
      pasos,
    }
  }

  let onu = null
  if (cliente.onu_id) {
    const { data } = await db()
      .from('onus')
      .select('id, sn, estado, rx_power_dbm, ultima_lectura, olt_id, slot, puerto, onu_index, frame')
      .eq('id', cliente.onu_id)
      .maybeSingle()
    onu = data ?? null
  }

  // La lectura en vivo, solo si se pidió. Abre una sesión SSH contra la OLT:
  // hacerlo en cada mensaje de WhatsApp llenaría las tres sesiones que admite
  // el equipo y dejaría al técnico sin poder entrar justo cuando hace falta.
  if (profundo && onu?.olt_id) {
    try {
      const equipo = await cargarOlt(onu.olt_id)
      const m = await olt.leerMetricas(equipo, {
        frame: onu.frame ?? 0,
        slot: onu.slot ?? 0,
        puerto: onu.puerto,
        onuId: onu.onu_index,
      })
      if (m?.rx_power_dbm != null) onu.rx_power_dbm = m.rx_power_dbm
      if (m?.estado) onu.estado = m.estado
      pasos.push({ paso: 'lectura_optica', en_vivo: true, ...m })
    } catch (err) {
      // Que la OLT no conteste no invalida el diagnóstico: se sigue con la
      // lectura cacheada, que para decidir "está apagado o no" suele alcanzar.
      pasos.push({ paso: 'lectura_optica', en_vivo: false, error: err.message })
    }
  }

  if (onu) {
    pasos.push({ paso: 'ont', estado: onu.estado, rx: onu.rx_power_dbm, leido: onu.ultima_lectura })

    if (onu.estado === 'los') {
      return {
        resultado: 'sin_fibra',
        mensaje:
          'Tu equipo no está recibiendo señal de fibra. Suele ser el cable de la casa: revisá que no esté doblado, pisado ni desconectado del equipo. Si está bien, mandamos un técnico.',
        accion: 'revisar_equipo',
        abrir_ticket: true,
        pasos,
      }
    }

    if (onu.estado !== 'online') {
      return {
        resultado: 'equipo_apagado',
        mensaje:
          'Tu equipo no está encendido o no llega a la red. Revisá que tenga corriente y que las luces estén prendidas; si acaba de haber un corte de luz, esperá un minuto a que arranque.',
        accion: 'revisar_equipo',
        // Un equipo apagado no es un ticket todavía: la mitad de las veces es
        // el cable de corriente. Se sugiere revisar y volver a escribir.
        abrir_ticket: false,
        pasos,
      }
    }

    const senal = calidadOptica(onu.rx_power_dbm)
    if (senal?.nivel === 'mala') {
      return {
        resultado: 'senal_baja',
        mensaje:
          'Tu equipo está conectado pero con señal muy baja, y por eso la conexión se corta. Vamos a mandar un técnico a revisar el tendido.',
        accion: 'escalar',
        abrir_ticket: true,
        senal,
        pasos,
      }
    }

    // --- 4. El ping, solo en el profundo -------------------------------------
    if (profundo && cliente.router_id && cliente.ip) {
      try {
        const equipo = await cargarRouter(cliente.router_id)
        const salida = await mk.ping(equipo, { destino: cliente.ip, cantidad: 4 })
        const paquetes = (salida ?? []).filter((p) => p.time || p.status)
        const ok = paquetes.filter((p) => p.time).length
        pasos.push({ paso: 'ping', enviados: paquetes.length, recibidos: ok })

        if (paquetes.length && ok === 0) {
          return {
            resultado: 'sin_respuesta',
            mensaje:
              'Tu equipo está en línea pero no responde. Probá reiniciarlo: desconectalo de la corriente, esperá diez segundos y volvé a conectarlo.',
            accion: 'reiniciar',
            abrir_ticket: false,
            pasos,
          }
        }
      } catch (err) {
        pasos.push({ paso: 'ping', error: err.message })
      }
    }

    return {
      resultado: 'todo_ok',
      mensaje:
        'De nuestro lado tu conexión está bien: el equipo está en línea y con buena señal. Si seguís sin navegar, probá reiniciar tu router WiFi; si no se arregla, abrimos un reclamo.',
      accion: 'reiniciar',
      abrir_ticket: false,
      senal: calidadOptica(onu.rx_power_dbm),
      pasos,
    }
  }

  // --- Radio: sin ONT, se mira si responde -----------------------------------
  if (profundo && cliente.router_id && cliente.ip) {
    try {
      const equipo = await cargarRouter(cliente.router_id)
      const salida = await mk.ping(equipo, { destino: cliente.ip, cantidad: 4 })
      const paquetes = (salida ?? []).filter((p) => p.time || p.status)
      const ok = paquetes.filter((p) => p.time).length
      pasos.push({ paso: 'ping', enviados: paquetes.length, recibidos: ok })

      if (paquetes.length && ok === 0) {
        return {
          resultado: 'sin_respuesta',
          mensaje:
            'Tu equipo no responde. Probá desconectarlo de la corriente diez segundos y volver a conectarlo.',
          accion: 'reiniciar',
          abrir_ticket: false,
          pasos,
        }
      }

      return {
        resultado: 'todo_ok',
        mensaje:
          'De nuestro lado tu conexión responde bien. Si seguís sin navegar, probá reiniciar tu router WiFi.',
        accion: 'reiniciar',
        abrir_ticket: false,
        pasos,
      }
    } catch (err) {
      pasos.push({ paso: 'ping', error: err.message })
    }
  }

  return {
    resultado: 'sin_datos',
    mensaje: 'No pudimos revisar tu conexión automáticamente. Un técnico la va a mirar.',
    accion: 'escalar',
    abrir_ticket: true,
    pasos,
  }
}

/**
 * Reinicia la ONT del abonado desde la OLT.
 *
 * ── Por qué se le deja hacer esto a un bot ──
 *
 * Porque es la acción que más llamadas resuelve y la única que el abonado ya
 * hace igual, peor: desenchufa el equipo. Un reinicio desde la OLT es más
 * limpio —`ont reset graceful`— y queda registrado.
 *
 * ── Y por qué solo la SUYA ──
 *
 * El objetivo sale de la ficha del abonado, nunca de lo que mande quien llama.
 * Es la misma regla de las herramientas técnicas: si el CRM pudiera mandar el
 * puerto y el ONT-ID, un error suyo reiniciaría el equipo del vecino — o, con
 * `ontId` nulo, el puerto PON entero.
 */
export async function reiniciarEquipo(clienteId) {
  const { data: cliente } = await db()
    .from('clientes')
    .select('id, nombre, onu_id')
    .eq('id', clienteId)
    .maybeSingle()

  if (!cliente?.onu_id) {
    throw badRequest('Tu equipo no admite el reinicio remoto.', {
      hint: 'Desconectalo de la corriente diez segundos y volvé a conectarlo.',
    })
  }

  const { data: onu } = await db()
    .from('onus')
    .select('id, sn, olt_id, slot, puerto, onu_index')
    .eq('id', cliente.onu_id)
    .maybeSingle()

  if (!onu?.olt_id || onu.puerto == null || onu.onu_index == null) {
    throw badRequest('No tenemos la ubicación de tu equipo para reiniciarlo de forma remota.')
  }

  const equipo = await cargarOlt(onu.olt_id)

  const salida = await olt.reiniciarOnts(equipo, {
    slot: onu.slot ?? 0,
    puerto: onu.puerto,
    // El ONT-ID concreto y nunca `null`: `null` significa "todas las del
    // puerto", que son sesenta abonados.
    ontId: onu.onu_index,
    graceful: true,
  })

  // Queda escrito, igual que cuando lo hace una persona desde la ficha: el día
  // que alguien pregunte por qué se le reinició el equipo a las once de la
  // noche, la respuesta tiene que ser un registro.
  await db()
    .from('comandos_ejecutados')
    .insert({
      client_id: cliente.id,
      destino_tipo: 'olt',
      destino_id: equipo.id,
      destino_nombre: equipo.nombre,
      comando: 'reiniciar_ont',
      parametros: { sn: onu.sn, origen: 'api_integracion' },
      salida: JSON.stringify(salida).slice(0, 4000),
      exito: true,
      created_by: null,
    })
    .then(({ error }) => error && console.error('[diagnostico] no se registró:', error.message))

  return {
    ok: true,
    mensaje: 'Tu equipo se está reiniciando. Tarda entre uno y dos minutos en volver.',
  }
}
