import { db, cargarOlt, cargarRouter } from '../lib/db.js'
import { badRequest, AppError } from '../lib/errors.js'
import { aEntero, aIp, rangoDeCidr } from '../lib/ip.js'
import * as olts from './oltService.js'
import * as mk from './mikrotikService.js'

/**
 * Pools de direcciones para las ONUs.
 *
 * Son dos cosas distintas con la misma forma:
 *
 *   gestion_onu  la IP con la que se administra la ONT — TR069, OMCI. Viaja
 *                por la VLAN de gestión, en paralelo a la del abonado.
 *   wan_onu      la estática que la ONT usa en su WAN cuando el abonado tiene
 *                IP fija en el equipo y no por PPPoE.
 *
 * A diferencia de un segmento de abonados, acá las direcciones se materializan
 * una por una al crear el pool. Es lo que permite contestar "¿cuál es la
 * siguiente libre?" sin recorrer el equipo, y ver de un vistazo cuáles están
 * tomadas — que es exactamente lo que hoy se hace mirando la OLT a mano.
 */

/** Tope de direcciones que se crean de una vez. */
// Un /20 son cuatro mil filas y se banca; un /8 son dieciséis millones y
// tumbaría la base. El límite existe para que el error sea un mensaje claro y
// no una petición que nunca termina.
const MAX_DIRECCIONES = 8192

const aTexto = (v) => {
  const s = String(v ?? '').trim()
  return s === '' ? null : s
}

/** Los pools de una OLT, con sus números. */
export async function listarPools(oltId, { proposito = 'gestion_onu' } = {}) {
  const olt = await cargarOlt(oltId)

  const { data, error } = await db()
    .from('v_pools_onu')
    .select('*')
    .eq('olt_id', oltId)
    .eq('proposito', proposito)
    .order('numero')

  if (error) throw new AppError(error.message, { status: 400 })

  const pools = data ?? []
  return {
    olt: { id: olt.id, nombre: olt.nombre },
    proposito,
    pools,
    resumen: {
      pools: pools.length,
      // Direcciones que hay que mirar: asignadas y sin dueño.
      requieren_atencion: pools.reduce((n, p) => n + (p.sin_dueno ?? 0), 0),
      usadas: pools.reduce((n, p) => n + (p.usadas ?? 0), 0),
      reservadas: pools.reduce((n, p) => n + (p.reservadas ?? 0), 0),
      libres: pools.reduce((n, p) => n + (p.libres ?? 0), 0),
    },
  }
}

/** Las direcciones de un pool, una por una. */
export async function listarIps(subredId, { estado, limite = 500, desde = 0 } = {}) {
  let q = db()
    .from('ip_addresses')
    .select('id, ip_address, estado, onu_id, client_id, descripcion, mac_address, origen, visto_at', {
      count: 'exact',
    })
    .eq('subred_id', subredId)
  if (estado) q = q.eq('estado', estado)

  const { data, error, count } = await q.range(desde, desde + limite - 1)
  if (error) throw new AppError(error.message, { status: 400 })

  // Las direcciones vienen como texto y hay que ordenarlas como números: por
  // orden alfabético, .10 va antes que .2.
  const filas = [...(data ?? [])].sort(
    (a, b) => (aEntero(a.ip_address) ?? 0) - (aEntero(b.ip_address) ?? 0),
  )

  // A quién pertenece cada una. Se resuelve acá y no con un join porque las
  // ONUs pueden estar en otra OLT y el join las escondería.
  const onuIds = [...new Set(filas.map((f) => f.onu_id).filter(Boolean))]
  const onus = onuIds.length
    ? (await db().from('onus').select('id, sn, nombre_cliente, slot, puerto').in('id', onuIds)).data
    : []
  const porId = new Map((onus ?? []).map((o) => [o.id, o]))

  return {
    total: count ?? filas.length,
    ips: filas.map((f) => ({
      ...f,
      onu: porId.get(f.onu_id)
        ? {
            sn: porId.get(f.onu_id).sn,
            nombre: porId.get(f.onu_id).nombre_cliente,
            donde: `${porId.get(f.onu_id).slot}/${porId.get(f.onu_id).puerto}`,
          }
        : null,
    })),
  }
}

/**
 * Qué direcciones abarcaría un rango, y qué hace falta corregir.
 *
 * Se calcula sin tocar la base para poder mostrarlo mientras se escribe el
 * formulario: cuántas se van a crear es la diferencia entre apretar Guardar con
 * confianza y descubrir después que se cargaron cuatro mil filas.
 */
export function revisarRango({ cidr, desde, hasta, gateway }) {
  const bloque = rangoDeCidr(cidr) // valida el CIDR y descarta red y broadcast

  const d = desde ? aEntero(desde) : bloque.desde
  const h = hasta ? aEntero(hasta) : bloque.hasta

  if (d == null) throw badRequest(`"${desde}" no es una dirección válida`)
  if (h == null) throw badRequest(`"${hasta}" no es una dirección válida`)
  if (h < d) throw badRequest('La dirección inicial del rango es mayor que la final')

  // Fuera del bloque no se avisa: se rechaza. Un pool que entrega direcciones
  // de otra red no falla al crearse — falla cuando la ONT no llega a ningún
  // lado, y para entonces nadie se acuerda de este formulario.
  if (d < bloque.desde || h > bloque.hasta) {
    throw badRequest(
      `El rango ${aIp(d)}-${aIp(h)} se sale de ${cidr}`,
      { hint: `Ese bloque va de ${aIp(bloque.desde)} a ${aIp(bloque.hasta)}.` },
    )
  }

  const gw = gateway ? aEntero(gateway) : null
  if (gateway && gw == null) throw badRequest(`"${gateway}" no es una dirección válida`)
  if (gw != null && (gw < bloque.desde || gw > bloque.hasta)) {
    throw badRequest(`El gateway ${gateway} no pertenece a ${cidr}`)
  }

  const total = h - d + 1
  if (total > MAX_DIRECCIONES) {
    throw badRequest(`El rango tiene ${total} direcciones y el máximo por pool es ${MAX_DIRECCIONES}`, {
      hint: 'Cargá un rango más chico, o dividí el bloque en varios pools.',
    })
  }

  return {
    cidr,
    desde: aIp(d),
    hasta: aIp(h),
    total,
    // El gateway se excluye del reparto: entregárselo a una ONU la deja sin
    // salida y rompe a todas las demás del segmento.
    gateway: gw != null ? aIp(gw) : null,
    a_crear: gw != null && gw >= d && gw <= h ? total - 1 : total,
    bloque: { desde: aIp(bloque.desde), hasta: aIp(bloque.hasta), total: bloque.hasta - bloque.desde + 1 },
  }
}

/**
 * Crea el pool y materializa sus direcciones.
 *
 * Las que ya existían en ese bloque no se tocan ni se duplican: el formulario
 * puede volver a correrse para ampliar un rango sin perder lo asignado.
 */
export async function crearPool(oltId, datos) {
  const olt = await cargarOlt(oltId)
  const proposito = datos.proposito === 'wan_onu' ? 'wan_onu' : 'gestion_onu'

  const revision = revisarRango({
    cidr: datos.cidr,
    desde: datos.desde,
    hasta: datos.hasta,
    gateway: datos.gateway,
  })

  const { data: subred, error } = await db()
    .from('subredes')
    .insert({
      nombre:
        aTexto(datos.nombre) ??
        `${olt.nombre} · ${proposito === 'wan_onu' ? 'WAN' : 'Gestión'} ONUs${datos.vlan ? ` VLAN ${datos.vlan}` : ''}`,
      cidr: datos.cidr,
      tipo: 'estatica',
      proposito,
      gateway: revision.gateway,
      dns1: aTexto(datos.dns1),
      dns2: aTexto(datos.dns2),
      vlan: datos.vlan === '' || datos.vlan == null ? null : Number(datos.vlan),
      rango_desde: revision.desde,
      rango_hasta: revision.hasta,
      olt_id: oltId,
      router_id: datos.router_id || null,
      notas: aTexto(datos.notas),
    })
    .select('*')
    .single()

  if (error) {
    throw new AppError(
      error.code === '23505'
        ? `El bloque ${datos.cidr} ya está cargado. Dos subredes con la misma red hacen que la ocupación de las dos mienta.`
        : error.message,
      { status: 400 },
    )
  }

  const creadas = await materializar(subred.id, revision)
  return { pool: subred, ...creadas }
}

/** Agrega al pool las direcciones que le falten del rango. */
export async function ampliarPool(subredId, { desde, hasta }) {
  const { data: subred } = await db().from('subredes').select('*').eq('id', subredId).maybeSingle()
  if (!subred) throw badRequest('Ese pool no existe')

  const revision = revisarRango({
    cidr: subred.cidr,
    desde: desde ?? subred.rango_desde,
    hasta: hasta ?? subred.rango_hasta,
    gateway: subred.gateway,
  })

  const creadas = await materializar(subredId, revision)

  // El rango declarado se amplía al que efectivamente abarca ahora.
  await db()
    .from('subredes')
    .update({ rango_desde: revision.desde, rango_hasta: revision.hasta })
    .eq('id', subredId)

  return creadas
}

/**
 * Crea las filas del rango que todavía no estén.
 *
 * Se leen primero las que hay y se insertan solo las que faltan, en vez de
 * confiar en el índice único: así el resultado dice cuántas se agregaron y
 * cuántas ya estaban, que es lo que hay que mostrar cuando alguien reejecuta
 * el formulario creyendo que no pasó nada la primera vez.
 */
async function materializar(subredId, revision) {
  const { data: existentes } = await db()
    .from('ip_addresses')
    .select('ip_address')
    .eq('subred_id', subredId)

  const yaEstan = new Set((existentes ?? []).map((e) => e.ip_address))
  const gw = revision.gateway ? aEntero(revision.gateway) : null

  const filas = []
  for (let n = aEntero(revision.desde); n <= aEntero(revision.hasta); n++) {
    if (n === gw) continue // el gateway no se reparte
    const ip = aIp(n)
    if (yaEstan.has(ip)) continue
    filas.push({ subred_id: subredId, ip_address: ip, estado: 'libre', origen: 'manual' })
  }

  if (!filas.length) return { creadas: 0, ya_estaban: yaEstan.size, gateway_excluido: gw != null }

  // De a tandas: un insert de cuatro mil filas puede pasarse del límite de la
  // petición y fallar entero, dejando el pool a medias sin decir por dónde iba.
  const TANDA = 500
  let creadas = 0
  for (let i = 0; i < filas.length; i += TANDA) {
    const { error } = await db().from('ip_addresses').insert(filas.slice(i, i + TANDA))
    if (error) {
      throw new AppError(`Se cargaron ${creadas} de ${filas.length} direcciones: ${error.message}`, {
        status: 400,
        hint: 'El pool quedó a medias. Volvé a guardar para completar las que faltan.',
      })
    }
    creadas += Math.min(TANDA, filas.length - i)
  }

  return { creadas, ya_estaban: yaEstan.size, gateway_excluido: gw != null }
}

/**
 * Trae al sistema las IPs de gestión que las ONTs ya tienen puestas.
 *
 * Es el paso que hace falta al migrar desde otro sistema: las direcciones están
 * en los equipos y acá figuran libres, así que el primer alta entregaría una
 * repetida. Dos ONTs con la misma dirección de gestión no dan error en ningún
 * lado — las dos le contestan al ACS y ninguna configuración llega a destino.
 *
 * Se lee del equipo, no de una exportación: es la única fuente que no puede
 * estar desactualizada.
 */
export async function importarIpsDeGestion(oltId, { aplicar = false } = {}) {
  const olt = await cargarOlt(oltId)

  const [{ data: onus }, { data: pools }] = await Promise.all([
    db().from('onus').select('id, sn, slot, puerto, onu_index, nombre_cliente').eq('olt_id', oltId),
    db().from('v_pools_onu').select('*').eq('olt_id', oltId).eq('proposito', 'gestion_onu'),
  ])

  if (!onus?.length) throw badRequest('Esta OLT no tiene ONUs cargadas')

  const leidas = await olts.leerIpsGestionDeOnts(olt, {
    onts: onus
      .filter((o) => o.slot != null && o.puerto != null && o.onu_index != null)
      .map((o) => ({ slot: o.slot, puerto: o.puerto, ontId: o.onu_index, onu_id: o.id, sn: o.sn })),
  })

  // A qué pool pertenece cada dirección. Se compara contra la red del bloque,
  // no contra el rango declarado: una dirección puesta a mano fuera del rango
  // sigue siendo de ese pool y sigue estando ocupada.
  const bloques = (pools ?? []).map((p) => ({ ...p, ...rangoDeCidr(p.cidr) }))
  const poolDe = (ip) => {
    const n = aEntero(ip)
    return n == null ? null : bloques.find((b) => n >= b.desde && n <= b.hasta)
  }

  const porOnu = new Map(onus.map((o) => [o.id, o]))
  const vistas = new Map() // ip → primera ONU que la tiene

  const filas = leidas.map((l) => {
    const onu = porOnu.get(l.onu_id)
    const base = {
      sn: l.sn,
      donde: `${l.slot}/${l.puerto}/${l.ontId}`,
      nombre: onu?.nombre_cliente ?? null,
      ip: l.ip ?? null,
      vlan: l.vlan ?? null,
      onu_id: l.onu_id,
    }

    if (l.error) return { ...base, estado: 'error', motivo: l.error }
    if (!l.ip) return { ...base, estado: 'sin_ip', motivo: 'La ONT no tiene IP de gestión puesta' }

    const pool = poolDe(l.ip)
    if (!pool) {
      return {
        ...base,
        estado: 'sin_pool',
        motivo: `${l.ip} no cae en ningún pool de gestión cargado`,
      }
    }

    // Dos ONTs con la misma dirección. No se importa la segunda: elegir una
    // escondería el problema, y es de los que hay que ver.
    const ya = vistas.get(l.ip)
    if (ya) {
      return { ...base, estado: 'repetida', motivo: `La misma dirección la tiene ${ya}`, pool_id: pool.id }
    }
    vistas.set(l.ip, `${l.sn} (${base.donde})`)

    return { ...base, estado: 'se_importa', pool_id: pool.id, pool: pool.cidr, mascara: l.mascara }
  })

  const aImportar = filas.filter((f) => f.estado === 'se_importa')

  const resumen = {
    onts_leidas: leidas.length,
    con_ip: filas.filter((f) => f.ip).length,
    se_importan: aImportar.length,
    sin_ip: filas.filter((f) => f.estado === 'sin_ip').length,
    sin_pool: filas.filter((f) => f.estado === 'sin_pool').length,
    repetidas: filas.filter((f) => f.estado === 'repetida').length,
    con_error: filas.filter((f) => f.estado === 'error').length,
  }

  if (!aplicar) return { olt: { id: olt.id, nombre: olt.nombre }, filas, resumen }

  // Se marcan como asignadas. La dirección puede no existir todavía como fila
  // —si el rango del pool no la incluía— y en ese caso se crea: lo que está en
  // el equipo manda sobre lo que alguien declaró.
  const resultados = []
  for (const f of aImportar) {
    const { data: existente } = await db()
      .from('ip_addresses')
      .select('id, estado')
      .eq('subred_id', f.pool_id)
      .eq('ip_address', f.ip)
      .maybeSingle()

    const campos = {
      estado: 'asignada',
      onu_id: f.onu_id,
      descripcion: `Gestión · ${f.nombre ?? f.sn}`.slice(0, 150),
      origen: 'manual',
    }

    const { error } = existente
      ? await db().from('ip_addresses').update(campos).eq('id', existente.id)
      : await db()
          .from('ip_addresses')
          .insert({ ...campos, subred_id: f.pool_id, ip_address: f.ip })

    resultados.push({
      ip: f.ip,
      sn: f.sn,
      hecho: !error,
      creada: !existente,
      ...(error ? { motivo: error.message } : {}),
    })
  }

  return {
    olt: { id: olt.id, nombre: olt.nombre },
    filas,
    resumen,
    importadas: resultados.filter((r) => r.hecho).length,
    fuera_del_rango: resultados.filter((r) => r.hecho && r.creada).length,
    fallidas: resultados.filter((r) => !r.hecho),
  }
}

/** Cambia los datos del pool. No toca las direcciones ya cargadas. */
export async function editarPool(subredId, datos) {
  const campos = {}
  for (const k of ['nombre', 'notas']) if (k in datos) campos[k] = aTexto(datos[k])
  for (const k of ['gateway', 'dns1', 'dns2']) if (k in datos) campos[k] = aTexto(datos[k])
  if ('vlan' in datos) campos.vlan = datos.vlan === '' || datos.vlan == null ? null : Number(datos.vlan)

  const { data, error } = await db()
    .from('subredes')
    .update(campos)
    .eq('id', subredId)
    .select('*')
    .maybeSingle()

  if (error) throw new AppError(error.message, { status: 400 })
  if (!data) throw badRequest('Ese pool no existe')
  return data
}

/**
 * Borra el pool.
 *
 * Se niega si tiene direcciones entregadas: borrarlo se lleva por delante las
 * filas de `ip_addresses` —la FK es ON DELETE CASCADE— y las ONUs que las
 * tenían quedan con una dirección que el sistema ya no sabe de dónde salió.
 */
export async function borrarPool(subredId, { forzar = false } = {}) {
  const { data: pool } = await db().from('v_pools_onu').select('*').eq('id', subredId).maybeSingle()
  if (!pool) throw badRequest('Ese pool no existe')

  const entregadas = (pool.usadas ?? 0) + (pool.reservadas ?? 0)
  if (entregadas && !forzar) {
    const plural = entregadas === 1 ? 'dirección entregada' : 'direcciones entregadas'
    throw new AppError(`El pool ${pool.cidr} tiene ${entregadas} ${plural}`, {
      status: 409,
      hint: 'Liberalas primero, o confirmá que querés borrarlo igual.',
      usadas: pool.usadas,
      reservadas: pool.reservadas,
    })
  }

  const { error } = await db().from('subredes').delete().eq('id', subredId)
  if (error) throw new AppError(error.message, { status: 400 })
  return { borrado: true, cidr: pool.cidr, direcciones_borradas: pool.total }
}

/**
 * La siguiente dirección libre del pool, para dársela a una ONU.
 *
 * Devuelve además el gateway, los DNS y la VLAN: son los datos que hay que
 * configurar junto con la dirección, y buscarlos por separado es cómo se
 * termina poniendo una IP correcta con el gateway de otro pool.
 */
export async function siguienteLibre(subredId) {
  const { data: pool } = await db().from('v_pools_onu').select('*').eq('id', subredId).maybeSingle()
  if (!pool) throw badRequest('Ese pool no existe')

  const { data } = await db()
    .from('ip_addresses')
    .select('id, ip_address')
    .eq('subred_id', subredId)
    .eq('estado', 'libre')

  if (!data?.length) {
    throw new AppError(`No queda ninguna dirección libre en ${pool.cidr}`, {
      status: 409,
      hint: 'Ampliá el rango del pool o liberá las de las ONUs dadas de baja.',
    })
  }

  const primera = data.sort((a, b) => (aEntero(a.ip_address) ?? 0) - (aEntero(b.ip_address) ?? 0))[0]

  return {
    ip: primera.ip_address,
    ip_id: primera.id,
    gateway: pool.gateway,
    dns1: pool.dns1,
    dns2: pool.dns2,
    vlan: pool.vlan,
    cidr: pool.cidr,
    quedan: data.length - 1,
  }
}

/**
 * Deja el pool del MikroTik igual al rango declarado en el bloque.
 *
 * El rango vive en dos lados: acá como inventario y en el router como lo que de
 * verdad entrega direcciones. Cambiar uno solo deja el sistema diciendo una
 * cosa y el router haciendo otra — y el que decide es el router, así que el
 * error aparece cuando un abonado recibe una IP que el sistema creía reservada.
 *
 * Si el pool no existe se crea. Si el bloque no tiene rango declarado no se
 * toca nada: sin saber qué entregar, escribir un rango sería inventarlo.
 */
export async function sincronizarPool(subredId) {
  const { data: sub } = await db().from('subredes').select('*').eq('id', subredId).maybeSingle()
  if (!sub) throw badRequest('Ese bloque no existe')
  if (!sub.router_id) throw badRequest('El bloque no tiene router asignado')
  if (!sub.pool_router) throw badRequest('El bloque no tiene nombre de pool')

  if (!sub.rango_desde || !sub.rango_hasta) {
    throw badRequest('El bloque no declara desde y hasta qué dirección entrega', {
      hint: 'Cargá el rango en la ficha del bloque y volvé a guardar.',
    })
  }

  const rango = `${sub.rango_desde}-${sub.rango_hasta}`
  const equipo = await cargarRouter(sub.router_id)
  const pools = await mk.listarPools(equipo)
  const existente = pools.find((p) => p.name === sub.pool_router)

  if (!existente) {
    await mk.crearPool(equipo, { name: sub.pool_router, ranges: rango, comment: sub.nombre })
    return { creado: true, pool: sub.pool_router, rango }
  }

  if (existente.ranges === rango) return { sin_cambios: true, pool: sub.pool_router, rango }

  // RouterOS no deja modificar el rango de un pool en uso sin más, así que se
  // borra y se recrea. Es instantáneo y no corta nada: el pool solo se consulta
  // cuando alguien autentica, no mantiene estado.
  await mk.borrarPool(equipo, existente['.id'] ?? existente.id)
  await mk.crearPool(equipo, { name: sub.pool_router, ranges: rango, comment: sub.nombre })

  return { actualizado: true, pool: sub.pool_router, antes: existente.ranges, ahora: rango }
}

/**
 * Un perfil PPP por VLAN, cada uno con su propia puerta de enlace.
 *
 * Hace falta cuando el esquema usa un gateway por bloque en vez de uno
 * compartido: reservar el .1 de cada /25 no sirve de nada si todos los abonados
 * siguen recibiendo el mismo local-address. Sin el perfil, se pierde una
 * dirección por bloque y no se gana nada.
 *
 * El perfil va sin límite de velocidad a propósito: en este esquema la limita
 * la OLT con sus traffic tables, y ponerlo en los dos lados hace que mande el
 * más restrictivo — con el resultado de que cambiar el plan en la OLT no surta
 * efecto y nadie sepa por qué.
 */
export async function crearPerfilesPorVlan(oltId, { aplicar = false, nombre = 'VLAN{vlan}' } = {}) {
  const olt = await cargarOlt(oltId)

  const { data: subredes } = await db()
    .from('subredes')
    .select('id, nombre, cidr, vlan, gateway, pool_router, router_id')
    .eq('olt_id', oltId)
    .eq('proposito', 'abonados')
    .not('vlan', 'is', null)
    .order('vlan')

  if (!subredes?.length) throw badRequest('Esta OLT no tiene bloques de abonados con VLAN')

  const propuestas = []
  for (const s of subredes) {
    const perfil = nombre.replace(/\{vlan\}/g, String(s.vlan)).replace(/\{olt\}/g, olt.nombre)

    // Sin gateway propio no hay nada que crear: el perfil quedaría igual al
    // compartido y sería una copia sin sentido.
    if (!s.gateway) {
      propuestas.push({ vlan: s.vlan, cidr: s.cidr, perfil, motivo: 'El bloque no declara gateway' })
      continue
    }
    if (!s.router_id) {
      propuestas.push({ vlan: s.vlan, cidr: s.cidr, perfil, motivo: 'El bloque no tiene router' })
      continue
    }

    propuestas.push({
      vlan: s.vlan,
      cidr: s.cidr,
      perfil,
      local_address: s.gateway,
      pool: s.pool_router,
      router_id: s.router_id,
      se_crea: true,
    })
  }

  const aCrear = propuestas.filter((p) => p.se_crea)

  // Cuáles ya existen y con qué. Se dice antes de tocar: un perfil que ya está
  // puede tener límites puestos a mano que este proceso borraría.
  if (aCrear.length) {
    const equipo = await cargarRouter(aCrear[0].router_id)
    const existentes = await mk.listarPppProfiles(equipo).catch(() => [])
    const porNombre = new Map(existentes.map((p) => [p.name, p]))
    for (const p of aCrear) {
      const y = porNombre.get(p.perfil)
      if (y) {
        p.ya_existe = true
        p.actual = {
          local_address: y['local-address'] ?? null,
          remote_address: y['remote-address'] ?? null,
          rate_limit: y['rate-limit'] ?? null,
        }
      }
    }
  }

  const resumen = {
    bloques: propuestas.length,
    se_crean: aCrear.filter((p) => !p.ya_existe).length,
    se_actualizan: aCrear.filter((p) => p.ya_existe).length,
    sin_gateway: propuestas.filter((p) => !p.se_crea).length,
  }

  if (!aplicar) return { olt: { id: olt.id, nombre: olt.nombre }, propuestas, resumen }

  const resultados = []
  for (const p of aCrear) {
    try {
      const equipo = await cargarRouter(p.router_id)
      const r = await mk.asegurarPppProfile(equipo, {
        nombre: p.perfil,
        localAddress: p.local_address,
        pool: p.pool ?? undefined,
        // Vacío a propósito: la velocidad la aplica la OLT.
        rateLimit: '',
        comentario: `${olt.nombre} · VLAN ${p.vlan} · ${p.cidr}`,
      })
      resultados.push({ perfil: p.perfil, vlan: p.vlan, hecho: true, ...r })
    } catch (e) {
      resultados.push({ perfil: p.perfil, vlan: p.vlan, hecho: false, motivo: e.message })
    }
  }

  return {
    olt: { id: olt.id, nombre: olt.nombre },
    propuestas,
    resumen,
    creados: resultados.filter((r) => r.hecho && r.creado).length,
    actualizados: resultados.filter((r) => r.hecho && r.actualizado).length,
    fallidos: resultados.filter((r) => !r.hecho),
  }
}

/**
 * Reconstruye los bloques leyendo el MikroTik.
 *
 * Es la pregunta de cualquier ISP que llega con la red ya armada: "¿tengo que
 * cargar todo a mano?". No: la información ya está en el router y con una
 * convención de nombres se puede recuperar entera.
 *
 *     BOARD1_PON0_VLAN116_MA5608T → 172.16.8.2-172.16.8.126
 *        placa 1 · puerto 0 · VLAN 116 · y el rango que entrega
 *
 * De ahí sale el bloque, su rango, su VLAN y de qué puerto es. El gateway sale
 * de las direcciones del router: la que cae dentro del mismo /25.
 *
 * Lo que NO se deduce se deja vacío en vez de inventarlo. Un pool llamado
 * "clientes-norte" no dice de qué puerto es, y suponerlo mandaría a un abonado
 * al segmento de otro.
 */
export async function importarDelRouter(routerId, { oltId = null, aplicar = false } = {}) {
  const equipo = await cargarRouter(routerId)

  const [pools, direcciones, { data: yaCargadas }] = await Promise.all([
    mk.listarPools(equipo),
    mk.listarDirecciones(equipo).catch(() => []),
    db().from('subredes').select('id, cidr, nombre, vlan'),
  ])

  // Las que ya están, por red: no se duplica lo cargado.
  const yaEsta = new Set(
    (yaCargadas ?? []).map((s) => {
      const { desde } = rangoDeCidr(s.cidr)
      return desde
    }),
  )

  // Las direcciones del router, para encontrar el gateway de cada bloque.
  const delRouter = (direcciones ?? [])
    .map((d) => {
      const [ip, bits] = String(d.address).split('/')
      return { n: aEntero(ip), bits: Number(bits), interfaz: d.interface, comentario: d.comment }
    })
    .filter((d) => d.n != null)

  const propuestas = []
  for (const p of pools) {
    const rangos = String(p.ranges ?? '').split(',')[0]
    const [desdeTxt, hastaTxt] = rangos.split('-').map((x) => x.trim())
    const desde = aEntero(desdeTxt)
    const hasta = aEntero(hastaTxt ?? desdeTxt)
    if (desde == null) continue

    // El nombre suele traer placa, puerto y VLAN. Es una convención del ISP y
    // por eso se lee con tolerancia: si no encaja, el bloque igual se propone,
    // solo que sin saber de qué puerto es.
    const m = String(p.name).match(/BOARD(\d+).*?PON(\d+).*?VLAN(\d+)/i)
    const vlanSuelta = String(p.name).match(/VLAN[_-]?(\d+)/i)

    // El bloque que contiene el rango. Se busca el gateway del router adentro y
    // de ahí sale el prefijo real; sin él se supone /24, que es lo más común.
    const gateway = delRouter.find((d) => {
      const tamano = 2 ** (32 - d.bits)
      const red = d.n - (d.n % tamano)
      return desde >= red && hasta <= red + tamano - 1
    })

    // El prefijo sale del gateway si el router lo tiene puesto. Si no —y en
    // PPPoE no lo tiene, porque el bloque no vive en ninguna interfaz— se
    // deduce del propio rango: el bloque alineado más chico que lo contenga.
    //
    // Suponer /24 estaba mal: dos /25 consecutivos caían en el mismo /24 y el
    // importador proponía el mismo bloque dos veces.
    const bits = gateway?.bits ?? prefijoQueContiene(desde, hasta)
    const tamano = 2 ** (32 - bits)
    const red = desde - (desde % tamano)

    propuestas.push({
      pool: p.name,
      rango: rangos,
      cidr: `${aIp(red)}/${bits}`,
      desde: aIp(desde),
      hasta: aIp(hasta),
      slot: m ? Number(m[1]) : null,
      puerto: m ? Number(m[2]) : null,
      // La VLAN, por orden de confianza: la del nombre del pool, la que el
      // nombre traiga suelta, o la de una interfaz que SE LLAME vlan<algo>.
      //
      // Antes se sacaba cualquier número de la interfaz, y "ether11" daba
      // "VLAN 11" — un dato inventado que después mandaría a un abonado al
      // segmento equivocado.
      vlan: m
        ? Number(m[3])
        : vlanSuelta
          ? Number(vlanSuelta[1])
          : (Number(String(gateway?.interfaz ?? '').match(/^vlan[_-]?(\d+)/i)?.[1]) || null),
      gateway: gateway ? aIp(gateway.n) : null,
      interfaz: gateway?.interfaz ?? null,
      ya_cargado: yaEsta.has(red + 1),
      // Sin VLAN el bloque se carga igual, pero no va a poder resolver un alta
      // sola: hay que completarla a mano.
      completo: Boolean(m),
    })
  }

  const nuevas = propuestas.filter((p) => !p.ya_cargado)
  const resumen = {
    pools: propuestas.length,
    ya_cargados: propuestas.filter((p) => p.ya_cargado).length,
    se_importan: nuevas.length,
    con_puerto: nuevas.filter((p) => p.completo).length,
    sin_puerto: nuevas.filter((p) => !p.completo).length,
  }

  if (!aplicar) return { router: equipo.nombre, propuestas, resumen }

  const resultados = []
  for (const p of nuevas) {
    try {
      const { data, error } = await db()
        .from('subredes')
        .insert({
          nombre: p.pool,
          cidr: p.cidr,
          tipo: 'pool_pppoe',
          vlan: p.vlan,
          gateway: p.gateway,
          rango_desde: p.desde,
          rango_hasta: p.hasta,
          pool_router: p.pool,
          router_id: routerId,
          olt_id: oltId,
          notas: `Importado del router. Pool "${p.pool}"${p.interfaz ? ` · interfaz ${p.interfaz}` : ''}.`,
        })
        .select('id')
        .single()
      if (error) throw new Error(error.message)

      // Y la asignación del puerto, cuando el nombre la traía.
      if (oltId && p.slot != null && p.puerto != null && p.vlan != null) {
        await anotarVlanSiFalta(oltId, p.vlan)
        await asignarPuertoDesdeImport(oltId, p)
      }

      resultados.push({ pool: p.pool, hecho: true, id: data.id })
    } catch (e) {
      resultados.push({ pool: p.pool, hecho: false, motivo: e.message })
    }
  }

  return {
    router: equipo.nombre,
    propuestas,
    resumen,
    importados: resultados.filter((r) => r.hecho).length,
    fallidos: resultados.filter((r) => !r.hecho),
  }
}

/**
 * El bloque alineado más chico que contiene ese rango.
 *
 * Un rango .1 → .126 entra en un /25 y no en un /26; uno .1 → .254 necesita un
 * /24. Se prueba de lo chico a lo grande y se devuelve el primero que alcanza,
 * porque proponer un bloque más grande del real haría que dos pools vecinos se
 * vean como el mismo.
 */
function prefijoQueContiene(desde, hasta) {
  for (let bits = 30; bits >= 8; bits--) {
    const tamano = 2 ** (32 - bits)
    const red = desde - (desde % tamano)
    if (hasta <= red + tamano - 1) return bits
  }
  return 8
}

/** La VLAN tiene que existir anotada antes de colgarle un puerto. */
async function anotarVlanSiFalta(oltId, vlan) {
  const { data } = await db()
    .from('vlans_olt')
    .select('vlan')
    .eq('olt_id', oltId)
    .eq('vlan', vlan)
    .maybeSingle()
  if (!data) {
    await db()
      .from('vlans_olt')
      .insert({ olt_id: oltId, vlan, uso: 'internet', descripcion: 'Importada del router' })
  }
}

async function asignarPuertoDesdeImport(oltId, p) {
  await db()
    .from('puertos_pon')
    .upsert(
      {
        olt_id: oltId,
        slot: p.slot,
        puerto: p.puerto,
        vlan: p.vlan,
        descripcion: `PON ${p.puerto} · importado del router`,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'olt_id,slot,puerto' },
    )
}
