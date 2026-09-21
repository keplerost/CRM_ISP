import * as huawei from '../drivers/huawei.js'
import * as huaweiSnmp from '../drivers/huaweiSnmp.js'
import * as vsol from '../drivers/vsol.js'
import { badRequest } from '../lib/errors.js'
import { normalizarSn } from '../lib/sn.js'
import { parseRegistroCli } from '../parsers/huaweiLogParser.js'

/**
 * Capa que unifica las dos marcas detrás de una sola API.
 *
 * Las CLIs no se parecen: Huawei direcciona por frame/slot/puerto + ONT-ID y V-SOL
 * por puerto + índice de ONU. Las rutas hablan siempre el vocabulario neutro
 * { frame, slot, puerto, onuId } y acá se traduce a lo que espera cada driver.
 */

const esHuawei = (olt) => String(olt.marca).toLowerCase() === 'huawei'

function driver(olt) {
  const marca = String(olt.marca || '').toLowerCase()
  if (marca === 'huawei') return huawei
  if (marca === 'vsol' || marca === 'v-sol') return vsol
  throw badRequest(`Marca de OLT no soportada: ${olt.marca}`, {
    hint: 'Las marcas soportadas son Huawei y VSOL.',
  })
}

export const probarConexion = (olt) => driver(olt).probarConexion(olt)

/**
 * Salud del equipo: temperatura, placas, consumo, puertos.
 *
 * Solo el driver Huawei la implementa por ahora: los comandos se escribieron
 * contra la salida real de un MA5800-X7. Para V-SOL hay que hacer el mismo
 * relevamiento antes — inventarlos de la documentación es lo que ya costó caro.
 */
export function leerSalud(olt) {
  const d = driver(olt)
  if (!d.leerSalud) {
    throw badRequest(`Todavía no se leen los datos de salud de una OLT ${olt.marca}`, {
      hint: 'Los comandos se relevan contra el equipo antes de implementarlos. Hoy está hecho para Huawei MA5800.',
    })
  }
  return d.leerSalud(olt)
}

/**
 * Placas del equipo. Mismo criterio que `leerSalud`: si el driver de la marca no
 * lo tiene relevado, se dice, en vez de devolver una lista vacía que se leería
 * como "esta OLT no tiene placas".
 */
export function leerPlacas(olt) {
  const d = driver(olt)
  if (!d.leerPlacas) throw sinRelevar(olt, 'las placas')
  return d.leerPlacas(olt)
}

/**
 * La IP de gestión de una ONT: la que usa el ACS para configurarla.
 *
 * Sin ella la ONT pasa tráfico pero nadie puede hablarle — ni para empujarle el
 * usuario y la clave PPPoE, ni para leerle el WiFi.
 */
export function configurarIpGestionOnu(olt, datos) {
  const d = driver(olt)
  if (!d.configurarIpGestionOnt) throw sinRelevar(olt, 'la IP de gestión de las ONTs')
  return d.configurarIpGestionOnt(olt, datos)
}

/** Lo mismo, pero pidiéndola por DHCP en vez de fija. */
export function configurarIpGestionOnuDhcp(olt, datos) {
  const d = driver(olt)
  if (!d.configurarIpGestionOntDhcp) throw sinRelevar(olt, 'el DHCP de gestión de las ONTs')
  return d.configurarIpGestionOntDhcp(olt, datos)
}

/** Saca la IP de gestión. La ONT sigue con servicio, pero queda inalcanzable. */
export function quitarIpGestionOnu(olt, datos) {
  const d = driver(olt)
  if (!d.quitarIpGestionOnt) throw sinRelevar(olt, 'sacar la IP de gestión de las ONTs')
  return d.quitarIpGestionOnt(olt, datos)
}

/** El modelo de muchas ONTs, en una sola sesión. */
export function leerModelosDeOnts(olt, datos) {
  const d = driver(olt)
  if (!d.leerModelosDeOnts) throw sinRelevar(olt, 'el modelo de las ONTs')
  return d.leerModelosDeOnts(olt, datos)
}

/** Las IPs de gestión de muchas ONTs, en una sola sesión. */
export function leerIpsGestionDeOnts(olt, datos) {
  const d = driver(olt)
  if (!d.leerIpsGestionDeOnts) throw sinRelevar(olt, 'las IPs de gestión de las ONTs')
  return d.leerIpsGestionDeOnts(olt, datos)
}

export function leerIpGestionOnu(olt, datos) {
  const d = driver(olt)
  if (!d.leerIpGestionOnt) throw sinRelevar(olt, 'la IP de gestión de las ONTs')
  return d.leerIpGestionOnt(olt, datos)
}

/**
 * Qué VLANs tiene puestas cada puerto PON, leídas del equipo.
 *
 * Es lo que el ISP configuró de verdad, no lo que nosotros anotamos. Las dos
 * cosas conviven en la pantalla y su diferencia es la que dice si un puerto
 * está a medio migrar.
 */
export function leerVlansPorPuerto(olt) {
  const d = driver(olt)
  if (!d.leerVlansPorPuerto) throw sinRelevar(olt, 'las VLANs por puerto')
  return d.leerVlansPorPuerto(olt)
}

export function leerPuertosPon(olt, { slot } = {}) {
  const d = driver(olt)
  if (!d.leerPuertosPon) throw sinRelevar(olt, 'los puertos PON')
  return d.leerPuertosPon(olt, { slot })
}

/** La comunidad SNMP tal como la tiene configurada el equipo. */
export function leerComunidadSnmp(olt, opciones) {
  const d = driver(olt)
  if (!d.leerComunidadSnmp) throw sinRelevar(olt, 'la comunidad SNMP')
  return d.leerComunidadSnmp(olt, opciones)
}

/**
 * Óptica de todas las ONTs por SNMP.
 *
 * Los OIDs son propietarios de cada marca, así que esto se releva equipo por
 * equipo igual que los comandos de la CLI. Hoy está hecho para Huawei.
 */
export function leerPotenciasSnmp(olt, comunidad, opciones) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'la óptica por SNMP')
  return huaweiSnmp.leerPotencias(olt, comunidad, opciones)
}

/**
 * Candidatas a autorizar según el registro SNMP del equipo.
 *
 * OJO: no es la cola viva. Sirve para saber qué puertos consultar por CLI, no
 * para publicar como "esperando autorización" — ver el comentario del driver.
 */
export function leerCandidatosSnmp(olt, comunidad) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'las candidatas a autorizar por SNMP')
  return huaweiSnmp.leerCandidatosAutofind(olt, comunidad)
}

/** Puertos de subida, con las VLANs que pasan por cada uno. */
export function leerUplinks(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'los puertos de subida')
  return huawei.leerUplinks(olt, datos)
}

/** Agrega o quita VLANs de puertos de subida. */
export function cambiarVlansDeUplink(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'el cambio de VLANs en los uplinks')
  return huawei.cambiarVlansDeUplink(olt, datos)
}

/** Estado detallado de los puertos PON de una placa. */
export function leerEstadoPuertos(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'el estado detallado de los puertos PON')
  return huawei.leerEstadoPuertos(olt, datos)
}

/** La configuración completa de una ONT: perfiles, descripción y service-ports. */
export function leerConfigCompletaOnt(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'la configuración completa de una ONT')
  return huawei.leerConfigCompletaOnt(olt, datos)
}

/** Mueve una ONT a otro puerto PON. Es borrar y recrear: corta el servicio. */
export function moverOnt(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'el traslado de ONTs entre puertos')
  return huawei.moverOnt(olt, datos)
}

/** Cambia la velocidad de una ONT sin cortarle el servicio. */
export function cambiarPlanDeOnt(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'el cambio de plan de una ONT')
  return huawei.cambiarPlanOnt(olt, datos)
}

/** Suspende o reactiva una ONT sin borrar su configuración. */
export function activarOnt(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'la suspensión de ONTs')
  return huawei.activarOnt(olt, datos)
}

/** Los service-ports de una ONT, con su índice y su VLAN. */
export function listarServicePortsDeOnt(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'los service-ports de una ONT')
  return huawei.listarServicePortsDeOnt(olt, datos)
}

/** Acciones masivas sobre los puertos de una placa. */
export function aplicarAPuertos(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'las acciones masivas sobre puertos')
  return huawei.aplicarAPuertos(olt, datos)
}

/** Reinicia las ONTs de un puerto. Deja sin servicio a sus abonados. */
export function reiniciarOnts(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'el reinicio de ONTs')
  return huawei.reiniciarOnts(olt, datos)
}

/**
 * La WAN de una ONT y los perfiles de WAN de la OLT.
 *
 * Solo Huawei: la consulta y los comandos son del MA5800. En V-SOL la WAN se
 * arma de otra manera y aplicar algo parecido sería inventar.
 */
export function leerWanDeOnt(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'la WAN de una ONT')
  return huawei.leerWanDeOnt(olt, datos)
}

export function listarWanProfiles(olt) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'los perfiles de WAN')
  return huawei.listarWanProfiles(olt)
}

export function asegurarWanProfile(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'crear perfiles de WAN')
  return huawei.asegurarWanProfile(olt, datos)
}

export function vincularWanOnt(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'configurar la WAN de una ONT')
  return huawei.vincularWanOnt(olt, datos)
}

export function desvincularWanOnt(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'sacar la WAN de una ONT')
  return huawei.desvincularWanOnt(olt, datos)
}

/**
 * Cambia los perfiles de una ONT ya autorizada, sin borrarla.
 *
 * Solo Huawei: el driver de V-SOL no implementa `ont modify`, y en esos equipos
 * el perfil se elige al registrar. Se avisa con el mensaje de siempre en vez de
 * aplicar algo parecido que nadie pidió.
 */
export function cambiarPerfilesOnt(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'cambiar los perfiles de una ONT')
  return driver(olt).cambiarPerfilesOnt(olt, datos)
}

/** Vuelve a registrar la ONT para que la OLT le reenvíe su configuración. */
export function reprovisionarOnt(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'el re-registro de ONTs')
  return huawei.reprovisionarOnt(olt, datos)
}

/** Devuelve la ONT a los valores de fábrica. */
export function restaurarFabricaOnt(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'la restauración de fábrica')
  return huawei.restaurarFabricaOnt(olt, datos)
}

/** La configuración que el equipo tiene en ejecución para esa ONT. */
export function leerConfigActivaOnt(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'la configuración activa')
  return huawei.leerConfigActivaOnt(olt, datos)
}

/** Todo lo de un puerto PON de una vez: sus ONTs con descripción y VLANs. */
export function leerPuertoCompleto(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'la lectura por puerto')
  return huawei.leerPuertoCompleto(olt, datos)
}

/** Las VLANs del equipo, con cuántos abonados cuelgan de cada una. */
export function leerVlans(olt) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'las VLANs')
  return huawei.leerVlans(olt)
}

/** Crea VLANs en el equipo. Acepta varias. */
export function crearVlans(olt, vlans, opciones) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'la creación de VLANs')
  return huawei.crearVlans(olt, vlans, opciones)
}

/** Borra VLANs, negándose a tocar las que tienen abonados. */
export function borrarVlans(olt, vlans, opciones) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'el borrado de VLANs')
  return huawei.borrarVlans(olt, vlans, opciones)
}

/** Las traffic tables del equipo, que son las que fijan la velocidad real. */
export function leerTrafficTables(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'las traffic tables')
  return huawei.leerTrafficTables(olt, datos)
}

/** Los puertos de adentro de la ONT: ethernet de la casa y teléfono. */
export function leerPuertosOnt(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'los puertos de la ONT')
  return huawei.leerPuertosOnt(olt, datos)
}

/** Contadores acumulados de tráfico de un service-port. */
export function leerEstadisticasServicePort(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'las estadísticas de tráfico')
  return huawei.leerEstadisticasServicePort(olt, datos)
}

/** Perfiles de línea y de servicio cargados en el equipo. */
export function listarPerfilesOnt(olt) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'los perfiles de ONT')
  return huawei.listarPerfilesOnt(olt)
}

/** El service-port: sin esto la ONT queda registrada pero no pasa tráfico. */
export function crearServicePortOlt(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'la creación de service-ports')
  return huawei.crearServicePort(olt, datos)
}

/** Inventario de ONTs por SNMP: serie, descripción, estado y distancia. */
export function leerInventarioSnmp(olt, comunidad) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'el inventario de ONTs por SNMP')
  return huaweiSnmp.leerInventario(olt, comunidad)
}

/** Estado del reloj. Devuelve null si la marca no lo tiene relevado. */
export function leerNtp(olt) {
  const d = driver(olt)
  return d.leerNtp ? d.leerNtp(olt) : Promise.resolve(null)
}

/** Corre comandos crudos devolviendo también si el equipo los rechazó. */
export function relevar(olt, comandos) {
  const d = driver(olt)
  if (!d.relevar) throw sinRelevar(olt, 'el relevamiento de comandos')
  return d.relevar(olt, comandos)
}

const sinRelevar = (olt, que) =>
  badRequest(`Todavía no se lee ${que} de una OLT ${olt.marca}`, {
    hint: 'Los comandos se relevan contra el equipo antes de implementarlos. Usá la pestaña de relevamiento para ver qué acepta este modelo.',
  })

export function listarOnus(olt, { frame = 0, slot = 0, puerto }) {
  return esHuawei(olt)
    ? huawei.listarOnts(olt, { frame, slot, puerto })
    : vsol.listarOnus(olt, { puerto })
}

export function listarAutofind(olt, { frame = 0, slot = 0, puerto }) {
  return esHuawei(olt)
    ? huawei.listarAutofind(olt, { frame, slot, puerto })
    : vsol.listarAutofind(olt, { puerto })
}

export function escanearAutofind(olt, { frame = 0, slot = 0, puertos = 8 }) {
  return esHuawei(olt)
    ? huawei.escanearAutofind(olt, { frame, slot, puertos })
    : vsol.escanearAutofind(olt, { puertos })
}

/**
 * Dónde está enchufada una ONT, buscándola por su serie.
 *
 * Es lo que necesita el técnico en la casa del abonado: escaneó el QR del
 * equipo y quiere saber si la OLT lo ve, sin tener que averiguar antes en qué
 * puerto PON quedó. Se busca primero entre las registradas y después en la cola
 * de auto-find, que es el orden en el que importa: una ONT que ya está dada de
 * alta y no responde es un problema distinto de una que nunca se registró.
 *
 * Con `puerto` mira solo ese —cuando la caja NAP ya dice de qué PON baja, es
 * una consulta en vez de un barrido de ocho—.
 */
export async function buscarPorSn(olt, { sn, frame = 0, slot, puerto, puertos = 8 }) {
  // Se compara en la notación de la etiqueta. El técnico escanea el QR del
  // equipo —que trae "HWTC304D1BB2"— y la CLI imprime "48575443304D1BB2": son
  // el mismo aparato, y sin normalizar la búsqueda devolvía "no está" para una
  // ONT que se veía perfectamente en el puerto.
  const objetivo = normalizarSn(sn)
  if (!objetivo) throw badRequest('Falta la serie de la ONT')

  const normalizar = normalizarSn

  // Dónde buscar. Nada de esto se supone: se le pregunta al equipo.
  //
  // Antes se daban por sentados el slot 0 y ocho puertos. En este X7 la placa
  // GPON está en el slot 6 y tiene dieciséis puertos, con abonados en el 9. O
  // sea que la búsqueda miraba una placa vacía y, aun mirando la correcta, se
  // habría detenido en el puerto 7. Contestaba "la OLT no ve la ONT" y mandaba
  // al técnico a revisar conectores que estaban perfectos.
  const donde = await dondeBuscar(olt, { slot, puerto, puertos })

  /**
   * Lo que el equipo NO contestó.
   *
   * Los dos recorridos de abajo se tragan los errores a propósito: si una placa
   * no contesta, se sigue con las otras en vez de abandonar la búsqueda entera.
   * Pero tragárselos y no decirlo hacía que "la OLT contestó y no la ve" y "la
   * OLT no contestó" salieran EXACTAMENTE iguales — `encontrada: false`.
   *
   * En una instalación eso manda al técnico a revisar un conector que está
   * perfecto, cuando lo que pasó fue que la OLT llegó a su máximo de sesiones
   * SSH. Anotarlos acá deja que quien llama distinga los dos casos.
   */
  const fallos = []

  for (const { slot: s, puertos: aRevisar } of donde) {
    for (const p of aRevisar) {
      const registradas = await listarOnus(olt, { frame, slot: s, puerto: p }).catch((err) => {
        fallos.push(`placa ${s} puerto ${p}: ${err.message}`)
        return []
      })
      const hallada = (registradas ?? []).find((o) => normalizar(o.sn) === objetivo)
      if (hallada) {
        return {
          encontrada: true,
          registrada: true,
          frame,
          slot: s,
          puerto: p,
          onuId: hallada.ontId ?? hallada.onuIndex ?? null,
          estado: hallada.estado ?? null,
          onu: hallada,
        }
      }
    }
  }

  // Recién ahora la cola de sin registrar. El orden importa: una ONT dada de
  // alta que no responde es un problema distinto de una que nunca se registró.
  //
  // Y esta segunda parte es la que más se usa en una instalación nueva: cuando
  // el técnico mide, la ONT todavía no está autorizada.
  for (const { slot: s, puertos: aRevisar } of donde) {
    const sinRegistrar = []
    for (const p of aRevisar) {
      sinRegistrar.push(
        ...((await listarAutofind(olt, { frame, slot: s, puerto: p }).catch((err) => {
          fallos.push(`autofind placa ${s} puerto ${p}: ${err.message}`)
          return []
        })) ?? []),
      )
    }

    const pendiente = sinRegistrar.find((o) => normalizar(o.sn) === objetivo)
    if (pendiente) {
      return {
        encontrada: true,
        registrada: false,
        frame,
        slot: pendiente.slot ?? s,
        puerto: pendiente.puerto ?? puerto ?? null,
        onuId: null,
        onu: pendiente,
      }
    }
  }

  return {
    encontrada: false,
    registrada: false,
    puerto: puerto ?? null,
    onuId: null,
    // Dónde se buscó de verdad. Es lo que distingue "la ONT no está" de "no
    // miré donde estaba", y sin eso los dos casos se leen igual.
    revisado: donde.map((d) => `placa ${d.slot} puertos ${d.puertos[0]}-${d.puertos[d.puertos.length - 1]}`),
    // Si esto tiene algo, "no la encontré" NO quiere decir "no está".
    sinRespuesta: fallos.length > 0,
    fallos,
  }
}

/**
 * En qué placas y puertos buscar, preguntándole al equipo.
 *
 * Con `slot` y `puerto` dados es una sola consulta. Sin ellos, se leen las
 * placas de servicio y los puertos que cada una tiene de verdad — no un número
 * fijo. Un X7 tiene dieciséis por placa; suponer ocho deja fuera a la mitad de
 * los abonados.
 *
 * Si el equipo no contesta se cae a lo que se suponía antes, en vez de no
 * buscar en ningún lado: una búsqueda que mira poco es mejor que una que no
 * mira nada.
 */
async function dondeBuscar(olt, { slot, puerto, puertos }) {
  const primero = esHuawei(olt) ? 0 : 1
  const rango = (cuantos, desde = primero) => Array.from({ length: cuantos }, (_, i) => desde + i)

  if (slot != null) {
    return [{ slot: Number(slot), puertos: puerto != null ? [Number(puerto)] : rango(puertos) }]
  }

  const placas = await leerPlacas(olt).catch(() => null)
  const deServicio = (placas ?? []).filter((p) => p.servicio)
  if (!deServicio.length) {
    return [{ slot: 0, puertos: puerto != null ? [Number(puerto)] : rango(puertos) }]
  }

  const salida = []
  for (const placa of deServicio) {
    if (puerto != null) {
      salida.push({ slot: placa.slot, puertos: [Number(puerto)] })
      continue
    }
    // `leerPuertosPon` devuelve un array de PLACAS, cada una con su lista de
    // puertos adentro. Leerlo como si fuera la lista de puertos directamente
    // daba vacío y se caía al rango de ocho — que es justo el error que esto
    // venía a arreglar.
    const placasPon = (await leerPuertosPon(olt, { slot: placa.slot }).catch(() => null)) ?? []
    const lista = (Array.isArray(placasPon) ? placasPon : [placasPon])
      .filter((b) => b?.slot === placa.slot || placasPon.length === 1)
      .flatMap((b) => b?.puertos ?? [])
      .map((x) => x?.puerto)
      .filter((x) => Number.isFinite(x))

    salida.push({ slot: placa.slot, puertos: lista.length ? lista : rango(puertos) })
  }
  return salida
}

export function registrarOnu(
  olt,
  { frame = 0, slot = 0, puerto, onuId, sn, descripcion, lineProfile, lineProfileId, srvProfileId },
) {
  if (esHuawei(olt)) {
    return huawei.registrarOnt(olt, {
      frame,
      slot,
      puerto,
      ontId: onuId,
      sn,
      descripcion,
      lineProfileId,
      srvProfileId,
    })
  }
  // V-SOL no registra por SN: confirma lo que está en la cola de auto-find del puerto.
  return vsol.confirmarOnus(olt, { puerto, lineProfile })
}

export function eliminarOnu(olt, { frame = 0, slot = 0, puerto, onuId }) {
  return esHuawei(olt)
    ? huawei.eliminarOnt(olt, { frame, slot, puerto, ontId: onuId })
    : vsol.eliminarOnu(olt, { puerto, onuIndex: onuId })
}

export function leerMetricas(olt, { frame = 0, slot = 0, puerto, onuId }) {
  return esHuawei(olt)
    ? huawei.leerMetricas(olt, { frame, slot, puerto, ontId: onuId })
    : vsol.leerMetricas(olt, { puerto, onuIndex: onuId })
}

/**
 * Servicio/VLAN de la ONU.
 * En Huawei esto se resuelve con line profile + service-port a nivel config; en el
 * taller la parte automatizada es la de V-SOL, que es la secuencia de 3 pasos ya
 * validada contra el equipo.
 */
export function configurarServicio(olt, { puerto, onuId, vlan, tcontId, gemportId, servicePortId }) {
  if (esHuawei(olt)) {
    throw badRequest(
      'En Huawei el servicio se aplica asignando un line profile al registrar la ONT, no con esta secuencia',
      { hint: 'Usá POST /api/olt/:id/line-profiles para crear el perfil y registrá la ONT con él.' },
    )
  }
  return vsol.configurarServicio(olt, {
    puerto,
    onuIndex: onuId,
    vlan,
    tcontId,
    gemportId,
    servicePortId,
  })
}

export function crearLineProfile(olt, { nombre, vlan, gemport }) {
  if (!esHuawei(olt)) {
    throw badRequest('La creación de line profiles automatizada está implementada solo para Huawei', {
      hint: 'En V-SOL creá el perfil desde la CLI y usá su nombre en "onu confirm line-profile <nombre>".',
    })
  }
  return huawei.crearLineProfile(olt, { nombre, vlan, gemport })
}

export function crearTrafficTable(olt, { index, nombre, cir, pir, priority }) {
  if (!esHuawei(olt)) {
    throw badRequest('La creación de traffic tables automatizada está implementada solo para Huawei')
  }
  return huawei.crearTrafficTable(olt, { index, nombre, cir, pir, priority })
}

export const ejecutarCrudo = (olt, comandos) => driver(olt).ejecutarCrudo(olt, comandos)

/** El registro de comandos de CLI de la OLT, de la entrada más nueva a la más vieja. */
export async function leerRegistroCli(olt) {
  const d = driver(olt)
  if (!d.leerRegistroCli) throw sinRelevar(olt, 'el registro de comandos')
  return parseRegistroCli(await d.leerRegistroCli(olt))
}

// --- TR-069 -----------------------------------------------------------------
//
// Relevado contra la MA5800-X7: el TR-069 de Huawei son perfiles globales más
// una asignación por ONT. V-SOL lo resuelve distinto y todavía no se relevó, así
// que se dice en vez de improvisar comandos que el equipo aceptaría a medias.

/** Los perfiles TR-069 del equipo, con cuántas ONT usa cada uno. */
export function listarPerfilesTr069(olt) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'los perfiles TR-069')
  return huawei.listarPerfilesTr069(olt)
}

/** Perfiles, ONT apuntadas y ONT con IP de gestión: los tres números. */
export function resumenTr069(olt) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'el estado del TR-069')
  return huawei.resumenTr069(olt)
}

/** Crea un perfil TR-069 nuevo. La clave viaja al equipo y no vuelve. */
export function crearPerfilTr069(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'la creación de perfiles TR-069')
  return huawei.crearPerfilTr069(olt, datos)
}

/** Apunta una ONT a otro perfil. Devuelve de dónde venía, para poder volver. */
export function asignarPerfilTr069(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'el cambio de perfil TR-069 de una ONT')
  return huawei.asignarPerfilTr069(olt, datos)
}

/** Estado TR-069 de una ONT: perfil, IP escrita, IP viva y qué le falta. */
export function leerTr069DeOnt(olt, datos) {
  if (!esHuawei(olt)) throw sinRelevar(olt, 'el estado TR-069 de una ONT')
  return huawei.leerTr069DeOnt(olt, datos)
}
