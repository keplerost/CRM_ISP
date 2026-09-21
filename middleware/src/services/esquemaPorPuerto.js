import { db, cargarOlt, cargarRouter } from '../lib/db.js'
import { badRequest } from '../lib/errors.js'
import { aEntero, aIp } from '../lib/ip.js'
import * as mk from './mikrotikService.js'
import * as olts from './oltService.js'
import { anotarVlan, asignarPuerto, crearVlans, desasignarPuerto } from './vlansOlt.js'

/**
 * Un bloque de IP y una VLAN para cada puerto PON, generados de una vez.
 *
 * Es el esquema que este ISP ya usa en la MA5608T y que armó a mano, puerto por
 * puerto:
 *
 *     vlan116  172.16.8.0/25    gw 172.16.8.1     .2 → .126     PON 0
 *     vlan117  172.16.8.128/25  gw 172.16.8.129   .130 → .254   PON 1
 *     vlan118  172.16.9.0/25    gw 172.16.9.1     .2 → .126     PON 2
 *
 * Dos /25 por cada /24, 128 direcciones cada uno, uno por puerto. Repetirlo a
 * mano en la otra OLT son dieciséis VLANs, dieciséis subredes, dieciséis
 * gateways y dieciséis pools escritos uno por uno; es donde aparece el bloque
 * repetido o el octeto salteado, y ninguno de los dos se nota hasta que dos
 * abonados terminan con la misma dirección.
 *
 * La cuenta se hace acá, sin tocar nada, y se muestra entera antes de aplicarla.
 */

/** Cuántas direcciones entran en un prefijo, incluidas red y broadcast. */
const tamanoDe = (prefijo) => 2 ** (32 - prefijo)

/**
 * El plan completo, sin tocar la base ni el equipo.
 *
 * Es una función pura a propósito: es la parte que hace la aritmética, es donde
 * un error se reparte por dieciséis puertos a la vez, y es la que se puede
 * probar sin nada conectado.
 */
export function planificarEsquemaPorPuerto({
  slot,
  desdePuerto = 0,
  hastaPuerto,
  desdeVlan,
  bloqueBase,
  prefijo = 25,
  // Dónde va el gateway DENTRO de cada bloque:
  //
  //   'inicio'      la .1     — los /25 de la MA5608T
  //   'fin'         la .254   — los /24 de la X7
  //   'compartido'  ninguna: el gateway es uno solo para todos los bloques,
  //                 el local-address del perfil PPP
  //
  // Y cómo se reparte, que es una decisión APARTE:
  //
  //   pppoe = false   IP fija: el bloque se pone en la interfaz VLAN del router
  //   pppoe = true    cada sesión levanta su propia ruta /32. No hay dominio de
  //                   broadcast ni ARP, así que el bloque no va en ninguna
  //                   interfaz. Verificado en este router: el abonado
  //                   172.16.5.2 tiene como gateway el 172.17.0.1 del perfil,
  //                   no el 172.16.5.1 que está puesto en la vlan110.
  //
  // Las cuatro combinaciones son válidas y las dos que importan son:
  //
  //   pppoe + compartido   un solo local-address. El .1 de cada bloque queda
  //                        libre y se entrega: 126 direcciones por /25.
  //   pppoe + inicio       un perfil PPP por VLAN, cada uno con el .1 de su
  //                        bloque. Reserva una dirección y a cambio el ruteo se
  //                        lee por segmento: 125 por /25.
  //
  // Estaban mezcladas en un solo campo y no se podía pedir la segunda.
  gateway = 'inicio',
  pppoe = false,
  gatewayPppoe = null,
  nombre = 'BOARD{slot}_PON{puerto}_VLAN{vlan}_{olt}',
  olt = '',
} = {}) {
  const s = Number(slot)
  const p0 = Number(desdePuerto)
  const p1 = Number(hastaPuerto)
  const v0 = Number(desdeVlan)
  const bits = Number(prefijo)

  if (!Number.isInteger(s) || s < 0) throw badRequest('Falta la placa (slot)')
  if (!Number.isInteger(p0) || !Number.isInteger(p1) || p1 < p0) {
    throw badRequest('El rango de puertos no es válido')
  }
  if (!Number.isInteger(v0) || v0 < 1 || v0 > 4094) throw badRequest('La VLAN inicial no es válida')
  if (!Number.isInteger(bits) || bits < 8 || bits > 30) {
    throw badRequest('El prefijo tiene que estar entre /8 y /30')
  }

  // `gateway: 'pppoe'` significaba las dos cosas juntas. Se traduce para no
  // romper lo que ya lo usa.
  const esPppoe = pppoe || gateway === 'pppoe'
  const donde = gateway === 'pppoe' ? 'compartido' : gateway

  const base = aEntero(String(bloqueBase ?? '').split('/')[0])
  if (base == null) throw badRequest(`"${bloqueBase}" no es una dirección válida`)

  // Sin local-address, el abonado autentica y queda sin puerta de enlace. Es un
  // fallo que no se ve al dar de alta —el secret se crea igual— sino cuando el
  // cliente llama porque "conecta pero no navega".
  if (donde === 'compartido' && aEntero(gatewayPppoe) == null) {
    throw badRequest('En modo PPPoE hace falta el local-address del perfil PPP', {
      hint: 'Es la dirección que el router le da como puerta de enlace a todos los abonados. En este router es 172.17.0.1.',
    })
  }

  const tamano = tamanoDe(bits)

  // Un bloque base desalineado genera solapamientos que no se ven en la tabla:
  // arrancar los /25 en .64 hace que el segundo pise al primero. Se rechaza
  // diciendo cuál es la dirección correcta, que es lo único útil en ese momento.
  if (base % tamano !== 0) {
    throw badRequest(
      `${aIp(base)}/${bits} no es el comienzo de un bloque. ` +
        `El /${bits} que lo contiene empieza en ${aIp(base - (base % tamano))}.`,
    )
  }

  const cantidad = p1 - p0 + 1
  if (v0 + cantidad - 1 > 4094) {
    throw badRequest(`Arrancando en la VLAN ${v0} no entran ${cantidad} puertos: se pasa de 4094`)
  }
  if (base + cantidad * tamano > 2 ** 32) {
    throw badRequest(`Arrancando en ${aIp(base)} no entran ${cantidad} bloques /${bits}`)
  }

  const filas = []
  for (let i = 0; i < cantidad; i++) {
    const puerto = p0 + i
    const vlan = v0 + i
    const red = base + i * tamano
    const broadcast = red + tamano - 1

    // La red y el broadcast quedan siempre afuera: el prefijo está acotado a
    // /30 justamente porque un bloque de abonados necesita las dos.
    //
    // Lo que cambia según dónde esté el gateway es si además se descuenta una
    // dirección más. Con el gateway compartido no se descuenta ninguna, y por
    // eso un /25 entrega 126 en vez de 125.
    const compartido = donde === 'compartido'
    const alFinal = donde === 'fin'

    const gw = compartido ? null : alFinal ? broadcast - 1 : red + 1
    const desde = compartido || alFinal ? red + 1 : red + 2
    const hasta = compartido ? broadcast - 1 : alFinal ? broadcast - 2 : broadcast - 1

    filas.push({
      // La placa va en cada fila y no solo arriba: las filas viajan al navegador
      // y vuelven, y separar el dato de su contexto es cómo se termina creando
      // el puerto 4 de la placa equivocada.
      slot: s,
      puerto,
      vlan,
      cidr: `${aIp(red)}/${bits}`,
      // El gateway que se le declara al bloque: el propio, o el compartido.
      gateway: compartido ? gatewayPppoe : aIp(gw),
      // Marca si el bloque va o no en una interfaz del router. Es lo que decide
      // que al aplicar NO se le ponga la dirección a la VLAN.
      pppoe: esPppoe,
      desde: aIp(desde),
      hasta: aIp(hasta),
      rango: `${aIp(desde)}-${aIp(hasta)}`,
      direcciones: hasta - desde + 1,
      nombre: nombre
        .replace(/\{slot\}/g, String(s))
        .replace(/\{puerto\}/g, String(puerto))
        .replace(/\{vlan\}/g, String(vlan))
        .replace(/\{olt\}/g, olt)
        .replace(/\{cidr\}/g, `${aIp(red)}/${bits}`),
    })
  }

  return {
    slot: s,
    prefijo: bits,
    filas,
    total: filas.length,
    direccionesPorBloque: filas[0]?.direcciones ?? 0,
    // Hasta dónde llega todo el esquema. Es el dato que hace falta para elegir
    // dónde arranca el siguiente sin pisarlo.
    abarca: filas.length ? `${filas[0].cidr.split('/')[0]} … ${filas.at(-1).hasta}` : null,
  }
}

/**
 * El mismo plan, contrastado con lo que ya existe.
 *
 * Un esquema nuevo casi nunca cae en terreno vacío: la VLAN puede estar en uso
 * en otro puerto, el bloque puede solapar con uno cargado hace un año. Detectar
 * eso DESPUÉS de crear la mitad deja el sistema a medias, así que se revisa
 * todo primero y se aplica solo si el usuario ve los avisos.
 */
export async function revisarEsquema(oltId, plan, { routerId = null } = {}) {
  const olt = await cargarOlt(oltId)

  const [{ data: subredes }, { data: asignadas }, { data: onus }, delEquipo, pools] = await Promise.all([
    db().from('subredes').select('id, nombre, cidr, vlan, olt_id').eq('activo', true),
    db().from('puertos_pon').select('vlan, slot, puerto').eq('olt_id', oltId),
    db().from('onus').select('slot, puerto').eq('olt_id', oltId),
    olts.leerVlans(olt).catch(() => null),
    routerId
      ? cargarRouter(routerId)
          .then((r) => mk.listarPools(r))
          .catch(() => null)
      : Promise.resolve(null),
  ])

  const enElEquipo = delEquipo ? new Set(delEquipo.map((v) => Number(v.vlan))) : null
  const nombresDePool = pools ? new Set(pools.map((p) => p.name)) : null
  // Indexado por PUERTO, no por VLAN. Una VLAN puede ser la de varios puertos
  // —acá la 200 es la de siete— y lo que no puede es que un puerto tenga dos
  // PREDETERMINADAS. Transportar varias sí puede, y de hecho lo hace.
  const porPuerto = new Map((asignadas ?? []).map((a) => [`${a.slot}/${a.puerto}`, a]))

  // Cuántos abonados cuelgan de cada puerto: es lo que permite decir a cuántos
  // afecta el cambio, en vez de un aviso genérico.
  const abonadosPorPuerto = new Map()
  for (const o of onus ?? []) {
    const k = `${o.slot}/${o.puerto}`
    abonadosPorPuerto.set(k, (abonadosPorPuerto.get(k) ?? 0) + 1)
  }
  const bloques = (subredes ?? []).map((s) => ({ ...s, ...rangoDe(s.cidr) })).filter((s) => s.desde != null)

  const filas = plan.filas.map((f) => {
    const avisos = []
    const { desde, hasta } = rangoDe(f.cidr)

    // Cambiarle la VLAN predeterminada a un puerto NO es un error: es lo que
    // hace una migración de esquema. Un puerto PON transporta varias VLANs a la
    // vez —acá cada ONT lleva la de internet y la de gestión— así que la
    // predeterminada es solo con cuál sale un ALTA NUEVA de ese puerto.
    //
    // Los abonados que ya están no se enteran: su segmento se resuelve por la
    // VLAN que su ONT tiene puesta, no por la del puerto.
    //
    // Esto era un aviso grave y bloqueaba la mitad de los puertos. Estaba mal:
    // se confundía "la VLAN predeterminada del puerto" con "las VLANs que el
    // puerto lleva", que son cosas distintas.
    const yaTiene = porPuerto.get(`${f.slot}/${f.puerto}`)
    if (yaTiene?.vlan != null && yaTiene.vlan !== f.vlan) {
      const cuantos = abonadosPorPuerto.get(`${f.slot}/${f.puerto}`) ?? 0
      avisos.push({
        cambia_predeterminada: true,
        texto:
          `El puerto pasa de la VLAN ${yaTiene.vlan} a la ${f.vlan}` +
          (cuantos
            ? `. Los ${cuantos} abonados que ya tiene siguen en la ${yaTiene.vlan} y no se tocan; los nuevos saldrán por la ${f.vlan}.`
            : '.'),
      })
    }

    const solapa = bloques.filter((s) => desde <= s.hasta && hasta >= s.desde)
    for (const s of solapa) {
      avisos.push({ grave: true, texto: `${f.cidr} se solapa con ${s.nombre} (${s.cidr})` })
    }

    const mismaVlan = bloques.filter((s) => s.vlan === f.vlan && !solapa.includes(s))
    for (const s of mismaVlan) {
      avisos.push({ texto: `La VLAN ${f.vlan} ya la usa ${s.nombre} (${s.cidr})` })
    }

    if (enElEquipo && !enElEquipo.has(f.vlan)) {
      avisos.push({ texto: `La VLAN ${f.vlan} no existe en el equipo: se va a crear`, crear_vlan: true })
    }

    // Un pool con el mismo nombre no se puede crear dos veces, y descubrirlo a
    // mitad de camino deja la mitad de los bloques sin el suyo.
    if (nombresDePool?.has(f.nombre)) {
      avisos.push({ texto: `El router ya tiene un pool llamado "${f.nombre}"` })
    }

    return { ...f, avisos, listo: !avisos.some((a) => a.grave) }
  })

  return {
    ...plan,
    filas,
    // Se pudo leer el equipo o no. Sin esto, "ninguna VLAN hay que crear" y "no
    // pudimos preguntar" se ven igual, y son cosas muy distintas.
    equipo_leido: enElEquipo != null,
    router_leido: nombresDePool != null,
    a_crear_en_el_equipo: enElEquipo ? filas.filter((f) => !enElEquipo.has(f.vlan)).length : null,
    con_problemas: filas.filter((f) => !f.listo).length,
    // Puertos a los que les cambia la VLAN predeterminada. No es un problema
    // —es lo que hace una migración— pero hay que verlo antes de aplicar.
    cambian_de_vlan: filas.filter((f) => f.avisos.some((a) => a.cambia_predeterminada)).length,
  }
}

/**
 * Deshace lo que creó el esquema, en los tres lados a la vez.
 *
 * Es el botón que faltaba. El generador crea TRES cosas —la VLAN en la OLT, el
 * bloque acá y la asignación del puerto— y hasta ahora deshacerlo era ir a tres
 * pantallas distintas. Quien iba a dos y se olvidaba de la tercera quedaba con
 * el generador bloqueado sin entender por qué: los bloques ya no estaban pero
 * los puertos seguían con su VLAN puesta.
 *
 * Lo que NO toca, nunca:
 *
 *   - un puerto con abonados: quitarle la VLAN deja un alta ahí sin poder
 *     deducir su segmento
 *   - un bloque con direcciones entregadas: borrarlo se las lleva puestas
 *   - la VLAN en el equipo: puede estar llevando tráfico de otro puerto
 *
 * Por eso se revisa antes y se informa qué se va a saltear, en vez de negarse
 * entero: limpiar nueve puertos y dejar siete es lo correcto, y trabar los
 * dieciséis por siete sería inútil.
 */
export async function deshacerEsquema(oltId, { slot, desdePuerto = 0, hastaPuerto, aplicar = false }) {
  const olt = await cargarOlt(oltId)
  const s = Number(slot)
  const p0 = Number(desdePuerto)
  const p1 = Number(hastaPuerto)

  if (!Number.isInteger(s)) throw badRequest('Falta la placa')
  if (!Number.isInteger(p0) || !Number.isInteger(p1) || p1 < p0) {
    throw badRequest('El rango de puertos no es válido')
  }

  const [{ data: puertos }, { data: onus }] = await Promise.all([
    db()
      .from('puertos_pon')
      .select('slot, puerto, vlan')
      .eq('olt_id', oltId)
      .eq('slot', s)
      .gte('puerto', p0)
      .lte('puerto', p1)
      .not('vlan', 'is', null),
    db().from('onus').select('slot, puerto').eq('olt_id', oltId).eq('slot', s),
  ])

  const abonadosDe = new Map()
  for (const o of onus ?? []) {
    const k = `${o.slot}/${o.puerto}`
    abonadosDe.set(k, (abonadosDe.get(k) ?? 0) + 1)
  }

  const filas = []
  for (const p of puertos ?? []) {
    const abonados = abonadosDe.get(`${p.slot}/${p.puerto}`) ?? 0

    // Los bloques de esa VLAN, con cuántas direcciones tienen entregadas.
    const { data: subredes } = await db()
      .from('subredes')
      .select('id, nombre, cidr, pool_router, router_id')
      .eq('vlan', p.vlan)
      .eq('olt_id', oltId)

    const bloques = []
    for (const sub of subredes ?? []) {
      const { count } = await db()
        .from('ip_addresses')
        .select('id', { count: 'exact', head: true })
        .eq('subred_id', sub.id)
        .neq('estado', 'libre')
      bloques.push({ ...sub, entregadas: count ?? 0 })
    }

    filas.push({
      slot: p.slot,
      puerto: p.puerto,
      etiqueta: `${p.slot}/${p.puerto}`,
      vlan: p.vlan,
      abonados,
      bloques,
      // El puerto se limpia solo si nadie cuelga de él.
      se_quita_la_vlan: abonados === 0,
      // Y cada bloque solo si no entregó nada.
      bloques_a_borrar: abonados === 0 ? bloques.filter((b) => !b.entregadas) : [],
      motivo:
        abonados > 0
          ? `Tiene ${abonados} abonados: se deja como está`
          : bloques.some((b) => b.entregadas)
            ? 'Algún bloque tiene direcciones entregadas: se deja'
            : null,
    })
  }

  const resumen = {
    puertos: filas.length,
    se_limpian: filas.filter((f) => f.se_quita_la_vlan).length,
    se_dejan: filas.filter((f) => !f.se_quita_la_vlan).length,
    bloques: filas.reduce((n, f) => n + f.bloques_a_borrar.length, 0),
  }

  if (!aplicar) return { olt: { id: olt.id, nombre: olt.nombre }, filas, resumen }

  const hecho = { puertos: 0, bloques: 0, pools: 0, fallos: [] }
  const equipo = filas.some((f) => f.bloques_a_borrar.some((b) => b.router_id))
    ? await cargarRouter(filas.flatMap((f) => f.bloques_a_borrar).find((b) => b.router_id).router_id)
    : null

  for (const f of filas.filter((x) => x.se_quita_la_vlan)) {
    for (const b of f.bloques_a_borrar) {
      // El pool primero: si se borra la subred antes, se pierde su nombre y el
      // pool queda huérfano en el router — que es justo el estado del que
      // venimos.
      if (equipo && b.pool_router) {
        try {
          const pools = await mk.listarPools(equipo)
          const pool = pools.find((p) => p.name === b.pool_router)
          if (pool) {
            await mk.borrarPool(equipo, pool['.id'] ?? pool.id)
            hecho.pools++
          }
        } catch (e) {
          hecho.fallos.push(`pool ${b.pool_router}: ${e.message}`)
        }
      }

      const { error } = await db().from('subredes').delete().eq('id', b.id)
      if (error) hecho.fallos.push(`bloque ${b.cidr}: ${error.message}`)
      else hecho.bloques++
    }

    try {
      await desasignarPuerto(oltId, { slot: f.slot, puerto: f.puerto })
      hecho.puertos++
    } catch (e) {
      hecho.fallos.push(`puerto ${f.etiqueta}: ${e.message}`)
    }
  }

  return {
    olt: { id: olt.id, nombre: olt.nombre },
    filas,
    resumen,
    ...hecho,
    // La VLAN sigue en el equipo a propósito: puede estar llevando tráfico de
    // otro puerto, y borrarla dejaría a esos abonados sin salida.
    nota: 'Las VLANs siguen creadas en la OLT. Se borran desde VLANs → Borrar varias, que se niega si tienen abonados.',
  }
}

const rangoDe = (cidr) => {
  const [dir, bitsTexto] = String(cidr ?? '').split('/')
  const base = aEntero(dir)
  const bits = Number(bitsTexto)
  if (base == null || !Number.isInteger(bits)) return { desde: null, hasta: null }
  const tamano = tamanoDe(bits)
  const red = base - (base % tamano)
  return { desde: red, hasta: red + tamano - 1 }
}

/**
 * Crear de verdad lo que el plan dice.
 *
 * Se aplica fila por fila y se informa cada una: si la novena falla, las ocho
 * anteriores quedaron creadas y hay que poder verlo. Deshacerlas
 * automáticamente sería peor —borrar subredes que quizás ya tienen abonados
 * adentro— así que se informa y se decide afuera.
 *
 * Las filas con un aviso grave no se tocan: son las que solapan con algo que ya
 * existe.
 */
export async function aplicarEsquema(
  oltId,
  {
    filas,
    routerId = null,
    crearEnElEquipo = true,
    // El pool en el MikroTik. Es como este ISP ya tiene la MA5608T —uno por
    // puerto, con el mismo nombre que la subred— y es lo que hace que el alta
    // pueda sacar la siguiente dirección libre sin que nadie escriba el rango.
    crearPool = true,
    // La dirección del router dentro del bloque. Requiere que la interfaz VLAN
    // ya exista en el MikroTik: crearla no está en la API de este sistema.
    interfaz = '',
    tipo = 'estatica',
  },
) {
  if (!filas?.length) throw badRequest('No hay nada que crear')

  const olt = await cargarOlt(oltId)
  const equipo = routerId ? await cargarRouter(routerId) : null
  const resultados = []

  // Las VLANs que falten en el equipo, todas juntas: son un solo viaje de SSH en
  // vez de dieciséis.
  const aCrear = crearEnElEquipo
    ? filas.filter((f) => f.avisos?.some((a) => a.crear_vlan)).map((f) => f.vlan)
    : []

  let vlansCreadas = null
  if (aCrear.length) {
    vlansCreadas = await crearVlans(oltId, {
      vlans: aCrear,
      descripcion: `Esquema por puerto placa ${filas[0]?.slot ?? ''}`.trim(),
    })
  }

  for (const f of filas) {
    if (f.avisos?.some((a) => a.grave)) {
      resultados.push({ puerto: f.puerto, vlan: f.vlan, hecho: false, motivo: 'tiene avisos graves' })
      continue
    }

    const avisos = []

    try {
      // El pool primero. Si falla, la subred se crea igual pero sin apuntar a un
      // pool que no existe: un `pool_router` que no está en el router hace que
      // el alta se corte pidiendo una dirección de la nada.
      let pool = null
      if (equipo && crearPool) {
        try {
          await mk.crearPool(equipo, {
            name: f.nombre,
            ranges: f.rango,
            comment: `PON ${f.slot}/${f.puerto} · VLAN ${f.vlan} · ${olt.nombre}`,
          })
          pool = f.nombre
        } catch (e) {
          avisos.push(`no se pudo crear el pool: ${e.message}`)
        }
      }

      const { data: subred, error } = await db()
        .from('subredes')
        .insert({
          nombre: f.nombre,
          cidr: f.cidr,
          // El tipo lo decide el propio esquema cuando es PPPoE: el bloque lo
          // reparte el router al autenticar, y llamarlo "estática" haría que la
          // pantalla de redes lo trate como uno que se asigna a mano.
          tipo: f.pppoe ? 'pool_pppoe' : tipo,
          gateway: f.gateway,
          vlan: f.vlan,
          olt_id: oltId,
          router_id: routerId,
          pool_router: pool,
          notas: `Puerto PON ${f.slot ?? ''}/${f.puerto} de ${olt.nombre}. Rango para abonados: ${f.rango}.`,
        })
        .select('id, nombre, cidr')
        .single()

      if (error) throw new Error(error.message)

      await anotarVlan(oltId, f.vlan, { descripcion: `PON ${f.puerto}`, uso: 'internet' })
      await asignarPuerto(oltId, {
        slot: f.slot,
        puerto: f.puerto,
        vlan: f.vlan,
        descripcion: `PON ${f.puerto}`,
      })

      // La dirección del router. Va última porque es la única que puede fallar
      // por algo ajeno a nosotros —que la interfaz VLAN no exista todavía— y no
      // tiene sentido que eso impida cargar el bloque.
      //
      // En PPPoE no va: el bloque no vive en ninguna interfaz. Poner el /25 en
      // la VLAN crearía una red conectada que nadie usa —el gateway del abonado
      // es el local-address del perfil— y haría creer al router que puede llegar
      // a esas direcciones por ARP, que es justo lo que no pasa.
      if (equipo && interfaz && !f.pppoe) {
        const nombreIfaz = interfaz.replace(/\{vlan\}/g, String(f.vlan)).replace(/\{puerto\}/g, String(f.puerto))
        try {
          await mk.crearDireccion(equipo, {
            address: `${f.gateway}/${f.cidr.split('/')[1]}`,
            interface: nombreIfaz,
            comment: `PON ${f.slot}/${f.puerto} · ${olt.nombre}`,
          })
        } catch (e) {
          avisos.push(`no se pudo poner ${f.gateway} en ${nombreIfaz}: ${e.message}`)
        }
      }

      resultados.push({
        puerto: f.puerto,
        vlan: f.vlan,
        hecho: true,
        subred_id: subred.id,
        cidr: subred.cidr,
        pool,
        ...(avisos.length ? { avisos } : {}),
      })
    } catch (e) {
      resultados.push({ puerto: f.puerto, vlan: f.vlan, hecho: false, motivo: e.message, ...(avisos.length ? { avisos } : {}) })
    }
  }

  return {
    // Para que la pantalla sepa qué falta después: en PPPoE hace falta la
    // interfaz y el servidor; en el otro modo, el gateway.
    pppoe: filas.some((f) => f.pppoe),
    creadas: resultados.filter((r) => r.hecho).length,
    omitidas: resultados.filter((r) => !r.hecho).length,
    pools: resultados.filter((r) => r.pool).length,
    // Lo que quedó a medias. Se cuenta aparte de las omitidas: una subred creada
    // sin su pool no es un fracaso, pero tampoco está terminada.
    con_avisos: resultados.filter((r) => r.avisos?.length).length,
    vlans_en_el_equipo: vlansCreadas,
    resultados,
  }
}
