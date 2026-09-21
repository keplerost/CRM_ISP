/**
 * Corte automático de promesas vencidas.
 *
 * Habilitar el servicio por una promesa es prestarle confianza al abonado; si
 * la fecha pasa sin pago, alguien tiene que volver a cortar. Depender de que un
 * humano se acuerde convierte cada promesa en una fuga silenciosa.
 *
 * Tres cosas que hacen que esto sea seguro de dejar corriendo solo:
 *
 * 1. Solo corta a quien sigue debiendo. Si pagó —aunque nadie haya cerrado la
 *    promesa a mano— tiene saldo cero y queda afuera.
 * 2. La decisión de a quién cortar es una función pura, separada del corte en
 *    sí. Se puede ver la lista sin tocar la red, y se puede probar sin router.
 * 3. Hay un tope por corrida. Si una consulta sale mal y devuelve a todos los
 *    abonados, el tope evita dejar sin internet al pueblo entero.
 */

import { db, cargarRouter } from '../lib/db.js'
import * as mt from './mikrotikService.js'
import { config } from '../config.js'

/** Fecha local en YYYY-MM-DD. `toISOString` daría la del huso UTC. */
export function fechaLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Decide a quién corresponde cortar.
 *
 * @param promesas  filas de `v_promesas_a_cortar`
 * @param saldos    Map de client_id → saldo pendiente
 * @param limite    tope de cortes por corrida
 * @returns {{ cortes: object[], omitidos: object[] }}
 */
export function decidirCortes(promesas = [], saldos = new Map(), { limite = 200 } = {}) {
  const cortes = []
  const omitidos = []

  for (const p of promesas) {
    const saldo = Number(saldos.get(p.client_id) ?? 0)

    // Pagó después de prometer: la deuda es cero y no hay nada que cortar.
    if (!(saldo > 0)) {
      omitidos.push({ ...p, motivo: 'Ya no tiene saldo pendiente' })
      continue
    }

    // Sin router o sin IP no se puede cortar solo: queda para hacerlo a mano.
    if (!p.router_id || !p.ip) {
      omitidos.push({ ...p, motivo: 'No tiene router o IP asignados' })
      continue
    }

    if (cortes.length >= limite) {
      omitidos.push({ ...p, motivo: `Se alcanzó el tope de ${limite} cortes por corrida` })
      continue
    }

    cortes.push({ ...p, saldo })
  }

  return { cortes, omitidos }
}

/** Promesas vencidas que habían habilitado el servicio, con su deuda actual. */
export async function candidatos() {
  const { data: promesas, error } = await db().from('v_promesas_a_cortar').select('*')
  if (error) throw new Error(`No se pudieron leer las promesas vencidas: ${error.message}`)
  if (!promesas?.length) return { promesas: [], saldos: new Map() }

  const ids = [...new Set(promesas.map((p) => p.client_id).filter(Boolean))]
  const { data: facturas, error: errFac } = await db()
    .from('v_facturas_por_cobrar')
    .select('client_id, saldo')
    .in('client_id', ids)
  if (errFac) throw new Error(`No se pudieron leer los saldos: ${errFac.message}`)

  const saldos = new Map()
  for (const f of facturas ?? []) {
    saldos.set(f.client_id, Number(saldos.get(f.client_id) ?? 0) + Number(f.saldo ?? 0))
  }

  return { promesas, saldos }
}

/**
 * Corta a los que corresponde.
 *
 * @param simular  true = solo devuelve la lista, sin tocar la red ni la base
 */
export async function ejecutarCortes({ simular = false, limite = config.cortes.limite } = {}) {
  const { promesas, saldos } = await candidatos()
  const { cortes, omitidos } = decidirCortes(promesas, saldos, { limite })

  if (simular) {
    return { simulado: true, fecha: fechaLocal(), cortados: [], pendientes: cortes, omitidos }
  }

  // Un router se carga una vez por corrida aunque tenga veinte morosos: cada
  // carga descifra credenciales y golpea la base.
  const routers = new Map()
  const cortados = []
  const fallidos = []

  for (const p of cortes) {
    try {
      if (!routers.has(p.router_id)) routers.set(p.router_id, await cargarRouter(p.router_id))
      const equipo = routers.get(p.router_id)

      // La entrada del address-list no corta nada sin la regla de filter que
      // dropea esa lista; se asegura antes de bloquear.
      await mt.asegurarReglaCorte(equipo)
      await mt.bloquearIp(equipo, {
        address: p.ip,
        comment: `Promesa incumplida del ${p.fecha_promesa}`,
      })

      await db().from('clientes').update({ estado: 'cortado' }).eq('id', p.client_id)
      await db().from('promesas_pago').update({ estado: 'incumplida' }).eq('id', p.id)

      cortados.push({ id: p.id, cliente: p.cliente, ip: p.ip, saldo: p.saldo })
    } catch (err) {
      // Que falle un router no puede dejar sin cortar a los demás.
      fallidos.push({ id: p.id, cliente: p.cliente, ip: p.ip, error: err.message })
    }
  }

  return { simulado: false, fecha: fechaLocal(), cortados, fallidos, omitidos }
}

// --- Programador ------------------------------------------------------------

/**
 * Estado de la última corrida, para poder mostrarlo en la UI.
 * Vive en memoria: si el proceso se reinicia se pierde, y la corrida se repite.
 * No es un problema porque cortar es idempotente — a quien ya está cortado la
 * consulta no lo devuelve.
 */
export const estadoCortes = {
  automaticos: false,
  hora: null,
  ultimaCorrida: null,
  ultimoResultado: null,
}

/** ¿Ya pasó la hora de hoy? */
function llegoLaHora(ahora, hora) {
  const [h, m] = String(hora).split(':').map(Number)
  if (Number.isNaN(h)) return false
  return ahora.getHours() > h || (ahora.getHours() === h && ahora.getMinutes() >= (m || 0))
}

/**
 * Arranca el corte diario.
 *
 * Se revisa cada pocos minutos en vez de programar un temporizador de 24 horas:
 * un `setTimeout` largo se desfasa con la suspensión del equipo y con los
 * cambios de horario, y basta un reinicio para que nunca dispare.
 */
export function programarCortes({
  activo = config.cortes.automaticos,
  hora = config.cortes.hora,
  intervaloMs = 5 * 60 * 1000,
  ejecutar = ejecutarCortes,
} = {}) {
  estadoCortes.automaticos = activo
  estadoCortes.hora = hora

  if (!activo) return null

  const revisar = async () => {
    const ahora = new Date()
    const hoy = fechaLocal(ahora)

    if (estadoCortes.ultimaCorrida === hoy) return
    if (!llegoLaHora(ahora, hora)) return

    // Se marca antes de ejecutar: si la corrida tarda, el siguiente tick no
    // tiene que largar una segunda en paralelo.
    estadoCortes.ultimaCorrida = hoy
    try {
      const r = await ejecutar({})
      estadoCortes.ultimoResultado = r
      console.log(
        `[cortes] ${r.cortados.length} cortados, ${r.fallidos?.length ?? 0} con error, ${r.omitidos.length} omitidos`,
      )
    } catch (err) {
      estadoCortes.ultimoResultado = { error: err.message }
      console.error(`[cortes] la corrida falló: ${err.message}`)
      // Se libera la marca para que vuelva a intentar en el próximo tick: un
      // error de red no puede cancelar el corte de todo el día.
      estadoCortes.ultimaCorrida = null
    }
  }

  const temporizador = setInterval(revisar, intervaloMs)
  temporizador.unref?.()
  revisar()

  return temporizador
}
