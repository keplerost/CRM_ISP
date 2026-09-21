import test from 'node:test'
import assert from 'node:assert/strict'

import {
  aKbps,
  parsearRateLimit,
  aRateLimit,
  enMbps,
  coincide,
  camposDeCola,
  perfilDePlan,
  revisarPerfilDePlan,
  rateLimitDePlan,
} from '../src/lib/velocidad.js'
import { buscarColaPorIp } from '../src/drivers/mikrotikApi.js'

/**
 * Aplicar un plan nuevo a los abonados que ya lo tienen.
 *
 * Es la parte que no se puede verificar mirando el equipo: si la lectura del
 * perfil se interpreta mal, la pantalla dice que el plan de 300 megas está bien
 * aplicado mientras el perfil limita a 150. Nadie lo nota hasta que un cliente
 * mide su velocidad y llama.
 */

test('lee las unidades de RouterOS', () => {
  assert.equal(aKbps('150M'), 150000)
  assert.equal(aKbps('51200k'), 51200)
  assert.equal(aKbps('1G'), 1000000)
  assert.equal(aKbps('10m'), 10000)
})

test('sin unidad, RouterOS habla en bits por segundo', () => {
  // "150000000" son 150 Mbps, no 150 millones de kbps. Interpretarlo como kbps
  // haría que un perfil correcto figure como mil veces más rápido.
  assert.equal(aKbps('150000000'), 150000)
})

test('lo que no es una velocidad devuelve null', () => {
  assert.equal(aKbps(''), null)
  assert.equal(aKbps('rápido'), null)
  assert.equal(aKbps(null), null)
})

test('parsea el rate-limit real de un perfil del router', () => {
  // Tal cual lo devolvió el CCR2116 de producción.
  const r = parsearRateLimit('150M/150M 0/0 0/0 10/10 8/8 0/0')
  assert.deepEqual(r, { subida_kbps: 150000, bajada_kbps: 150000 })
})

test('el primer valor es la SUBIDA del abonado, no la bajada', () => {
  // La trampa de este campo: rx es lo que el router recibe del cliente. Al
  // revés, un plan de 100/10 parecería aplicado cuando al cliente le dieron 10
  // de bajada.
  const r = parsearRateLimit('10M/100M')
  assert.equal(r.subida_kbps, 10000)
  assert.equal(r.bajada_kbps, 100000)
})

test('un rate-limit con un solo valor limita igual en los dos sentidos', () => {
  assert.deepEqual(parsearRateLimit('20M'), { subida_kbps: 20000, bajada_kbps: 20000 })
})

test('un perfil sin rate-limit devuelve null, no cero', () => {
  // Cero pasaría por "limitado a nada"; null dice "no limita", que es lo real.
  assert.equal(parsearRateLimit(''), null)
  assert.equal(parsearRateLimit(undefined), null)
})

test('escribe el rate-limit con la subida primero', () => {
  assert.equal(aRateLimit({ subida_kbps: 10240, bajada_kbps: 102400 }), '10240k/102400k')
})

test('1024 y 1000 son el mismo plan comercial', () => {
  // El plan se carga como 102400 kbps ("100 megas") y el perfil como "100M" =
  // 100000. Marcarlos como distintos sería avisar de un problema inexistente
  // todos los días, hasta que nadie mire más los avisos.
  const plan = { bajada_kbps: 102400, subida_kbps: 10240 }
  assert.ok(coincide(plan, { bajada_kbps: 100000, subida_kbps: 10000 }))
})

test('150 contra 300 sí es una diferencia', () => {
  const plan = { bajada_kbps: 300000, subida_kbps: 300000 }
  assert.ok(!coincide(plan, { bajada_kbps: 150000, subida_kbps: 150000 }))
})

test('una diferencia solo en la subida también cuenta', () => {
  const plan = { bajada_kbps: 100000, subida_kbps: 50000 }
  assert.ok(!coincide(plan, { bajada_kbps: 100000, subida_kbps: 10000 }))
})

test('sin perfil no coincide, en vez de romper', () => {
  assert.ok(!coincide({ bajada_kbps: 100, subida_kbps: 100 }, null))
  assert.ok(!coincide(null, { bajada_kbps: 100, subida_kbps: 100 }))
})

test('muestra las velocidades como se hablan', () => {
  assert.equal(enMbps(102400), '102.4 Mbps')
  assert.equal(enMbps(30000), '30 Mbps')
  assert.equal(enMbps(512), '512 kbps')
  assert.equal(enMbps(null), '—')
})

// --- El plan traducido a una cola -------------------------------------------

/** 50 megas de bajada, 25 de subida, sin nada más configurado. */
const PLAN = { bajada_kbps: 50000, subida_kbps: 25000 }

test('un plan sin más configuración manda todo en neutro', () => {
  // No se omiten los campos: `set` deja lo que había, así que omitirlos dejaría
  // a un abonado con la ráfaga de un plan viejo para siempre. Sincronizar tiene
  // que dejar la cola IGUAL al plan.
  const { campos, avisos } = camposDeCola(PLAN)
  assert.deepEqual(campos, {
    'max-limit': '25000k/50000k',
    'limit-at': '0/0',
    'burst-limit': '0/0',
    'burst-threshold': '0/0',
    'burst-time': '0s/0s',
    priority: '8/8',
  })
  assert.deepEqual(avisos, [])
})

test('quitarle la ráfaga a un plan la borra del router', () => {
  // El caso que motivó mandar el juego completo: un plan que tenía ráfaga y se
  // la sacan. Si el campo no viajara, el abonado seguiría con la vieja.
  const { campos } = camposDeCola(PLAN)
  assert.equal(campos['burst-limit'], '0/0')
  assert.equal(campos['burst-time'], '0s/0s')
})

test('RouterOS escribe la subida primero', () => {
  // Al revés, un plan de 50 de bajada le daría 50 de SUBIDA al abonado y 25 de
  // bajada. Anda, se ve rápido en un test de velocidad de subida, y el cliente
  // llama igual porque no le carga nada.
  assert.equal(camposDeCola(PLAN).campos['max-limit'], '25000k/50000k')
})

test('la ráfaga completa se aplica con sus tres pares', () => {
  const { campos, avisos } = camposDeCola({
    ...PLAN,
    burst_bajada_kbps: 60000,
    burst_subida_kbps: 30000,
    umbral_bajada_kbps: 40000,
    umbral_subida_kbps: 20000,
    burst_segundos_bajada: 8,
    burst_segundos_subida: 8,
  })

  assert.equal(campos['burst-limit'], '30000k/60000k')
  assert.equal(campos['burst-threshold'], '20000k/40000k')
  assert.equal(campos['burst-time'], '8s/8s')
  assert.deepEqual(avisos, [])
})

test('una ráfaga a medio configurar se omite entera', () => {
  // Es el error que apareció contra el equipo real: mandar burst-limit sin
  // burst-time hace que RouterOS rechace la COLA ENTERA con "no
  // download-burst-time". El abonado se quedaba sin siquiera su velocidad.
  const { campos, avisos } = camposDeCola({
    ...PLAN,
    burst_bajada_kbps: 60000,
    burst_subida_kbps: 30000,
  })

  assert.equal(campos['burst-limit'], '0/0', 'la ráfaga viaja en neutro, no se omite')
  assert.equal(campos['max-limit'], '25000k/50000k', 'la velocidad se aplica igual')
  assert.match(avisos[0], /medio configurar/)
})

test('una ráfaga menor que el plan se descarta con el motivo', () => {
  // Pasa al subir un plan de 50 a 300 megas sin tocarle la ráfaga.
  const { campos, avisos } = camposDeCola({
    bajada_kbps: 300000,
    subida_kbps: 300000,
    burst_bajada_kbps: 60000,
    burst_subida_kbps: 30000,
    umbral_bajada_kbps: 40000,
    umbral_subida_kbps: 20000,
    burst_segundos_bajada: 8,
    burst_segundos_subida: 8,
  })

  assert.equal(campos['burst-limit'], '0/0', 'la ráfaga viaja en neutro, no se omite')
  assert.equal(campos['max-limit'], '300000k/300000k')
  assert.match(avisos[0], /menor que la velocidad/)
})

test('un umbral por encima del plan también se descarta', () => {
  // Con el umbral más alto que el máximo, la ráfaga estaría siempre activa: el
  // plan dejaría de existir en la práctica.
  const { campos, avisos } = camposDeCola({
    ...PLAN,
    burst_bajada_kbps: 60000,
    burst_subida_kbps: 30000,
    umbral_bajada_kbps: 90000,
    umbral_subida_kbps: 80000,
    burst_segundos_bajada: 8,
    burst_segundos_subida: 8,
  })

  assert.equal(campos['burst-threshold'], '0/0')
  assert.match(avisos[0], /siempre/)
})

test('el caudal garantizado se aplica dado vuelta', () => {
  const { campos } = camposDeCola({
    ...PLAN,
    garantizado_bajada_kbps: 10000,
    garantizado_subida_kbps: 5000,
  })
  assert.equal(campos['limit-at'], '5000k/10000k')
})

test('un garantizado mayor que el plan se descarta', () => {
  // RouterOS lo rechazaría con "limit-at larger than max-limit" y el abonado
  // quedaría sin cola.
  const { campos, avisos } = camposDeCola({
    ...PLAN,
    garantizado_bajada_kbps: 90000,
    garantizado_subida_kbps: 5000,
  })
  assert.equal(campos['limit-at'], '0/0')
  assert.match(avisos[0], /mayor que la velocidad/)
})

test('el garantizado necesita los dos sentidos', () => {
  const { campos, avisos } = camposDeCola({ ...PLAN, garantizado_bajada_kbps: 10000 })
  assert.equal(campos['limit-at'], '0/0')
  assert.match(avisos[0], /los dos valores/)
})

test('la prioridad se aplica en los dos sentidos', () => {
  assert.equal(camposDeCola({ ...PLAN, prioridad: 1 }).campos.priority, '1/1')
})

test('sin prioridad no se manda el campo', () => {
  assert.equal(camposDeCola(PLAN).campos.priority, '8/8', 'el 8 es el neutro de RouterOS')
})

test('una mala configuración nunca impide aplicar la velocidad', () => {
  // La regla que gobierna todo este módulo: lo que está mal se omite, pero el
  // abonado tiene que quedar con lo que está pagando.
  const { campos, avisos } = camposDeCola({
    ...PLAN,
    burst_bajada_kbps: 10,
    garantizado_bajada_kbps: 999999,
    prioridad: 3,
  })

  assert.equal(campos['max-limit'], '25000k/50000k')
  assert.equal(campos.priority, '3/3')
  assert.equal(avisos.length, 2)
})

// --- Quién controla el caudal de los abonados PPPoE --------------------------

/** El caso normal en fibra: limita la OLT. */
const POR_OLT = {
  nombre: 'PLAN_100M',
  perfil_ppp: 'PLAN HOME 150Mbps',
  bajada_kbps: 102400,
  subida_kbps: 10240,
  control_pppoe: 'olt',
}

/** El mismo plan, en un sector donde limita el router. */
const POR_ROUTER = { ...POR_OLT, control_pppoe: 'mikrotik' }

test('con la OLT al mando, el perfil se crea SIN rate-limit', () => {
  // Es lo contraintuitivo de la arquitectura: un límite en el perfil sería un
  // segundo tope compitiendo con la traffic table, y el abonado se queda con el
  // menor de los dos sin que ese número aparezca en ninguna pantalla.
  const p = perfilDePlan(POR_OLT)
  assert.equal(p.rateLimit, '')
  assert.equal(p.nombre, 'PLAN HOME 150Mbps')
})

test('sin la columna cargada se asume la OLT', () => {
  // Es el comportamiento que había antes de que el control fuera configurable:
  // ningún plan existente cambia de conducta al correr la migración.
  assert.equal(perfilDePlan({ nombre: 'X', bajada_kbps: 1000, subida_kbps: 1000 }).rateLimit, '')
})

test('con el router al mando, el perfil lleva la velocidad del plan', () => {
  // Subida primero, como todo lo de RouterOS.
  assert.match(perfilDePlan(POR_ROUTER).rateLimit, /^10240k\/102400k /)
})

test('el rate-limit usa la forma que devuelven los propios equipos', () => {
  // "150M/150M 0/0 0/0 10/10 8/8 0/0" — seis grupos. El formato es posicional:
  // no se pueden saltear los huecos, van en 0/0.
  const { valor } = rateLimitDePlan(POR_ROUTER)
  assert.equal(valor.split(' ').length, 6, valor)
  assert.equal(valor, '10240k/102400k 0/0 0/0 0/0 8/8 0/0')
})

test('la ráfaga completa entra en el rate-limit', () => {
  const { valor, avisos } = rateLimitDePlan({
    ...POR_ROUTER,
    burst_bajada_kbps: 120000,
    burst_subida_kbps: 20000,
    umbral_bajada_kbps: 80000,
    umbral_subida_kbps: 8000,
    burst_segundos_bajada: 8,
    burst_segundos_subida: 6,
    prioridad: 3,
    garantizado_bajada_kbps: 50000,
    garantizado_subida_kbps: 5000,
  })

  assert.equal(valor, '10240k/102400k 20000k/120000k 8000k/80000k 6/8 3/3 5000k/50000k')
  assert.deepEqual(avisos, [])
})

test('una ráfaga a medias no rompe el perfil: se omite con su motivo', () => {
  // Un rate-limit malformado hace que RouterOS rechace el perfil ENTERO, y ahí
  // el abonado se queda sin nada.
  const { valor, avisos } = rateLimitDePlan({ ...POR_ROUTER, burst_bajada_kbps: 120000 })

  assert.equal(valor, '10240k/102400k 0/0 0/0 0/0 8/8 0/0', 'la velocidad se aplica igual')
  assert.match(avisos[0], /medio configurar/)
})

test('un garantizado imposible se omite y se avisa', () => {
  const { valor, avisos } = rateLimitDePlan({
    ...POR_ROUTER,
    garantizado_bajada_kbps: 999000,
    garantizado_subida_kbps: 5000,
  })
  assert.ok(valor.endsWith('0/0'), valor)
  assert.match(avisos[0], /mayor que la velocidad/)
})

test('sin perfil_ppp cargado se usa el nombre del plan', () => {
  assert.equal(perfilDePlan({ nombre: 'PLAN_50M' }).nombre, 'PLAN_50M')
})

test('un plan sin nombre ni perfil no se puede aprovisionar', () => {
  assert.throws(() => perfilDePlan({}), /perfil PPP/)
})

// --- Revisión del perfil que hay en el equipo --------------------------------

test('con la OLT al mando, un perfil sin límite está bien', () => {
  assert.deepEqual(revisarPerfilDePlan({ 'rate-limit': '' }, POR_OLT), { ok: true })
  assert.deepEqual(revisarPerfilDePlan({}, POR_OLT), { ok: true })
})

test('con la OLT al mando, un perfil CON límite es un desvío', () => {
  // Quien lo cargó probablemente creyó que estaba asegurando la velocidad. Está
  // creando un segundo límite que pelea con la OLT.
  const r = revisarPerfilDePlan({ 'rate-limit': '10M/100M 0/0 0/0 10/10 8/8' }, POR_OLT)
  assert.equal(r.ok, false)
  assert.equal(r.motivo, 'no_deberia_limitar')
  assert.equal(r.aplica.bajada_kbps, 100000)
})

test('con el router al mando, un perfil SIN límite es el problema', () => {
  // Es el caso inverso y hay que distinguirlo: acá el abonado navega sin tope.
  const r = revisarPerfilDePlan({ 'rate-limit': '' }, POR_ROUTER)
  assert.equal(r.ok, false)
  assert.equal(r.motivo, 'sin_limite')
})

test('con el router al mando, el límite tiene que coincidir con el plan', () => {
  const igual = revisarPerfilDePlan({ 'rate-limit': '10M/100M' }, POR_ROUTER)
  assert.equal(igual.ok, true, 'los 1024 del plan y los 1000 del equipo son el mismo plan')

  const otro = revisarPerfilDePlan({ 'rate-limit': '10M/50M' }, POR_ROUTER)
  assert.equal(otro.ok, false)
  assert.equal(otro.motivo, 'difiere')
})

test('un perfil que no existe se reporta igual en los dos modos', () => {
  assert.deepEqual(revisarPerfilDePlan(null, POR_OLT), { ok: false, motivo: 'no_existe' })
  assert.deepEqual(revisarPerfilDePlan(null, POR_ROUTER), { ok: false, motivo: 'no_existe' })
})

// --- Encontrar la cola del abonado ------------------------------------------

const COLAS = [
  { '.id': '*1', name: 'Juan Pérez', target: '10.0.0.5/32', 'max-limit': '10M/50M' },
  { '.id': '*2', name: 'Ana Gómez', target: '10.0.0.9', 'max-limit': '10M/50M' },
  { '.id': '*3', name: 'Oficina', target: '10.0.0.20/32,10.0.0.21/32' },
  { '.id': '*4', name: 'Juan Perez (viejo)', target: '10.0.0.77/32' },
]

test('encuentra la cola por su objetivo, con o sin máscara', () => {
  assert.equal(buscarColaPorIp(COLAS, '10.0.0.5')[0]['.id'], '*1')
  assert.equal(buscarColaPorIp(COLAS, '10.0.0.9')[0]['.id'], '*2')
})

test('encuentra una cola con varios objetivos', () => {
  assert.equal(buscarColaPorIp(COLAS, '10.0.0.21')[0]['.id'], '*3')
})

test('se busca por IP y no por nombre', () => {
  // Dos colas con nombres casi iguales: buscar por nombre le cambiaría la
  // velocidad al abonado equivocado.
  const r = buscarColaPorIp(COLAS, '10.0.0.77')
  assert.equal(r.length, 1)
  assert.equal(r[0]['.id'], '*4')
})

test('una IP sin cola devuelve vacío: hay que crearla', () => {
  assert.deepEqual(buscarColaPorIp(COLAS, '10.0.0.200'), [])
})

test('no confunde 10.0.0.5 con 10.0.0.50', () => {
  // Con una comparación por "empieza con", el abonado .50 se llevaría la cola
  // del .5.
  assert.deepEqual(buscarColaPorIp([{ '.id': '*9', target: '10.0.0.50/32' }], '10.0.0.5'), [])
})

test('sin IP no devuelve cualquier cosa', () => {
  assert.deepEqual(buscarColaPorIp(COLAS, ''), [])
  assert.deepEqual(buscarColaPorIp(COLAS, null), [])
})

test('una respuesta que no es lista no rompe', () => {
  assert.deepEqual(buscarColaPorIp(null, '10.0.0.5'), [])
})
