import 'dotenv/config'

function int(name, fallback) {
  const raw = process.env[name]
  const n = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) ? n : fallback
}

export const config = {
  port: int('PORT', 4000),

  /**
   * El puerto de la página que ve el abonado cortado.
   *
   * Va aparte de la API porque el router le manda a este puerto TODO el tráfico
   * web del cortado, con cualquier ruta: una API donde cada ruta significa algo
   * no puede convivir con un servidor que contesta lo mismo a todas.
   *
   * Se apaga poniéndolo en 0. Arranca encendido en un puerto fijo porque el
   * router tiene que apuntarle a algo estable: un puerto que cambia entre
   * instalaciones obliga a rehacer la regla del firewall en cada una.
   *
   * No es el 8080: ese lo usa media herramienta de desarrollo que existe —en
   * esta máquina ya estaba tomado por otro Node— y el choque se descubriría el
   * día que un abonado cortado vea la página de otra cosa.
   */
  portalCorte: int('PORTAL_CORTE_PORT', 8090),
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

  credentialsKey: process.env.CREDENTIALS_KEY || '',

  // Si está en true, cada request tiene que traer el access token de Supabase.
  // Importante: el middleware tiene la service_role key, así que dejarlo abierto
  // equivale a exponer la base entera.
  requireAuth: process.env.REQUIRE_AUTH !== 'false',

  /**
   * Corte automático de las promesas de pago vencidas.
   *
   * Viene apagado: dejar sin internet a un abonado es una acción que no puede
   * activarse sola por instalar el sistema. Se enciende a propósito, cuando la
   * lista de "para volver a cortar" ya se revisó a mano y se confía en ella.
   */
  cortes: {
    automaticos: process.env.CORTES_AUTOMATICOS === 'true',
    hora: process.env.CORTES_HORA || '09:00',
    limite: int('CORTES_LIMITE', 200),
  },

  /**
   * Generación mensual de facturas del sistema.
   *
   * Viene apagada: que empiecen a aparecer cobros solos por instalar el sistema
   * sería una sorpresa cara. Se enciende cuando los días de facturación de los
   * abonados ya están cargados y revisados.
   */
  facturacion: {
    automatica: process.env.FACTURACION_AUTOMATICA === 'true',
    hora: process.env.FACTURACION_HORA || '06:00',
  },

  /**
   * Recolección del consumo diario.
   *
   * Apagada por defecto, como las demás: se enciende cuando las colas del
   * router ya se emparejan con los abonados. Correrla antes llenaría la base de
   * mediciones adjudicadas a quien no corresponde.
   */
  consumo: {
    automatico: process.env.CONSUMO_AUTOMATICO === 'true',
    cada_minutos: int('CONSUMO_CADA_MINUTOS', 60),
  },

  /**
   * Monitoreo de la red (NMS / Watchdog).
   *
   * Apagado por defecto, como los demás automatismos. Acá el motivo es
   * distinto: encenderlo antes de cargar bien las dependencias padre/hijo hace
   * que el primer corte de fibra mande veinte mensajes a la vez, y a partir de
   * ahí nadie los lee más. Se enciende cuando el inventario ya tiene el árbol
   * armado.
   */
  nms: {
    automatico: process.env.NMS_AUTOMATICO === 'true',
    cada_minutos: int('NMS_CADA_MINUTOS', 2),
    // Cuántos pings por sondeo. Con menos, una pérdida puntual se lee como caída.
    paquetes: int('NMS_PAQUETES', 4),
    // Por dónde avisar y a quién, cuando el nodo no tiene técnico asignado.
    canal: process.env.NMS_CANAL || 'telegram',
    destino: process.env.NMS_DESTINO || '',
  },

  /**
   * Historial de potencia óptica.
   *
   * Los dos números que deciden cuánto crece la tabla y cuánto detalle queda.
   * 0,5 dB es más chico que la variación normal entre lecturas de un enlace
   * sano, así que una ONT estable no genera ruido; y 6 horas garantiza que
   * igual quede constancia de que se la midió y estaba bien.
   */
  optica: {
    saltoDb: Number(process.env.OPTICA_SALTO_DB ?? 0.5),
    cadaMs: int('OPTICA_CADA_MS', 6 * 60 * 60 * 1000),

    /**
     * Lectura automática de todas las OLTs.
     *
     * Es lo que hace que el historial exista: sin esto, la serie depende de que
     * alguien se acuerde de apretar el botón, y justo los días complicados
     * nadie se acuerda.
     *
     * Cada 15 minutos es un buen punto: una fibra que se degrada tarda días o
     * semanas, así que no hace falta más resolución, y a ese ritmo cada equipo
     * recibe cuatro consultas por hora — nada al lado de lo que aguanta un
     * agente SNMP.
     */
    automatica: process.env.OPTICA_AUTOMATICA !== 'false',
    cada_minutos: int('OPTICA_CADA_MINUTOS', 15),
  },

  /**
   * Barrido de ONTs esperando autorización.
   *
   * Más seguido que la óptica porque contesta otra pregunta: la óptica cambia
   * en semanas, pero una ONT recién conectada es alguien esperando el servicio.
   *
   * Cinco minutos es barato: cuando no hay candidatas —el caso normal— el
   * barrido es un solo recorrido SNMP y ni un comando por la CLI.
   */
  esperando: {
    automatico: process.env.ESPERANDO_AUTOMATICO !== 'false',
    cada_minutos: int('ESPERANDO_CADA_MINUTOS', 5),
  },

  /**
   * SNMP: la vía de lectura masiva.
   *
   * Los tiempos son bajos a propósito. Sobre UDP no hay conexión que avise que
   * el equipo dejó de contestar, así que el que pregunta pone el límite. Y como
   * se leen miles de valores por recorrido, un timeout generoso por paquete
   * multiplica el peor caso hasta volverlo inservible.
   */
  snmp: {
    timeoutMs: int('SNMP_TIMEOUT_MS', 4000),
    reintentos: int('SNMP_REINTENTOS', 1),
    // Cuántos valores pide por paquete. Más alto es más rápido, pero un lote
    // que no entra en la MTU se fragmenta y se pierde entero.
    porLote: int('SNMP_POR_LOTE', 40),
    recorridoTimeoutMs: int('SNMP_RECORRIDO_TIMEOUT_MS', 60000),

    /**
     * Cuántas veces se reintenta UN paso del recorrido antes de darlo por
     * perdido.
     *
     * Sobre UDP no hay entrega garantizada: un paquete que se pierde es normal,
     * no es una falla del equipo. Sin esto, un recorrido de quinientos valores
     * se cae entero por una sola pérdida — y se vio pasar justo después de una
     * escritura pesada, con el agente ocupado.
     *
     * Es distinto de `reintentos`, que es la retransmisión que hace la librería
     * dentro de una misma consulta.
     */
    reintentosPaso: int('SNMP_REINTENTOS_PASO', 3),
    esperaReintentoMs: int('SNMP_ESPERA_REINTENTO_MS', 700),
  },

  /**
   * El servidor TR-069 (GenieACS).
   *
   * Es lo único que puede tocar el WiFi de la ONT del abonado: la OLT sabe
   * darle servicio, pero el nombre de la red y su clave viven dentro del equipo
   * y solo se llega ahí por TR-069.
   *
   * Vacío = sin TR-069. Los cambios de WiFi quedan pedidos y alguien los aplica
   * a mano, que es como funciona hasta que el ACS tenga camino a la red de
   * gestión de las ONTs.
   */
  genieacs: {
    // El NBI, no la interfaz web: por defecto el 7557.
    url: process.env.GENIEACS_URL || '',
    // Corto a propósito: si el ACS no contesta rápido es porque no llega al
    // equipo, y hacer esperar al abonado treinta segundos para decirle que
    // quedó pendiente es peor que decírselo enseguida.
    timeoutMs: int('GENIEACS_TIMEOUT_MS', 8000),
  },

  /**
   * La licencia de esta instalación.
   *
   * El sistema se vende por abonado y se cobra por mes. Acá va lo que necesita
   * la instalación para verificar su permiso — nunca lo que haría falta para
   * emitirlo: la clave privada vive solo en la máquina del vendedor.
   */
  licencia: {
    // Con esta se VERIFICA la firma del vendedor. Es pública: publicarla no
    // habilita a nadie a fabricar licencias.
    // El \n literal se convierte en salto real: una clave PEM no entra en una
    // línea de .env de otra forma.
    clavePublica: (process.env.LICENCIA_CLAVE_PUBLICA || '').replace(/\\n/g, '\n'),

    // A dónde pedir la renovación. Vacío = solo licencias pegadas a mano, que
    // es como arranca todo vendedor antes de tener el servidor levantado.
    servidor: process.env.LICENCIA_SERVIDOR || '',

    /**
     * Días de margen después del vencimiento.
     *
     * No es un regalo: es lo que absorbe el pago hecho un viernes a la tarde
     * que se acredita el lunes. Sin margen, el cliente que pagó en fecha
     * igual amanece bloqueado, y la llamada la atiende el vendedor.
     */
    graciaDias: int('LICENCIA_GRACIA_DIAS', 3),
  },

  ssh: {
    idleMs: int('SSH_IDLE_MS', 600),
    commandTimeoutMs: int('SSH_COMMAND_TIMEOUT_MS', 15000),
    connectTimeoutMs: int('SSH_CONNECT_TIMEOUT_MS', 15000),

    /**
     * Cuánto esperar a que EMPIECE a llegar la salida, cuando lo único recibido
     * es el eco del Enter.
     *
     * El fin de un comando se detecta por silencio, y con `idleMs` en 600 ms
     * cualquier equipo que tarde en contestar parece haber terminado. Se vio
     * exactamente eso contra el MA5800-X7: `display ntp-service status` consulta
     * a su servidor antes de imprimir nada, el Enter extra volvía con un solo
     * salto de línea, y la tabla del NTP aparecía DENTRO de la salida del
     * comando siguiente. Un relevamiento que atribuye la respuesta al comando
     * equivocado es peor que uno que falla: se lee como un hallazgo.
     *
     * Solo se aplica mientras no haya llegado nada útil, así que no le agrega
     * tiempo a los comandos que contestan enseguida.
     */
    esperaSalidaMs: int('SSH_ESPERA_SALIDA_MS', 6000),

    /**
     * Reutilizar la sesión SSH de la OLT entre operaciones.
     *
     * Sin esto, cada acción —escanear un puerto, leer potencia, registrar una
     * ONU— abre su propio login y su propio logout. En el registro del equipo
     * se ve una entrada y una salida por clic, y en una OLT que admite tres
     * sesiones eso deja al operador a un paso del "exceed max sessions".
     *
     * El precio: si el middleware se cae de golpe, la sesión abierta puede
     * quedar colgada del lado del equipo hasta que lo libere su propio timeout.
     * Por eso se cierran al apagar el proceso, y por eso se puede desactivar.
     */
    sesionPersistente: process.env.SSH_SESION_PERSISTENTE !== 'false',
    /**
     * Cuánto se mantiene abierta sin uso antes de soltar la ranura del equipo.
     *
     * Tiene que ser MENOR que el timeout de sesión de la OLT. Si el equipo la
     * mata primero, el middleware sigue creyendo que la tiene: la próxima
     * operación intenta reutilizar una sesión muerta, falla, la descarta y
     * reconecta — todo eso tarda más que haber abierto una nueva de entrada.
     *
     * 45 s asume el mínimo habitual de un minuto configurado en el equipo. Si
     * en la OLT se pone otro, hay que bajar este también.
     */
    sesionIdleMs: int('SSH_SESION_IDLE_MS', 45000),

    /**
     * Latido para que la sesión ociosa no se muera en silencio.
     *
     * ── Por qué hace falta ──
     *
     * Una sesión guardada y sin usar puede morirse sin que nadie se entere: el
     * NAT del camino deja de reenviar, el equipo se reinicia, el enlace se cae.
     * El socket local sigue “abierto” y `viva()` dice que sí, porque mira el
     * canal de este lado. La próxima operación descubre la verdad, y la
     * descubre tarde.
     *
     * Con latido pasan las dos cosas que se quieren: el camino se mantiene
     * despierto, y una sesión muerta se detecta en `keepaliveCuenta` latidos en
     * vez de en la próxima acción del operador.
     *
     * Medido contra la V-SOL PROGRESO por IP pública: una sesión ociosa SIN
     * latido aguantó 5 minutos. O sea que el camino no es agresivo — pero 5
     * minutos no son ocho horas, y el latido es lo que hace segura la diferencia.
     *
     * En 0 se apaga, para un equipo que se porte mal con los latidos.
     */
    keepaliveMs: int('SSH_KEEPALIVE_MS', 20000),
    /** Cuántos latidos sin respuesta antes de dar la sesión por muerta. */
    keepaliveCuenta: int('SSH_KEEPALIVE_CUENTA', 3),

    /**
     * Cuánto esperar antes de reconectar tras descartar una sesión.
     *
     * Estas OLTs no liberan la ranura en el instante en que se cierra el
     * socket. Reconectar de inmediato se topa con la sesión anterior sin soltar
     * y el equipo rechaza el handshake, encadenando fallos en todo lo que siga.
     */
    esperaReconexionMs: int('SSH_ESPERA_RECONEXION_MS', 3000),
  },
}

/**
 * Los valores de relleno de .env.example cuentan como "sin configurar": copiar el
 * ejemplo no puede dar por buena la configuración, o el arranque dice "todo listo"
 * y el error aparece recién al primer request contra Supabase.
 */
const esRelleno = (v) =>
  !v || v.includes('xxxxxxxxxxxx') || v.includes('...') || v.includes('cambiame-por-una-frase')

/**
 * Avisa al arrancar de lo que falta, en vez de fallar recién al primer request.
 * No aborta: el endpoint /api/health sigue respondiendo para poder diagnosticar.
 */
export function checkConfig() {
  const faltantes = []
  if (esRelleno(config.supabaseUrl)) faltantes.push('SUPABASE_URL')
  if (esRelleno(config.supabaseServiceKey)) faltantes.push('SUPABASE_SERVICE_ROLE_KEY')
  if (esRelleno(config.credentialsKey)) faltantes.push('CREDENTIALS_KEY')
  return faltantes
}
