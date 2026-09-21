import { AppError } from '../lib/errors.js'
import { pedir, modeloDe } from './genieacs.js'

/**
 * La WAN de la ONT, por TR-069.
 *
 * ── Qué resuelve ──
 *
 * Dar de alta la conexión a internet del abonado sin entrar al equipo: PPPoE con
 * su usuario, IP fija, o DHCP. Hoy eso se hace a mano en cada ONT, o se deja en
 * bridge y lo resuelve el router del cliente — que es la razón por la que un
 * cambio de plan obliga a una visita.
 *
 * ── Por qué está en su propio archivo ──
 *
 * Porque el mapa de parámetros de la WAN es cuatro veces más grande que el del
 * WiFi y tiene una diferencia de fondo: el WiFi se EDITA sobre un objeto que ya
 * existe, y la WAN muchas veces hay que CREARLA. Son dos operaciones distintas
 * de TR-069 —`setParameterValues` contra `addObject`— y mezclarlas en el mismo
 * archivo haría que quien venga a tocar el nombre de una red se tropiece con la
 * lógica de aprovisionamiento.
 *
 * ── Las tres cosas que hacen difícil esto ──
 *
 * 1. TR-098 y TR-181 no solo cambian los nombres: cambian la FORMA. En TR-098 la
 *    conexión IP y la PPPoE son dos objetos distintos —`WANIPConnection` y
 *    `WANPPPConnection`— y elegir el modo es elegir cuál crear. En TR-181 hay una
 *    interfaz IP y, si es PPPoE, una interfaz PPP debajo.
 *
 * 2. Huawei agrega parámetros propios sin los cuales la conexión se crea y no
 *    levanta: la VLAN del servicio y la lista de qué servicios usan esa WAN. Sin
 *    `X_HW_SERVICELIST` la ONT arma el enlace y no le da internet a nadie.
 *
 * 3. El equipo se queda sin conexión mientras aplica. Un cambio de WAN corta al
 *    abonado por unos segundos —o para siempre, si algo quedó mal— y a diferencia
 *    del WiFi no hay forma de volver atrás desde el ACS si el equipo perdió el
 *    camino. Por eso acá nada se aplica sin decir antes exactamente qué se va a
 *    escribir.
 */

/** Los modos que se pueden aprovisionar. */
export const MODOS = ['pppoe', 'dhcp', 'estatica']

/**
 * El mapa de parámetros, por modelo de datos.
 *
 * Cada entrada dice dónde vive la conexión y cómo se llama cada campo. Está
 * escrito como datos y no como `if`s a propósito: agregar un fabricante que
 * inventa su propio parámetro es sumar una línea, no tocar la lógica.
 */
const MAPAS = {
  tr098: {
    raiz: 'InternetGatewayDevice',
    /** Dónde viven las conexiones. El `1` es el WANDevice, casi siempre único. */
    base: (wan = 1, con = 1) =>
      `InternetGatewayDevice.WANDevice.${wan}.WANConnectionDevice.${con}`,
    objeto: (modo) => (modo === 'pppoe' ? 'WANPPPConnection' : 'WANIPConnection'),

    campos: {
      habilitar: 'Enable',
      tipo: 'ConnectionType',
      nombre: 'Name',
      // PPPoE
      usuario: 'Username',
      clave: 'Password',
      // IP fija
      direccionamiento: 'AddressingType',
      ip: 'ExternalIPAddress',
      mascara: 'SubnetMask',
      puerta: 'DefaultGateway',
      dns: 'DNSServers',
      // NAT: sin esto la LAN no sale, aunque la WAN tenga IP.
      nat: 'NATEnabled',
    },

    /**
     * Lo que Huawei agrega y sin lo cual la conexión no sirve.
     *
     * `X_HW_SERVICELIST` es el que más cuesta descubrir: la conexión se crea, el
     * enlace levanta, y el abonado sigue sin internet porque la ONT no sabe que
     * esa WAN es para el servicio de datos.
     */
    huawei: {
      vlan: 'X_HW_VLAN',
      servicios: 'X_HW_SERVICELIST',
      prioridad: 'X_HW_PRIORITY',
    },

    valores: {
      tipoRuteado: 'IP_Routed',
      dhcp: 'DHCP',
      estatica: 'Static',
    },
  },

  tr181: {
    raiz: 'Device',
    base: () => 'Device.IP.Interface',
    objeto: () => 'Device.IP.Interface',

    campos: {
      habilitar: 'Enable',
      tipo: null,
      nombre: 'Name',
      usuario: 'Username',
      clave: 'Password',
      direccionamiento: 'IPv4Address.1.AddressingType',
      ip: 'IPv4Address.1.IPAddress',
      mascara: 'IPv4Address.1.SubnetMask',
      puerta: null,
      dns: null,
      nat: null,
    },

    huawei: null,

    valores: {
      tipoRuteado: null,
      dhcp: 'DHCP',
      estatica: 'Static',
    },
  },
}

export const mapaDe = (nombreModelo) => MAPAS[nombreModelo] ?? null

/** ¿Es una IPv4 con sentido? */
export function esIpv4(valor) {
  const partes = String(valor ?? '').trim().split('.')
  if (partes.length !== 4) return false
  return partes.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255)
}

/**
 * Revisa el pedido ANTES de tocar el equipo.
 *
 * ── Por qué se valida acá y no se deja fallar al equipo ──
 *
 * Porque un pedido mal armado no falla: la ONT acepta los parámetros que
 * entiende, ignora los que no, y queda con media configuración. El abonado se
 * queda sin internet y el ACS informa que el cambio se aplicó.
 *
 * Devuelve la lista de problemas en vez de lanzar en el primero: quien está
 * cargando una WAN quiere ver todo lo que le falta de una vez, no de a uno.
 */
export function revisar({ modo, usuario, clave, ip, mascara, puerta, dns, vlan } = {}) {
  const problemas = []

  if (!MODOS.includes(modo)) {
    problemas.push(`Modo desconocido: ${modo ?? '(ninguno)'}. Tiene que ser pppoe, dhcp o estatica.`)
    return problemas
  }

  if (modo === 'pppoe') {
    if (!String(usuario ?? '').trim()) problemas.push('Falta el usuario de PPPoE.')
    if (!String(clave ?? '').trim()) problemas.push('Falta la clave de PPPoE.')
  }

  if (modo === 'estatica') {
    if (!esIpv4(ip)) problemas.push('La dirección IP no es válida.')
    if (!esIpv4(mascara)) problemas.push('La máscara no es válida.')
    if (!esIpv4(puerta)) problemas.push('La puerta de enlace no es válida.')

    /**
     * La puerta tiene que estar en la misma red que la IP.
     *
     * Es el error más común al cargar a mano —un dígito de más en el tercer
     * octeto— y el más caro: la conexión levanta, la ONT toma la IP, y no sale
     * nada. Desde el ACS parece todo bien.
     */
    if (esIpv4(ip) && esIpv4(mascara) && esIpv4(puerta) && !mismaRed(ip, puerta, mascara)) {
      problemas.push('La puerta de enlace no está en la misma red que la IP.')
    }

    for (const d of String(dns ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
      if (!esIpv4(d)) problemas.push(`El DNS "${d}" no es una dirección válida.`)
    }
  }

  if (vlan != null && vlan !== '') {
    const n = Number(vlan)
    if (!Number.isInteger(n) || n < 1 || n > 4094) {
      problemas.push('La VLAN tiene que ser un número entre 1 y 4094.')
    }
  }

  return problemas
}

/** ¿Dos direcciones caen en la misma red con esa máscara? */
export function mismaRed(a, b, mascara) {
  const nums = (x) => x.split('.').map(Number)
  const [ia, ib, im] = [nums(a), nums(b), nums(mascara)]
  return ia.every((_, i) => (ia[i] & im[i]) === (ib[i] & im[i]))
}

/**
 * Arma los parámetros que hay que escribir.
 *
 * Se devuelve la lista en vez de mandarla: es lo que permite mostrarla antes de
 * aplicar. Un cambio de WAN deja al abonado sin servicio mientras se aplica y
 * puede dejarlo sin servicio para siempre si algo quedó mal — que se pueda leer
 * antes no es una comodidad, es la diferencia entre un cambio y una apuesta.
 */
export function parametros({
  modelo,
  modo,
  usuario,
  clave,
  ip,
  mascara,
  puerta,
  dns,
  vlan,
  esHuawei = false,
  wan = 1,
  conexion = 1,
  instancia = 1,
} = {}) {
  const mapa = mapaDe(modelo)
  if (!mapa) {
    throw new AppError('El equipo no reporta un modelo de datos conocido (ni TR-098 ni TR-181).', {
      status: 422,
      hint: 'Pedile un inform al equipo y volvé a intentar: sin su árbol de parámetros no se sabe dónde escribir.',
    })
  }

  const problemas = revisar({ modo, usuario, clave, ip, mascara, puerta, dns, vlan })
  if (problemas.length) {
    throw new AppError(`No se puede aprovisionar: ${problemas[0]}`, { status: 400, problemas })
  }

  const c = mapa.campos
  const v = mapa.valores
  const objeto = mapa.objeto(modo)

  // El prefijo completo de la conexión: en TR-098 lleva el índice de la
  // instancia; en TR-181 la interfaz ya viene numerada.
  const p = modelo === 'tr098'
    ? `${mapa.base(wan, conexion)}.${objeto}.${instancia}`
    : `${objeto}.${instancia}`

  const escribir = []
  const poner = (campo, valor, tipo = 'xsd:string') => {
    if (!campo || valor == null || valor === '') return
    escribir.push([`${p}.${campo}`, String(valor), tipo])
  }

  poner(c.habilitar, '1', 'xsd:boolean')
  if (v.tipoRuteado) poner(c.tipo, v.tipoRuteado)
  poner(c.nombre, modo === 'pppoe' ? 'INTERNET_PPPoE' : `INTERNET_${modo.toUpperCase()}`)

  if (modo === 'pppoe') {
    poner(c.usuario, usuario)
    poner(c.clave, clave)
  } else if (modo === 'dhcp') {
    poner(c.direccionamiento, v.dhcp)
  } else {
    poner(c.direccionamiento, v.estatica)
    poner(c.ip, ip)
    poner(c.mascara, mascara)
    poner(c.puerta, puerta)
    if (dns) poner(c.dns, String(dns).split(',').map((x) => x.trim()).filter(Boolean).join(','))
  }

  // Con NAT, que es lo que hace que la LAN del abonado salga. Sin esto la WAN
  // toma IP y ningún equipo de la casa navega.
  poner(c.nat, '1', 'xsd:boolean')

  /**
   * Lo de Huawei, al final.
   *
   * `1` en la lista de servicios es INTERNET. Va aparte de los estándar para que
   * se vea qué se le escribe de más a esta marca: el día que aparezca una ONT de
   * otro fabricante que no lo entienda, se sabe qué sacar.
   */
  if (esHuawei && mapa.huawei) {
    if (vlan) escribir.push([`${p}.${mapa.huawei.vlan}`, String(vlan), 'xsd:unsignedInt'])
    escribir.push([`${p}.${mapa.huawei.servicios}`, 'INTERNET', 'xsd:string'])
  }

  return { ruta: p, objeto, escribir }
}

/**
 * Lee cómo está configurada hoy la WAN.
 *
 * Del último inform, sin despertar al equipo: sirve para mostrar en pantalla qué
 * hay antes de cambiarlo, que es lo primero que mira quien va a tocar esto.
 */
export function leerWan(dispositivo, { modelo, wan = 1, conexion = 1, instancia = 1 } = {}) {
  const mapa = mapaDe(modelo)
  if (!mapa || !dispositivo) return null

  const valor = (ruta) => {
    let nodo = dispositivo
    for (const parte of ruta.split('.')) {
      nodo = nodo?.[parte]
      if (nodo == null) return null
    }
    return nodo?._value ?? null
  }

  const c = mapa.campos

  /**
   * Se prueban los dos objetos, no el que uno espera.
   *
   * Un equipo puede tener PPPoE y una IP a la vez —la PPPoE para internet y una
   * DHCP para la gestión del ACS— y mirar solo uno haría decir "está en DHCP"
   * sobre un abonado que navega por PPPoE. Pero "existe el objeto" no es
   * "está en uso": una ONT a la que ya se le cambió el modo por acá alguna vez
   * se queda con el objeto viejo, deshabilitado, al lado del nuevo. Por eso se
   * prefiere el que está HABILITADO, y solo si ninguno lo está se muestra el
   * primero que se encuentre —para no devolver null sobre un equipo que sí
   * tiene algo cargado, aunque esté apagado.
   */
  let candidato = null
  for (const objeto of ['WANPPPConnection', 'WANIPConnection']) {
    const p = modelo === 'tr098'
      ? `${mapa.base(wan, conexion)}.${objeto}.${instancia}`
      : `${mapa.objeto()}.${instancia}`

    const habilitado = valor(`${p}.${c.habilitar}`)
    if (habilitado == null) continue

    const activo = habilitado === true || habilitado === '1' || habilitado === 1
    if (activo) {
      candidato = { objeto, p, activo }
      break
    }
    if (!candidato) candidato = { objeto, p, activo }
  }

  if (!candidato) return null

  const { objeto, p, activo: habilitada } = candidato
  const esPppoe = objeto === 'WANPPPConnection'

  return {
    modo: esPppoe ? 'pppoe' : (valor(`${p}.${c.direccionamiento}`) === mapa.valores.estatica ? 'estatica' : 'dhcp'),
    habilitada,
    usuario: esPppoe ? valor(`${p}.${c.usuario}`) : null,
    // La clave NUNCA se devuelve, aunque el equipo la reporte: esta pantalla la
    // ven el técnico y la oficina, y una clave de PPPoE a la vista es una
    // credencial de red regalada.
    ip: valor(`${p}.${c.ip}`),
    mascara: valor(`${p}.${c.mascara}`),
    puerta: valor(`${p}.${c.puerta}`),
    dns: valor(`${p}.${c.dns}`),
    vlan: mapa.huawei ? valor(`${p}.${mapa.huawei.vlan}`) : null,
    estado: valor(`${p}.ConnectionStatus`),
    ruta: p,
  }
}

/** ¿Es Huawei el fabricante que reportó el equipo? Se lee del equipo, no se pregunta. */
export function esHuawei(dispositivo) {
  return /huawei/i.test(dispositivo?._deviceId?._Manufacturer ?? '')
}

/** ¿Existe ya ese nodo en el árbol que reportó el equipo? */
function existeNodo(dispositivo, ruta) {
  let nodo = dispositivo
  for (const parte of ruta.split('.')) {
    nodo = nodo?.[parte]
    if (nodo == null) return false
  }
  return true
}

/**
 * Aplica el aprovisionamiento de WAN sobre un equipo ya encontrado en el ACS.
 *
 * ── Por qué no crea el objeto si falta ──
 *
 * Un `addObject` mal indexado deja a la ONT con una WAN fantasma y sin la que
 * tenía —es el escenario que la cabecera de este archivo marca como el más
 * caro de los tres—. Mientras eso no esté resuelto con cuidado, esta función
 * EDITA lo que el equipo ya reportó tener y avisa, sin tocar nada, cuando no
 * hay dónde escribir: crear la conexión queda para el equipo, la OLT, o una
 * versión futura de esto que lo haga con el mismo cuidado que `parametros`
 * pone en validar.
 *
 * ── El resto es igual que `cambiarWifi` ──
 *
 * `connection_request` para aplicar ya; si el equipo no contesta, la tarea
 * queda guardada en GenieACS para el próximo inform y esto lo dice como lo que
 * es, no como una falla.
 */
export async function aplicar(dispositivo, opciones = {}) {
  const modelo = modeloDe(dispositivo)
  if (!modelo) {
    throw new AppError('El equipo no reporta un modelo de datos conocido (ni TR-098 ni TR-181).', {
      status: 422,
      hint: 'Pedile un inform al equipo y volvé a intentar: sin su árbol de parámetros no se sabe dónde escribir.',
    })
  }

  // `esHuawei` se lee del equipo, no de lo que mande quien llama: es la misma
  // regla que en todo este sistema — el objetivo se deduce de la fuente de
  // verdad, no del pedido.
  const { ruta, objeto, escribir } = parametros({
    ...opciones,
    modelo: modelo.nombre,
    esHuawei: esHuawei(dispositivo),
  })

  if (!existeNodo(dispositivo, ruta)) {
    throw new AppError(
      `La ONT no tiene creada la conexión ${objeto} en esa posición. Este sistema no la da de alta `
        + 'sola: hay que crearla desde el equipo, su página web, o por TR-069 antes de poder editarla.',
      { status: 409 },
    )
  }

  const id = encodeURIComponent(dispositivo._id)

  try {
    await pedir(`/devices/${id}/tasks?connection_request`, {
      method: 'POST',
      body: JSON.stringify({ name: 'setParameterValues', parameterValues: escribir }),
    })
    return { aplicado: true, ruta, objeto }
  } catch (err) {
    // El equipo no contestó al golpe en la puerta: apagado, sin camino de red,
    // o detrás de un NAT. La tarea igual quedó guardada en GenieACS y se aplica
    // en el próximo inform.
    return { aplicado: false, motivo: err.message, encolado: true, ruta, objeto }
  }
}
