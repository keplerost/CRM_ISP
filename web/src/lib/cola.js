import { openDB } from 'idb'

/**
 * La cola de trabajo sin conexión.
 *
 * ── Qué problema resuelve, exactamente ──
 *
 * El técnico pierde señal en medio de una instalación. Hoy eso significa que lo
 * que cargó se pierde y tiene que rehacerlo cuando vuelve la cobertura — o, más
 * común, que no lo rehace y la orden queda a medias en el sistema.
 *
 * ── El caso peligroso NO es "no se envió" ──
 *
 * Es "se envió, el servidor lo guardó, y la respuesta no volvió". Desde el
 * teléfono eso es indistinguible de un fallo, así que reintenta. Sin protección,
 * el material se descuenta dos veces y a fin de mes el inventario no cuadra por
 * un margen que nadie puede explicar.
 *
 * Por eso cada operación lleva una `clave_idempotencia` generada ACÁ, antes del
 * primer intento, y que no cambia entre reintentos. La migración 84 puso un
 * índice único sobre esa columna: el segundo intento rebota con el código 23505
 * y eso significa "ya estaba", no "falló".
 *
 * ── Lo que esta cola NO promete ──
 *
 * No promete que el trabajo esté hecho. Mientras hay operaciones pendientes, la
 * pantalla dice "falta enviar" y no "listo". Decir "listo" sería cómodo y sería
 * mentira, y el día que el teléfono se pierda con la cola adentro, el técnico
 * habría jurado que cerró una orden que nadie recibió.
 */

const BASE = 'taller-campo'
const TIENDA = 'pendientes'

let db
async function abrir() {
  if (db) return db
  db = await openDB(BASE, 1, {
    upgrade(d) {
      const t = d.createObjectStore(TIENDA, { keyPath: 'id' })
      t.createIndex('creado', 'creado')
      t.createIndex('estado', 'estado')
    },
  })
  return db
}

/** Un id que sobrevive al reintento. `crypto.randomUUID` está en todo navegador que soporte service workers. */
const nuevoId = () => crypto.randomUUID()

/**
 * Encola una escritura.
 *
 * `tipo` dice qué hacer al despacharla; el despachador de más abajo es el único
 * lugar que sabe traducir cada tipo a una llamada. Guardar la llamada ya armada
 * —una función, o una URL con su cuerpo— no funcionaría: lo que entra en
 * IndexedDB tiene que ser datos, y tiene que seguir teniendo sentido dentro de
 * tres horas y con la app actualizada.
 */
export async function encolar(tipo, datos) {
  const d = await abrir()
  const op = {
    id: nuevoId(),
    tipo,
    datos,
    // La clave viaja al servidor. Es la que hace que reintentar sea seguro.
    clave: nuevoId(),
    estado: 'pendiente',
    intentos: 0,
    error: null,
    creado: Date.now(),
  }
  await d.put(TIENDA, op)
  avisar()
  return op
}

export async function pendientes() {
  const d = await abrir()
  const todo = await d.getAll(TIENDA)
  return todo.filter((o) => o.estado !== 'listo').sort((a, b) => a.creado - b.creado)
}

export async function contarPendientes() {
  return (await pendientes()).length
}

/** Los que fallaron de forma definitiva y necesitan que alguien mire. */
export async function trabados() {
  return (await pendientes()).filter((o) => o.estado === 'trabado')
}

async function guardar(op) {
  const d = await abrir()
  await d.put(TIENDA, op)
  avisar()
}

async function borrar(id) {
  const d = await abrir()
  await d.delete(TIENDA, id)
  avisar()
}

/* ── Aviso a las pantallas ─────────────────────────────────────────────────
 *
 * Un evento y no un estado de React: la cola se toca desde varias pantallas y
 * desde el despachador, que no es un componente. Con un evento, cualquiera que
 * quiera enterarse escucha, y nadie tiene que pasar props tres niveles abajo.
 */
const EVENTO = 'cola-cambio'
const avisar = () => window.dispatchEvent(new CustomEvent(EVENTO))
export const alCambiar = (fn) => {
  window.addEventListener(EVENTO, fn)
  return () => window.removeEventListener(EVENTO, fn)
}

/* ── El despacho ─────────────────────────────────────────────────────────── */

/**
 * Qué sabe hacer la cola.
 *
 * Se registran desde afuera —`registrarTipo`— en vez de importar acá el módulo
 * de instalaciones, el de inventario y el de tickets. Si los importara, este
 * archivo dependería de medio sistema y el service worker terminaría cargando
 * pantallas enteras para mandar una fila.
 *
 * Cada manejador recibe `(datos, clave)` y tiene que:
 *   · usar `clave` como `clave_idempotencia` en lo que escriba,
 *   · lanzar si el fallo es transitorio (sin red, 5xx) → se reintenta,
 *   · lanzar un error con `.definitivo = true` si no tiene sentido reintentar.
 */
const MANEJADORES = new Map()

export function registrarTipo(tipo, manejador) {
  MANEJADORES.set(tipo, manejador)
}

/**
 * ¿Este error se arregla reintentando?
 *
 * La distinción importa más de lo que parece. Reintentar para siempre algo que
 * el servidor rechaza por reglas —falta la firma, el plan no existe— convierte
 * la cola en un bucle que nunca se vacía, y el técnico ve "1 pendiente" durante
 * semanas hasta que deja de mirarlo.
 */
function esDefinitivo(err) {
  if (err?.definitivo) return true
  const code = err?.code ?? ''
  // 23505 = clave duplicada. Es el caso bueno: ya estaba guardado.
  if (code === '23505') return false
  // 42501 = RLS lo rechazó. Reintentar no va a cambiar quién es.
  if (code === '42501') return true
  // Los errores de restricción son del dato, no de la conexión.
  if (/^23/.test(code)) return true
  return false
}

/**
 * ¿Falló porque la sesión venció?
 *
 * ── El caso que esto evita ──
 *
 * El técnico trabaja toda la mañana sin señal. Cuando vuelve la cobertura, el
 * token de Supabase ya venció y hay que renovarlo. Durante esos segundos —o
 * hasta que vuelva a entrar, si el refresh también venció— las escrituras
 * fallan con un error de autenticación.
 *
 * Sin esta comprobación, el despachador corre cada minuto, quema los ocho
 * intentos en ocho minutos y marca como TRABADO el trabajo de toda la mañana.
 * El técnico ve "8 cosas no se pudieron enviar" y la única salida sería
 * descartarlas.
 *
 * Un token vencido no es un fallo de la operación: es que todavía no se pudo
 * intentar. No cuenta como intento y detiene la ronda — si la sesión no sirve
 * para la primera, no va a servir para las otras seis.
 */
const esDeSesion = (err) => {
  const code = err?.code ?? ''
  if (code === 'PGRST301' || err?.status === 401) return true
  return /jwt|token|expired|refresh/i.test(err?.message ?? '')
}

let despachando = false

/**
 * Vacía la cola.
 *
 * En serie y no en paralelo, a propósito: las operaciones de una misma orden
 * tienen orden entre sí —primero la lectura del equipo, después el cierre— y
 * mandarlas todas juntas haría que el cierre llegue antes que lo que valida.
 */
export async function despachar() {
  if (despachando || !navigator.onLine) return { enviadas: 0, quedan: await contarPendientes() }
  despachando = true
  let enviadas = 0

  try {
    for (const op of await pendientes()) {
      if (op.estado === 'trabado') continue

      const manejador = MANEJADORES.get(op.tipo)
      if (!manejador) {
        // Una operación de una versión anterior de la app, con un tipo que ya
        // no existe. No se borra en silencio: se marca para que alguien la vea.
        await guardar({ ...op, estado: 'trabado', error: `Tipo desconocido: ${op.tipo}` })
        continue
      }

      try {
        await manejador(op.datos, op.clave)
        await borrar(op.id)
        enviadas++
      } catch (err) {
        // 23505 significa que el servidor ya lo tenía. Es éxito, no error.
        if (err?.code === '23505') {
          await borrar(op.id)
          enviadas++
          continue
        }

        // La sesión vencida no cuenta como intento: no se llegó a intentar
        // nada. Y corta la ronda, porque las demás van a fallar igual.
        if (esDeSesion(err)) {
          await guardar({ ...op, error: 'Esperando que se renueve la sesión' })
          break
        }

        const intentos = op.intentos + 1
        // Ocho intentos y para. Con reintento al recuperar la señal y cada vez
        // que se abre la app, ocho fallos seguidos ya no son la conexión.
        const trabado = esDefinitivo(err) || intentos >= 8
        await guardar({
          ...op,
          intentos,
          estado: trabado ? 'trabado' : 'pendiente',
          error: err?.message ?? String(err),
        })
        // Si fue por conexión, no tiene sentido seguir con las demás.
        if (!navigator.onLine) break
      }
    }
  } finally {
    despachando = false
  }

  return { enviadas, quedan: await contarPendientes() }
}

/** Reintenta algo que quedó trabado, después de que alguien lo revisó. */
export async function reintentar(id) {
  const d = await abrir()
  const op = await d.get(TIENDA, id)
  if (!op) return
  await guardar({ ...op, estado: 'pendiente', intentos: 0, error: null })
  return despachar()
}

/**
 * Descarta una operación trabada.
 *
 * Existe porque la alternativa es peor: una cola que no se puede vaciar termina
 * ignorada. Pero es explícito y pide confirmación en la pantalla — descartar en
 * silencio sería perder el trabajo del técnico sin decírselo.
 */
export const descartar = (id) => borrar(id)

/**
 * Arranca el despachador.
 *
 * Tres disparadores, y los tres hacen falta:
 *   · `online` — el momento en que vuelve la señal.
 *   · `visibilitychange` — el técnico vuelve a la app. El evento `online` miente
 *     seguido en Android: dice que hay red cuando todavía no hay salida.
 *   · un intervalo — la red del celular pasa de "conectado" a "sin datos" sin
 *     disparar ningún evento, y ahí lo único que descubre que volvió es probar.
 */
export function arrancarCola() {
  const intentar = () => despachar().catch(() => {})

  window.addEventListener('online', intentar)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') intentar()
  })
  const t = setInterval(intentar, 60000)
  intentar()

  return () => {
    window.removeEventListener('online', intentar)
    clearInterval(t)
  }
}
