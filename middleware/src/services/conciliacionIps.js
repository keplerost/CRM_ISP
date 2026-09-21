import { extraerIp, usuarioDeColaPppoe } from './importador.js'

/**
 * Comparar las IPs del sistema con las del MikroTik.
 *
 * ── Por qué hace falta ──
 *
 * Después de migrar un padrón, el sistema cree saber qué IP tiene cada abonado:
 * la que decía el archivo. El router sabe otra cosa — la que de verdad está
 * configurada. Entre las dos hay diferencias, y cada tipo de diferencia
 * significa algo distinto:
 *
 *   OCUPADA POR OTRO   El sistema dice que la 10.20.1.15 es de Pérez y en el
 *                      router está en la cola de González. Uno de los dos va a
 *                      quedar sin servicio, y el que reclame no va a ser el que
 *                      esté mal cargado.
 *
 *   EN LA LISTA DE     El abonado entra como activo pero su IP quedó en el
 *   MOROSOS            address-list de cortes del sistema anterior. Va a pagar
 *                      y no va a tener internet, y en el sistema todo se ve
 *                      bien. Es la peor de todas porque no da ninguna señal.
 *
 *   NO ESTÁ EN EL      El sistema le asignó una IP que el router no conoce.
 *   ROUTER             Puede ser un abonado que nunca se configuró, o una IP
 *                      inventada al llenar la planilla.
 *
 *   SOBRA EN EL        Hay algo en el router con una IP que ningún abonado del
 *   ROUTER             sistema tiene. O falta importarlo, o es un equipo que
 *                      nadie registró.
 *
 * ── Por qué solo informa ──
 *
 * Porque tocar el router para "arreglar" esto es cambiarle la IP a una casa que
 * hoy está andando. La decisión de a quién se le mueve la dirección es del ISP,
 * no de una rutina que corre sola.
 */

/**
 * Qué listas cortan de verdad en este router.
 *
 * ── Por qué no alcanza con el nombre configurado ──
 *
 * Porque el nombre lo escribió alguien a mano en la ficha del router, y si no
 * coincide con la realidad todo lo demás miente en la dirección más peligrosa:
 * hacia el "está todo bien".
 *
 * Pasó acá. El sistema tenía configurada `CORTE_MOROSOS` y el router de La Maná
 * corta con `Moroso` —239 direcciones adentro— porque venía de WispHub. Con el
 * nombre equivocado, la comparación no encuentra un solo abonado cortado y
 * devuelve un informe impecable; y peor, cortar desde el sistema escribe en una
 * lista que ninguna regla mira, así que el moroso sigue navegando y el sistema
 * anota el corte como hecho.
 *
 * ── Cómo se reconoce una lista que corta ──
 *
 * Por lo que le HACEN a esas direcciones, no por cómo se llaman:
 *
 *   Un `redirect` o un `dst-nat` en dstnat con `src-address-list` es un portal
 *   cautivo: al abonado se le manda todo a la página de pago.
 *
 *   Un `drop` o un `reject` en la cadena `forward` con `src-address-list` es un
 *   corte seco.
 *
 * Se exige `src-address-list` —la lista del que ORIGINA el tráfico— y no
 * `dst-address-list`: esta última son destinos bloqueados (las listas de
 * Arcotel), que no cortan a ningún abonado. Y en `filter` se exige la cadena
 * `forward`: un `drop` en `input` protege al router de un ataque, no le corta
 * el servicio a nadie.
 */
export function listasQueCortan(reglasFilter = [], reglasNat = []) {
  const listas = new Map()

  const anotar = (lista, como) => {
    if (!lista) return
    if (!listas.has(lista)) listas.set(lista, { lista, motivos: [] })
    listas.get(lista).motivos.push(como)
  }

  const apagada = (r) => String(r.disabled ?? 'false') === 'true'

  for (const r of reglasNat ?? []) {
    if (apagada(r)) continue
    if (!['redirect', 'dst-nat'].includes(r.action)) continue
    anotar(r['src-address-list'], `${r.action}${r.comment ? ` · ${r.comment}` : ''}`)
  }

  for (const r of reglasFilter ?? []) {
    if (apagada(r)) continue
    if (!['drop', 'reject', 'tarpit'].includes(r.action)) continue
    if (r.chain !== 'forward') continue
    anotar(r['src-address-list'], `${r.action}${r.comment ? ` · ${r.comment}` : ''}`)
  }

  return [...listas.values()]
}

/**
 * Todo lo que el router dice sobre direcciones IP, indexado por IP.
 *
 * Se juntan las cuatro fuentes porque cada una miente por separado: un abonado
 * PPPoE no tiene lease, uno de IP fija no tiene secret, y un cortado puede estar
 * solo en el address-list. Preguntarle a una sola fuente da una foto incompleta
 * y hace parecer que faltan abonados que están perfectamente configurados.
 */
export function indexarRouter(escaneo = {}, { listaMorosos = 'CORTE_MOROSOS', listasCorte } = {}) {
  // Las que cortan de verdad, si se pudieron leer las reglas; si no, la que
  // dice la ficha del router.
  const cortan = new Set(
    (listasCorte?.length ? listasCorte : [listaMorosos]).map((l) => String(l).toLowerCase()),
  )

  const porIp = new Map()

  const anotar = (ip, dato) => {
    if (!ip) return
    if (!porIp.has(ip)) porIp.set(ip, { ip, fuentes: [], nombres: [], morosa: false })
    const e = porIp.get(ip)
    e.fuentes.push(dato.fuente)
    if (dato.nombre) e.nombres.push(dato.nombre)
    if (dato.morosa) e.morosa = true
    if (dato.lista) e.lista = dato.lista
  }

  for (const s of escaneo.pppSecrets ?? []) {
    anotar(extraerIp(s['remote-address']), { fuente: 'ppp-secret', nombre: s.name })
  }

  for (const a of escaneo.pppActive ?? []) {
    anotar(extraerIp(a.address), { fuente: 'ppp-active', nombre: a.name })
  }

  for (const q of escaneo.simpleQueues ?? []) {
    // Las colas dinámicas de PPPoE apuntan a la interfaz, no a una IP: su dueño
    // sale del nombre. Sin esto, ese abonado parecería no tener cola.
    const usuario = usuarioDeColaPppoe(q.name)
    anotar(extraerIp(q.target), { fuente: 'simple-queue', nombre: usuario ?? q.name })
  }

  for (const l of escaneo.dhcpLeases ?? []) {
    anotar(extraerIp(l.address), { fuente: 'dhcp-lease', nombre: l.comment || l['host-name'] })
  }

  for (const e of escaneo.addressList ?? []) {
    const ip = extraerIp(e.address)
    const esMorosa = cortan.has(String(e.list ?? '').toLowerCase())
    anotar(ip, {
      fuente: `address-list:${e.list}`,
      nombre: e.comment,
      morosa: esMorosa,
      lista: e.list,
    })
  }

  return porIp
}

/**
 * Si los dos nombres son la misma persona.
 *
 * Los nombres nunca coinciden carácter por carácter entre dos sistemas: uno
 * guarda "OÑA RIERA JOSÉ" y el otro "jose.ona" o "ONA RIERA J". Comparar exacto
 * marcaría a toda la base como conflicto y el informe sería inservible.
 *
 * Se comparan las palabras de más de dos letras, sin acentos: si comparten al
 * menos una, es probable que sean la misma persona y no vale la pena molestar.
 */
export function pareceElMismo(unNombre, otroNombre) {
  const palabras = (s) =>
    new Set(
      String(s ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9]+/)
        .filter((p) => p.length > 2),
    )

  const a = palabras(unNombre)
  const b = palabras(otroNombre)
  if (!a.size || !b.size) return false

  for (const p of a) if (b.has(p)) return true
  return false
}

/**
 * El informe.
 *
 * `abonados` son los del sistema para ESE router: { id, codigo, nombre, ip,
 * estado, usuario_ppp }. `escaneo` es lo que devolvió el router.
 */
export function conciliar(
  abonados = [],
  escaneo = {},
  { listaMorosos = 'CORTE_MOROSOS', reglasFilter, reglasNat } = {},
) {
  /**
   * Qué listas cortan, y si la configurada es una de ellas.
   *
   * Esta comprobación va ANTES que cualquier otra porque, si falla, todo el
   * resto del informe es un "está todo bien" falso: con el nombre equivocado no
   * se detecta un solo abonado cortado.
   */
  const detectadas = listasQueCortan(reglasFilter, reglasNat)
  const seLeyeronLasReglas = reglasFilter != null || reglasNat != null
  const configuradaCorta = detectadas.some(
    (d) => d.lista.toLowerCase() === String(listaMorosos).toLowerCase(),
  )

  const enElRouter = indexarRouter(escaneo, {
    listaMorosos,
    listasCorte: detectadas.map((d) => d.lista),
  })
  const vistas = new Set()

  const ocupadas_por_otro = []
  const en_morosos = []
  const sin_configurar = []
  const duplicadas = []
  const conformes = []

  // Dos abonados del sistema con la misma IP. El índice único de la base lo
  // impide por router, pero un padrón recién importado puede traer la misma IP
  // en dos routers distintos por un error de carga.
  const porIpDelSistema = new Map()
  for (const c of abonados) {
    if (!c.ip) continue
    if (!porIpDelSistema.has(c.ip)) porIpDelSistema.set(c.ip, [])
    porIpDelSistema.get(c.ip).push(c)
  }

  for (const [ip, cs] of porIpDelSistema) {
    if (cs.length > 1) {
      duplicadas.push({ ip, abonados: cs.map((c) => ({ id: c.id, nombre: c.nombre })) })
    }
  }

  for (const c of abonados) {
    if (!c.ip) continue
    vistas.add(c.ip)

    const enRouter = enElRouter.get(c.ip)

    if (!enRouter) {
      // Un abonado de baja sin configuración en el router es lo esperable: se
      // la sacaron cuando se fue. Informarlo sería ruido.
      if (c.estado !== 'baja') {
        sin_configurar.push({
          id: c.id, codigo: c.codigo, nombre: c.nombre, ip: c.ip, estado: c.estado,
        })
      }
      continue
    }

    /**
     * La IP en la lista de cortes con el abonado activo.
     *
     * Es la peor de todas y la que justifica esta pantalla: el abonado paga,
     * en el sistema figura activo, y no tiene internet. No hay ninguna señal
     * salvo su llamada — y al que atiende el teléfono el sistema le va a decir
     * que está todo bien.
     */
    if (enRouter.morosa && c.estado === 'activo') {
      en_morosos.push({
        id: c.id, codigo: c.codigo, nombre: c.nombre, ip: c.ip, lista: enRouter.lista,
      })
    }

    // Quién figura en el router con esa dirección.
    const otros = enRouter.nombres.filter(
      (n) => n && !pareceElMismo(n, c.nombre) && !pareceElMismo(n, c.usuario_ppp),
    )

    if (otros.length) {
      ocupadas_por_otro.push({
        id: c.id,
        codigo: c.codigo,
        nombre: c.nombre,
        ip: c.ip,
        estado: c.estado,
        en_el_router: [...new Set(otros)],
        fuentes: [...new Set(enRouter.fuentes)],
      })
    } else if (!enRouter.morosa || c.estado !== 'activo') {
      conformes.push(c.ip)
    }
  }

  /**
   * Lo que está en el router y no en el sistema.
   *
   * Se dejan afuera las entradas del address-list de morosos: la IP de un
   * cortado que ya se dio de baja sigue ahí y no es un abonado que falte
   * importar. Y las que no tienen ningún nombre tampoco dicen nada útil.
   */
  const sobran_en_el_router = []
  for (const [ip, e] of enElRouter) {
    if (vistas.has(ip)) continue
    if (e.fuentes.every((f) => f.startsWith('address-list'))) continue
    sobran_en_el_router.push({
      ip,
      nombres: [...new Set(e.nombres)],
      fuentes: [...new Set(e.fuentes)],
    })
  }

  /**
   * El hallazgo que invalida a los demás.
   *
   * Si la lista configurada no es ninguna de las que cortan, el sistema le
   * escribe los cortes a una lista que ninguna regla mira: el moroso sigue
   * navegando y el sistema anota el corte como hecho. Y en la otra dirección,
   * ningún abonado cortado va a aparecer en este informe.
   */
  const corte =
    !seLeyeronLasReglas
      ? { revisado: false, configurada: listaMorosos, detectadas: [] }
      : {
          revisado: true,
          configurada: listaMorosos,
          detectadas: detectadas.map((d) => d.lista),
          motivos: detectadas,
          coincide: configuradaCorta,
          problema: configuradaCorta
            ? null
            : detectadas.length
              ? `El sistema está configurado para cortar con "${listaMorosos}", pero en este router las listas que cortan de verdad son ${detectadas.map((d) => `"${d.lista}"`).join(' y ')}. Los cortes que haga el sistema no van a cortar a nadie, y los que ya están cortados no aparecen en este informe.`
              : `No se encontró ninguna regla que corte por address-list en este router. El corte por mora desde el sistema no va a tener efecto.`,
        }

  return {
    corte,
    ocupadas_por_otro,
    en_morosos,
    sin_configurar,
    duplicadas,
    sobran_en_el_router,
    resumen: {
      abonados_con_ip: porIpDelSistema.size,
      ips_en_el_router: enElRouter.size,
      conformes: conformes.length,
      ocupadas_por_otro: ocupadas_por_otro.length,
      en_morosos: en_morosos.length,
      sin_configurar: sin_configurar.length,
      duplicadas: duplicadas.length,
      sobran_en_el_router: sobran_en_el_router.length,
    },
  }
}
