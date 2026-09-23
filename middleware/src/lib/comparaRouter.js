/**
 * Comparar lo que dice el sistema contra lo que tiene el MikroTik.
 *
 * Todo acá es puro: entra lo que se leyó del equipo y de la base, sale la lista
 * de diferencias. Eso permite probar el criterio —que es donde está el riesgo—
 * sin un router delante.
 *
 * ── El caso que justifica esto ──
 *
 * Se le cambia la IP a un abonado justo cuando el túnel está caído. El sistema
 * guarda la nueva, el router se queda con la vieja, y nadie vuelve a mirarlo
 * porque en la pantalla todo se ve bien.
 *
 * El abonado sigue navegando —su cola vieja lo limita igual— así que no
 * reclama. Y el día que hay que cortarlo, el corte agrega a la lista la IP
 * NUEVA, que en el router no es de nadie: se corta a nadie. El abonado navega
 * gratis hasta que alguien se da cuenta, y no hay nada que lo delate.
 */

/** La IP sin máscara: el router escribe "10.10.7.9/32" y la base "10.10.7.9". */
export const soloIp = (texto) => String(texto ?? '').trim().split('/')[0].trim()

/** Los objetivos de una cola. Puede apuntar a varios separados por coma. */
const objetivosDe = (cola) =>
  String(cola?.target ?? '')
    .split(',')
    .map(soloIp)
    .filter(Boolean)

/**
 * Las colas que le faltan, le sobran o no coinciden a cada abonado de IP fija.
 *
 * `esperado` es lo que `camposDeCola` calculó para el plan: se compara contra
 * eso y no contra la velocidad del plan directamente, para que la comparación
 * use exactamente el mismo criterio que la escritura. Si los dos se separan,
 * "reparar" empezaría a corregir para siempre algo que ya está bien.
 */
export function compararColas({ clientes = [], colas = [], esperadoPorPlan = new Map() }) {
  const faltan = []
  const corregir = []
  const duplicadas = []
  const usadas = new Set()

  for (const c of clientes) {
    const ip = soloIp(c.ip)
    if (!ip) continue

    const suyas = colas.filter((q) => objetivosDe(q).includes(ip))
    suyas.forEach((q) => usadas.add(q['.id']))

    const esperado = esperadoPorPlan.get(c.plan_id)

    if (!suyas.length) {
      faltan.push({
        cliente: c.nombre,
        id: c.id,
        ip,
        // Sin cola no hay límite: el abonado recibe lo que dé el puerto.
        motivo: 'no tiene cola en el router: navega sin límite',
      })
      continue
    }

    if (suyas.length > 1) {
      duplicadas.push({ cliente: c.nombre, ip, cuantas: suyas.length })
    }

    // Manda la primera: es la que RouterOS aplica.
    const q = suyas[0]
    if (!esperado) continue

    const diferencias = []
    for (const campo of ['max-limit', 'limit-at']) {
      const enRouter = String(q[campo] ?? '').trim()
      const enSistema = String(esperado[campo] ?? '').trim()
      if (enSistema && normalizarVelocidad(enRouter) !== normalizarVelocidad(enSistema)) {
        diferencias.push({ campo, router: enRouter || '—', sistema: enSistema })
      }
    }

    if (diferencias.length) {
      corregir.push({ cliente: c.nombre, id: c.id, ip, diferencias })
    }
  }

  // Las que apuntan a alguien que el sistema no reconoce. NO se borran solas:
  // puede ser un abonado cuya ficha todavía no se cargó, y borrarle la cola lo
  // dejaría sin límite en vez de arreglar algo.
  const desconocidas = colas
    .filter((q) => !usadas.has(q['.id']))
    .map((q) => ({ nombre: q.name ?? '—', target: q.target ?? '—', id: q['.id'] }))

  return { faltan, corregir, duplicadas, desconocidas }
}

/**
 * "150M/150M" y "150000k/150000k" son lo mismo.
 *
 * El sistema escribe en kbps y RouterOS devuelve lo que le resulta más corto.
 * Comparar los textos tal cual haría que cada revisión encontrara diferencias
 * en todos los abonados, y "reparar" reescribiría las 27 colas cada vez sin
 * cambiar nada.
 */
export function normalizarVelocidad(texto) {
  return String(texto ?? '')
    .split('/')
    .map((parte) => {
      const t = parte.trim().toLowerCase()
      const m = t.match(/^(\d+(?:\.\d+)?)([kmg]?)$/)
      if (!m) return t
      const n = Number(m[1])
      const factor = { g: 1_000_000, m: 1_000, k: 1 }[m[2]] ?? 0.001 // sin sufijo: bits
      return String(Math.round(n * factor))
    })
    .join('/')
}

/**
 * Las leases estáticas que no coinciden con la IP que dice el sistema.
 *
 * Es la otra mitad del cambio de IP: sin la lease, el equipo del abonado sigue
 * pidiendo y recibiendo la dirección vieja, así que la cola nueva —que apunta a
 * la nueva— no lo alcanza. Las dos cosas tienen que moverse juntas.
 *
 * Solo se miran los abonados con MAC cargada: sin ella no hay a qué atar la
 * lease, y eso no es una falla que reparar pueda resolver.
 */
export function compararLeases({ clientes = [], leases = [] }) {
  const corregir = []
  const faltan = []

  const porMac = new Map(
    leases
      .filter((l) => l['mac-address'])
      .map((l) => [String(l['mac-address']).toUpperCase().trim(), l]),
  )

  for (const c of clientes) {
    const mac = String(c.mac_address ?? '').toUpperCase().trim()
    const ip = soloIp(c.ip)
    if (!mac || !ip) continue

    const lease = porMac.get(mac)
    if (!lease) {
      faltan.push({ cliente: c.nombre, id: c.id, ip, mac, motivo: 'sin lease fija' })
      continue
    }

    const enRouter = soloIp(lease.address)
    if (enRouter !== ip) {
      corregir.push({
        cliente: c.nombre,
        id: c.id,
        mac,
        ip,
        router: enRouter || '—',
        // El caso del cambio de IP con el router caído.
        motivo: `el router le entrega ${enRouter || 'otra'} y el sistema dice ${ip}`,
      })
    }
  }

  return { faltan, corregir }
}
