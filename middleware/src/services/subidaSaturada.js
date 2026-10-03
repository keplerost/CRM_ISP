import { conClave, db } from '../lib/db.js'
import * as mk from './mikrotikService.js'
import { emparejar } from './consumoDiario.js'

/**
 * La subida saturada: quién está llenando su propia subida, y desde cuándo.
 *
 * ── Cómo se mide ──
 *
 * Con los contadores de bytes de cada cola, no con su "rate". El rate es una
 * foto de los últimos segundos: una muestra cada cinco minutos lo vería arriba
 * o abajo por casualidad. La diferencia de bytes entre dos lecturas es el
 * PROMEDIO de todo el intervalo, que es lo que importa para decir "sostenido".
 *
 * Las lecturas anteriores viven en memoria. Al reiniciar el servidor la primera
 * pasada solo fija el punto de partida; no vale la pena guardarlas en la base
 * para no perder cinco minutos.
 *
 * ── Cómo se decide ──
 *
 * La función `decidir` es pura —se prueba sin router ni base—:
 *
 *   · Por encima del umbral y sin evento abierto → se abre uno.
 *   · Un evento que todavía no cumplió la espera se BORRA en cuanto una muestra
 *     baja del umbral: no fue sostenido, y no tiene que quedar como evidencia.
 *   · Cumplida la espera, se CONFIRMA: sale la campana y queda en la ficha.
 *   · Uno confirmado se cierra recién cuando baja bastante (20 puntos por
 *     debajo del umbral). Sin ese margen, alguien que oscila entre 79 y 81%
 *     abriría y cerraría alertas cada cinco minutos.
 *
 * El envío por WhatsApp/Telegram no se hace acá: lo hace la tarea de alertas,
 * que ya toma cualquier evento abierto que cumplió la espera de su regla.
 */

export const REGLA = 'subida_saturada'

/** Cuántos puntos por debajo del umbral hay que bajar para cerrar. */
export const MARGEN_CIERRE = 20

/** Un evento sin muestras nuevas en este tiempo se da por terminado. */
const SIN_DATOS_MS = 60 * 60 * 1000

/** Roles a los que les suena la campana. */
const ROLES_QUE_AVISAR = ['super_admin', 'admin', 'jefe_tecnico']

/**
 * "10M", "10000000", "512k", "1.5G" → bits por segundo.
 * Cero o vacío = sin límite.
 */
export function aBps(valor) {
  const m = String(valor ?? '').trim().match(/^([\d.]+)\s*([kKmMgG]?)$/)
  if (!m) return 0
  const n = Number(m[1])
  const mult = { '': 1, k: 1e3, m: 1e6, g: 1e9 }[m[2].toLowerCase()]
  return Number.isFinite(n) ? n * mult : 0
}

/** El límite de SUBIDA de una cola: "subida/bajada", el primero. */
export const limiteSubida = (cola) => aBps(String(cola?.['max-limit'] ?? '').split('/')[0])

/**
 * Velocidad de subida de cada abonado, a partir de dos lecturas.
 *
 * @param lecturas  [{ client_id, cliente, origen, subida, cola }] de `emparejar`
 * @param previas   Map client_id → { subida, origen, t }
 * @returns         { medidas: [{ client_id, cliente, mbps, limite_mbps, pct }], previas }
 */
export function medir(lecturas, previas, ahora = Date.now(), intervaloMs = 5 * 60_000) {
  const nuevas = new Map(previas)
  const medidas = []

  for (const l of lecturas) {
    const ant = previas.get(l.client_id)
    nuevas.set(l.client_id, { subida: l.subida, origen: l.origen, t: ahora })
    if (!ant || ant.origen !== l.origen) continue

    const dt = (ahora - ant.t) / 1000
    const dBytes = l.subida - ant.subida
    // Muy seguido no promedia nada; muy espaciado (el servidor estuvo parado)
    // diluye un pico en horas. Contador hacia atrás = la cola se reinició.
    if (dt < 60 || dt > (intervaloMs / 1000) * 3 || dBytes < 0) continue

    const limite = limiteSubida(l.cola)
    if (!limite) continue

    const bps = (dBytes * 8) / dt
    medidas.push({
      client_id: l.client_id,
      cliente: l.cliente,
      mbps: Math.round((bps / 1e6) * 100) / 100,
      limite_mbps: Math.round((limite / 1e6) * 100) / 100,
      pct: Math.round((bps / limite) * 1000) / 10,
      desde: new Date(ant.t).toISOString(),
    })
  }
  return { medidas, previas: nuevas }
}

/**
 * Qué hacer con los eventos, dadas las medidas de esta pasada.
 *
 * @param medidas  las de `medir`
 * @param abiertos eventos abiertos de esta regla (de la base)
 * @param regla    { umbral, espera_min }
 */
export function decidir({ medidas, abiertos, regla, ahora = new Date() }) {
  const umbral = Number(regla?.umbral ?? 80)
  const esperaMs = Number(regla?.espera_min ?? 15) * 60_000
  const plan = { abrir: [], actualizar: [], borrar: [], resolver: [], confirmar: [] }

  const porCliente = new Map(abiertos.map((e) => [String(e.entidad_id), e]))
  const medidos = new Set()

  for (const m of medidas) {
    const id = String(m.client_id)
    medidos.add(id)
    const e = porCliente.get(id)
    const muestra = {
      ultimo_mbps: m.mbps,
      ultimo_pct: m.pct,
      limite_mbps: m.limite_mbps,
      medido_en: ahora.toISOString(),
    }

    if (!e) {
      if (m.pct >= umbral) {
        plan.abrir.push({
          entidad_id: id,
          cliente: m.cliente,
          empezo_en: m.desde,
          detalle: { ...muestra, pico_mbps: m.mbps, pico_pct: m.pct, muestras: 1 },
        })
      }
      continue
    }

    const d = e.detalle ?? {}
    const confirmado = Boolean(d.confirmado_en)

    if (!confirmado && m.pct < umbral) {
      plan.borrar.push(e.id)
      continue
    }
    if (confirmado && m.pct < umbral - MARGEN_CIERRE) {
      plan.resolver.push({ id: e.id, detalle: { ...d, ...muestra } })
      continue
    }

    const detalle = {
      ...d,
      ...muestra,
      pico_mbps: Math.max(Number(d.pico_mbps ?? 0), m.mbps),
      pico_pct: Math.max(Number(d.pico_pct ?? 0), m.pct),
      muestras: Number(d.muestras ?? 0) + 1,
    }
    if (!confirmado && ahora - new Date(e.empezo_en) >= esperaMs) {
      detalle.confirmado_en = ahora.toISOString()
      plan.confirmar.push({ id: e.id, entidad_id: id, etiqueta: e.etiqueta, empezo_en: e.empezo_en, detalle })
    } else {
      plan.actualizar.push({ id: e.id, detalle })
    }
  }

  // Los que no se pudieron medir: se esperan una hora y después se cierran.
  for (const e of abiertos) {
    if (medidos.has(String(e.entidad_id))) continue
    const ultimo = new Date(e.detalle?.medido_en ?? e.empezo_en)
    if (ahora - ultimo < SIN_DATOS_MS) continue
    if (e.detalle?.confirmado_en) plan.resolver.push({ id: e.id, detalle: e.detalle })
    else plan.borrar.push(e.id)
  }

  return plan
}

/** El texto de la campana. El de WhatsApp/Telegram vive en web/src/lib/alertas.js. */
export function textoCampana({ etiqueta, detalle: d = {} }) {
  return {
    titulo: `${etiqueta ?? 'Abonado'}: subida saturada`,
    detalle:
      `Lleva un rato usando ${d.ultimo_mbps} de ${d.limite_mbps} Mbps de subida (${Math.round(d.ultimo_pct)}%). ` +
      'Se va a notar lento para todo, pero es tráfico que sale de su casa, no la red.',
  }
}

// ---------------------------------------------------------------------------

/** Las lecturas anteriores, por abonado. Viven lo que vive el proceso. */
let previas = new Map()

export async function ejecutarSubida({ ahora = new Date(), intervaloMs = 5 * 60_000 } = {}) {
  const resultado = { medidos: 0, saturados: 0, abiertos: 0, confirmados: 0, cerrados: 0, fallidos: [] }

  const { data: regla, error: eRegla } = await db()
    .from('alerta_reglas').select('*').eq('clave', REGLA).maybeSingle()
  if (eRegla || !regla) {
    throw new Error('Falta la regla de subida saturada. Corré supabase/migracion-204-la-subida-saturada.sql')
  }
  if (!regla.activa) return { ...resultado, apagada: true }

  const { data: routers } = await db().from('routers_mikrotik').select('*').eq('activo', true)
  const { data: clientes } = await db()
    .from('clientes')
    .select('id, nombre, codigo, ip, usuario_ppp, router_id, estado, zona')
    .eq('estado', 'activo')

  const lecturas = []
  for (const router of routers ?? []) {
    const suyos = (clientes ?? []).filter((c) => c.router_id === router.id)
    if (!suyos.length) continue
    try {
      const colas = (await mk.listarSimpleQueues(conClave(router))) ?? []
      const activas = colas.filter((q) => String(q.disabled) !== 'true')
      lecturas.push(...emparejar(activas, suyos))
    } catch (err) {
      resultado.fallidos.push({ router: router.nombre, error: err.message })
    }
  }

  const medicion = medir(lecturas, previas, ahora.getTime(), intervaloMs)
  previas = medicion.previas
  resultado.medidos = medicion.medidas.length
  resultado.saturados = medicion.medidas.filter((m) => m.pct >= Number(regla.umbral ?? 80)).length

  const { data: abiertos } = await db()
    .from('alerta_eventos')
    .select('id, entidad_id, etiqueta, empezo_en, detalle')
    .eq('regla', REGLA)
    .is('resuelto_en', null)

  const plan = decidir({ medidas: medicion.medidas, abiertos: abiertos ?? [], regla, ahora })

  for (const a of plan.abrir) {
    const c = a.cliente ?? {}
    const { error } = await db().from('alerta_eventos').insert({
      regla: REGLA,
      entidad: 'cliente',
      entidad_id: a.entidad_id,
      etiqueta: c.nombre,
      zona: c.zona ?? null,
      abonados: 1,
      empezo_en: a.empezo_en,
      detalle: { ...a.detalle, codigo: c.codigo ?? null, cliente_id: a.entidad_id },
    })
    if (error) resultado.fallidos.push({ cliente: c.nombre, error: error.message })
    else resultado.abiertos++
  }

  for (const u of [...plan.actualizar, ...plan.confirmar]) {
    await db().from('alerta_eventos').update({ detalle: u.detalle }).eq('id', u.id)
  }

  if (plan.borrar.length) {
    await db().from('alerta_eventos').delete().in('id', plan.borrar)
  }

  for (const r of plan.resolver) {
    await db()
      .from('alerta_eventos')
      .update({ resuelto_en: ahora.toISOString(), detalle: r.detalle })
      .eq('id', r.id)
    resultado.cerrados++
  }

  if (plan.confirmar.length) {
    const { data: usuarios } = await db()
      .from('usuarios_sistema')
      .select('id')
      .eq('activo', true)
      .in('rol', ROLES_QUE_AVISAR)

    for (const c of plan.confirmar) {
      const { titulo, detalle } = textoCampana(c)
      for (const u of usuarios ?? []) {
        await db().rpc('notificar', {
          p_usuario: u.id,
          p_tipo: REGLA,
          p_titulo: titulo,
          p_detalle: detalle,
          p_ruta: `/clientes/${c.entidad_id}`,
          p_entidad: 'cliente',
          p_entidad_id: String(c.entidad_id),
        })
      }
      resultado.confirmados++
    }
  }

  return resultado
}

export const estadoSubida = {
  automatico: false,
  cada_minutos: 5,
  ultimaCorrida: null,
  ultimoResultado: null,
  error: null,
}

/** Cada pocos minutos. La primera pasada solo fija el punto de partida. */
export function programarSubida({ cada_minutos = 5, ejecutar = ejecutarSubida } = {}) {
  estadoSubida.automatico = true
  estadoSubida.cada_minutos = cada_minutos
  const intervaloMs = cada_minutos * 60_000

  const correr = async () => {
    try {
      estadoSubida.ultimoResultado = await ejecutar({ intervaloMs })
      estadoSubida.ultimaCorrida = new Date().toISOString()
      estadoSubida.error = null
    } catch (err) {
      estadoSubida.error = err.message
      console.error('[subida] falló la medición:', err.message)
    }
  }

  const tarea = setInterval(correr, intervaloMs)
  tarea.unref?.()
  correr()
  return tarea
}
