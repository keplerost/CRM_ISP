import test from 'node:test'
import assert from 'node:assert/strict'

import {
  armar, aWhatsapp, html, identificacionParaDeposito,
} from '../src/services/paginaCorte.js'
import { ipDelPedido } from '../src/servidorCorte.js'

/**
 * La página que ve el abonado cortado.
 *
 * Lo que se prueba es QUÉ dice, no cómo se ve: el monto que muestra es una cifra
 * que alguien va a depositar y el número que muestra es al que va a mandar el
 * comprobante. Los dos errores posibles cuestan plata y una llamada.
 */

const ABONADO = {
  id: 'a1', codigo: 42, nombre: 'OÑA RIERA JOSÉ', plan: 'PLAN_HOME',
  estado: 'cortado', estado_desde: '2026-08-01T10:00:00Z',
  saldo: 40.18, facturas_pendientes: 2,
}

const CONFIG = {
  activa: true,
  titulo: 'Tu servicio está suspendido',
  mensaje: 'Tu servicio fue suspendido por falta de pago.',
  whatsapp_pagos: '0981864229',
  aviso_despues_de_pagar: 'Enviá la foto del comprobante por WhatsApp.',
  mostrar_saldo: true,
  mostrar_facturas: true,
}

const CUENTAS = [
  { nombre: 'Pichincha Ahorros', tipo: 'banco', banco: 'Pichincha', numero: '2202723021', activa: true, mostrar_en_corte: true, identificacion: '1712345678' },
  { nombre: 'Pichincha Corriente', tipo: 'banco', banco: 'Pichincha', numero: '2100300272', activa: true, mostrar_en_corte: false },
  { nombre: 'Caja Oficina', tipo: 'efectivo', activa: true, mostrar_en_corte: true },
]

const EMPRESA = {
  ruc: '0504056151001',
  razon_social: 'JOSE LUIS OÑA RIERA',
  nombre_comercial: 'OR IMPORTACIONES',
  telefono: '0981864229',
}

const armado = (extra = {}) =>
  armar({ abonado: ABONADO, config: CONFIG, cuentas: CUENTAS, empresa: EMPRESA, ...extra })

// --- El número de WhatsApp --------------------------------------------------

test('el celular ecuatoriano se convierte al formato de WhatsApp', () => {
  // Sin el código de país el enlace no abre nada, y el abonado que ya pagó no
  // tiene cómo avisar: sigue cortado y vuelve a llamar.
  assert.equal(aWhatsapp('0981864229'), '593981864229')
  assert.equal(aWhatsapp('098 186 4229'), '593981864229')
  assert.equal(aWhatsapp('+593981864229'), '593981864229')
  assert.equal(aWhatsapp('593981864229'), '593981864229')
})

test('sin número no se inventa uno', () => {
  assert.equal(aWhatsapp(''), null)
  assert.equal(aWhatsapp(null), null)
})

// --- Qué se le muestra ------------------------------------------------------

test('al que debe se le dice cuánto y dónde', () => {
  const d = armado()
  assert.equal(d.motivo, 'mora')
  assert.equal(d.saldo, 40.18)
  assert.equal(d.facturas, 2)
  assert.equal(d.cuentas.length, 1)
  assert.equal(d.whatsapp, '593981864229')
})

test('la caja de la oficina no se publica', () => {
  // "Depositá en Caja Oficina" no significa nada para alguien sentado en su casa.
  const d = armado()
  assert.ok(!d.cuentas.some((c) => c.tipo === 'Cuenta' && c.banco === 'Caja Oficina'))
})

test('solo se publican las cuentas marcadas', () => {
  // Publicar un número de cuenta es una decisión, no un valor por defecto.
  const d = armado()
  assert.deepEqual(d.cuentas.map((c) => c.numero), ['2202723021'])
})

test('la cuenta lleva la identificación del titular', () => {
  // En Ecuador el cajero la pide. Sin ella el abonado llega a la ventanilla y no
  // puede completar el depósito — y vuelve a llamar.
  const d = armado()
  assert.equal(d.cuentas[0].identificacion, '1712345678')
  assert.equal(d.cuentas[0].titular, 'JOSE LUIS OÑA RIERA', 'cae al nombre de la empresa')
})

test('al que NO debe no se le pide plata', () => {
  /**
   * Son dos conversaciones distintas. A alguien suspendido sin deuda pedirle que
   * deposite lo manda a pagar de más, y esa plata después hay que devolverla.
   */
  const d = armado({ abonado: { ...ABONADO, saldo: 0, facturas_pendientes: 0 } })
  assert.equal(d.motivo, 'suspendido')
  assert.equal(d.saldo, null)
  assert.match(d.mensaje, /no tenemos una deuda registrada/)
})

test('el ISP puede esconder el monto', () => {
  const d = armado({ config: { ...CONFIG, mostrar_saldo: false } })
  assert.equal(d.saldo, null)
  assert.equal(d.cuentas.length, 1, 'las cuentas siguen: puede pagar aunque no vea el total')
})

// --- Que un ISP nuevo no tenga que configurar dos veces lo mismo -------------

describe_identificacion()
function describe_identificacion() {
  test('el RUC de una persona se muestra como cédula', () => {
    /**
     * En Ecuador el RUC de una persona natural es su cédula más "001", pero la
     * cuenta bancaria está a nombre de la persona y el cajero pide la CÉDULA.
     * Mostrar los trece dígitos hace que el depositante escriba un número que no
     * empareja con el titular, y el depósito se rechaza en la ventanilla.
     */
    assert.equal(identificacionParaDeposito('0504056151001'), '0504056151')
  })

  test('el RUC de una sociedad se muestra entero', () => {
    // Ahí la cuenta sí está a nombre de la empresa.
    assert.equal(identificacionParaDeposito('1791234567002'), '1791234567002')
    assert.equal(identificacionParaDeposito('0990012345001'), '0990012345')
  })

  test('sin RUC no se inventa nada', () => {
    assert.equal(identificacionParaDeposito(''), null)
    assert.equal(identificacionParaDeposito(null), null)
  })
}

test('la cuenta sin identificación propia usa la de la empresa', () => {
  /**
   * Es lo que hace que un ISP nuevo solo cargue sus cuentas: el nombre y la
   * cédula del titular ya están en su ficha fiscal, y pedirle que los repita
   * cuenta por cuenta es pedirle que se equivoque en una de ellas.
   */
  const d = armar({
    abonado: ABONADO,
    config: CONFIG,
    cuentas: [
      { nombre: 'Pichincha', tipo: 'banco', numero: '2202723021', activa: true, mostrar_en_corte: true },
    ],
    empresa: EMPRESA,
  })

  assert.equal(d.cuentas[0].titular, 'JOSE LUIS OÑA RIERA')
  assert.equal(d.cuentas[0].identificacion, '0504056151')
})

test('la identificación cargada a mano le gana a la de la empresa', () => {
  // Una cuenta puede estar a nombre de un socio o de otra razón social.
  const d = armado()
  assert.equal(d.cuentas[0].identificacion, '1712345678')
})

test('sin WhatsApp propio se usa el teléfono de la empresa', () => {
  // Mejor que un abonado que pagó escriba al número de ventas a que no tenga a
  // dónde escribir y vuelva a llamar por teléfono.
  const d = armar({
    abonado: ABONADO,
    config: { ...CONFIG, whatsapp_pagos: null },
    cuentas: CUENTAS,
    empresa: EMPRESA,
  })
  assert.equal(d.whatsapp, '593981864229')
})

test('sin datos de empresa la página no revienta', () => {
  // Es el estado del día uno de una instalación nueva.
  const d = armar({ abonado: ABONADO, config: {}, cuentas: [], empresa: {} })
  assert.equal(d.cuentas.length, 0)
  assert.equal(d.whatsapp, null)
  assert.match(html(d), /suspendido/i)
})

// --- El texto sale del editor de plantillas ---------------------------------

test('los marcadores de la plantilla se reemplazan con los datos del abonado', () => {
  /**
   * El título y el mensaje salen de Ajustes → Plantillas → Aviso de corte, así
   * que pueden traer `{{nombre}}` o `{{saldo}}`. Sin reemplazarlos, el abonado
   * leería esas llaves tal cual.
   *
   * Es el error que nadie ve al escribir la plantilla, justamente porque en la
   * vista previa del editor sí se reemplazan.
   */
  const d = armado({
    config: {
      ...CONFIG,
      titulo: 'Hola {{primer_nombre}}, tu servicio está suspendido',
      mensaje: 'Debés {{saldo}} de tu plan {{plan}}. Escribinos al {{telefono}}.',
    },
  })

  assert.equal(d.titulo, 'Hola OÑA, tu servicio está suspendido')
  assert.equal(d.mensaje, 'Debés $40.18 de tu plan PLAN_HOME. Escribinos al 0981864229.')
  assert.ok(!/\{\{/.test(html(d)), 'no puede quedar ningún marcador crudo en la página')
})

test('un marcador que no existe queda a la vista y no rompe', () => {
  // Se prefiere que salga visible a que desaparezca: un hueco silencioso se
  // publica y nadie lo nota; "{{descuento}}" en la pantalla se corrige el
  // primer día.
  const d = armado({ config: { ...CONFIG, mensaje: 'Debés {{saldo}} y {{descuento}}' } })
  assert.equal(d.mensaje, 'Debés $40.18 y {{descuento}}')
})

// --- El HTML ----------------------------------------------------------------

test('la página no depende de nada externo', () => {
  /**
   * El que la mira está CORTADO: su navegador no puede bajar nada. Un `<link>` a
   * una hoja de estilos se quedaría cargando y la página se vería rota justo
   * cuando tiene que verse clara.
   */
  const pagina = html(armado())
  assert.ok(!/<link[^>]+href=/i.test(pagina), 'no puede haber hojas de estilo externas')
  assert.ok(!/<script[^>]+src=/i.test(pagina), 'no puede haber scripts externos')
  assert.ok(!/https?:\/\/(?!wa\.me)/.test(pagina), 'el único enlace externo puede ser el de WhatsApp')
})

test('el monto y el número de cuenta están en la página', () => {
  const pagina = html(armado())
  assert.match(pagina, /\$40\.18/)
  assert.match(pagina, /2202723021/)
  assert.match(pagina, /wa\.me\/593981864229/)
})

test('el mensaje de WhatsApp se manda listo, con el nombre y el código', () => {
  // Que el abonado no tenga que explicar quién es: el que recibe el comprobante
  // necesita identificarlo para reactivar, y "ya pagué" a secas no alcanza.
  const pagina = html(armado())
  assert.match(pagina, /c%C3%B3digo%2042/)
})

test('los nombres con comillas no rompen la página', () => {
  const pagina = html(armado({ abonado: { ...ABONADO, nombre: 'CASA "LA ESPERANZA" & CÍA' } }))
  assert.match(pagina, /CASA &quot;LA ESPERANZA&quot; &amp; C/)
})

test('sin cuentas publicadas la página sigue sirviendo', () => {
  // Es el estado del día uno, antes de que alguien marque una cuenta. Tiene que
  // decir por qué está cortado igual, que ya es más de lo que hay hoy.
  const pagina = html(armar({ abonado: ABONADO, config: CONFIG, cuentas: [], empresa: EMPRESA }))
  assert.match(pagina, /suspendido/i)
  assert.ok(!/Dónde depositar/.test(pagina))
})

// --- De quién es la conexión ------------------------------------------------

test('la IP sale del socket y no de una cabecera', () => {
  /**
   * `X-Forwarded-For` acá la manda el propio abonado —no hay ningún proxy
   * nuestro en el medio—, así que confiar en ella dejaría que cualquiera viera
   * el saldo y el nombre de otro con solo escribir una cabecera.
   */
  const req = {
    socket: { remoteAddress: '172.16.11.133' },
    headers: { 'x-forwarded-for': '10.0.0.1' },
  }
  assert.equal(ipDelPedido(req), '172.16.11.133')
})

test('las IPv4 mapeadas a IPv6 se limpian', () => {
  // Node las devuelve así, y "::ffff:172.16.1.5" no empareja con ninguna ficha.
  assert.equal(ipDelPedido({ socket: { remoteAddress: '::ffff:172.16.1.5' } }), '172.16.1.5')
})

// --- El aviso previo, que es otra situación ---------------------------------

const PREVIO = { ...ABONADO, estado: 'activo', en_aviso_previo: true, saldo: 20.09 }

test('al que todavía tiene servicio no se le dice que está suspendido', () => {
  /**
   * Está leyendo la página CON SU PROPIA CONEXIÓN. Decirle "tu servicio está
   * suspendido" es una mentira que se nota en el acto, y a partir de ahí no
   * cree nada más de lo que diga la página — ni el monto ni la cuenta.
   */
  const d = armar({ abonado: PREVIO, config: CONFIG, cuentas: CUENTAS, empresa: EMPRESA })

  assert.equal(d.motivo, 'aviso')
  assert.ok(!/suspendido/i.test(d.titulo), `el título dice "${d.titulo}"`)
  assert.ok(!/suspendido/i.test(d.mensaje))
})

test('el aviso previo usa su propia plantilla', () => {
  const d = armar({
    abonado: PREVIO,
    config: {
      ...CONFIG,
      titulo_aviso: 'Tu factura vence pronto',
      mensaje_aviso: 'Tenés {{saldo}} por pagar antes del vencimiento.',
    },
    cuentas: CUENTAS,
    empresa: EMPRESA,
  })

  assert.equal(d.titulo, 'Tu factura vence pronto')
  assert.match(d.mensaje, /\$20\.09 por pagar/)
})

test('el aviso previo sí muestra el monto y las cuentas', () => {
  // Es de lo que se trata: que sepa cuánto y dónde, antes de quedarse sin nada.
  const d = armar({ abonado: PREVIO, config: CONFIG, cuentas: CUENTAS, empresa: EMPRESA })
  assert.equal(d.saldo, 20.09)
  assert.ok(d.cuentas.length > 0)
})

test('el pie de la página no contradice a la situación', () => {
  const previo = html(armar({ abonado: PREVIO, config: CONFIG, cuentas: CUENTAS, empresa: EMPRESA }))
  assert.match(previo, /factura por vencer/)
  assert.ok(!/porque tu servicio está suspendido/.test(previo))

  const cortado = html(armado())
  assert.match(cortado, /porque tu servicio está suspendido/)
})

test('el cortado nunca ve la pantalla de aviso previo', () => {
  /**
   * Si quedara en las dos listas del router, la primera regla que coincida
   * decide qué página ve. Que la ficha diga "está cortado" tiene que ganarle
   * siempre a la ventana de aviso.
   */
  const d = armar({
    abonado: { ...ABONADO, estado: 'cortado', en_aviso_previo: true },
    config: CONFIG,
    cuentas: CUENTAS,
    empresa: EMPRESA,
  })
  assert.equal(d.motivo, 'mora')
  assert.match(d.titulo, /suspendido/i)
})
