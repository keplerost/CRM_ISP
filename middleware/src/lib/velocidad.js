/**
 * Traducción entre cómo guarda las velocidades el sistema y cómo las escribe
 * RouterOS.
 *
 * Vive aparte porque es la parte de "cambiar un plan" que no se puede verificar
 * mirando el equipo: si la lectura del perfil se interpreta mal, la pantalla
 * dice que el plan de 300 megas está bien aplicado cuando el perfil limita a
 * 150. Nadie lo nota hasta que un cliente mide su velocidad y llama.
 */

const MULTIPLICADOR = { k: 1, m: 1000, g: 1000000 }

/** "150M" → 150000 kbps · "51200k" → 51200 · "1G" → 1000000. */
export function aKbps(texto) {
  const m = String(texto ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*([kmg])?$/i)
  if (!m) return null

  const valor = Number(m[1])
  // Sin unidad RouterOS asume bits por segundo, no kbps: "150000000" es 150 Mbps.
  const unidad = m[2]?.toLowerCase()
  return unidad ? Math.round(valor * MULTIPLICADOR[unidad]) : Math.round(valor / 1000)
}

/**
 * El `rate-limit` de un perfil PPP.
 *
 * Formato de RouterOS: `rx-rate[/tx-rate] [ráfaga…]` y varios campos más que
 * acá no interesan. Lo que importa es el primer par.
 *
 * Ojo con la perspectiva, que es la trampa de este campo: `rx` es lo que el
 * router RECIBE del abonado —su subida— y `tx` lo que le manda —su bajada—.
 * Invertirlo hace que un plan de 100/10 parezca aplicado cuando en realidad al
 * cliente le dieron 10 de bajada.
 */
export function parsearRateLimit(texto) {
  const primero = String(texto ?? '').trim().split(/\s+/)[0]
  if (!primero) return null

  const [rx, tx] = primero.split('/')
  const subida = aKbps(rx)
  const bajada = tx ? aKbps(tx) : subida

  if (subida == null || bajada == null) return null
  return { subida_kbps: subida, bajada_kbps: bajada }
}

/** Cómo se escribe un plan como `rate-limit`: subida primero. */
export const aRateLimit = ({ subida_kbps, bajada_kbps }) => `${subida_kbps}k/${bajada_kbps}k`

/** 102400 → "100 Mbps" · 30000 → "30 Mbps" · 512 → "512 kbps". */
export function enMbps(kbps) {
  // `Number(null)` es 0, que se vería como "0 kbps" —un límite de cero, o sea
  // sin internet— cuando lo que pasa es que el dato no está cargado.
  if (kbps == null || kbps === '') return '—'

  const n = Number(kbps)
  if (!Number.isFinite(n)) return '—'
  if (n < 1000) return `${n} kbps`
  const mbps = n / 1000
  return `${Number.isInteger(mbps) ? mbps : mbps.toFixed(1)} Mbps`
}

/**
 * Un plan traducido a los campos de una Simple Queue.
 *
 * Toda la traducción vive acá, y con ella la trampa de este formato: **RouterOS
 * escribe siempre subida primero**, mientras que un plan se habla al revés —"100
 * megas" es la bajada—. Cada par se da vuelta al salir.
 *
 * La otra regla la impuso el equipo de producción: `burst-limit` no se puede
 * mandar solo. RouterOS exige los tres —cuánto, desde qué caudal y por cuántos
 * segundos— y si falta uno rechaza la cola ENTERA con "no download-burst-time".
 * O sea que un burst a medio configurar dejaba al abonado sin que se le
 * aplicara siquiera su velocidad.
 *
 * Por eso nada acá tira una excepción: lo que está mal configurado se omite y
 * se devuelve el motivo. La velocidad se aplica igual, que es lo que el abonado
 * está pagando; el aviso llega a quien puede corregirlo.
 */
export function camposDeCola(plan) {
  const avisos = []

  // Se manda SIEMPRE el juego completo, con el valor neutro de RouterOS cuando
  // algo no está configurado. Omitir un campo no lo borra: `set` deja lo que
  // había, así que quitarle la ráfaga a un plan y volver a sincronizar dejaría
  // a los abonados con la ráfaga vieja para siempre. Sincronizar tiene que
  // significar "la cola queda igual al plan", no "se le suma lo nuevo".
  const campos = {
    'max-limit': `${plan.subida_kbps}k/${plan.bajada_kbps}k`,
    'limit-at': '0/0',
    'burst-limit': '0/0',
    'burst-threshold': '0/0',
    'burst-time': '0s/0s',
    priority: '8/8',
  }

  // --- Caudal garantizado --------------------------------------------------
  const garB = plan.garantizado_bajada_kbps
  const garS = plan.garantizado_subida_kbps
  if (garB || garS) {
    if (!garB || !garS) {
      avisos.push('El caudal garantizado necesita los dos valores, bajada y subida. No se aplicó.')
    } else if (garB > plan.bajada_kbps || garS > plan.subida_kbps) {
      avisos.push(
        `El caudal garantizado (${enMbps(garB)}/${enMbps(garS)}) es mayor que la velocidad del plan (${enMbps(plan.bajada_kbps)}/${enMbps(plan.subida_kbps)}). El router lo rechazaría, así que no se aplicó.`,
      )
    } else {
      campos['limit-at'] = `${garS}k/${garB}k`
    }
  }

  // --- Ráfaga --------------------------------------------------------------
  const burst = [
    plan.burst_bajada_kbps,
    plan.burst_subida_kbps,
    plan.umbral_bajada_kbps,
    plan.umbral_subida_kbps,
    plan.burst_segundos_bajada,
    plan.burst_segundos_subida,
  ]
  const cargados = burst.filter(Boolean).length

  if (cargados > 0 && cargados < 6) {
    avisos.push(
      'La ráfaga está a medio configurar. RouterOS necesita los seis valores —cuánto, desde qué caudal y por cuántos segundos, en bajada y en subida— o rechaza la cola entera. No se aplicó.',
    )
  } else if (cargados === 6) {
    const [bB, bS, uB, uS, sB, sS] = burst

    if (bB < plan.bajada_kbps || bS < plan.subida_kbps) {
      avisos.push(
        `La ráfaga (${enMbps(bB)}/${enMbps(bS)}) es menor que la velocidad del plan (${enMbps(plan.bajada_kbps)}/${enMbps(plan.subida_kbps)}). Una ráfaga por debajo del máximo no tiene sentido y el router la rechaza. No se aplicó.`,
      )
    } else if (uB > plan.bajada_kbps || uS > plan.subida_kbps) {
      avisos.push(
        `El umbral de ráfaga (${enMbps(uB)}/${enMbps(uS)}) supera la velocidad del plan: se le habilitaría la ráfaga siempre, que es lo mismo que no tener plan. No se aplicó.`,
      )
    } else {
      campos['burst-limit'] = `${bS}k/${bB}k`
      campos['burst-threshold'] = `${uS}k/${uB}k`
      campos['burst-time'] = `${sS}s/${sB}s`
    }
  }

  // --- Prioridad -----------------------------------------------------------
  if (plan.prioridad) campos.priority = `${plan.prioridad}/${plan.prioridad}`

  return { campos, avisos }
}

/**
 * Cómo tiene que quedar el perfil PPP de un plan en el router.
 *
 * El `rate-limit` va VACÍO, y no es un olvido: en FTTH el caudal lo controla la
 * traffic table de la OLT, que es la que manda sobre la fibra. Un límite en el
 * perfil pelearía con ella y el abonado terminaría con el menor de los dos, sin
 * que el número aparezca en ningún lado del sistema.
 *
 * Es la parte contraintuitiva de la arquitectura —un perfil de plan sin
 * velocidad parece un error— y por eso está acá, con nombre propio y probada,
 * en vez de como una cadena vacía suelta en medio de una llamada.
 *
 * Los abonados con IP fija no pasan por acá: a ellos los limita su Simple
 * Queue, que sí lleva los números (`camposDeCola`).
 */
export function perfilDePlan(plan) {
  const nombre = plan?.perfil_ppp?.trim() || plan?.nombre
  if (!nombre) throw new Error('El plan no tiene nombre de perfil PPP')

  const { valor, avisos } = rateLimitDePlan(plan)
  const enElRouter = plan?.control_pppoe === 'mikrotik'

  return {
    nombre,
    rateLimit: valor,
    comentario: `${plan.nombre} · caudal en ${enElRouter ? 'el router' : 'la OLT'}`,
    avisos,
  }
}

/**
 * El `rate-limit` que le corresponde al perfil PPP de un plan.
 *
 * Vacío cuando el caudal lo controla la OLT — que es lo normal en fibra y lo
 * contraintuitivo de esta arquitectura: un perfil de plan sin velocidad parece
 * un error, pero un límite acá competiría con la traffic table y ganaría el
 * menor de los dos, sin que ese número aparezca en ninguna pantalla.
 *
 * Cuando el control es del router, se arma la cadena completa. El formato es
 * posicional y no se pueden saltear grupos: si hay prioridad pero no ráfaga,
 * los huecos van en `0/0`. La forma está copiada de la que devuelven los
 * propios equipos —`150M/150M 0/0 0/0 10/10 8/8 0/0`— y no de la documentación,
 * que difiere entre versiones en si la prioridad es un valor o un par.
 *
 * Y como en las colas: lo que está mal configurado se omite con su motivo, pero
 * la velocidad se aplica igual. Un rate-limit malformado hace que RouterOS
 * rechace el perfil entero, y ahí el abonado se queda sin nada.
 */
export function rateLimitDePlan(plan) {
  if (plan?.control_pppoe !== 'mikrotik') return { valor: '', avisos: [] }

  const avisos = []
  const kb = (n) => `${n}k`
  const velocidad = `${kb(plan.subida_kbps)}/${kb(plan.bajada_kbps)}`

  // --- Ráfaga: los seis valores o ninguno ---------------------------------
  const burst = [
    plan.burst_bajada_kbps,
    plan.burst_subida_kbps,
    plan.umbral_bajada_kbps,
    plan.umbral_subida_kbps,
    plan.burst_segundos_bajada,
    plan.burst_segundos_subida,
  ]
  const cargados = burst.filter(Boolean).length

  let rafaga = '0/0'
  let umbral = '0/0'
  let tiempo = '0/0'

  if (cargados > 0 && cargados < 6) {
    avisos.push(
      'La ráfaga está a medio configurar y no se aplicó al perfil: RouterOS necesita cuánto, desde qué caudal y por cuántos segundos, en los dos sentidos.',
    )
  } else if (cargados === 6) {
    const [bB, bS, uB, uS, sB, sS] = burst

    if (bB < plan.bajada_kbps || bS < plan.subida_kbps) {
      avisos.push(
        `La ráfaga (${enMbps(bB)}/${enMbps(bS)}) es menor que la velocidad del plan y no se aplicó al perfil.`,
      )
    } else if (uB > plan.bajada_kbps || uS > plan.subida_kbps) {
      avisos.push(
        'El umbral de ráfaga supera la velocidad del plan: se habilitaría siempre. No se aplicó al perfil.',
      )
    } else {
      rafaga = `${kb(bS)}/${kb(bB)}`
      umbral = `${kb(uS)}/${kb(uB)}`
      tiempo = `${sS}/${sB}`
    }
  }

  // --- Prioridad ----------------------------------------------------------
  const p = plan.prioridad ?? 8
  const prioridad = `${p}/${p}`

  // --- Caudal garantizado -------------------------------------------------
  let minimo = '0/0'
  const garB = plan.garantizado_bajada_kbps
  const garS = plan.garantizado_subida_kbps

  if (garB || garS) {
    if (!garB || !garS) {
      avisos.push('El caudal garantizado necesita los dos valores y no se aplicó al perfil.')
    } else if (garB > plan.bajada_kbps || garS > plan.subida_kbps) {
      avisos.push(
        'El caudal garantizado es mayor que la velocidad del plan y no se aplicó al perfil.',
      )
    } else {
      minimo = `${kb(garS)}/${kb(garB)}`
    }
  }

  return {
    valor: `${velocidad} ${rafaga} ${umbral} ${tiempo} ${prioridad} ${minimo}`,
    avisos,
  }
}

/**
 * ¿El perfil del equipo es el que el plan espera?
 *
 * Depende de quién controla el caudal:
 *
 *   OLT       El perfil va sin rate-limit. Uno con límite no es "más seguro":
 *             es un segundo tope compitiendo con la traffic table, y gana el
 *             menor sin que ese número figure en ninguna pantalla.
 *
 *   MikroTik  El perfil es el que limita, así que su velocidad tiene que
 *             coincidir con la del plan. Uno sin límite deja al abonado
 *             navegando sin tope.
 */
export function revisarPerfilDePlan(perfil, plan) {
  if (!perfil) return { ok: false, motivo: 'no_existe' }

  const limite = String(perfil['rate-limit'] ?? '').trim()
  const enElRouter = plan?.control_pppoe === 'mikrotik'

  if (!enElRouter) {
    return limite ? { ok: false, motivo: 'no_deberia_limitar', limite, aplica: parsearRateLimit(limite) } : { ok: true }
  }

  if (!limite) return { ok: false, motivo: 'sin_limite' }

  const aplica = parsearRateLimit(limite)
  if (!aplica) return { ok: false, motivo: 'ilegible', limite }

  return coincide(plan, aplica)
    ? { ok: true, aplica }
    : { ok: false, motivo: 'difiere', limite, aplica }
}

/**
 * ¿El perfil aplica lo que dice el plan?
 *
 * Se admite un 5% de diferencia porque los planes suelen cargarse en múltiplos
 * de 1024 (102400 kbps = "100 megas") y los perfiles en múltiplos de 1000
 * ("100M" = 100000). Son el mismo plan comercial y marcarlos como distintos
 * sería avisar de un problema que no existe, todos los días.
 */
export function coincide(plan, perfil) {
  if (!plan || !perfil) return false
  const cerca = (a, b) => a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) <= 0.05
  return cerca(plan.bajada_kbps, perfil.bajada_kbps) && cerca(plan.subida_kbps, perfil.subida_kbps)
}
