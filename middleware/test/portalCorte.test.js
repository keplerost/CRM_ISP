import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LISTA_AVISO_VISTO,
  aplicar,
  camposDe,
  destinoSugerido,
  leerTunel,
  planear,
  reglaDelCorte,
  resumir,
} from '../src/services/portalCorte.js'
import { comentario } from '../src/lib/marcaReglas.js'

/**
 * Lo que el router necesita para que el cortado vea su página.
 *
 * El caso que se protege es el del piloto: la redirección existía, apuntaba al
 * puerto 80 —donde nginx contesta otra cosa— y además el drop del corte se
 * comía el pedido. Desde el sistema todo se veía "configurado".
 */

const LISTA = 'CORTE_MOROSOS'
const DESTINO = '10.66.0.1'

const drop = { '.id': '*D', chain: 'forward', action: 'drop', 'src-address-list': LISTA, comment: comentario('corte') }
const masq = { '.id': '*M', chain: 'srcnat', action: 'masquerade', 'out-interface': 'ether1' }

const accion = (acciones, clave) => acciones.filter((a) => a.clave === clave)

test('router nuevo: crea las cuatro piezas, y los permisos delante del corte', () => {
  const acciones = planear({ filter: [drop], nat: [masq], destino: DESTINO, puerto: 8090, lista: LISTA })

  assert.deepEqual(
    acciones.map((a) => [a.clave, a.accion]),
    [
      ['redireccion', 'crear'],
      ['portalSinNat', 'crear'],
      ['portalPagina', 'crear'],
      ['portalDns', 'crear'],
    ],
  )
  assert.equal(accion(acciones, 'portalPagina')[0].antesDe, '*D')
  assert.equal(accion(acciones, 'portalDns')[0].antesDe, '*D')
  assert.equal(accion(acciones, 'portalSinNat')[0].antesDe, '*M', 'tiene que ganarle al masquerade')

  const red = accion(acciones, 'redireccion')[0].campos
  assert.equal(red['to-addresses'], DESTINO)
  assert.equal(red['to-ports'], '8090')
})

test('la redirección vieja al puerto 80 se corrige, no se duplica', () => {
  const vieja = {
    '.id': '*R',
    chain: 'dstnat',
    action: 'dst-nat',
    'src-address-list': LISTA,
    'to-addresses': DESTINO,
    'to-ports': '80',
    comment: comentario('redireccion'),
  }
  const [a] = accion(planear({ filter: [drop], nat: [vieja, masq], destino: DESTINO, puerto: 8090, lista: LISTA }), 'redireccion')

  assert.equal(a.accion, 'corregir')
  assert.equal(a.id, '*R')
  assert.deepEqual(a.campos, { 'to-ports': '8090' })
})

test('un permiso que quedó detrás del drop se mueve: ahí no sirve de nada', () => {
  const pagina = {
    '.id': '*P',
    chain: 'forward',
    action: 'accept',
    protocol: 'tcp',
    'src-address-list': LISTA,
    'dst-address': DESTINO,
    'dst-port': '8090',
    comment: comentario('portalPagina'),
  }
  const [a] = accion(planear({ filter: [drop, pagina], nat: [], destino: DESTINO, puerto: 8090, lista: LISTA }), 'portalPagina')

  assert.equal(a.accion, 'mover')
  assert.equal(a.antesDe, '*D')
})

test('con todo en su lugar no hay nada que hacer', () => {
  const v = { destino: DESTINO, puerto: 8090, lista: LISTA }
  const primero = planear({ filter: [drop], nat: [masq], ...v })

  // Se arma el router como quedaría después de aplicar el plan.
  const conId = (a, id) => ({ '.id': id, ...a.campos })
  const nat = [conId(primero[0], '*R'), conId(primero[1], '*S'), masq]
  const filter = [conId(primero[2], '*P'), conId(primero[3], '*Q'), drop]

  const segundo = planear({ filter, nat, ...v })
  assert.ok(segundo.every((a) => a.accion === 'ok'), JSON.stringify(segundo))
  assert.equal(resumir(segundo), null)
})

test('el corte de otro sistema también cuenta como ancla', () => {
  // Un router adoptado de MikroWisp corta con su propia regla: los permisos
  // tienen que ir delante de esa, que es la que de verdad descarta.
  const ajeno = { '.id': '*W', chain: 'forward', action: 'drop', 'src-address-list': 'moroso', comment: 'MikroWisp' }
  assert.equal(reglaDelCorte([ajeno], 'Moroso'), ajeno)
})

test('una regla de corte apagada no es el ancla', () => {
  assert.equal(reglaDelCorte([{ ...drop, disabled: 'true' }], LISTA), null)
})

test('sin archivo del túnel, el destino se deduce solo en 10.66, y lo configurado gana', () => {
  assert.equal(destinoSugerido({ ip_host: '10.66.0.11' }, null, null), '10.66.0.1')
  assert.equal(destinoSugerido({ ip_host: '10.66.3.20' }, null, null), '10.66.3.1')
  // El .1 es el propio servidor: un router ahí no tiene a quién apuntar.
  assert.equal(destinoSugerido({ ip_host: '10.66.0.1' }, null, null), null)
  // Fuera del túnel, adivinar sería peor que preguntar.
  assert.equal(destinoSugerido({ ip_host: '192.168.88.5' }, null, null), null)
  assert.equal(destinoSugerido({ ip_host: '181.119.227.177' }, null, null), null)
  assert.equal(destinoSugerido({ ip_host: '10.66.0.11' }, '67.205.175.106', null), '67.205.175.106')
})

test('con el archivo del túnel, el destino sigue a la red real aunque se haya cambiado', () => {
  // Lo que deja `cambiar-red-vpn.sh` después de mover el túnel a 10.67.
  const tunel = leerTunel('PUBLICO=1.2.3.4\nPUERTO=1194\nRED_VPN=10.67.0.0\nPREFIJO=24\nIP_VPS=10.67.0.1\n')
  assert.equal(destinoSugerido({ ip_host: '10.67.0.11' }, null, tunel), '10.67.0.1')
  // Un router que todavía figura con la IP vieja no está en el túnel nuevo.
  assert.equal(destinoSugerido({ ip_host: '10.66.0.11' }, null, tunel), '10.66.0.1')
  assert.equal(destinoSugerido({ ip_host: '192.168.1.5' }, null, tunel), null)

  // Instalaciones viejas, sin PREFIJO ni IP_VPS en el archivo.
  const viejo = leerTunel('RED_VPN=10.8.0.0\n')
  assert.equal(destinoSugerido({ ip_host: '10.8.0.12' }, null, viejo), '10.8.0.1')
})

test('la IP del propio router como destino se rechaza antes de tocar el equipo', async () => {
  // El error del piloto: en "IP del servidor" se puso la del MikroTik. El router
  // se redirigía a sí mismo y la página no cargaba, sin error en ningún lado.
  await assert.rejects(
    aplicar({ ip_host: '10.66.0.11' }, { destino: '10.66.0.11', lista: LISTA }),
    (err) => /propio router/.test(err.message) && /10\.66\.0\.1/.test(err.hint ?? ''),
  )
})

// ── El aviso previo ─────────────────────────────────────────────────────────

/**
 * Un router de mentira: aplica las acciones de `planear` de a una, como hace
 * `aplicar`, y devuelve cómo quedó. Es lo que prueba que el orden converge
 * aunque una pieza se ancle en otra que todavía no existe.
 */
function simular({ filter, nat, ...v }) {
  let n = 0
  const tabla = { filter: [...filter], nat: [...nat] }
  for (let vuelta = 0; vuelta < 20; vuelta++) {
    const a = planear({ filter: tabla.filter, nat: tabla.nat, ...v }).find((x) => x.accion !== 'ok')
    if (!a) return tabla
    const reglas = tabla[a.tipo]
    if (a.accion === 'crear') {
      const nueva = { '.id': `*N${++n}`, ...a.campos }
      const i = a.antesDe ? reglas.findIndex((r) => r['.id'] === a.antesDe) : reglas.length
      reglas.splice(i, 0, nueva)
    } else if (a.accion === 'corregir') {
      Object.assign(reglas.find((r) => r['.id'] === a.id), a.campos)
    } else if (a.accion === 'mover') {
      const [r] = reglas.splice(reglas.findIndex((x) => x['.id'] === a.id), 1)
      reglas.splice(reglas.findIndex((x) => x['.id'] === a.antesDe), 0, r)
    }
  }
  throw new Error('no convergió')
}

const posicion = (reglas, clave) => reglas.findIndex((r) => r.comment === comentario(clave))

test('sin lista de aviso no se escribe nada del aviso', () => {
  const acciones = planear({ filter: [drop], nat: [masq], destino: DESTINO, puerto: 8090, lista: LISTA })
  assert.ok(!acciones.some((a) => a.clave.startsWith('aviso')))
})

test('con lista de aviso: corte, "ya lo vio" y aviso, en ese orden, y las excepciones antes del masquerade', () => {
  const { nat } = simular({ filter: [drop], nat: [masq], destino: DESTINO, puerto: 8090, lista: LISTA, listaAviso: 'AVISO_PAGO' })

  const corte = posicion(nat, 'redireccion')
  const visto = posicion(nat, 'avisoVisto')
  const aviso = posicion(nat, 'avisoRedireccion')
  assert.ok(corte < visto && visto < aviso, nat.map((r) => r.comment).join(' | '))

  const masquerade = nat.indexOf(masq)
  assert.ok(posicion(nat, 'portalSinNat') < masquerade)
  assert.ok(posicion(nat, 'avisoSinNat') < masquerade)

  assert.equal(nat[visto]['src-address-list'], LISTA_AVISO_VISTO)
  assert.equal(nat[visto]['dst-port'], '80', 'un accept más amplio saltearía otras reglas de dstnat')
  assert.equal(nat[aviso]['src-address-list'], 'AVISO_PAGO')
  assert.equal(nat[aviso]['to-ports'], '8090')
})

test('router de WispHub: nuestro aviso va delante del de ellos, y la redirección del corte delante del "ya lo vio"', () => {
  // Lo que se vio en el router: las reglas de WispHub arriba y la nuestra del corte al final.
  const wh = (id, extra) => ({ '.id': id, chain: 'dstnat', ...extra })
  const nat = [
    wh('*W0', { action: 'accept', 'src-address-list': 'Moroso', 'dst-address-list': 'servers', comment: 'WispHub - Permitir pagina web morosos' }),
    masq,
    wh('*W4', { action: 'redirect', protocol: 'tcp', 'src-address-list': 'Moroso', 'dst-port': '!8291', comment: 'WispHub - Suspension de clientes(TCP)' }),
    wh('*W6', { action: 'redirect', protocol: 'tcp', 'src-address-list': 'Aviso', 'dst-port': '80', comment: 'WispHub - Aviso de Pago en Pantalla de clientes(TCP)' }),
    { '.id': '*R', ...camposDe('redireccion', { destino: DESTINO, puerto: 8090, lista: LISTA }) },
  ]
  const final = simular({ filter: [drop], nat, destino: DESTINO, puerto: 8090, lista: LISTA, listaAviso: 'Aviso' }).nat

  const ids = final.map((r) => r['.id'])
  assert.ok(posicion(final, 'avisoRedireccion') < ids.indexOf('*W6'), 'detrás de la de WispHub no se ve')
  assert.ok(posicion(final, 'redireccion') < posicion(final, 'avisoVisto'))
  assert.ok(posicion(final, 'avisoVisto') < posicion(final, 'avisoRedireccion'))
})

test('las dos excepciones al masquerade no se disputan el primer lugar', () => {
  // Si cada una se anclara en la otra, se moverían alternadamente sin fin.
  assert.doesNotThrow(() =>
    simular({ filter: [drop], nat: [masq], destino: DESTINO, puerto: 8090, lista: LISTA, listaAviso: 'AVISO_PAGO' }),
  )
})

test('la lista del aviso: sin decidir toma la de fábrica, apagada se respeta', async () => {
  const { listaAvisoDe, LISTA_AVISO } = await import('../src/services/portalCorte.js')
  assert.equal(listaAvisoDe({ lista_aviso: null }), LISTA_AVISO)
  assert.equal(listaAvisoDe({}), LISTA_AVISO)
  assert.equal(listaAvisoDe({ lista_aviso: '' }), null, 'la apagaron: no se vuelve a encender sola')
  assert.equal(listaAvisoDe({ lista_aviso: ' Aviso ' }), 'Aviso')
  assert.notEqual(LISTA_AVISO, 'Aviso', 'no la de WispHub: se pisarían')
})
