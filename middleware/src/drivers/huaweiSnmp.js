import { recorrer, decodificarIfIndex, valor } from '../lib/snmp.js'
import { decodificarSn } from '../lib/sn.js'

/**
 * Lectura óptica masiva de una OLT Huawei, por SNMP.
 *
 * Reemplaza el recorrido por CLI cuando hay que leer a todos: con mil ONTs, la
 * vía CLI son mil conversaciones con el equipo, y esta es un recorrido de una
 * rama del árbol.
 *
 * # De dónde salen estos OIDs
 *
 * De preguntarle al equipo, no del manual. El relevamiento contra el MA5800-X7
 * (firmware R018C00, agosto 2026) recorrió la rama y comparó cada columna
 * contra `display ont optical-info` de las MISMAS ONTs. La correspondencia
 * quedó confirmada valor por valor:
 *
 *     ONT 0 slot 6 puerto 0     SNMP        CLI
 *     temperatura               38          Temperature(C)          : 38
 *     corriente del láser       12          Laser bias current(mA)  : 12
 *     potencia TX               233         Tx optical power(dBm)   : 2.35
 *     potencia RX               -1728       Rx optical power(dBm)   : -17.28
 *     voltaje                   3280        Voltage(V)              : 3.280
 *
 * Elegir la columna sin esa comparación habría sido adivinar, y una potencia mal
 * escalada se ve perfectamente creíble en pantalla: -172.8 dBm es absurdo y se
 * nota, pero -1.728 dBm parece una señal excelente y mandaría a cerrar reclamos
 * que son reales.
 */

/**
 * # Cuánto cuesta cada lectura, medido
 *
 * Contra el X7 con 85 ONTs, agosto 2026:
 *
 *     una sola columna (RX)          6.1 s     72 ms por ONT
 *     las cinco columnas en serie   29.4 s
 *     las cinco EN PARALELO         22.3 s     (sesión propia por columna)
 *
 * Dos conclusiones que definen este archivo:
 *
 * 1. **El costo es por VALOR, no por consulta.** Unos 72 ms cada uno, y el
 *    agente corta las respuestas en ~25 valores sin importar qué lote se le
 *    pida. No es la red: un valor suelto vuelve en 36 ms. Es que la OLT tiene
 *    que interrogar el módulo óptico de cada ONT por la fibra — eso no se
 *    optimiza, es el precio de la medición.
 *
 * 2. **Paralelizar casi no sirve.** Cinco sesiones simultáneas bajaron 29 s a
 *    22 s: el agente atiende prácticamente en serie. No vale el gasto de abrir
 *    cinco sockets y cinco recorridos para ganar un cuarto del tiempo.
 *
 * Por eso el modo por defecto lee SOLO la potencia RX, que es la que dispara
 * alertas. Todo lo demás está a un parámetro de distancia, pero se paga.
 */
const DDM = '1.3.6.1.4.1.2011.6.128.1.1.2.51.1'

/**
 * Columnas verificadas. `factor` lleva el crudo a la unidad de siempre.
 *
 * Las que no se pudieron identificar NO están: una columna con nombre inventado
 * es peor que una columna ausente, porque alguien la va a usar para decidir.
 */
const COLUMNAS = {
  1: { campo: 'temperatura_c', factor: 1 },
  2: { campo: 'bias_ma', factor: 1 },
  3: { campo: 'tx_dbm', factor: 0.01 },
  4: { campo: 'rx_dbm', factor: 0.01 },
  5: { campo: 'voltaje_v', factor: 0.001 },
}

// -----------------------------------------------------------------------------
// Inventario de ONTs
// -----------------------------------------------------------------------------

/**
 * Columnas del inventario, todas verificadas contra el equipo.
 *
 * El estado se encontró comparando una ONT que reporta óptica contra una que no:
 * es la única columna que separa los dos grupos sin excepciones. La distancia se
 * confirmó contra la CLI — 9326 m para la ONT 6/0/1, el mismo número.
 */
const INVENTARIO = {
  sn: '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.3',
  perfil: '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.7',
  modelo: '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.8',
  descripcion: '1.3.6.1.4.1.2011.6.128.1.1.2.43.1.9',
  estado: '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.15',
  distancia_m: '1.3.6.1.4.1.2011.6.128.1.1.2.46.1.20',
}

// Las dos notaciones del número de serie viven en un solo lugar: las usan tanto
// este lector como el parser de la CLI, y tenerlas duplicadas sería garantizar
// que un día diverjan.
export { decodificarSn, normalizarSn } from '../lib/sn.js'

/**
 * Desarma la descripción que dejó el sistema anterior.
 *
 * Vienen con esta forma, que es la que arma SmartOLT:
 *
 *     NOMBRE_APELLIDO_zone_Zone_1_descr_LA DIRECCION_authd_20251013
 *
 * Se separa para no perder la dirección ni la fecha de alta, que es información
 * real del abonado enterrada en un solo campo de texto. Lo que no tenga esta
 * forma se devuelve entero como nombre: inventarle estructura a un texto libre
 * es peor que dejarlo como está.
 */
export function parsearDescripcion(texto) {
  const completa = String(texto ?? '').trim()
  if (!completa) return { nombre: null, zona: null, direccion: null, alta: null, completa: null }

  const trozo = (etiqueta) => {
    const m = completa.match(new RegExp(`_${etiqueta}_(.*?)(?=_(?:zone|descr|authd)_|$)`, 'i'))
    return m?.[1]?.trim() || null
  }

  const nombre = completa.split(/_(?:zone|descr|authd)_/i)[0].trim()
  const alta = trozo('authd')

  // Los guiones bajos son el separador que usa la descripción, no parte del
  // texto. Se sacan en los tres campos por igual: dejándolos solo en el nombre,
  // la misma zona quedaba escrita de dos formas —"Zone 1" y "Zone_1"— y el
  // filtro de zonas la mostraba dos veces, como si fueran dos zonas distintas.
  const sinGuiones = (t) => t?.replace(/_/g, ' ').trim() || null

  return {
    nombre: sinGuiones(nombre),
    zona: sinGuiones(trozo('zone')),
    direccion: sinGuiones(trozo('descr')),
    // "20251013" → "2025-10-13". Sin esto la fecha no se puede ni ordenar.
    alta: /^\d{8}$/.test(alta ?? '') ? `${alta.slice(0, 4)}-${alta.slice(4, 6)}-${alta.slice(6)}` : alta,
    completa,
  }
}

const texto = (v) =>
  Buffer.isBuffer(v) ? v.toString('latin1').replace(/\0/g, '').trim() : String(v ?? '').trim()

/**
 * Inventario completo de ONTs: quiénes son, dónde están y cómo están.
 *
 * Es lo que permite que la lectura óptica masiva le pegue a un abonado en vez de
 * quedar como un número suelto.
 */
export async function leerInventario(olt, comunidad) {
  const inicio = Date.now()
  const porOnt = new Map()

  const ubicar = (oid, base) => {
    const p = oid.slice(base.length + 1).split('.')
    const ub = decodificarIfIndex(p[0])
    if (!ub) return null
    return { clave: `${ub.slot}/${ub.puerto}/${p[1]}`, ...ub, ontId: Number(p[1]) }
  }

  for (const [campo, base] of Object.entries(INVENTARIO)) {
    for (const f of await recorrer(olt, comunidad, base)) {
      const u = ubicar(f.oid, base)
      if (!u) continue

      if (!porOnt.has(u.clave)) {
        porOnt.set(u.clave, {
          frame: 0,
          slot: u.slot,
          puerto: u.puerto,
          ontId: u.ontId,
          sn: null,
          descripcion: null,
          modelo: null,
          perfil: null,
          estado: null,
          distancia_m: null,
        })
      }

      const fila = porOnt.get(u.clave)
      if (campo === 'sn') fila.sn = decodificarSn(f.valor)
      else if (campo === 'estado') fila.estado = Number(f.valor) === 1 ? 'online' : 'offline'
      else if (campo === 'distancia_m') fila.distancia_m = valor(f.valor)
      else fila[campo] = texto(f.valor) || null
    }
  }

  const onts = [...porOnt.values()]
    // Una posición sin serie no es una ONT: es un hueco de la tabla.
    .filter((o) => o.sn)
    .map((o) => ({ ...o, datos: parsearDescripcion(o.descripcion) }))
    .sort((a, b) => a.slot - b.slot || a.puerto - b.puerto || a.ontId - b.ontId)

  return {
    onts,
    online: onts.filter((o) => o.estado === 'online').length,
    ms: Date.now() - inicio,
  }
}

// -----------------------------------------------------------------------------
// Candidatas a autorizar
// -----------------------------------------------------------------------------

const AUTOFIND = {
  sn: '1.3.6.1.4.1.2011.6.128.1.1.2.52.1.2',
  detectada: '1.3.6.1.4.1.2011.6.128.1.1.2.52.1.4',
}

/** DateAndTime de SNMP: año(2 bytes) mes día hora minuto segundo… */
function fechaSnmp(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 7) return null
  const p = (n) => String(n).padStart(2, '0')
  const iso = `${buf.readUInt16BE(0)}-${p(buf[2])}-${p(buf[3])}T${p(buf[4])}:${p(buf[5])}:${p(buf[6])}`
  return Number.isNaN(new Date(iso).getTime()) ? null : iso
}

/**
 * ONTs que la OLT registró como descubiertas, con su puerto y cuándo aparecieron.
 *
 * # Esto NO es la cola de autorización
 *
 * Es la trampa que casi me como. La tabla parece la lista de "esperando
 * autorización" —contiene la ONT que efectivamente espera— pero además conserva
 * entradas de ONTs que ya no están en la cola viva. Contra el X7 devolvía seis
 * cuando la CLI reportaba una: las otras cinco compartían el mismo segundo
 * exacto de detección y su puerto ya no tenía ninguna esperando.
 *
 * Publicar esto como "esperando autorización" habría hecho que el tablero
 * mostrara seis ONTs para autorizar y que alguien saliera a buscar cinco
 * equipos que no existen.
 *
 * Sirve para lo que sí es: saber DÓNDE mirar. Con estos puertos, la
 * confirmación por CLI cuesta dos comandos en vez de barrer treinta y dos.
 */
export async function leerCandidatosAutofind(olt, comunidad) {
  const porClave = new Map()

  for (const [campo, base] of Object.entries(AUTOFIND)) {
    for (const f of await recorrer(olt, comunidad, base, { tope: 2000 })) {
      const r = f.oid.slice(base.length + 1).split('.')
      const ub = decodificarIfIndex(r[0])
      if (!ub) continue

      const clave = `${ub.slot}/${ub.puerto}/${r[1]}`
      if (!porClave.has(clave)) porClave.set(clave, { slot: ub.slot, puerto: ub.puerto })

      const e = porClave.get(clave)
      if (campo === 'sn') e.sn = decodificarSn(f.valor)
      else e.detectada = fechaSnmp(f.valor)
    }
  }

  const candidatas = [...porClave.values()]
    .filter((c) => c.sn)
    .sort((a, b) => a.slot - b.slot || a.puerto - b.puerto)

  return {
    candidatas,
    // Lo único que se usa río abajo: qué puertos vale la pena preguntarle a la
    // CLI. Sin candidatas, cero comandos.
    puertos: [...new Set(candidatas.map((c) => `${c.slot}/${c.puerto}`))].map((k) => {
      const [slot, puerto] = k.split('/').map(Number)
      return { slot, puerto }
    }),
  }
}

/**
 * Arma las filas por ONT a partir de los OIDs crudos.
 *
 * Separado del acceso a la red para poder probarlo: el desarmado del OID y el
 * escalado son donde un error pasa desapercibido. Una potencia dividida por 10
 * en vez de por 100 da -1.7 dBm, que parece una señal excelente y haría cerrar
 * reclamos que son reales.
 */
export function armarFilas(filas) {
  const porOnt = new Map()

  for (const f of filas) {
    // El OID termina en  <columna>.<ifIndex>.<ontId>
    const partes = f.oid.slice(DDM.length + 1).split('.')
    if (partes.length < 3) continue

    const columna = COLUMNAS[partes[0]]
    if (!columna) continue

    const ubicacion = decodificarIfIndex(partes[1])
    if (!ubicacion) continue

    const ontId = Number(partes[2])
    const clave = `${ubicacion.slot}/${ubicacion.puerto}/${ontId}`

    if (!porOnt.has(clave)) {
      porOnt.set(clave, {
        frame: 0,
        slot: ubicacion.slot,
        puerto: ubicacion.puerto,
        ontId,
        rx_dbm: null,
        tx_dbm: null,
        temperatura_c: null,
        voltaje_v: null,
        bias_ma: null,
      })
    }

    const n = valor(f.valor)
    if (n !== null) {
      const escalado = n * columna.factor
      // Redondeo al alcance del instrumento: estos módulos reportan centésimas.
      porOnt.get(clave)[columna.campo] =
        columna.factor === 1 ? escalado : Math.round(escalado * 100) / 100
    }
  }

  return [...porOnt.values()].sort(
    (a, b) => a.slot - b.slot || a.puerto - b.puerto || a.ontId - b.ontId,
  )
}

/**
 * Potencia óptica de TODAS las ONTs de la OLT.
 *
 * Por defecto trae solo la RX, que es la que decide si hay que mandar un
 * técnico. Cada columna extra cuesta otro recorrido completo —unos 72 ms por
 * ONT— así que `completo` multiplica el tiempo por cinco. Con mil abonados eso
 * es la diferencia entre un minuto y seis.
 */
export async function leerPotencias(olt, comunidad, { completo = false } = {}) {
  const inicio = Date.now()

  // Se recorre columna por columna y no la tabla entera: pedir la rama completa
  // trae las cinco sí o sí, aunque solo se quiera una.
  const columnas = completo ? Object.keys(COLUMNAS) : ['4']

  const filas = []
  for (const col of columnas) {
    filas.push(...(await recorrer(olt, comunidad, `${DDM}.${col}`)))
  }

  const onts = armarFilas(filas)

  return {
    onts,
    completo,
    // Una ONT registrada que no reporta óptica está apagada o desconectada: la
    // posición existe en la tabla pero sin valores.
    con_lectura: onts.filter((o) => o.rx_dbm !== null).length,
    ms: Date.now() - inicio,
    valores_leidos: filas.length,
  }
}
