import { db, cargarOlt } from '../lib/db.js'
import { badRequest, AppError } from '../lib/errors.js'
import * as olts from './oltService.js'

/**
 * Las VLANs de una OLT: las que tiene el equipo, más lo que el ISP sabe de ellas.
 *
 * La existencia de una VLAN la dice el equipo. Para qué se usa y de qué puerto
 * PON es la predeterminada no puede decirlo: eso es una convención del ISP, y
 * las convenciones que no están escritas se aplican mal el día que las aplica
 * otra persona.
 *
 * Todo esto existe para un objetivo concreto: que el técnico en la calle no
 * tenga que elegir el segmento de red del abonado. La cadena es
 *
 *     la ONT apareció en la placa 6 puerto 4
 *        → ese puerto usa la VLAN 204
 *           → esa VLAN es la de la subred 10.20.4.0/24
 */

/** El equipo y nuestra base, cruzados. */
export async function listarVlans(oltId) {
  const olt = await cargarOlt(oltId)

  const [enEquipo, { data: guardadas }, { data: puertos }] = await Promise.all([
    olts.leerVlans(olt),
    db().from('vlans_olt').select('*').eq('olt_id', oltId),
    db().from('puertos_pon').select('slot, puerto, vlan').eq('olt_id', oltId),
  ])

  // De qué puertos es la predeterminada. En plural a propósito: en esta red la
  // 200 es la de los siete puertos con abonados, y decir "la del 6/9" —el
  // último que se anotó— era falso y escondía los otros seis.
  const puertosDeVlan = new Map()
  for (const p of puertos ?? []) {
    if (p.vlan == null) continue
    if (!puertosDeVlan.has(p.vlan)) puertosDeVlan.set(p.vlan, [])
    puertosDeVlan.get(p.vlan).push(p)
  }

  const porVlan = new Map((guardadas ?? []).map((v) => [v.vlan, v]))
  const { data: subredes } = await db().from('subredes').select('*').eq('activo', true)

  // Todas las de cada VLAN, no la última. Una VLAN puede tener varios bloques
  // —cuando uno se llena se agrega otro— y quedarse con uno solo hacía que la
  // pantalla dijera que la 200 es la del 172.18.4.0/24 cuando además hay tres
  // más. Alguien la lee, saca una dirección del bloque equivocado, y el error
  // recién aparece cuando el abonado no navega.
  const porVlanSubred = new Map()
  for (const s of subredes ?? []) {
    if (s.vlan == null) continue
    if (s.olt_id != null && s.olt_id !== oltId) continue
    if (!porVlanSubred.has(s.vlan)) porVlanSubred.set(s.vlan, [])
    porVlanSubred.get(s.vlan).push(s)
  }

  // En qué puertos PON se está usando cada VLAN, de verdad. Es distinto de la
  // predeterminada: esa es la convención —lo que el ISP decidió— y esto es lo
  // que hay puesto en los equipos hoy. Durante una migración de esquema las dos
  // no coinciden, y ver la diferencia es justamente lo que dice cuánto falta.
  const { data: onus } = await db()
    .from('onus')
    .select('vlan, slot, puerto')
    .eq('olt_id', oltId)
    .not('vlan', 'is', null)

  const usoPorVlan = new Map()
  for (const o of onus ?? []) {
    if (o.slot == null || o.puerto == null) continue
    if (!usoPorVlan.has(o.vlan)) usoPorVlan.set(o.vlan, new Map())
    const puertos = usoPorVlan.get(o.vlan)
    const clave = `${o.slot}/${o.puerto}`
    puertos.set(clave, (puertos.get(clave) ?? 0) + 1)
  }

  const enUso = (vlan) =>
    [...(usoPorVlan.get(vlan) ?? new Map())]
      .map(([puerto, abonados]) => ({ puerto, abonados }))
      // Por número de puerto, no alfabético: si no, el 10 va antes que el 2.
      .sort((a, b) => Number(a.puerto.split('/')[1]) - Number(b.puerto.split('/')[1]))

  const filas = enEquipo.map((v) => {
    const meta = porVlan.get(v.vlan)
    const deLaVlan = porVlanSubred.get(v.vlan) ?? []
    const subred = deLaVlan[0] ?? null
    return {
      vlan: v.vlan,
      tipo: v.tipo,
      // Cuántos abonados cuelgan de ella. Es lo que decide si se puede borrar.
      abonados: v.abonados,
      puertos_estandar: v.puertos_estandar,

      descripcion: meta?.descripcion ?? null,
      uso: meta?.uso ?? null,

      // Los puertos de los que es la predeterminada, todos.
      puertos_predeterminados: (puertosDeVlan.get(v.vlan) ?? [])
        .map((p) => ({ slot: p.slot, puerto: p.puerto, etiqueta: `${p.slot}/${p.puerto}` }))
        .sort((a, b) => a.slot - b.slot || a.puerto - b.puerto),

      // En qué PON está puesta hoy, con cuántos abonados en cada uno.
      puertos_en_uso: enUso(v.vlan),

      subred_id: subred?.id ?? null,
      subred: subred?.nombre ?? null,
      cidr: subred?.cidr ?? null,
      // Los demás bloques de la misma VLAN. Se devuelven todos: es la diferencia
      // entre "la 200 es este bloque" y "la 200 la comparten cuatro".
      segmentos: deLaVlan.map((s) => ({
        subred_id: s.id,
        subred: s.nombre,
        cidr: s.cidr,
        gateway: s.gateway,
        pool_router: s.pool_router,
      })),
    }
  })

  // Las que tenemos anotadas y el equipo no tiene. No se esconden: una VLAN
  // asignada a un puerto que ya no existe en la OLT es justo el tipo de cosa
  // que deja una instalación eligiendo un segmento que no lleva a ningún lado.
  const enEquipoSet = new Set(enEquipo.map((v) => v.vlan))
  const huerfanas = (guardadas ?? [])
    .filter((v) => !enEquipoSet.has(v.vlan))
    .map((v) => ({ ...v, motivo: 'está anotada en el sistema pero el equipo no la tiene' }))

  return {
    olt: { id: olt.id, nombre: olt.nombre },
    vlans: filas.sort((a, b) => a.vlan - b.vlan),
    huerfanas,
    resumen: {
      total: filas.length,
      con_abonados: filas.filter((v) => v.abonados > 0).length,
      asignadas_a_puerto: filas.filter((v) => v.puertos_predeterminados.length).length,
      con_subred: filas.filter((v) => v.subred_id).length,
      en_uso: filas.filter((v) => v.puertos_en_uso.length).length,
    },
  }
}

/**
 * Los puertos PON de cada tarjeta, con la VLAN que tienen asignada.
 *
 * Es la misma información que `listarVlans` mirada al revés, y hace falta que
 * exista de las dos formas porque responden preguntas distintas:
 *
 *   por VLAN     "¿dónde se está usando la 200?"
 *   por puerto   "¿qué le falta configurar al 6/12?"
 *
 * La segunda es la que se usa para armar el esquema, y por eso lista TODOS los
 * puertos de todas las placas de servicio, tengan abonados o no. Un puerto vacío
 * es precisamente el que hay que configurar; esconderlo hasta que tenga un
 * cliente es dejar el trabajo para cuando ya hay alguien esperando.
 */
/**
 * Le pregunta al equipo cómo está armado y qué tiene puesto, y lo guarda.
 *
 * Es la parte cara: treinta segundos, casi todos en dos lecturas que describen
 * el HARDWARE —qué placas hay y cuántos puertos tiene cada una— y que no cambian
 * salvo que alguien cambie una tarjeta. Por eso va aparte y a pedido, y la
 * pantalla lee lo guardado.
 *
 * Se guarda TODO puerto que el equipo reporte, tenga abonados o no: un puerto
 * vacío es precisamente el que hay que configurar.
 */
export async function relevarPuertos(oltId) {
  const olt = await cargarOlt(oltId)

  // En serie y no en Promise.all: comparten la misma sesión SSH, así que pedirlas
  // juntas no las hace más rápidas y sí hace más confuso el error cuando una
  // falla.
  const placas = await olts.leerPlacas(olt)
  const deServicio = (placas ?? []).filter((p) => p.servicio)

  const tarjetas = []
  for (const placa of deServicio) {
    const t = await olts.leerPuertosPon(olt, { slot: placa.slot }).catch(() => null)
    for (const x of Array.isArray(t) ? t : [t].filter(Boolean)) tarjetas.push(x)
  }

  const delEquipo = await olts.leerVlansPorPuerto(olt)
  const porPuerto = new Map((delEquipo ?? []).map((p) => [`${p.slot}/${p.puerto}`, p]))

  const ahora = new Date().toISOString()
  const filas = []
  for (const placa of deServicio) {
    const t = tarjetas.find((x) => x?.slot === placa.slot)
    const puertos = (t?.puertos ?? []).map((x) => x.puerto).filter(Number.isFinite)

    for (const puerto of puertos) {
      const eq = porPuerto.get(`${placa.slot}/${puerto}`)
      filas.push({
        olt_id: oltId,
        slot: placa.slot,
        puerto,
        placa: placa.placa ?? null,
        vlans_equipo: eq?.vlans ?? [],
        onts_equipo: eq?.onts ?? 0,
        leido_at: ahora,
      })
    }
  }

  if (!filas.length) {
    throw new AppError('El equipo no reportó ningún puerto PON', {
      status: 502,
      hint: 'Puede ser que no tenga placas de servicio, o que la lectura haya fallado.',
    })
  }

  // Se actualiza sin tocar `vlan` ni `descripcion`: eso es lo que cargó el
  // usuario y un relevamiento no tiene por qué pisarlo.
  const { error } = await db()
    .from('puertos_pon')
    .upsert(filas, { onConflict: 'olt_id,slot,puerto' })
  if (error) throw new AppError(`No se pudo guardar el relevamiento: ${error.message}`, { status: 400 })

  return {
    puertos: filas.length,
    placas: deServicio.map((p) => ({ slot: p.slot, placa: p.placa, puertos: filas.filter((f) => f.slot === p.slot).length })),
    con_service_ports: filas.filter((f) => f.onts_equipo > 0).length,
    leido_at: ahora,
  }
}

export async function listarPuertosConVlan(oltId) {
  const olt = await cargarOlt(oltId)

  const [{ data: asignadas }, { data: subredes }, { data: onus }] = await Promise.all([
    db().from('puertos_pon').select('*').eq('olt_id', oltId),
    db().from('subredes').select('*').eq('activo', true),
    db().from('onus').select('slot, puerto, vlan, estado').eq('olt_id', oltId),
  ])

  const { data: declaradasVlan } = await db()
    .from('vlans_olt')
    .select('vlan, uso, descripcion')
    .eq('olt_id', oltId)

  // Lo relevado del equipo, que ahora vive en la misma fila del puerto.
  const equipoPorPuerto = new Map(
    (asignadas ?? []).map((p) => [
      `${p.slot}/${p.puerto}`,
      { vlans: p.vlans_equipo ?? [], onts: p.onts_equipo ?? 0 },
    ]),
  )


  const porPuerto = new Map((asignadas ?? []).map((a) => [`${a.slot}/${a.puerto}`, a]))
  const usoDeVlan = new Map((declaradasVlan ?? []).map((v) => [v.vlan, v]))

  const porVlanSubred = new Map()
  for (const s of subredes ?? []) {
    if (s.vlan == null) continue
    if (s.olt_id != null && s.olt_id !== oltId) continue
    if (!porVlanSubred.has(s.vlan)) porVlanSubred.set(s.vlan, [])
    porVlanSubred.get(s.vlan).push(s)
  }

  const conteo = new Map()
  for (const o of onus ?? []) {
    if (o.slot == null || o.puerto == null) continue
    const clave = `${o.slot}/${o.puerto}`
    const c = conteo.get(clave) ?? { abonados: 0, online: 0, vlans: new Set() }
    c.abonados++
    if (String(o.estado).toLowerCase() === 'online') c.online++
    if (o.vlan != null) c.vlans.add(o.vlan)
    conteo.set(clave, c)
  }

  // Las placas y sus puertos salen de lo relevado. Si nunca se relevó, se arma
  // con lo que se sabe igual —los puertos donde hay abonados— en vez de mostrar
  // una pantalla vacía: una lista incompleta con el aviso puesto sirve, una
  // vacía hace creer que el equipo no tiene nada.
  const puertosConocidos = new Map()
  for (const p of asignadas ?? []) puertosConocidos.set(`${p.slot}/${p.puerto}`, p)
  for (const k of conteo.keys()) {
    if (!puertosConocidos.has(k)) {
      const [slot, puerto] = k.split('/').map(Number)
      puertosConocidos.set(k, { slot, puerto })
    }
  }

  const porSlot = new Map()
  for (const p of puertosConocidos.values()) {
    if (!porSlot.has(p.slot)) porSlot.set(p.slot, [])
    porSlot.get(p.slot).push(p)
  }

  const relevado = (asignadas ?? []).filter((p) => p.leido_at)
  const ultimoRelevo = relevado.length
    ? relevado.map((p) => p.leido_at).sort().at(-1)
    : null

  const resultado = [...porSlot.keys()]
    .sort((a, b) => a - b)
    .map((slot) => ({
      slot,
      placa: porSlot.get(slot).find((p) => p.placa)?.placa ?? null,
      estado: null,
      puertos: porSlot
        .get(slot)
        .map((x) => x.puerto)
        .sort((a, b) => a - b)
        .map((puerto) => {
        const clave = `${slot}/${puerto}`
        const meta = porPuerto.get(clave)
        const c = conteo.get(clave)
        const segmentos = meta?.vlan != null ? (porVlanSubred.get(meta.vlan) ?? []) : []

        return {
          slot,
          puerto,
          etiqueta: `${slot}/${puerto}`,
          vlan: meta?.vlan ?? null,
          descripcion: meta?.descripcion ?? usoDeVlan.get(meta?.vlan)?.descripcion ?? null,
          uso: usoDeVlan.get(meta?.vlan)?.uso ?? null,

          segmentos: segmentos.map((s) => ({
            subred_id: s.id,
            subred: s.nombre,
            cidr: s.cidr,
            gateway: s.gateway,
            pool_router: s.pool_router,
          })),

          abonados: c?.abonados ?? 0,
          online: c?.online ?? 0,

          // Lo que el EQUIPO tiene puesto en ese puerto, con cuántos
          // service-ports lleva cada VLAN. Es la fuente buena: nuestra base
          // guarda una sola VLAN por ONU y así se pierde la de gestión.
          //
          // Cada una viene marcada con si es de abonados o no. La de gestión
          // convive con la de internet en todos los puertos y siempre va a estar
          // ahí: contarla como "distinta de la asignada" dejaba a los siete
          // puertos marcados como a medio migrar de forma permanente, y un aviso
          // que está siempre encendido es un aviso que nadie mira.
          vlans_del_equipo: (equipoPorPuerto.get(clave)?.vlans ?? []).map((v) => ({
            ...v,
            de_servicio: esDeServicio(usoDeVlan.get(v.vlan)?.uso),
          })),
          onts_del_equipo: equipoPorPuerto.get(clave)?.onts ?? 0,

          // Las que conocemos por nuestras ONUs. Se conserva porque es lo que
          // hay cuando el equipo no contesta.
          vlans_en_uso: [...(c?.vlans ?? [])].sort((a, b) => a - b),

          // Lo que falta para que una instalación en este puerto se resuelva
          // sola. Se dice acá y no en la pantalla porque es la misma regla que
          // aplica el alta, y tenerla en dos lados es tenerla distinta.
          listo: meta?.vlan != null && segmentos.length > 0,
          leido_at: meta?.leido_at ?? null,
        }
      }),
    }))

  const todos = resultado.flatMap((p) => p.puertos)

  // Las que el equipo tiene y nadie declaró para qué son. Salen acá porque es
  // donde se las va a ver: una VLAN pasando por los puertos sin que el sistema
  // sepa qué es no se descubre hasta que alguien la saca de un troncal.
  const declaradas = new Set((declaradasVlan ?? []).map((a) => a.vlan))
  const sinDeclarar = new Set()
  for (const p of todos) {
    for (const v of p.vlans_del_equipo) if (!declaradas.has(v.vlan)) sinDeclarar.add(v.vlan)
  }

  return {
    olt: { id: olt.id, nombre: olt.nombre },
    placas: resultado,
    // Cuándo se relevó por última vez. Null = nunca, que no es lo mismo que
    // "el equipo no tiene nada": mostrar los dos casos igual haría que alguien
    // concluyera que una OLT recién cargada está vacía.
    relevado_at: ultimoRelevo,
    equipo_leido: ultimoRelevo != null,
    vlans_del_equipo_leidas: ultimoRelevo != null,
    vlans_sin_declarar: [...sinDeclarar].sort((a, b) => a - b),
    resumen: {
      puertos: todos.length,
      con_vlan: todos.filter((p) => p.vlan != null).length,
      listos: todos.filter((p) => p.listo).length,
      con_abonados: todos.filter((p) => p.abonados > 0).length,
      // Puertos donde el equipo pasa una VLAN DE ABONADOS distinta de la
      // asignada. Durante una migración de esquema, esto es cuánto falta.
      //
      // Las que no llevan abonados no cuentan: la de gestión está en todos los
      // puertos por diseño y no es un resto de nada.
      a_medio_migrar: todos.filter(
        (p) =>
          p.vlan != null &&
          p.vlans_del_equipo.some((v) => v.vlan !== p.vlan && v.de_servicio !== false),
      ).length,
    },
  }
}

/**
 * Trae al sistema lo que el equipo ya tiene: qué VLAN usa cada puerto PON.
 *
 * No toca la OLT. Lee sus service-ports y escribe nuestras anotaciones, que es
 * exactamente lo que alguien haría a mano puerto por puerto — con la ventaja de
 * que el equipo no se equivoca al transcribir.
 *
 * Lo delicado es elegir CUÁL VLAN es la del puerto cuando tiene varias. Acá cada
 * ONT está en dos: la de internet y la de gestión. Se descarta la que esté
 * declarada como no-abonados y se elige la que más service-ports tenga. Cuando
 * quedan dos candidatas empatadas NO se elige: se informa, porque una
 * predeterminada equivocada manda al abonado al segmento de otro y eso no se
 * nota hasta el reclamo.
 */
export async function importarVlansDePuertos(oltId, { aplicar = false, sobrescribir = false } = {}) {
  const olt = await cargarOlt(oltId)

  const [delEquipo, { data: yaAnotadas }, { data: yaAsignados }] = await Promise.all([
    olts.leerVlansPorPuerto(olt),
    db().from('vlans_olt').select('*').eq('olt_id', oltId),
    db().from('puertos_pon').select('slot, puerto, vlan').eq('olt_id', oltId),
  ])

  const usoDe = new Map((yaAnotadas ?? []).map((a) => [a.vlan, a.uso]))
  const asignadaEn = new Map(
    (yaAsignados ?? []).filter((a) => a.vlan != null).map((a) => [`${a.slot}/${a.puerto}`, a.vlan]),
  )

  const propuestas = []
  for (const p of delEquipo) {
    const clave = `${p.slot}/${p.puerto}`
    const candidatas = p.vlans.filter((v) => esDeServicio(usoDe.get(v.vlan)) !== false)

    const base = {
      slot: p.slot,
      puerto: p.puerto,
      etiqueta: clave,
      vlans_del_equipo: p.vlans,
      ya_asignada: asignadaEn.get(clave) ?? null,
    }

    if (!candidatas.length) {
      propuestas.push({
        ...base,
        vlan: null,
        motivo: p.vlans.length
          ? 'Todas las VLANs de ese puerto están declaradas como que no llevan abonados'
          : 'El puerto no tiene service-ports',
      })
      continue
    }

    const orden = [...candidatas].sort((a, b) => b.service_ports - a.service_ports)
    if (orden.length > 1 && orden[0].service_ports === orden[1].service_ports) {
      propuestas.push({
        ...base,
        vlan: null,
        motivo:
          `Hay ${orden.length} VLANs con la misma cantidad de service-ports ` +
          `(${orden.map((v) => v.vlan).join(', ')}): no se puede saber cuál es la del puerto`,
      })
      continue
    }

    const elegida = orden[0].vlan
    const yaEstaba = asignadaEn.get(clave)

    propuestas.push({
      ...base,
      vlan: elegida,
      service_ports: orden[0].service_ports,
      // Sin cambio, cambio, o conflicto con lo que ya hay cargado.
      estado:
        yaEstaba == null ? 'nueva' : yaEstaba === elegida ? 'igual' : 'distinta',
      ...(yaEstaba != null && yaEstaba !== elegida
        ? {
            motivo: `El sistema tiene la ${yaEstaba} y el equipo usa la ${elegida}`,
          }
        : {}),
    })
  }

  const aEscribir = propuestas.filter(
    (p) => p.vlan != null && (p.estado === 'nueva' || (p.estado === 'distinta' && sobrescribir)),
  )

  if (!aplicar) {
    return {
      olt: { id: olt.id, nombre: olt.nombre },
      propuestas,
      resumen: resumirImportacion(propuestas, aEscribir),
    }
  }

  const resultados = []
  for (const p of aEscribir) {
    try {
      // La VLAN se anota una vez —para qué sirve— y el puerto aparte. Son dos
      // tablas porque son dos hechos distintos, y meterlos juntos era lo que
      // hacía que siete puertos con la misma VLAN quedaran en uno.
      if (!usoDe.has(p.vlan)) {
        await anotarVlan(oltId, p.vlan, { uso: 'internet', descripcion: 'Traída del equipo' })
        usoDe.set(p.vlan, 'internet')
      }
      await asignarPuerto(oltId, {
        slot: p.slot,
        puerto: p.puerto,
        vlan: p.vlan,
        descripcion: `PON ${p.puerto}`,
      })
      resultados.push({ puerto: p.etiqueta, vlan: p.vlan, hecho: true })
    } catch (e) {
      resultados.push({ puerto: p.etiqueta, vlan: p.vlan, hecho: false, motivo: e.message })
    }
  }

  return {
    olt: { id: olt.id, nombre: olt.nombre },
    propuestas,
    resultados,
    importadas: resultados.filter((r) => r.hecho).length,
    fallidas: resultados.filter((r) => !r.hecho).length,
    resumen: resumirImportacion(propuestas, aEscribir),
  }
}

const resumirImportacion = (propuestas, aEscribir) => ({
  puertos: propuestas.length,
  se_pueden_traer: aEscribir.length,
  ya_estaban_igual: propuestas.filter((p) => p.estado === 'igual').length,
  distintas: propuestas.filter((p) => p.estado === 'distinta').length,
  sin_resolver: propuestas.filter((p) => p.vlan == null).length,
})

/**
 * Le quita a un puerto su VLAN predeterminada, sin borrar la VLAN.
 *
 * Son cosas distintas y confundirlas es caro: quitar la anotación no toca el
 * equipo ni deja a nadie sin servicio; borrar la VLAN sí. Acá solo se olvida de
 * qué puerto era.
 */
export async function desasignarPuerto(oltId, { slot, puerto }) {
  const { data, error } = await db()
    .from('puertos_pon')
    .update({ vlan: null, updated_at: new Date().toISOString() })
    .eq('olt_id', oltId)
    .eq('slot', Number(slot))
    .eq('puerto', Number(puerto))
    .select()
    .maybeSingle()

  if (error) throw new AppError(error.message, { status: 400 })
  if (!data) throw badRequest(`El puerto ${slot}/${puerto} no está anotado en esta OLT`)
  return data
}

/** Crea VLANs en el equipo y las anota. */
export async function crearVlans(oltId, { vlans, descripcion, uso = 'internet' }) {
  const lista = normalizarLista(vlans)
  if (!lista.length) throw badRequest('No se indicó ninguna VLAN')

  const olt = await cargarOlt(oltId)
  const r = await olts.crearVlans(olt, lista)

  // Se anotan las que quedaron en el equipo, creadas ahora o de antes. Anotar
  // una que falló dejaría al sistema ofreciendo una VLAN inexistente.
  const enEquipo = [...r.creadas, ...r.yaEstaban]
  if (enEquipo.length) {
    await db()
      .from('vlans_olt')
      .upsert(
        enEquipo.map((v) => ({ olt_id: oltId, vlan: v, descripcion: descripcion ?? null, uso })),
        { onConflict: 'olt_id,vlan' },
      )
  }

  return r
}

/** Borra VLANs del equipo y de nuestra base. */
export async function borrarVlans(oltId, { vlans, forzar = false }) {
  const lista = normalizarLista(vlans)
  if (!lista.length) throw badRequest('No se indicó ninguna VLAN')

  const olt = await cargarOlt(oltId)
  const r = await olts.borrarVlans(olt, lista, { forzar })

  // Solo se olvida lo que se borró de verdad. Borrar la anotación de una VLAN
  // que sigue en el equipo la volvería invisible para el sistema.
  const idas = [...r.borradas, ...r.noEstaban]
  if (idas.length) {
    await db().from('vlans_olt').delete().eq('olt_id', oltId).in('vlan', idas)
  }

  return r
}

/**
 * Anota para qué sirve una VLAN y de qué puerto es la predeterminada.
 *
 * Es lo único de esta pantalla que no toca el equipo: son datos del ISP sobre
 * VLANs que ya existen.
 */
export async function anotarVlan(oltId, vlan, { descripcion, uso }) {
  const { data, error } = await db()
    .from('vlans_olt')
    .upsert(
      {
        olt_id: oltId,
        vlan: Number(vlan),
        descripcion: descripcion ?? null,
        uso: uso ?? 'internet',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'olt_id,vlan' },
    )
    .select()
    .maybeSingle()

  if (error) throw new AppError(error.message, { status: 400 })
  return data
}

/**
 * Qué VLAN usa un puerto PON por defecto.
 *
 * Vive aparte de `anotarVlan` porque son dos cosas distintas: aquélla dice para
 * qué sirve una VLAN, y ésta de qué puerto es. Tenerlas juntas hacía que anotar
 * la 200 en siete puertos escribiera siete veces la misma fila y quedara una.
 */
export async function asignarPuerto(oltId, { slot, puerto, vlan, descripcion }) {
  if (slot == null || puerto == null) {
    throw badRequest('La placa y el puerto van juntos', {
      hint: 'Con uno solo no se sabe de qué puerto se está hablando.',
    })
  }

  const { data, error } = await db()
    .from('puertos_pon')
    .upsert(
      {
        olt_id: oltId,
        slot: Number(slot),
        puerto: Number(puerto),
        vlan: vlan === '' || vlan == null ? null : Number(vlan),
        descripcion: descripcion ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'olt_id,slot,puerto' },
    )
    .select()
    .maybeSingle()

  if (error) throw new AppError(error.message, { status: 400 })
  return data
}

/**
 * Asigna VLANs correlativas a los puertos de una placa.
 *
 * Es la convención más común —puerto 1 la 201, puerto 2 la 202— y hacerla a
 * mano dieciséis veces es donde aparece el error de tipeo que después manda a
 * un abonado al segmento de otro.
 */
export async function asignarCorrelativas(oltId, { slot, desdePuerto, hastaPuerto, desdeVlan }) {
  if ([slot, desdePuerto, hastaPuerto, desdeVlan].some((x) => x == null || x === '')) {
    throw badRequest('Faltan datos: placa, rango de puertos y VLAN inicial')
  }

  const filas = []
  const vlansUsadas = new Set()
  for (let p = Number(desdePuerto), v = Number(desdeVlan); p <= Number(hastaPuerto); p++, v++) {
    filas.push({
      olt_id: oltId,
      slot: Number(slot),
      puerto: p,
      vlan: v,
      descripcion: `Puerto PON ${slot}/${p}`,
      updated_at: new Date().toISOString(),
    })
    vlansUsadas.add(v)
  }

  // Para qué sirve cada VLAN va en su tabla; de qué puerto es, en la otra. Con
  // las dos cosas juntas, asignar la misma VLAN a varios puertos escribía una
  // sola fila y los demás puertos quedaban sin nada.
  const { error: eVlans } = await db()
    .from('vlans_olt')
    .upsert(
      [...vlansUsadas].map((v) => ({ olt_id: oltId, vlan: v, uso: 'internet' })),
      { onConflict: 'olt_id,vlan', ignoreDuplicates: true },
    )
  if (eVlans) throw new AppError(`No se pudo anotar las VLANs: ${eVlans.message}`, { status: 400 })

  const { error } = await db()
    .from('puertos_pon')
    .upsert(filas, { onConflict: 'olt_id,slot,puerto' })
  if (error) throw new AppError(`No se pudo asignar: ${error.message}`, { status: 400 })

  return { asignadas: filas.length, desde: filas[0], hasta: filas[filas.length - 1] }
}

/**
 * Qué segmento de red le toca a una ONT según dónde apareció.
 *
 * Es la razón de ser de todo lo anterior. Devuelve el motivo cuando la cadena
 * se corta, y DICE dónde se cortó: sin eso, el técnico ve un campo vacío y no
 * sabe si es que no hay segmento o si nadie configuró la VLAN de ese puerto.
 */
export async function segmentoDePuerto(oltId, { slot, puerto }) {
  if (slot == null || puerto == null) return null

  const { data } = await db()
    .from('v_vlan_por_puerto')
    .select('*')
    .eq('olt_id', oltId)
    .eq('slot', Number(slot))
    .eq('puerto', Number(puerto))

  if (!data?.length) {
    return {
      encontrado: false,
      motivo: `El puerto ${slot}/${puerto} no tiene VLAN predeterminada asignada`,
      hint: 'Se asigna en la OLT → VLANs. Mientras tanto hay que elegir el segmento a mano.',
    }
  }

  const vlan = data[0].vlan

  // Una VLAN de gestión no lleva abonados. Darle a un cliente una dirección de
  // ahí lo deja sin servicio Y con acceso a la red de administración de las
  // ONTs, que es la peor combinación posible. Se corta acá y se dice por qué.
  if (esDeServicio(data[0].uso) === false) {
    return {
      encontrado: false,
      vlan,
      motivo: `El puerto ${slot}/${puerto} tiene asignada la VLAN ${vlan}, que está declarada como ${data[0].uso}`,
      hint: 'Esa VLAN no lleva abonados. Asignale al puerto una VLAN de internet en la OLT → VLANs.',
    }
  }

  const conSubred = data.filter((f) => !f.sin_subred)

  if (!conSubred.length) {
    return {
      encontrado: false,
      vlan,
      motivo: `El puerto usa la VLAN ${vlan} y ninguna subred está declarada con esa VLAN`,
      hint: 'Se declara en Gestión de red → Redes IPv4, poniéndole la VLAN a la subred.',
    }
  }

  // Una VLAN puede tener más de un bloque: cuando el primero se llena se agrega
  // otro. Como todos sirven a cualquier plan, el criterio es el único que
  // importa: cuál tiene más lugar por delante.
  const [elegido, ...resto] = ordenarPorLugar(conSubred)

  return {
    encontrado: true,
    vlan,
    subred_id: elegido.subred_id,
    subred: elegido.subred,
    cidr: elegido.cidr,
    tipo: elegido.subred_tipo,
    gateway: elegido.gateway,
    pool_router: elegido.pool_router,
    router_id: elegido.router_id,
    router: elegido.router,
    anotadas: elegido.anotadas,
    direcciones_del_bloque: elegido.direcciones_del_bloque,
    ...(resto.length ? { alternativas: resto.map(resumir) } : {}),
  }
}

/**
 * Si de esa VLAN puede salir la dirección de un abonado.
 *
 *   true   internet, o iptv — llevan tráfico de cliente
 *   false  gestion, voip — no
 *   null   nadie la declaró: no se sabe, y no saber no es lo mismo que "no"
 *
 * Se distingue el tercer caso a propósito. Bloquear un alta porque una VLAN no
 * está declarada dejaría al técnico trabado por un dato administrativo que nadie
 * cargó; bloquearla cuando SÍ está declarada como gestión es evitar que el
 * abonado quede sin servicio y adentro de la red de administración.
 */
const esDeServicio = (uso) => {
  if (uso == null) return null
  return uso === 'internet' || uso === 'iptv' || uso === 'otra'
}

/**
 * Los bloques ordenados por lugar libre, el que más tiene primero.
 *
 * `anotadas` cuenta lo que ESTE sistema registró, no lo que el router repartió a
 * mano. Sirve para ordenar; no alcanza para prometer que hay lugar.
 */
const ordenarPorLugar = (bloques) =>
  [...bloques].sort(
    (a, b) =>
      (b.direcciones_del_bloque ?? 0) - (b.anotadas ?? 0) -
      ((a.direcciones_del_bloque ?? 0) - (a.anotadas ?? 0)),
  )

const resumir = (s) => ({
  subred_id: s.subred_id ?? s.id,
  subred: s.subred ?? s.nombre,
  cidr: s.cidr,
  anotadas: s.anotadas,
  direcciones_del_bloque: s.direcciones_del_bloque,
})

/**
 * "200, 201-215, 300" → [200, 201, …, 215, 300]
 *
 * Escribir dieciséis VLANs una por una es donde aparece el número repetido o el
 * salteado, y ninguno de los dos se nota hasta que un abonado queda en el
 * segmento de otro.
 */
export function normalizarLista(entrada) {
  if (Array.isArray(entrada)) {
    return [...new Set(entrada.map(Number).filter(Number.isFinite))]
      .filter((v) => v >= 1 && v <= 4094)
      .sort((a, b) => a - b)
  }

  const salida = new Set()
  for (const trozo of String(entrada ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)) {
    const rango = trozo.match(/^(\d+)\s*-\s*(\d+)$/)
    if (rango) {
      // Un rango al revés —"215-201"— es un tipeo, no una orden de no hacer
      // nada. Se ordena en vez de devolver vacío en silencio.
      const [a, b] = [Number(rango[1]), Number(rango[2])].sort((x, y) => x - y)
      for (let v = a; v <= b; v++) salida.add(v)
      continue
    }
    const n = Number(trozo)
    if (Number.isFinite(n)) salida.add(n)
  }

  return [...salida].filter((v) => v >= 1 && v <= 4094).sort((a, b) => a - b)
}

/**
 * El segmento que le toca a un abonado.
 *
 * La dirección la da DÓNDE está colgada la ONT, no qué plan contrató. En la
 * misma VLAN conviven un abonado de 150 megas y uno de 500: los bloques sirven a
 * todos los planes por igual. El plan decide la velocidad —las traffic tables
 * del service-port— y no interviene acá.
 *
 * Hay dos formas de saber dónde está, y no siempre coinciden:
 *
 *   la VLAN que la ONT TIENE     lo que está puesto en el equipo, ahora mismo
 *   la VLAN que el puerto USA    la convención del ISP para ese puerto PON
 *
 * Cuando difieren gana la primera, porque el tráfico del abonado sale etiquetado
 * con esa y una dirección del otro bloque no le enrutaría. Pero se avisa: que
 * una ONT esté en una VLAN distinta a la de su puerto es algo que alguien tiene
 * que mirar.
 */
export async function segmentoSugerido({ oltId, slot, puerto, sn }) {
  // Lo que ya sabemos de esa serie. Si la ONT está dada de alta trae su VLAN
  // real y en qué puerto quedó, que es todo lo que hace falta.
  const onu = await loQueSabemosDeLaOnu(sn)

  const slotFinal = slot ?? onu?.slot ?? null
  const puertoFinal = puerto ?? onu?.puerto ?? null

  const [porPuerto, porVlan] = await Promise.all([
    slotFinal != null && puertoFinal != null
      ? segmentoDePuerto(oltId, { slot: slotFinal, puerto: puertoFinal })
      : Promise.resolve(null),
    onu?.vlan != null ? segmentoDeVlan(oltId, onu.vlan) : Promise.resolve(null),
  ])

  const p = porPuerto?.encontrado ? porPuerto : null
  const v = porVlan?.encontrado ? porVlan : null

  // De dónde salió cada cosa, para que la pantalla lo pueda decir. Un puerto
  // deducido de la ONU ya dada de alta no es lo mismo que uno que vino en la
  // orden, aunque los dos acierten.
  const origen = {
    ...(onu?.vlan != null ? { vlan_de_la_onu: onu.vlan } : {}),
    ...(slot == null && onu?.slot != null ? { puerto_de_la_onu: `${onu.slot}/${onu.puerto}` } : {}),
  }
  const conOrigen = (r) => ({ ...r, ...(Object.keys(origen).length ? { origen } : {}) })

  if (v && p && v.subred_id !== p.subred_id) {
    return conOrigen({
      ...v,
      por: 'vlan',
      conflicto: {
        motivo: `La ONT está en la VLAN ${v.vlan} y el puerto ${slotFinal}/${puertoFinal} usa la ${p.vlan}`,
        por_vlan: { subred: v.subred, cidr: v.cidr, vlan: v.vlan },
        por_puerto: { subred: p.subred, cidr: p.cidr, vlan: p.vlan },
        hint:
          'Se propone el de la VLAN que la ONT tiene puesta, que es por donde le sale el tráfico. ' +
          'Revisá por qué no coincide con la de su puerto.',
      },
    })
  }

  if (v) return conOrigen(v)
  if (p) return conOrigen({ ...p, por: 'puerto' })

  // Ninguno resolvió. Se devuelve el motivo más útil y —esto es lo que
  // desatasca al técnico— las candidatas que sí sabemos.
  const base = porVlan ??
    porPuerto ?? { encontrado: false, motivo: 'No sabemos en qué puerto ni en qué VLAN está la ONT' }

  return conOrigen(base)
}

/**
 * Qué segmento le toca por la VLAN que la ONU ya tiene puesta.
 *
 * Es la tercera fuente, y la más directa: si la ONT está dada de alta, su
 * service-port dice en qué VLAN está. No hay que deducir nada.
 *
 * Una VLAN puede tener más de un bloque: cuando el primero se llena se agrega
 * otro. Como todos sirven a cualquier plan —en la misma VLAN hay un abonado de
 * 150 megas y uno de 500— no hay nada que los distinga salvo cuánto lugar les
 * queda, y ese es el criterio. Los demás se devuelven igual, por si el elegido
 * no sirve.
 */
export async function segmentoDeVlan(oltId, vlan) {
  if (vlan == null) return { encontrado: false, motivo: 'La ONU no tiene VLAN conocida' }

  // Igual que en el puerto: si esa VLAN está declarada como de gestión o de
  // VoIP, no es de donde sale la IP de un abonado. Una ONT puede estar en dos
  // VLANs a la vez —la de internet y la de gestión— y quedarse con la
  // equivocada es dar de alta al cliente en la red de administración.
  const { data: declarada } = await db()
    .from('vlans_olt')
    .select('uso')
    .eq('olt_id', oltId)
    .eq('vlan', vlan)
    .maybeSingle()

  if (declarada && esDeServicio(declarada.uso) === false) {
    return {
      encontrado: false,
      vlan,
      motivo: `La VLAN ${vlan} está declarada como ${declarada.uso}: no lleva abonados`,
      hint: 'Buscá en qué VLAN de internet está la ONT, o revisá la asignación del puerto.',
    }
  }

  const { data } = await db().from('subredes').select('*').eq('vlan', vlan).eq('activo', true)

  if (!data?.length) {
    return {
      encontrado: false,
      vlan,
      motivo: `Ninguna subred está declarada con la VLAN ${vlan}`,
      hint: 'Se declara en Gestión de red → Redes IPv4.',
    }
  }

  // Un bloque de otra OLT le daría al abonado una dirección que no enruta desde
  // donde está colgado. Los que no declaran OLT sirven para cualquiera.
  const propias = data.filter((s) => s.olt_id === oltId || s.olt_id == null)
  const candidatas = propias.length ? propias : data

  const [elegido, ...resto] = ordenarPorLugar(await conOcupacion(candidatas))

  return {
    encontrado: true,
    por: 'vlan',
    vlan,
    subred_id: elegido.subred_id,
    subred: elegido.subred,
    cidr: elegido.cidr,
    tipo: elegido.tipo,
    gateway: elegido.gateway,
    pool_router: elegido.pool_router,
    router_id: elegido.router_id,
    anotadas: elegido.anotadas,
    direcciones_del_bloque: elegido.direcciones_del_bloque,
    ...(resto.length ? { alternativas: resto.map(resumir) } : {}),
  }
}

/**
 * Les agrega cuánto hay anotado adentro y cuánto entra.
 *
 * Se cuenta acá y no en la consulta porque las subredes vienen de una tabla y la
 * ocupación de otra; hacerlo en dos pasos evita depender de una vista que habría
 * que rehacer cada vez que la tabla cambia una columna.
 */
async function conOcupacion(subredes) {
  const ids = subredes.map((s) => s.id)
  const { data } = await db().from('ip_addresses').select('subred_id').in('subred_id', ids)

  const cuenta = new Map()
  for (const { subred_id } of data ?? []) cuenta.set(subred_id, (cuenta.get(subred_id) ?? 0) + 1)

  return subredes.map((s) => {
    const bits = Number(String(s.cidr ?? '').split('/')[1])
    return {
      ...s,
      subred_id: s.id,
      subred: s.nombre,
      anotadas: cuenta.get(s.id) ?? 0,
      direcciones_del_bloque: Number.isFinite(bits) && bits <= 30 ? 2 ** (32 - bits) - 2 : null,
    }
  })
}

/**
 * Lo que el sistema ya sabe de esa serie: dónde está y en qué VLAN.
 *
 * Si la ONT está dada de alta, esto ahorra toda la deducción. Y sirve además
 * para recuperar el PLAN cuando la orden lo perdió — que es exactamente lo que
 * pasa cuando alguien reemplaza el catálogo de planes y las órdenes viejas
 * quedan apuntando a uno que ya no existe.
 */
export async function loQueSabemosDeLaOnu(sn) {
  if (!sn) return null

  const { data } = await db()
    .from('onus')
    .select('id, sn, olt_id, slot, puerto, vlan, plan_id, plan_velocidad')
    .eq('sn', sn)
    .maybeSingle()

  return data ?? null
}
