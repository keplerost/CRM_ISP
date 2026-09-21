import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clientesConVencido,
  fechaLocal,
  filtrarAbonados,
} from '../../web/src/lib/abonados.js'

/**
 * La cartera vencida: el número del panel y la lista que abre.
 *
 * ── Qué se está protegiendo ──
 *
 * El panel de inicio muestra "$X vencidos · N cuentas" y esa tarjeta abre el
 * listado de abonados filtrado. Son dos pantallas distintas contestando la
 * misma pregunta, y lo único que las mantiene de acuerdo es que las dos llaman
 * a `clientesConVencido`.
 *
 * Si alguien mañana decide que "vencida" también incluye la que vence hoy, o
 * que las notas de crédito no cuentan, tiene que cambiarlo en un solo lugar.
 * El día que en vez de eso se escriba un criterio parecido en la pantalla que
 * toca, el número del panel va a dejar de coincidir con la lista que abre —y
 * eso no se nota mirando: se nota cuando alguien suma a mano y no le da.
 *
 * Por eso la prueba central de este archivo no verifica un cálculo sino un
 * ACUERDO: que la cuenta del panel y las filas del listado sean el mismo
 * conjunto de gente.
 *
 * ── Por qué se prueba desde acá ──
 *
 * Por lo mismo que `abonados.test.js`: `abonados.js` no importa nada —ni
 * Supabase, ni React— así que corre en este runner sin montar un navegador.
 * Lo que se verifica no es que la tabla se pinte, sino a quién hay que ir a
 * cobrarle.
 */

const HOY = '2026-09-21'

/* El padrón, tal como llega de `v_clientes_ficha`. El `saldo` de la ficha es
   el total por cobrar —todas las facturas con saldo, hayan vencido o no—, y
   por eso NO alcanza para saber quién está vencido: Dario debe y no venció. */
const CLIENTES = [
  { id: 1, nombre: 'Ana', estado: 'activo', saldo: 0 },
  { id: 2, nombre: 'Beto', estado: 'activo', saldo: 17.5 },
  { id: 3, nombre: 'Carla', estado: 'suspendido', saldo: 42 },
  { id: 4, nombre: 'Dario', estado: 'activo', saldo: 20 },
  { id: 5, nombre: 'Elsa', estado: 'activo', saldo: 9 },
  { id: 6, nombre: 'Fabio', estado: 'activo', saldo: 5 },
]

/* Las facturas impagas, tal como llegan de `v_facturas_por_cobrar`. */
const FACTURAS = [
  { client_id: 2, saldo: 17.5, fecha_vencimiento: '2026-08-15' },
  // Dos facturas del MISMO abonado: son una sola cuenta vencida, no dos.
  { client_id: 3, saldo: 20.0, fecha_vencimiento: '2026-07-01' },
  { client_id: 3, saldo: 22.0, fecha_vencimiento: '2026-08-01' },
  // Todavía no vence.
  { client_id: 4, saldo: 20.0, fecha_vencimiento: '2026-10-05' },
  // Vence HOY. Hoy todavía se puede pagar sin estar vencido.
  { client_id: 5, saldo: 9.0, fecha_vencimiento: HOY },
  // Venció hace rato, pero ya está pagada: no se le cobra a nadie.
  { client_id: 6, saldo: 0, fecha_vencimiento: '2026-06-01' },
]

test('vencida es tener saldo Y haber pasado la fecha', () => {
  const ids = clientesConVencido(FACTURAS, HOY)

  assert.deepEqual([...ids].sort(), [2, 3], 'solo Beto y Carla deben algo vencido')
})

test('dos facturas del mismo abonado son una sola cuenta', () => {
  // Carla tiene dos facturas vencidas. Si esto contara facturas en vez de
  // cuentas, el panel diría "3 cuentas" y el listado mostraría 2 filas.
  const soloCarla = FACTURAS.filter((f) => f.client_id === 3)

  assert.equal(clientesConVencido(soloCarla, HOY).size, 1)
})

test('la que vence hoy todavía no está vencida', () => {
  assert.equal(clientesConVencido(FACTURAS, HOY).has(5), false)

  // Y mañana sí. Es el borde que separa "avisale" de "cortale".
  assert.equal(clientesConVencido(FACTURAS, '2026-09-22').has(5), true)
})

test('una factura vencida pero ya pagada no cuenta', () => {
  assert.equal(clientesConVencido(FACTURAS, HOY).has(6), false)
})

test('una factura futura no cuenta, aunque el abonado deba', () => {
  const ids = clientesConVencido(FACTURAS, HOY)

  // Dario tiene saldo en la ficha, así que un filtro por "saldo > 0" lo
  // traería. Por eso el filtro no mira la ficha: mira las fechas.
  assert.equal(CLIENTES.find((c) => c.id === 4).saldo > 0, true)
  assert.equal(ids.has(4), false)
})

test('sin facturas no se rompe', () => {
  assert.equal(clientesConVencido([], HOY).size, 0)
  assert.equal(clientesConVencido(null, HOY).size, 0)
  assert.equal(clientesConVencido(undefined, HOY).size, 0)
})

/**
 * El acuerdo entre el panel y el listado.
 *
 * Esta es la prueba que importa. Las de arriba verifican el criterio; esta
 * verifica que las dos pantallas lo usen igual.
 */
test('el número del panel y las filas del listado son la misma gente', () => {
  // Lo que calcula el panel para la tarjeta de cartera.
  const idsVencidos = clientesConVencido(FACTURAS, HOY)
  const cuentasDelPanel = idsVencidos.size
  const montoDelPanel = FACTURAS.filter(
    (f) => Number(f.saldo) > 0 && idsVencidos.has(f.client_id),
  ).reduce((s, f) => s + f.saldo, 0)

  // Lo que muestra el listado al abrir `/clientes?deuda=vencida`.
  const filasDelListado = filtrarAbonados(CLIENTES, { vencidos: idsVencidos })

  assert.equal(cuentasDelPanel, 2)
  assert.equal(montoDelPanel, 59.5)
  assert.deepEqual(filasDelListado.map((c) => c.id), [2, 3])

  // El acuerdo, dicho explícitamente.
  assert.equal(
    filasDelListado.length,
    cuentasDelPanel,
    'la tarjeta dice un número y abre una lista: tienen que dar lo mismo',
  )
})

test('el filtro de vencidas se suma a los otros, no los reemplaza', () => {
  const vencidos = clientesConVencido(FACTURAS, HOY)

  // Vencidos Y activos: Carla está suspendida, así que queda afuera.
  assert.deepEqual(
    filtrarAbonados(CLIENTES, { vencidos, estado: 'activo' }).map((c) => c.id),
    [2],
  )

  // Vencidos Y buscando por nombre.
  assert.deepEqual(
    filtrarAbonados(CLIENTES, { vencidos, busqueda: 'car' }).map((c) => c.id),
    [3],
  )
})

test('sin conjunto no filtra, y con conjunto vacío no queda nadie', () => {
  // `null` es "el filtro está apagado".
  assert.equal(filtrarAbonados(CLIENTES, { vencidos: null }).length, CLIENTES.length)
  assert.equal(filtrarAbonados(CLIENTES, {}).length, CLIENTES.length)

  // Un Set vacío es "nadie debe nada vencido", que es distinto de apagado.
  assert.equal(filtrarAbonados(CLIENTES, { vencidos: new Set() }).length, 0)
})

/**
 * El día, en hora local.
 *
 * Vive junto al criterio de vencimiento y no en cada pantalla por una razón
 * concreta: `toISOString()` devuelve UTC, y en Ecuador (UTC-5) eso hace que a
 * partir de las 19:00 el sistema empiece a contar el día siguiente. El síntoma
 * es una cartera que a la tarde marca vencido lo que vence mañana.
 */
test('la fecha local no se corre de día a la tarde', () => {
  // 21 de septiembre, 23:30 hora local. En UTC ya es 22.
  assert.equal(fechaLocal(new Date(2026, 8, 21, 23, 30)), '2026-09-21')

  // Y a la mañana temprano, que es el borde del otro lado.
  assert.equal(fechaLocal(new Date(2026, 8, 21, 0, 15)), '2026-09-21')
})

test('la fecha local se compara como texto con las de la base', () => {
  // Las fechas llegan en ISO `AAAA-MM-DD`, donde el orden alfabético es el
  // cronológico. Por eso el criterio puede comparar con `<` sin convertir
  // nada, y por eso el mes y el día van con cero adelante.
  assert.equal(fechaLocal(new Date(2026, 0, 5)), '2026-01-05')
  assert.ok('2026-01-05' < '2026-01-06')
  assert.ok('2026-09-30' < '2026-10-01')
})
