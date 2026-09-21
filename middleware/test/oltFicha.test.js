import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { analizarCoherencia, evaluar, taparSecretos, AREAS } from '../src/services/oltFicha.js'

/**
 * Auditoría de coherencia y lectura del relevamiento.
 *
 * Los casos están escritos como se dan en la realidad: el plan que alguien
 * renombró, los dos planes peleándose el mismo índice, la placa de reserva que
 * no es una falla. Todo lo que se prueba acá es una decisión de "esto está mal y
 * es así de grave", que es exactamente lo que un operador va a creer sin
 * verificar.
 */

const buscar = (hallazgos, clave) => hallazgos.filter((h) => h.clave === clave)
const hay = (hallazgos, clave) => buscar(hallazgos, clave).length > 0

/** Una OLT sana, para que cada test solo tenga que romper una cosa. */
const oltSana = (extra = {}) => ({
  id: 'olt-1',
  nombre: 'X7 LA MANA',
  activo: true,
  hw_version: 'MA5800-X7',
  sw_version: 'R018',
  ntp_servers: '200.1.1.1',
  snmp_trap: false,
  snmp_ro_encrypted: null,
  ...extra,
})

const onu = (extra = {}) => ({
  id: 'onu-1',
  olt_id: 'olt-1',
  sn: 'HWTC00000001',
  plan_id: 'plan-1',
  plan_velocidad: 'PLAN_100M',
  estado: 'online',
  ...extra,
})

const plan = (extra = {}) => ({
  id: 'plan-1',
  nombre: 'PLAN_100M',
  traffic_table_index: 10,
  bajada_kbps: 100000,
  subida_kbps: 50000,
  ...extra,
})

describe('auditoría de coherencia', () => {
  test('una instalación sana no reporta nada', () => {
    const h = analizarCoherencia({
      olts: [oltSana()],
      onus: [onu()],
      planes: [plan()],
      perfiles: [],
    })
    assert.deepEqual(h, [])
  })

  test('detecta dos planes peleándose el mismo índice de traffic table', () => {
    const h = analizarCoherencia({
      olts: [oltSana()],
      onus: [],
      planes: [
        plan({ id: 'p1', nombre: 'PLAN_100M', traffic_table_index: 7 }),
        plan({ id: 'p2', nombre: 'PLAN_300M', traffic_table_index: 7 }),
      ],
    })

    const encontrado = buscar(h, 'indice-duplicado')
    assert.equal(encontrado.length, 1)
    assert.equal(encontrado[0].severidad, 'alta')
    // El mensaje tiene que nombrar a los dos: con uno solo no se sabe qué mirar.
    assert.match(encontrado[0].detalle, /PLAN_100M/)
    assert.match(encontrado[0].detalle, /PLAN_300M/)
  })

  test('un plan sin índice no se puede aplicar y se avisa', () => {
    const h = analizarCoherencia({
      olts: [oltSana()],
      onus: [],
      planes: [plan({ traffic_table_index: null })],
    })
    assert.ok(hay(h, 'plan-sin-indice'))
    // Y no se lo cuenta además como duplicado: no compite con nadie por un índice.
    assert.ok(!hay(h, 'indice-duplicado'))
  })

  test('detecta el plan renombrado que dejó la copia vieja en la ONU', () => {
    const h = analizarCoherencia({
      olts: [oltSana()],
      onus: [onu({ plan_velocidad: 'PLAN_50M' })],
      planes: [plan({ nombre: 'PLAN_50_MEGAS' })],
    })

    const encontrado = buscar(h, 'plan-renombrado')
    assert.equal(encontrado.length, 1)
    // No afecta el servicio: exagerar la severidad hace que se ignore el resto.
    assert.equal(encontrado[0].severidad, 'baja')
    assert.match(encontrado[0].ejemplos[0], /PLAN_50M.*PLAN_50_MEGAS/)
  })

  test('un mismo número de serie en dos OLTs es un fantasma de migración', () => {
    const h = analizarCoherencia({
      olts: [oltSana(), oltSana({ id: 'olt-2', nombre: 'PROGRESO' })],
      onus: [
        onu({ id: 'a', sn: 'HWTC00000009', olt_id: 'olt-1' }),
        onu({ id: 'b', sn: 'HWTC00000009', olt_id: 'olt-2' }),
      ],
      planes: [plan()],
    })

    const encontrado = buscar(h, 'sn-repetido')
    assert.equal(encontrado.length, 1)
    assert.equal(encontrado[0].severidad, 'alta')
    assert.match(encontrado[0].ejemplos[0], /X7 LA MANA.*PROGRESO/)
  })

  test('una ONU apuntando a una OLT que ya no existe queda huérfana', () => {
    const h = analizarCoherencia({
      olts: [oltSana()],
      onus: [onu({ olt_id: 'olt-borrada' })],
      planes: [plan()],
    })
    assert.ok(hay(h, 'onu-huerfana'))
  })

  test('dos line profiles con el mismo ID interno se pisan dentro del equipo', () => {
    const h = analizarCoherencia({
      olts: [oltSana()],
      onus: [],
      planes: [],
      perfiles: [
        { id: 'lp1', olt_id: 'olt-1', nombre: 'VLAN100', profile_id_olt: 5 },
        { id: 'lp2', olt_id: 'olt-1', nombre: 'VLAN200', profile_id_olt: 5 },
      ],
    })
    assert.ok(hay(h, 'perfil-duplicado'))
  })

  test('el mismo ID interno en OLTs distintas NO es un conflicto', () => {
    // Los perfiles viven dentro de cada equipo: el 5 de una OLT y el 5 de otra
    // no se tocan. Reportarlo mandaría a "arreglar" algo que está bien.
    const h = analizarCoherencia({
      olts: [oltSana(), oltSana({ id: 'olt-2', nombre: 'PROGRESO' })],
      onus: [],
      planes: [],
      perfiles: [
        { id: 'lp1', olt_id: 'olt-1', nombre: 'VLAN100', profile_id_olt: 5 },
        { id: 'lp2', olt_id: 'olt-2', nombre: 'VLAN100', profile_id_olt: 5 },
      ],
    })
    assert.ok(!hay(h, 'perfil-duplicado'))
  })

  test('escuchar traps sin comunidad SNMP no va a recibir nada', () => {
    const h = analizarCoherencia({
      olts: [oltSana({ snmp_trap: true, snmp_ro_encrypted: null })],
      onus: [onu()],
      planes: [plan()],
    })
    const encontrado = buscar(h, 'trap-sin-comunidad')
    assert.equal(encontrado.length, 1)
    assert.equal(encontrado[0].severidad, 'alta')
  })

  test('con la comunidad cargada, escuchar traps está bien', () => {
    const h = analizarCoherencia({
      olts: [oltSana({ snmp_trap: true, snmp_ro_encrypted: 'v1:x:y:z' })],
      onus: [onu()],
      planes: [plan()],
    })
    assert.ok(!hay(h, 'trap-sin-comunidad'))
  })

  test('la ficha sin NTP se anota, pero sin afirmar nada sobre el reloj', () => {
    // El X7 estaba sincronizado en estrato 2 con este campo vacío. Un hallazgo
    // que dijera "no tiene NTP" mandaría a arreglar algo que funciona.
    const h = analizarCoherencia({
      olts: [oltSana({ ntp_servers: null })],
      onus: [onu()],
      planes: [plan()],
    })

    const encontrado = buscar(h, 'ntp-sin-registrar')
    assert.equal(encontrado.length, 1)
    assert.equal(encontrado[0].severidad, 'baja')
    // No puede afirmar que el reloj esté mal: eso solo se sabe preguntándoselo.
    assert.doesNotMatch(encontrado[0].detalle, /se corre|desincronizad|sin sincroniz/i)
  })

  test('una OLT sin versiones leídas no puede detectar un cambio de firmware', () => {
    const h = analizarCoherencia({
      olts: [oltSana({ hw_version: null, sw_version: null })],
      onus: [onu()],
      planes: [plan()],
    })
    assert.ok(hay(h, 'sin-version'))
  })

  test('una OLT apagada con abonados vivos es grave', () => {
    const h = analizarCoherencia({
      olts: [oltSana({ activo: false })],
      onus: [onu()],
      planes: [plan()],
    })
    const encontrado = buscar(h, 'oculta-con-onus')
    assert.equal(encontrado[0].severidad, 'alta')
    // Y no se la reporta también por "activa sin ONUs": son excluyentes.
    assert.ok(!hay(h, 'sin-onus'))
  })

  test('los hallazgos vienen ordenados por gravedad', () => {
    const h = analizarCoherencia({
      olts: [oltSana({ ntp_servers: null, snmp_trap: true })],
      onus: [
        onu({ id: 'a', sn: 'DUP', olt_id: 'olt-1' }),
        onu({ id: 'b', sn: 'DUP', olt_id: 'olt-1', plan_velocidad: 'viejo' }),
      ],
      planes: [plan()],
    })

    const orden = { alta: 0, media: 1, baja: 2 }
    const severidades = h.map((x) => orden[x.severidad])
    assert.deepEqual(severidades, [...severidades].sort((a, b) => a - b))
  })

  test('cada hallazgo dice qué hacer, no solo qué está mal', () => {
    const h = analizarCoherencia({
      olts: [oltSana({ ntp_servers: null, hw_version: null, sw_version: null })],
      onus: [onu({ plan_id: null })],
      planes: [plan({ traffic_table_index: null })],
    })

    assert.ok(h.length > 0)
    for (const x of h) {
      assert.ok(x.sugerencia, `"${x.titulo}" no dice qué hacer`)
      assert.ok(x.detalle, `"${x.titulo}" no explica por qué importa`)
    }
  })
})

describe('lectura del relevamiento', () => {
  test('un comando rechazado no cuenta como útil', () => {
    const r = evaluar({
      comando: 'display fan',
      salida: '% Unknown command found at \'^\' position.',
      rechazo: '% Unknown command found',
    })
    assert.equal(r.util, false)
  })

  test('un comando aceptado con salida cuenta las líneas', () => {
    const r = evaluar({
      comando: 'display board 0',
      salida: 'display board 0\n  6  H901GPHF  Normal\n  7  H901GPHF  Normal',
      rechazo: null,
    })
    assert.equal(r.util, true)
    // El eco del comando no es una línea de datos.
    assert.equal(r.lineas, 2)
  })

  test('una tabla vacía es un resultado válido, no un rechazo', () => {
    // "aceptado pero vacío" y "no entiendo el comando" mandan a lugares
    // distintos: uno dice que no hay nada configurado, el otro que hay que
    // buscar otro comando.
    const r = evaluar({ comando: 'display vlan all', salida: 'display vlan all', rechazo: null })
    assert.equal(r.rechazo, null)
    assert.equal(r.util, false)
    assert.equal(r.lineas, 0)
  })

  test('los códigos de terminal no se cuentan como contenido', () => {
    const r = evaluar({
      comando: 'display time',
      salida: '\x1b[2Kdisplay time\n\x1b[1;1H2026-08-02 22:02:05-05:00',
      rechazo: null,
    })
    assert.equal(r.lineas, 1)
    assert.equal(r.util, true)
  })

  test('el hint de autocompletado de VRP no es una línea de datos', () => {
    // La CLI de Huawei imprime `{ <cr>||<K> }:` esperando el Enter extra. Si se
    // contara, un comando que no devolvió nada parecería haber traído algo.
    const r = evaluar({
      comando: 'display ont autofind all',
      salida: 'display ont autofind all\n  { <cr>||<K> }:',
      rechazo: null,
    })
    assert.equal(r.lineas, 0)
    assert.equal(r.util, false)
  })
})

describe('credenciales en la salida cruda', () => {
  test('tapa la comunidad SNMP que devuelve el MA5800', () => {
    // Salida real del X7. Antes de esto, la comunidad de ESCRITURA aparecía en
    // claro en la pantalla de relevamiento.
    const real = `display snmp-agent community write
   Community name: 0Sxmrv5pbfCc
   Storage type: nonVolatile
   View name: ViewDefault`

    const r = taparSecretos(real)
    assert.ok(!r.includes('0Sxmrv5pbfCc'), 'la comunidad quedó visible')
    // La etiqueta se conserva: para escribir el parser hace falta saber que el
    // campo existe y cómo viene, no cuánto vale.
    assert.match(r, /Community name:\s*•+/)
    assert.match(r, /Storage type: nonVolatile/)
    assert.match(r, /View name: ViewDefault/)
  })

  test('tapa contraseñas y claves en cualquiera de las dos marcas', () => {
    const r = taparSecretos(
      ['password: hunter2', 'auth-key = s3cr3t', 'snmp-server community publico rw'].join('\n'),
    )
    assert.ok(!r.includes('hunter2'))
    assert.ok(!r.includes('s3cr3t'))
    assert.ok(!r.includes('publico'))
  })

  test('tapa los hashes de usuario de la configuración Huawei', () => {
    // Líneas reales de `display current-configuration` del X7. Son hashes, no
    // texto plano, pero un hash se ataca sin conexión y con todo el tiempo del
    // mundo. Esta forma —sin dos puntos, con el usuario en el medio— se me
    // escapó en la primera versión.
    const real = [
      'terminal user name buildrun_new_password root *j$1b$K/zs1IbH44$S@C%.RO9,N>."=E7"GiC:3:D5QS',
      'terminal user name history_password root *j$1b$tL>#(!DekJ$dfVf4]xwv&oH}U!lfNT@U:im%JN}JVo7',
    ].join('\n')

    const r = taparSecretos(real)
    assert.ok(!r.includes('K/zs1IbH44'), 'quedó el hash de root')
    assert.ok(!r.includes('tL>#(!DekJ'), 'quedó el hash del historial')
    // El nombre del usuario se conserva: saber que existe una cuenta "root" es
    // parte de auditar el equipo, y no es el secreto.
    assert.match(r, /terminal user name buildrun_new_password root/)
  })

  test('una política de contraseñas no es una contraseña', () => {
    // "system user password security-length 8" configura el largo mínimo.
    // Taparlo escondería un dato de auditoría sin proteger nada.
    const linea = 'system user password security-length 8'
    assert.equal(taparSecretos(linea), linea)
  })

  test('tapa un blob cifrado aunque la etiqueta sea desconocida', () => {
    // Si el enmascarado dependiera de reconocer cada etiqueta, la primera que
    // aparezca en otro comando se filtra.
    const r = taparSecretos('algo-que-nunca-vimos *m$1b$AbCdEf$xyz123456')
    assert.ok(!r.includes('AbCdEf'))
  })

  test('no toca el resto de la salida', () => {
    const tabla = '  6  H901GPHF  Normal\n  clock stratum: 2'
    assert.equal(taparSecretos(tabla), tabla)
  })

  test('el largo tapado no delata el largo real de una clave larga', () => {
    const r = taparSecretos('Community name: unacomunidadmuchomuylargaqueseguroesfuerte')
    assert.match(r, /Community name: •{12}$/)
  })

  test('evaluar devuelve la salida ya enmascarada', () => {
    // Es lo que viaja al navegador: si el enmascarado dependiera de que la
    // pantalla se acuerde de aplicarlo, la primera que lo olvide lo filtra.
    const r = evaluar({
      comando: 'display snmp-agent community write',
      salida: 'display snmp-agent community write\n   Community name: 0Sxmrv5pbfCc',
      rechazo: null,
    })
    assert.ok(!r.salida.includes('0Sxmrv5pbfCc'))
  })
})

describe('catálogo de relevamiento', () => {
  test('cada área tiene candidatos para las dos marcas', () => {
    for (const [clave, area] of Object.entries(AREAS)) {
      assert.ok(area.titulo, `${clave} sin título`)
      assert.ok(area.comandos.Huawei?.length, `${clave} sin comandos Huawei`)
      assert.ok(area.comandos.VSOL?.length, `${clave} sin comandos VSOL`)
    }
  })

  test('no se cuelan comandos que modifiquen el equipo', () => {
    // El relevamiento es de solo lectura: corre sin confirmación y contra
    // producción. Un `undo` acá dejaría sin servicio a un puerto entero.
    const peligrosos = /^\s*(undo|no|delete|reset|reboot|erase|clear|shutdown|save)\b/i
    for (const [clave, area] of Object.entries(AREAS)) {
      for (const lista of Object.values(area.comandos)) {
        for (const cmd of lista) {
          assert.ok(!peligrosos.test(cmd), `${clave}: "${cmd}" no es de solo lectura`)
        }
      }
    }
  })
})
