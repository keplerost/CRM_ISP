import test from 'node:test'
import assert from 'node:assert/strict'

import { aplicar, planear } from '../src/services/adopcionCorte.js'

/**
 * Hacerse cargo del corte que ya existe en el router.
 *
 * El escenario es el real de La Maná: el sistema configurado en
 * `CORTE_MOROSOS` y el router cortando con `Moroso`, con 239 direcciones
 * adentro y las reglas de WispHub.
 */

const ROUTER = { nombre: 'FTTH LA MANA', lista_morosos: 'CORTE_MOROSOS' }

const NAT = [
  {
    '.id': '*4A', chain: 'dstnat', action: 'accept',
    'src-address-list': 'Moroso', 'dst-address-list': 'servers_wisphub',
    comment: 'WispHub - Permitir pagina web morosos',
  },
  {
    '.id': '*4C', chain: 'dstnat', action: 'redirect', 'to-ports': '999', protocol: 'tcp',
    'src-address-list': 'Moroso', disabled: 'false',
    comment: 'WispHub - Suspension de clientes(TCP)',
  },
  {
    '.id': '*4E', chain: 'dstnat', action: 'redirect', 'to-ports': '999',
    'src-address-list': 'Aviso', disabled: 'false',
    comment: 'WispHub - Aviso de Pago',
  },
  { '.id': '*10', chain: 'srcnat', action: 'masquerade', disabled: 'false' },
]

const LISTA = [
  ...Array.from({ length: 5 }, (_, i) => ({ list: 'Moroso', address: `10.0.0.${i + 1}` })),
  { list: 'Aviso', address: '10.0.9.1' },
  { list: 'Cliente', address: '10.0.5.1' },
]

const plan = () => planear({ router: ROUTER, reglasFilter: [], reglasNat: NAT, addressList: LISTA })

// --- Qué encuentra ----------------------------------------------------------

test('encuentra la lista que corta de verdad y cuántos tiene adentro', () => {
  const p = plan()
  assert.equal(p.coincide, false)
  assert.equal(p.principal, 'Moroso')
  assert.equal(p.direcciones.en_el_router, 5)
  assert.equal(p.direcciones.a_copiar, 5)
})

test('la lista de aviso previo se informa aparte y no se toca', () => {
  /**
   * En un router de WispHub, "Moroso" son los cortados y "Aviso" son los que
   * están por caer. Migrar la de aviso como si fuera la de corte convertiría un
   * recordatorio en un corte.
   */
  const p = plan()
  assert.deepEqual(p.otras, ['Aviso'])
  assert.ok(p.advertencias.some((a) => /aviso previo/.test(a)))
  assert.ok(!p.reglas.some((r) => r.id === '*4E'), 'la regla de Aviso no entra en la migración')
})

test('junta las reglas que hay que clonar, y solo esas', () => {
  const p = plan()
  assert.deepEqual(p.reglas.map((r) => r.id).sort(), ['*4A', '*4C'])
})

test('avisa que la página de pago es del sistema anterior', () => {
  // Clonar la regla la conserva HOY. El día que WispHub se apague, el moroso va
  // a ver un error en vez del aviso de pago, y eso hay que saberlo antes.
  const p = plan()
  assert.ok(p.advertencias.some((a) => /página de pago/.test(a)))
})

test('cuando ya coincide, no hay nada que ofrecer', () => {
  const p = planear({
    router: { nombre: 'x', lista_morosos: 'Moroso' },
    reglasNat: NAT,
    addressList: LISTA,
  })
  assert.equal(p.coincide, true)
  assert.deepEqual(p.opciones, [])
})

test('un router sin ninguna regla de corte lo dice', () => {
  const p = planear({ router: ROUTER, reglasNat: [], addressList: [] })
  assert.equal(p.principal, null)
  assert.deepEqual(p.opciones, [], 'no se puede adoptar ni migrar lo que no existe')
  assert.ok(p.advertencias.some((a) => /ninguna regla que corte/.test(a)))
})

test('las dos salidas se describen por lo que le pasa al abonado', () => {
  const p = plan()
  assert.deepEqual(p.opciones.map((o) => o.modo), ['adoptar', 'migrar'])
  assert.equal(p.opciones[0].riesgo, 'ninguno')
  assert.match(p.opciones[1].riesgo, /abonados conectados/)
})

// --- Qué hace ---------------------------------------------------------------

/** Un router de mentira que anota lo que le piden, en orden. */
function espia() {
  const pasos = []
  return {
    pasos,
    fijarLista: async (l) => pasos.push(['fijarLista', l]),
    copiar: async (o, d) => (pasos.push(['copiar', o, d]), { copiadas: 5 }),
    clonar: async (r) => (pasos.push(['clonar', r.tipo, r.id, r.lista]), { ok: true }),
    apagar: async (r) => (pasos.push(['apagar', r.tipo, r.id]), { ok: true }),
  }
}

test('adoptar no toca el router', async () => {
  const a = espia()
  const r = await aplicar(plan(), 'adoptar', a)

  assert.deepEqual(a.pasos, [['fijarLista', 'Moroso']])
  assert.equal(r.lista, 'Moroso')
})

test('migrar hace las tres cosas, y en ese orden', async () => {
  /**
   * El orden no es preferencia, es seguridad.
   *
   * Copiar es inofensivo: una lista que ninguna regla mira no le hace nada a
   * nadie. Clonar deja a los cortados cortados por dos caminos a la vez, que es
   * redundante pero no rompe. Apagar las viejas va ÚLTIMO: al revés, los 239
   * abonados tendrían internet gratis durante los segundos que tarde el resto.
   */
  const a = espia()
  await aplicar(plan(), 'migrar', a)

  const orden = a.pasos.map((p) => p[0])
  assert.equal(orden[0], 'copiar', 'primero copiar, que no rompe nada')
  assert.ok(
    orden.lastIndexOf('clonar') < orden.indexOf('apagar'),
    'no se puede apagar una regla vieja antes de tener la nueva',
  )
  assert.equal(orden[orden.length - 1], 'fijarLista')
})

test('migrar clona y apaga exactamente las reglas del corte', async () => {
  const a = espia()
  const r = await aplicar(plan(), 'migrar', a)

  const clonadas = a.pasos.filter((p) => p[0] === 'clonar').map((p) => p[2])
  const apagadas = a.pasos.filter((p) => p[0] === 'apagar').map((p) => p[2])

  assert.deepEqual(clonadas.sort(), ['*4A', '*4C'])
  assert.deepEqual(apagadas.sort(), ['*4A', '*4C'])
  assert.equal(r.clonadas, 2)
  assert.equal(r.apagadas, 2)
})

test('una regla que ya estaba apagada no se clona ni se toca', async () => {
  // No corta a nadie: clonarla sería copiar una regla muerta, y apagarla otra
  // vez es ruido en el registro del equipo. Se agrega una segunda regla de corte
  // encendida para que "Moroso" siga siendo la lista de corte.
  const nat = [
    ...NAT.map((r) => (r['.id'] === '*4C' ? { ...r, disabled: 'true' } : r)),
    {
      '.id': '*4F', chain: 'dstnat', action: 'redirect', 'to-ports': '999', protocol: 'udp',
      'src-address-list': 'Moroso', disabled: 'false', comment: 'Suspension (UDP)',
    },
  ]
  const p = planear({ router: ROUTER, reglasNat: nat, addressList: LISTA })

  const a = espia()
  await aplicar(p, 'migrar', a)

  assert.deepEqual(
    a.pasos.filter((x) => x[0] === 'clonar').map((x) => x[2]).sort(),
    ['*4A', '*4F'],
    'la regla apagada queda afuera',
  )
})

test('una lista llena de gente con su regla apagada es un hallazgo', () => {
  /**
   * De los que no dan ninguna señal: hay direcciones ahí porque alguien las
   * cortó, pero la regla que las cortaba está deshabilitada. Esa gente está
   * navegando gratis y en el sistema anterior figura cortada.
   *
   * Y protege de un error feo acá: sin regla encendida, "Moroso" no se detecta
   * como lista de corte, y el planificador podría tomar como principal la de
   * AVISO —que sí la tiene encendida— y migrar un recordatorio como si fuera un
   * corte.
   */
  const nat = NAT.map((r) => (r['.id'] === '*4C' ? { ...r, disabled: 'true' } : r))
  const p = planear({ router: ROUTER, reglasNat: nat, addressList: LISTA })

  assert.ok(
    p.advertencias.some((a) => /"Moroso" tiene 5 direcciones adentro pero su regla/.test(a)),
    'tiene que avisar que hay cinco cortados navegando',
  )
})

test('los clones apuntan a la lista del sistema', async () => {
  const a = espia()
  await aplicar(plan(), 'migrar', a)
  for (const p of a.pasos.filter((x) => x[0] === 'clonar')) {
    assert.equal(p[3], 'CORTE_MOROSOS')
  }
})

test('un modo inventado no hace nada a medias', async () => {
  const a = espia()
  await assert.rejects(() => aplicar(plan(), 'cualquier-cosa', a), /Modo desconocido/)
  assert.deepEqual(a.pasos, [])
})
