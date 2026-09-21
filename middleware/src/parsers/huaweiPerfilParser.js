/**
 * Perfiles y service-ports de una OLT Huawei.
 *
 * Escrito contra la salida real de un MA5800-X7:
 *
 *   display ont-lineprofile gpon all
 *   display ont-srvprofile gpon all
 *
 *     Profile-ID  Profile-name                     Binding times
 *     ----------------------------------------------------------
 *     2           SMARTOLT_FLEXIBLE_GPON           76
 *
 * El "Binding times" importa más de lo que parece: es cuántas ONTs usan ese
 * perfil, y por lo tanto cuál proponer por defecto. El perfil que ya usan 76
 * abonados es casi seguro el correcto para el 77.
 */

const limpiar = (s) =>
  String(s ?? '')
    .replace(/\x1b?\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')

/**
 * Lista de perfiles con su ID, nombre y cuántas ONTs los usan.
 *
 * Se exige que el nombre NO sea un número: el encabezado y las líneas de
 * guiones tienen la forma justa para colarse, y un perfil llamado "76" haría
 * que el formulario ofreciera basura.
 */
export function parsePerfiles(salida) {
  const filas = []

  for (const linea of limpiar(salida).split('\n')) {
    const m = linea.match(/^\s*(\d+)\s+(\S+)\s+(\d+)\s*$/)
    if (!m) continue
    if (/^\d+$/.test(m[2])) continue

    filas.push({ id: Number(m[1]), nombre: m[2], usos: Number(m[3]) })
  }

  // Por uso descendente: el más usado primero es el que hay que proponer.
  return filas.sort((a, b) => b.usos - a.usos || a.id - b.id)
}

/**
 * Índices de service-port ya ocupados.
 *
 *     INDEX VLAN VLAN     PORT F/ S/ P VPI  VCI   FLOW  FLOW       RX   TX   STATE
 *         0  999 common   gpon 0/6 /0  1    2     vlan  999        9    9    up
 *
 * Hace falta para elegir uno libre: el equipo no los asigna solo, y reusar uno
 * ocupado pisaría el servicio de otro abonado.
 */
export function parseIndicesServicePort(salida) {
  const usados = new Set()

  for (const linea of limpiar(salida).split('\n')) {
    const m = linea.match(/^\s*(\d+)\s+(\d+)\s+\S+\s+(gpon|epon|eth)\b/i)
    if (m) usados.add(Number(m[1]))
  }
  return usados
}

/**
 * Los service-ports de UNA ONT, con su índice y su VLAN.
 *
 *   display service-port port 0/6/0 ont 1
 *
 *        0  999 common   gpon 0/6 /0  1    2     vlan  999   9   9   up
 *        4  200 common   gpon 0/6 /0  1    1     vlan  200   11  10  up
 *
 * Una ONT suele tener más de uno: el de internet y el de gestión. Cambiarle el
 * plan a uno solo dejaría la mitad del servicio con la velocidad vieja, y
 * borrar la ONT sin limpiarlos deja índices ocupados por un abonado que ya no
 * existe.
 */
export function parseServicePortsDeOnt(salida) {
  const filas = []

  for (const linea of limpiar(salida).split('\n')) {
    // Las columnas RX y TX vienen con un guion cuando la ONT no tiene traffic
    // table, que es lo que pasa cuando se autoriza sin elegir plan.
    //
    // Exigirlas numéricas hacía que esas filas no existieran para el sistema, y
    // el efecto no era que "no se veía la velocidad": era que la ONT quedaba
    // imposible de borrar y de mover. El código creía que no tenía nada que
    // limpiar, y el equipo después rechazaba el borrado con "This configured
    // object has some service virtual ports".
    const m = linea.match(
      /^\s*(\d+)\s+(\d+)\s+\S+\s+(?:gpon|epon)\s+\d+\s*\/\s*\d+\s*\/\s*\d+\s+(\d+)\s+(\d+)\s+\S+\s+(\d+)\s+(\d+|-)\s+(\d+|-)\s+(\S+)/i,
    )
    if (!m) continue

    const numeroONada = (v) => (v === '-' ? null : Number(v))

    filas.push({
      indice: Number(m[1]),
      vlan: Number(m[2]),
      ontId: Number(m[3]),
      gemport: Number(m[4]),
      userVlan: Number(m[5]),
      // Las columnas RX y TX de la tabla son los índices de traffic table, y
      // van CRUZADOS respecto de cómo se escriben en el comando.
      //
      // Verificado contra el respaldo del equipo: el service-port 4 se muestra
      // con RX=11 TX=10 y en la configuración dice
      // "inbound traffic-table index 10 outbound traffic-table index 11".
      //
      // Invertirlos al recrear le daría al abonado la velocidad de bajada en la
      // subida y viceversa — y nadie lo notaría hasta que se queje de que "sube
      // rapidísimo y baja lento".
      ttEntrada: numeroONada(m[7]),
      ttSalida: numeroONada(m[6]),
      estado: m[8],
    })
  }
  return filas
}

/**
 * Los service-ports de toda la OLT, con el puerto PON de cada uno.
 *
 *   INDEX VLAN VLAN     PORT F/ S/ P VPI  VCI   FLOW  FLOW       RX   TX   STATE
 *         ID   ATTR     TYPE                    TYPE  PARA
 *       0  999 common   gpon 0/6 /0  1    2     vlan  999        9    9    up
 *       2  200 common   gpon 0/6 /0  16   1     vlan  200        11   10   up
 *
 * Es la respuesta a "¿qué VLANs tiene puestas cada puerto PON?", que el equipo
 * sabe y nuestra base no: nosotros guardamos UNA VLAN por ONU y acá se ve que
 * cada ONT tiene dos —la de internet y la de gestión—.
 *
 * El F/S/P viene partido raro —"0/6 /0"— porque la columna del slot está
 * alineada a la izquierda y la del puerto a la derecha. Separarlo mal deja
 * todos los service-ports en el puerto equivocado.
 */
export function parseServicePortsPorPuerto(salida) {
  const filas = []

  for (const linea of limpiar(salida).split('\n')) {
    const m = linea.match(
      /^\s*(\d+)\s+(\d+)\s+\S+\s+(gpon|epon)\s+(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(\d+)\s+(\d+|-)\s+(\d+|-)\s+(\S+)/i,
    )
    if (!m) continue

    filas.push({
      indice: Number(m[1]),
      vlan: Number(m[2]),
      tipo: m[3].toLowerCase(),
      frame: Number(m[4]),
      slot: Number(m[5]),
      puerto: Number(m[6]),
      ontId: Number(m[7]),
      gemport: Number(m[8]),
      userVlan: Number(m[9]),
      estado: m[12],
    })
  }
  return filas
}

/**
 * Configuración de una ONT: sus perfiles y su descripción.
 *
 * `display ont info <puerto> <ontid>`. Hace falta para poder recrearla igual en
 * otro puerto: sin los IDs de perfil, la ONT vuelve con una configuración
 * distinta de la que tenía.
 *
 * La descripción viene partida en varias líneas cuando es larga, igual que en
 * la tabla de ONTs — y acá el corte es siempre a mitad de palabra, sin relleno.
 */
export function parseConfigOnt(salida) {
  const t = limpiar(salida)
  const lineas = t.split('\n')

  const uno = (re) => t.match(re)?.[1]?.trim() ?? null

  // "48575443304D1BB2 (HWTC-304D1BB2)" → la forma de la etiqueta.
  const snCrudo = uno(/^\s*SN\s*:\s*(.+?)\s*$/im)
  const sn = snCrudo?.match(/\(([A-Z0-9-]+)\)/)?.[1]?.replace('-', '') ?? snCrudo?.split(/\s+/)[0]

  // La descripción arranca en su etiqueta y sigue en las líneas de abajo hasta
  // la próxima que tenga forma de "clave : valor".
  //
  // Cómo se vuelven a unir depende de POR DÓNDE cortó el equipo, y eso se sabe
  // mirando si rellenó el final de la línea con espacios:
  //
  //   HERRERA_GUAMANI_ENMA_BEATRIZ_zon     sin relleno: cortó a mitad de
  //   e_Zone_1_descr_Via_San_Gerardo_R     palabra    → se unen pegadas
  //
  //   PRUEBA BORRAR NO ES UN␣␣␣␣␣␣␣␣␣␣     con relleno: cortó en un espacio
  //   ABONADO_descr_alta de␣␣␣␣␣␣␣␣␣␣␣     de la descripción → va un espacio
  //
  // Unir siempre igual rompe uno de los dos casos: o el nombre del abonado
  // queda partido, o le aparecen palabras pegadas.
  // Y hay un tercer caso, que es el que rompía direcciones de abonados:
  //
  //   ...ORFAY_descr_Selvalegre Frente al        ← llena la columna justo
  //   \e[37D      \e[37D           estadio       ← y empuja el espacio acá
  //
  // Cuando el corte cae justo al terminar una palabra, el equipo manda el
  // espacio separador al PRINCIPIO de la línea siguiente, escondido entre
  // saltos de cursor. Al limpiarlos y recortar, ese espacio desaparecía y la
  // dirección quedaba "Frente alestadio".
  //
  // Se reconoce porque la continuación arranca más adentro que las demás.
  let descripcion = null
  const i = lineas.findIndex((l) => /^\s*Description\s*:/i.test(l))
  if (i >= 0) {
    let previa = lineas[i].replace(/^\s*Description\s*:\s*/i, '')
    let texto = previa.trimEnd()
    let sangriaNormal = null

    for (const siguiente of lineas.slice(i + 1)) {
      if (/^\s*[A-Za-z][\w\s/()-]*\s:/.test(siguiente)) break
      if (!siguiente.trim()) break

      const sangria = siguiente.match(/^\s*/)[0].length
      if (sangriaNormal == null) sangriaNormal = sangria

      const cortoEnEspacio = /\s$/.test(previa) || sangria > sangriaNormal
      texto += `${cortoEnEspacio ? ' ' : ''}${siguiente.trim()}`
      previa = siguiente
    }
    descripcion = texto.trim() || null
  }

  const lineProfileId = uno(/Line profile ID\s*:\s*(\d+)/i)
  const srvProfileId = uno(/Service profile ID\s*:\s*(\d+)/i)

  if (!sn && lineProfileId == null) return null

  return {
    sn,
    descripcion,
    lineProfileId: lineProfileId == null ? null : Number(lineProfileId),
    lineProfileNombre: uno(/Line profile name\s*:\s*(\S+)/i),
    srvProfileId: srvProfileId == null ? null : Number(srvProfileId),
    srvProfileNombre: uno(/Service profile name\s*:\s*(\S+)/i),
    estado: uno(/Run state\s*:\s*(\S+)/i),
    autenticacion: uno(/Authentic type\s*:\s*(\S+)/i),
    gestion: uno(/Management mode\s*:\s*(\S+)/i),
  }
}

/** El primer índice libre. */
export function primerIndiceLibre(usados, desde = 0) {
  let i = desde
  while (usados.has(i)) i++
  return i
}

/**
 * Contadores de tráfico de un service-port.
 *
 *   display statistics service-port 66
 *
 *    Number of upstream bytes             : 86543078325
 *    Number of upstream packets           : 218710573
 *    Number of upstream discard packets   : 89368
 *    Number of downstream bytes           : 589636417373
 *    Number of downstream packets         : 497867596
 *    Number of downstream discard packets : 126925
 *
 * Son acumulados desde que se creó el service-port. Un número solo no dice
 * nada: la velocidad sale de restar dos lecturas.
 *
 * Los bytes se leen como BigInt y se devuelven como Number recién al final:
 * 589.636.417.373 todavía entra en un entero seguro de JavaScript, pero un
 * abonado con años de servicio lo pasa, y ahí las restas empiezan a dar
 * velocidades inventadas.
 */
export function parseEstadisticasServicePort(salida) {
  const t = limpiar(salida)
  const uno = (etiqueta) => {
    const m = t.match(new RegExp(`Number of ${etiqueta}\\s*:\\s*(\\d+)`, 'i'))
    return m ? BigInt(m[1]) : null
  }

  const subidaBytes = uno('upstream bytes')
  const bajadaBytes = uno('downstream bytes')
  if (subidaBytes == null && bajadaBytes == null) return null

  const aNumero = (v) => (v == null ? null : Number(v))

  return {
    subida_bytes: aNumero(subidaBytes),
    subida_paquetes: aNumero(uno('upstream packets')),
    subida_descartados: aNumero(uno('upstream discard packets')),
    bajada_bytes: aNumero(bajadaBytes),
    bajada_paquetes: aNumero(uno('downstream packets')),
    bajada_descartados: aNumero(uno('downstream discard packets')),
  }
}

/**
 * Las traffic tables que tiene cargadas el equipo.
 *
 *   display traffic table ip from-index 0 to-index 21
 *
 *    TID CIR      CBS        PIR      PBS        Pri Copy-policy  Pri-Policy
 *        (kbps)   (bytes)    (kbps)   (bytes)
 *    10  1048064  33540048   1048064  33540048   0   -            local-pri
 *    12  51200    640000     51200    640000     0   -            local-pri
 *
 * Es lo que decide la velocidad real del abonado, y hasta ahora se cargaba a
 * mano en cada plan. Dos de los tres planes de este ISP apuntaban a tablas que
 * no existen —la 30 y la 50, escritas con el número del plan— y no se notaba
 * hasta que el equipo rechazaba un alta.
 *
 * El CIR es el caudal garantizado y el PIR el máximo. Se devuelven los dos: un
 * plan "de 50 megas" con CIR 50 y PIR 50 no es lo mismo que uno con CIR 5 y
 * PIR 50, y desde el nombre del plan no se distinguen.
 */
export function parseTrafficTables(salida) {
  const filas = []

  for (const linea of limpiar(salida).split('\n')) {
    // "6 off off off off 0 - tag-pri" — la tabla sin límite usa "off".
    const m = linea.match(
      /^\s*(\d+)\s+(\d+|off)\s+(\d+|off)\s+(\d+|off)\s+(\d+|off)\s+(\d+)\s+\S+\s+(\S+)\s*$/i,
    )
    if (!m) continue

    const numero = (v) => (/^off$/i.test(v) ? null : Number(v))
    const cir = numero(m[2])
    const pir = numero(m[4])

    filas.push({
      index: Number(m[1]),
      // null es "sin límite", no cero. Un cero se leería como "no pasa nada".
      cir_kbps: cir,
      cbs_bytes: numero(m[3]),
      pir_kbps: pir,
      pbs_bytes: numero(m[5]),
      prioridad: Number(m[6]),
      politica: m[7],
      // Lo que se muestra en una lista para elegir. El PIR es el techo real.
      mbps: pir == null ? null : Math.round((pir / 1000) * 10) / 10,
      sin_limite: pir == null,
    })
  }

  return filas.sort((a, b) => a.index - b.index)
}

/**
 * Las traffic tables con su NOMBRE y si están en uso.
 *
 *   display traffic table ip from-index 10 to-index 13 detail
 *
 *     Traffic Table Index          : 10
 *     Traffic Table Name           : SMARTOLT-1G-UP
 *     CIR                          : 1048064 kbps
 *     PIR                          : 1048064 kbps
 *     Referenced Status            : used
 *
 * El listado compacto no trae el nombre, y sin nombre una tabla es solo un
 * número: "índice 14" no le dice nada a nadie, "SMARTOLT-PLAN_HOME-UP" sí. El
 * estado de referencia dice cuáles se están usando de verdad, que es la
 * diferencia entre las que hay que respetar y las que quedaron de pruebas.
 */
export function parseTrafficTablesDetalle(salida) {
  const bloques = limpiar(salida)
    .split(/^\s*-{10,}\s*$/m)
    .filter((b) => /Traffic Table Index/i.test(b))

  const filas = []

  for (const bloque of bloques) {
    const uno = (etiqueta) =>
      bloque.match(new RegExp(`${etiqueta}\\s*:\\s*(.+?)\\s*$`, 'im'))?.[1]?.trim() ?? null

    const index = uno('Traffic Table Index')
    if (index == null || !/^\d+$/.test(index)) continue

    const kbps = (v) => {
      const m = String(v ?? '').match(/^(\d+)/)
      return m ? Number(m[1]) : null
    }
    const cir = kbps(uno('CIR'))
    const pir = kbps(uno('PIR'))

    filas.push({
      index: Number(index),
      nombre: uno('Traffic Table Name'),
      cir_kbps: cir,
      pir_kbps: pir,
      mbps: pir == null ? null : Math.round((pir / 1000) * 10) / 10,
      sin_limite: pir == null || pir === 0,
      // "used" = algún service-port la está aplicando. Borrarla dejaría a esos
      // abonados sin límite, así que la pantalla tiene que poder distinguirlas.
      en_uso: /^used$/i.test(uno('Referenced Status') ?? ''),
      prioridad: Number(uno('Specified Outer-Priority') ?? 0),
    })
  }

  return filas.sort((a, b) => a.index - b.index)
}
