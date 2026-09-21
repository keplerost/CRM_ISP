import test from 'node:test'
import assert from 'node:assert/strict'

import {
  conciliar, indexarRouter, listasQueCortan, pareceElMismo,
} from '../src/services/conciliacionIps.js'

/**
 * Comparar lo que el sistema cree con lo que el router sabe.
 *
 * Los casos de acá son los que aparecen al migrar un padrón de verdad, y cada
 * uno tiene una consecuencia distinta para el abonado.
 */

const ESCANEO = {
  pppSecrets: [{ name: 'jose.ona', 'remote-address': '10.20.1.15' }],
  pppActive: [],
  simpleQueues: [
    { name: 'gonzalez', target: '10.20.1.16/32' },
    // La cola dinámica que RouterOS crea sola para un PPPoE: apunta a la
    // interfaz y su dueño está en el nombre.
    { name: '<pppoe-luis.masapanta>', target: 'pppoe-luis' },
  ],
  dhcpLeases: [{ address: '10.20.1.30', comment: 'CAMARA NODO' }],
  addressList: [
    { address: '10.20.1.17', list: 'CORTE_MOROSOS', comment: 'cortado 2024' },
    { address: '10.20.1.99', list: 'CORTE_MOROSOS' },
  ],
}

/**
 * Las reglas del router de La Maná, tal como están.
 *
 * Vino de WispHub: corta mandando a los morosos a una página de pago con un
 * `redirect`, no con un `drop`. Un detector que solo busque `drop` no ve nada.
 */
const NAT_REAL = [
  { action: 'accept', chain: 'dstnat', 'src-address-list': 'Moroso', 'dst-address-list': 'servers_wisphub', comment: 'Permitir pagina web morosos' },
  { action: 'redirect', chain: 'dstnat', 'src-address-list': 'Moroso', disabled: 'false', comment: 'Suspension de clientes(TCP)' },
  { action: 'redirect', chain: 'dstnat', 'src-address-list': 'Moroso', disabled: 'false', comment: 'Suspension de clientes(UDP)' },
  { action: 'redirect', chain: 'dstnat', 'src-address-list': 'Aviso', disabled: 'false', comment: 'Aviso de Pago' },
  { action: 'src-nat', chain: 'srcnat', 'src-address-list': 'Facturador', disabled: 'false' },
  { action: 'dst-nat', chain: 'dstnat', 'dst-address-list': 'Ips-Bloqueo_Arcotel', disabled: 'false' },
  { action: 'masquerade', chain: 'srcnat', 'src-address-list': 'VPN-WireGuard', disabled: 'false' },
]

const FILTER_REAL = [
  { action: 'drop', chain: 'input', 'src-address-list': 'Black_List', disabled: 'false' },
  { action: 'accept', chain: 'input', 'src-address-list': 'IpsPermitidas', disabled: 'false' },
]

// --- Qué lista corta de verdad ----------------------------------------------

test('reconoce la lista que corta aunque no se llame como el sistema cree', () => {
  /**
   * Es el hallazgo que motivó esta función. El sistema tenía configurada
   * `CORTE_MOROSOS` y el router corta con `Moroso`, con 239 direcciones adentro.
   * Con el nombre equivocado no se detecta un solo abonado cortado y el informe
   * sale impecable — que es mentir en la única dirección que hace daño.
   */
  const listas = listasQueCortan(FILTER_REAL, NAT_REAL).map((l) => l.lista)
  assert.ok(listas.includes('Moroso'), 'el redirect a la página de pago ES un corte')
  assert.ok(listas.includes('Aviso'))
})

test('no confunde con un corte lo que no lo es', () => {
  const listas = listasQueCortan(FILTER_REAL, NAT_REAL).map((l) => l.lista)

  assert.ok(!listas.includes('Facturador'), 'un src-nat es salida a internet, no un corte')
  assert.ok(!listas.includes('VPN-WireGuard'), 'un masquerade tampoco')
  assert.ok(
    !listas.includes('Ips-Bloqueo_Arcotel'),
    'una lista de DESTINOS bloqueados no le corta el servicio a ningún abonado',
  )
  assert.ok(
    !listas.includes('Black_List'),
    'un drop en la cadena input protege al router de un ataque; no corta a un abonado',
  )
})

test('una regla deshabilitada no corta', () => {
  const listas = listasQueCortan(
    [],
    [{ action: 'redirect', chain: 'dstnat', 'src-address-list': 'Vieja', disabled: 'true' }],
  )
  assert.equal(listas.length, 0)
})

test('el corte seco con drop en forward también se reconoce', () => {
  // El otro estilo: en vez de mandar a una página de pago, se tira el tráfico.
  const listas = listasQueCortan(
    [{ action: 'drop', chain: 'forward', 'src-address-list': 'CORTE_MOROSOS', disabled: 'false' }],
    [],
  ).map((l) => l.lista)
  assert.deepEqual(listas, ['CORTE_MOROSOS'])
})

test('avisa cuando la lista configurada no es la que corta', () => {
  const r = conciliar([], ESCANEO, {
    listaMorosos: 'CORTE_MOROSOS',
    reglasFilter: FILTER_REAL,
    reglasNat: NAT_REAL,
  })

  assert.equal(r.corte.revisado, true)
  assert.equal(r.corte.coincide, false)
  assert.match(r.corte.problema, /no van a cortar a nadie/)
  assert.ok(r.corte.detectadas.includes('Moroso'))
})

test('cuando coincide, no hay nada que avisar', () => {
  const r = conciliar([], ESCANEO, {
    listaMorosos: 'Moroso',
    reglasFilter: FILTER_REAL,
    reglasNat: NAT_REAL,
  })
  assert.equal(r.corte.coincide, true)
  assert.equal(r.corte.problema, null)
})

test('un router sin ninguna regla de corte se dice, no se calla', () => {
  const r = conciliar([], ESCANEO, { listaMorosos: 'CORTE_MOROSOS', reglasFilter: [], reglasNat: [] })
  assert.match(r.corte.problema, /no va a tener efecto/)
})

test('si no se pudieron leer las reglas, no se afirma nada', () => {
  // Callarse es correcto; decir "coincide" sin haber mirado, no.
  const r = conciliar([], ESCANEO, { listaMorosos: 'CORTE_MOROSOS' })
  assert.equal(r.corte.revisado, false)
})

test('los cortados se detectan por la lista real, no por la configurada', () => {
  /**
   * La consecuencia práctica de todo lo anterior: con el nombre mal, este
   * abonado —que paga, figura activo y no tiene internet— no aparecía.
   */
  const escaneo = {
    ...ESCANEO,
    addressList: [{ address: '10.20.1.50', list: 'Moroso', comment: 'cortado por WispHub' }],
  }

  const conReglas = conciliar(
    [{ id: 'x', nombre: 'PAGA Y NO TIENE', ip: '10.20.1.50', estado: 'activo' }],
    escaneo,
    { listaMorosos: 'CORTE_MOROSOS', reglasFilter: FILTER_REAL, reglasNat: NAT_REAL },
  )
  assert.equal(conReglas.resumen.en_morosos, 1, 'con las reglas leídas, aparece')

  const sinReglas = conciliar(
    [{ id: 'x', nombre: 'PAGA Y NO TIENE', ip: '10.20.1.50', estado: 'activo' }],
    escaneo,
    { listaMorosos: 'CORTE_MOROSOS' },
  )
  assert.equal(sinReglas.resumen.en_morosos, 0, 'sin ellas, se lo pierde: por eso se leen')
})

// --- Reconocer a la misma persona -------------------------------------------

test('el mismo abonado escrito distinto se reconoce', () => {
  // Nunca coinciden carácter por carácter entre dos sistemas. Comparar exacto
  // marcaría toda la base como conflicto y el informe no serviría para nada.
  assert.equal(pareceElMismo('OÑA RIERA JOSÉ', 'jose.ona'), true)
  assert.equal(pareceElMismo('MASAPANTA LUIS', 'luis.masapanta'), true)
  assert.equal(pareceElMismo('OÑA RIERA JOSÉ', 'ONA RIERA J'), true, 'los acentos no pueden separar')
})

test('dos personas distintas no se confunden', () => {
  assert.equal(pareceElMismo('OÑA RIERA JOSÉ', 'GONZÁLEZ PEDRO'), false)
  assert.equal(pareceElMismo('', 'algo'), false)
  assert.equal(pareceElMismo(null, null), false)
})

test('las palabras cortas no alcanzan para dar por iguales a dos', () => {
  // "de", "la", "y" están en medio padrón. Si contaran, todos serían el mismo.
  assert.equal(pareceElMismo('DE LA CRUZ ANA', 'DE LA TORRE BETO'), false)
})

// --- Leer el router ---------------------------------------------------------

test('las cuatro fuentes del router se juntan por IP', () => {
  /**
   * Cada fuente miente por separado: un PPPoE no tiene lease, uno de IP fija no
   * tiene secret, y un cortado puede estar solo en el address-list. Preguntarle
   * a una sola da una foto incompleta y hace parecer que faltan abonados que
   * están perfectamente configurados.
   */
  const mapa = indexarRouter(ESCANEO)

  assert.deepEqual(mapa.get('10.20.1.15').nombres, ['jose.ona'])
  assert.deepEqual(mapa.get('10.20.1.16').nombres, ['gonzalez'])
  assert.equal(mapa.get('10.20.1.30').nombres[0], 'CAMARA NODO')
  assert.equal(mapa.get('10.20.1.17').morosa, true)
})

test('la cola dinámica de PPPoE dice a quién pertenece', () => {
  // Su target es la interfaz, no una IP. Sin sacar el usuario del nombre, ese
  // abonado parecería no tener cola en el router.
  const mapa = indexarRouter(ESCANEO)
  const conNombre = [...mapa.values()].flatMap((e) => e.nombres)
  assert.ok(!conNombre.includes('<pppoe-luis.masapanta>'), 'no puede quedar el nombre crudo')
})

// --- El informe -------------------------------------------------------------

test('un abonado bien configurado no aparece en ningún hallazgo', () => {
  const r = conciliar(
    [{ id: '1', nombre: 'OÑA RIERA JOSÉ', ip: '10.20.1.15', estado: 'activo' }],
    ESCANEO,
  )
  assert.equal(r.resumen.conformes, 1)
  assert.equal(r.resumen.ocupadas_por_otro, 0)
  assert.equal(r.resumen.sin_configurar, 0)
})

test('la IP que en el router es de otro se marca', () => {
  // Uno de los dos va a quedar sin servicio, y el que reclame no va a ser el
  // que esté mal cargado.
  const r = conciliar(
    [{ id: '2', codigo: 5, nombre: 'PÉREZ MARÍA', ip: '10.20.1.16', estado: 'activo' }],
    ESCANEO,
  )
  assert.equal(r.resumen.ocupadas_por_otro, 1)
  assert.deepEqual(r.ocupadas_por_otro[0].en_el_router, ['gonzalez'])
})

test('el abonado activo cuya IP quedó en la lista de cortes', () => {
  /**
   * Es la peor de todas y la razón de ser de esta comparación: el abonado paga,
   * en el sistema figura activo, y no tiene internet. No hay ninguna señal
   * salvo su llamada — y al que atiende el teléfono el sistema le va a decir
   * que está todo bien.
   */
  const r = conciliar(
    [{ id: '3', nombre: 'CHICAIZA ANA', ip: '10.20.1.17', estado: 'activo' }],
    ESCANEO,
  )
  assert.equal(r.resumen.en_morosos, 1)
  assert.equal(r.en_morosos[0].lista, 'CORTE_MOROSOS')
})

test('un cortado en la lista de cortes es lo esperable, no un hallazgo', () => {
  const r = conciliar(
    [{ id: '4', nombre: 'CHICAIZA ANA', ip: '10.20.1.17', estado: 'cortado' }],
    ESCANEO,
  )
  assert.equal(r.resumen.en_morosos, 0)
})

test('una IP que el router no conoce se informa', () => {
  const r = conciliar(
    [{ id: '5', nombre: 'NUEVO ABONADO', ip: '10.20.1.77', estado: 'activo' }],
    ESCANEO,
  )
  assert.equal(r.resumen.sin_configurar, 1)
})

test('el abonado de baja sin configuración no es un hallazgo', () => {
  // Se la sacaron cuando se fue: es exactamente lo que tenía que pasar.
  const r = conciliar(
    [{ id: '6', nombre: 'SE FUE', ip: '10.20.1.77', estado: 'baja' }],
    ESCANEO,
  )
  assert.equal(r.resumen.sin_configurar, 0)
})

test('dos abonados del sistema con la misma IP', () => {
  const r = conciliar(
    [
      { id: '7', nombre: 'UNO', ip: '10.20.1.15', estado: 'activo' },
      { id: '8', nombre: 'OTRO', ip: '10.20.1.15', estado: 'activo' },
    ],
    ESCANEO,
  )
  assert.equal(r.resumen.duplicadas, 1)
  assert.equal(r.duplicadas[0].abonados.length, 2)
})

test('lo que está en el router y no en el sistema', () => {
  const r = conciliar([], ESCANEO)

  const ips = r.sobran_en_el_router.map((x) => x.ip)
  assert.ok(ips.includes('10.20.1.30'), 'la cámara del nodo que nadie registró')
  assert.ok(
    !ips.includes('10.20.1.99'),
    'una IP que solo está en la lista de cortes no es un abonado que falte importar',
  )
})

test('un abonado sin IP no se compara con nada', () => {
  const r = conciliar([{ id: '9', nombre: 'SIN IP', ip: null, estado: 'activo' }], ESCANEO)
  assert.equal(r.resumen.abonados_con_ip, 0)
  assert.equal(r.resumen.sin_configurar, 0)
})

test('el usuario PPPoE también sirve para reconocer al abonado', () => {
  // En el router el dueño de la cola es el usuario, no el nombre de la persona.
  const r = conciliar(
    [{ id: '10', nombre: 'MASAPANTA LUIS', usuario_ppp: 'gonzalez', ip: '10.20.1.16', estado: 'activo' }],
    ESCANEO,
  )
  assert.equal(r.resumen.ocupadas_por_otro, 0, 'si el usuario coincide, no hay conflicto')
})
