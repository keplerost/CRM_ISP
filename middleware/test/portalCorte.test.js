import test from 'node:test'
import assert from 'node:assert/strict'

import { aplicar, destinoSugerido, leerTunel, planear, reglaDelCorte, resumir } from '../src/services/portalCorte.js'
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
