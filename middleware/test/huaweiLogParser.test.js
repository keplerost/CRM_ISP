import test from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistroCli } from '../src/parsers/huaweiLogParser.js'

// Recortado de `display log cli all` del MA5800-X7 de La Maná, tal cual llegó.
const SALIDA = `display log cli all
{ <cr>|start-date<D><yyyy-mm-dd>||<K> }:


  Command:
          display log cli all
  ------------------------------------------------------------------------------
  No.      UserName                         Domain               IP-Address
  74087    smartoltusr                      --                   172.16.10.3
  Time:    2026-09-11 01:39:57-05:00
  Cmd:     config
  ------------------------------------------------------------------------------
  No.      UserName                         Domain               IP-Address
  74081    smartoltusr                      --                   23.108.35.2
\x1b[37D                                     \x1b[37D  Time:    2026-09-11 00:42:35-05:00
  Cmd:     ont wan-access http 0/6/0 10 enable
  ------------------------------------------------------------------------------
  No.      UserName                         Domain               IP-Address
  74070    smartoltusr                      --                   23.108.35.2
  Time:    2026-09-11 00:07:45-05:00
  Cmd:     service-port 74 vlan 999 gpon 0/6/0 ont 10 gemport 2 multi-service user-vlan 999 tag-transform translate inbound traffic-table name SMARTOLT-VOIPMNG-10M outbound traffic-table name
           SMARTOLT-VOIPMNG-10M
  ------------------------------------------------------------------------------
  No.      UserName                         Domain               IP-Address
  72971    SYS                              --                   --
  Time:    2026-09-10 21:34:12-05:00
  Cmd:     enable
  ------------------------------------------------------------------------------
  No.      UserName                         Domain               IP-Address
  74014    smartoltusr                      --                   23.108.35.2
  Time:    2026-09-11 01:28:52-05:00
  Failure Cmd:  undo ont policy-route-config 0 10
  ------------------------------------------------------------------------------

MA5800-X7(config)#`

test('una entrada por comando, con usuario, IP, hora y comando', () => {
  const e = parseRegistroCli(SALIDA)
  assert.equal(e.length, 5)
  assert.deepEqual(e[0], {
    numero: 74087,
    usuario: 'smartoltusr',
    dominio: null,
    ip: '172.16.10.3',
    fecha: '2026-09-11 01:39:57-05:00',
    comando: 'config',
    fallo: false,
  })
})

test('los saltos de cursor de la terminal no rompen la entrada', () => {
  const e = parseRegistroCli(SALIDA)
  assert.equal(e[1].fecha, '2026-09-11 00:42:35-05:00')
  assert.equal(e[1].comando, 'ont wan-access http 0/6/0 10 enable')
})

test('un comando partido en dos líneas vuelve entero', () => {
  const e = parseRegistroCli(SALIDA)
  assert.match(e[2].comando, /outbound traffic-table name SMARTOLT-VOIPMNG-10M$/)
})

test('sin IP ni dominio queda en null, y el prompt final no se cuela', () => {
  const e = parseRegistroCli(SALIDA)
  assert.equal(e[3].usuario, 'SYS')
  assert.equal(e[3].ip, null)
  assert.equal(e[3].comando, 'enable')
})

test('un comando que el equipo rechazó entra igual, marcado como fallo', () => {
  const e = parseRegistroCli(SALIDA)
  assert.equal(e[4].numero, 74014)
  assert.equal(e[4].comando, 'undo ont policy-route-config 0 10')
  assert.equal(e[4].fallo, true)
  assert.equal(e[3].fallo, false)
})

test('una salida vacía o sin entradas no rompe', () => {
  assert.deepEqual(parseRegistroCli(''), [])
  assert.deepEqual(parseRegistroCli('No record is available'), [])
})
