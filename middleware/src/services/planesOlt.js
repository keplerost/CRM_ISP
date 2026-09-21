import { db } from '../lib/db.js'
import { badRequest, AppError } from '../lib/errors.js'
import * as olts from './oltService.js'

/**
 * Los planes contra la realidad del equipo.
 *
 * Un plan guarda dos índices de traffic table —uno por sentido— y esos índices
 * tienen que existir en la OLT. Si no existen, el alta del abonado falla en el
 * peor momento: la ONT queda registrada y sin pasar tráfico, con el técnico ya
 * bajado de la escalera.
 *
 * Se descubrió con datos reales: dos de los tres planes cargados apuntaban a
 * las tablas 30 y 50, que no existen. Alguien había escrito el número del plan
 * en vez del índice.
 */

/** Cuánto vale de verdad un plan, según lo que dice el equipo. */
const describir = (t) =>
  t == null
    ? null
    : t.sin_limite
      ? 'sin límite'
      : `${t.mbps} Mbps${t.cir_kbps !== t.pir_kbps ? ` (garantizado ${Math.round(t.cir_kbps / 1000)})` : ''}`

/**
 * Comprueba los índices de todos los planes contra una OLT.
 *
 * Devuelve, para cada plan, si sus tablas existen y qué velocidad aplican de
 * verdad. Lo segundo importa tanto como lo primero: un plan llamado "100M" que
 * apunta a una tabla de 1 Gbps no limita nada, y desde el nombre no se nota.
 */
export async function verificarPlanes(oltId, { guardar = false } = {}) {
  const olt = await (await import('../lib/db.js')).cargarOlt(oltId)
  // Con nombre: hace falta para encontrar la tabla hermana de un plan que solo
  // tenga el índice viejo. Sin el nombre, "12" no sabe que su pareja es "13".
  const tablas = await olts.leerTrafficTables(olt, { conNombre: true, hasta: 63 })
  const porIndice = new Map(tablas.map((t) => [t.index, t]))

  /**
   * La otra mitad del par, buscada por el nombre.
   *
   * Las tablas del equipo se llaman PLAN_HOME-DOWN y PLAN_HOME-UP. Con eso, un
   * plan que solo tiene guardado el índice de bajada puede recuperar el de
   * subida sin que nadie lo adivine.
   */
  const hermana = (t) => {
    const m = String(t?.nombre ?? '').match(/^(.*?)[-_](UP|DOWN)$/i)
    if (!m) return null
    const opuesto = /UP/i.test(m[2]) ? 'DOWN' : 'UP'
    return tablas.find((x) => new RegExp(`^${m[1]}[-_]${opuesto}$`, 'i').test(x.nombre ?? ''))
  }

  const { data: planes, error } = await db()
    .from('planes_velocidad')
    .select('*')
    .order('bajada_kbps')

  if (error) throw new AppError(`No se pudieron leer los planes: ${error.message}`, { status: 500 })

  const revisados = []

  for (const p of planes ?? []) {
    const bajada = p.traffic_table_bajada ?? p.traffic_table_index

    // Un plan que arrastra el índice viejo tiene UN número para los dos
    // sentidos. Copiarlo a ambos y darlo por verificado —que es lo que hacía
    // esto— convierte una suposición en un dato comprobado: con tablas
    // asimétricas, el abonado termina subiendo a la velocidad de bajada y el
    // sistema jura que lo revisó.
    //
    // Se busca la hermana por el nombre. Si no aparece, se deja en null y sale
    // como problema, que es lo honesto.
    let subida = p.traffic_table_subida
    let subidaDeducida = false
    if (subida == null && bajada != null) {
      const par = hermana(porIndice.get(bajada))
      if (par) {
        subida = par.index
        subidaDeducida = true
      }
    }

    const tSubida = subida == null ? null : porIndice.get(subida) ?? false
    const tBajada = bajada == null ? null : porIndice.get(bajada) ?? false

    const problemas = []
    if (bajada == null) {
      problemas.push('no tiene índices de traffic table: no se puede aplicar velocidad en la OLT')
    } else if (subida == null) {
      problemas.push(
        `solo tiene un índice (${bajada}) y el equipo pide uno por sentido. No se encontró su tabla hermana por el nombre: elegí la de subida a mano`,
      )
    }
    if (tSubida === false) problemas.push(`la tabla ${subida} (subida) no existe en el equipo`)
    if (tBajada === false) problemas.push(`la tabla ${bajada} (bajada) no existe en el equipo`)

    // Que la tabla exista no basta: puede no corresponderse con lo que el plan
    // dice vender. Se compara contra lo contratado, con margen del 10%.
    const cerca = (kbps, tabla) =>
      tabla && !tabla.sin_limite && Math.abs(tabla.pir_kbps - kbps) <= kbps * 0.1

    if (tSubida && !cerca(p.subida_kbps, tSubida)) {
      problemas.push(
        tSubida.sin_limite
          ? `la tabla de subida no limita nada, pero el plan vende ${Math.round(p.subida_kbps / 1000)} Mbps`
          : `la tabla de subida aplica ${tSubida.mbps} Mbps y el plan vende ${Math.round(p.subida_kbps / 1000)}`,
      )
    }
    if (tBajada && !cerca(p.bajada_kbps, tBajada)) {
      problemas.push(
        tBajada.sin_limite
          ? `la tabla de bajada no limita nada, pero el plan vende ${Math.round(p.bajada_kbps / 1000)} Mbps`
          : `la tabla de bajada aplica ${tBajada.mbps} Mbps y el plan vende ${Math.round(p.bajada_kbps / 1000)}`,
      )
    }

    const ok = problemas.length === 0

    if (guardar && ok) {
      await db()
        .from('planes_velocidad')
        .update({
          traffic_table_subida: subida,
          traffic_table_bajada: bajada,
          tablas_verificadas_at: new Date().toISOString(),
          tablas_verificadas_en: oltId,
        })
        .eq('id', p.id)
    }

    revisados.push({
      id: p.id,
      nombre: p.nombre,
      contratado: `${Math.round(p.bajada_kbps / 1000)}/${Math.round(p.subida_kbps / 1000)} Mbps`,
      traffic_table_subida: subida,
      traffic_table_bajada: bajada,
      // Que se vea de dónde salió. Un índice recuperado por el nombre de la
      // tabla es distinto de uno que alguien eligió, aunque los dos funcionen.
      subida_deducida: subidaDeducida,
      subida_deducida_de: subidaDeducida ? porIndice.get(subida)?.nombre ?? null : null,
      aplica_subida: describir(tSubida || null),
      aplica_bajada: describir(tBajada || null),
      ok,
      problemas,
    })
  }

  return {
    olt: { id: olt.id, nombre: olt.nombre },
    verificado_at: new Date().toISOString(),
    planes: revisados,
    // Las que hay disponibles, para poder elegir la correcta.
    tablas: tablas.map((t) => ({
      index: t.index,
      mbps: t.mbps,
      sin_limite: t.sin_limite,
      etiqueta: `${t.index} · ${describir(t)}`,
    })),
    resumen: {
      total: revisados.length,
      correctos: revisados.filter((x) => x.ok).length,
      con_problemas: revisados.filter((x) => !x.ok).length,
    },
  }
}

/**
 * Guarda los índices de un plan, comprobándolos antes contra el equipo.
 *
 * La comprobación no es opcional: guardar un índice inventado es exactamente lo
 * que dejó dos planes rotos sin que nadie se enterara durante meses.
 */
export async function guardarTablasDePlan(oltId, planId, { subida, bajada }) {
  if (subida == null || bajada == null) {
    throw badRequest('Hacen falta los dos índices: uno para la subida y otro para la bajada', {
      hint: 'El equipo los pide por separado. Con uno solo, el límite de bajada se le aplica también a la subida.',
    })
  }

  const olt = await (await import('../lib/db.js')).cargarOlt(oltId)
  const tablas = await olts.leerTrafficTables(olt)
  const porIndice = new Map(tablas.map((t) => [t.index, t]))

  const faltan = [subida, bajada].filter((i) => !porIndice.has(Number(i)))
  if (faltan.length) {
    throw badRequest(`La OLT no tiene la traffic table ${[...new Set(faltan)].join(' ni la ')}`, {
      hint: 'Cargala en el equipo o elegí una de las que existen.',
      disponibles: tablas.map((t) => ({ index: t.index, mbps: t.mbps })),
    })
  }

  const { data, error } = await db()
    .from('planes_velocidad')
    .update({
      traffic_table_subida: Number(subida),
      traffic_table_bajada: Number(bajada),
      // Se mantiene la columna vieja apuntando a la bajada, que es lo que
      // usaban las pantallas que todavía la leen.
      traffic_table_index: Number(bajada),
      tablas_verificadas_at: new Date().toISOString(),
      tablas_verificadas_en: oltId,
    })
    .eq('id', planId)
    .select()
    .maybeSingle()

  if (error) throw new AppError(`No se pudo guardar: ${error.message}`, { status: 400 })

  return {
    ...data,
    aplica_subida: describir(porIndice.get(Number(subida))),
    aplica_bajada: describir(porIndice.get(Number(bajada))),
  }
}

// -----------------------------------------------------------------------------
// Crear traffic tables en los equipos
// -----------------------------------------------------------------------------

/** Desde dónde buscar índices libres. Debajo suele haber tablas de fábrica. */
const PRIMER_INDICE = 8
const MAX_INDICE = 1023

/**
 * Las traffic tables de varias OLTs a la vez.
 *
 * Se pregunta a cada equipo por separado porque las tablas son de cada uno: el
 * índice 12 de una OLT no tiene por qué ser la misma velocidad que el 12 de
 * otra. Esa es justamente la trampa que hay que ver antes de crear nada.
 */
export async function listarTablasDeOlts(oltIds = []) {
  const { cargarOlt } = await import('../lib/db.js')
  const salida = []

  for (const id of oltIds) {
    try {
      const olt = await cargarOlt(id)
      salida.push({
        olt_id: id,
        olt: olt.nombre,
        // Con nombre: sin él, una tabla es solo un número y elegir cuál
        // vender se vuelve adivinar.
        tablas: await olts.leerTrafficTables(olt, { conNombre: true, hasta: 31 }),
      })
    } catch (err) {
      // Un equipo que no contesta no puede dejar sin información a los demás,
      // pero tampoco puede aparecer como "sin tablas": son cosas distintas.
      salida.push({ olt_id: id, olt: null, tablas: null, error: err.message })
    }
  }

  return salida
}

/**
 * Crea un par de traffic tables —bajada y subida— en las OLTs elegidas.
 *
 * El par y no una sola: el equipo aplica una tabla por sentido, y con una sola
 * el abonado termina con su velocidad de bajada también en la subida. Así están
 * cargadas las que ya tiene este equipo, en pares.
 *
 * Los índices son los MISMOS en todas las OLTs elegidas. Es lo que permite que
 * un plan comercial guarde un solo par de números y valga para toda la red; con
 * índices distintos por equipo, cada alta tendría que averiguar en cuál está.
 * Por eso se busca un hueco libre en TODAS antes de escribir en ninguna.
 */
export async function crearParDeTablas(oltIds, { nombre, bajada_kbps, subida_kbps, priority = 0 }) {
  if (!oltIds?.length) throw badRequest('Elegí al menos una OLT')
  if (!nombre?.trim()) throw badRequest('Falta el nombre')
  if (!bajada_kbps || !subida_kbps) {
    throw badRequest('Faltan las velocidades', {
      hint: 'Hacen falta las dos: una tabla por sentido.',
    })
  }

  const { cargarOlt } = await import('../lib/db.js')
  const equipos = []
  const ocupados = new Set()

  for (const id of oltIds) {
    const olt = await cargarOlt(id)
    const tablas = await olts.leerTrafficTables(olt)
    equipos.push({ olt, tablas })
    for (const t of tablas) ocupados.add(t.index)
  }

  // Dos índices consecutivos libres en TODAS. Consecutivos porque así están las
  // que ya tiene el equipo y se leen de a pares en la CLI.
  let iBajada = null
  for (let i = PRIMER_INDICE; i < MAX_INDICE; i++) {
    if (!ocupados.has(i) && !ocupados.has(i + 1)) {
      iBajada = i
      break
    }
  }
  if (iBajada == null) {
    throw new AppError('No quedan dos índices consecutivos libres en todas las OLTs elegidas', {
      status: 409,
    })
  }
  const iSubida = iBajada + 1

  const limpio = nombre.trim().replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 24)
  const hechas = []
  const fallidas = []

  for (const { olt } of equipos) {
    for (const [index, sentido, kbps] of [
      [iBajada, 'DOWN', bajada_kbps],
      [iSubida, 'UP', subida_kbps],
    ]) {
      try {
        // cir y pir iguales: es como están cargadas las del equipo. Un cir menor
        // al pir haría que la velocidad garantizada no sea la vendida, y eso es
        // una decisión comercial, no un detalle técnico que deba tomar el sistema.
        await olts.crearTrafficTable(olt, {
          index,
          nombre: `${limpio}-${sentido}`,
          cir: kbps,
          pir: kbps,
          priority,
        })
        hechas.push({ olt: olt.nombre, index, sentido, kbps })
      } catch (err) {
        fallidas.push({ olt: olt.nombre, index, sentido, error: err.message })
      }
    }
  }

  // Se relee para confirmar. El equipo puede aceptar el comando y guardar otra
  // cosa, y decir "listo" sin mirar es lo que dejó dos planes apuntando a tablas
  // que no existían.
  const verificacion = []
  for (const { olt } of equipos) {
    const tablas = await olts.leerTrafficTables(olt).catch(() => null)
    const b = tablas?.find((t) => t.index === iBajada)
    const s = tablas?.find((t) => t.index === iSubida)
    verificacion.push({
      olt: olt.nombre,
      bajada: b ? { index: b.index, mbps: b.mbps } : null,
      subida: s ? { index: s.index, mbps: s.mbps } : null,
      ok: Boolean(b && s),
    })
  }

  return {
    nombre: limpio,
    traffic_table_bajada: iBajada,
    traffic_table_subida: iSubida,
    bajada_kbps,
    subida_kbps,
    hechas,
    fallidas,
    verificacion,
    // Solo si quedó bien en TODAS. Un par que existe en dos de tres equipos no
    // sirve para un plan comercial: el alta falla justo en la OLT que falta.
    completo: verificacion.every((v) => v.ok) && fallidas.length === 0,
  }
}

/** Borra un par de traffic tables de las OLTs donde esté. */
export async function borrarTabla(oltIds, index) {
  if (index == null) throw badRequest('Falta el índice')

  const { cargarOlt } = await import('../lib/db.js')
  const { data: usan } = await db()
    .from('planes_velocidad')
    .select('nombre')
    .or(`traffic_table_subida.eq.${index},traffic_table_bajada.eq.${index}`)

  if (usan?.length) {
    throw badRequest(
      `La usan ${usan.length} plan(es): ${usan.map((p) => p.nombre).join(', ')}`,
      {
        hint: 'Cambiales la tabla antes de borrarla. Borrándola, sus abonados quedan sin límite aplicado en la próxima alta.',
      },
    )
  }

  const hechas = []
  for (const id of oltIds) {
    const olt = await cargarOlt(id)
    try {
      await olts.ejecutarCrudo(olt, [`undo traffic table ip index ${index}`, ''])
      hechas.push(olt.nombre)
    } catch (err) {
      throw new AppError(`No se pudo borrar en ${olt.nombre}: ${err.message}`, { status: 400 })
    }
  }
  return { ok: true, index, olts: hechas }
}

/**
 * Junta las traffic tables en PARES vendibles.
 *
 * El equipo las guarda de a una, pero el negocio las usa de a dos: una para lo
 * que baja el abonado y otra para lo que sube. Quien las cargó ya las nombró
 * así —SMARTOLT-PLAN_HOME-UP y SMARTOLT-PLAN_HOME-DOWN— porque es la única
 * forma en que tienen sentido.
 *
 * Emparejarlas es lo que permite pasar de "índice 14, 153.6 Mbps" a "PLAN_HOME,
 * 153/153, ponele precio". Sin esto hay que elegir dos números sueltos de una
 * lista de veintidós y acordarse de cuál era cuál.
 *
 * Lo que no encaja en un par se devuelve igual, aparte: una tabla suelta puede
 * ser perfectamente lo que alguien quiere usar, y esconderla sería decidir por
 * él.
 */
export function emparejar(tablas = []) {
  const grupos = new Map()
  const sueltas = []

  for (const t of tablas) {
    const m = String(t.nombre ?? '').match(/^(.*?)[-_](UP|DOWN)$/i)
    if (!m) {
      sueltas.push(t)
      continue
    }
    const base = m[1]
    const sentido = m[2].toUpperCase()
    if (!grupos.has(base)) grupos.set(base, {})
    grupos.get(base)[sentido === 'UP' ? 'subida' : 'bajada'] = t
  }

  const pares = []
  for (const [nombre, g] of grupos) {
    if (!g.subida || !g.bajada) {
      // Media pareja no sirve para vender: al aplicarla, el sentido que falta
      // queda sin límite y el abonado tiene un plan distinto del que pagó.
      sueltas.push(...[g.subida, g.bajada].filter(Boolean))
      continue
    }
    pares.push({
      nombre,
      traffic_table_bajada: g.bajada.index,
      traffic_table_subida: g.subida.index,
      bajada_mbps: g.bajada.mbps,
      subida_mbps: g.subida.mbps,
      bajada_kbps: g.bajada.pir_kbps,
      subida_kbps: g.subida.pir_kbps,
      en_uso: Boolean(g.bajada.en_uso || g.subida.en_uso),
    })
  }

  return {
    pares: pares.sort((a, b) => (a.bajada_mbps ?? 0) - (b.bajada_mbps ?? 0)),
    sueltas: sueltas.sort((a, b) => a.index - b.index),
  }
}

/**
 * Crea un plan comercial a partir de un par de traffic tables que ya existe.
 *
 * Es el camino que faltaba. El otro —definir el plan y después buscarle las
 * tablas— sirve para una red nueva; en una que ya está andando, las tablas
 * existen desde hace años y lo único que falta es ponerles nombre comercial y
 * precio.
 */
export async function crearPlanDesdeTablas(oltId, datos) {
  const { nombre, precio, bajada, subida, categoria = 'residencial' } = datos

  if (!nombre?.trim()) throw badRequest('El plan necesita un nombre')
  if (bajada == null || subida == null) {
    throw badRequest('Hacen falta las dos tablas: una por sentido')
  }

  const olt = await (await import('../lib/db.js')).cargarOlt(oltId)
  const tablas = await olts.leerTrafficTables(olt, { conNombre: true, hasta: 63 })
  const tB = tablas.find((t) => t.index === Number(bajada))
  const tS = tablas.find((t) => t.index === Number(subida))

  if (!tB || !tS) {
    throw badRequest(`La OLT no tiene la traffic table ${!tB ? bajada : subida}`, {
      hint: 'Se leyó del equipo hace un momento: puede que alguien la haya borrado.',
    })
  }

  // La velocidad la dicta el EQUIPO, no lo que se escriba en el formulario. Es
  // lo que evita volver a tener un plan llamado "100M" que aplica 1 Gbps.
  const fila = {
    nombre: nombre.trim(),
    categoria,
    precio: Number(precio) || 0,
    tipo_impuesto: datos.tipo_impuesto ?? 'incluido',
    iva_porcentaje: datos.iva_porcentaje ?? 15,
    bajada_kbps: tB.pir_kbps,
    subida_kbps: tS.pir_kbps,
    traffic_table_bajada: tB.index,
    traffic_table_subida: tS.index,
    traffic_table_index: tB.index,
    tablas_verificadas_at: new Date().toISOString(),
    tablas_verificadas_en: oltId,
    control_pppoe: 'olt',
    activo: true,
  }

  const { data, error } = await db().from('planes_velocidad').insert(fila).select().maybeSingle()
  if (error) {
    throw new AppError(
      error.code === '23505' ? `Ya existe un plan llamado "${fila.nombre}"` : error.message,
      { status: 400 },
    )
  }

  return {
    ...data,
    aplica_bajada: describir(tB),
    aplica_subida: describir(tS),
  }
}
