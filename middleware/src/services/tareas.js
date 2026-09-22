import { db } from '../lib/db.js'
import { config } from '../config.js'
import { AppError, badRequest } from '../lib/errors.js'
import { programarCortes, estadoCortes } from './cortesPromesas.js'
import { programarFacturacion, estadoFacturacion } from './facturacionMensual.js'
import { programarConsumo } from './consumoDiario.js'
import { programarNms } from './nms.js'
import { programarIncidencias, estadoIncidencias } from './incidenciasProgramadas.js'
import { programarOptica } from './opticaProgramada.js'
import { programarComisiones, estadoComisiones } from './comisionesProgramadas.js'
import { programarCartera, estadoCartera } from './carteraProgramada.js'
import { programarEsperando } from './esperandoProgramado.js'
import { programarAlertas, estadoAlertas } from './alertasProgramadas.js'
import { programarStock, estadoStock } from './stockProgramado.js'
import { programarAvisosPago, estadoAvisosPago } from './avisosPago.js'
import { programarCorteMora, estadoMora } from './corteMora.js'
import { programarFirmas, estadoFirmas } from './firmasProgramadas.js'

/**
 * Los automatismos: qué corre solo, cada cuánto y a qué hora.
 *
 * ── Por qué existe este archivo ──
 *
 * Cada automatismo sabía arrancarse a sí mismo, pero nadie guardaba su
 * temporizador. Eso alcanzaba mientras la única forma de cambiar un horario era
 * editar el .env y reiniciar. Desde una pantalla no: apagar el corte automático
 * tiene que apagarlo AHORA, no en el próximo reinicio del servidor.
 *
 * Así que los handles viven acá, y acá se los cancela y se los vuelve a armar.
 *
 * ── Lo que se guarda y lo que no ──
 *
 * Una columna en NULL significa "usá lo del archivo". No es lo mismo que false:
 * NULL es "no lo decidí", false es "lo apagué". Sin esa distinción, correr la
 * migración apagaría todos los automatismos de las instalaciones que ya estaban
 * funcionando — que es exactamente el error que ya se cometió con la licencia.
 */

/** Los temporizadores vivos. Se cancelan antes de rearmar. */
const temporizadores = {}

/**
 * Las tareas, con lo que hace falta para describirlas y para arrancarlas.
 *
 * La descripción no es adorno: es lo que le permite a alguien decidir si
 * encender algo que va a dejar gente sin internet. El campo `cuidado` marca
 * justamente esas.
 *
 * `arrancar` acepta un segundo argumento que se pasa tal cual al programador.
 * Las dos tareas diarias hacen una corrida apenas arrancan —para recuperar la
 * del día si el servidor estuvo caído a esa hora—, y sin poder sustituir ese
 * `ejecutar`, probarlas cortaría abonados y emitiría facturas de verdad.
 */
export const TAREAS = [
  {
    clave: 'cortes',
    /**
     * Se llamaba "Corte de morosos", que es indistinguible de "Corte por mora".
     *
     * Dos tareas con el mismo nombre en la misma pantalla llevan a encender una
     * creyendo que se enciende la otra — y pasó: quedó encendida esta, que solo
     * cubre las promesas incumplidas, mientras la que corta a los morosos de
     * verdad seguía apagada. Nadie lo iba a notar mirando la pantalla.
     */
    nombre: 'Corte por promesa incumplida',
    que: 'Corta a quien pidió plazo, se le devolvió el servicio, y dejó vencer la promesa sin pagar. No corta por deuda: eso lo hace "Corte por mora".',
    cuidado: 'Deja gente sin internet. Encendelo cuando ya revisaste la lista a mano y confiás en ella.',
    tipo: 'diaria',
    arrancar: (v, extra) =>
      programarCortes({ activo: v.cortes_automaticos, hora: v.cortes_hora, ...extra }),
  },
  {
    clave: 'facturacion',
    nombre: 'Facturación mensual',
    que: 'Crea la factura de cada abonado en su día de facturación. No emite nada ante el SRI.',
    cuidado: 'Empiezan a aparecer cobros solos. Encendelo con los días de facturación ya revisados.',
    tipo: 'diaria',
    arrancar: (v, extra) =>
      programarFacturacion({ activo: v.facturacion_automatica, hora: v.facturacion_hora, ...extra }),
  },
  {
    clave: 'comisiones',
    nombre: 'Comisiones: refresco y cierre mensual',
    que: 'Actualiza qué hitos alcanzó cada venta y, el día de cierre, congela el mes anterior por vendedor.',
    cuidado:
      'El cierre fija lo que se le va a pagar a cada uno. Encendelo cuando las bases y los escalones estén como los querés: un período cerrado no se recalcula.',
    tipo: 'diaria',
    arrancar: (v, extra) =>
      programarComisiones({ activo: v.comisiones_automatico, hora: v.comisiones_hora, ...extra }),
  },
  {
    clave: 'cartera',
    nombre: 'Cartera: retiros de equipo y reactivaciones',
    que: 'Abre la orden de retiro de quien llegó a la condición configurada y anota a los que volvieron a pagar.',
    cuidado:
      'Genera trabajo de campo: cada orden es una visita a la casa de un ex abonado. No mueve plata ni descuenta nada a nadie.',
    tipo: 'diaria',
    arrancar: (v, extra) =>
      programarCartera({ activo: v.cartera_automatico, hora: v.cartera_hora, ...extra }),
  },
  {
    clave: 'consumo',
    nombre: 'Medición de consumo',
    que: 'Anota cuánto consumió cada abonado, leyendo las colas del router.',
    cuidado: 'Antes de encenderlo, las colas del router tienen que emparejarse con los abonados: si no, el consumo queda adjudicado a quien no corresponde.',
    tipo: 'intervalo',
    arrancar: (v) =>
      v.consumo_automatico ? programarConsumo({ cada_minutos: v.consumo_cada_minutos }) : null,
  },
  {
    clave: 'nms',
    nombre: 'Monitoreo de red',
    que: 'Sondea los nodos y avisa cuando uno se cae o se recupera.',
    cuidado: 'Sin el árbol de dependencias cargado, el primer corte de fibra manda un mensaje por cada antena que cuelga de la torre. A partir de ahí nadie los lee.',
    tipo: 'intervalo',
    arrancar: (v) =>
      v.nms_automatico
        ? programarNms({
            cada_minutos: v.nms_cada_minutos,
            // Qué hacer con los ABONADOS cuando cae un nodo. Va acá y no en su
            // propia tarea porque quien detecta la caída es este sondeo: la
            // tarea de incidencias solo manda lo que este haya encolado.
            incidencias: {
              activo: Boolean(v.incidencias_automatico),
              minutos: v.incidencias_minutos,
            },
          })
        : null,
  },
  {
    clave: 'incidencias',
    nombre: 'Aviso de cortes masivos a los abonados',
    que: 'Manda los avisos de una avería o un mantenimiento a todos los abonados del sector afectado, y el "ya está solucionado" cuando se resuelve.',
    cuidado:
      'Le escribe a cientos de personas y no se puede desenviar. Encendela cuando ya hayas leído los textos en Ajustes → Plantillas y probado una incidencia sobre una zona chica.',
    tipo: 'intervalo',
    arrancar: (v) =>
      programarIncidencias({
        activo: Boolean(v.incidencias_cola_activa),
        cada_minutos: v.incidencias_cada_minutos,
        lote: v.incidencias_lote,
      }),
  },
  {
    clave: 'optica',
    nombre: 'Lectura óptica',
    que: 'Mide la potencia de todas las ONTs y guarda el historial. Es lo que permite ver una fibra que se degrada antes de que se corte.',
    tipo: 'intervalo',
    arrancar: (v) =>
      v.optica_automatica ? programarOptica({ cada_minutos: v.optica_cada_minutos }) : null,
  },
  {
    clave: 'alertas',
    nombre: 'Alertas en tiempo real',
    que: 'Mira la red cada pocos minutos y avisa por WhatsApp o Telegram cuando un abonado se queda sin señal o se cae una caja entera.',
    cuidado: 'Antes de encenderla hay que cargar los destinos y probarlos en Ajustes → Alertas. Encendida sin destinos no rompe nada, pero no avisa a nadie.',
    tipo: 'intervalo',
    // Recibe `extra` como las diarias: esta corre una vez apenas arranca —para
    // recuperar lo que se cayó mientras el servidor estuvo abajo— y en una
    // prueba eso mandaría alertas de verdad.
    arrancar: (v, extra) =>
      v.alertas_automaticas
        ? programarAlertas({ activo: true, cada_minutos: v.alertas_cada_minutos, ...extra })
        : null,
  },
  {
    clave: 'firmas',
    nombre: 'Vencer firmas sin completar',
    que: 'Marca vencidos los enlaces de firma que el abonado no usó dentro del plazo. Es lo que hace que el sistema deje de esperarlos y ofrezca la firma en papel.',
    cuidado:
      'No manda nada ni cancela ningún contrato: solo deja de darlos por "esperando al abonado". Sin esto, un enlace de hace un mes sigue figurando activo y a ese contrato nunca se le ofrece el papel.',
    tipo: 'intervalo',
    arrancar: (v) =>
      v.firmas_automatico
        ? programarFirmas({ activo: true, cada_minutos: v.firmas_cada_minutos })
        : null,
  },
  {
    clave: 'mora',
    nombre: 'Corte por mora y reconexión automática',
    que: 'La grande: corta a TODOS los que deben, según los meses de atraso de cada ficha, y respeta a quien tiene promesa vigente. Le devuelve el servicio al que paga, en segundos.',
    cuidado:
      'Deja gente sin internet. Antes de encenderla, mirá la corrida en seco de acá abajo y revisá que cada abonado tenga bien sus meses en la ficha: el que paga cada tres meses configurado en uno se corta el primer mes.',
    tipo: 'diaria',
    arrancar: (v, extra) =>
      programarCorteMora({
        activo: v.mora_automatico,
        hora: v.mora_hora,
        cada_segundos: v.mora_reconexion_segundos,
        cada_minutos: v.mora_barrida_minutos,
        ...extra,
      }),
  },
  {
    clave: 'avisos_pago',
    nombre: 'Avisos de pago',
    que: 'Manda los tres recordatorios de pago —antes de vencer, vencido y último antes del corte— con los textos del editor de plantillas.',
    cuidado:
      'Le escribe a los abonados. Antes de encenderla, revisá los textos en Ajustes → Editor de plantillas y probá una corrida en seco desde acá: un aviso mal redactado sale para todos a la vez.',
    tipo: 'diaria',
    arrancar: (v, extra) =>
      programarAvisosPago({ activo: v.avisos_pago_automatico, hora: v.avisos_pago_hora, ...extra }),
  },
  {
    clave: 'stock',
    nombre: 'Aviso de material por acabarse',
    que: 'Revisa el stock de cada bodega y de cada técnico, y avisa de lo que está en el mínimo o por debajo.',
    cuidado:
      'Antes de encenderla conviene cargar los mínimos en Inventario → Stock. Sin mínimos no avisa de nada; con mínimos mal puestos avisa todos los días de lo mismo.',
    tipo: 'diaria',
    arrancar: (v, extra) =>
      programarStock({ activo: v.stock_automatico, hora: v.stock_hora, ...extra }),
  },
  {
    clave: 'esperando',
    nombre: 'ONTs esperando autorización',
    que: 'Busca ONTs recién conectadas. Cada una es alguien esperando el servicio.',
    tipo: 'intervalo',
    arrancar: (v) =>
      v.esperando_automatico ? programarEsperando({ cada_minutos: v.esperando_cada_minutos }) : null,
  },
]

/** Lo que dice el archivo: el valor de arranque de cada cosa. */
const DEL_ARCHIVO = () => ({
  cortes_automaticos: config.cortes.automaticos,
  cortes_hora: config.cortes.hora,
  cortes_limite: config.cortes.limite,
  facturacion_automatica: config.facturacion.automatica,
  facturacion_hora: config.facturacion.hora,
  consumo_automatico: config.consumo.automatico,
  consumo_cada_minutos: config.consumo.cada_minutos,
  nms_automatico: config.nms.automatico,
  nms_cada_minutos: config.nms.cada_minutos,
  nms_paquetes: config.nms.paquetes,
  optica_automatica: config.optica.automatica,
  optica_cada_minutos: config.optica.cada_minutos,
  esperando_automatico: config.esperando.automatico,
  esperando_cada_minutos: config.esperando.cada_minutos,
  // Apagada por defecto. Una tarea que congela lo que se le va a pagar a alguien
  // no se enciende sola porque sí: la prende una persona cuando las bases y los
  // escalones están como los quiere.
  comisiones_automatico: false,
  comisiones_hora: '03:30',
  // La de cartera también arranca apagada, pero por otra razón: no congela
  // dinero, genera visitas. Encenderla sin que nadie sepa produciría órdenes de
  // retiro que ningún técnico está esperando.
  cartera_automatico: false,
  cartera_hora: '04:00',
  // Apagada hasta que haya destinos cargados y probados: una alerta que sale a
  // un número mal escrito es peor que ninguna, porque nadie se entera de que no
  // está llegando.
  alertas_automaticas: false,
  alertas_cada_minutos: 5,
  // Apagada hasta que los mínimos estén cargados: encendida sin mínimos no
  // avisa de nada, y con mínimos mal puestos avisa todos los días de lo mismo
  // hasta que dejan de mirarse.
  stock_automatico: false,
  stock_hora: '07:00',
  // Apagada hasta que alguien lea los tres textos: un aviso mal redactado sale
  // para todos los abonados a la vez y no se puede desenviar.
  avisos_pago_automatico: false,
  avisos_pago_hora: '09:00',
  // Apagada hasta que alguien mire la corrida en seco. Es la tarea que deja
  // gente sin internet: encenderla sin revisar los umbrales de cada ficha corta
  // al que paga cada tres meses en el primero.
  mora_automatico: false,
  mora_hora: '05:00',
  /**
   * El tope del corte por mora. `0` = sin tope: corta a todos los que
   * corresponda.
   *
   * ── Por qué NO viene con un tope puesto ──
   *
   * Estaba en 50, y era un número de prueba disfrazado de configuración: un ISP
   * con 500 morosos cortaba 50 por día y los otros 450 navegaban gratis diez
   * días. Un ISP corta a todos en una sola madrugada.
   *
   * El argumento para tener tope era el miedo a un error de configuración que
   * cortara el padrón entero. Ese miedo no se sostiene, por dos razones que se
   * comprobaron midiendo:
   *
   *   ES REVERSIBLE SOLO. Si el corte salió de una factura mal creada, se anula
   *   la factura y `v_clientes_a_reconectar` los devuelve al servicio en la
   *   barrida siguiente —quince minutos— sin que nadie toque un router.
   *
   *   NO ES UN PROBLEMA DE TIEMPO. Medido contra el router de La Maná: 9 ms por
   *   corte, unos 7000 por minuto. Cinco mil morosos son 43 segundos.
   *
   * El campo sigue existiendo para quien quiera ir despacio los primeros meses.
   */
  mora_limite: 0,
  // El pago encola la reconexión y esto la atiende: son segundos, no minutos.
  // El abonado paga en la ventanilla y se queda mirando el teléfono.
  mora_reconexion_segundos: 5,
  // Y la barrida de seguridad, que recoge lo que la cola no atrapó.
  mora_barrida_minutos: 15,
  // Apagada mientras no haya proveedor de firma contratado: sin trámites que
  // vencer, encenderla solo agrega ruido a esta pantalla.
  firmas_automatico: false,
  firmas_cada_minutos: 60,
  /**
   * Los cortes masivos, y por qué los dos interruptores están apagados.
   *
   * `incidencias_cola_activa` es el que MANDA los mensajes que ya están
   * encolados. Apagado, una incidencia abierta a mano deja su cola quieta y hay
   * que apretar "enviar ahora" — que es lo correcto los primeros días: se ve la
   * lista de destinatarios antes de que salga nada.
   *
   * `incidencias_automatico` es más fuerte todavía: deja que el MONITOREO abra
   * la incidencia por su cuenta cuando un nodo lleva caído más que el umbral. Es
   * la única cosa del sistema que le escribe a cientos de abonados sin que
   * ninguna persona haya apretado nada, y por eso arranca apagada aunque el
   * monitoreo esté encendido: primero se mira un mes de borradores para saber
   * qué habría mandado.
   */
  incidencias_cola_activa: false,
  incidencias_automatico: false,
  incidencias_minutos: 15,
  incidencias_cada_minutos: 2,
  incidencias_lote: 40,
})

async function fila() {
  const { data, error } = await db().from('config_tareas').select('*').eq('id', 1).maybeSingle()
  if (error) {
    // La migración no corrió todavía. Se sigue con el archivo, como siempre.
    console.warn('[tareas] no se pudo leer la configuración, se usa el .env:', error.message)
    return null
  }
  return data
}

/**
 * Los valores efectivos, campo por campo.
 *
 * La caída al archivo es POR CAMPO y no en bloque: quien cambió la hora del
 * corte desde la pantalla no pierde el resto de su configuración del .env.
 */
export async function valores() {
  const guardado = (await fila()) ?? {}
  const archivo = DEL_ARCHIVO()

  const efectivo = {}
  for (const [campo, valorArchivo] of Object.entries(archivo)) {
    efectivo[campo] = guardado[campo] == null ? valorArchivo : guardado[campo]
  }
  return { efectivo, guardado, archivo }
}

/**
 * Apaga todo y lo vuelve a armar con la configuración actual.
 *
 * Cancelar primero es obligatorio. Sin eso, guardar dos veces dejaría dos
 * temporizadores corriendo la misma tarea, y cada guardado agregaría uno más
 * hasta que la lectura óptica salga cada pocos segundos contra una OLT que
 * admite tres sesiones.
 */
export async function rearrancar() {
  const { efectivo } = await valores()

  for (const tarea of TAREAS) {
    if (temporizadores[tarea.clave]) {
      clearInterval(temporizadores[tarea.clave])
      delete temporizadores[tarea.clave]
    }
    try {
      const t = tarea.arrancar(efectivo)
      if (t) temporizadores[tarea.clave] = t
    } catch (err) {
      // Que una tarea no arranque no puede impedir que arranquen las demás.
      console.error(`[tareas] no se pudo arrancar ${tarea.clave}: ${err.message}`)
    }
  }

  return {
    valores: efectivo,
    // Los nombres de las que quedaron corriendo: es lo que se imprime al
    // arrancar y lo que permite ver de un vistazo si algo no encendió.
    encendidas: TAREAS.filter((t) => temporizadores[t.clave]).map((t) => t.nombre),
  }
}

/** Para la pantalla: qué está corriendo, con qué valores y cuándo corrió. */
export async function estado() {
  const { efectivo, guardado } = await valores()

  return {
    tareas: TAREAS.map((t) => ({
      clave: t.clave,
      nombre: t.nombre,
      que: t.que,
      cuidado: t.cuidado ?? null,
      tipo: t.tipo,
      activa: Boolean(efectivo[llaveActiva(t)]),
      corriendo: Boolean(temporizadores[t.clave]),
      // De dónde salió el encendido: sirve para entender por qué algo corre
      // aunque la pantalla parezca decir que no se configuró.
      desde_archivo: guardado[llaveActiva(t)] == null,
    })),
    valores: efectivo,
    ultimas_corridas: {
      cortes: estadoCortes?.ultimaCorrida ?? null,
      facturacion: estadoFacturacion?.ultimaCorrida ?? null,
      comisiones: estadoComisiones?.ultimaCorrida ?? null,
      alertas: estadoAlertas?.ultimaCorrida ?? null,
      cartera: estadoCartera?.ultimaCorrida ?? null,
      stock: estadoStock?.ultimaCorrida ?? null,
      avisos_pago: estadoAvisosPago?.ultimaCorrida ?? null,
      mora: estadoMora?.ultimaCorrida ?? null,
      firmas: estadoFirmas?.ultimaCorrida ?? null,
    },

    /**
     * Lo que salió mal en la última corrida de cada tarea.
     *
     * ── Por qué esto sube hasta el panel ──
     *
     * Un corte que falla porque el router no respondía no deja al sistema
     * mintiendo —el abonado no queda marcado como cortado si no se lo cortó— pero
     * sí deja plata en la calle: ese abonado sigue navegando sin pagar. Y al
     * revés, una reconexión fallida deja sin internet a alguien que ya pagó.
     *
     * Hasta ahora eso quedaba en el resultado de la tarea, en Ajustes → Tareas
     * programadas. Había que ir a mirarlo, y nadie va a mirar todos los días una
     * pantalla que casi siempre está bien. Uno se entera cuando llama el cliente
     * o cuando falta la plata.
     *
     * Acá sale un resumen —cuántos y quiénes— para que el panel pueda mostrarlo
     * solo cuando hay algo. Se mandan tres nombres y no la lista entera: el
     * panel necesita decir "pasó esto y mirá acá", no resolverlo.
     */
    problemas: Object.fromEntries(
      Object.entries({
        mora: estadoMora,
        cortes: estadoCortes,
        avisos_pago: estadoAvisosPago,
      }).map(([clave, estado]) => [clave, _resumenDeFallas(estado?.ultimoResultado)]),
    ),
  }
}

/**
 * Qué salió mal, en corto.
 *
 * `error` y `fallidos` son dos cosas distintas y se informan por separado: el
 * primero es la tarea que no pudo ni empezar —sin conexión a la base, por
 * ejemplo— y el segundo son los casos sueltos que fallaron dentro de una corrida
 * que sí funcionó. Mezclarlos haría que "1 problema" signifique cosas muy
 * distintas según el día.
 */
export function _resumenDeFallas(resultado) {
  if (!resultado) return null
  if (resultado.error) return { error: resultado.error, fallidos: 0, ejemplos: [] }

  const fallidos = resultado.fallidos ?? []
  return {
    error: null,
    fallidos: fallidos.length,
    ejemplos: fallidos.slice(0, 3).map((f) => ({
      cliente: f.cliente ?? f.nombre ?? null,
      accion: f.accion ?? null,
      motivo: f.error ?? f.motivo ?? null,
    })),
  }
}

/**
 * El nombre de la columna que enciende cada tarea.
 *
 * Las excepciones son de concordancia —"cortes automáticos", "facturación
 * automática", "alertas automáticas"— y no hay forma de deducirlas de la clave.
 * Hay una prueba que falla si alguna deja de existir en `config_tareas`: la de
 * `alertas` faltaba, y por eso la pantalla mostraba esa tarea como apagada
 * mientras corría — que es la peor de las dos mentiras posibles, porque invita
 * a encender lo que ya está encendido.
 */
function llaveActiva(t) {
  if (t.clave === 'cortes') return 'cortes_automaticos'
  if (t.clave === 'facturacion') return 'facturacion_automatica'
  if (t.clave === 'comisiones') return 'comisiones_automatico'
  if (t.clave === 'optica') return 'optica_automatica'
  if (t.clave === 'alertas') return 'alertas_automaticas'
  /**
   * La de incidencias tiene DOS interruptores y este es el de la tarea.
   *
   * `incidencias_cola_activa` es lo que hace que salgan los mensajes ya
   * encolados, que es lo que esta tarea hace. `incidencias_automatico` es otra
   * cosa —que el monitoreo ABRA la incidencia solo— y vive en el sondeo, no
   * acá. Sin este caso especial, la pantalla mostraría encendida la tarea por
   * un interruptor que no la enciende.
   */
  if (t.clave === 'incidencias') return 'incidencias_cola_activa'
  return `${t.clave}_automatico`
}

/** Para las pruebas: que ninguna tarea apunte a una columna que no existe. */
export const _llaveActiva = llaveActiva
export const _TAREAS = TAREAS
export const _COLUMNAS = () => Object.keys(DEL_ARCHIVO())

const COLUMNAS = Object.keys(DEL_ARCHIVO())

const HORA_VALIDA = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

/**
 * Guarda y REARRANCA.
 *
 * Las dos cosas juntas, siempre. Guardar sin rearrancar deja la pantalla
 * diciendo una cosa y el servidor haciendo otra, que es la peor forma de
 * equivocarse: nadie sospecha de lo que la pantalla confirma.
 */
export async function guardar(datos = {}) {
  const fila = {}

  for (const campo of COLUMNAS) {
    if (!(campo in datos)) continue
    let v = datos[campo]

    if (campo.endsWith('_hora')) {
      if (v && !HORA_VALIDA.test(v)) {
        throw badRequest(`${campo.replace('_', ' ')} tiene que ser una hora HH:MM, como 09:00`)
      }
      fila[campo] = v || null
      continue
    }

    /**
     * Los campos que aceptan CERO como "sin tope".
     *
     * ── Por qué están aparte ──
     *
     * Para el resto de los números, cero no significa nada: una tarea que corre
     * "cada 0 minutos" o que manda "0 paquetes" está mal configurada. Pero un
     * tope de cortes en cero sí quiere decir algo muy concreto: cortá a todos los
     * que corresponda, sin límite.
     *
     * Sin esta distinción no se podía guardar el 0 y el mensaje decía que hacía
     * falta "un número mayor que cero", que es exactamente lo contrario de lo
     * que el campo necesita.
     */
    /**
     * `cortes_limite` NO está acá aunque sea también un tope.
     *
     * La base lo declara `BETWEEN 1 AND 100000` desde la migración 62, así que un
     * cero rebota igual con un mensaje que nadie entiende. Y no hace falta: son
     * las promesas incumplidas del día, que son pocas por definición.
     */
    const CERO_ES_SIN_TOPE = ['mora_limite']

    if (
      campo.endsWith('_minutos')
      /**
       * Los `_segundos` faltaban, y por el mismo motivo que `mora_limite`.
       *
       * `mora_reconexion_segundos` caía en el último caso y se guardaba como
       * `Boolean(v)`: la base recibía "true" para una columna entera y devolvía
       * "invalid input syntax for type integer". El campo de la pantalla no se
       * podía guardar y el error no decía por qué.
       */
      || campo.endsWith('_segundos')
      || campo === 'nms_paquetes'
      || campo === 'cortes_limite'
      || CERO_ES_SIN_TOPE.includes(campo)
    ) {
      if (v === '' || v == null) {
        fila[campo] = null
        continue
      }
      const n = Number(v)
      const minimo = CERO_ES_SIN_TOPE.includes(campo) ? 0 : 1

      if (!Number.isInteger(n) || n < minimo) {
        throw badRequest(
          minimo === 0
            ? `${campo.replace(/_/g, ' ')} tiene que ser un número entero. Poné 0 para no limitar.`
            : `${campo.replace(/_/g, ' ')} tiene que ser un número entero mayor que cero`,
        )
      }
      fila[campo] = n
      continue
    }

    /**
     * Y `mora_limite` faltaba en esa lista.
     *
     * Al no estar, caía en el último caso —el de los interruptores— y se
     * guardaba como `Boolean(v)`: el tope se convertía en `true` o `false` antes
     * de llegar a una columna que es un entero. Ese es el error que no dejaba
     * guardar ningún valor.
     */

    fila[campo] = v == null ? null : Boolean(v)
  }

  if (Object.keys(fila).length) {
    fila.actualizado_en = new Date().toISOString()
    const { error } = await db().from('config_tareas').update(fila).eq('id', 1)
    if (error) {
      throw new AppError(`No se pudo guardar: ${error.message}`, {
        status: 502,
        hint: 'Si dice que no existe la tabla, falta correr la migración 62.',
      })
    }
  }

  await rearrancar()
  return estado()
}
