import { config } from '../config.js'
import { db, cargarRouter } from '../lib/db.js'
import { aplicarPlantilla, enviarCrudo } from './mensajeria.js'
import { credenciales } from './configMensajeria.js'
import * as mk from './mikrotikService.js'
import { detectarCaida, detectarRecuperacion } from './incidencias.js'

/**
 * Watchdog de la red: sondea los nodos y avisa cuando algo se cae.
 *
 * Tres cosas que definen cómo está escrito:
 *
 * 1. **Se pinguea desde el router, no desde el servidor.** Una antena de torre
 *    casi nunca es alcanzable desde donde corre el middleware. Preguntarle al
 *    equipo que sí tiene ruta es la diferencia entre monitorear la red y
 *    monitorear la conectividad del servidor.
 *
 * 2. **Los padres se sondean antes que los hijos.** Cuando cae la fibra de una
 *    torre, sus antenas caen en el mismo minuto. Si el hijo se evalúa primero,
 *    el padre todavía figura arriba y la caída del hijo se reporta como propia:
 *    veinte alertas por un solo corte.
 *
 * 3. **Avisar es lo último y lo más frágil.** Un fallo mandando el mensaje no
 *    puede impedir que el estado quede registrado — el historial es lo que
 *    contesta "¿a qué hora se cayó?" y tiene que existir aunque el bot de
 *    Telegram esté caído.
 */

const estado = {
  automatico: false,
  cada_minutos: null,
  // Apagado: el monitoreo detecta y deja el borrador, pero no le escribe a
  // nadie hasta que el ISP lo encienda en Ajustes → Tareas programadas.
  incidencias: { activo: false, minutos: 15 },
  ultimaCorrida: null,
  ultimoResultado: null,
  corriendo: false,
}

export const estadoNms = () => ({ ...estado })

/**
 * Ordena los nodos de arriba hacia abajo del árbol.
 *
 * La profundidad se calcula caminando la cadena de padres con un tope: un ciclo
 * de carga —A padre de B y B padre de A— colgaría el bucle, y la base no lo
 * puede prohibir sin un disparador recursivo. Con el tope, un ciclo queda al
 * final y todo lo demás se sondea bien igual.
 */
export function ordenarPorJerarquia(nodos) {
  const porId = new Map(nodos.map((n) => [n.id, n]))

  const profundidad = (nodo) => {
    let d = 0
    let actual = nodo
    const vistos = new Set()

    while (actual?.padre_id && !vistos.has(actual.id) && d < 20) {
      vistos.add(actual.id)
      actual = porId.get(actual.padre_id)
      d++
    }
    return d
  }

  return [...nodos].sort(
    (a, b) => profundidad(a) - profundidad(b) || String(a.nombre).localeCompare(String(b.nombre)),
  )
}

/**
 * Qué estado le corresponde a una medición.
 *
 * Sin respuesta es 'down'. Con respuesta pero fuera de los umbrales del nodo es
 * 'warning': el enlace está, y decir que está caído mandaría a un técnico a
 * buscar un corte que no existe.
 */
export function evaluar({ recibidos, enviados, latencia_ms }, nodo) {
  if (!enviados) return { estado: 'desconocido', perdida_pct: null }

  const perdida = Math.round(((enviados - recibidos) / enviados) * 100)
  if (recibidos === 0) return { estado: 'down', perdida_pct: 100 }

  const malo =
    perdida >= nodo.perdida_warning_pct ||
    (latencia_ms != null && latencia_ms > nodo.latencia_warning_ms)

  return { estado: malo ? 'warning' : 'up', perdida_pct: perdida }
}

/** Le pregunta al router si el nodo responde. */
async function sondearNodo(nodo, equipos) {
  if (!nodo.router_id) {
    return {
      medicion: { enviados: 0, recibidos: 0, latencia_ms: null },
      detalle: 'El nodo no tiene router desde el cual sondearlo',
    }
  }

  let equipo = equipos.get(nodo.router_id)
  if (!equipo) {
    equipo = await cargarRouter(nodo.router_id)
    equipos.set(nodo.router_id, equipo)
  }

  const paquetes = await mk.ping(equipo, { destino: nodo.ip, cantidad: config.nms.paquetes })

  const enviados = (paquetes ?? []).filter((p) => p.time || p.status)
  const respondidos = enviados.filter((p) => p.time)
  const tiempos = respondidos
    .map((p) => Number(String(p.time).replace(/[^\d.]/g, '')))
    .filter(Boolean)

  return {
    medicion: {
      enviados: enviados.length,
      recibidos: respondidos.length,
      latencia_ms: tiempos.length
        ? Math.round((tiempos.reduce((s, t) => s + t, 0) / tiempos.length) * 10) / 10
        : null,
    },
    detalle: null,
  }
}

const hora = (d) =>
  new Date(d).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'medium' })

/**
 * Qué clase de equipo es, a los efectos del aviso.
 *
 * Los de radio son EMISORES: de ellos cuelgan abonados directamente, y quien lee
 * el aviso quiere saber a cuántas casas dejó sin servicio. El resto es
 * infraestructura —la torre, el switch, la OLT— y ahí lo que importa es qué se
 * cayó y desde cuándo.
 *
 * Es la distinción que hacen las plantillas, y por eso se decide acá y no en
 * cada llamada.
 */
export function claseDeNodo(nodo) {
  return ['ptp', 'ptmp'].includes(nodo?.tipo) ? 'emisor' : 'router'
}

/** La clave de la plantilla que le toca a este aviso. */
export function plantillaDe(nodo, nuevo, canal = 'telegram') {
  const clase = claseDeNodo(nodo)
  const estado = nuevo === 'up' ? 'conectado' : 'caido'
  // La larga para el correo, la corta para el teléfono: el mismo criterio que
  // usan los avisos al abonado.
  return `${canal === 'email' ? 'mail' : 'sms'}_${clase}_${estado}`
}

/** Los datos que la plantilla puede usar. */
export function variablesDeNodo(nodo, cuando, minutos) {
  return {
    equipo: nodo.nombre ?? '',
    ip: nodo.ip ?? '',
    zona: nodo.punto ?? '',
    fecha: hora(cuando),
    // Cuántos abonados quedan sin servicio. Es el dato que convierte "se cayó
    // una antena" en "hay veintitrés casas sin internet", que es lo que hace
    // que alguien salga a la ruta.
    afectados: String(nodo.activos ?? 0),
    duracion: minutos != null ? `${Math.round(minutos)} minutos` : '',
  }
}

/**
 * El texto del aviso. Corto: se lee en la pantalla de bloqueo del celular.
 *
 * ── Por qué la plantilla es opcional ──
 *
 * Porque este aviso lo lee el equipo técnico y tiene que salir SIEMPRE. Si la
 * plantilla se borró, se desactivó, o la base no contesta, el texto de acá abajo
 * sigue funcionando. Un monitoreo que deja de avisar porque alguien editó un
 * texto no es un monitoreo.
 */
export function mensajeDe(nodo, nuevo, cuando, minutos, plantilla = null) {
  if (plantilla?.cuerpo) {
    return aplicarPlantilla(plantilla.cuerpo, variablesDeNodo(nodo, cuando, minutos))
  }

  const donde = [nodo.punto, nodo.ip].filter(Boolean).join(' · ')

  if (nuevo === 'down') {
    return `🔴 CAÍDO — ${nodo.nombre}\n${donde}\nDesde: ${hora(cuando)}`
  }
  if (nuevo === 'up') {
    const duracion = minutos != null ? `\nEstuvo caído ${Math.round(minutos)} min` : ''
    return `🟢 RECUPERADO — ${nodo.nombre}\n${donde}\nA las: ${hora(cuando)}${duracion}`
  }
  return `🟡 DEGRADADO — ${nodo.nombre}\n${donde}\nDesde: ${hora(cuando)}`
}

/**
 * Las plantillas de red, leídas una vez por corrida.
 *
 * Son ocho —cuatro conceptos por dos formatos— y una caída puede disparar veinte
 * avisos seguidos si se cae una torre con sus antenas colgando. Leerlas por cada
 * uno sería veinte consultas para el mismo texto.
 */
async function plantillasDeRed() {
  const { data } = await db()
    .from('plantillas_mensaje')
    .select('clave, asunto, cuerpo')
    .eq('activa', true)
    .in('clave', [
      'mail_router_caido', 'mail_router_conectado',
      'mail_emisor_caido', 'mail_emisor_conectado',
      'sms_router_caido', 'sms_router_conectado',
      'sms_emisor_caido', 'sms_emisor_conectado',
    ])

  return new Map((data ?? []).map((p) => [p.clave, p]))
}

/**
 * Manda el aviso y deja constancia de si salió.
 *
 * Nunca lanza: un error de mensajería no puede tumbar la corrida ni impedir que
 * se sondeen los nodos que faltan.
 */
async function avisar(nodo, nuevo, cuando, minutos, plantillas = null) {
  // Sale de Ajustes → Mensajería, con el .env como respaldo. El técnico del
  // nodo gana sobre el destino general: quien está a cargo de esa torre es el
  // que tiene que enterarse primero.
  const { nms } = await credenciales()
  const canal = nms.canal
  const destino =
    canal === 'email'
      ? nodo.tecnico_email || nms.destino
      : nodo.tecnico_telefono || nms.destino

  if (!destino) {
    return {
      enviado: false,
      motivo:
        'No hay a quién avisar: el nodo no tiene técnico y falta el destino en Ajustes → Mensajería',
    }
  }

  const plantilla = plantillas?.get(plantillaDe(nodo, nuevo, canal)) ?? null

  try {
    await enviarCrudo({
      canal,
      destino,
      asunto: plantilla?.asunto
        ? aplicarPlantilla(plantilla.asunto, variablesDeNodo(nodo, cuando, minutos))
        : `${nuevo === 'down' ? 'CAÍDA' : 'RECUPERACIÓN'} · ${nodo.nombre}`,
      cuerpo: mensajeDe(nodo, nuevo, cuando, minutos, plantilla),
    })
    return { enviado: true }
  } catch (err) {
    return { enviado: false, motivo: err.message }
  }
}

/**
 * Una pasada completa sobre todos los nodos monitoreados.
 *
 * Devuelve el resumen de lo que pasó, que es lo que muestra el tablero y lo que
 * se escribe en el log cuando corre sola.
 */
/**
 * @param incidencias  qué hacer con los abonados cuando cae un nodo.
 *                     `{ activo, minutos }` — ver `services/incidencias.js`.
 *                     Por defecto NO abre nada: solo deja el borrador.
 */
export async function sondear({ incidencias = { activo: false, minutos: 15 } } = {}) {
  if (estado.corriendo) return { salteada: true, motivo: 'Ya hay un sondeo en curso' }
  estado.corriendo = true

  try {
    const { data, error } = await db().from('v_nodos_red').select('*').eq('monitorear', true)
    if (error) throw new Error(`No se pudieron leer los nodos: ${error.message}`)

    const nodos = ordenarPorJerarquia(data ?? [])
    const equipos = new Map()
    // El estado de ESTA corrida, para decidir sobre los hijos con el dato
    // fresco y no con el que había en la base al empezar.
    const reciente = new Map()

    const cambios = []
    const avisos = []
    const fallidos = []
    // Lo que se hizo con los abonados afectados. Va aparte de `avisos`, que son
    // los del técnico: son dos públicos distintos y se leen por separado.
    const masivos = []
    let sondeados = 0

    /**
     * Los textos, una sola vez para toda la corrida.
     *
     * Si la lectura falla se sigue igual, con `null`: el aviso sale con el texto
     * de fábrica. Un monitoreo que deja de avisar porque no pudo leer una
     * plantilla no es un monitoreo.
     */
    const plantillas = await plantillasDeRed().catch(() => null)

    for (const nodo of nodos) {
      let nuevo
      let medicion = { enviados: 0, recibidos: 0, latencia_ms: null, perdida_pct: null }
      let detalle = null

      try {
        const r = await sondearNodo(nodo, equipos)
        medicion = { ...medicion, ...r.medicion }
        detalle = r.detalle
        const evaluado = evaluar(medicion, nodo)
        nuevo = evaluado.estado
        medicion.perdida_pct = evaluado.perdida_pct
        if (medicion.enviados) sondeados++
      } catch (err) {
        // No se pudo preguntar. Eso NO es que el nodo esté caído: es que no se
        // sabe. Decir "down" mandaría un técnico a una torre que está perfecta
        // porque el router intermedio no contestó.
        nuevo = 'desconocido'
        detalle = err.message
        fallidos.push({ nodo: nodo.nombre, error: err.message })
      }

      reciente.set(nodo.id, nuevo)

      const { data: cambio, error: errRpc } = await db().rpc('registrar_chequeo_nodo', {
        p_nodo_id: nodo.id,
        p_estado: nuevo,
        p_latencia: medicion.latencia_ms,
        p_perdida: medicion.perdida_pct,
        p_detalle: detalle,
      })

      if (errRpc) {
        fallidos.push({ nodo: nodo.nombre, error: `no se registró: ${errRpc.message}` })
        continue
      }
      if (!cambio) continue

      const anterior = nodo.estado
      cambios.push({ nodo: nodo.nombre, de: anterior, a: nuevo })

      // --- ¿Se avisa? ------------------------------------------------------
      // Solo caídas y recuperaciones: un 'warning' que va y viene con la lluvia
      // llenaría el teléfono sin que haya nada que ir a hacer.
      const esCaida = nuevo === 'down'
      const esRecuperacion = nuevo === 'up' && ['down', 'warning'].includes(anterior)

      /**
       * Los abonados que cuelgan de este nodo.
       *
       * ── Por qué va ANTES del `continue` de `nodo.avisar` ──
       *
       * Porque `avisar` decide si se le escribe al TÉCNICO, y son dos cosas
       * distintas: un nodo que el NOC ya mira en pantalla puede tener el aviso
       * apagado para no duplicar, y sus ciento ochenta abonados igual necesitan
       * enterarse. Colgarlo del mismo interruptor hacía que apagar el ruido
       * interno apagara también el aviso al cliente.
       *
       * ── Y por qué no importa si el padre está caído ──
       *
       * `detectarCaida` solo crea el borrador; el índice único de la migración
       * 174 impide una segunda incidencia por nodo. Pero el hijo de un padre
       * caído SÍ genera la suya, y eso es deliberado: si mañana el ISP resuelve
       * la troncal y el sector sigue abajo, la incidencia del sector ya existe
       * con su hora real de caída.
       */
      if (esCaida || esRecuperacion) {
        try {
          const r = esCaida
            ? await detectarCaida(nodo, {
                minutos: incidencias.minutos ?? 15,
                automatico: Boolean(incidencias.activo),
              })
            : await detectarRecuperacion(nodo)

          if (r) masivos.push({ nodo: nodo.nombre, ...r })
        } catch (err) {
          // Que falle la incidencia masiva no puede dejar sin avisar al técnico:
          // el técnico es quien va a arreglar el corte.
          fallidos.push({ nodo: nodo.nombre, error: `incidencia: ${err.message}` })
        }
      }

      if (!nodo.avisar || (!esCaida && !esRecuperacion)) continue

      // El padre caído explica la caída del hijo. Se mira el estado de esta
      // corrida: el de la base puede ser de hace dos minutos.
      const padreCaido = nodo.padre_id
        ? (reciente.get(nodo.padre_id) ?? nodo.estado_padre) === 'down'
        : false

      if (esCaida && padreCaido) {
        avisos.push({
          nodo: nodo.nombre,
          enviado: false,
          motivo: `Su padre ${nodo.padre} está caído: la alerta se omite`,
        })
        continue
      }

      const cuando = new Date().toISOString()
      const resultado = await avisar(nodo, nuevo, cuando, nodo.minutos_en_estado, plantillas)
      avisos.push({ nodo: nodo.nombre, estado: nuevo, ...resultado })

      if (resultado.enviado) {
        await db()
          .from('nodo_eventos')
          .update({ notificado: true, notificado_at: cuando })
          .eq('nodo_id', nodo.id)
          .is('hasta', null)
      }
    }

    const resumen = {
      nodos: nodos.length,
      sondeados,
      cambios,
      avisos,
      masivos,
      fallidos,
      corrida: new Date().toISOString(),
    }

    estado.ultimaCorrida = resumen.corrida
    estado.ultimoResultado = resumen
    return resumen
  } finally {
    estado.corriendo = false
  }
}

/**
 * Deja el watchdog corriendo cada N minutos.
 *
 * No sondea al arrancar: si el middleware se reinicia varias veces seguidas
 * —un deploy, un crash— cada arranque dispararía una pasada completa contra
 * todos los routers.
 */
export function programarNms({ cada_minutos = 2, incidencias = null } = {}) {
  estado.automatico = true
  estado.cada_minutos = cada_minutos
  // Qué hacer con los abonados cuando cae un nodo. Se guarda para poder
  // mostrarlo: "el monitoreo está encendido" y "el monitoreo le avisa a los
  // abonados" son dos cosas que se confunden fácil en una pantalla.
  estado.incidencias = incidencias ?? { activo: false, minutos: 15 }

  const tarea = setInterval(
    async () => {
      try {
        const r = await sondear({ incidencias: estado.incidencias })
        if (r.masivos?.length) {
          console.log(
            `[nms] incidencias: ${r.masivos
              .map((m) => `${m.nodo} ${m.abierta ? 'ABIERTA' : m.resuelta ? 'resuelta' : m.motivo ?? 'en borrador'}`)
              .join(' · ')}`,
          )
        }
        if (r.cambios?.length) {
          console.log(`[nms] ${r.cambios.map((c) => `${c.nodo}: ${c.de} → ${c.a}`).join(' · ')}`)
        }
      } catch (err) {
        console.error('[nms] falló el sondeo:', err.message)
      }
    },
    cada_minutos * 60_000,
  )

  tarea.unref?.()
  return tarea
}
