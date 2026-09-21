import { db } from '../lib/db.js'
import * as mk from '../services/mikrotikService.js'
import { fechaLocal } from './facturacionMensual.js'

/**
 * Recolección del consumo diario.
 *
 * El MikroTik no dice "este abonado bajó 4 GB hoy": dice cuántos bytes lleva
 * acumulados una cola desde que se creó. El consumo del día es la diferencia
 * entre dos lecturas, y eso trae tres problemas que hay que resolver de verdad:
 *
 * 1. **El contador se reinicia.** Al reiniciar el router, al recrear la cola o
 *    al reconectar una sesión PPPoE, vuelve a cero. Restar sin más daría un
 *    número negativo enorme; tomar el valor entero como consumo del momento
 *    inventaría gigabytes que nadie usó.
 *
 * 2. **La cola cambia de nombre.** Una cola dinámica de PPPoE se llama como la
 *    sesión y se recrea en cada reconexión. Si cambió el origen, la lectura
 *    anterior no es comparable.
 *
 * 3. **El recolector corre varias veces.** Tiene que sumar a lo que ya había,
 *    no reemplazarlo, y una corrida repetida no puede duplicar el consumo.
 *
 * La decisión de cuánto consumió cada abonado es una función pura —`repartir`—
 * separada de la lectura y de la escritura: se puede probar sin router y sin
 * base, que es la única forma de confiar en un proceso que corre solo.
 */

/**
 * Bytes que reporta RouterOS en "rx/tx" o en un campo suelto.
 *
 * Se redondea a entero: las columnas de bytes son BIGINT y un decimal las hace
 * fallar. RouterOS manda enteros, pero un valor con coma —de otra fuente, de un
 * cálculo, de una prueba— no puede tumbar la medición de todos los abonados.
 */
export function partirBytes(valor) {
  if (valor == null) return { rx: 0, tx: 0 }
  const [rx, tx] = String(valor)
    .split('/')
    .map((n) => Math.round(Number(String(n).trim())) || 0)
  return { rx: rx || 0, tx: tx || 0 }
}

/** Entero no negativo, que es lo único que aceptan las columnas de bytes. */
const bytes = (n) => Math.max(0, Math.round(Number(n) || 0))

/**
 * Cuánto consumió cada abonado entre dos lecturas.
 *
 * @param lecturas  [{ client_id, origen, subida, bajada }] lo que marca el equipo ahora
 * @param previas   { [client_id]: { origen, subida_bytes, bajada_bytes } } lo de la vez anterior
 */
export function repartir(lecturas = [], previas = {}) {
  const consumos = []

  for (const l of lecturas) {
    const anterior = previas[l.client_id]

    // Sin lectura previa no hay diferencia que calcular. Se guarda el punto de
    // partida y se cuenta desde la próxima: contar el acumulado como consumo de
    // hoy le cargaría al abonado todo lo que bajó desde que se instaló.
    if (!anterior) {
      consumos.push({ client_id: l.client_id, subida: 0, bajada: 0, origen: l.origen, arranque: true })
      continue
    }

    // Otro origen: la cola se recreó y el contador arrancó de cero.
    if (anterior.origen && l.origen && anterior.origen !== l.origen) {
      consumos.push({
        client_id: l.client_id,
        subida: bytes(l.subida),
        bajada: bytes(l.bajada),
        origen: l.origen,
        reinicio: true,
      })
      continue
    }

    const dSubida = l.subida - Number(anterior.subida_bytes ?? 0)
    const dBajada = l.bajada - Number(anterior.bajada_bytes ?? 0)

    // Contador reiniciado: lo que marca ahora es lo consumido desde el cero.
    const reinicio = dSubida < 0 || dBajada < 0

    consumos.push({
      client_id: l.client_id,
      subida: reinicio ? bytes(l.subida) : bytes(dSubida),
      bajada: reinicio ? bytes(l.bajada) : bytes(dBajada),
      origen: l.origen,
      reinicio,
    })
  }

  return consumos
}

/**
 * Cómo estuvo el servicio del abonado en este momento.
 *
 * Es lo que pinta la gráfica: azul cuando navegaba normal, verde cuando estaba
 * conectado por una promesa —el dato que se mira cuando alguien pregunta por
 * qué tuvo servicio sin haber pagado— y rojo cuando estuvo cortado.
 */
export function estadoDe(cliente, conPromesa = false) {
  if (cliente.estado === 'cortado') return 'cortado'
  if (cliente.estado === 'suspendido' || cliente.estado === 'baja') return 'suspendido'
  return conPromesa ? 'promesa' : 'activo'
}

/** Empareja las colas del router con los abonados, por IP o por usuario PPPoE. */
export function emparejar(colas = [], clientes = []) {
  const porIp = new Map()
  const porUsuario = new Map()

  for (const c of clientes) {
    if (c.ip) porIp.set(String(c.ip).split('/')[0], c)
    if (c.usuario_ppp) porUsuario.set(String(c.usuario_ppp).toLowerCase(), c)
  }

  const lecturas = []
  for (const q of colas) {
    // El objetivo de una simple queue es la IP o la red del abonado; en las
    // dinámicas de PPPoE, el nombre trae el usuario: <pppoe-juan>.
    const objetivo = String(q.target ?? '').split(',')[0].split('/')[0]
    const nombre = String(q.name ?? '')
    const usuario = nombre.replace(/^<pppoe-/, '').replace(/>$/, '').toLowerCase()

    const cliente = porIp.get(objetivo) ?? porUsuario.get(usuario)
    if (!cliente) continue

    // En una simple queue, "bytes" viene como "subida/bajada" desde la
    // perspectiva del router: lo que recibe del abonado es su subida.
    const { rx, tx } = partirBytes(q.bytes)

    lecturas.push({
      client_id: cliente.id,
      cliente,
      origen: nombre || objetivo,
      subida: rx,
      bajada: tx,
    })
  }

  return lecturas
}

/**
 * Lee los routers, calcula y guarda.
 *
 * @param simular  true = devuelve lo que haría sin escribir nada
 */
export async function recolectar({ simular = false, fecha = null } = {}) {
  const hoy = fecha ?? fechaLocal()

  const { data: routers, error: errRouters } = await db()
    .from('routers_mikrotik')
    .select('*')
    .eq('activo', true)
  if (errRouters) throw new Error(`No se pudieron leer los routers: ${errRouters.message}`)

  const { data: clientes, error: errClientes } = await db()
    .from('clientes')
    .select('id, nombre, ip, usuario_ppp, router_id, estado')
  if (errClientes) throw new Error(`No se pudieron leer los clientes: ${errClientes.message}`)

  const { data: contadores } = await db().from('consumo_contadores').select('*')
  const previas = Object.fromEntries((contadores ?? []).map((c) => [c.client_id, c]))

  // Quién está con promesa activa hoy: es lo que pinta el día de verde.
  const { data: promesas } = await db()
    .from('promesas_pago')
    .select('client_id')
    .eq('estado', 'activa')
    .eq('activo_servicio', true)
  const conPromesa = new Set((promesas ?? []).map((p) => p.client_id))

  const resultado = { fecha: hoy, simulado: simular, routers: [], medidos: 0, fallidos: [] }

  for (const router of routers ?? []) {
    const suyos = (clientes ?? []).filter((c) => c.router_id === router.id)
    if (!suyos.length) continue

    let colas
    try {
      colas = await mk.listarSimpleQueues(router)
    } catch (err) {
      resultado.fallidos.push({ router: router.nombre, error: err.message })
      continue
    }

    const lecturas = emparejar(colas ?? [], suyos)
    const consumos = repartir(lecturas, previas)

    resultado.routers.push({
      router: router.nombre,
      colas: colas?.length ?? 0,
      emparejados: lecturas.length,
      sin_emparejar: suyos.length - lecturas.length,
    })

    if (simular) {
      resultado.medidos += consumos.length
      resultado.detalle = [
        ...(resultado.detalle ?? []),
        ...consumos.map((c) => ({
          cliente: suyos.find((x) => x.id === c.client_id)?.nombre,
          subida: c.subida,
          bajada: c.bajada,
          arranque: c.arranque ?? false,
          reinicio: c.reinicio ?? false,
        })),
      ]
      continue
    }

    for (const c of consumos) {
      const cliente = suyos.find((x) => x.id === c.client_id)
      const lectura = lecturas.find((l) => l.client_id === c.client_id)

      // La primera lectura solo fija el punto de partida.
      if (!c.arranque && (c.subida > 0 || c.bajada > 0)) {
        const { error } = await db().rpc('sumar_consumo', {
          p_client_id: c.client_id,
          p_fecha: hoy,
          p_subida: c.subida,
          p_bajada: c.bajada,
          p_estado: estadoDe(cliente, conPromesa.has(c.client_id)),
          p_fuente: 'mikrotik',
        })
        if (error) resultado.fallidos.push({ cliente: cliente?.nombre, error: error.message })
      }

      // Si esto falla en silencio, la próxima corrida compara contra una
      // lectura vieja y le carga al abonado el consumo de las horas del medio.
      // Es peor que no medir: el número parece correcto y no lo es.
      const { error: errContador } = await db()
        .from('consumo_contadores')
        .upsert({
          client_id: c.client_id,
          subida_bytes: bytes(lectura.subida),
          bajada_bytes: bytes(lectura.bajada),
          origen: lectura.origen,
          fuente: 'mikrotik',
          leido_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })

      if (errContador) {
        resultado.fallidos.push({
          cliente: cliente?.nombre,
          error: `No se guardó el contador: ${errContador.message}`,
        })
        continue
      }

      resultado.medidos++
    }
  }

  return resultado
}

/**
 * Sesiones activas del router, para la tabla de registros.
 *
 * Se guarda una fila por sesión y se le pone fin cuando desaparece. Sin esto,
 * un abonado que reclama "se me cae todo el tiempo" no tiene con qué probarlo.
 */
export async function sincronizarSesiones() {
  const { data: routers } = await db().from('routers_mikrotik').select('*').eq('activo', true)
  const { data: clientes } = await db().from('clientes').select('id, ip, usuario_ppp, router_id')

  let abiertas = 0
  let cerradas = 0

  for (const router of routers ?? []) {
    let activas = []
    try {
      activas = (await mk.listarPppActive(router)) ?? []
    } catch {
      // Sin PPPoE en este router no hay sesiones que seguir. No es un error.
      continue
    }

    const suyos = (clientes ?? []).filter((c) => c.router_id === router.id)
    const vivas = new Set()

    for (const s of activas) {
      const cliente = suyos.find(
        (c) => String(c.usuario_ppp ?? '').toLowerCase() === String(s.name ?? '').toLowerCase(),
      )
      if (!cliente) continue
      vivas.add(cliente.id)

      const { data: existente } = await db()
        .from('sesiones_conexion')
        .select('id')
        .eq('client_id', cliente.id)
        .is('fin', null)
        .maybeSingle()

      if (!existente) {
        await db().from('sesiones_conexion').insert({
          client_id: cliente.id,
          usuario: s.name,
          ip: s.address,
          mac: s['caller-id'],
          nas: router.nombre,
          inicio: new Date().toISOString(),
          fuente: 'mikrotik',
        })
        abiertas++
      }
    }

    // Las que ya no están: se cierran con la hora de ahora. No es el momento
    // exacto de la caída —eso solo lo da RADIUS— pero acota cuándo pasó.
    const { data: colgadas } = await db()
      .from('sesiones_conexion')
      .select('id, client_id')
      .is('fin', null)
      .in('client_id', suyos.map((c) => c.id))

    for (const s of colgadas ?? []) {
      if (vivas.has(s.client_id)) continue
      await db()
        .from('sesiones_conexion')
        .update({ fin: new Date().toISOString(), motivo_desconexion: 'No figura activa en el router' })
        .eq('id', s.id)
      cerradas++
    }
  }

  return { abiertas, cerradas }
}

// --- Proceso que corre solo --------------------------------------------------

export const estadoConsumo = {
  automatico: false,
  cada_minutos: 60,
  ultimaCorrida: null,
  ultimoResultado: null,
}

/**
 * Arranca la recolección periódica.
 *
 * Cada hora es suficiente: el consumo se mira por día y leer más seguido solo
 * agrega conexiones al router sin cambiar el número. El intervalo importa por
 * otra cosa —cuanto más espaciado, más consumo se pierde si el contador se
 * reinicia entre dos lecturas—.
 */
export function programarConsumo({ cada_minutos = 60 } = {}) {
  estadoConsumo.automatico = true
  estadoConsumo.cada_minutos = cada_minutos

  const tarea = setInterval(
    async () => {
      try {
        estadoConsumo.ultimoResultado = await recolectar()
        estadoConsumo.ultimaCorrida = new Date().toISOString()
        console.log(
          `[consumo] ${estadoConsumo.ultimoResultado.medidos} abonados medidos` +
            (estadoConsumo.ultimoResultado.fallidos.length
              ? `, ${estadoConsumo.ultimoResultado.fallidos.length} con error`
              : ''),
        )
      } catch (err) {
        console.error('[consumo] falló la recolección:', err.message)
      }
    },
    cada_minutos * 60_000,
  )

  // Que el proceso pueda terminar aunque el temporizador siga vivo.
  tarea.unref?.()
  return tarea
}
