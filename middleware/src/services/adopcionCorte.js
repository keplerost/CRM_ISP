import { listasQueCortan } from './conciliacionIps.js'

/**
 * Hacerse cargo del corte que ya existe en el router.
 *
 * ── El problema ──
 *
 * El sistema tiene configurada una lista de cortes —`CORTE_MOROSOS`— y el router
 * corta con otra, la que le dejó el sistema anterior. Mientras no coincidan,
 * cortar desde el sistema escribe en una lista que ninguna regla mira: el moroso
 * sigue navegando y el sistema anota el corte como hecho.
 *
 * ── Las dos salidas, y por qué no son equivalentes ──
 *
 * ADOPTAR es cambiar un campo en la ficha del router: el sistema pasa a usar la
 * lista que ya corta. No se toca nada en el equipo. Los que ya están cortados
 * siguen cortados, los que paguen se destraban de verdad, y el informe de IPs
 * empieza a verlos. Es reversible cambiando el campo de vuelta.
 *
 * MIGRAR es traer todo a la lista del sistema: copiar las direcciones, clonar
 * las reglas apuntando a la lista nueva y apagar las viejas. Deja el router
 * ordenado a nombre de este sistema, pero toca el firewall de un equipo con
 * abonados adentro.
 *
 * ── La trampa que hay que evitar ──
 *
 * Copiar las direcciones y NO tocar las reglas es lo peor de los dos mundos, y
 * es lo que parece razonable a primera vista. La lista nueva no corta a nadie
 * —ninguna regla la mira— así que los cortes del sistema siguen sin funcionar. Y
 * cuando un abonado pague, el sistema lo va a sacar de la lista nueva mientras
 * la vieja lo sigue teniendo: pagó y sigue sin internet, y el sistema dice que
 * está todo bien.
 *
 * Por eso migrar no ofrece pasos sueltos. O hace las tres cosas, o no hace
 * ninguna.
 */

/** Los campos de una regla que se muestran al planear. Lo demás es ruido. */
const resumirRegla = (r) => ({
  id: r['.id'],
  cadena: r.chain,
  accion: r.action,
  lista: r['src-address-list'],
  comentario: r.comment ?? null,
  apagada: String(r.disabled ?? 'false') === 'true',
})

/**
 * Qué pasaría, sin hacer nada.
 *
 * `router` es la fila de `routers_mikrotik`; el resto se lee del equipo.
 */
export function planear({ router, reglasFilter = [], reglasNat = [], addressList = [] }) {
  const configurada = router.lista_morosos
  const detectadas = listasQueCortan(reglasFilter, reglasNat)
  const coincide = detectadas.some((d) => d.lista.toLowerCase() === String(configurada).toLowerCase())

  const enLista = (nombre) =>
    (addressList ?? []).filter(
      (e) => String(e.list ?? '').toLowerCase() === String(nombre).toLowerCase(),
    )

  // Cuando el router corta con más de una lista se toma la que más
  // direcciones tiene: en un router de WispHub, "Moroso" son los cortados y
  // "Aviso" son los que están por caer. La otra se informa aparte.
  const ordenadas = [...detectadas].sort((a, b) => enLista(b.lista).length - enLista(a.lista).length)
  const principal = ordenadas[0] ?? null
  const otras = ordenadas.slice(1)

  const delRouter = principal ? enLista(principal.lista) : []
  const nuestras = enLista(configurada)
  const yaEstan = new Set(nuestras.map((e) => e.address))
  const aCopiar = delRouter.filter((e) => !yaEstan.has(e.address))

  const reglasDelCorte = [
    ...(reglasNat ?? [])
      .filter((r) => principal && r['src-address-list'] === principal.lista)
      .map((r) => ({ ...resumirRegla(r), tipo: 'nat' })),
    ...(reglasFilter ?? [])
      .filter((r) => principal && r['src-address-list'] === principal.lista)
      .map((r) => ({ ...resumirRegla(r), tipo: 'filter' })),
  ]

  const advertencias = []

  if (!principal) {
    advertencias.push(
      'Este router no tiene ninguna regla que corte por address-list. Antes de que el corte por mora sirva para algo hay que crear esa regla en el equipo.',
    )
  }

  /**
   * Una lista llena de gente cuya regla está APAGADA.
   *
   * Es un hallazgo por sí mismo, y de los que no da ninguna señal: hay
   * direcciones ahí adentro porque alguien las cortó, pero la regla que las
   * cortaba está deshabilitada. Esa gente está navegando gratis y en el sistema
   * anterior figura cortada.
   *
   * Además protege de un error feo acá: sin la regla habilitada, esa lista no se
   * detecta como "de corte", y el planificador podría terminar tomando como
   * principal la lista de AVISO —que sí tiene su regla encendida— y migrar un
   * recordatorio como si fuera un corte.
   */
  const nombresQueCortan = new Set(detectadas.map((d) => d.lista.toLowerCase()))
  const apagadasConGente = new Map()

  for (const r of [...(reglasNat ?? []), ...(reglasFilter ?? [])]) {
    const lista = r['src-address-list']
    if (!lista || String(r.disabled ?? 'false') !== 'true') continue
    if (nombresQueCortan.has(lista.toLowerCase())) continue
    if (!['redirect', 'dst-nat', 'drop', 'reject', 'tarpit'].includes(r.action)) continue
    const cuantas = enLista(lista).length
    if (cuantas > 0) apagadasConGente.set(lista, cuantas)
  }

  for (const [lista, cuantas] of apagadasConGente) {
    advertencias.push(
      `La lista "${lista}" tiene ${cuantas} direcciones adentro pero su regla de corte está APAGADA en el router. ` +
        'Esa gente figura cortada en el sistema anterior y está navegando. Revisá esa regla antes de migrar nada.',
    )
  }

  if (otras.length) {
    advertencias.push(
      `El router también corta con ${otras.map((o) => `"${o.lista}"`).join(' y ')}. ` +
        `Eso no se toca: en un router de WispHub esa suele ser la lista de aviso previo, que avisa pero no corta del todo.`,
    )
  }

  /**
   * La redirección a la página de WispHub.
   *
   * Es lo que hace que el moroso vea "pagá acá" en vez de una pantalla en
   * blanco. Apunta a un puerto del propio router que sirve WispHub; clonar la
   * regla la conserva HOY, pero el día que WispHub se apague esa página deja de
   * existir y el abonado va a ver un error en vez de un aviso.
   */
  if (reglasDelCorte.some((r) => r.accion === 'redirect' || r.accion === 'dst-nat')) {
    advertencias.push(
      'El corte de este router no tira el tráfico: redirige al moroso a una página de pago del sistema anterior. Los clones la conservan, pero cuando ese sistema se apague la página va a dejar de existir y el abonado va a ver un error en vez del aviso de pago.',
    )
  }

  return {
    router: router.nombre,
    configurada,
    coincide,
    detectadas: detectadas.map((d) => d.lista),
    principal: principal?.lista ?? null,
    motivos: principal?.motivos ?? [],
    otras: otras.map((o) => o.lista),
    direcciones: {
      en_el_router: delRouter.length,
      en_la_nuestra: nuestras.length,
      a_copiar: aCopiar.length,
      ejemplos: aCopiar.slice(0, 10).map((e) => e.address),
    },
    reglas: reglasDelCorte,
    advertencias,
    opciones: opcionesDe({ coincide, principal, delRouter, aCopiar, reglasDelCorte, configurada }),
  }
}

/**
 * Las dos salidas, descritas para poder elegir.
 *
 * Se describen con lo que le pasa al ABONADO y no con lo que se toca en el
 * equipo: "los que ya están cortados siguen cortados" es lo que hay que saber
 * para decidir, y "se clonan tres reglas dstnat" no.
 */
function opcionesDe({ coincide, principal, delRouter, aCopiar, reglasDelCorte, configurada }) {
  if (coincide) return []
  if (!principal) return []

  return [
    {
      modo: 'adoptar',
      titulo: `Usar la lista que ya corta ("${principal.lista}")`,
      que_hace: 'Cambia un campo en la ficha del router. No se toca nada en el equipo.',
      resultado: [
        `Los ${delRouter.length} que ya están cortados siguen cortados, y el sistema pasa a verlos.`,
        'Cuando uno pague, el sistema lo saca de la lista correcta y recupera el servicio de verdad.',
        'Se deshace cambiando el campo de vuelta.',
      ],
      riesgo: 'ninguno',
    },
    {
      modo: 'migrar',
      titulo: `Traer todo a "${configurada}"`,
      que_hace:
        `Copia ${aCopiar.length} direcciones, clona ${reglasDelCorte.length} reglas apuntando a la lista nueva —cada una en el mismo lugar de la cadena— y apaga las viejas.`,
      resultado: [
        'El router queda ordenado a nombre de este sistema y sin rastros del anterior.',
        `Las ${reglasDelCorte.length} reglas viejas quedan APAGADAS, no borradas: volver atrás es encenderlas y apagar las nuevas.`,
        'La lista vieja queda con sus direcciones adentro, inerte.',
      ],
      riesgo:
        'Toca el firewall de un router con abonados conectados. Si algo sale mal en el medio, puede quedar gente cortada que pagó o gente navegando que no. Hacelo con el respaldo del router hecho y no en hora pico.',
    },
  ]
}

/**
 * Ejecuta lo elegido.
 *
 * `acciones` es el mínimo que hace falta del mundo exterior, inyectado: así esto
 * se puede probar entero sin un router y sin una base.
 */
export async function aplicar(plan, modo, acciones) {
  if (modo === 'adoptar') {
    await acciones.fijarLista(plan.principal)
    return {
      modo,
      lista: plan.principal,
      hecho: `El sistema ahora corta con "${plan.principal}", que es la lista que este router usa de verdad.`,
    }
  }

  if (modo !== 'migrar') {
    throw new Error(`Modo desconocido: ${modo}`)
  }

  /**
   * El orden importa y es este:
   *
   *   1. Copiar las direcciones. Es lo único inofensivo: una lista con
   *      direcciones que ninguna regla mira no le hace nada a nadie.
   *
   *   2. Clonar las reglas. Desde acá los cortados quedan cortados por DOS
   *      caminos a la vez, que es redundante pero no rompe nada.
   *
   *   3. Apagar las viejas. Recién acá el corte pasa a depender de las nuevas.
   *
   * Al revés —apagar primero— dejaría a 239 abonados con internet gratis
   * durante los segundos que tarde el resto.
   */
  const copiadas = await acciones.copiar(plan.principal, plan.configurada)

  const clonadas = []
  for (const r of plan.reglas) {
    if (r.apagada) continue // una regla que ya estaba apagada no corta: no se clona
    clonadas.push(await acciones.clonar({ tipo: r.tipo, id: r.id, lista: plan.configurada }))
  }

  const apagadas = []
  for (const r of plan.reglas) {
    if (r.apagada) continue
    apagadas.push(await acciones.apagar({ tipo: r.tipo, id: r.id }))
  }

  await acciones.fijarLista(plan.configurada)

  return {
    modo,
    lista: plan.configurada,
    copiadas,
    clonadas: clonadas.length,
    apagadas: apagadas.length,
    hecho:
      `El corte pasó a "${plan.configurada}". Las ${apagadas.length} reglas viejas quedaron apagadas, no borradas: ` +
      'volver atrás es encenderlas y apagar las nuevas.',
  }
}
