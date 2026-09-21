/**
 * Puertos de subida de una OLT Huawei.
 *
 * En un MA5800 los uplinks viven en las placas de control, y su información
 * está repartida en dos comandos: `display board 0/<slot>` da la tabla de
 * puertos —velocidad, dúplex, enlace, VLAN nativa— y `display port vlan
 * <f/s/p>` da qué VLANs pasan por cada uno.
 *
 * La segunda es la que importa para armar un troncal: sin ella no se puede
 * saber si la VLAN de un cliente nuevo llega hasta el router, y el síntoma —el
 * abonado no navega aunque su ONT esté online— manda a buscar el problema al
 * lado equivocado.
 */

const limpiar = (s) =>
  String(s ?? '')
    .replace(/\x1b?\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')

/**
 * Tabla de puertos de una placa de control.
 *
 *   Port  Port Optic   Native  MDI  Speed   Duplex  Flow-  Active   Link
 *         Type Status  VLAN         (Mbps)          Ctrl   State
 *      0  GE   mismatch     1  -    1000    full    off    active   online
 */
export function parsePuertosPlaca(salida) {
  const t = limpiar(salida)
  const puertos = []

  for (const linea of t.split('\n')) {
    const m = linea.match(
      /^\s*(\d+)\s+(GE|XGE|10GE|FE)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/i,
    )
    if (!m) continue

    const optico = m[3]
    puertos.push({
      puerto: Number(m[1]),
      tipo: m[2].toUpperCase(),
      // "absence" = no hay SFP puesto; cualquier otra cosa es que hay algo.
      // Distinguirlos evita reportar como falla un puerto que simplemente
      // está libre.
      optico,
      tiene_sfp: !/absence/i.test(optico),
      medio: /absence/i.test(optico) ? 'cobre' : 'fibra',
      vlan_nativa: Number(m[4]),
      velocidad_mbps: Number(m[6]),
      duplex: m[7],
      flow_ctrl: m[8],
      admin: m[9],
      habilitado: /active/i.test(m[9]),
      enlace: m[10],
      online: /online|up/i.test(m[10]),
    })
  }

  return {
    placa: t.match(/Board Name\s*:\s*(\S+)/i)?.[1] ?? null,
    estado: t.match(/Board Status\s*:\s*(.+?)\s*$/im)?.[1]?.trim() ?? null,
    puertos,
  }
}

/**
 * VLANs que pasan por un puerto.
 *
 *     ---------------------------------------
 *        1    200    201    202    203    204
 *      205    206    207 ...
 *     ---------------------------------------
 *     Total: 35
 *     Native VLAN: 1
 *
 * Se toma el "Total" que informa el equipo y se compara con lo leído: si no
 * coinciden, el parseo se comió alguna y hay que decirlo en vez de mostrar una
 * lista incompleta como si fuera completa.
 */
export function parseVlansDePuerto(salida) {
  const t = limpiar(salida)

  const total = Number(t.match(/Total\s*:\s*(\d+)/i)?.[1] ?? NaN)
  const nativa = Number(t.match(/Native VLAN\s*:\s*(\d+)/i)?.[1] ?? NaN)

  // El bloque entre las dos líneas de guiones es la lista.
  const bloque = t.match(/-{10,}\s*\n([\s\S]*?)\n\s*-{10,}/)
  const vlans = []

  if (bloque) {
    for (const n of bloque[1].split(/\s+/)) {
      const v = Number(n)
      if (Number.isInteger(v) && v >= 1 && v <= 4094) vlans.push(v)
    }
  }

  const unicas = [...new Set(vlans)].sort((a, b) => a - b)

  return {
    vlans: unicas,
    nativa: Number.isFinite(nativa) ? nativa : null,
    total: Number.isFinite(total) ? total : unicas.length,
    // Si el equipo dice 35 y se leyeron 30, la lista está incompleta y quien la
    // mire tiene que saberlo antes de concluir que falta una VLAN.
    completa: !Number.isFinite(total) || total === unicas.length,
  }
}

/**
 * Cuántos abonados cuelga de cada VLAN.
 *
 *   VLAN   Type      Attribute  STND-Port NUM   SERV-Port NUM  VLAN-Con NUM
 *    200   smart     common                 4              90             -
 *
 * "SERV-Port" son los service-ports, o sea los abonados. Es el número que hay
 * que mirar ANTES de sacar una VLAN de un troncal: quitar la 200 de este equipo
 * deja a noventa clientes sin salida, todos al mismo tiempo.
 */
export function parseVlansConUso(salida) {
  const filas = []

  for (const linea of limpiar(salida).split('\n')) {
    const m = linea.match(/^\s*(\d+)\s+(smart|standard|mux|super)\s+(\S+)\s+(\d+)\s+(\d+)/i)
    if (!m) continue

    filas.push({
      vlan: Number(m[1]),
      tipo: m[2],
      puertos_estandar: Number(m[4]),
      abonados: Number(m[5]),
    })
  }
  return filas
}

/**
 * Agrupa VLANs consecutivas: "100-132, 888" en vez de treinta y cinco números.
 *
 * Es la diferencia entre poder leer un troncal de un vistazo y tener que
 * contar. Un rango roto —"100-115, 117-132"— salta a la vista; en una lista
 * plana, no.
 */
export function comprimirRangos(vlans) {
  if (!vlans?.length) return ''

  const orden = [...new Set(vlans)].sort((a, b) => a - b)
  const trozos = []
  let inicio = orden[0]
  let previo = orden[0]

  for (const v of orden.slice(1)) {
    if (v === previo + 1) {
      previo = v
      continue
    }
    trozos.push(inicio === previo ? `${inicio}` : `${inicio}-${previo}`)
    inicio = v
    previo = v
  }
  trozos.push(inicio === previo ? `${inicio}` : `${inicio}-${previo}`)

  return trozos.join(', ')
}
