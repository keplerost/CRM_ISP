import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseAutofind } from '../src/parsers/huaweiOntParser.js'

/**
 * Lo que el equipo sabe de una ONT que todavía nadie autorizó.
 *
 * Salida literal del MA5800-X7 para la SKYWB800528F.
 */
const SALIDA = `  Command:
          display ont autofind 9
   ----------------------------------------------------------------------------
   Number              : 1
   F/S/P               : 0/6/9
   Ont SN              : 534B5957B800528F (SKYW-B800528F)
   Password            : 0x30303030303030310000(00000001)
   Loid                :
   Checkcode           :
   VendorID            : SKYW
   Ont Version         : V1.0
   Ont SoftwareVersion : V2.2.0.10
   Ont EquipmentID     : GN256VH
   Ont Customized Info : -
   Ont MAC             : -
   Ont Equipment SN    : -
   Ont autofind time   : 2026-08-03 23:27:12-05:00
   Multi channel       : -
   ----------------------------------------------------------------------------`

describe('ficha de una ONT sin autorizar', () => {
  const [o] = parseAutofind(SALIDA)

  test('serie, ubicación y modelo', () => {
    assert.equal(o.sn, '534B5957B800528F')
    assert.equal(o.slot, 6)
    assert.equal(o.puerto, 9)
    assert.equal(o.equipmentId, 'GN256VH')
    assert.equal(o.vendorId, 'SKYW')
    assert.equal(o.softwareVersion, 'V2.2.0.10')
  })

  test('desde cuándo la ve el equipo, respetando SU huso horario', () => {
    // El equipo informa -05:00. Interpretarlo como hora local desplazaría el
    // "hace cuánto" varias horas, y esa cifra es justo la que decide si alguien
    // sale a mirar ahora o mañana.
    assert.equal(o.detectadaEn, '2026-08-04T04:27:12.000Z')
  })

  test('los guiones del equipo son null, no la cadena "-"', () => {
    // Mostrar un guion como si fuera una MAC hace perder tiempo buscándole
    // sentido a un dato que el equipo dijo que no tiene.
    assert.equal(o.mac, null)
    assert.equal(o.equipoSn, null)
    assert.equal(o.loid, null)
  })

  test('sin hora de detección queda en null, no en una fecha inventada', () => {
    const [sinHora] = parseAutofind(SALIDA.replace(/Ont autofind time.*/, 'Ont autofind time   : -'))
    assert.equal(sinHora.detectadaEn, null)
    assert.equal(sinHora.sn, '534B5957B800528F')
  })
})
