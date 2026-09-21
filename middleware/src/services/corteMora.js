import { db, cargarRouter } from '../lib/db.js'
import * as mt from './mikrotikService.js'
import { fechaLocal } from './cortesPromesas.js'
import { listasQueCortan } from './conciliacionIps.js'
import { avisarAlAbonado, drenarAvisos } from './avisosSalientes.js'
import { sincronizarAvisoPantalla } from './pantallaAviso.js'

/**
 * El corte por mora, y la reconexión.
 *
 * ── Por qué las dos cosas viven en la misma tarea ──
 *
 * Porque cortar sin reconectar es peor que no cortar. Si el corte fuera
 * automático y la reconexión quedara a mano, el abonado que paga a las nueve de
 * la mañana seguiría sin internet hasta que alguien mire una pantalla — y ese
 * alguien está ocupado. La llamada por un pago no honrado es peor que la de un
 * corte: el abonado ya cumplió, y el que quedó mal es el ISP.
 *
 * ── Por qué se reconecta ANTES de cortar ──
 *
 * Porque si la corrida se cae a la mitad, es preferible que se haya caído
 * después de devolverle el servicio a los que pagaron y antes de cortar a los
 * que deben. El orden inverso deja gente cortada que no correspondía durante un
 * día entero.
 *
 * ── Lo que este archivo NO decide ──
 *
 * A quién le toca. Eso lo contestan `v_clientes_a_cortar_por_mora` y
 * `v_clientes_a_reconectar`, que se pueden mirar sin tocar la red.
 */

export const estadoMora = {
  automaticas: false,
  hora: '05:00',
  reconexionCadaSegundos: 5,
  barridaCadaMinutos: 15,
  ultimaCorrida: null,
  ultimaReconexion: null,
  ultimoResultado: null,
}

function llegoLaHora(ahora, hora) {
  const [h, m] = String(hora ?? '05:00')
    .split(':')
    .map(Number)
  return ahora.getHours() > h || (ahora.getHours() === h && ahora.getMinutes() >= m)
}

/**
 * ¿Este router ya tiene una regla que corte por esta lista?
 *
 * Se pregunta una vez por router y por corrida: leer las reglas del firewall es
 * una consulta al equipo, y hacerla por cada moroso multiplicaría el trabajo por
 * cincuenta sin cambiar la respuesta.
 */
const cortaPorLista = new Map()

async function yaCorta(equipo, lista) {
  const clave = `${equipo.id}:${lista}`
  if (cortaPorLista.has(clave)) return cortaPorLista.get(clave)

  let respuesta = false
  try {
    const [filtro, nat] = await Promise.all([
      mt.listarReglasFilter(equipo),
      mt.listarReglasNat(equipo),
    ])
    respuesta = listasQueCortan(filtro, nat).some(
      (d) => d.lista.toLowerCase() === String(lista).toLowerCase(),
    )
  } catch {
    /**
     * Si no se pudieron leer las reglas, se contesta que SÍ corta.
     *
     * Es la respuesta prudente: equivocarse hacia "no corta" haría crear un
     * `drop` en un router que quizá ya tiene su propio mecanismo, y ese cambio
     * al firewall de un equipo con abonados es peor que un corte que no se
     * aplica. El corte que falta se ve en la próxima corrida; una regla de más
     * hay que ir a buscarla.
     */
    respuesta = true
  }

  cortaPorLista.set(clave, respuesta)
  return respuesta
}

/**
 * El comentario con el que se marca un corte de esta tarea.
 *
 * ── En días, no en meses ──
 *
 * Desde la 154 el corte se decide por la fecha de corte de cada abonado, así que
 * la mayoría de los cortes tiene menos de un mes de atraso. Con la cuenta en
 * meses, el que se cortaba al día siguiente del vencimiento quedaba anotado en el
 * router como "0 meses de atraso": un comentario que no explica nada y que hace
 * dudar de si el corte estuvo bien.
 *
 * El prefijo "Corte por mora" NO se puede cambiar: es lo que después permite
 * reconectar solo lo que cortó esta tarea —un corte por abuso o una suspensión
 * pedida por el abonado no se deshacen porque el saldo llegó a cero— y la vista
 * de reconexión lo busca tal cual.
 */
export function marcaDeCorte(dias) {
  const n = Number(dias) || 0
  return `Corte por mora · ${n} ${n === 1 ? 'día' : 'días'} de atraso`
}

/**
 * Devolver el servicio a los que ya no corresponde tener cortados.
 *
 * Está aparte del corte porque se ejecuta con otra frecuencia: cortar es una
 * decisión diaria, reconectar no puede esperar a mañana. El abonado que paga a
 * las nueve de la mañana no puede quedarse hasta las cinco del día siguiente
 * sin internet — eso es peor que el corte, porque ya cumplió.
 */
async function devolverServicio(lista, equipo) {
  const reconectados = []
  const fallidos = []

  for (const r of lista) {
    try {
      const eq = await equipo(r.router_id)

      // Se saca del address-list por su id de RouterOS si se guardó; si no, se
      // busca por dirección. Un corte hecho antes de que se guardara el id
      // igual tiene que poder deshacerse.
      if (r.routeros_id) {
        await mt.desbloquear(eq, r.routeros_id)
      } else {
        const entradas = await mt.listarBloqueos(eq, r.lista || eq.lista_morosos)
        for (const e of entradas.filter((x) => x.address === r.ip)) {
          await mt.desbloquear(eq, e['.id'])
        }
      }

      /**
       * Y sacarlo de la lista de IPv6, si la hay.
       *
       * ── Por qué esto importa más que el corte ──
       *
       * Un corte que solo alcanza a v4 deja al moroso navegando: molesto, pero
       * el cliente no se queja. Una reconexión que solo alcanza a v4 deja al que
       * PAGÓ a medias — navega por v4 y se le cae todo lo que resuelve por v6.
       * Ese sí llama, y con razón.
       *
       * Se busca por dirección y no por id: el id de la entrada v6 no se guarda
       * en `firewall_bloqueos`, que tiene una sola columna para eso.
       */
      if (eq.ipv6_activo) {
        try {
          const { data: cli } = await db()
            .from('clientes')
            .select('ipv6_prefijo')
            .eq('id', r.cliente_id)
            .single()

          if (cli?.ipv6_prefijo) {
            const listaV6 = eq.ipv6_lista_morosos || mt.LISTA_MOROSOS_V6
            const entradas = await mt.listarBloqueosIpv6(eq, listaV6)
            for (const e of entradas.filter((x) => x.address === cli.ipv6_prefijo)) {
              await mt.desbloquearIpv6(eq, e['.id'])
            }
          }
        } catch (err) {
          fallidos.push({
            cliente: r.nombre,
            motivo: `Se reconectó en IPv4 pero quedó bloqueado en IPv6: ${err.message}`,
          })
        }
      }

      await db().from('firewall_bloqueos').update({ activo: false }).eq('id', r.bloqueo_id)
      await db().from('clientes').update({ estado: 'activo' }).eq('id', r.cliente_id)

      reconectados.push({ cliente: r.nombre, ip: r.ip, saldo: r.saldo })
    } catch (err) {
      fallidos.push({ accion: 'reconectar', cliente: r.nombre, ip: r.ip, error: err.message })
    }
  }

  return { reconectados, fallidos }
}

/**
 * Atiende la cola de reconexiones.
 *
 * ── Por qué esto corre cada pocos SEGUNDOS ──
 *
 * Porque el abonado paga en la ventanilla y se queda mirando el teléfono. Los
 * sistemas que reemplazamos lo devuelven en segundos, y con razón: diez minutos
 * con el comprobante en la mano son diez minutos de desconfianza.
 *
 * Es barato porque la cola casi siempre está vacía: un disparador sobre `pagos`
 * encola SOLO cuando el que paga está cortado, así que la consulta habitual no
 * devuelve nada.
 *
 * ── Por qué la cola y no una llamada desde la pantalla ──
 *
 * Porque se cobra desde varios lugares —la ficha, la caja, el buscador— y
 * mañana desde un botón de pago en línea. Cada uno que se olvide de avisar
 * dejaría un abonado cortado que pagó, y ese olvido no da error: simplemente no
 * pasa nada. Con el disparador da igual desde dónde se cobre.
 */
export async function ejecutarReconexiones() {
  const { data, error } = await db().from('v_reconexiones_a_procesar').select('*')

  if (error) {
    // Sin la cola todavía, se cae a la barrida completa: es más lenta pero no
    // deja a nadie sin servicio mientras la migración no esté corrida.
    if (/does not exist/i.test(error.message)) return barridaCompleta()
    throw new Error(`No se pudo leer la cola de reconexiones: ${error.message}`)
  }

  if (!data?.length) return { reconectados: [], fallidos: [] }

  const routers = new Map()
  const equipo = async (id) => {
    if (!routers.has(id)) routers.set(id, await cargarRouter(id))
    return routers.get(id)
  }

  const { reconectados, fallidos } = await devolverServicio(data, equipo)

  /**
   * Los pedidos se cierran por su id, uno por uno.
   *
   * Cerrar todos los que se leyeron sería más corto y estaría mal: si uno falló
   * —el router no contesta— cerrarlo lo perdería, y ese abonado se quedaría
   * cortado hasta la barrida de mañana.
   */
  const nombresOk = new Set(reconectados.map((r) => r.cliente))
  for (const p of data) {
    if (!nombresOk.has(p.nombre)) continue
    await db()
      .from('reconexiones_pendientes')
      .update({ procesado_en: new Date().toISOString() })
      .eq('id', p.pedido_id)
  }

  for (const f of fallidos) {
    const pedido = data.find((p) => p.nombre === f.cliente)
    if (!pedido) continue
    // Se deja abierto y se anota el error: el próximo intento es en segundos.
    await db()
      .from('reconexiones_pendientes')
      .update({ error: f.error, intentos: (pedido.intentos ?? 0) + 1 })
      .eq('id', pedido.pedido_id)
  }

  return { reconectados, fallidos }
}

/**
 * La barrida completa, sin cola.
 *
 * Es la red de seguridad: mira a TODOS los cortados que ya no deberían estarlo,
 * incluidos aquellos cuyo pedido se perdió o cuya situación cambió sin que nadie
 * registrara un pago —una factura anulada, un ajuste de saldo—. Corre pocas
 * veces por hora; la cola es la que responde rápido.
 */
export async function barridaCompleta() {
  const { data, error } = await db().from('v_clientes_a_reconectar').select('*')
  if (error) throw new Error(`No se pudo leer a quién reconectar: ${error.message}`)
  if (!data?.length) return { reconectados: [], fallidos: [] }

  const routers = new Map()
  const equipo = async (id) => {
    if (!routers.has(id)) routers.set(id, await cargarRouter(id))
    return routers.get(id)
  }

  return devolverServicio(data, equipo)
}

/**
 * Una corrida.
 *
 * @param simular  true = devuelve las dos listas sin tocar la red ni la base
 */
export async function ejecutarCorteMora({ simular = false, limite = null } = {}) {
  const { data: cfg } = await db()
    .from('config_tareas')
    .select('mora_limite')
    .eq('id', 1)
    .maybeSingle()

  /**
   * El tope es una RED DE SEGURIDAD, no un cupo diario.
   *
   * ── Por qué existe ──
   *
   * Para que un error de configuración —un cambio de plan mal aplicado, una
   * anulación masiva de facturas— no deje al padrón entero sin internet en una
   * madrugada. Es la única tarea del sistema de la que no se vuelve apretando un
   * botón: hay que reconectar uno por uno y atender los reclamos.
   *
   * ── Por qué NO puede ser bajo ──
   *
   * Porque un ISP corta a todos sus morosos en una sola madrugada, como hacen
   * WispHub y MikroWISP. Con un tope de 50 y 500 morosos, se cortaban 50 por día
   * y los otros 450 seguían navegando gratis diez días — y el informe decía "50
   * cortados", sin mencionar a los que faltaban.
   *
   * `0` lo desactiva: corta a todos, sin red.
   */
  const tope = limite ?? cfg?.mora_limite ?? 500

  /**
   * Cuántos hay en TOTAL, sin el tope.
   *
   * Es lo que faltaba: sin este número, el resultado no puede distinguir entre
   * "se cortó a todos los que había" y "se cortó hasta donde llegó el tope".
   */
  const { count: totalACortar } = await db()
    .from('v_clientes_a_cortar_por_mora')
    .select('client_id', { count: 'exact', head: true })

  const consultaCortar = db().from('v_clientes_a_cortar_por_mora').select('*')

  const [rCortar, rReconectar] = await Promise.all([
    tope > 0 ? consultaCortar.limit(tope) : consultaCortar,
    db().from('v_clientes_a_reconectar').select('*'),
  ])

  if (rCortar.error) {
    const falta = /does not exist/i.test(rCortar.error.message)
    throw new Error(
      falta
        ? 'Falta la vista del corte por mora. Corré supabase/migracion-132-el-corte-por-mora.sql'
        : `No se pudo leer a quién cortar: ${rCortar.error.message}`,
    )
  }
  if (rReconectar.error) {
    throw new Error(`No se pudo leer a quién reconectar: ${rReconectar.error.message}`)
  }

  const aCortar = rCortar.data ?? []
  const aReconectar = rReconectar.data ?? []

  /**
   * Los que el tope dejó afuera.
   *
   * Se informa siempre, y en la corrida de verdad además se escribe en el log:
   * es gente que debería estar cortada y está navegando, y nadie lo va a
   * descubrir mirando un número que dice "cortados: 500".
   */
  const quedaronSinCortar = Math.max(0, (totalACortar ?? aCortar.length) - aCortar.length)

  if (simular) {
    return {
      simulado: true,
      fecha: fechaLocal(),
      pendientes_corte: aCortar,
      pendientes_reconexion: aReconectar,
      total_a_cortar: totalACortar ?? aCortar.length,
      quedaron_sin_cortar: quedaronSinCortar,
      tope,
      cortados: [],
      reconectados: [],
    }
  }

  if (quedaronSinCortar) {
    console.warn(
      `[mora] el tope de ${tope} dejó ${quedaronSinCortar} abonado(s) SIN CORTAR de `
      + `${totalACortar} que corresponden. Siguen con servicio hasta la próxima corrida. `
      + 'Subí el tope en Ajustes → Tareas si esto no es lo que esperabas.',
    )
  }

  // Un router se carga una vez por corrida aunque tenga veinte morosos: cada
  // carga descifra credenciales y golpea la base.
  const routers = new Map()
  // Lo que se sabe de las reglas vale para ESTA corrida: entre una y otra
  // alguien puede haber arreglado el router.
  cortaPorLista.clear()
  const equipo = async (id) => {
    if (!routers.has(id)) routers.set(id, await cargarRouter(id))
    return routers.get(id)
  }

  const cortados = []
  const fallidos = []

  // ── Primero devolver el servicio ──
  const { reconectados, fallidos: falloReconexion } = await devolverServicio(aReconectar, equipo)
  fallidos.push(...falloReconexion)

  // ── Y después cortar ──
  for (const c of aCortar) {
    try {
      const eq = await equipo(c.router_id)
      const lista = eq.lista_morosos || mt.LISTA_MOROSOS
      /**
       * Los días de atraso de la factura más vieja.
       *
       * Es la medida con la que se decidió el corte —la fecha de corte de la
       * ficha, ver la 154— y tiene que ser la misma que queda escrita en el
       * router: un comentario que no coincide con el motivo manda a buscar el
       * error al lugar equivocado. El `??` es para la corrida vieja, antes de la
       * 153, donde la vista no traía días.
       */
      const comentario = marcaDeCorte(c.dias_de_atraso ?? 0)

      /**
       * La entrada en la lista no corta nada por sí sola: hace falta una regla
       * que actúe sobre esa lista. Se crea SOLO si el router no tiene ya la
       * suya.
       *
       * ── Por qué no se crea siempre ──
       *
       * `asegurarReglaCorte` agrega un `drop` en la cadena forward. En un router
       * que viene de otro sistema —el de La Maná corta mandando al moroso a una
       * página de pago con un `redirect`— ese drop sería una segunda forma de
       * cortar, encima de la que ya funciona. El abonado dejaría de ver la
       * página que le dice cuánto debe y vería una pantalla en blanco.
       *
       * Se pregunta por lo que las reglas HACEN y no por su nombre, que es la
       * misma comprobación que usa la conciliación de IPs.
       */
      if (!(await yaCorta(eq, lista))) {
        await mt.asegurarReglaCorte(eq, lista)
      }

      const respuesta = await mt.bloquearIp(eq, { address: c.ip, comment: comentario, lista })

      /**
       * Y el prefijo IPv6, si este router entrega IPv6.
       *
       * ── Por qué no alcanza con cortar v4 ──
       *
       * `/ip/firewall` y `/ipv6/firewall` son dos mundos separados en RouterOS.
       * Un abonado con IPv6 andando queda bloqueado en v4 y sigue navegando por
       * v6 — y Google, YouTube, Facebook y Netflix responden por IPv6, así que
       * para él no cambia nada. El sistema anotaría el corte como hecho.
       *
       * ── Por qué no tumba el corte si falla ──
       *
       * El corte de v4 ya está aplicado en este punto. Si lo de v6 falla —el
       * paquete apagado, el equipo con una versión vieja— cortar a medias es
       * mejor que deshacer lo que funcionó, y queda anotado para que se vea.
       *
       * Es de capa 3: sirve igual para fibra y para radioenlace.
       */
      if (eq.ipv6_activo) {
        const listaV6 = eq.ipv6_lista_morosos || mt.LISTA_MOROSOS_V6
        try {
          /**
           * El prefijo se lee de `clientes`, no de la vista.
           *
           * `v_clientes_a_cortar_por_mora` se armó antes de que existiera la
           * columna y no la trae. Rehacer esa vista es tocar la consulta que
           * decide a quién se le corta el servicio — mucho riesgo por un campo
           * que se lee una vez por cortado.
           */
          const { data: cli } = await db()
            .from('clientes')
            .select('ipv6_prefijo')
            .eq('id', c.cliente_id)
            .single()

          if (cli?.ipv6_prefijo) {
            await mt.asegurarReglaCorteIpv6(eq, listaV6)
            await mt.bloquearIpv6(eq, {
              address: cli.ipv6_prefijo,
              comment: comentario,
              lista: listaV6,
            })
          }
        } catch (err) {
          fallidos.push({
            cliente: c.nombre,
            motivo: `Se cortó en IPv4 pero no en IPv6: ${err.message}`,
          })
        }
      }
      // RouterOS devuelve el id de la entrada creada como `ret`, dentro de un
      // arreglo. Sin guardarlo, deshacer el corte obliga a buscar por dirección.
      const entrada = Array.isArray(respuesta) ? respuesta[0] : respuesta

      await db().from('firewall_bloqueos').insert({
        router_id: c.router_id,
        cliente_id: c.cliente_id,
        cliente_ip: c.ip,
        tipo_accion: 'CORTAR_SERVICIO',
        comentario,
        lista,
        routeros_id: entrada?.ret ?? entrada?.['.id'] ?? null,
        activo: true,
      })

      await db().from('clientes').update({ estado: 'cortado' }).eq('id', c.cliente_id)

      /**
       * Y se le avisa que se le cortó.
       *
       * Es el mensaje que más llamadas evita: llega con la explicación y con el
       * número de cuenta, en vez de dejar al abonado adivinando por qué se quedó
       * sin internet. Va acá y no en una cola porque el corte lo hace este
       * proceso: ya sabe a quién cortó y puede decírselo en el acto.
       *
       * Que el aviso no salga no deshace el corte. Se anota y se sigue: el
       * abonado sin internet y sin aviso es un problema; dejar de cortar a los
       * demás por eso sería otro más grande.
       */
      const aviso = await avisarAlAbonado({
        cliente: { ...c, id: c.cliente_id },
        tipo: 'corte_servicio',
        variables: { saldo: `$${Number(c.saldo ?? 0).toFixed(2)}` },
      })

      cortados.push({
        cliente: c.nombre,
        ip: c.ip,
        saldo: c.saldo,
        meses: c.meses_de_atraso ?? c.meses_sin_pago,
        dias: c.dias_de_atraso ?? null,
        umbral: c.cortar_tras_meses,
        aviso: aviso.enviado ? aviso.canal : aviso.motivo,
      })
    } catch (err) {
      // Que falle un router no puede dejar sin cortar a los demás.
      fallidos.push({ accion: 'cortar', cliente: c.nombre, ip: c.ip, error: err.message })
    }
  }

  return {
    simulado: false,
    fecha: fechaLocal(),
    cortados,
    reconectados,
    fallidos,

    /**
     * Cuántos quedaron afuera por el tope.
     *
     * ── Por qué este número estaba mal ──
     *
     * Antes se calculaba así:
     *
     *     Math.max(0, aCortar.length === tope ? -1 : 0)
     *
     * que da CERO siempre: si se alcanzó el tope da `max(0, -1)` = 0, y si no,
     * `max(0, 0)` = 0. El comentario decía lo correcto —"sin esto, 50 cortados
     * con 200 pendientes parece un trabajo terminado"— y el cálculo hacía
     * exactamente lo que el comentario quería evitar.
     *
     * Ahora sale de contar cuántos hay de verdad contra cuántos se trajeron.
     */
    pendientes: quedaronSinCortar,
    total_a_cortar: totalACortar ?? aCortar.length,
    tope,
  }
}

/**
 * Arranca la tarea diaria.
 *
 * De madrugada a propósito: el corte queda hecho antes de que el abonado empiece
 * el día, y le deja la mañana entera para pagar y recuperar el servicio.
 */
let timerReconexion = null
let timerBarrida = null

export function programarCorteMora({
  activo = false,
  hora = '05:00',
  // La cola se atiende en segundos; la barrida de seguridad, en minutos.
  cada_segundos = 5,
  cada_minutos = 15,
  intervaloMs = 5 * 60 * 1000,
  ejecutar = ejecutarCorteMora,
  ejecutarReconexion = ejecutarReconexiones,
} = {}) {
  estadoMora.automaticas = activo
  estadoMora.hora = hora
  estadoMora.reconexionCadaSegundos = cada_segundos
  estadoMora.barridaCadaMinutos = cada_minutos

  /**
   * El temporizador de la reconexión se cancela SIEMPRE, encendida o apagada.
   *
   * `rearrancar` cancela el que devuelve esta función, pero este segundo se
   * guarda acá. Sin cancelarlo, cada guardado en la pantalla de tareas dejaría
   * uno más corriendo, y a la décima vez el router recibiría diez consultas
   * simultáneas cada diez minutos.
   */
  for (const t of [timerReconexion, timerBarrida]) if (t) clearInterval(t)
  timerReconexion = null
  timerBarrida = null

  if (!activo) return null

  /**
   * La reconexión, cada pocos minutos.
   *
   * Va con su propio reloj y no con el del corte porque son dos cosas
   * distintas: cortar es una decisión diaria; devolver el servicio a alguien
   * que ya pagó es urgente.
   */
  let corriendo = false

  timerReconexion = setInterval(async () => {
    /**
     * Una corrida por vez.
     *
     * A cinco segundos de intervalo, una corrida lenta —un router que no
     * contesta y tarda en dar el tiempo de espera— se solaparía con la
     * siguiente, y dos corridas intentarían reconectar al mismo abonado.
     */
    if (corriendo) return
    corriendo = true
    try {
      const r = await ejecutarReconexion()

      // La confirmación de pago viaja en el mismo latido: el abonado que acaba
      // de pagar espera el acuse mientras todavía está en la ventanilla.
      const avisos = await drenarAvisos()
      if (avisos.enviados) {
        console.log(`[avisos] ${avisos.enviados} enviados: ${avisos.detalle.map((x) => `${x.cliente} (${x.tipo})`).join(', ')}`)
      }

      if (r.reconectados.length) {
        estadoMora.ultimaReconexion = new Date().toISOString()
        console.log(
          `[mora] reconectados al instante: ${r.reconectados.map((x) => x.cliente).join(', ')}`,
        )
      }
      if (r.fallidos.length) {
        console.error(`[mora] ${r.fallidos.length} no se pudieron reconectar`)
      }
    } catch (e) {
      console.error(`[mora] reconexión: ${e.message}`)
    } finally {
      corriendo = false
    }
  }, Math.max(2, cada_segundos) * 1000)
  timerReconexion.unref?.()

  /**
   * Y la barrida completa, cada tanto.
   *
   * Es la red de seguridad de la cola: recoge al que quedó cortado porque su
   * pedido falló, o porque su situación cambió sin que nadie registrara un pago
   * —una factura anulada, un ajuste—. Va con `cada_minutos` porque no tiene
   * apuro: lo urgente ya lo resolvió la cola.
   */
  timerBarrida = setInterval(async () => {
    try {
      const r = await barridaCompleta()
      if (r.reconectados.length) {
        console.log(`[mora] barrida: ${r.reconectados.length} reconectados que la cola no atrapó`)
      }
      await db().rpc('limpiar_reconexiones_vencidas')

      /**
       * Y la pantalla de aviso previo.
       *
       * Va en la barrida y no en el latido rápido porque su respuesta cambia con
       * el CALENDARIO, no con lo que hace el abonado: hoy le toca y pasado
       * mañana ya no. Revisarlo cada cinco segundos sería preguntarle al router
       * doce veces por minuto algo que cambia una vez por día.
       */
      const pantalla = await sincronizarAvisoPantalla()
      if (pantalla.puestos?.length || pantalla.sacados?.length) {
        console.log(
          `[aviso previo] ${pantalla.puestos.length} puestos, ${pantalla.sacados.length} sacados`,
        )
      }
      for (const f of pantalla.fallidos ?? []) {
        console.error(`[aviso previo] ${f.cliente}: ${f.error}`)
      }
    } catch (e) {
      console.error(`[mora] barrida: ${e.message}`)
    }
  }, Math.max(1, cada_minutos) * 60 * 1000)
  timerBarrida.unref?.()

  const revisar = async () => {
    const ahora = new Date()
    const hoy = fechaLocal(ahora)

    if (estadoMora.ultimaCorrida === hoy) return
    if (!llegoLaHora(ahora, hora)) return

    estadoMora.ultimaCorrida = hoy
    try {
      const r = await ejecutar()
      estadoMora.ultimoResultado = r
      console.log(
        `[mora] ${r.cortados.length} cortados, ${r.reconectados.length} reconectados, ` +
          `${r.fallidos.length} fallidos`,
      )
    } catch (e) {
      estadoMora.ultimoResultado = { error: e.message }
      console.error(`[mora] ${e.message}`)
    }
  }

  const timer = setInterval(revisar, intervaloMs)
  timer.unref?.()
  revisar()

  return timer
}
