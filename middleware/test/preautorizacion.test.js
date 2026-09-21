import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { decidirPreautorizacion } from '../src/services/preautorizacion.js'

/**
 * Autorizar sola una ONT es lo único que escribe en un equipo de producción sin
 * que una persona apriete nada. Todo lo de acá existe para que no lo haga
 * cuando no corresponde.
 *
 * La regla es una sola: cualquier cosa que no sea un "sí" limpio es un "no". Que
 * alguien tenga que apretar un botón es una molestia; que se configure sola una
 * ONT que no era, es un abonado ajeno tomando el servicio de otro.
 */

const CARGA = {
  estado: 'esperando',
  automatica: true,
  vlan: 200,
  line_profile_id: 2,
  srv_profile_id: 11,
  slot: null,
  puerto: null,
  vence_at: null,
}
const ONT = { sn: 'SKYWB800528F', slot: 6, puerto: 9 }

describe('cuándo se autoriza sola', () => {
  test('cargada, automática y con todos los datos: sí', () => {
    assert.equal(decidirPreautorizacion(CARGA, ONT).autorizar, true)
  })

  test('una serie que nadie cargó: nunca', () => {
    // Ésta es la garantía de fondo: lo que aparece suelto en la fibra no se
    // toca. Sin esto, cualquier ONT enchufada por cualquiera entraría sola.
    const d = decidirPreautorizacion(null, ONT)
    assert.equal(d.autorizar, false)
    assert.match(d.motivo, /no estaba cargada/)
  })

  test('marcada para autorizar a mano: no', () => {
    assert.equal(decidirPreautorizacion({ ...CARGA, automatica: false }, ONT).autorizar, false)
  })

  test('ya autorizada o fallada: no se vuelve a intentar', () => {
    // Sin esto, una que falla se reintentaría cada cinco minutos para siempre.
    assert.equal(decidirPreautorizacion({ ...CARGA, estado: 'fallada' }, ONT).autorizar, false)
    assert.equal(decidirPreautorizacion({ ...CARGA, estado: 'autorizada' }, ONT).autorizar, false)
  })
})

describe('la ubicación esperada', () => {
  test('si coincide, se autoriza', () => {
    const d = decidirPreautorizacion({ ...CARGA, slot: 6, puerto: 9 }, ONT)
    assert.equal(d.autorizar, true)
  })

  test('si apareció en otro puerto, NO', () => {
    // El caso real: la ONT se cargó para un abonado, el equipo terminó en manos
    // de otro y se conectó en otra zona. Autorizarla ahí le daría el servicio y
    // el plan del primero a quien no corresponde.
    const d = decidirPreautorizacion({ ...CARGA, slot: 6, puerto: 3 }, ONT)
    assert.equal(d.autorizar, false)
    assert.match(d.motivo, /apareció en 6\/9 y estaba cargada para 6\/3/)
  })

  test('sin ubicación cargada, entra donde aparezca', () => {
    // Es a propósito: si no se sabe de antemano en qué puerto va a caer, exigir
    // que coincida haría que no entre nunca.
    assert.equal(decidirPreautorizacion(CARGA, { ...ONT, slot: 0, puerto: 4 }).autorizar, true)
  })
})

describe('el vencimiento', () => {
  const ahora = new Date('2026-08-04T12:00:00Z')

  test('todavía vigente: entra', () => {
    const d = decidirPreautorizacion({ ...CARGA, vence_at: '2026-08-10T00:00:00Z' }, ONT, ahora)
    assert.equal(d.autorizar, true)
  })

  test('vencida: no, y queda marcada', () => {
    // Una ONT cargada para una instalación que se canceló no puede quedar
    // autorizándose sola seis meses después, cuando el equipo se revendió y
    // aparece en la fibra de otro.
    const d = decidirPreautorizacion({ ...CARGA, vence_at: '2026-07-01T00:00:00Z' }, ONT, ahora)
    assert.equal(d.autorizar, false)
    assert.equal(d.vencida, true)
  })
})

describe('datos incompletos', () => {
  test('sin VLAN no entra, aunque todo lo demás esté', () => {
    // Entraría registrada y sin service-port: conectada, sin pasar tráfico, y
    // desde el lado GPON se ve todo bien. Es lo más difícil de diagnosticar.
    const d = decidirPreautorizacion({ ...CARGA, vlan: null }, ONT)
    assert.equal(d.autorizar, false)
    assert.match(d.motivo, /VLAN/)
  })

  test('sin perfiles tampoco', () => {
    // Entraría con la configuración por defecto del equipo: online, con el
    // nombre correcto, y con otro comportamiento.
    assert.equal(decidirPreautorizacion({ ...CARGA, srv_profile_id: null }, ONT).autorizar, false)
    assert.equal(decidirPreautorizacion({ ...CARGA, line_profile_id: null }, ONT).autorizar, false)
  })

  test('la VLAN 0 no se confunde con "sin VLAN"', () => {
    // vlan == null es "no hay dato"; un cero es un dato. Confundirlos es el
    // mismo error de siempre: "no sé" no es "cero".
    const d = decidirPreautorizacion({ ...CARGA, vlan: 0 }, ONT)
    assert.equal(d.autorizar, true)
  })
})
