import { normalizarHuawei, stripAnsi, cursorForwardASeparador } from '../lib/ansi.js'
import { normalizarSn } from '../lib/sn.js'

/**
 * Parsers de la salida de una OLT Huawei (MA5800, VRP).
 *
 * La CLI VRP mezcla dos formatos:
 *   - Tablas con separadores de guiones (display ont info <port> all)
 *   - Bloques "clave : valor" (display ont autofind, optical-info, version)
 *
 * Todos los parsers son tolerantes: si la salida no tiene el formato esperado
 * devuelven vacío en vez de romper, porque el firmware cambia el ancho de las
 * columnas entre versiones.
 */

const ES_SEPARADOR = (l) => /^[\s-]{5,}$/.test(l)

/** true si la OLT contestó que no hay nada (no es un error real). */
export function sinResultados(salida) {
  return /do not exist|Failure: The automatically found ONTs do not exist|The required ONT does not exist/i.test(
    salida,
  )
}

/** Extrae "clave : valor" de un bloque de texto. Devuelve un Map en minúsculas. */
function paresClaveValor(texto) {
  const mapa = new Map()
  for (const linea of texto.split('\n')) {
    const m = linea.match(/^\s*([A-Za-z][A-Za-z0-9 /()\-.#]*?)\s*:\s*(.*)$/)
    if (!m) continue
    const clave = m[1].trim().toLowerCase()
    const valor = m[2].trim()
    if (clave) mapa.set(clave, valor)
  }
  return mapa
}

const num = (v) => {
  if (v == null) return null
  const m = String(v).match(/-?\d+(\.\d+)?/)
  return m ? Number.parseFloat(m[0]) : null
}

/** Prefijo "0/ 6/0   12  " de cualquiera de las dos tablas. */
const PREFIJO_FILA = /^\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s+(\d+)\s+/

/**
 * Fila de estado. El número de serie tiene que PARECER un número de serie.
 *
 * Esa exigencia es la que arregla el bug: una fila de descripción como
 *
 *     0/ 6/0    0   MOLINA GARCIA FULTON ORFAY_descr_Selvalegre Frente al
 *
 * encajaba perfecto en la forma genérica —F/S/P, ONT-ID y cinco palabras
 * sueltas— y pisaba la fila buena dejando "MOLINA" como número de serie. No
 * dependía de que la ONT estuviera caída, como parecía: dependía de cuántas
 * palabras tuviera la descripción.
 */
const FILA_ESTADO = new RegExp(
  PREFIJO_FILA.source +
    /([0-9A-Fa-f]{12,16}|[A-Za-z0-9]{4}[0-9A-Fa-f]{8})\s+(\S+)\s+(online|offline)\s+(\S+)(?:\s+(\S+))?(?:\s+(\S+))?\s*$/
      .source,
  'i',
)

const ENCABEZADO_ESTADO = /F\/S\/P\s+ONT\s+SN/i
const ENCABEZADO_DESCRIPCION = /F\/S\/P\s+ONT-?\s*ID\s+Description/i

/**
 * `display ont info <portid> all`
 *
 * La salida trae DOS tablas, una detrás de la otra: primero el estado de cada
 * ONT y después su descripción. Se leen por sección —siguiendo el encabezado que
 * imprime el equipo— y no tratando de adivinar qué es cada línea por su forma.
 * Adivinando fue exactamente como se coló el bug de arriba.
 *
 * La otra trampa son las descripciones largas: el equipo las parte en varias
 * líneas, y a veces corta al medio de una palabra.
 *
 *     0/ 6/0    0   MOLINA GARCIA FULTON ORFAY_descr_Selvalegre Frente al␣␣␣
 *                   estadio
 *     0/ 6/0    1   HERRERA_..._descr_Via_San_G
 *                   erardo_Recinto_Selvalegre_...
 *
 * La diferencia entre las dos está en los espacios del final: cuando cortó en un
 * borde de palabra deja relleno, y cuando cortó al medio no. Por eso acá NO se
 * usa `normalizarHuawei`, que recorta el final de cada línea: ese relleno es el
 * único dato que dice si al unir hay que poner un espacio o no.
 */
export function parseOntInfoAll(salidaCruda) {
  // Limpieza de ANSI SIN recortar el final de las líneas.
  const salida = stripAnsi(cursorForwardASeparador(String(salidaCruda ?? ''), ' ')).replace(/\r/g, '')
  if (sinResultados(salida)) return []

  const onts = new Map()
  const descripciones = new Map()

  let seccion = 'estado'
  let ultimaOnt = null
  // Dónde empieza el texto de la descripción. Se aprende de la fila de datos y
  // se reusa para sus continuaciones, en vez de fijarlo: el ancho cambia según
  // cuántos dígitos tenga el ONT-ID.
  let columnaTexto = 0

  for (const linea of salida.split('\n')) {
    if (ENCABEZADO_ESTADO.test(linea)) {
      seccion = 'estado'
      ultimaOnt = null
      continue
    }
    if (ENCABEZADO_DESCRIPCION.test(linea)) {
      seccion = 'descripcion'
      ultimaOnt = null
      // La columna del texto se toma del ENCABEZADO y no de la primera fila de
      // datos. El equipo intercala saltos de cursor a mitad de la salida y al
      // limpiarlos queda un bloque de espacios que corre esa fila a la derecha:
      // midiendo contra ella, la continuación se cortaba contra un ancho falso
      // y la dirección del abonado quedaba trunca en "…_descr_Via".
      const m = linea.match(/^(.*?)Description/i)
      if (m) columnaTexto = m[1].length
      continue
    }
    if (ES_SEPARADOR(linea)) {
      ultimaOnt = null
      continue
    }

    if (seccion === 'estado') {
      const fila = linea.match(FILA_ESTADO)
      if (!fila) continue

      const [, frame, slot, puerto, ontId, sn, controlFlag, runState, configState, matchState, protectSide] = fila
      onts.set(ontId, {
        frame: Number(frame),
        slot: Number(slot),
        puerto: Number(puerto),
        ontId: Number(ontId),
        // Se guarda como está en la etiqueta del equipo, no en el hexadecimal
        // crudo que imprime la CLI. Son el mismo número y compararlos sin
        // normalizar da "no existe" para una ONT que sí está.
        sn: normalizarSn(sn),
        controlFlag,
        runState: runState.toLowerCase(),
        configState,
        matchState: matchState ?? null,
        protectSide: protectSide ?? null,
        descripcion: null,
        estado: /^online$/i.test(runState) ? 'online' : 'offline',
      })
      continue
    }

    // --- Sección de descripciones ---
    const prefijo = linea.match(PREFIJO_FILA)
    if (prefijo) {
      ultimaOnt = prefijo[4]
      // Acá sí se corta por el prefijo: la expresión encuentra el F/S/P esté
      // donde esté, así que funciona aunque la fila venga corrida.
      // Se conserva el relleno del final TAL CUAL: hace falta para saber cómo
      // unir la línea siguiente.
      if (!columnaTexto) columnaTexto = prefijo[0].length
      descripciones.set(ultimaOnt, linea.slice(prefijo[0].length))
      continue
    }

    // Continuación: no trae F/S/P, solo el texto alineado bajo la columna.
    //
    // Se corta por la columna y NO se recortan los espacios del principio. Suena
    // a detalle y no lo es: cuando el equipo llena la columna justo hasta el
    // final de una palabra, empuja el espacio separador al comienzo de la línea
    // siguiente. Recortándolo, "…descr_Recinto" + "Nuevo Amanecer" quedaba como
    // "RecintoNuevo Amanecer" — con la dirección del abonado mal escrita.
    if (ultimaOnt !== null && linea.trim()) {
      let trozo = linea.slice(columnaTexto)
      // Si también esta línea vino corrida, cortar por la columna la vaciaría.
      // Se cae a unir con un espacio: se pierde el detalle de si el corte fue
      // al medio de una palabra, pero no se pierde el texto.
      if (!trozo.trim()) trozo = ` ${linea.trim()}`
      descripciones.set(ultimaOnt, (descripciones.get(ultimaOnt) ?? '') + trozo)
    }
  }

  for (const [ontId, texto] of descripciones) {
    const ont = onts.get(ontId)
    if (!ont) continue
    // Recién ahora se colapsa el relleno: los espacios de más ya hicieron su
    // trabajo separando lo que había que separar.
    const limpio = texto.replace(/\s+/g, ' ').trim()
    ont.descripcion = limpio && limpio !== '-' ? limpio : null
  }

  return [...onts.values()]
}

/**
 * `display ont autofind <portid>`
 *
 * Bloques "clave : valor", uno por ONT no registrada, separados por líneas de guiones.
 */
/** El equipo escribe "-" cuando no tiene el dato. Eso es null, no un guion. */
const guionANada = (v) => {
  const s = (v ?? '').trim()
  return !s || s === '-' ? null : s
}

/**
 * "2026-08-03 23:27:12-05:00" → Date.
 *
 * Se respeta el huso que manda el equipo en vez de suponer el nuestro: una ONT
 * detectada a las 23:27 en -05:00 no es la misma hora que a las 23:27 acá, y
 * equivocarse desplaza el "hace cuánto" varias horas.
 */
const aFecha = (v) => {
  const s = guionANada(v)
  if (!s) return null
  const fecha = new Date(s.replace(' ', 'T'))
  return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString()
}

export function parseAutofind(salidaCruda) {
  const salida = normalizarHuawei(salidaCruda)
  if (sinResultados(salida)) return []

  const bloques = salida
    .split(/^[\s-]{10,}$/m)
    .map((b) => b.trim())
    .filter((b) => /ont\s*sn/i.test(b))

  return bloques
    .map((bloque) => {
      const kv = paresClaveValor(bloque)
      // "485754439ABCDEF0 (HWTC-9ABCDEF0)" → nos quedamos con el SN hexadecimal
      const snCrudo = kv.get('ont sn') || ''
      const sn = (snCrudo.match(/^[0-9A-Fa-f]{12,16}/)?.[0] || snCrudo.split(' ')[0] || '').toUpperCase()
      const fsp = kv.get('f/s/p') || ''
      const [frame, slot, puerto] = fsp.split('/').map((p) => Number.parseInt(p.trim(), 10))

      return {
        sn,
        fsp,
        frame: Number.isFinite(frame) ? frame : null,
        slot: Number.isFinite(slot) ? slot : null,
        puerto: Number.isFinite(puerto) ? puerto : null,
        vendorId: kv.get('vendorid') || null,
        equipmentId: kv.get('ont equipmentid') || null,
        version: kv.get('ont version') || null,
        softwareVersion: kv.get('ont softwareversion') || null,
        loid: kv.get('loid') || null,
        // Desde cuándo la está viendo el equipo. Es el dato que contesta la
        // pregunta que importa cuando aparece una ONT sin autorizar: ¿se acaba
        // de conectar recién, o lleva seis días esperando que alguien la mire?
        //
        // Viene como "2026-08-03 23:27:12-05:00", con el huso del equipo.
        detectadaEn: aFecha(kv.get('ont autofind time')),
        mac: guionANada(kv.get('ont mac')),
        equipoSn: guionANada(kv.get('ont equipment sn')),
      }
    })
    .filter((o) => o.sn)
}

/** `display ont optical-info <portid> <ontid>` */
export function parseOpticalInfo(salidaCruda) {
  const salida = normalizarHuawei(salidaCruda)
  if (sinResultados(salida)) return null

  const kv = paresClaveValor(salida)
  const buscar = (...claves) => {
    for (const [k, v] of kv) {
      if (claves.some((c) => k.includes(c))) return v
    }
    return null
  }

  const rx = num(buscar('rx optical power'))
  const tx = num(buscar('tx optical power'))
  if (rx == null && tx == null) return null

  return {
    rxPowerDbm: rx,
    txPowerDbm: tx,
    temperaturaC: num(buscar('temperature')),
    voltajeV: num(buscar('voltage')),
    corrienteMa: num(buscar('laser bias current', 'bias current')),
    // La OLT también reporta cuánta potencia recibe ELLA desde la ONT
    olrRxPowerDbm: num(buscar('olt rx ont optical power', 'rx power of olt')),
  }
}

/** `display ont version <portid> <ontid>` */
export function parseOntVersion(salidaCruda) {
  const salida = normalizarHuawei(salidaCruda)
  if (sinResultados(salida)) return null

  const kv = paresClaveValor(salida)

  // El mismo dato se llama distinto según el comando que lo devuelva:
  //
  //   display ont autofind → "Ont EquipmentID"  "VendorID"
  //   display ont version  → "Equipment-ID"     "Vendor-ID"
  //
  // Conocer una sola forma dejaba el modelo en null justo para las ONTs ya
  // autorizadas —que son todas— y el listado mostraba la columna vacía como si
  // el equipo no lo supiera.
  const buscar = (...claves) => {
    for (const c of claves) {
      const v = kv.get(c)
      if (v) return v
    }
    return null
  }

  const declarado = buscar('ont equipmentid', 'equipmentid', 'equipment-id')
  if (!declarado && kv.size === 0) return null

  // El Equipment-ID a veces viene recortado de fábrica. Un HG8310M con firmware
  // V3R015 lo devuelve como "310M", y el mismo aparato con V3R017 lo devuelve
  // entero. Sin corregirlo quedan dos modelos en el catálogo para un solo
  // equipo, y a uno de los dos hay que cargarle la foto y los puertos otra vez.
  //
  // La descripción del producto SÍ trae el nombre completo:
  //
  //   Equipment-ID          : 310M
  //   OntProductDescription : HG8310M GPON/EPON Terminal (CLASS C+/PX20+…)
  //
  // Se completa solo cuando la descripción contiene una palabra que TERMINA con
  // lo declarado y es más larga. Es deliberadamente estricto: así corrige un
  // recorte y no reemplaza un modelo por otro que se le parezca.
  const modelo = completarConLaDescripcion(declarado, buscar('ontproductdescription'))

  return {
    modelo,
    ...(modelo !== declarado ? { modelo_declarado: declarado } : {}),
    vendorId: buscar('ont vendor id', 'vendorid', 'vendor-id'),
    versionHardware: buscar('ont version', 'ont main hardware version'),
    versionSoftware: buscar('ont softwareversion', 'main software version'),
    mac: buscar('ont mac'),
    equipoSn: buscar('ont equipment sn'),
    productoId: buscar('product-id', 'productid'),
  }
}

/** Distancia: aparece en `display ont info <port> <ont>` como "ONT distance(m)". */
export function parseDistancia(salidaCruda) {
  const salida = normalizarHuawei(salidaCruda)
  const m = salida.match(/ONT\s+distance\s*\(m\)\s*:\s*(\d+)/i)
  return m ? Number.parseInt(m[1], 10) : null
}

/**
 * Por qué se cayó la ONT la última vez.
 *
 * Es lo único que distingue un corte de luz en la casa del abonado de una fibra
 * cortada: las dos llegan a la OLT como pérdida de señal. Cuando se va la luz,
 * la ONT alcanza a mandar un último aviso —el "dying gasp"— y la OLT lo anota
 * como causa. Sin esto, el técnico sale a buscar un empalme roto que no existe.
 *
 * Los nombres cambian entre versiones de VRP: unas dicen `dying-gasp`, otras
 * `dying gasp` y otras `power off`. Se normalizan a tres casos.
 */
const CAUSAS = [
  { patron: /dying[\s-]?gasp|power[\s-]?off/i, causa: 'power_off' },
  { patron: /\bLOS(i|f)?\b|loss\s+of\s+signal/i, causa: 'los' },
  { patron: /deactive|de-?activ/i, causa: 'desactivada' },
  { patron: /reboot|reset/i, causa: 'reinicio' },
]

/**
 * @returns {{ causa: string|null, causaCruda: string|null, ultimaCaida: string|null }}
 *   `causa` es 'power_off' | 'los' | 'desactivada' | 'reinicio' | 'otra'.
 */
export function parseCausaCaida(salidaCruda) {
  const salida = normalizarHuawei(salidaCruda)

  const m = salida.match(/Last\s+down\s+cause\s*:\s*(.+?)\s*$/im)
  const cruda = m ? m[1].trim() : null

  const fecha = salida.match(/Last\s+down\s+time\s*:\s*(.+?)\s*$/im)
  // "-" es lo que devuelve la OLT cuando nunca se cayó.
  const ultimaCaida = fecha && fecha[1].trim() !== '-' ? fecha[1].trim() : null

  if (!cruda || cruda === '-') return { causa: null, causaCruda: null, ultimaCaida }

  const encontrada = CAUSAS.find((c) => c.patron.test(cruda))
  return { causa: encontrada ? encontrada.causa : 'otra', causaCruda: cruda, ultimaCaida }
}

/**
 * Detecta si la OLT rechazó el comando.
 * VRP responde con "Failure: ..." o "% Unknown command" en vez de un exit code.
 */
export function detectarFallo(salidaCruda) {
  const salida = normalizarHuawei(salidaCruda)
  if (sinResultados(salida)) return null
  // Cualquier línea que empiece con "%" es un rechazo de VRP, y además el
  // "Failure:" que usa para los errores de negocio.
  //
  // Antes se listaban solo tres formas —Unknown command, Parameter error y
  // Failure— y faltaba "% Incomplete command". El efecto no fue cosmético: al
  // crear una traffic table sin la política de prioridad, el equipo contestaba
  // "% Incomplete command", el sistema lo daba por bueno, y el plan quedaba
  // apuntando a una tabla que nunca existió. Enumerar los errores conocidos
  // deja pasar el que todavía no se vio.
  const m = salida.match(/^\s*(Failure:.*|%.*)$/im)
  return m ? m[1].trim() : null
}

/**
 * La IP de gestión de una ONT.
 *
 *   ONT IP host index        : 0
 *   ONT config type          : Static config
 *   ONT IP                   : 192.168.240.225
 *   ONT subnet mask          : 255.255.255.0
 *   ONT gateway              : 192.168.240.1
 *   ONT primary DNS          : 8.8.8.8
 *   ONT slave DNS            : 8.8.4.4
 *   ONT manage VLAN          : 999
 *
 * Es la dirección por la que el ACS le habla a la ONT para configurarle el
 * PPPoE. Se lee después de escribirla: que el comando no diera error no
 * significa que el equipo la haya tomado.
 */
export function parseOntIpconfig(salida) {
  const texto = normalizarHuawei(salida)
  const buscar = (etiqueta) => {
    const m = texto.match(new RegExp(String.raw`ONT\s+${etiqueta}\s*:\s*(\S+)`, 'i'))
    const v = m?.[1]?.trim()
    // El equipo escribe "-" cuando el campo no está puesto. Devolverlo como
    // texto haría que una comparación contra la IP esperada pasara por válida.
    return !v || v === '-' ? null : v
  }

  const tipo = texto.match(/ONT\s+config\s+type\s*:\s*(.+)/i)?.[1]?.trim() ?? null
  const ip = buscar('IP')

  // Sin dirección no hay configuración que reportar: devolver un objeto lleno
  // de nulos haría creer que se leyó algo.
  if (!ip && !tipo) return null

  return {
    tipo,
    estatica: /static/i.test(tipo ?? ''),
    ip,
    mascara: buscar('subnet mask'),
    gateway: buscar('gateway'),
    dns1: buscar('primary DNS'),
    dns2: buscar('slave DNS'),
    vlan: buscar('manage VLAN') ? Number(buscar('manage VLAN')) : null,
    prioridad: buscar('manage priority') ? Number(buscar('manage priority')) : null,
  }
}

/**
 * Completa un Equipment-ID recortado con el nombre que trae la descripción.
 *
 * Solo actúa cuando la descripción tiene una palabra que termina con lo
 * declarado y es más larga: "310M" dentro de "HG8310M GPON/EPON Terminal" se
 * completa, pero "HG8145X6-13" no se toca porque ya está entero.
 *
 * La estrictez es a propósito. Una regla más suelta —"buscá algo que se
 * parezca"— convertiría un modelo en otro parecido y eso es peor que dejarlo
 * recortado: un recorte se nota, un modelo cambiado no.
 */
function completarConLaDescripcion(declarado, descripcion) {
  if (!declarado || !descripcion) return declarado

  const corto = declarado.toUpperCase()
  for (const palabra of String(descripcion).split(/[\s(,]+/)) {
    const p = palabra.replace(/[^A-Za-z0-9.\-]/g, '')
    if (p.length > corto.length && p.toUpperCase().endsWith(corto)) return p
  }
  return declarado
}

/**
 * `display ont wan-info <puerto> <ontId>`
 *
 * ── Qué devuelve el equipo ──
 *
 * Un bloque por conexión WAN de la ONT. La de gestión —la que usa TR-069— se
 * reconoce por `Service type: Tr069`, y es la que muestra la IP con la que el
 * ACS llega hasta el equipo del abonado.
 *
 * ── Por qué puede venir vacío sin que nada esté roto ──
 *
 * Porque la consulta va por OMCI y no todos los modelos la implementan. Las
 * Huawei contestan; un Skyworth GN256VH o un H3-1s responden "The ONT can not
 * support". Eso NO significa que la ONT esté mal ni que no tenga WAN: significa
 * que no sabe contestar esta pregunta en particular, y hay que mirarla por su
 * página web o por TR-069.
 *
 * Se devuelve `{ soportado: false }` en vez de `null` justamente para poder
 * decirlo en pantalla, en lugar de mostrar un hueco que se lee como "no tiene".
 */
export function parseWanInfo(salidaCruda) {
  const salida = normalizarHuawei(salidaCruda)

  if (/can\s*not\s*support|not\s*support/i.test(salida)) {
    return { soportado: false, conexiones: [] }
  }
  if (sinResultados(salida)) return { soportado: true, conexiones: [] }

  const conexiones = []
  let actual = null

  const valor = (linea) => {
    const m = linea.match(/:\s*(.*)$/)
    const v = m?.[1]?.trim()
    // El equipo escribe "-" donde no hay dato. Devolverlo como texto haría que
    // la pantalla imprima un guion creyendo que es un valor.
    return !v || v === '-' ? null : v
  }
  // String.raw: sin él, `\s` dentro de una plantilla es solo una `s`, y el
  // patrón queda buscando "sssIndex" en vez de espacios.
  const es = (linea, etiqueta) => new RegExp(String.raw`^\s*${etiqueta}\s*:`, 'i').test(linea)

  for (const linea of salida.split('\n')) {
    // Cada conexión arranca con su índice.
    if (es(linea, 'Index')) {
      if (actual) conexiones.push(actual)
      actual = { indice: Number(valor(linea)) }
      continue
    }
    if (!actual) continue

    const campos = [
      ['Name', 'nombre'],
      ['Service type', 'servicio'],
      ['Connection type', 'tipoConexion'],
      ['IPv4 Connection status', 'estadoIpv4'],
      ['IPv4 access type', 'accesoIpv4'],
      ['IPv4 address', 'ipv4'],
      ['Subnet mask', 'mascara'],
      ['Default gateway', 'gateway'],
      ['Primary DNS', 'dns1'],
      ['Secondary DNS', 'dns2'],
      ['Manage VLAN', 'vlan'],
      ['Manage priority', 'prioridad'],
      ['NAT switch', 'nat'],
      ['MAC address', 'mac'],
      ['L2 encap-type', 'encap'],
    ]
    for (const [etiqueta, clave] of campos) {
      if (es(linea, etiqueta)) {
        actual[clave] = valor(linea)
        break
      }
    }
  }
  if (actual) conexiones.push(actual)

  return { soportado: true, conexiones }
}

/** `display ont wan-profile all` */
export function parseWanProfiles(salidaCruda) {
  const salida = normalizarHuawei(salidaCruda)
  if (sinResultados(salida)) return []

  const perfiles = []
  for (const linea of salida.split('\n')) {
    // "  0           smartolt                          2"
    const m = linea.match(/^\s*(\d+)\s+(\S.*?)\s{2,}(\d+)\s*$/)
    if (m) perfiles.push({ id: Number(m[1]), nombre: m[2].trim(), vinculos: Number(m[3]) })
  }
  return perfiles
}
