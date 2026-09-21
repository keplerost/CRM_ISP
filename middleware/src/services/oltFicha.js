import net from 'node:net'
import { db } from '../lib/db.js'
import { encrypt, decrypt } from '../lib/crypto.js'
import { badRequest } from '../lib/errors.js'
import * as olts from './oltService.js'
import { normalizarSn } from '../drivers/huaweiSnmp.js'
import { aHexSn } from '../lib/sn.js'
import { aEntero } from '../lib/ip.js'
import * as manual from './fichaManual.js'
import { buscarPersona } from '../lib/nombres.js'
import { buscarPorSerie, hayAcs, modeloDe } from '../drivers/genieacs.js'
import * as genieacsWan from '../drivers/genieacsWan.js'

/**
 * Ficha de la OLT: alcance, versiones, relevamiento y auditoría de coherencia.
 *
 * Lo que este archivo NO hace es inventar comandos. Cada vez que hizo falta
 * saber qué entiende un equipo, se le preguntó al equipo. Las listas de abajo
 * son candidatos a probar, no verdades: el relevamiento corre todos y reporta
 * cuáles aceptó, y recién con esa salida real se escribe un parser.
 */

const marcaDe = (olt) => (String(olt.marca).toLowerCase().replace('-', '') === 'vsol' ? 'VSOL' : 'Huawei')

// -----------------------------------------------------------------------------
// Alcance
// -----------------------------------------------------------------------------

/**
 * ¿Contesta el equipo?
 *
 * Se abre un TCP contra el puerto de gestión, no un ICMP. Es a propósito: una
 * OLT puede contestar ping perfecto con el SSH caído o con las sesiones
 * agotadas, y en ese estado el sistema no puede hacer absolutamente nada con
 * ella. Lo que hay que medir es el camino que este sistema realmente usa.
 *
 * No abre sesión SSH ni se autentica: sería carísimo para pintar un puntito y
 * consumiría una de las pocas ranuras de sesión del equipo.
 */
export function probarAlcance(olt, { timeoutMs = 4000 } = {}) {
  const host = olt.ip_host
  const port = olt.puerto_ssh || 22

  return new Promise((resolve) => {
    const inicio = Date.now()
    let listo = false

    const terminar = (estado, detalle) => {
      if (listo) return
      listo = true
      try {
        socket.destroy()
      } catch {
        // Ya estaba cerrado; da igual.
      }
      resolve({ estado, detalle, latencia_ms: Date.now() - inicio })
    }

    const socket = net.createConnection({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => terminar('online', null))
    socket.once('timeout', () => terminar('offline', `Sin respuesta en ${timeoutMs} ms`))
    socket.once('error', (err) => terminar('offline', err.code || err.message))
  })
}

/** Prueba el alcance y deja el resultado cacheado en la fila. */
export async function refrescarEstado(olt, opciones) {
  const r = await probarAlcance(olt, opciones)

  await db()
    .from('olts')
    .update({
      estado: r.estado,
      estado_at: new Date().toISOString(),
      estado_latencia_ms: r.latencia_ms,
      estado_detalle: r.detalle,
    })
    .eq('id', olt.id)

  return { id: olt.id, nombre: olt.nombre, ip_host: olt.ip_host, ...r }
}

/**
 * Refresca todas de una. En paralelo porque son sockets TCP: una OLT que no
 * contesta no puede hacer esperar cuatro segundos a cada una de las siguientes.
 */
export async function refrescarEstados() {
  const { data, error } = await db()
    .from('olts')
    .select('id, nombre, ip_host, puerto_ssh, activo')
    .order('numero', { ascending: true })

  if (error) throw badRequest(`No se pudieron leer las OLTs: ${error.message}`)

  // Las ocultas no se sondean: apagarlas es justamente lo que uno hace con un
  // equipo que sabe que no está.
  const activas = (data ?? []).filter((o) => o.activo !== false)
  return Promise.all(activas.map((o) => refrescarEstado(o)))
}

// -----------------------------------------------------------------------------
// Versiones
// -----------------------------------------------------------------------------

/**
 * Lee modelo, firmware y tipos PON del equipo y los guarda.
 *
 * Se cargan leyéndolos y no a mano porque una versión tipeada por una persona
 * queda vieja el día que alguien actualiza el firmware sin avisar — y el
 * detector de inconsistencias compara justamente esto contra lo que el equipo
 * dice hoy.
 */
export async function sincronizarVersiones(olt) {
  const info = await olts.probarConexion(olt)

  const cambios = { versiones_at: new Date().toISOString() }
  if (info.modelo) cambios.hw_version = info.modelo
  if (info.version) cambios.sw_version = info.version

  // Los tipos PON no salen de la versión sino de las placas: un mismo chasis
  // puede tener una GPON y una XG-PON al mismo tiempo.
  try {
    const tarjetas = await olts.leerPuertosPon(olt)
    const tipos = [...new Set(tarjetas.flatMap((t) => (t.puertos ?? []).map((p) => p.tipo)))]
    if (tipos.length) cambios.pon_tipos = tipos.join(', ')
  } catch {
    // Marca sin relevar todavía: no es motivo para perder el modelo y el firmware.
  }

  const { error } = await db().from('olts').update(cambios).eq('id', olt.id)
  if (error) throw badRequest(`Se leyó el equipo pero no se pudo guardar: ${error.message}`)

  return { ...info, ...cambios }
}

// -----------------------------------------------------------------------------
// SNMP
// -----------------------------------------------------------------------------

/**
 * Le pregunta la comunidad de lectura al equipo y la guarda cifrada.
 *
 * El valor va del equipo a la columna sin pasar por ninguna pantalla: se
 * devuelve solo cuántos caracteres tiene, que alcanza para confirmar que se
 * guardó algo razonable. Es el mismo criterio de siempre — el descifrado vive
 * dentro del middleware y no sale.
 */
export async function detectarComunidad(olt, { escritura = false } = {}) {
  const comunidad = await olts.leerComunidadSnmp(olt, { escritura })
  if (!comunidad) {
    throw badRequest('El equipo no devolvió ninguna comunidad SNMP', {
      hint: 'Puede que SNMP no esté configurado. Miralo en la pestaña Avanzado.',
    })
  }

  const columna = escritura ? 'snmp_rw_encrypted' : 'snmp_ro_encrypted'
  const { error } = await db()
    .from('olts')
    .update({ [columna]: encrypt(comunidad) })
    .eq('id', olt.id)

  if (error) throw badRequest(`Se leyó la comunidad pero no se pudo guardar: ${error.message}`)

  return { guardada: true, tipo: escritura ? 'escritura' : 'lectura', caracteres: comunidad.length }
}

/**
 * Potencia óptica de todas las ONTs, por SNMP.
 *
 * La comunidad se descifra acá dentro y no sale de esta función.
 */
export async function leerPotencias(olt, opciones) {
  if (!olt.snmp_ro_encrypted) {
    throw badRequest('Esta OLT no tiene cargada la comunidad SNMP de lectura', {
      hint: 'Usá "Detectar comunidad": se lee del propio equipo y se guarda cifrada.',
    })
  }

  return olts.leerPotenciasSnmp(olt, decrypt(olt.snmp_ro_encrypted), opciones)
}

/**
 * Compara lo que hay en el equipo contra lo que hay en la base.
 *
 * Sin tocar nada: es la parte que decide qué es nuevo, qué cambió de lugar y qué
 * sobra. Separada del acceso a la base para poder probarla, porque acá es donde
 * un error se lleva puesta la ficha de un abonado.
 *
 * Las series se comparan normalizadas: la CLI del MA5800 imprime los ocho bytes
 * en hexadecimal y SNMP la forma de la etiqueta, y son el mismo número. Sin
 * normalizar, cada importación crearía duplicados de las mismas ONTs.
 */
export function compararInventario(delEquipo, deLaBase) {
  const porSn = new Map()
  for (const u of deLaBase) {
    const sn = normalizarSn(u.sn)
    if (sn) porSn.set(sn, u)
  }

  const nuevas = []
  const mudadas = []
  const sinCambios = []
  const vistas = new Set()

  for (const o of delEquipo) {
    const sn = normalizarSn(o.sn)
    if (!sn) continue
    vistas.add(sn)

    const fila = porSn.get(sn)
    if (!fila) {
      nuevas.push(o)
      continue
    }

    // Cambió de puerto o de ONT-ID: pasa cuando se reubica a un abonado y es
    // justo lo que deja la base apuntando a la fibra equivocada.
    const movida =
      fila.slot !== o.slot || fila.puerto !== o.puerto || fila.onu_index !== o.ontId

    if (movida) mudadas.push({ ...o, antes: { slot: fila.slot, puerto: fila.puerto, onu_index: fila.onu_index }, id: fila.id })
    else sinCambios.push({ ...o, id: fila.id })
  }

  // En la base pero no en el equipo. NUNCA se borran solas: puede ser una ONT
  // que alguien desconectó por diez minutos, y con ella se iría la ficha del
  // abonado. Se informan para que decida una persona.
  const sobrantes = deLaBase.filter((u) => !vistas.has(normalizarSn(u.sn)))

  return { nuevas, mudadas, sinCambios, sobrantes }
}

/**
 * Trae las ONTs del equipo a la base.
 *
 * Sin `aplicar` es una vista previa: dice exactamente qué va a pasar y no
 * escribe nada. Importar 85 fichas de abonado sin poder mirarlas antes es la
 * clase de operación que se lamenta después.
 */
export async function importarOnus(olt, { aplicar = false } = {}) {
  if (!olt.snmp_ro_encrypted) {
    throw badRequest('Esta OLT no tiene cargada la comunidad SNMP de lectura', {
      hint: 'Usá "Detectar comunidad": se lee del propio equipo y se guarda cifrada.',
    })
  }

  const inventario = await olts.leerInventarioSnmp(olt, decrypt(olt.snmp_ro_encrypted))

  const { data: enBase, error } = await db()
    .from('onus')
    .select('id, sn, slot, puerto, onu_index, nombre_cliente, estado')
    .eq('olt_id', olt.id)

  if (error) throw badRequest(`No se pudieron leer las ONUs de la base: ${error.message}`)

  const plan = compararInventario(inventario.onts, enBase ?? [])

  // Un puerto entero que desaparece NO es que se hayan ido sus abonados: es que
  // el puerto está caído y el equipo no reporta sus ONTs.
  //
  // Pasó de verdad: el puerto 6/6 estuvo abajo durante una importación y sus
  // seis abonados quedaron fuera del sistema sin que nada lo dijera. Sub-
  // reportar es el peor error acá — un abonado invisible no se factura, no se
  // monitorea y no aparece cuando se cae.
  const puertosCaidos = detectarPuertosCaidos(plan.sobrantes, inventario.onts)

  const resumen = {
    en_el_equipo: inventario.onts.length,
    en_la_base: (enBase ?? []).length,
    online: inventario.online,
    nuevas: plan.nuevas.length,
    mudadas: plan.mudadas.length,
    sin_cambios: plan.sinCambios.length,
    sobrantes: plan.sobrantes.length,
    ms: inventario.ms,
  }

  if (!aplicar) {
    return {
      aplicado: false,
      ...resumen,
      // Una muestra alcanza para decidir; mandar las 85 fichas completas a la
      // pantalla solo para confirmar no ayuda a nadie.
      muestra_nuevas: plan.nuevas.slice(0, 20).map(paraMostrar),
      muestra_mudadas: plan.mudadas.slice(0, 20).map((o) => ({ ...paraMostrar(o), antes: o.antes })),
      sobrantes: plan.sobrantes.map((u) => ({
        sn: u.sn,
        nombre: u.nombre_cliente,
        donde: `${u.slot}/${u.puerto}/${u.onu_index}`,
      })),
      puertos_caidos: puertosCaidos,
      ...(puertosCaidos.length
        ? {
            aviso:
              `Ojo: ${puertosCaidos.map((p) => `el puerto ${p.slot}/${p.puerto} (${p.onus} ONTs)`).join(' y ')} ` +
              'no reporta ninguna ONT. Eso no significa que se hayan ido los abonados: significa que el puerto ' +
              'está caído. Esperá a que vuelva antes de sacar conclusiones — y no borres esas filas.',
          }
        : {}),
    }
  }

  const ahora = new Date().toISOString()
  const errores = []
  let insertadas = 0
  let actualizadas = 0

  for (const o of plan.nuevas) {
    const { error: err } = await db()
      .from('onus')
      .insert({ olt_id: olt.id, ...aFila(o), ultima_lectura: ahora })
    if (err) errores.push(`${o.sn}: ${err.message}`)
    else insertadas++
  }

  for (const o of [...plan.mudadas, ...plan.sinCambios]) {
    const { error: err } = await db()
      .from('onus')
      .update({ ...aFila(o), ultima_lectura: ahora })
      .eq('id', o.id)
    if (err) errores.push(`${o.sn}: ${err.message}`)
    else actualizadas++
  }

  return {
    aplicado: true,
    ...resumen,
    insertadas,
    actualizadas,
    // Los sobrantes se informan pero no se tocan: borrar la ficha de un abonado
    // porque su ONT no contestó en este momento es un daño que no se deshace.
    sobrantes_no_tocadas: plan.sobrantes.length,
    errores,
  }
}

/**
 * Puertos donde TODAS las ONTs de la base desaparecieron de golpe.
 *
 * Que se vaya un abonado es normal. Que se vayan los quince de un puerto, todos
 * el mismo día, no: es el puerto que está caído. La diferencia importa porque
 * el primer caso se resuelve borrando filas y el segundo esperando a que
 * vuelva la fibra.
 */
export function detectarPuertosCaidos(sobrantes, delEquipo) {
  const vistosPorPuerto = new Map()
  for (const o of delEquipo) {
    const k = `${o.slot}/${o.puerto}`
    vistosPorPuerto.set(k, (vistosPorPuerto.get(k) ?? 0) + 1)
  }

  const faltantesPorPuerto = new Map()
  for (const u of sobrantes) {
    const k = `${u.slot}/${u.puerto}`
    if (!faltantesPorPuerto.has(k)) faltantesPorPuerto.set(k, [])
    faltantesPorPuerto.get(k).push(u)
  }

  const caidos = []
  for (const [k, lista] of faltantesPorPuerto) {
    // El equipo no reportó NINGUNA de ese puerto y en la base había varias.
    if (!vistosPorPuerto.has(k) && lista.length > 1) {
      const [slot, puerto] = k.split('/').map(Number)
      caidos.push({ slot, puerto, onus: lista.length })
    }
  }
  return caidos
}

/** Fila de `onus` a partir de lo que dice el equipo. */
function aFila(o) {
  return {
    sn: normalizarSn(o.sn),
    // La columna es de 150 caracteres y estas descripciones traen nombre, zona,
    // dirección y fecha, todo junto. Se guarda el nombre, que es lo que se busca.
    nombre_cliente: (o.datos?.nombre ?? o.descripcion ?? '').slice(0, 150) || null,
    frame: 0,
    slot: o.slot,
    puerto: o.puerto,
    onu_index: o.ontId,
    estado: o.estado ?? 'offline',
    distancia_m: o.distancia_m ?? null,
    // La fecha en que el equipo la autorizó, no la de esta importación. Sin
    // ella, un equipo con años de servicio queda con todas sus ONTs fechadas
    // hoy y cualquier gráfico de altas muestra una sola barra gigante.
    autorizada_at: o.datos?.alta ?? null,
    zona: o.datos?.zona ? o.datos.zona.slice(0, 60) : null,
  }
}

const paraMostrar = (o) => ({
  sn: o.sn,
  donde: `${o.slot}/${o.puerto}/${o.ontId}`,
  nombre: o.datos?.nombre ?? null,
  // El texto tal cual lo tiene el equipo. Va en la vista previa a propósito: es
  // lo único que permite ver si el desarmado cortó un nombre por la mitad antes
  // de escribir 85 fichas de abonado.
  descripcion_cruda: o.datos?.completa ?? null,
  direccion: o.datos?.direccion ?? null,
  zona: o.datos?.zona ?? null,
  alta: o.datos?.alta ?? null,
  modelo: o.modelo,
  estado: o.estado,
  distancia_m: o.distancia_m,
})

// -----------------------------------------------------------------------------
// Abonados
// -----------------------------------------------------------------------------

/**
 * Decide qué hacer con cada ONT respecto de los abonados. No toca la base.
 *
 * Cuatro destinos posibles:
 *
 *   `yaEnlazadas`  la ONT ya tiene su abonado. No se vuelve a mirar.
 *   `enlazar`      hay UN abonado con ese nombre y ninguna otra ONT se lo
 *                  disputa. Es el único caso que se resuelve solo.
 *   `ambiguas`     hay más de un candidato, o dos ONTs apuntan al mismo. Van a
 *                  revisión: elegir entre homónimos no es trabajo de un
 *                  programa.
 *   `crear`        nadie con ese nombre. Hay servicio dado y ninguna ficha.
 */
export function planificarAbonados(onus, clientes) {
  const libres = clientes.filter((c) => !c.onu_id)
  const yaEnlazadas = []
  const enlazar = []
  const ambiguas = []
  const crear = []

  for (const u of onus) {
    if (clientes.some((c) => c.onu_id === u.id)) {
      yaEnlazadas.push(u)
      continue
    }

    const nombre = u.nombre_cliente
    if (!nombre) {
      crear.push({ onu: u, motivo: 'la OLT no tiene un nombre anotado en esta ONT' })
      continue
    }

    const hallado = buscarPersona(nombre, libres)
    if (!hallado) {
      crear.push({ onu: u, motivo: 'ningún abonado con ese nombre' })
    } else if (hallado.ambiguo) {
      ambiguas.push({
        onu: u,
        candidatos: hallado.coincidencias.map((x) => ({
          id: x.candidato.id,
          nombre: x.candidato.nombre,
          identificacion: x.candidato.identificacion,
        })),
      })
    } else {
      enlazar.push({ onu: u, cliente: hallado.candidato, como: hallado.como })
    }
  }

  // Dos ONTs que pelean el mismo abonado: pasa cuando alguien tiene dos
  // servicios, o cuando una ONT vieja quedó con la descripción del anterior.
  // Enlazar cualquiera de las dos sería elegir al azar.
  const porCliente = new Map()
  for (const e of enlazar) {
    const lista = porCliente.get(e.cliente.id) ?? []
    lista.push(e)
    porCliente.set(e.cliente.id, lista)
  }

  const definitivas = []
  for (const [, lista] of porCliente) {
    if (lista.length === 1) definitivas.push(lista[0])
    else {
      for (const e of lista) {
        ambiguas.push({
          onu: e.onu,
          candidatos: [{ id: e.cliente.id, nombre: e.cliente.nombre }],
          motivo: `${lista.length} ONTs distintas coinciden con este mismo abonado`,
        })
      }
    }
  }

  return { yaEnlazadas, enlazar: definitivas, ambiguas, crear }
}

/**
 * Enlaza las ONTs con sus abonados, y opcionalmente crea los que faltan.
 *
 * Sin `aplicar` no escribe nada. Y `crear` es una decisión aparte de `aplicar`
 * a propósito: enlazar es reversible y barato, crear ochenta fichas de abonado
 * no lo es.
 *
 * Las fichas nuevas salen SIN plan y SIN identificación, porque el equipo no
 * los sabe. Es la opción segura: un abonado sin plan no se factura, y un abonado
 * con un plan inventado sí — y le llega la factura equivocada al que menos se lo
 * espera.
 */
export async function emparejarAbonados(olt, { aplicar = false, crear = false } = {}) {
  const cliente = db()

  const [rOnus, rClientes] = await Promise.all([
    cliente
      .from('onus')
      .select('id, sn, nombre_cliente, slot, puerto, onu_index, estado, rx_power_dbm')
      .eq('olt_id', olt.id)
      .order('slot')
      .order('puerto')
      .order('onu_index'),
    cliente.from('clientes').select('id, nombre, identificacion, onu_id, estado'),
  ])

  if (rOnus.error) throw badRequest(`No se pudieron leer las ONUs: ${rOnus.error.message}`)
  if (rClientes.error) throw badRequest(`No se pudieron leer los abonados: ${rClientes.error.message}`)

  const plan = planificarAbonados(rOnus.data ?? [], rClientes.data ?? [])

  const resumen = {
    onus: (rOnus.data ?? []).length,
    clientes: (rClientes.data ?? []).length,
    ya_enlazadas: plan.yaEnlazadas.length,
    a_enlazar: plan.enlazar.length,
    ambiguas: plan.ambiguas.length,
    a_crear: plan.crear.length,
  }

  if (!aplicar) {
    return {
      aplicado: false,
      ...resumen,
      enlaces: plan.enlazar.map((e) => ({
        sn: e.onu.sn,
        donde: `${e.onu.slot}/${e.onu.puerto}/${e.onu.onu_index}`,
        nombre_en_la_olt: e.onu.nombre_cliente,
        cliente: e.cliente.nombre,
        client_id: e.cliente.id,
        coincidencia: e.como,
      })),
      revisar: plan.ambiguas.map((a) => ({
        sn: a.onu.sn,
        donde: `${a.onu.slot}/${a.onu.puerto}/${a.onu.onu_index}`,
        nombre_en_la_olt: a.onu.nombre_cliente,
        motivo: a.motivo ?? 'más de un abonado con ese nombre',
        candidatos: a.candidatos,
      })),
      sin_abonado: plan.crear.slice(0, 30).map((c) => ({
        sn: c.onu.sn,
        donde: `${c.onu.slot}/${c.onu.puerto}/${c.onu.onu_index}`,
        nombre_en_la_olt: c.onu.nombre_cliente,
        motivo: c.motivo,
      })),
    }
  }

  const errores = []
  let enlazados = 0
  let creados = 0

  for (const e of plan.enlazar) {
    const { error } = await cliente.from('clientes').update({ onu_id: e.onu.id }).eq('id', e.cliente.id)
    if (error) errores.push(`${e.cliente.nombre}: ${error.message}`)
    else enlazados++
  }

  if (crear) {
    for (const c of plan.crear) {
      if (!c.onu.nombre_cliente) continue

      const { error } = await cliente.from('clientes').insert({
        nombre: c.onu.nombre_cliente.slice(0, 150),
        onu_id: c.onu.id,
        // "onu" deja marcadas estas fichas para poder revisarlas juntas —y para
        // poder deshacer la importación si salió mal.
        origen: 'onu',
        // Sin plan y sin precio: el equipo no los sabe y adivinarlos sería
        // facturar de más o de menos a alguien que no lo pidió.
        estado: 'activo',
      })

      if (error) errores.push(`${c.onu.sn}: ${error.message}`)
      else creados++
    }
  }

  return {
    aplicado: true,
    ...resumen,
    enlazados,
    creados,
    crear_pedido: crear,
    ambiguas_sin_tocar: plan.ambiguas.length,
    errores,
    ...(creados
      ? {
          aviso:
            `Se crearon ${creados} fichas SIN plan ni identificación: el equipo no los tiene. ` +
            'Hasta que se los cargues no se les puede facturar ni aplicar velocidad. ' +
            'Las encontrás filtrando por origen "onu".',
        }
      : {}),
  }
}

/**
 * ONTs conectadas a la fibra que todavía nadie autorizó.
 *
 * Dos pasos, y el orden es lo que hace que esto se pueda consultar seguido:
 *
 *   1. SNMP dice en qué puertos hay candidatas. Es un recorrido, menos de un
 *      segundo, y no consume la sesión CLI del equipo.
 *   2. La CLI confirma SOLO esos puertos.
 *
 * El segundo paso no es opcional: la tabla SNMP conserva ONTs que ya salieron
 * de la cola. Contra el X7 devolvía seis y la cola real tenía una. Publicar el
 * paso 1 solo haría que alguien saliera a buscar cinco equipos inexistentes.
 *
 * Sin candidatas, no se manda ni un comando: el caso normal —no hay nada nuevo—
 * termina en menos de un segundo.
 */
export async function esperandoAutorizacion(olt) {
  const inicio = Date.now()

  if (!olt.snmp_ro_encrypted) {
    throw badRequest('Esta OLT no tiene cargada la comunidad SNMP de lectura', {
      hint: 'Sin SNMP habría que barrer todos los puertos por la CLI, que tarda minutos. Usá "Detectar comunidad" en la ficha.',
    })
  }

  const { candidatas, puertos } = await olts.leerCandidatosSnmp(
    olt,
    decrypt(olt.snmp_ro_encrypted),
  )

  const confirmadas = []
  const descartadas = []

  for (const { slot, puerto } of puertos) {
    const enCola = await olts
      .listarAutofind(olt, { frame: 0, slot, puerto })
      .catch(() => [])

    const series = new Set((enCola ?? []).map((o) => normalizarSn(o.sn)))

    for (const c of candidatas.filter((x) => x.slot === slot && x.puerto === puerto)) {
      const sn = normalizarSn(c.sn)
      const viva = (enCola ?? []).find((o) => normalizarSn(o.sn) === sn)

      if (viva) {
        confirmadas.push({ ...c, sn, modelo: viva.equipmentId ?? viva.modelo ?? null })
      } else {
        // Estaba en el registro del equipo pero ya no en la cola.
        descartadas.push({ ...c, sn })
      }
    }

    // Lo que la CLI ve y SNMP no: se agrega igual. La cola viva manda.
    for (const o of enCola ?? []) {
      const sn = normalizarSn(o.sn)
      if (candidatas.some((c) => normalizarSn(c.sn) === sn)) continue
      confirmadas.push({ slot, puerto, sn, modelo: o.equipmentId ?? o.modelo ?? null, detectada: null })
      series.add(sn)
    }
  }

  return {
    esperando: confirmadas.length,
    onts: confirmadas.sort((a, b) => a.slot - b.slot || a.puerto - b.puerto),
    puertos_consultados: puertos,
    // Se informan pero no se cuentan: son fantasmas del registro del equipo.
    descartadas: descartadas.length,
    ms: Date.now() - inicio,
  }
}

// -----------------------------------------------------------------------------
// Autorización de ONTs
// -----------------------------------------------------------------------------

/**
 * Todo lo que hace falta para llenar el formulario de autorización.
 *
 * La idea: lo que el sistema ya sabe, no se pregunta. El nombre, la dirección y
 * el plan salen de la orden de instalación, que se encuentra sola porque el
 * técnico escaneó el QR de esta misma ONT al instalarla — `instalaciones.
 * equipo_sn` tiene índice único justamente para eso.
 */
export async function datosAutorizacion(olt, sn) {
  const serie = normalizarSn(sn)
  if (!serie) throw badRequest('Falta la serie de la ONT')

  const esperando = await db()
    .from('onts_esperando')
    .select('*')
    .eq('olt_id', olt.id)
    .eq('sn', serie)
    .maybeSingle()

  const ont = esperando.data
  if (!ont) {
    throw badRequest(`La ONT ${serie} no figura esperando autorización en esta OLT`, {
      hint: 'Puede que ya se haya autorizado, o que el último barrido sea viejo. Volvé a escanear.',
    })
  }

  // La instalación se busca por la serie en sus dos notaciones: puede haberse
  // cargado escaneando el QR (forma de etiqueta) o tipeada del comando (hex).
  const { data: instalaciones } = await db()
    .from('instalaciones')
    .select('id, nombre, direccion, plan_id, client_id, estado, equipo_sn, equipo_modelo')
    .neq('estado', 'cancelada')

  const instalacion =
    (instalaciones ?? []).find((i) => normalizarSn(i.equipo_sn) === serie) ?? null

  const [{ data: planes }, perfiles, { data: ocupadas }] = await Promise.all([
    db().from('planes_velocidad').select('*').order('bajada_kbps'),
    olts.listarPerfilesOnt(olt),
    db().from('onus').select('id').eq('olt_id', olt.id).eq('slot', ont.slot).eq('puerto', ont.puerto),
  ])

  const plan = instalacion?.plan_id
    ? (planes ?? []).find((p) => p.id === instalacion.plan_id)
    : null

  // El perfil de servicio se propone por el modelo que reportó la ONT: si el
  // equipo dice "GN256VH" y existe un perfil con ese nombre, es ése.
  const porModelo = ont.modelo
    ? perfiles.srv.find((p) => p.nombre.toUpperCase() === String(ont.modelo).toUpperCase())
    : null

  return {
    olt: { id: olt.id, nombre: olt.nombre },
    ont,
    instalacion,
    planes: planes ?? [],
    perfiles,
    // Un puerto GPON admite 128 ONTs. Saber cuántas quedan evita descubrir que
    // estaba lleno recién cuando el equipo rechaza el alta.
    puerto: {
      capacidad: 128,
      ocupados: (ocupadas ?? []).length,
      libres: 128 - (ocupadas ?? []).length,
    },
    sugerido: {
      // El más usado: el perfil que ya tienen 76 abonados es casi seguro el
      // correcto para el 77.
      line_profile_id: perfiles.line[0]?.id ?? null,
      srv_profile_id: porModelo?.id ?? perfiles.srv[0]?.id ?? null,
      srv_por_modelo: Boolean(porModelo),
      // La VLAN NO se propone. Es el dato que cambia en cada alta y sugerir uno
      // ajeno es peor que dejarlo vacío: se acepta sin mirar.
      vlan: null,
      gemport: 1,
      plan_id: instalacion?.plan_id ?? null,
      nombre: instalacion?.nombre ?? null,
      comentario: instalacion?.direccion ?? null,
      plan: plan?.nombre ?? null,
    },
  }
}

/**
 * Todo lo que se sabe de una ONT que todavía nadie autorizó.
 *
 * Es la pantalla para mirar antes de decidir. La pregunta que contesta no es
 * "¿qué modelo es?" sino "¿esta ONT quién es y de dónde salió?", que se
 * responde con tres cosas distintas:
 *
 *   - lo que dice el equipo AHORA (no lo que guardamos en el último barrido)
 *   - hace cuánto la está viendo, que separa "se conectó recién" de "lleva seis
 *     días esperando que alguien la mire"
 *   - si esa serie aparece en alguna orden de instalación, o si ya estuvo dada
 *     de alta antes en esta u otra OLT
 *
 * Ese último cruce es el que evita el error caro: autorizar como nueva una ONT
 * que en realidad es la de un abonado que se mudó, o que ya está contada en
 * otra OLT.
 */
export async function detalleEsperando(olt, sn) {
  const serie = normalizarSn(sn)
  if (!serie) throw badRequest('Falta la serie de la ONT')

  const { data: guardada } = await db()
    .from('onts_esperando')
    .select('*')
    .eq('olt_id', olt.id)
    .eq('sn', serie)
    .maybeSingle()

  if (!guardada) {
    throw badRequest(`La ONT ${serie} no figura esperando autorización en esta OLT`, {
      hint: 'Puede que ya se haya autorizado, o que el último barrido sea viejo. Probá "Resincronizar".',
    })
  }

  // Se le pregunta al equipo en vez de confiar en lo guardado: entre el último
  // barrido y ahora la ONT pudo haberse desconectado, y mandar a alguien a
  // autorizar un equipo que ya no está es un viaje perdido.
  const enVivo = await olts
    .listarAutofind(olt, { frame: 0, slot: guardada.slot, puerto: guardada.puerto })
    .then((lista) => (lista ?? []).find((o) => normalizarSn(o.sn) === serie) ?? null)
    .catch(() => undefined) // undefined = no se pudo preguntar; null = se preguntó y no está

  const [{ data: instalaciones }, { data: yaAlta }, perfiles] = await Promise.all([
    db()
      .from('instalaciones')
      .select('id, nombre, direccion, plan_id, client_id, estado, equipo_sn, equipo_modelo')
      .neq('estado', 'cancelada'),
    db()
      .from('onus')
      .select('id, olt_id, slot, puerto, onu_index, nombre_cliente, estado')
      .eq('sn', serie),
    olts.listarPerfilesOnt(olt).catch(() => null),
  ])

  const instalacion = (instalaciones ?? []).find((i) => normalizarSn(i.equipo_sn) === serie) ?? null
  const modelo = enVivo?.equipmentId ?? guardada.modelo ?? null
  const perfilPorModelo = modelo
    ? (perfiles?.srv ?? []).find((p) => p.nombre.toUpperCase() === String(modelo).toUpperCase())
    : null

  return {
    olt: { id: olt.id, nombre: olt.nombre },
    sn: serie,
    sn_hex: aHexSn(serie),
    slot: guardada.slot,
    puerto: guardada.puerto,
    // null es distinto de false: "el equipo dice que no está" no es lo mismo que
    // "no se pudo preguntar".
    en_la_cola: enVivo === undefined ? null : Boolean(enVivo),
    modelo,
    fabricante: enVivo?.vendorId ?? null,
    version_hw: enVivo?.version ?? null,
    version_sw: enVivo?.softwareVersion ?? null,
    mac: enVivo?.mac ?? null,
    loid: enVivo?.loid ?? null,
    detectada: enVivo?.detectadaEn ?? guardada.detectada ?? null,
    visto_at: guardada.visto_at,
    // Lo que hace que valga la pena mirar antes de autorizar.
    instalacion,
    ya_dada_de_alta: (yaAlta ?? []).map((o) => ({
      ...o,
      es_esta_olt: o.olt_id === olt.id,
    })),
    perfil_sugerido: perfilPorModelo
      ? { id: perfilPorModelo.id, nombre: perfilPorModelo.nombre, por_modelo: true }
      : null,
  }
}

/**
 * Vuelve a preguntarle al equipo por una ONT que está esperando.
 *
 * El barrido general corre cada cinco minutos y toca todos los puertos de todas
 * las OLTs. Esto pregunta por un solo puerto y contesta en segundos, que es lo
 * que hace falta cuando alguien acaba de conectar una ONT y está parado
 * mirando la pantalla.
 *
 * Si el equipo ya no la ve, se la saca de la cola en vez de dejarla ahí: una
 * ONT que se muestra esperando y no existe manda a un técnico a buscar un
 * equipo que no está.
 */
export async function resincronizarEsperando(olt, sn) {
  const serie = normalizarSn(sn)
  if (!serie) throw badRequest('Falta la serie de la ONT')

  const { data: guardada } = await db()
    .from('onts_esperando')
    .select('*')
    .eq('olt_id', olt.id)
    .eq('sn', serie)
    .maybeSingle()

  if (!guardada) {
    throw badRequest(`La ONT ${serie} no figura esperando autorización en esta OLT`)
  }

  const enVivo = (await olts.listarAutofind(olt, { frame: 0, slot: guardada.slot, puerto: guardada.puerto }))
    ?.find((o) => normalizarSn(o.sn) === serie)

  if (!enVivo) {
    await db().from('onts_esperando').delete().eq('id', guardada.id)
    return {
      sigue: false,
      sn: serie,
      slot: guardada.slot,
      puerto: guardada.puerto,
      aviso:
        `El equipo ya no ve la ONT ${serie} en ${guardada.slot}/${guardada.puerto}. ` +
        'Se la sacó de la cola: o la autorizó alguien más, o la desconectaron.',
    }
  }

  const { data: actualizada } = await db()
    .from('onts_esperando')
    .update({
      modelo: enVivo.equipmentId ?? guardada.modelo,
      detectada: enVivo.detectadaEn ?? guardada.detectada,
      visto_at: new Date().toISOString(),
    })
    .eq('id', guardada.id)
    .select()
    .maybeSingle()

  return {
    sigue: true,
    sn: serie,
    slot: guardada.slot,
    puerto: guardada.puerto,
    modelo: actualizada?.modelo ?? null,
    detectada: actualizada?.detectada ?? null,
    visto_at: actualizada?.visto_at ?? null,
  }
}

/**
 * Autoriza la ONT: la registra en el equipo y le crea su service-port.
 *
 * Son dos pasos y el segundo puede fallar solo. Si pasa, la ONT queda
 * registrada pero sin tráfico — y eso se informa tal cual, porque una respuesta
 * de error a secas haría pensar que no se hizo nada y el siguiente intento
 * chocaría con una ONT que ya existe.
 */
/**
 * Le pone a la ONT su dirección de gestión, tomándola del pool de la OLT.
 *
 * Es automático a propósito. Un técnico arriba de una escalera no puede elegir
 * qué dirección está libre, y elegirla mal —repetir una— deja a DOS ONTs sin
 * poder ser administradas, no a una: las dos responden al ACS y ninguna de las
 * dos configuración llega a destino.
 *
 * Sin pool cargado no se hace nada y se dice por qué. Es preferible a inventar
 * un rango: una IP de gestión fuera de la VLAN correcta no llega a ningún lado
 * y el síntoma —"la ONT está online pero no se le puede cambiar el WiFi"—
 * aparece semanas después.
 *
 * La reserva se hace ANTES de tocar el equipo y se libera si el equipo falla.
 * Al revés, dos altas simultáneas se llevarían la misma dirección.
 */
async function provisionarIpDeGestion(olt, { slot, puerto, ontId, nombre, modelo }) {
  // Un modelo que ya sabemos que no acepta configuración remota no se intenta:
  // el técnico está esperando arriba de una escalera y el intento tarda y falla.
  // "No se sabe" (null) SÍ se intenta, y el resultado queda aprendido.
  const soporta = await manual.soportaTr069(modelo, olt.marca)
  if (soporta === false) {
    return {
      sin_tr069: true,
      aviso: `El modelo ${modelo} no acepta configuración remota: hay que cargarlo a mano en el equipo.`,
    }
  }

  const { data: pools } = await db()
    .from('v_pools_onu')
    .select('*')
    .eq('olt_id', olt.id)
    .eq('proposito', 'gestion_onu')
    .eq('activo', true)

  if (!pools?.length) {
    return {
      aviso:
        'La ONT quedó sin IP de gestión: esta OLT no tiene ningún pool cargado. ' +
        'Sin eso no se le puede empujar la configuración por TR069.',
    }
  }

  // El que más lugar tiene. Con varios pools —uno por zona, o uno que se
  // llenó— es el único criterio que no deja a nadie afuera.
  const pool = [...pools].sort((a, b) => (b.libres ?? 0) - (a.libres ?? 0))[0]
  if (!pool.libres) {
    return { aviso: `El pool de gestión ${pool.cidr} no tiene direcciones libres.` }
  }

  let reserva = null
  try {
    const { data: libres } = await db()
      .from('ip_addresses')
      .select('id, ip_address')
      .eq('subred_id', pool.id)
      .eq('estado', 'libre')

    if (!libres?.length) return { aviso: `El pool de gestión ${pool.cidr} se quedó sin libres.` }

    const primera = libres.sort((a, b) => (aEntero(a.ip_address) ?? 0) - (aEntero(b.ip_address) ?? 0))[0]

    // Se toma la dirección antes de escribir en el equipo. Si dos altas corren
    // a la vez, la segunda ya no la ve libre.
    const { data: tomada } = await db()
      .from('ip_addresses')
      .update({
        estado: 'asignada',
        descripcion: `Gestión · ${nombre ?? 'ONT'}`.slice(0, 150),
        origen: 'alta',
      })
      .eq('id', primera.id)
      .eq('estado', 'libre')
      .select('id, ip_address')
      .maybeSingle()

    if (!tomada) return { aviso: 'Otra alta tomó la dirección de gestión al mismo tiempo.' }
    reserva = tomada

    const r = await olts.configurarIpGestionOnu(olt, {
      frame: 0,
      slot,
      puerto,
      ontId,
      ip: tomada.ip_address,
      mascara: mascaraDeCidr(pool.cidr),
      gateway: pool.gateway,
      dns1: pool.dns1,
      dns2: pool.dns2,
      vlan: pool.vlan,
    })

    await manual.anotarSoporteTr069(modelo, true, olt.marca)
    const servicePort = await asegurarServicePortGestion(olt, { slot, puerto, ontId, vlan: pool.vlan })
    return {
      ip: tomada.ip_address,
      ip_id: tomada.id,
      pool_id: pool.id,
      comando: r.comando,
      servicePort,
      aviso: servicePort.aviso,
      leido: r,
      // Los datos de red que el técnico necesitaría si además tiene que tocar
      // el equipo a mano.
      datos: {
        ip: tomada.ip_address,
        mascara: mascaraDeCidr(pool.cidr),
        gateway: pool.gateway,
        dns1: pool.dns1,
        dns2: pool.dns2,
        vlan: pool.vlan,
      },
    }
  } catch (err) {
    // El equipo la rechazó: la dirección vuelve al pool. Dejarla tomada haría
    // que cada intento fallido consumiera una, y el pool se vaciaría sin que
    // ninguna ONT la tenga puesta.
    if (reserva) {
      await db()
        .from('ip_addresses')
        .update({ estado: 'libre', descripcion: null, onu_id: null, origen: 'manual' })
        .eq('id', reserva.id)
    }
    // Que UNA ONT haya fallado no prueba que el modelo no sirva —pudo estar
    // apagada— así que no se anota nada: anotarlo dejaría a todo un modelo sin
    // aprovisionamiento automático por un incidente suelto.
    return {
      sin_tr069: true,
      aviso: `No se pudo poner la IP de gestión: ${err.message}. La dirección volvió al pool.`,
    }
  }
}

/**
 * Sin el service-port de la VLAN de gestión, la IP de gestión no tiene por
 * dónde salir. Gemport 2 porque la gestión sale con prioridad 802.1p 2.
 * No lanza: una ONT sin gestión igual tiene servicio.
 */
async function asegurarServicePortGestion(olt, { slot, puerto, ontId, vlan }) {
  if (vlan == null) return { aviso: 'Sin VLAN de gestión: no se creó su service-port.' }
  try {
    const actuales = await olts.listarServicePortsDeOnt(olt, { frame: 0, slot, puerto, ontId })
    const existente = actuales.find((sp) => sp.vlan === Number(vlan))
    if (existente) return { indice: existente.indice, existente: true }
    const r = await olts.crearServicePortOlt(olt, {
      frame: 0,
      slot,
      puerto,
      ontId,
      vlan: Number(vlan),
      gemport: 2,
    })
    return { indice: r.indice, comando: r.comando }
  } catch (err) {
    return {
      aviso: `La IP de gestión quedó puesta, pero falló su service-port (VLAN ${vlan}): ${err.message}`,
    }
  }
}

/** 255.255.255.0 a partir de un /24. */
const mascaraDeCidr = (cidr) => {
  const bits = Number(String(cidr ?? '').split('/')[1])
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return '255.255.255.0'
  const m = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return [(m >>> 24) & 255, (m >>> 16) & 255, (m >>> 8) & 255, m & 255].join('.')
}

export async function autorizarOnt(olt, datos) {
  const {
    sn,
    slot,
    puerto,
    ontId,
    lineProfileId,
    srvProfileId,
    vlan,
    gemport = 1,
    nombre,
    comentario,
    plan_id,
    instalacion_id,
  } = datos

  const serie = normalizarSn(sn)
  if (!serie) throw badRequest('Falta la serie de la ONT')
  if (vlan == null) throw badRequest('Falta la VLAN de usuario')

  // La descripción con el mismo formato que ya usan las otras ONTs del equipo,
  // para que se siga leyendo igual desde la CLI y desde cualquier otro sistema.
  const hoy = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const descripcion = [nombre, comentario ? `descr_${comentario}` : null, `authd_${hoy}`]
    .filter(Boolean)
    .join('_')

  // El modelo lo dijo el propio equipo cuando la vio aparecer. Se lee ANTES de
  // autorizar porque el alta la saca de la cola de espera y después ya no está.
  const { data: enCola } = await db()
    .from('onts_esperando')
    .select('modelo')
    .eq('olt_id', olt.id)
    .eq('sn', serie)
    .maybeSingle()
  const modelo = enCola?.modelo ?? null

  const comandos = []
  const registro = await olts.registrarOnu(olt, {
    frame: 0,
    slot,
    puerto,
    onuId: ontId,
    sn: serie,
    descripcion,
    lineProfileId: lineProfileId ? Number(lineProfileId) : null,
    srvProfileId: srvProfileId ? Number(srvProfileId) : null,
  })
  comandos.push(registro.comando)

  // Velocidad: sale de la traffic table del plan. Sin índice no se puede
  // aplicar, y se sigue igual — es mejor un abonado conectado sin shaping que
  // un alta que falla entera.
  let plan = null
  if (plan_id) {
    const { data } = await db().from('planes_velocidad').select('*').eq('id', plan_id).maybeSingle()
    plan = data
  }
  // Una tabla por sentido. El equipo las pide separadas y casi todos los planes
  // son asimétricos: con un solo índice, el límite de bajada se le aplicaba
  // también a la subida.
  //
  // Se cae a la columna vieja para los planes que todavía no se migraron.
  const ttSubida = plan?.traffic_table_subida ?? plan?.traffic_table_index ?? null
  const ttBajada = plan?.traffic_table_bajada ?? plan?.traffic_table_index ?? null

  let servicePort = null
  let aviso = null
  try {
    servicePort = await olts.crearServicePortOlt(olt, {
      frame: 0,
      slot,
      puerto,
      ontId: registro.ontId,
      vlan: Number(vlan),
      gemport: Number(gemport) || 1,
      // "inbound" es lo que SUBE el abonado y "outbound" lo que baja. Cruzarlos
      // le daría la velocidad de bajada en la subida, y nadie lo relaciona con
      // el alta de tres meses antes.
      ttEntrada: ttSubida,
      ttSalida: ttBajada,
    })
    comandos.push(servicePort.comando)
    if (servicePort.sinVelocidad) {
      aviso = plan
        ? `El plan "${plan.nombre}" no tiene índice de traffic table, así que la ONT quedó sin límite de velocidad aplicado.`
        : 'No se eligió plan: la ONT quedó con servicio pero sin límite de velocidad.'
    }
  } catch (err) {
    aviso =
      `La ONT quedó REGISTRADA (ONT-ID ${registro.ontId}) pero su service-port falló: ${err.message}. ` +
      'Sin service-port no pasa tráfico. No hace falta volver a registrarla — solo crear el service-port.'
  }

  // --- La IP de gestión ------------------------------------------------------
  //
  // Es lo que convierte un alta en un alta completa. Sin ella la ONT pasa
  // tráfico pero nadie puede hablarle: ni el ACS para empujarle el usuario y la
  // clave PPPoE, ni el sistema para leerle el WiFi o reiniciarla.
  //
  // Va DESPUÉS del service-port del abonado y su fallo no tumba el alta: es
  // mejor un abonado conectado al que le falta la gestión que un alta que se
  // cae entera con la ONT ya registrada a medias.
  const gestion = await provisionarIpDeGestion(olt, {
    slot,
    puerto,
    ontId: registro.ontId,
    nombre,
    modelo,
  })
  if (gestion?.comando) comandos.push(gestion.comando)
  if (gestion?.servicePort?.comando) comandos.push(gestion.servicePort.comando)
  if (gestion?.aviso) aviso = [aviso, gestion.aviso].filter(Boolean).join(' · ')

  // Recién ahora la base. El orden importa: si el equipo rechazó el alta, no
  // queremos una fila fantasma que diga que existe una ONT que no está.
  const { data: fila, error } = await db()
    .from('onus')
    .upsert(
      {
        olt_id: olt.id,
        sn: serie,
        nombre_cliente: (nombre ?? '').slice(0, 150) || null,
        frame: 0,
        slot,
        puerto,
        onu_index: registro.ontId,
        plan_id: plan_id || null,
        plan_velocidad: plan?.nombre ?? null,
        estado: 'offline',
        autorizada_at: new Date().toISOString().slice(0, 10),
        // Lo que ya sabemos en este momento y hasta ahora se tiraba. Guardarlo
        // acá es la diferencia entre un listado de novecientas ONUs que se
        // resuelve con una consulta y uno que necesitaría mil sesiones SSH.
        modelo: modelo ?? null,
        vlan: Number(vlan),
        direccion: comentario ?? null,
        descripcion_olt: descripcion,
        line_profile_olt: lineProfileId ?? null,
        srv_profile_olt: srvProfileId ?? null,
        ficha_leida_at: new Date().toISOString(),
      },
      { onConflict: 'olt_id,sn' },
    )
    .select()
    .single()

  // La dirección de gestión queda enganchada a la ONU. Se hace acá y no al
  // reservarla porque recién ahora existe la fila: antes no había a qué
  // apuntar, y una dirección "asignada" sin dueño es lo que la pantalla de
  // pools marca como "requiere atención".
  if (gestion?.ip_id && fila?.id) {
    await db().from('ip_addresses').update({ onu_id: fila.id }).eq('id', gestion.ip_id)
  }

  // --- La ficha para cargar el equipo a mano ---------------------------------
  //
  // Sale siempre que el aprovisionamiento automático no haya podido dejar la
  // ONT lista: modelo sin TR069, sin pool cargado, o el intento falló. El
  // técnico está en la calle con el equipo en la mano y necesita el usuario y
  // la clave PPPoE, la VLAN y el WiFi juntos — no repartidos en tres pantallas.
  //
  // El SSID y la clave del WiFi se generan acá: que el técnico los invente en
  // el momento es cómo se termina con cincuenta redes llamadas "WIFI" y la
  // clave "12345678".
  let fichaManual = null
  if (gestion?.sin_tr069 || !gestion?.ip) {
    const { data: inst } = instalacion_id
      ? await db()
          .from('instalaciones')
          .select('usuario_ppp, clave_ppp')
          .eq('id', instalacion_id)
          .maybeSingle()
      : { data: null }

    fichaManual = await manual.armarFichaManual({
      onu: { ...(fila ?? {}), sn: serie, nombre_cliente: nombre },
      instalacion: inst,
      vlan: Number(vlan),
      gestion: gestion?.datos ?? null,
      marcaSsid: olt.nombre_red ?? 'WIFI',
    })

    // El WiFi propuesto se guarda ya: si el técnico lo usa —y es lo que va a
    // pasar— tiene que quedar anotado para cuando el abonado llame preguntando
    // su clave, que es la consulta más frecuente del soporte.
    if (fila?.id) {
      await manual.guardarConfiguracionManual(fila.id, {
        ssid: fichaManual.wifi.ssid,
        clave_wifi: fichaManual.wifi.clave,
        configurada_por: 'manual',
      })
    }
  } else if (fila?.id) {
    await db().from('onus').update({ configurada_por: 'tr069' }).eq('id', fila.id)
  }

  // Ya no está esperando.
  await db().from('onts_esperando').delete().eq('olt_id', olt.id).eq('sn', serie)

  // La instalación queda enlazada a su ONU, que es lo que después permite
  // cerrarla y convertirla en abonado.
  if (instalacion_id && fila?.id) {
    await db().from('instalaciones').update({ onu_id: fila.id }).eq('id', instalacion_id)
  }

  return {
    ok: true,
    slot,
    puerto,
    ontId: registro.ontId,
    sn: serie,
    servicePort: servicePort?.indice ?? null,
    // La dirección con la que el ACS va a poder configurarle el PPPoE.
    ip_gestion: gestion?.ip ?? null,
    // Cuando no se pudo configurar sola, lo que hay que escribir a mano.
    ...(fichaManual ? { ficha_manual: fichaManual } : {}),
    // Lo necesita quien autoriza sin persona delante: sin el id no puede dejar
    // anotado a qué ONU corresponde la carga que acaba de entrar.
    onu_id: fila?.id ?? null,
    guardadaEnBase: Boolean(fila) && !error,
    ...(error ? { errorBase: error.message } : {}),
    comandos,
    ...(aviso ? { aviso } : {}),
  }
}

// -----------------------------------------------------------------------------
// Operaciones sobre una ONT ya instalada
// -----------------------------------------------------------------------------

/** Carga la ONU de la base y verifica que sea de esta OLT. */
async function ontDeLaBase(olt, onuId) {
  const { data, error } = await db()
    .from('onus')
    .select('*')
    .eq('id', onuId)
    .eq('olt_id', olt.id)
    .maybeSingle()

  if (error) throw badRequest(`No se pudo leer la ONU: ${error.message}`)
  if (!data) throw badRequest('Esa ONU no existe en esta OLT')
  return data
}

/**
 * Cambia el plan de una ONT ya instalada.
 *
 * No corta el servicio: el equipo deja modificar las traffic-tables de un
 * service-port existente, así que no hay que rehacerlo.
 *
 * Se aplica primero en el equipo y recién después en la base. Al revés, un
 * rechazo de la OLT dejaría al abonado facturado por un plan que no tiene.
 */
export async function cambiarPlan(olt, { onuId, planId }) {
  const onu = await ontDeLaBase(olt, onuId)

  const { data: plan } = await db().from('planes_velocidad').select('*').eq('id', planId).maybeSingle()
  if (!plan) throw badRequest('Ese plan no existe')

  const ttSubida = plan.traffic_table_subida ?? plan.traffic_table_index
  const ttBajada = plan.traffic_table_bajada ?? plan.traffic_table_index

  if (ttSubida == null || ttBajada == null) {
    throw badRequest(`El plan "${plan.nombre}" no tiene índices de traffic table`, {
      hint: 'Sin ellos no se puede aplicar velocidad en la OLT. Asignáselos desde Servicios → Planes.',
    })
  }

  // Que existan. Un índice inventado hace que el equipo rechace el comando, y
  // sin esto el abonado se enteraría por el rechazo en medio de un cambio de
  // plan que él ya pagó.
  const tablas = await olts.leerTrafficTables(olt).catch(() => null)
  if (tablas) {
    const hay = new Set(tablas.map((t) => t.index))
    const faltan = [ttSubida, ttBajada].filter((i) => !hay.has(i))
    if (faltan.length) {
      throw badRequest(
        `La OLT no tiene la traffic table ${[...new Set(faltan)].join(' ni la ')}`,
        {
          hint: `El plan "${plan.nombre}" apunta a un índice que no existe en este equipo. Corregilo en Servicios → Planes.`,
        },
      )
    }
  }

  const r = await olts.cambiarPlanDeOnt(olt, {
    frame: onu.frame ?? 0,
    slot: onu.slot,
    puerto: onu.puerto,
    ontId: onu.onu_index,
    ttEntrada: ttSubida,
    ttSalida: ttBajada,
  })

  const { error } = await db()
    .from('onus')
    .update({ plan_id: plan.id, plan_velocidad: plan.nombre })
    .eq('id', onu.id)

  return {
    ok: true,
    sn: onu.sn,
    plan: plan.nombre,
    velocidad: `${Math.round(plan.bajada_kbps / 1000)}/${Math.round(plan.subida_kbps / 1000)} Mbps`,
    service_ports: r.servicePorts,
    comandos: r.comandos,
    guardadoEnBase: !error,
    ...(error ? { aviso: `Se aplicó en el equipo pero no se pudo guardar: ${error.message}` } : {}),
  }
}

/**
 * La ficha completa de una ONU: lo guardado más lo que dice el equipo AHORA.
 *
 * Las dos cosas juntas y separadas, no mezcladas. Una pantalla que muestra un
 * solo bloque de datos sin decir de dónde sale cada uno hace imposible la
 * pregunta que importa cuando algo no cuadra: ¿esto es lo que el equipo tiene
 * configurado, o lo que nosotros creemos que tiene?
 *
 * Lo del equipo puede fallar —está apagado, no hay sesión libre— y eso no puede
 * tumbar la ficha entera: se devuelve lo guardado igual, con el motivo.
 */
export async function fichaOnu(olt, onuId) {
  const onu = await ontDeLaBase(olt, onuId)

  const { data: vista } = await db()
    .from('v_onus_clientes')
    .select('*')
    .eq('onu_id', onu.id)
    .maybeSingle()

  const ubicacion = {
    frame: onu.frame ?? 0,
    slot: onu.slot,
    puerto: onu.puerto,
    ontId: onu.onu_index,
  }

  // Las dos lecturas van juntas y cada una con su propio catch: la óptica es
  // OMCI en vivo y no contesta con la ONT caída, que es justo cuando más falta
  // hace ver el resto de la ficha.
  const [config, optica] = await Promise.all([
    olts.leerConfigCompletaOnt(olt, ubicacion).catch((err) => ({ error: err.message })),
    olts
      .leerMetricas(olt, { ...ubicacion, onuId: onu.onu_index })
      .catch((err) => ({ error: err.message })),
  ])

  const { data: historial } = await db()
    .from('onu_optica_historial')
    .select('leida_at, rx_power_dbm, tx_power_dbm')
    .eq('onu_id', onu.id)
    .order('leida_at', { ascending: false })
    .limit(60)

  return {
    guardado: vista ?? onu,
    // null cuando no se pudo preguntar. Distinto de un objeto vacío: "no se
    // pudo leer" no es "no tiene nada configurado".
    equipo: config?.error ? null : config,
    optica: optica?.error || !optica?.online ? null : normalizarOptica(optica),
    historial_optico: (historial ?? []).reverse(),
    problemas: [
      config?.error,
      optica?.error,
      // Que la ONT esté caída no es un error de lectura: es la respuesta. Se
      // informa con el motivo que dio el equipo, que es lo que hace falta.
      !optica?.error && optica?.online === false ? optica.mensaje : null,
    ].filter(Boolean),
  }
}

/**
 * El driver devuelve la óptica en camelCase y el resto del sistema la nombra
 * como las columnas de la base. Se traduce acá, en un solo lugar.
 *
 * No es cosmética: la pantalla leía `rx_power_dbm` de un objeto que traía
 * `rxPowerDbm`, así que mostraba un guion donde había una medición real. Un
 * hueco donde hay dato se lee como "no tiene señal".
 */
const normalizarOptica = (o) => ({
  rx_power_dbm: o.rxPowerDbm ?? null,
  tx_power_dbm: o.txPowerDbm ?? null,
  olt_rx_power_dbm: o.olrRxPowerDbm ?? null,
  distancia_m: o.distanciaM ?? null,
  modelo: o.version?.modelo ?? null,
  version_hw: o.version?.versionHardware ?? null,
  version_sw: o.version?.versionSoftware ?? null,
  fabricante: o.version?.vendorId ?? null,
  causa: o.causa ?? null,
  causa_cruda: o.causaCruda ?? o.causa_cruda ?? null,
  ultima_caida: o.ultimaCaida ?? o.ultima_caida ?? null,
})

/**
 * Vuelve a leer del equipo lo que tenemos guardado de una ONU y lo actualiza.
 *
 * NO le envía nada a la ONT: solo corrige NUESTRA copia. Es la operación
 * opuesta a `reprovisionarOnu`, y por eso no se llama "resincronizar" — con ese
 * nombre al lado del otro botón, tarde o temprano alguien aprieta el que no era.
 *
 * Hace falta porque nuestra
 * copia se escribe una vez, al darla de alta, y desde entonces cualquiera puede
 * haber cambiado la configuración por la CLI sin que este sistema se entere.
 *
 * Solo se pisan los campos que el equipo contestó. Un campo que no vino no se
 * borra: "no lo leí" no es "no tiene".
 */
export async function actualizarFichaOnu(olt, onuId) {
  const onu = await ontDeLaBase(olt, onuId)

  const ubicacion = {
    frame: onu.frame ?? 0,
    slot: onu.slot,
    puerto: onu.puerto,
    ontId: onu.onu_index,
  }

  const config = await olts.leerConfigCompletaOnt(olt, ubicacion)

  // El modelo no está en `display ont info`: lo dice `display ont version`, que
  // es una consulta OMCI y solo contesta con la ONT online. Por eso va aparte y
  // con su propio catch — que no se pueda leer el modelo no puede tumbar el
  // resto de la resincronización.
  const metricas = await olts
    .leerMetricas(olt, { ...ubicacion, onuId: onu.onu_index })
    .catch(() => null)

  // El service-port de la VLAN de servicio es el que NO es el de gestión. La de
  // gestión es la misma para todos y no dice nada del abonado.
  const servicio = (config.servicePorts ?? []).find((s) => s.vlan !== 999) ?? config.servicePorts?.[0]

  const cambios = { ficha_leida_at: new Date().toISOString() }
  const anotar = (campo, valor) => {
    if (valor != null && valor !== '') cambios[campo] = valor
  }

  anotar('modelo', metricas?.version?.modelo)
  anotar('rx_power_dbm', metricas?.rxPowerDbm)
  anotar('tx_power_dbm', metricas?.txPowerDbm)
  anotar('distancia_m', metricas?.distanciaM)
  anotar('descripcion_olt', config.descripcion)
  anotar('line_profile_olt', config.lineProfileId)
  anotar('srv_profile_olt', config.srvProfileId)
  anotar('srv_profile_nombre', config.srvProfileNombre)
  anotar('vlan', servicio?.vlan)
  // El estado tiene una excepción: una ONT suspendida se ve OFFLINE desde el
  // equipo, igual que una caída. Pisarla con "offline" perdería el dato de que
  // el corte fue nuestro y por falta de pago, no un problema de red — y alguien
  // saldría a revisar una fibra que está perfecta.
  //
  // Fuera de ese caso sí se pisa: dejar "online" una ONT que el equipo reporta
  // caída escondería un corte real.
  if (config.estado === 'online') cambios.estado = 'online'
  else if (config.estado && onu.estado !== 'unknown') cambios.estado = 'offline'

  const { error } = await db().from('onus').update(cambios).eq('id', onu.id)

  // Qué cambió respecto de lo que teníamos. Es lo que hace útil el botón: si no
  // cambió nada, eso también es una respuesta.
  //
  // Las MEDICIONES quedan afuera. La potencia óptica varía una décima entre dos
  // lecturas seguidas, así que incluirlas hacía que el botón informara cambios
  // siempre —"tx 2.20 → 2.33"— y un aviso que aparece siempre deja de leerse.
  // Se guardan igual, pero lo que se reporta es qué cambió de la CONFIGURACIÓN,
  // que es la pregunta que uno viene a hacerle a este botón.
  const MEDICIONES = new Set(['rx_power_dbm', 'tx_power_dbm', 'distancia_m', 'ficha_leida_at'])
  const diferencias = Object.entries(cambios)
    .filter(([k]) => !MEDICIONES.has(k))
    .filter(([k, v]) => String(onu[k] ?? '') !== String(v ?? ''))
    .map(([k, v]) => ({ campo: k, antes: onu[k] ?? null, ahora: v }))

  return {
    ok: true,
    sn: onu.sn,
    diferencias,
    sin_cambios: diferencias.length === 0,
    service_ports: config.servicePorts ?? [],
    guardadoEnBase: !error,
    ...(error ? { aviso: `Se leyó del equipo pero no se pudo guardar: ${error.message}` } : {}),
  }
}

/**
 * Vuelve a enviarle la configuración a la ONT.
 *
 * Es el "resync config" del taller, y contesta un problema muy concreto: la
 * configuración que viaja por TR069 a veces no se aplica. La ONT queda online,
 * el sistema dice que está todo bien, y el abonado no tiene servicio o le falta
 * parte de lo que contrató. Nada en la pantalla lo delata.
 *
 * `ont re-register` fuerza a la ONT a reasociarse, y en esa reasociación la OLT
 * le vuelve a empujar todo: perfiles, service-ports y la configuración TR069.
 *
 * OJO: NO es lo mismo que "actualizar la ficha". Aquélla lee del equipo para
 * corregir NUESTRA copia; ésta escribe en el equipo. Tenerlas con nombres
 * parecidos sería garantizar que alguien apriete la que no era.
 */
/**
 * Cómo sale a internet esta ONU.
 *
 * Devuelve las conexiones WAN que el equipo declara, más los perfiles de WAN
 * que tiene la OLT para poder elegir. Los dos en una sola llamada porque la
 * pantalla necesita las dos cosas y cada consulta al equipo es una sesión SSH.
 *
 * `soportado: false` significa que ESE MODELO no sabe contestar la consulta
 * —pasa con Skyworth y con H3—, no que la ONT esté sin WAN.
 */
export async function leerWanOnu(olt, onuId) {
  const onu = await ontDeLaBase(olt, onuId)
  const ubicacion = {
    frame: onu.frame ?? 0,
    slot: onu.slot,
    puerto: onu.puerto,
    ontId: onu.onu_index,
  }

  const [wan, perfiles, tr069] = await Promise.all([
    olts.leerWanDeOnt(olt, ubicacion),
    olts.listarWanProfiles(olt).catch(() => []),
    leerWanTr069(onu.sn),
  ])

  return { sn: onu.sn, ...wan, perfiles, tr069 }
}

/**
 * Lo que la ONT reporta de su WAN por TR-069 —dirección, PPPoE, DNS—, que es
 * justo lo que el perfil de la OLT no guarda.
 *
 * Nunca lanza: una ONT sin ACS, sin serie, o que el ACS no conoce todavía es un
 * estado normal de esta pantalla, no un error que tumbe el resto de la ficha.
 */
async function leerWanTr069(sn) {
  if (!sn) return { gestionable: false, motivo: 'sin_serie' }
  if (!hayAcs()) return { gestionable: false, motivo: 'sin_acs' }

  let equipo = null
  try {
    equipo = await buscarPorSerie(sn)
  } catch (err) {
    return { gestionable: false, motivo: 'acs_no_responde', error: err.message }
  }
  if (!equipo) return { gestionable: false, motivo: 'equipo_desconocido' }

  const modelo = modeloDe(equipo)
  return {
    gestionable: true,
    ultimo_contacto: equipo._lastInform ?? null,
    modelo: modelo?.nombre ?? null,
    wan: modelo ? genieacsWan.leerWan(equipo, { modelo: modelo.nombre }) : null,
  }
}

/**
 * Le manda a la ONT, por TR-069, la dirección, el PPPoE, o el DHCP de su WAN.
 *
 * ── Por qué es una función distinta de `configurarWanOnu` ──
 *
 * Esa escribe en la OLT, por SSH, el PERFIL —modo y NAT—. Esta escribe adentro
 * del equipo, por el ACS, los datos que el perfil no guarda. Son dos
 * transportes que fallan por separado: si se mezclaran en una sola función, un
 * error del ACS se leería como un error de la OLT y al revés.
 */
export async function configurarWanTr069Onu(olt, onuId, datos = {}) {
  const onu = await ontDeLaBase(olt, onuId)
  if (!onu.sn) throw badRequest('Esta ONU no tiene número de serie cargado')
  if (!hayAcs()) {
    throw badRequest('No hay servidor TR-069 configurado en este sistema', {
      hint: 'Definí GENIEACS_URL en middleware/.env apuntando al NBI de GenieACS.',
    })
  }

  const equipo = await buscarPorSerie(onu.sn)
  if (!equipo) {
    throw badRequest('La ONT nunca se reportó al servidor TR-069', {
      hint: 'Revisá que tenga el perfil TR-069 apuntado, la IP de gestión, y que haya levantado la interfaz.',
    })
  }

  const r = await genieacsWan.aplicar(equipo, datos)
  return {
    ok: true,
    sn: onu.sn,
    ...r,
    aviso: r.aplicado
      ? 'La WAN quedó aplicada en el equipo por TR-069.'
      : 'El equipo no contestó al pedido: la tarea quedó guardada en el ACS y se aplica cuando informe.',
  }
}

/**
 * Configura la WAN de una ONU.
 *
 * ── Qué le cambia al abonado ──
 *
 * Todo: es por dónde y cómo sale a internet. Pasar una ONT de puente a enrutada
 * hace que deje de entregar la IP que entregaba. Por eso la ruta exige
 * confirmar, y por eso `ip_index` se pide explícito: la WAN de gestión vive en
 * su propio índice y pisarla dejaría a la ONT sin ACS.
 *
 * ── Lo que NO se puede poner desde acá ──
 *
 * La dirección IP, la máscara, el gateway y los DNS de la WAN de servicio. En
 * este equipo el perfil solo guarda el modo y el NAT; el resto se le manda a la
 * ONT por TR-069 o se carga en su página web. Se dice en el aviso para que
 * nadie los busque en un campo que no existe.
 */
export async function configurarWanOnu(olt, onuId, datos = {}) {
  const onu = await ontDeLaBase(olt, onuId)
  const ubicacion = {
    frame: onu.frame ?? 0,
    slot: onu.slot,
    puerto: onu.puerto,
    ontId: onu.onu_index,
  }

  if (datos.sacar) {
    const r = await olts.desvincularWanOnt(olt, { ...ubicacion, ipIndex: datos.ipIndex ?? 1 })
    return { ok: true, sn: onu.sn, ...r, aviso: 'La ONT quedó sin esa WAN configurada desde la OLT.' }
  }

  let perfil = null
  // Crear el perfil y vincularlo van juntos: un perfil sin vincular no hace
  // nada, y vincular uno que no existe falla. Hacerlo en dos botones deja a
  // alguien a mitad de camino creyendo que terminó.
  if (datos.perfil) {
    perfil = await olts.asegurarWanProfile(olt, datos.perfil)
  }

  const profileId = datos.profileId ?? perfil?.profileId
  if (profileId == null) {
    throw badRequest('Falta el perfil de WAN', {
      hint: 'Elegí uno de los que ya tiene la OLT, o definí uno nuevo.',
    })
  }

  const r = await olts.vincularWanOnt(olt, {
    ...ubicacion,
    ipIndex: datos.ipIndex ?? 1,
    profileId,
  })

  return {
    ok: true,
    sn: onu.sn,
    perfil,
    ...r,
    aviso:
      'La WAN quedó configurada en la OLT. La dirección IP, la máscara, el gateway y los DNS '
      + 'no se ponen desde acá: se le mandan a la ONT por TR-069 o se cargan en su página web.',
  }
}

/**
 * La gestión remota de una ONU: perfil TR-069 y su IP de gestión.
 *
 * ── Qué resuelve ──
 *
 * Al autorizar, el sistema le pone las dos cosas solo, tomando la primera IP
 * libre del pool de gestión. Esto es para después: cambiar de ACS, mover la ONT
 * a otra dirección porque la suya se duplicó, o dársela a una que quedó sin
 * ninguna porque el pool estaba lleno ese día.
 *
 * ── Por qué reserva la IP en la base ANTES de escribirla en el equipo ──
 *
 * Porque si se escribe primero y se anota después, dos altas simultáneas eligen
 * la misma dirección: las dos la ven libre. Reservando primero, la segunda
 * choca contra el índice único y elige otra. El costo de equivocarse al revés
 * —una reserva anotada que el equipo rechazó— es una dirección marcada como
 * usada, que se libera a mano; el otro camino deja dos ONTs con la misma IP y
 * ninguna gestionable.
 */
export async function configurarGestionOnu(olt, onuId, datos = {}) {
  const onu = await ontDeLaBase(olt, onuId)
  const ubicacion = {
    frame: onu.frame ?? 0,
    slot: onu.slot,
    puerto: onu.puerto,
    ontId: onu.onu_index,
  }

  const hecho = {}

  // --- El perfil TR-069 ---
  if (datos.profileId != null) {
    const r = await olts.asignarPerfilTr069(olt, { ...ubicacion, profileId: datos.profileId })
    hecho.perfil = r
  }

  // --- Sacar la IP de gestión ("Inactive") ---
  //
  // Va antes que la estática y la DHCP porque es un camino aparte: no hay
  // dirección que derivar de ningún pool, solo hay que sacarla.
  if (datos.modo === 'inactive') {
    const r = await olts.quitarIpGestionOnu(olt, ubicacion)
    hecho.ip = { modo: 'inactive', ...r }
  }

  // --- La IP de gestión por DHCP ---
  if (datos.modo === 'dhcp') {
    let vlan = datos.vlan
    if (vlan == null) {
      const { data: pools } = await db()
        .from('v_pools_onu')
        .select('*')
        .eq('olt_id', olt.id)
      vlan = pools?.[0]?.vlan ?? null
    }
    const r = await olts.configurarIpGestionOnuDhcp(olt, { ...ubicacion, vlan })
    hecho.ip = { modo: 'dhcp', vlan, ...r }
    hecho.servicePortGestion = await asegurarServicePortGestion(olt, { ...ubicacion, vlan })
  }

  // --- La IP de gestión, estática ---
  if (datos.ip) {
    /**
     * De dónde salen máscara, gateway y DNS cuando no vienen.
     *
     * De la subred de gestión a la que pertenece la IP elegida. Pedírselos a
     * quien aprieta el botón sería pedirle que recuerde datos que el sistema ya
     * tiene, y un gateway mal tipeado deja la ONT con IP y sin salida: se ve
     * configurada y no responde.
     */
    let { mascara, gateway, dns1, dns2, vlan } = datos

    if (!gateway || !mascara || vlan == null) {
      const { data: pools } = await db()
        .from('v_pools_onu')
        .select('*')
        .eq('olt_id', olt.id)

      const pool = (pools ?? []).find((p) => perteneceAlPool(datos.ip, p.cidr)) ?? pools?.[0] ?? null

      if (pool) {
        mascara = mascara ?? mascaraDeCidr(pool.cidr)
        gateway = gateway ?? pool.gateway
        dns1 = dns1 ?? pool.dns1
        dns2 = dns2 ?? pool.dns2
        vlan = vlan ?? pool.vlan
      }
    }

    if (!gateway) {
      throw badRequest('No se pudo deducir la puerta de enlace de gestión', {
        hint: 'La IP no cae en ningún pool de gestión de esta OLT. Cargá el pool en Red → Redes IPv4.',
      })
    }

    const r = await olts.configurarIpGestionOnu(olt, {
      ...ubicacion,
      ip: datos.ip,
      mascara: mascara ?? '255.255.255.0',
      gateway,
      dns1,
      dns2,
      vlan,
    })
    hecho.ip = { ip: datos.ip, vlan, gateway, ...r }
    hecho.servicePortGestion = await asegurarServicePortGestion(olt, { ...ubicacion, vlan })
  }

  return {
    ok: true,
    sn: onu.sn,
    ...hecho,
    aviso:
      'La ONT vuelve a negociar su gestión. Si cambió de ACS, puede tardar unos minutos en '
      + 'aparecer del otro lado.',
  }
}

/** ¿Esta IP cae dentro de este bloque? Aritmética simple, sin dependencias. */
function perteneceAlPool(ip, cidr) {
  if (!ip || !cidr) return false
  const [red, bits] = String(cidr).split('/')
  const aNum = (x) => String(x).split('.').reduce((n, o) => n * 256 + Number(o), 0)
  const mascara = bits === '0' ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0
  return ((aNum(ip) & mascara) >>> 0) === ((aNum(red) & mascara) >>> 0)
}

/**
 * Cambia los perfiles de una ONU ya autorizada.
 *
 * ── Qué resuelve ──
 *
 * Es el equivalente al "Change ONU type" de otras herramientas: la ONT quedó
 * con un perfil que no le corresponde —porque su modelo no estaba en la OLT
 * cuando se autorizó, o porque se registró un perfil mejor después— y hay que
 * corregirlo sin dar de baja al abonado.
 *
 * ── Por qué no borra y recrea ──
 *
 * Porque `ont modify` cambia el perfil conservando el ONT-ID, y ese número está
 * guardado en la ficha y referenciado por los service-ports. Borrar y recrear
 * obligaría a rehacer todo eso y le cambiaría el identificador al abonado.
 *
 * ── Qué se guarda ──
 *
 * Lo que la OLT dice que quedó, no lo que se pidió. Si el equipo aceptó el
 * comando pero aplicó otra cosa, la ficha tiene que reflejar el equipo y no la
 * intención.
 */
export async function cambiarPerfilesOnu(olt, onuId, { srvProfileId = null, lineProfileId = null } = {}) {
  const onu = await ontDeLaBase(olt, onuId)

  const antes = { srv: onu.srv_profile_olt ?? null, line: onu.line_profile_olt ?? null }

  const r = await olts.cambiarPerfilesOnt(olt, {
    frame: onu.frame ?? 0,
    slot: onu.slot,
    puerto: onu.puerto,
    ontId: onu.onu_index,
    srvProfileId,
    lineProfileId,
  })

  const cambios = {}
  if (r.srvProfileId != null) cambios.srv_profile_olt = r.srvProfileId
  if (r.lineProfileId != null) cambios.line_profile_olt = r.lineProfileId
  if (r.srvProfileNombre) cambios.srv_profile_nombre = r.srvProfileNombre

  if (Object.keys(cambios).length) {
    const { error } = await db().from('onus').update(cambios).eq('id', onu.id)
    /**
     * El equipo ya cambió: que la ficha no se entere no se puede deshacer
     * callando. Se avisa y se sigue, porque volver atrás en la OLT sería un
     * segundo corte para arreglar un campo.
     */
    if (error) {
      return {
        ok: true,
        sn: onu.sn,
        antes,
        ...r,
        aviso: `El perfil cambió en la OLT, pero no se pudo guardar en la ficha: ${error.message}. `
          + 'Resincronizá la ONU para que la ficha se ponga al día.',
      }
    }
  }

  return {
    ok: true,
    sn: onu.sn,
    antes,
    ...r,
    aviso:
      'La ONT se reaprovisiona por OMCI: el abonado puede perder el servicio unos segundos. '
      + 'Su ONT-ID no cambia.',
  }
}

export async function reprovisionarOnu(olt, onuId) {
  const onu = await ontDeLaBase(olt, onuId)

  const r = await olts.reprovisionarOnt(olt, {
    frame: onu.frame ?? 0,
    slot: onu.slot,
    puerto: onu.puerto,
    ontId: onu.onu_index,
  })

  return {
    ok: true,
    sn: onu.sn,
    comando: r.comando,
    aviso:
      'La ONT se está reasociando y la OLT le vuelve a enviar su configuración. ' +
      'El abonado pierde el servicio unos segundos.',
  }
}

/**
 * Devuelve la ONT a los valores de fábrica.
 *
 * Borra TODO lo que el usuario configuró dentro del equipo: el nombre y la
 * contraseña del wifi, los reenvíos de puertos, lo que haya tocado. El internet
 * vuelve solo, porque la OLT le reaplica la configuración de servicio — pero el
 * wifi queda con la clave de fábrica y el abonado va a llamar preguntando por
 * qué no se conecta ningún teléfono de la casa.
 *
 * Por eso el aviso dice eso último con todas las letras: es la consecuencia que
 * no se ve desde acá y la que genera el llamado.
 */
export async function restaurarFabricaOnu(olt, onuId, { completamente = false } = {}) {
  const onu = await ontDeLaBase(olt, onuId)

  const r = await olts.restaurarFabricaOnt(olt, {
    frame: onu.frame ?? 0,
    slot: onu.slot,
    puerto: onu.puerto,
    ontId: onu.onu_index,
    completamente,
  })

  return {
    ok: true,
    sn: onu.sn,
    comando: r.comando,
    completamente,
    aviso:
      'La ONT volvió a fábrica. La OLT le reaplica el servicio sola, así que el internet vuelve; ' +
      'pero el wifi quedó con el nombre y la clave de fábrica, y todo lo que el abonado hubiera ' +
      'configurado adentro se perdió.',
  }
}

/** La configuración que el equipo tiene EN EJECUCIÓN para esta ONT. */
export async function configActivaOnu(olt, onuId) {
  const onu = await ontDeLaBase(olt, onuId)

  const r = await olts.leerConfigActivaOnt(olt, {
    frame: onu.frame ?? 0,
    slot: onu.slot,
    puerto: onu.puerto,
    ontId: onu.onu_index,
  })

  // Se tapan los secretos igual que en los respaldos: esta salida trae la
  // configuración TR069, y ahí viaja la contraseña del servidor de gestión.
  return { ...r, texto: taparSecretos(r.texto), lineas: r.lineas.map(taparSecretos) }
}

/**
 * Datos de software y hardware de la ONT, en vivo.
 *
 * Modelo exacto, firmware y fabricante leídos del equipo en este momento. Es lo
 * que hace falta antes de decidir si un problema se arregla con una
 * actualización o con cambiar el equipo.
 */
export async function softwareOnu(olt, onuId) {
  const onu = await ontDeLaBase(olt, onuId)

  const m = await olts.leerMetricas(olt, {
    frame: onu.frame ?? 0,
    slot: onu.slot,
    puerto: onu.puerto,
    onuId: onu.onu_index,
  })

  if (!m?.version) {
    throw new AppError('El equipo no devolvió la versión de la ONT', {
      status: 502,
      hint:
        m?.online === false
          ? 'Es una consulta OMCI en vivo y la ONT está caída: no puede contestar.'
          : 'Volvé a intentar.',
    })
  }

  return { sn: onu.sn, ...m.version }
}

/**
 * Los puertos de adentro de la ONT del abonado.
 *
 * Contesta la pregunta que aparece cuando llama diciendo "no me anda internet"
 * y la fibra está perfecta: si sus cuatro puertos están caídos, el problema
 * está del router para adentro y no hay nada que revisar en la red.
 *
 * Del lado del teléfono, lo que importa es el estado de registro. Una línea en
 * `RegisterFail` se ve, desde afuera, exactamente igual que una que funciona:
 * la ONT está online y el puerto existe.
 */
export async function puertosOnu(olt, onuId) {
  const onu = await ontDeLaBase(olt, onuId)

  const r = await olts.leerPuertosOnt(olt, {
    frame: onu.frame ?? 0,
    slot: onu.slot,
    puerto: onu.puerto,
    ontId: onu.onu_index,
  })

  const conectados = r.ethernet.filter((p) => p.conectado).length

  return {
    sn: onu.sn,
    ...r,
    resumen: {
      ethernet_total: r.ethernet.length,
      ethernet_conectados: conectados,
      // Que no haya NINGUNO enchufado no es una falla por sí solo —hay quien
      // usa solo wifi— pero es lo primero que hay que saber antes de salir a
      // revisar la red por un reclamo de "no tengo internet".
      ninguno_conectado: r.ethernet.length > 0 && conectados === 0,
      // === true, no truthy: `null` es "no se pudo saber" y no tiene que
      // encender la alarma.
      con_bucle: r.ethernet.filter((p) => p.bucle === true).map((p) => p.puerto),
      telefonos: r.telefonia.length,
      telefonos_registrados: r.telefonia.filter((p) => p.registrado).length,
      telefonos_con_problema: r.telefonia
        .filter((p) => !p.registrado)
        .map((p) => ({ puerto: p.puerto, estado: p.registro })),
    },
  }
}

/**
 * Reinicia UNA ONT.
 *
 * Es lo primero que se prueba cuando un abonado llama porque "anda lento" y la
 * señal óptica está bien. Corta el servicio un par de minutos, así que la
 * pantalla lo dice antes.
 */
export async function reiniciarOnu(olt, onuId) {
  const onu = await ontDeLaBase(olt, onuId)

  const r = await olts.reiniciarOnts(olt, {
    slot: onu.slot,
    puerto: onu.puerto,
    ontId: onu.onu_index,
  })

  return {
    ok: true,
    sn: onu.sn,
    comando: r.comando,
    aviso: 'La ONT se está reiniciando: vuelve en un par de minutos.',
  }
}

/**
 * Suspende o reactiva una ONT.
 *
 * Es lo que corresponde para un corte por falta de pago: la configuración queda
 * intacta y vuelve con un comando. Borrarla obligaría a darla de alta otra vez
 * cuando el abonado pague.
 */
export async function suspenderOnt(olt, { onuId, activar }) {
  const onu = await ontDeLaBase(olt, onuId)

  const r = await olts.activarOnt(olt, {
    frame: onu.frame ?? 0,
    slot: onu.slot,
    puerto: onu.puerto,
    ontId: onu.onu_index,
    activar,
  })

  await db()
    .from('onus')
    .update({ estado: activar ? 'offline' : 'unknown' })
    .eq('id', onu.id)

  return {
    ok: true,
    sn: onu.sn,
    activa: activar,
    comando: r.comando,
    aviso: activar
      ? 'La ONT vuelve a levantar en menos de un minuto.'
      : 'La ONT quedó suspendida. Su configuración está intacta: se reactiva con un comando.',
  }
}

/**
 * Mueve una ONT a otro puerto PON.
 *
 * Es la operación con el peor caso de todas: mover es borrar y recrear, así que
 * si algo falla en el medio el abonado queda sin servicio Y sin configuración.
 * Por eso la respuesta incluye siempre la foto de cómo estaba, salga bien o mal.
 *
 * Y hay una parte que el sistema no puede hacer: mover la fibra. Si el pigtail
 * sigue en el puerto viejo, la ONT no levanta en el nuevo por más que la
 * configuración esté impecable.
 */
export async function moverOnt(olt, { onuId, nuevoSlot, nuevoPuerto }) {
  const onu = await ontDeLaBase(olt, onuId)

  if (nuevoPuerto == null) throw badRequest('Falta el puerto de destino')

  const r = await olts.moverOnt(olt, {
    frame: onu.frame ?? 0,
    slot: onu.slot,
    puerto: onu.puerto,
    ontId: onu.onu_index,
    nuevoSlot: nuevoSlot ?? onu.slot,
    nuevoPuerto: Number(nuevoPuerto),
  })

  const { error } = await db()
    .from('onus')
    .update({
      slot: r.hasta.slot,
      puerto: r.hasta.puerto,
      onu_index: r.hasta.ontId,
      // La óptica de la ubicación vieja ya no dice nada de la nueva.
      rx_power_dbm: null,
      tx_power_dbm: null,
      estado: 'offline',
    })
    .eq('id', onu.id)

  return {
    ok: true,
    sn: r.sn,
    nombre: onu.nombre_cliente,
    desde: `${r.desde.slot}/${r.desde.puerto}/${r.desde.ontId}`,
    hasta: `${r.hasta.slot}/${r.hasta.puerto}/${r.hasta.ontId}`,
    service_ports: r.servicePorts,
    comandos: r.comandos,
    guardadoEnBase: !error,
    aviso:
      'La configuración quedó lista en el puerto nuevo. Si la fibra sigue conectada al puerto viejo, ' +
      'la ONT no va a levantar: el traslado físico lo hace una persona.',
  }
}

/**
 * Da de baja una ONT: la borra del equipo y de la base.
 *
 * Es IRREVERSIBLE del lado del equipo. Para un corte temporal —falta de pago,
 * mudanza— lo que corresponde es suspenderla, no borrarla.
 *
 * La ficha del abonado NO se toca: sigue existiendo sin ONU. Borrar su
 * historial de pagos porque se le sacó el equipo sería otra cosa muy distinta.
 */
export async function darDeBajaOnt(olt, { onuId }) {
  const onu = await ontDeLaBase(olt, onuId)

  const r = await olts.eliminarOnu(olt, {
    frame: onu.frame ?? 0,
    slot: onu.slot,
    puerto: onu.puerto,
    onuId: onu.onu_index,
  })

  // El cliente queda sin ONU pero sigue existiendo. La FK es ON DELETE SET NULL,
  // así que se desengancha solo.
  const { error } = await db().from('onus').delete().eq('id', onu.id)

  return {
    ok: true,
    sn: onu.sn,
    nombre: onu.nombre_cliente,
    donde: `${onu.slot}/${onu.puerto}/${onu.onu_index}`,
    service_ports_borrados: r.servicePortsBorrados ?? [],
    comando: r.comando,
    borradaDeBase: !error,
    aviso:
      'La ficha del abonado sigue existiendo, ahora sin ONU. Su historial de pagos y su contrato no se tocaron.',
  }
}

// -----------------------------------------------------------------------------
// Relevamiento
// -----------------------------------------------------------------------------

/**
 * Comandos CANDIDATOS por área.
 *
 * Repito porque es la lección más cara de este proyecto: esto no es lo que el
 * equipo soporta, es lo que se le va a preguntar. El MA5800-X7 rechaza
 * `display fan`, `display cpu`, `display memory` y `display alarm active` —
 * cuatro comandos que cualquier manual da por sentados. Por eso se corren todos
 * y se muestra cuáles pasaron.
 */
export const AREAS = {
  uplink: {
    titulo: 'Puertos de subida',
    ayuda: 'Los GE/10GE que conectan la OLT con el resto de la red.',
    comandos: {
      // Relevado contra el X7 R018: `display port state all` y
      // `display link-aggregation summary` los rechaza. Los uplinks salen de las
      // placas de control, que en un MA5800 son los slots 8 y 9.
      Huawei: ['display interface', 'display board 0/9', 'display board 0/8'],
      VSOL: ['show interface brief', 'show interface uplink', 'show port statistics'],
    },
  },
  vlans: {
    titulo: 'VLANs',
    ayuda: 'Las VLAN configuradas en el equipo y por dónde salen.',
    comandos: {
      // `display vlan brief` no existe en R018; `display vlan all` sí.
      Huawei: ['display vlan all', 'display service-port all'],
      VSOL: ['show vlan all', 'show vlan', 'show service-port all'],
    },
  },
  pools: {
    titulo: 'Pools de IP para ONUs',
    ayuda: 'Rangos que la OLT entrega a las ONUs para su IP de gestión.',
    comandos: {
      Huawei: ['display ip pool', 'display dhcp server ip-pool', 'display ont ipconfig'],
      VSOL: ['show ip pool', 'show dhcp pool', 'show onu ip-config'],
    },
  },
  acls: {
    titulo: 'ACLs de acceso remoto',
    ayuda: 'Desde qué direcciones se permite administrar el equipo.',
    comandos: {
      Huawei: ['display acl all', 'display sysman firewall', 'display sysman service state'],
      VSOL: ['show access-list', 'show acl', 'show system access'],
    },
  },
  perfiles: {
    titulo: 'Perfiles de tráfico',
    ayuda: 'Traffic tables, line profiles y DBA: el ancho de banda del lado de la OLT.',
    comandos: {
      Huawei: [
        'display traffic table ip',
        'display dba-profile all',
        'display ont-lineprofile gpon all',
        'display ont-srvprofile gpon all',
      ],
      VSOL: ['show onu line-profile all', 'show onu srv-profile all', 'show traffic-profile'],
    },
  },
  voip: {
    titulo: 'Perfiles de telefonía',
    ayuda: 'VoIP sobre las ONUs. Si el equipo no tiene el módulo, esto va a venir vacío.',
    comandos: {
      Huawei: ['display voip', 'display esl user', 'display mgpbx all'],
      VSOL: ['show voip config', 'show pots', 'show sip config'],
    },
  },
  avanzado: {
    titulo: 'Parámetros avanzados',
    ayuda: 'NTP, SNMP, servicios de gestión y quién está conectado.',
    comandos: {
      // `display snmp-agent community` a secas devuelve "Incomplete command":
      // el equipo pide read o write. Y `display users` no existe en R018.
      Huawei: [
        'display ntp-service status',
        'display snmp-agent community read',
        'display snmp-agent community write',
        'display sysman service state',
      ],
      VSOL: ['show ntp', 'show snmp', 'show system', 'show users'],
    },
  },
}

/**
 * Comandos para sacar la paginación antes de un volcado largo.
 *
 * Sin esto, la CLI corta la salida en `---- More ----` esperando una tecla y la
 * sesión queda trabada. Se prueban varios y se ignora el que el equipo rechace:
 * el que sirva ya habrá hecho efecto.
 */
const SIN_PAGINAR = {
  Huawei: ['scroll 512', 'screen-length 0 temporary'],
  VSOL: ['terminal length 0'],
}

const RESPALDO = {
  Huawei: ['display current-configuration', 'display saved-configuration'],
  VSOL: ['show running-config', 'show startup-config'],
}

/**
 * Tapa las credenciales que aparecen en la salida cruda.
 *
 * No es hipotético: `display snmp-agent community write` en el MA5800-X7
 * devuelve `Community name: <la comunidad en claro>`, y el relevamiento muestra
 * la salida tal cual para poder escribir el parser. Sin esto, una pantalla
 * pensada para explorar comandos se convierte en la que reparte las llaves del
 * equipo — justamente lo que este sistema evita al cifrar en un solo sentido.
 *
 * Se enmascara el VALOR y se deja la etiqueta: para escribir un parser hace
 * falta saber que el campo existe y en qué formato viene, no cuánto vale.
 */
const SECRETOS = [
  // Huawei: "Community name: xxxx"
  /^(\s*Community name\s*:\s*)(\S+)/gim,
  // Genéricos de las dos marcas, con dos puntos o igual.
  /^(\s*(?:password|secret|community|auth-?key|priv-?key)\s*[:=]\s*)(\S+)/gim,
  // V-SOL: "snmp-server community xxxx rw"
  /^(\s*snmp-server community\s+)(\S+)/gim,
  // Huawei en la configuración: "terminal user name buildrun_new_password root <hash>".
  // Sin dos puntos y con el usuario en el medio — la forma que se me escapó y
  // que apareció con los hashes de root y de la cuenta del sistema.
  /(\S*_password\s+\S+\s+)(\S+)/gi,
  // "password cipher <hash>" / "password irreversible-cipher <hash>"
  /((?:password|key)\s+(?:cipher|simple|irreversible-cipher)\s+)(\S+)/gi,
]

// Los blobs cifrados de Huawei — "*j$1b$K/zs1IbH44$..." — aparecen sueltos en
// varios comandos. Se tapan por su forma, sin depender de qué etiqueta los
// preceda: una etiqueta nueva es una filtración nueva.
const HASH_HUAWEI = /\*\S*?\$\d[a-z]?\$\S+/gi

export function taparSecretos(texto) {
  let salida = String(texto ?? '')

  for (const re of SECRETOS) {
    re.lastIndex = 0
    salida = salida.replace(re, (entero, etiqueta, valor) => {
      // "system user password security-length 8" no es un secreto: es una
      // política. Tapar un número de configuración confunde al que lee.
      if (/^\d+$/.test(valor)) return entero
      return `${etiqueta}${'•'.repeat(Math.min(valor.length, 12))}`
    })
  }

  HASH_HUAWEI.lastIndex = 0
  return salida.replace(HASH_HUAWEI, '*••••••••••••')
}

/** Le quita el eco del comando y el ruido para poder medir si trajo algo. */
const cuerpo = (salida, comando) =>
  String(salida ?? '')
    .replace(/\x1b?\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== comando && !/^\{.*\}:?$/.test(l))
    .join('\n')

/** ¿El equipo contestó algo aprovechable, o contestó "no sé qué me pediste"? */
export function evaluar(r) {
  const texto = cuerpo(r.salida, r.comando)
  return {
    ...r,
    // La salida sale enmascarada de acá para arriba: es lo que viaja al
    // navegador y lo que alguien va a copiar y pegar en un chat.
    salida: taparSecretos(r.salida),
    lineas: texto ? texto.split('\n').length : 0,
    // Un comando aceptado que devuelve dos líneas puede ser "la tabla está
    // vacía", que es un resultado válido y distinto de un rechazo.
    util: !r.rechazo && texto.length > 0,
  }
}

/**
 * Le pregunta al equipo qué entiende de un área.
 *
 * Devuelve la salida cruda a propósito: es material para escribir el parser, y
 * un resumen prolijo acá sería exactamente el atajo que ya salió caro.
 */
export async function relevarArea(olt, area) {
  const def = AREAS[area]
  if (!def) {
    throw badRequest(`No hay un relevamiento definido para "${area}"`, {
      hint: `Áreas disponibles: ${Object.keys(AREAS).join(', ')}`,
    })
  }

  const marca = marcaDe(olt)
  const comandos = def.comandos[marca] ?? []
  if (!comandos.length) {
    throw badRequest(`No hay comandos candidatos de "${def.titulo}" para una OLT ${olt.marca}`)
  }

  const resultados = (await olts.relevar(olt, comandos)).map(evaluar)

  return {
    area,
    titulo: def.titulo,
    ayuda: def.ayuda,
    marca: olt.marca,
    aceptados: resultados.filter((r) => r.util).length,
    resultados,
  }
}

/**
 * Baja la configuración completa y la guarda.
 *
 * Se prueban varios comandos y se queda con el primero que traiga algo
 * sustancial. Si la salida quedó cortada por la paginación se guarda igual pero
 * marcada: un respaldo parcial que se cree completo es peor que no tenerlo,
 * porque se descubre el día que hay que restaurar.
 */
export async function respaldarConfig(olt, { quien = null, nombre = null } = {}) {
  const marca = marcaDe(olt)
  const candidatos = RESPALDO[marca]

  const salidas = await olts.relevar(olt, [...(SIN_PAGINAR[marca] ?? []), ...candidatos])
  const dumps = salidas.filter((s) => candidatos.includes(s.comando))

  const bueno = dumps.map(evaluar).find((s) => s.util && s.lineas >= 5)
  if (!bueno) {
    throw badRequest('Ninguno de los comandos de respaldo devolvió configuración', {
      hint: `Se probaron: ${candidatos.join(' · ')}`,
      detalle: dumps.map((d) => `${d.comando} → ${d.rechazo ?? '(vacío)'}`).join('\n'),
    })
  }

  const truncado = /----\s*More\s*----|---- More/i.test(bueno.salida)
  const contenido = cuerpo(bueno.salida, bueno.comando)
  const sello = new Date().toISOString().slice(0, 16).replace('T', ' ')

  const { data, error } = await db()
    .from('olt_backups')
    .insert({
      olt_id: olt.id,
      nombre: nombre || `${olt.nombre} · ${sello}${truncado ? ' (parcial)' : ''}`,
      contenido,
      comando: bueno.comando,
      quien,
    })
    .select('id, nombre, comando, bytes, created_at')
    .single()

  if (error) throw badRequest(`Se leyó la configuración pero no se pudo guardar: ${error.message}`)

  return {
    ...data,
    truncado,
    lineas: bueno.lineas,
    // Se dice siempre, no solo cuando se enmascaró algo: alguien tiene que
    // saber que esto NO alcanza para restaurar un equipo desde cero.
    enmascarado: true,
    nota_credenciales:
      'Las comunidades SNMP y contraseñas que aparecían en la configuración están tapadas. ' +
      'Sirve para comparar y auditar, no para restaurar el equipo tal cual.',
    ...(truncado
      ? {
          aviso:
            'La salida quedó cortada en el prompt de paginación: el respaldo está incompleto. ' +
            'Hay que relevar en este modelo qué comando desactiva la paginación.',
        }
      : {}),
  }
}

// -----------------------------------------------------------------------------
// Inconsistencias de configuración
// -----------------------------------------------------------------------------

const problema = (clave, severidad, titulo, detalle, extra = {}) => ({
  clave,
  severidad,
  titulo,
  detalle,
  ...extra,
})

/**
 * Las reglas de coherencia, sin base de datos de por medio.
 *
 * Está separado a propósito: son las decisiones de qué está mal y cuán grave es,
 * y eso se prueba con datos armados a mano. Mezclado con las consultas habría
 * que levantar una base para verificar que un índice duplicado se detecta.
 */
export function analizarCoherencia({ olts: listaOlts = [], onus = [], planes = [], perfiles = [] }) {
  const nombreOlt = new Map(listaOlts.map((o) => [o.id, o.nombre]))
  const planPorId = new Map(planes.map((p) => [p.id, p]))
  const hallazgos = []

  // --- Por OLT --------------------------------------------------------------
  for (const o of listaOlts) {
    const ref = { olt_id: o.id, olt: o.nombre }

    if (!o.hw_version || !o.sw_version) {
      hallazgos.push(
        problema(
          'sin-version',
          'media',
          'Versiones nunca leídas del equipo',
          'No se sabe qué modelo ni qué firmware tiene. Sin esto no se puede detectar una actualización hecha por fuera del sistema.',
          { ...ref, sugerencia: 'Abrí la OLT y usá "Leer del equipo" en la pestaña de detalles.' },
        ),
      )
    }

    // Ojo con lo que este hallazgo puede y no puede afirmar: la columna es
    // documentación de la ficha, no una lectura del equipo. Decir "no tiene NTP"
    // porque el campo está vacío es mentir — la X7 estaba sincronizada en
    // estrato 2 con el campo en blanco. Si el reloj está bien o mal se sabe
    // preguntándoselo, y eso lo hace la revisión profunda.
    if (!o.ntp_servers) {
      hallazgos.push(
        problema(
          'ntp-sin-registrar',
          'baja',
          'La ficha no registra los servidores NTP',
          'Es un dato de documentación: sirve para saber contra qué está sincronizado el equipo sin tener que entrar a preguntárselo. No dice nada sobre si el reloj está bien.',
          {
            ...ref,
            sugerencia:
              'Corré la revisión profunda para ver el estado real del reloj, y anotá los servidores en la ficha.',
          },
        ),
      )
    }

    if (o.snmp_trap && !o.snmp_ro_encrypted) {
      hallazgos.push(
        problema(
          'trap-sin-comunidad',
          'alta',
          'Escucha de traps activada sin comunidad SNMP',
          'Está esperando notificaciones del equipo pero no tiene con qué autenticarlas. No va a llegar ninguna.',
          { ...ref, sugerencia: 'Cargá la comunidad de solo lectura o desactivá la escucha de traps.' },
        ),
      )
    }

    const suyas = onus.filter((u) => u.olt_id === o.id)

    if (o.activo === false && suyas.length) {
      hallazgos.push(
        problema(
          'oculta-con-onus',
          'alta',
          `OLT desactivada con ${suyas.length} ONUs vivas`,
          'Está marcada como inactiva pero sigue teniendo abonados colgando. Ninguna operación automática la va a tocar.',
          { ...ref, sugerencia: 'Reactivala, o migrá sus ONUs antes de dejarla apagada.' },
        ),
      )
    }

    if (o.activo !== false && !suyas.length) {
      hallazgos.push(
        problema(
          'sin-onus',
          'baja',
          'OLT activa sin ninguna ONU registrada',
          'O es nueva, o las ONUs se dieron de alta por la CLI y nunca se importaron a la base.',
          { ...ref, sugerencia: 'Corré un descubrimiento desde la pestaña de puertos PON.' },
        ),
      )
    }

    // Dos perfiles con el mismo ID interno en la misma OLT es una colisión real:
    // el segundo pisa al primero cuando se aplica.
    const porIdOlt = new Map()
    for (const p of perfiles.filter((p) => p.olt_id === o.id)) {
      const previo = porIdOlt.get(p.profile_id_olt)
      if (previo) {
        hallazgos.push(
          problema(
            'perfil-duplicado',
            'alta',
            `Dos line profiles con el ID ${p.profile_id_olt}`,
            `"${previo.nombre}" y "${p.nombre}" apuntan al mismo perfil dentro del equipo. El que se aplique último pisa al otro.`,
            { ...ref, sugerencia: 'Cambiá el ID interno de uno de los dos.' },
          ),
        )
      } else {
        porIdOlt.set(p.profile_id_olt, p)
      }
    }
  }

  // --- Planes ---------------------------------------------------------------
  const porIndice = new Map()
  for (const p of planes) {
    if (p.traffic_table_index == null) {
      hallazgos.push(
        problema(
          'plan-sin-indice',
          'media',
          `El plan "${p.nombre}" no tiene índice de traffic table`,
          'No se puede aplicar en una OLT: el índice es la posición donde vive dentro del equipo.',
          { sugerencia: 'Asignale un índice libre desde Servicios → Planes.' },
        ),
      )
      continue
    }
    const previo = porIndice.get(p.traffic_table_index)
    if (previo) {
      hallazgos.push(
        problema(
          'indice-duplicado',
          'alta',
          `Dos planes usan el índice ${p.traffic_table_index}`,
          `"${previo.nombre}" y "${p.nombre}" escriben la misma traffic table. El último que se aplique le cambia la velocidad a los abonados del otro.`,
          { sugerencia: 'Dale un índice distinto a uno de los dos y volvé a aplicarlo.' },
        ),
      )
    } else {
      porIndice.set(p.traffic_table_index, p)
    }
  }

  // --- ONUs -----------------------------------------------------------------
  const sinPlan = onus.filter((u) => !u.plan_id)
  if (sinPlan.length) {
    hallazgos.push(
      problema(
        'onu-sin-plan',
        'media',
        `${sinPlan.length} ONUs sin plan asignado`,
        'No se les puede aplicar ni verificar ancho de banda porque no se sabe cuál les corresponde.',
        {
          sugerencia: 'Asignales un plan desde la ficha del abonado.',
          ejemplos: sinPlan.slice(0, 8).map((u) => `${u.sn} · ${nombreOlt.get(u.olt_id) ?? '—'}`),
        },
      ),
    )
  }

  // El clásico: se renombró el plan y la copia textual de la ONU quedó vieja.
  const desfasadas = onus.filter((u) => {
    const plan = u.plan_id ? planPorId.get(u.plan_id) : null
    return plan && u.plan_velocidad && u.plan_velocidad !== plan.nombre
  })
  if (desfasadas.length) {
    hallazgos.push(
      problema(
        'plan-renombrado',
        'baja',
        `${desfasadas.length} ONUs con el nombre del plan desactualizado`,
        'El plan se renombró después de darlas de alta y quedaron con la copia vieja. No afecta el servicio, pero los listados y reportes muestran dos nombres para lo mismo.',
        {
          sugerencia: 'Se corrige reescribiendo la copia textual desde el plan actual.',
          ejemplos: desfasadas
            .slice(0, 8)
            .map((u) => `${u.sn}: "${u.plan_velocidad}" → "${planPorId.get(u.plan_id).nombre}"`),
        },
      ),
    )
  }

  // Mismo SN en dos OLTs: una de las dos filas es un fantasma de una migración.
  const porSn = new Map()
  for (const u of onus) {
    const lista = porSn.get(u.sn) ?? []
    lista.push(u)
    porSn.set(u.sn, lista)
  }
  const repetidas = [...porSn.entries()].filter(([, v]) => v.length > 1)
  if (repetidas.length) {
    hallazgos.push(
      problema(
        'sn-repetido',
        'alta',
        `${repetidas.length} números de serie registrados en más de una OLT`,
        'Un mismo equipo físico no puede estar en dos OLTs. Una de las filas sobró de una migración o de una mudanza mal cerrada.',
        {
          sugerencia: 'Verificá en qué OLT está realmente y borrá la otra fila.',
          ejemplos: repetidas
            .slice(0, 8)
            .map(([sn, v]) => `${sn} → ${v.map((x) => nombreOlt.get(x.olt_id) ?? '?').join(' + ')}`),
        },
      ),
    )
  }

  const huerfanas = onus.filter((u) => !u.olt_id || !nombreOlt.has(u.olt_id))
  if (huerfanas.length) {
    hallazgos.push(
      problema(
        'onu-huerfana',
        'alta',
        `${huerfanas.length} ONUs sin OLT`,
        'Quedaron apuntando a un equipo que ya no existe en el sistema.',
        { sugerencia: 'Reasignalas a su OLT o eliminalas.' },
      ),
    )
  }

  const orden = { alta: 0, media: 1, baja: 2 }
  return hallazgos.sort((a, b) => orden[a.severidad] - orden[b.severidad])
}

/**
 * Busca desalineaciones entre lo que la base cree y lo que hay configurado.
 *
 * Casi todo se resuelve con consultas: son las incoherencias que se acumulan
 * solas —un plan renombrado, una ONU que quedó sin plan, dos planes peleándose
 * el mismo índice de traffic table— y que nadie descubre hasta que un abonado
 * reclama.
 *
 * Con `profundo` además se le pregunta a cada equipo, que es caro (una sesión
 * CLI por OLT) y por eso no es lo que corre por defecto.
 */
export async function buscarInconsistencias({ profundo = false } = {}) {
  const cliente = db()

  const [rOlts, rOnus, rPlanes, rPerfiles] = await Promise.all([
    cliente.from('olts').select('*').order('numero', { ascending: true }),
    cliente
      .from('onus')
      .select('id, olt_id, sn, nombre_cliente, puerto, onu_index, plan_id, plan_velocidad, estado'),
    cliente.from('planes_velocidad').select('id, nombre, traffic_table_index, bajada_kbps, subida_kbps'),
    cliente.from('line_profiles').select('id, olt_id, nombre, vlan_id, profile_id_olt'),
  ])

  for (const r of [rOlts, rOnus, rPlanes, rPerfiles]) {
    if (r.error) throw badRequest(`No se pudo leer la base: ${r.error.message}`)
  }

  const listaOlts = rOlts.data ?? []
  const onus = rOnus.data ?? []
  const planes = rPlanes.data ?? []
  const perfiles = rPerfiles.data ?? []

  const hallazgos = analizarCoherencia({ olts: listaOlts, onus, planes, perfiles })

  // --- Contra el equipo -----------------------------------------------------
  if (profundo) {
    const { cargarOlt } = await import('../lib/db.js')

    for (const o of listaOlts.filter((x) => x.activo !== false)) {
      const ref = { olt_id: o.id, olt: o.nombre }
      try {
        const equipo = await cargarOlt(o.id)
        const vivo = await olts.probarConexion(equipo)

        if (o.sw_version && vivo.version && o.sw_version !== vivo.version) {
          hallazgos.push(
            problema(
              'firmware-cambiado',
              'alta',
              'El firmware del equipo no es el que dice la base',
              `La base tiene "${o.sw_version}" y el equipo responde "${vivo.version}". Alguien actualizó por fuera del sistema, o la base nunca se refrescó.`,
              { ...ref, sugerencia: 'Usá "Leer del equipo" para dejar la ficha al día.' },
            ),
          )
        }

        // El reloj, preguntado al equipo. Un OLT que se cree sincronizado y no
        // lo está es peor que uno sin NTP: fecha cada evento con una hora que
        // nadie va a cuestionar.
        const ntp = await olts.leerNtp(equipo).catch(() => null)
        if (ntp && (!ntp.sincronizado || ntp.sin_referencia)) {
          hallazgos.push(
            problema(
              'reloj-sin-sincronizar',
              'media',
              'El reloj del equipo no está sincronizado',
              `El equipo reporta "${ntp.estado}"${ntp.sin_referencia ? ' y estrato 16, que significa sin referencia' : ''}. Los eventos que registre van a quedar fechados con una hora que se corre, y no se van a poder cruzar con los del resto del sistema.`,
              { ...ref, sugerencia: 'Revisá la configuración NTP del equipo y que alcance a su servidor.' },
            ),
          )
        }

        if (o.hw_version && vivo.modelo && o.hw_version !== vivo.modelo) {
          hallazgos.push(
            problema(
              'modelo-cambiado',
              'alta',
              'El modelo del equipo no es el que dice la base',
              `La base tiene "${o.hw_version}" y responde "${vivo.modelo}". Esa IP puede estar apuntando a otro equipo.`,
              { ...ref, sugerencia: 'Confirmá que la IP de gestión sea la correcta.' },
            ),
          )
        }
      } catch (err) {
        hallazgos.push(
          problema(
            'inalcanzable',
            'alta',
            'No se pudo consultar el equipo',
            err.message,
            { ...ref, sugerencia: err.hint ?? 'Revisá alcance, puerto y credenciales.' },
          ),
        )
      }
    }
  }

  const orden = { alta: 0, media: 1, baja: 2 }
  hallazgos.sort((a, b) => orden[a.severidad] - orden[b.severidad])

  return {
    revisado_at: new Date().toISOString(),
    profundo,
    olts: listaOlts.length,
    onus: onus.length,
    total: hallazgos.length,
    por_severidad: {
      alta: hallazgos.filter((h) => h.severidad === 'alta').length,
      media: hallazgos.filter((h) => h.severidad === 'media').length,
      baja: hallazgos.filter((h) => h.severidad === 'baja').length,
    },
    hallazgos,
  }
}
