import { Router } from 'express'

import { asyncHandler } from '../lib/errors.js'
import { requireApiKey } from '../lib/apiKey.js'
import { freno } from '../lib/frenoApi.js'
import {
  cambiarWifi,
  consultarComprobante,
  crearTicket,
  diagnosticoDe,
  estadoDeCuenta,
  facturasDe,
  registrarPago,
  reiniciarEquipoDe,
} from '../services/integracion.js'

/**
 * La API para sistemas externos: el CRM y el bot de WhatsApp.
 *
 * ── Por qué está separada de todo lo demás ──
 *
 * Porque quien llama es un programa de otra empresa. Eso cambia tres cosas:
 *
 * 1. La autenticación. Llave de API, no sesión de una persona (`requireApiKey`).
 * 2. Lo que se devuelve. Cada campo de acá va a terminar escrito en un chat de
 *    WhatsApp: no salen IPs, ni claves PPPoE, ni el serial completo del equipo.
 * 3. El contrato. Una ruta de la app se puede cambiar y se arregla el frontend
 *    en el mismo commit. Estas no: del otro lado hay un proveedor que despliega
 *    cuando puede. Lo que se agrega, se agrega; lo que se saca, rompe.
 *
 * Cada ruta pide su permiso por separado. Una llave que solo consulta deuda no
 * puede abrir tickets ni tocar el WiFi de nadie — y esa es toda la diferencia
 * entre una llave filtrada que expone saldos y una que reconfigura la red.
 */

const router = Router()

/**
 * Los cupos por minuto y por llave.
 *
 * Comparten contador con `/api/v1` (ver `lib/frenoApi.js`): es la misma llave y
 * el mismo bot, así que gastar el cupo en una superficie tiene que gastarlo en
 * la otra. Si fueran contadores separados, el límite se duplicaría solo con
 * alternar entre las dos rutas.
 */
const limitar = freno('v1', 120)
const frenoProfundo = freno(
  'v1-equipos',
  6,
  'Usá GET /diagnostico/:cedula, que no toca los equipos y no tiene este freno.',
)

/** Health check de la integración: sirve para que el proveedor pruebe su llave. */
router.get(
  '/ping',
  requireApiKey(),
  asyncHandler(async (req, res) => {
    res.json({
      ok: true,
      llave: req.llave.nombre,
      permisos: req.llave.permisos ?? [],
      // Para que el proveedor sepa qué esperar al registrar un pago sin tener
      // que probarlo con plata de verdad.
      pagos: req.llave.confirma_pagos ? 'se acreditan al instante' : 'quedan a verificar',
    })
  }),
)

// --- Consultar ---------------------------------------------------------------

/**
 * El estado del abonado: servicio, deuda, fecha de corte y promesa vigente.
 *
 * Es lo primero que pide el bot cuando alguien escribe "no tengo internet".
 */
router.get(
  '/clientes/:identificacion',
  requireApiKey('clientes.ver'),
  limitar,
  asyncHandler(async (req, res) => {
    res.json(await estadoDeCuenta(req.params.identificacion))
  }),
)

/**
 * Las facturas por cédula.
 *
 * Por defecto solo las que tienen saldo: es lo que contesta "¿cuánto debo?".
 * Con `?estado=todas` viene el historial, para el que pide su comprobante del
 * mes pasado.
 */
router.get(
  '/facturas/:identificacion',
  requireApiKey('facturacion.ver'),
  limitar,
  asyncHandler(async (req, res) => {
    res.json(
      await facturasDe(req.params.identificacion, {
        estado: req.query.estado === 'todas' ? 'todas' : 'pendiente',
      }),
    )
  }),
)

// --- Registrar un pago --------------------------------------------------------

/**
 * Registra un pago.
 *
 * Qué pasa con él lo decide la LLAVE, no este pedido: la del webhook de la
 * pasarela acredita en el acto, la del bot lo deja a verificar. Ver
 * `registrarPago` en el servicio.
 *
 * Cuerpo:
 *   identificacion      cédula o RUC del abonado          (obligatorio)
 *   monto               número mayor que cero             (obligatorio)
 *   forma_pago          efectivo | transferencia | deposito | tarjeta | otro
 *   fecha_pago          AAAA-MM-DD (por defecto, hoy)
 *   n_transaccion       el número del comprobante del banco
 *   referencia_externa  la clave del CRM. MANDALA: es lo que evita el duplicado
 *   comprobante_url     a dónde quedó la captura que mandó el abonado
 *   notas               texto libre
 *
 * Contesta 200 y `repetido: true` cuando la referencia ya estaba registrada. Es
 * a propósito y no un error: un reintento tiene que poder distinguirse de un
 * fracaso, y el CRM tiene que poder dejar de reintentar.
 */
router.post(
  '/pagos',
  requireApiKey('pagos.registrar'),
  limitar,
  asyncHandler(async (req, res) => {
    const r = await registrarPago(req.llave, req.body ?? {})
    res.status(r.repetido ? 200 : 201).json(r)
  }),
)

/**
 * ¿Este comprobante ya está registrado?
 *
 * La misma consulta que `/api/v1/pagos/comprobante`, sobre el mismo servicio.
 * Sirve para avisarle al abonado antes de que mande el comprobante dos veces.
 */
router.get(
  '/pagos/comprobante',
  requireApiKey('pagos.registrar'),
  limitar,
  asyncHandler(async (req, res) => {
    res.json(await consultarComprobante({ ...req.query }))
  }),
)

// --- Diagnóstico de red -------------------------------------------------------

/**
 * "¿Por qué no tengo internet?", contestado.
 *
 * Devuelve una CONCLUSIÓN, no mediciones: `resultado` dice qué pasa, `mensaje`
 * es el texto que se le puede leer al abonado tal cual, y `abrir_ticket` dice si
 * corresponde escalarlo o no. Ver `services/diagnostico.js` para el orden en que
 * se descarta cada cosa y por qué.
 *
 * Resultados posibles:
 *   averia_zona      hay un corte conocido en su sector → informar, sin ticket
 *   corte_por_deuda  está suspendido → cobrar
 *   sin_fibra        la ONT no ve señal óptica → revisar el cable de la casa
 *   equipo_apagado   la ONT no reporta → revisar corriente
 *   senal_baja       conectado pero con potencia mala → visita técnica
 *   sin_respuesta    en línea y no contesta → reiniciar
 *   todo_ok          de nuestro lado está bien → probar el WiFi del abonado
 *   sin_datos        no hay con qué revisarlo → escalar
 *
 * Este es el rápido: no toca ningún equipo y contesta casi todos los casos.
 */
router.get(
  '/diagnostico/:identificacion',
  requireApiKey('red.diagnostico'),
  limitar,
  asyncHandler(async (req, res) => {
    res.json(await diagnosticoDe(req.params.identificacion))
  }),
)

/**
 * El diagnóstico profundo: le pregunta a la OLT y pinguea desde el router.
 *
 * Tarda segundos y consume una de las pocas sesiones SSH que admite una OLT.
 * Va como POST y con su propio freno —seis por minuto por llave— porque
 * llamarlo en cada mensaje de WhatsApp dejaría al técnico sin poder entrar al
 * equipo justo cuando está atendiendo el corte.
 *
 * Usalo cuando el rápido devolvió `todo_ok` y el abonado insiste.
 */
router.post(
  '/diagnostico/:identificacion',
  requireApiKey('red.diagnostico'),
  limitar,
  frenoProfundo,
  asyncHandler(async (req, res) => {
    res.json(await diagnosticoDe(req.params.identificacion, { profundo: true }))
  }),
)

/**
 * Reinicia la ONT del abonado.
 *
 * Es la acción que más llamadas resuelve, y la que el abonado ya hace igual
 * —peor— desenchufando el equipo. El objetivo sale de su ficha: nunca de lo que
 * mande quien llama.
 */
router.post(
  '/reiniciar-equipo',
  requireApiKey('red.diagnostico'),
  limitar,
  frenoProfundo,
  asyncHandler(async (req, res) => {
    res.json(await reiniciarEquipoDe(req.body?.identificacion))
  }),
)

// --- Soporte -----------------------------------------------------------------

/**
 * Cambio de clave o de nombre del WiFi.
 *
 * La respuesta dice si se aplicó en el equipo o si quedó pedido. El bot tiene
 * que decir cuál de las dos: prometerle al abonado que ya está y que su WiFi
 * siga con la clave vieja es peor que decirle que va a demorar.
 */
router.post(
  '/wifi',
  requireApiKey('red.wifi'),
  limitar,
  asyncHandler(async (req, res) => {
    const { identificacion, ssid, clave } = req.body ?? {}
    res.json(await cambiarWifi(identificacion, { ssid, clave }))
  }),
)

/**
 * Abre un reclamo.
 *
 * `tipo`: sin_internet | lento | intermitente | cambio_clave | otro.
 * Si el abonado ya tiene uno abierto del mismo tipo, contesta 400 con el número
 * del que ya existe — así el bot le dice "ya lo estamos viendo, es el N° 412"
 * en vez de abrir el quinto ticket por lo mismo.
 */
router.post(
  '/tickets',
  requireApiKey('soporte.crear'),
  limitar,
  asyncHandler(async (req, res) => {
    const { identificacion, tipo, descripcion } = req.body ?? {}
    res.status(201).json(await crearTicket(identificacion, { tipo, descripcion }))
  }),
)

export default router
