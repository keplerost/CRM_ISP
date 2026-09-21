import test from 'node:test'
import assert from 'node:assert/strict'

import { canalesDeFactura } from '../src/services/avisoFactura.js'

/**
 * El aviso de que hay factura nueva.
 *
 * La regla del negocio es que se le avisa a TODOS al crearse la factura interna.
 * Que el abonado pida comprobante del SRI no tiene nada que ver: eso se emite
 * después, solo al cobrar y solo a quien lo pidió.
 *
 * La única excepción es el que pide expresamente que no le escriban.
 */

const CLIENTE = {
  id: 'x',
  canal_preferido: 'whatsapp',
  email: 'jose@correo.com',
  telefono_movil: '0998877665',
  telegram_chat_id: '123',
  avisos_activos: true,
  aviso_factura_canales: null,
}

test('un abonado nuevo recibe su factura sin que nadie le configure nada', () => {
  /**
   * `null` es "no lo configuré", y para este aviso eso significa TODOS los
   * canales que se puedan. Si significara "ninguno", media base migrada quedaría
   * sin aviso de factura por omisión — y la regla es que se le avisa a todos.
   */
  const canales = canalesDeFactura(CLIENTE)
  assert.ok(canales.length > 0)
  assert.equal(canales[0], 'whatsapp', 'empieza por el que prefiere')
})

test('la combinación elegida se respeta', () => {
  const c = canalesDeFactura({ ...CLIENTE, aviso_factura_canales: ['email', 'telegram'] })
  assert.deepEqual(new Set(c), new Set(['email', 'telegram']))
})

test('desactivado es una lista vacía, y se distingue de no configurado', () => {
  // No es lo mismo "no lo toqué" que "me lo pidió el abonado".
  assert.deepEqual(canalesDeFactura({ ...CLIENTE, aviso_factura_canales: [] }), [])
  assert.ok(canalesDeFactura({ ...CLIENTE, aviso_factura_canales: null }).length > 0)
})

test('el interruptor general apaga también el aviso de factura', () => {
  /**
   * Lo encontré probando contra la base: la comprobación estaba solo en el
   * momento de enviar, así que el mensaje no salía —bien— pero esta función
   * seguía contestando "por WhatsApp". Las vistas previas la usan, y habrían
   * mostrado que se le avisa a alguien que pidió que no lo molesten.
   *
   * Una función que contesta distinto según quién pregunte es una trampa.
   */
  assert.deepEqual(canalesDeFactura({ ...CLIENTE, avisos_activos: false }), [])
})

test('elegir un canal del que no se tiene el dato no lo inventa', () => {
  const sinCorreo = { ...CLIENTE, email: null, aviso_factura_canales: ['email'] }
  assert.deepEqual(canalesDeFactura(sinCorreo), [])
})
