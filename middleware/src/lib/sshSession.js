import { Client } from 'ssh2'
import { config } from '../config.js'
import { AppError } from './errors.js'
import { enCola } from './cola.js'

/**
 * Sesión SSH interactiva contra una OLT.
 *
 * Las CLIs de OLT no funcionan bien con `exec` (un comando por sesión): necesitan
 * un shell interactivo porque el estado importa — `enable` → `config` →
 * `interface gpon 0/1` y recién ahí los comandos del puerto. Por eso se abre un
 * shell y se van escribiendo comandos en secuencia.
 *
 * Detección de "el comando terminó": se espera a que la salida quede en silencio
 * `idleMs` milisegundos. Es más tosco que buscar el prompt con regex, pero funciona
 * con las dos marcas sin tener que conocer el hostname de cada equipo (el prompt
 * cambia según el modelo y el modo).
 */

// Paginadores: hay que mandar un espacio para que el equipo siga escupiendo salida.
const PAGINADORES = [
  /---- More \( Press 'Q' to break \) ----/gi, // Huawei VRP
  /--More--/gi, // V-SOL
  /\bMore:\s*<space>/gi,
]

// El prompt de paginación solo puede estar al FINAL de lo recibido: es lo último
// que imprime el equipo antes de quedarse esperando. Mirar todo el buffer sería
// un error grave — el texto del paginador queda ahí para siempre, así que cada
// vez que llegan datos nuevos se volvería a mandar un espacio, inundando al
// equipo hasta que corta la sesión.
const COLA = 200

// Tope de páginas por comando. Es una red de seguridad: sin esto, un paginador
// que no se atienda bien deja el bucle mandando espacios indefinidamente.
const MAX_PAGINAS = 200

function tienePaginador(buffer) {
  const cola = buffer.slice(-COLA)
  return PAGINADORES.some((re) => {
    re.lastIndex = 0
    return re.test(cola)
  })
}

/** Saca los prompts de paginación ya atendidos, para que no se cuenten dos veces. */
function quitarPaginadores(buffer) {
  let limpio = buffer
  for (const re of PAGINADORES) {
    re.lastIndex = 0
    limpio = limpio.replace(re, '')
  }
  return limpio
}

export class SshSession {
  constructor({ host, port = 22, username, password }) {
    this.conexion = { host, port: port || 22, username, password }
    this.client = null
    this.stream = null
    this.buffer = ''
    // Error ocurrido DESPUÉS de que la sesión ya estaba abierta. Se guarda acá
    // porque en ese punto la promesa de connect() ya se resolvió: si solo se
    // llamara a reject(), el error se perdería y el comando en curso quedaría
    // esperando hasta el timeout, escondiendo la causa real.
    this.errorSesion = null
  }

  connect() {
    return new Promise((resolve, reject) => {
      const client = new Client()
      this.client = client
      let abierta = false

      const fallar = (err) => {
        try {
          client.end()
        } catch {
          /* ya estaba cerrado */
        }
        reject(traducirErrorSsh(err, this.conexion))
      }

      client.on('ready', () => {
        client.shell({ term: 'vt100', rows: 200, cols: 200 }, (err, stream) => {
          if (err) return fallar(err)
          this.stream = stream
          stream.on('data', (d) => {
            this.buffer += d.toString('utf8')
          })
          stream.stderr?.on('data', (d) => {
            this.buffer += d.toString('utf8')
          })
          stream.on('close', () => {
            if (abierta && !this.errorSesion) {
              this.errorSesion = new AppError('La OLT cerró la sesión SSH durante la operación', {
                status: 502,
                hint: 'Suele pasar si el equipo limita las sesiones simultáneas o corta por inactividad.',
              })
            }
          })
          // Damos un momento al banner de login antes de empezar a mandar comandos.
          setTimeout(() => {
            this.buffer = ''
            abierta = true
            resolve(this)
          }, 500)
        })
      })

      client.on('error', (err) => {
        if (abierta) this.errorSesion = traducirErrorSsh(err, this.conexion)
        else fallar(err)
      })

      client.connect({
        host: this.conexion.host,
        port: this.conexion.port,
        username: this.conexion.username,
        password: this.conexion.password,
        readyTimeout: config.ssh.connectTimeoutMs,

        /**
         * El latido que mantiene viva la sesión guardada.
         *
         * Sin esto, una sesión ociosa puede morirse sin avisar —el NAT del
         * camino deja de reenviar, el equipo se reinicia— y el socket local
         * sigue pareciendo abierto. El operador se entera al apretar un botón.
         *
         * Con latido, ssh2 emite `error` tras `keepaliveCountMax` intentos sin
         * respuesta; eso marca `errorSesion`, `viva()` pasa a false y el pool la
         * descarta y reconecta antes de que nadie la use.
         *
         * En 0 se apaga: hay equipos viejos que se portan mal con los latidos.
         */
        ...(config.ssh.keepaliveMs > 0
          ? {
              keepaliveInterval: config.ssh.keepaliveMs,
              keepaliveCountMax: config.ssh.keepaliveCuenta,
            }
          : {}),
        // Las OLTs suelen correr firmware viejo con algoritmos que ssh2 ya no
        // ofrece por defecto. Sin esto, la conexión falla con "no matching
        // key exchange algorithm" contra equipos reales de campo.
        algorithms: {
          kex: [
            'curve25519-sha256',
            'curve25519-sha256@libssh.org',
            'ecdh-sha2-nistp256',
            'ecdh-sha2-nistp384',
            'ecdh-sha2-nistp521',
            'diffie-hellman-group-exchange-sha256',
            'diffie-hellman-group14-sha256',
            'diffie-hellman-group16-sha512',
            'diffie-hellman-group14-sha1',
            'diffie-hellman-group1-sha1',
            'diffie-hellman-group-exchange-sha1',
          ],
          cipher: [
            'aes128-gcm@openssh.com',
            'aes256-gcm@openssh.com',
            'aes128-ctr',
            'aes192-ctr',
            'aes256-ctr',
            'aes128-cbc',
            'aes192-cbc',
            'aes256-cbc',
            '3des-cbc',
          ],
          serverHostKey: [
            'ssh-ed25519',
            'ecdsa-sha2-nistp256',
            'rsa-sha2-512',
            'rsa-sha2-256',
            'ssh-rsa',
            'ssh-dss',
          ],
          hmac: ['hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1'],
        },
      })
    })
  }

  /**
   * Escribe un comando y devuelve lo que salió hasta que la salida quedó en silencio.
   * Un comando vacío ('') manda solo un Enter — es exactamente lo que necesita el
   * "Enter extra" de Huawei VRP (ver docs/comandos-referencia.md § 2.2).
   */
  async run(
    comando,
    { esperaMinimaMs = 0, timeoutMs = config.ssh.commandTimeoutMs, maxPaginas = MAX_PAGINAS } = {},
  ) {
    if (!this.stream) throw new AppError('La sesión SSH no está abierta', { status: 500 })
    if (this.errorSesion) throw this.errorSesion

    this.buffer = ''
    this.stream.write(`${comando}\n`)

    const inicio = Date.now()
    let ultimoLargo = -1
    let ultimoCambio = Date.now()
    let paginas = 0

    while (true) {
      await esperar(100)

      // Si el equipo cortó la conexión, mejor reportarlo ya que esperar el timeout.
      if (this.errorSesion) throw this.errorSesion

      if (this.buffer.length !== ultimoLargo) {
        ultimoLargo = this.buffer.length
        ultimoCambio = Date.now()

        // Si el equipo quedó esperando en un paginador, le pedimos la página
        // siguiente. El prompt se saca del buffer al mismo tiempo: si quedara,
        // el próximo tick lo volvería a detectar y mandaríamos espacios de más.
        if (tienePaginador(this.buffer)) {
          this.buffer = quitarPaginadores(this.buffer)
          ultimoLargo = this.buffer.length
          paginas++
          if (paginas > maxPaginas) {
            throw new AppError(`"${comando}" devolvió demasiadas páginas de salida`, {
              status: 504,
              hint: 'El equipo no deja de paginar. Puede que el paginador no se esté atendiendo bien.',
              detalle: this.buffer.slice(-500),
            })
          }
          this.stream.write(' ')
          continue
        }
      }

      // Mientras lo único recibido sea el eco del Enter, el silencio no dice
      // "terminó" sino "todavía no empezó". Darlo por terminado hace que la
      // salida llegue tarde y se le atribuya al comando siguiente.
      const nadaUtil = this.buffer.trim().length === 0
      if (nadaUtil && Date.now() - inicio < esperaMinimaMs) continue

      if (Date.now() - ultimoCambio >= config.ssh.idleMs) break

      if (Date.now() - inicio >= timeoutMs) {
        throw new AppError(`Timeout esperando la respuesta de "${comando || '<enter>'}"`, {
          status: 504,
          hint: 'El equipo tardó demasiado o quedó esperando input. Revisá si el comando abre un prompt interactivo.',
          detalle: this.buffer.slice(-500),
        })
      }
    }

    return this.buffer
  }

  /**
   * ¿Sirve para otra operación?
   *
   * El canal puede haberse cerrado sin que nadie lo pidiera —la OLT corta por
   * inactividad, se cayó el enlace— y reutilizarla en ese estado haría que el
   * comando quede esperando el timeout completo antes de fallar.
   */
  viva() {
    return Boolean(this.stream) && !this.errorSesion && !this.stream.destroyed
  }

  /** Ejecuta comandos en orden y devuelve [{ comando, salida }]. */
  async runAll(comandos) {
    const resultados = []
    for (const comando of comandos) {
      resultados.push({ comando, salida: await this.run(comando) })
    }
    return resultados
  }

  /**
   * Cierre ordenado.
   *
   * Cortar el socket de golpe (client.end() inmediato) deja la sesión colgada del
   * lado del equipo. Varias OLTs admiten pocas sesiones simultáneas, así que la
   * siguiente conexión se topa con la anterior sin liberar y el equipo contesta
   * con un DISCONNECT mal formado. Por eso se sale de los modos, se cierra el
   * canal y recién después el cliente.
   */
  async close() {
    try {
      if (this.stream && !this.errorSesion) {
        // Salir de los contextos anidados (interface → config → enable) para que
        // el equipo dé la sesión por terminada en vez de dejarla abierta.
        this.stream.write('exit\nexit\nexit\n')
        await esperar(200)
        this.stream.end()
        await esperar(150)
      }
    } catch {
      /* la sesión ya estaba rota */
    }
    try {
      this.client?.end()
    } catch {
      /* nada que hacer */
    }
  }
}

/** Errores que indican que el equipo todavía estaba liberando la sesión anterior. */
const ES_TRANSITORIO = (err) =>
  // "cerró la sesión" es el texto propio de `sshSession`: lo que pasa cuando el
  // equipo da de baja la sesión por su cuenta. Sin él, un reintento configurado
  // no cubría justamente el caso más común de estas OLTs.
  /malformed|disconnect|too many|channel open failure|resource shortage|cerró la sesión/i.test(
    String(err?.message ?? err),
  )

// =============================================================================
// Sesiones reutilizadas, una por equipo
// =============================================================================
//
// Antes cada operación abría su propia sesión: escanear un puerto, leer la
// potencia y registrar una ONU eran tres logins y tres logouts seguidos. En el
// registro de la OLT se ve una entrada y una salida por clic, y en un equipo que
// admite tres sesiones eso deja al operador a un paso del "exceed max sessions".
//
// Ahora se hace login una vez y la sesión se reutiliza. Dos cosas hacen que sea
// seguro, y sin ellas esto sería peor que el problema que resuelve:
//
// 1. **El estado se normaliza al reutilizar.** Una sesión SSH contra una CLI de
//    OLT tiene modos anidados —enable → config → interface gpon 0/1—. Si la
//    operación anterior terminó dentro del puerto, la siguiente ejecutaría sus
//    comandos ahí adentro sin darse cuenta. El driver dice cómo volver al punto
//    de partida.
//
// 2. **Una sesión reutilizada que falla se descarta y se reintenta con una
//    nueva.** Es la red de seguridad: ante cualquier cosa rara, el peor caso es
//    exactamente el comportamiento anterior —una sesión fresca— y nunca ejecutar
//    comandos en el modo equivocado.

const sesiones = new Map()

const claveDe = (c) => `${c.host}:${c.port ?? 22}:${c.username}`

function programarCierre(clave) {
  const guardada = sesiones.get(clave)
  if (!guardada) return

  clearTimeout(guardada.temporizador)

  /**
   * `sesionIdleMs` en 0 = no se cierra nunca por inactividad.
   *
   * ── Cuándo conviene ──
   *
   * En un equipo que NO libera la ranura al cerrar —la V-SOL es así— abrir y
   * cerrar todo el tiempo es peor que sostener una: cada ciclo deja una sesión
   * a medio soltar, y tres ciclos seguidos agotan el tope de tres. Sostener una
   * sola gasta una ranura y deja las otras dos libres para quien entre por
   * PuTTY.
   *
   * El precio es esa ranura ocupada mientras el middleware viva, y una sesión
   * que hay que mantener despierta — de eso se encarga el latido.
   */
  if (!(config.ssh.sesionIdleMs > 0)) return

  guardada.temporizador = setTimeout(() => cerrarSesion(clave), config.ssh.sesionIdleMs)
  // Que un temporizador pendiente no mantenga vivo el proceso.
  guardada.temporizador.unref?.()
}

async function cerrarSesion(clave) {
  const guardada = sesiones.get(clave)
  if (!guardada) return

  sesiones.delete(clave)
  clearTimeout(guardada.temporizador)
  await guardada.sesion.close().catch(() => {})
}

/**
 * Cierra todas las sesiones abiertas.
 *
 * Se llama al apagar el proceso. Sin esto, una OLT sin timeout de inactividad
 * puede quedarse con la sesión colgada hasta que alguien la libere a mano desde
 * la interfaz web — que es justo el problema que este pooling viene a evitar.
 */
export async function cerrarTodasSsh() {
  await Promise.all([...sesiones.keys()].map(cerrarSesion))
}

export const sesionesSshAbiertas = () => sesiones.size

/** La sesión del equipo, nueva o reutilizada y ya devuelta a su punto de partida. */
async function obtenerSesion(credenciales, normalizar) {
  const clave = claveDe(credenciales)
  const guardada = sesiones.get(clave)

  if (guardada?.sesion?.viva()) {
    clearTimeout(guardada.temporizador)

    /**
     * Normalizar es el primer comando que se manda sobre una sesión guardada, y
     * por eso es donde se descubre que ya no sirve.
     *
     * ── El agujero que esto tapa ──
     *
     * `ejecutar` tiene una red de seguridad: si una sesión REUTILIZADA falla, la
     * descarta y prueba una vez con una nueva. Pero esa red está en el `try` que
     * envuelve a `fn`, y `normalizar` corre acá, antes — así que un fallo suyo
     * salía por el catch de "no se pudo obtener sesión", donde esa red no
     * aplica. El resultado era un error en la cara del operador por una sesión
     * que el equipo había cerrado por su cuenta.
     *
     * Y no es un caso raro. Medido contra la V-SOL PROGRESO: el equipo cierra la
     * sesión SSH después de exactamente 5 comandos, sin importar el tiempo ni el
     * volumen de salida. Con `normalizar` mandando uno por operación, la sesión
     * guardada se muere sola cada pocas acciones.
     *
     * `viva()` no alcanza para detectarlo: mira el canal local, y el equipo
     * puede haberla dado de baja sin que el socket se entere todavía.
     */
    try {
      if (normalizar) await normalizar(guardada.sesion)
      return { sesion: guardada.sesion, reutilizada: true }
    } catch {
      // Se sigue de largo y se abre una nueva. El error no se propaga: que la
      // sesión guardada ya no sirva no es un fallo de la operación que el
      // usuario pidió, es trabajo interno.
      await cerrarSesion(clave)
      return conectarNueva(credenciales, clave)
    }
  }

  // Quedó una entrada muerta: se descarta antes de crear la nueva.
  if (guardada) await cerrarSesion(clave)

  return conectarNueva(credenciales, clave)
}

/** Abre una sesión nueva y la deja guardada para la próxima operación. */
async function conectarNueva(credenciales, clave) {
  const sesion = new SshSession(credenciales)
  await sesion.connect()
  sesiones.set(clave, { sesion, temporizador: null })
  return { sesion, reutilizada: false }
}

/**
 * Ejecuta `fn(sesion)` sobre la sesión del equipo.
 *
 * Las operaciones contra una misma OLT se encolan: su CLI es con estado y dos
 * comandos entrelazados mezclarían los modos. Equipos distintos siguen
 * trabajando en paralelo.
 *
 * @param opciones.normalizar  Cómo volver al punto de partida una sesión que ya
 *                             estaba abierta. Lo provee el driver porque el
 *                             comando cambia según la marca.
 * @param opciones.reintentos  Reintentos ante errores transitorios del equipo.
 */
export function conSesionSsh(credenciales, fn, opciones = {}) {
  const clave = claveDe(credenciales)
  return enCola(clave, () => ejecutar(clave, credenciales, fn, opciones))
}

async function ejecutar(clave, credenciales, fn, { normalizar, reintentos = 0 } = {}) {
  // Sin pooling: el comportamiento de siempre, una sesión por operación.
  if (!config.ssh.sesionPersistente) return abrirYEjecutar(credenciales, fn, { reintentos })

  let ultimoError
  let yaReintentoPorReutilizada = false

  for (let intento = 0; ; intento++) {
    let sesion
    let reutilizada

    try {
      ;({ sesion, reutilizada } = await obtenerSesion(credenciales, normalizar))
    } catch (err) {
      await cerrarSesion(clave)
      ultimoError = err
      if (intento < reintentos && ES_TRANSITORIO(err)) {
        await esperar(1500)
        continue
      }
      throw err
    }

    try {
      const resultado = await fn(sesion)
      // Salió bien: se deja abierta para la próxima operación.
      programarCierre(clave)
      return resultado
    } catch (err) {
      ultimoError = err
      await cerrarSesion(clave)

      // Una sesión reutilizada que falla puede haber quedado en un modo que no
      // esperábamos. Se descarta y se prueba UNA vez con una nueva: si el
      // problema era el estado, esto lo resuelve; si era del equipo, el error
      // vuelve igual pero ya sin la duda.
      //
      // Con una pausa antes de reconectar, y no es un detalle: estas OLTs no
      // liberan la ranura en el instante en que se cierra el socket. Reconectar
      // de inmediato se topa con la sesión anterior sin soltar y el equipo
      // rechaza el handshake — y a partir de ahí rebota todo lo que siga.
      // Medido contra una V-SOL real: sin la pausa, las tres operaciones
      // posteriores fallaron en menos de 250 ms cada una.
      if (reutilizada && !yaReintentoPorReutilizada) {
        yaReintentoPorReutilizada = true
        await esperar(config.ssh.esperaReconexionMs)
        continue
      }

      if (intento < reintentos && ES_TRANSITORIO(err)) {
        await esperar(1500)
        continue
      }
      throw err
    }
  }
}

/** Una sesión por operación: se abre, se ejecuta y se cierra siempre. */
async function abrirYEjecutar(credenciales, fn, { reintentos = 0 } = {}) {
  let ultimoError

  for (let intento = 0; intento <= reintentos; intento++) {
    if (intento > 0) await esperar(1500)

    const sesion = new SshSession(credenciales)
    try {
      await sesion.connect()
    } catch (err) {
      ultimoError = err
      if (ES_TRANSITORIO(err)) continue
      throw err
    }

    try {
      return await fn(sesion)
    } catch (err) {
      ultimoError = err
      if (intento < reintentos && ES_TRANSITORIO(err)) continue
      throw err
    } finally {
      await sesion.close()
    }
  }

  throw ultimoError
}

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function traducirErrorSsh(err, { host, port }) {
  const msg = String(err?.message || err)

  if (err?.code === 'ECONNREFUSED') {
    return new AppError(`La OLT ${host}:${port} rechazó la conexión SSH`, {
      status: 502,
      hint: 'Verificá que el servicio SSH esté habilitado y que el puerto sea el correcto.',
    })
  }
  if (err?.code === 'ETIMEDOUT' || /timed? out/i.test(msg)) {
    return new AppError(`No hay respuesta de ${host}:${port}`, {
      status: 504,
      hint: 'La OLT no es alcanzable desde donde corre el middleware (ruta, VLAN de gestión o firewall).',
    })
  }
  if (err?.code === 'ENOTFOUND' || err?.code === 'EHOSTUNREACH') {
    return new AppError(`No se puede resolver o alcanzar ${host}`, { status: 502 })
  }
  if (/All configured authentication methods failed/i.test(msg)) {
    return new AppError('Usuario o contraseña incorrectos para la OLT', {
      status: 401,
      hint: 'Revisá las credenciales guardadas para esta OLT.',
    })
  }
  if (/no matching/i.test(msg)) {
    return new AppError('La OLT usa algoritmos SSH que este cliente no acepta', {
      status: 502,
      hint: 'Firmware muy viejo. Habría que agregar el algoritmo a la lista en sshSession.js.',
      detalle: msg,
    })
  }
  // El equipo manda un SSH_MSG_DISCONNECT que no cumple el formato del protocolo
  // (le falta el campo de idioma), así que ssh2 no puede leer el motivo y lo
  // reporta como paquete mal formado. Con PuTTY el mismo caso se ve completo:
  //   disconnect type 11 (by application): "exceed max sessions"
  // Por eso acá se traduce al motivo real en vez de repetir el error de la librería.
  if (/malformed DISCONNECT|Malformed packet/i.test(msg)) {
    return new AppError(`La OLT llegó a su máximo de sesiones SSH (${host})`, {
      status: 503,
      hint:
        'El equipo rechaza conexiones nuevas hasta liberar las abiertas ("exceed max sessions"). ' +
        'Estas OLTs suelen tener Max Sessions = 3 como tope del firmware. ' +
        'Cerrá las sesiones que tengas abiertas (PuTTY, otra pestaña, otro operador). ' +
        'Si el equipo no tiene timeout de inactividad, las sesiones colgadas NO se liberan solas: ' +
        'desde la interfaz web, en System Configuration → SSH, poné SSH en Disable, Submit, y volvé a Enable. ' +
        'Eso corta las sesiones sin afectar el tráfico de los clientes.',
      detalle: msg,
    })
  }
  if (/exceed max sessions/i.test(msg)) {
    return new AppError(`La OLT llegó a su máximo de sesiones SSH (${host})`, {
      status: 503,
      hint: 'Esperá a que se liberen las sesiones abiertas, o cerralas desde la consola del equipo.',
      detalle: msg,
    })
  }
  if (/too many|resource shortage|channel open failure/i.test(msg)) {
    return new AppError(`La OLT no acepta más sesiones SSH (${host})`, {
      status: 502,
      hint: 'Cerrá las sesiones abiertas contra el equipo y reintentá.',
      detalle: msg,
    })
  }
  return new AppError(`Error SSH contra ${host}: ${msg}`, { status: 502 })
}
