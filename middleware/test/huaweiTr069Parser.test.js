import test from 'node:test'
import assert from 'node:assert/strict'

import {
  contarAsignacionesTr069,
  contarIpsDeGestion,
  diagnosticoTr069,
  parseMacsDeOnt,
  parsePerfilesTr069,
  parseTr069DeOnt,
} from '../src/parsers/huaweiTr069Parser.js'

/**
 * Todas las salidas de este archivo son las de verdad, copiadas de la MA5800-X7
 * de La Maná. Inventarlas sería probar el parser contra mi idea del equipo en
 * vez de contra el equipo.
 */

const CONFIG = `
  Command:
          display current-configuration | include tr069
 ont tr069-server-profile add profile-id 1 profile-name "SmartOLT" url "http://10.69.69.1:14501" user "soltcpe" "%$%#LY(!!!!!!!!!!!!{jy{*}6z)+#\\h0Y8,\\D-so<58Tc9p<KR$6~_o{SQ./T8SZwjRKeaB9)c4\\8*&4uG0U+)L>%$%#"
 ont tr069-server-profile add profile-id 2 profile-name "GenieACS" url "http://192.168.55.254:7547"
  tr069-management enable
 ont tr069-server-config 0 0 profile-id 1
 ont tr069-server-config 0 1 profile-id 1
 ont tr069-server-config 0 2 profile-id 1
 ont tr069-server-config 9 17 profile-id 2
`

test('lee los perfiles con su URL', () => {
  const perfiles = parsePerfilesTr069(CONFIG)
  assert.equal(perfiles.length, 2)

  assert.deepEqual(perfiles[1], {
    id: 2,
    nombre: 'GenieACS',
    url: 'http://192.168.55.254:7547',
    usuario: null,
    conClave: false,
  })
})

test('la clave del ACS no sale nunca del equipo', () => {
  /**
   * Es la credencial con la que TODAS las ONT del padrón se presentan ante el
   * ACS. Una sola pantalla que la muestre la reparte a cualquiera que pase por
   * detrás de un técnico.
   */
  const perfiles = parsePerfilesTr069(CONFIG)
  const smartolt = perfiles.find((p) => p.id === 1)

  assert.equal(smartolt.usuario, 'soltcpe')
  assert.equal(smartolt.conClave, true, 'tiene que informar que hay clave puesta')
  assert.ok(!('clave' in smartolt))
  assert.ok(!JSON.stringify(perfiles).includes('%$%#'))
  assert.ok(!JSON.stringify(perfiles).includes('SQ./T8SZwjRKeaB9'))
})

test('la línea de habilitación no se confunde con un perfil', () => {
  // `tr069-management enable` aparece en la misma búsqueda y no es un perfil.
  // Contarlo daría un perfil fantasma con todo en null.
  assert.equal(parsePerfilesTr069(CONFIG).length, 2)
  assert.ok(parsePerfilesTr069(CONFIG).every((p) => p.nombre))
})

test('cuenta cuántas ONT usa cada perfil', () => {
  const cuentas = contarAsignacionesTr069(CONFIG)
  assert.equal(cuentas.get(1), 3)
  assert.equal(cuentas.get(2), 1)
})

test('cuenta las IPs de gestión, estáticas y por DHCP', () => {
  const salida = `
 ont ipconfig 0 0 static ip-address 192.168.240.225 mask 255.255.255.0 vlan 999 priority 2
 ont ipconfig 0 1 static ip-address 192.168.240.177 mask 255.255.255.0 vlan 999 priority 2
 ont ipconfig 3 4 dhcp vlan 999 priority 2
  `
  assert.equal(contarIpsDeGestion(salida), 3)
})

/* ── El estado de una ONT ──────────────────────────────────────────────────── */

const ONT_QUE_ANDA = `
  Control flag            : active
  Run state               : online
  Config state            : normal
  SN                      : 434D4443A1A3BA49 (CMDC-A1A3BA49)
  ONT IP 0 address/mask   : 192.168.240.30/24
  Line profile ID      : 2
  TR069 management    :Enable
  TR069 server profile ID      : 1
  TR069 server profile name    : SmartOLT
`

const ONT_QUE_NO_LEVANTA = `
  Control flag            : active
  Run state               : online
  Config state            : normal
  SN                      : 534B5957B800528F (SKYW-B800528F)
  Line profile ID      : 2
  TR069 management    :Enable
  TR069 server profile ID      : 2
  TR069 server profile name    : GenieACS
`

test('separa la IP que la ONT reporta de la que se le escribió', () => {
  /**
   * La diferencia entre estas dos ONT es TODO el diagnóstico. Las dos tienen
   * perfil, las dos tienen la IP escrita, las dos dicen "online". Solo una
   * reporta su dirección puesta, y es la única que el ACS puede ver.
   */
  assert.equal(parseTr069DeOnt(ONT_QUE_ANDA).ipViva, '192.168.240.30')
  assert.equal(parseTr069DeOnt(ONT_QUE_NO_LEVANTA).ipViva, null)
})

test('lee el perfil asignado y si la gestión está habilitada', () => {
  const e = parseTr069DeOnt(ONT_QUE_ANDA)
  assert.equal(e.perfilId, 1)
  assert.equal(e.perfilNombre, 'SmartOLT')
  assert.equal(e.gestionHabilitada, true)
  assert.equal(e.estado, 'online')
})

test('una ONT sin TR-069 no inventa un perfil', () => {
  const e = parseTr069DeOnt('  Run state : online\n  Control flag : active\n')
  assert.equal(e.perfilId, null)
  assert.equal(e.perfilNombre, null)
  assert.equal(e.gestionHabilitada, false)
})

/* ── El diagnóstico ────────────────────────────────────────────────────────── */

test('el caso medido en la SKYW: acusa recibo y no levanta', () => {
  const d = diagnosticoTr069({
    ...parseTr069DeOnt(ONT_QUE_NO_LEVANTA),
    ipConfigurada: '192.168.240.250',
  })
  assert.equal(d.lista, false)
  assert.match(d.motivo, /no levantó la interfaz/i)
})

test('la ONT que anda se declara lista', () => {
  const d = diagnosticoTr069({
    ...parseTr069DeOnt(ONT_QUE_ANDA),
    ipConfigurada: '192.168.240.30',
    macsEnGestion: 1,
  })
  assert.equal(d.lista, true)
})

/* ── La MAC, que es la única prueba de que la ONT habla ────────────────────── */

const MACS = `
   SRV-P BUNDLE TYPE MAC            MAC TYPE F /S /P   VPI  VCI   VLAN ID
   INDEX INDEX
  -----------------------------------------------------------------------
      18     -  gpon f895-2232-e13a dynamic  0 /6 /9   1    1         200
      22     -  gpon f895-2232-e13c dynamic  0 /6 /9   1    2         999
  -----------------------------------------------------------------------
   Total: 2
`

test('lee las MAC con la VLAN de cada una', () => {
  const macs = parseMacsDeOnt(MACS)
  assert.equal(macs.length, 2)
  assert.deepEqual(macs[1], { mac: 'f895-2232-e13c', vlan: 999 })
})

test('una ONT sin MAC no da error, da lista vacía', () => {
  assert.deepEqual(parseMacsDeOnt('  Failure: There is not any MAC address record'), [])
})

test('la MAC aprendida SÍ confirma que la ONT habla', () => {
  const d = diagnosticoTr069({
    estado: 'online',
    gestionHabilitada: true,
    perfilId: 2,
    ipConfigurada: '192.168.240.30',
    ipViva: '192.168.240.30',
    macsEnGestion: 1,
  })
  assert.equal(d.lista, true)
})

test('SIN MAC NO SE CONDENA A LA ONT: la tabla envejece', () => {
  /**
   * El error que esta prueba fija.
   *
   * La primera versión declaraba "no lista" a toda ONT sin MAC en la VLAN de
   * gestión. Medido contra el equipo: la CMDC H3-1s de 0/6/3 responde al ping
   * —o sea, se gestiona— y figuraba SIN MAC, porque su IP host no manda nada
   * mientras nadie la busca y la tabla la había envejecido.
   *
   * Con aquella regla, la pantalla mandaba a reconfigurar una ONT que estaba
   * perfecta. Ahora la ausencia de MAC devuelve "no lo sé", que es lo único
   * cierto, y dice cómo averiguarlo.
   */
  const d = diagnosticoTr069({
    estado: 'online',
    gestionHabilitada: true,
    perfilId: 2,
    ipConfigurada: '192.168.240.30',
    ipViva: '192.168.240.30',
    macsEnGestion: 0,
  })

  assert.equal(d.lista, null, 'sin MAC no se afirma ni se niega')
  assert.match(d.motivo, /envejece/i)
  assert.match(d.motivo, /ping/i, 'tiene que decir cómo salir de la duda')
})

test('si nadie miró la tabla de MAC, tampoco se afirma que esté lista', () => {
  const d = diagnosticoTr069({
    estado: 'online',
    gestionHabilitada: true,
    perfilId: 2,
    ipConfigurada: '10.0.0.5',
    ipViva: '10.0.0.5',
  })
  assert.equal(d.lista, null)
  assert.match(d.motivo, /No se comprobó/i)
})

test('cada motivo señala una causa distinta', () => {
  /**
   * Un diagnóstico que diga siempre lo mismo manda a revisar al azar. Se
   * comprueba que cada faltante dé su propio motivo.
   */
  const base = {
    estado: 'online',
    gestionHabilitada: true,
    perfilId: 2,
    ipConfigurada: '10.0.0.5',
    ipViva: '10.0.0.5',
    macsEnGestion: 1,
  }

  const motivos = [
    diagnosticoTr069({ ...base, estado: 'offline' }).motivo,
    diagnosticoTr069({ ...base, gestionHabilitada: false }).motivo,
    diagnosticoTr069({ ...base, perfilId: null }).motivo,
    diagnosticoTr069({ ...base, ipConfigurada: null }).motivo,
    diagnosticoTr069({ ...base, ipViva: null }).motivo,
    diagnosticoTr069({ ...base, macsEnGestion: 0 }).motivo,
  ]

  assert.equal(new Set(motivos).size, 6, `se repiten motivos: ${motivos.join(' | ')}`)
})

test('la ONT caída se reporta como caída y no como mal configurada', () => {
  // Si no, el técnico va a revisar perfiles y VLANs de una ONT que está apagada.
  const d = diagnosticoTr069({ estado: 'offline', gestionHabilitada: false, perfilId: null })
  assert.match(d.motivo, /fuera de línea/i)
})
