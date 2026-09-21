import { Router } from 'express'

import { AppError, asyncHandler } from '../lib/errors.js'
import { requireApiKey } from '../lib/apiKey.js'
import { freno } from '../lib/frenoApi.js'
import { db } from '../lib/db.js'
import {
  cambiarWifi,
  clientePor,
  consultarComprobante,
  crearTicket,
  registrarPago,
} from '../services/integracion.js'
import { diagnosticar } from '../services/diagnostico.js'
import { incidenciaActivaDe } from '../services/incidencias.js'
import { misFacturas } from '../services/portal.js'
import { agendarInstalacion, catalogoPlanes, validarCobertura } from '../services/ventasBot.js'

/**
 * `/api/v1` — el contrato que consume el agente de IA del CRM.
 *
 * ── Por qué existe además de `/api/integracion` ──
 *
 * Porque del otro lado hay un LLM llamando funciones, y eso cambia las reglas
 * de un contrato:
 *
 * 1. **La forma de la respuesta es parte del contrato.** El agente ramifica por
 *    `status` y por `code`, no por el texto. Un mensaje se puede reescribir el
 *    día que alguien lo lea y no lo entienda; un código no.
 * 2. **`message` se le lee al usuario tal cual.** No es un log: es lo que el bot
 *    va a decir por WhatsApp. Por eso ningún error de acá dice "constraint
 *    violation" ni nombra una tabla.
 * 3. **Es de otra empresa y despliega cuando puede.** Lo que se agrega, se
 *    agrega; lo que se saca, rompe. `/api/integracion` sigue existiendo para lo
 *    que no está en este contrato, y las dos usan los mismos servicios: no hay
 *    dos implementaciones de "cuánto debe este abonado".
 *
 * ── Lo que deliberadamente NO se devuelve ──
 *
 * La IP del abonado. La especificación la pedía en `consultar-deuda` y no va:
 * no le sirve a quien pregunta por su factura, y sí le sirve a quien quiere
 * hacerse pasar por él. Si el ISP la necesita para algo concreto, se agrega con
 * su propio permiso y sabiendo para qué.
 */

const router = Router()

// El cupo general y el de las operaciones que tocan equipos. El segundo es
// chico a propósito: una OLT admite tres sesiones SSH y el técnico necesita una
// justo cuando está atendiendo un corte.
const frenoGeneral = freno('v1', 120)
const frenoEquipos = freno(
  'v1-equipos',
  6,
  'Usá GET /api/v1/cliente/consultar-deuda o el diagnóstico rápido, que no tocan los equipos.',
)

/** La respuesta exitosa, siempre con el mismo sobre. */
const ok = (res, datos, status = 200) => res.status(status).json({ status: 'success', ...datos })

/**
 * Cómo se ve el estado del servicio desde afuera.
 *
 * Se traduce a un vocabulario estable en MAYÚSCULAS porque es lo que el agente
 * compara. `cortado` es nuestro nombre interno y podría cambiar; lo que el CRM
 * lee no.
 */
const ESTADO_SERVICIO = {
  activo: 'ACTIVO',
  cortado: 'SUSPENDIDO_POR_CORTE',
  suspendido: 'SUSPENDIDO',
  baja: 'DADO_DE_BAJA',
}

/** "Agosto 2026" a partir de una fecha. Es lo que el abonado reconoce. */
const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]
function mesDe(fecha) {
  if (!fecha) return null
  const d = new Date(`${String(fecha).slice(0, 10)}T12:00:00`)
  if (Number.isNaN(d.getTime())) return null
  return `${MESES[d.getMonth()]} ${d.getFullYear()}`
}

/** Quién es el abonado, con las tres formas de decirlo que usa el CRM. */
/**
 * De quién habla el pedido.
 *
 * Los mismos tres datos se aceptan por query y por cuerpo, y la cédula además
 * bajo los tres nombres con que la llaman los CRM: `cedula`, `documento` e
 * `identificacion`. No es indulgencia gratuita — un CRM que manda `documento=`
 * en la query recibe `FALTA_IDENTIFICADOR`, que suena a que el abonado no
 * existe, y el que integra termina buscando el problema en la base en vez de en
 * el nombre del parámetro.
 */
const aQuien = (req) => ({
  cedula:
    req.query.cedula ??
    req.query.documento ??
    req.query.identificacion ??
    req.body?.cedula ??
    req.body?.documento ??
    req.body?.identificacion,
  telefono: req.query.telefono ?? req.body?.telefono,
  cliente_id: req.query.cliente_id ?? req.body?.cliente_id,
})

// =============================================================================
// MÓDULO 1 — Pagos y facturación
// =============================================================================

/**
 * 1. Consulta de deuda.
 *
 * Acepta `cedula`, `telefono` o `cliente_id`. El teléfono es el que un bot de
 * WhatsApp tiene primero, y es también el menos confiable: si el número está en
 * la ficha de dos abonados, se contesta `TELEFONO_AMBIGUO` en vez de elegir uno.
 * Mostrar la deuda del vecino porque comparten el celular de la casa es una
 * falla de privacidad, no una comodidad.
 */
router.get(
  '/cliente/consultar-deuda',
  // Cualquiera de los dos: devuelve el estado del abonado Y sus facturas, así
  // que quien puede ver abonados y quien puede ver facturación tienen los dos
  // motivo para llamarla. Con solo `clientes.ver`, una llave sacada de un
  // cobrador —que tiene `facturacion.ver`— no podía ni consultar la deuda.
  requireApiKey(['clientes.ver', 'facturacion.ver']),
  frenoGeneral,
  asyncHandler(async (req, res) => {
    const cliente = await clientePor(aQuien(req))

    const [facturas, incidencia] = await Promise.all([
      misFacturas(cliente.id),
      incidenciaActivaDe(cliente.id).catch(() => null),
    ])

    const pendientes = facturas.filter((f) => f.estado !== 'pagada')

    ok(res, {
      cliente: {
        id: cliente.id,
        nombre: cliente.nombre,
        cedula: cliente.identificacion,
        estado_servicio: ESTADO_SERVICIO[cliente.estado] ?? cliente.estado?.toUpperCase(),
        codigo_pago: cliente.codigo_pago,
      },
      deuda_total: Number(pendientes.reduce((s, f) => s + f.pendiente, 0).toFixed(2)),
      facturas_pendientes: pendientes.map((f) => ({
        factura_id: f.id,
        numero: f.numero,
        mes: mesDe(f.periodo ?? f.emision),
        // `monto` es lo que FALTA, no el total de la factura. Un abono parcial
        // hace que sean distintos, y decirle al abonado el total lo hace pagar
        // de nuevo lo que ya entregó.
        monto: f.pendiente,
        total_factura: f.total,
        fecha_vencimiento: f.vencimiento,
        estado: f.estado,
      })),
      /**
       * La avería conocida, si la hay.
       *
       * No estaba en la especificación y va igual: es lo único de toda esta API
       * cuyo propósito es que el bot DEJE de hacer cosas. Cuando viene, la
       * respuesta correcta es leerle `mensaje` y cerrar la conversación.
       */
      falla_masiva_sector: Boolean(incidencia),
      incidencia: incidencia ?? null,
    })
  }),
)

/**
 * 2. Registro y validación de pago.
 *
 * ── En qué se aparta de la especificación, y por qué ──
 *
 * La spec decía que este endpoint dispara el desbloqueo en el MikroTik y
 * contesta "servicio restablecido". Acá eso pasa solo cuando el pago está
 * CONFIRMADO, y quién puede confirmar lo decide la llave (`confirma_pagos`),
 * no el pedido.
 *
 * `verificado_por` solo puede BAJAR esa confianza: `ocr_only` —una imagen leída
 * por el bot— queda a verificar aunque la llave acredite sola. Si pudiera
 * subirla, alcanzaría con mandar `"human"` para saltarse la verificación, y
 * entonces la verificación no existiría.
 *
 * El bot puede decirle al cliente "recibimos tu pago" en los dos casos. Lo que
 * no puede decir es "ya está acreditado" cuando no lo está: eso genera el
 * reclamo del día siguiente, cuando sigue cortado.
 */
router.post(
  '/pagos/registrar',
  requireApiKey('pagos.registrar'),
  frenoGeneral,
  asyncHandler(async (req, res) => {
    const r = await registrarPago(req.llave, req.body ?? {})

    // Lo que le queda debiendo DESPUÉS de este pago. Es el número con el que el
    // bot cierra la conversación, y calcularlo del lado del CRM lo obligaría a
    // restar a mano contra la consulta anterior —que ya quedó vieja—.
    const cliente = await clientePor({
      cedula: req.body?.identificacion ?? req.body?.cedula ?? req.body?.documento,
      telefono: req.body?.telefono,
      cliente_id: req.body?.cliente_id,
    }).catch(() => null)

    let saldo = null
    if (cliente) {
      const { data } = await db()
        .from('v_saldo_clientes')
        .select('saldo')
        .eq('client_id', cliente.id)
        .maybeSingle()
      saldo = Number(data?.saldo ?? 0)
    }

    const acreditado = r.estado === 'confirmado'

    ok(
      res,
      {
        /**
         * El texto que el bot le muestra al abonado.
         *
         * ── Por qué el repetido tiene el suyo ──
         *
         * `repetido` ya distingue los dos casos para el programa, pero el
         * `mensaje` decía lo mismo en ambos: "recibimos tu pago". Quien lo
         * mostrara tal cual le estaría diciendo al abonado que acaba de
         * registrar algo que ya estaba, y al que mandó el comprobante dos veces
         * lo dejaría creyendo que pagó dos.
         */
        mensaje: r.repetido
          ? acreditado
            ? 'Este comprobante ya estaba registrado y acreditado. No se duplicó el pago.'
            : 'Este comprobante ya lo habíamos recibido y lo estamos validando. No se duplicó el pago.'
          : acreditado
            ? r.reactivacion?.ok
              ? 'Pago registrado y servicio restablecido.'
              : 'Pago registrado y acreditado.'
            : 'Recibimos tu pago. Lo estamos validando y se acredita en cuanto se confirme.',
        transaccion_id: r.reporte_id ? `REP-${String(r.reporte_id).slice(0, 8)}` : null,
        // Los identificadores de verdad, para conciliar del lado del CRM.
        reporte_id: r.reporte_id,
        pago_id: r.pago_id ?? null,
        acreditado,
        estado: r.estado,
        // Sin duplicar: `true` cuando ese comprobante ya estaba registrado.
        repetido: Boolean(r.repetido),
        ...(r.motivo_pendiente ? { motivo_pendiente: r.motivo_pendiente } : {}),
        saldo_restante: saldo,
        ...(r.facturas_saldadas ? { facturas_saldadas: r.facturas_saldadas } : {}),
        ...(r.saldo_a_favor ? { saldo_a_favor: r.saldo_a_favor } : {}),
        // A qué cuenta entró, ya resuelta. Le sirve al CRM para confirmar que
        // el número que leyó del comprobante se interpretó como esperaba.
        ...(r.cuenta ? { cuenta: r.cuenta } : {}),
        ...(r.reactivacion ? { reactivacion: r.reactivacion } : {}),
      },
      r.repetido ? 200 : 201,
    )
  }),
)

/**
 * 2b. ¿Este comprobante ya está registrado?
 *
 * Se pregunta ANTES de registrar, para poder decírselo al abonado en pantalla.
 * No crea nada.
 *
 * Query: `hash_qr`, `uuid_transaccion` o `num_comprobante` (al menos uno).
 * Opcionalmente `cedula` / `cliente_id` / `telefono` para saber si el
 * comprobante es de ESE abonado o de otro.
 *
 * `mensaje` viene listo para mostrar. Los tres campos que decidan el flujo:
 *
 *   registrado        si ya lo tenemos
 *   puede_reenviar    solo `true` cuando fue rechazado y conviene otra foto
 *   del_mismo_abonado `false` = es de otro. No se dice de quién, a propósito
 */
router.get(
  '/pagos/comprobante',
  requireApiKey('pagos.registrar'),
  frenoGeneral,
  asyncHandler(async (req, res) => {
    ok(res, await consultarComprobante({ ...req.query }))
  }),
)

// =============================================================================
// MÓDULO 2 — Ventas y captación
// =============================================================================

/** 3. ¿Llegamos a estas coordenadas? */
router.post(
  '/ventas/validar-cobertura',
  requireApiKey('ventas.cobertura'),
  frenoGeneral,
  asyncHandler(async (req, res) => {
    ok(res, await validarCobertura(req.body ?? {}))
  }),
)

/** 4. Los planes que se pueden ofrecer. */
router.get(
  '/ventas/planes',
  requireApiKey('ventas.planes'),
  frenoGeneral,
  asyncHandler(async (req, res) => {
    ok(res, { planes: await catalogoPlanes({ categoria: req.query.categoria ?? null }) })
  }),
)

/**
 * 5. Agendar la instalación.
 *
 * Crea una ORDEN, no un abonado: la ficha se crea cuando el técnico instala.
 * Ver `agendarInstalacion` — un padrón lleno de gente que nunca se instaló
 * aparece en la cartera, en las estadísticas y en la facturación mensual.
 */
router.post(
  '/ventas/agendar-instalacion',
  requireApiKey('ventas.solicitudes'),
  frenoGeneral,
  asyncHandler(async (req, res) => {
    const r = await agendarInstalacion(req.body ?? {})
    ok(res, r, r.repetido ? 200 : 201)
  }),
)

// =============================================================================
// MÓDULO 3 — Soporte técnico y autogestión
// =============================================================================

/**
 * El vocabulario de incidencias del CRM traducido al nuestro.
 *
 * Ellos mandan `SIN_SERVICIO_LUZ_ROJA`, que es más específico que nuestros
 * cinco tipos. Lo específico no se pierde: va en la descripción del ticket, que
 * es lo que lee el técnico antes de salir. El tipo sirve para enrutar y para no
 * duplicar reclamos, y para eso cinco categorías alcanzan.
 */
function tipoDeIncidencia(crudo) {
  const t = String(crudo ?? '').toUpperCase()
  if (/SIN_SERVICIO|SIN_INTERNET|LOS|CAIDO|ROJA/.test(t)) return 'sin_internet'
  if (/LENT|VELOCIDAD/.test(t)) return 'lento'
  if (/INTERMIT|CORTE|INESTABLE/.test(t)) return 'intermitente'
  if (/CLAVE|WIFI|CONTRASE/.test(t)) return 'cambio_clave'
  return 'otro'
}

/**
 * 6. Crear ticket de incidencia.
 *
 * Contesta 409 —y NO abre el ticket— si hay una avería masiva conocida que
 * explica lo que el abonado reporta. Es lo que evita que un corte de fibra
 * genere ciento ochenta tickets por la misma causa, cada uno mandando un
 * técnico a una casa donde no hay nada que arreglar.
 */
router.post(
  '/soporte/crear-ticket',
  requireApiKey('soporte.crear'),
  frenoGeneral,
  asyncHandler(async (req, res) => {
    const b = req.body ?? {}
    const cliente = await clientePor(aQuien(req))

    const detalle = [
      String(b.descripcion_bot ?? b.descripcion ?? '').trim(),
      // El tipo crudo del CRM queda escrito: "SIN_SERVICIO_LUZ_ROJA" le dice al
      // técnico qué llevar, y nuestro `sin_internet` no.
      b.tipo_incidencia ? `[${b.tipo_incidencia}]` : null,
      b.adjunto_url ? `Foto: ${b.adjunto_url}` : null,
      b.prioridad ? `Prioridad indicada: ${b.prioridad}` : null,
    ]
      .filter(Boolean)
      .join(' · ')

    const r = await crearTicket(cliente.identificacion, {
      tipo: tipoDeIncidencia(b.tipo_incidencia),
      descripcion: detalle || 'Reportado desde el bot, sin detalle.',
    })

    ok(
      res,
      {
        ticket_id: `TK-${r.ticket.numero}`,
        ticket_uuid: r.ticket.id,
        mensaje: 'Ticket creado exitosamente y asignado a cuadrilla técnica.',
      },
      201,
    )
  }),
)

/**
 * 7. Diagnóstico en vivo de la ONT.
 *
 * Por omisión NO toca los equipos: usa lo que la base ya sabe, que contesta
 * casi todos los casos y no consume sesiones de la OLT. Con `?en_vivo=1` abre
 * SSH contra la OLT y pinguea desde el router — ahí el cupo baja a 6 por minuto.
 *
 * `falla_masiva_sector` es lo primero que se evalúa: si hay un corte conocido,
 * medirle la potencia a esa ONT es gastar una sesión para enterarse de lo que
 * ya se sabía.
 */
router.get(
  '/red/diagnostico-ont',
  requireApiKey('red.diagnostico'),
  frenoGeneral,
  asyncHandler(async (req, res, next) => {
    const enVivo = req.query.en_vivo === '1' || req.query.en_vivo === 'true'
    if (!enVivo) return responderDiagnostico(req, res, false)

    // El cupo chico se gasta SOLO cuando de verdad se va a abrir una sesión
    // contra la OLT. Cobrárselo también al diagnóstico rápido dejaría al bot
    // sin poder contestar seis consultas por minuto sin tocar nada.
    return frenoEquipos(req, res, () => {
      responderDiagnostico(req, res, true).catch(next)
    })
  }),
)

async function responderDiagnostico(req, res, enVivo) {
  const cliente = await clientePor(aQuien(req))
  const d = await diagnosticar(cliente.id, { profundo: enVivo })

  const senal = d.senal ?? null
  const ont = d.pasos?.find((p) => p.paso === 'ont') ?? null

  return ok(res, {
    cliente_id: cliente.id,
    estado_ont:
      d.resultado === 'sin_fibra'
        ? 'LOS'
        : d.resultado === 'equipo_apagado'
          ? 'OFFLINE'
          : ont?.estado
            ? String(ont.estado).toUpperCase()
            : 'DESCONOCIDO',
    potencia_rx: senal?.dbm != null ? `${senal.dbm} dBm` : null,
    potencia_rx_valor: senal?.dbm ?? null,
    es_potencia_optima: senal ? senal.nivel === 'buena' : null,
    falla_masiva_sector: d.resultado === 'averia_zona',
    // La conclusión, que es lo que el bot necesita para saber qué contestar y
    // si corresponde escalar. Ver `services/diagnostico.js`.
    resultado: d.resultado,
    mensaje: d.mensaje,
    accion_sugerida: d.accion,
    abrir_ticket: d.abrir_ticket,
    ...(d.incidencia ? { incidencia: d.incidencia } : {}),
    en_vivo: enVivo,
  })
}

/** 8. Cambiar las credenciales del WiFi. */
router.post(
  '/red/cambiar-wifi',
  requireApiKey('red.wifi'),
  frenoGeneral,
  frenoEquipos,
  asyncHandler(async (req, res) => {
    const b = req.body ?? {}
    const cliente = await clientePor(aQuien(req))

    const r = await cambiarWifi(cliente.identificacion, {
      ssid: b.nuevo_ssid ?? b.ssid,
      clave: b.nueva_clave ?? b.clave,
    })

    /**
     * La respuesta distingue aplicado de pedido, y el bot tiene que distinguirlo
     * también.
     *
     * Decirle "listo" a alguien cuyo WiFi sigue con la clave vieja es peor que
     * decirle que va a demorar: se queda intentando conectarse con la nueva.
     */
    const aplicado = r.estado === 'aplicada'

    ok(res, {
      aplicado,
      mensaje: aplicado
        ? 'Credenciales Wi-Fi actualizadas en el equipo remoto.'
        : 'El cambio quedó registrado y se aplica en cuanto el equipo se reporte. Por ahora seguí usando tu clave anterior.',
      ...r,
    })
  }),
)

// =============================================================================
// El sobre de error
// =============================================================================
/**
 * Todo error de `/api/v1` sale con la misma forma.
 *
 * ── Por qué un manejador propio y no el general ──
 *
 * Porque este contrato lo consume un LLM que ramifica por `code`. El manejador
 * general del servidor contesta `{ error, hint }`, que es lo que la app propia
 * entiende; cambiarlo para todos rompería la app para arreglar la integración.
 *
 * `message` se le lee al usuario final tal cual, así que un error de 500 no
 * cuenta lo que pasó por dentro: un mensaje de Postgres en un chat de WhatsApp
 * no ayuda a nadie y le dice a cualquiera cómo está armada la base.
 */
const CODIGO_POR_STATUS = {
  400: 'DATOS_INVALIDOS',
  401: 'NO_AUTORIZADO',
  403: 'SIN_PERMISO',
  404: 'NO_ENCONTRADO',
  409: 'CONFLICTO',
  429: 'LIMITE_EXCEDIDO',
}

// eslint-disable-next-line no-unused-vars -- Express identifica el handler por los 4 argumentos
router.use((err, req, res, _next) => {
  const status = err instanceof AppError ? err.status : 500
  if (status >= 500) console.error('[v1]', err)

  res.locals.errorApi = (err.message || '').slice(0, 500) || null

  res.status(status).json({
    status: 'error',
    code: err.codigo ?? CODIGO_POR_STATUS[status] ?? 'ERROR_INTERNO',
    message:
      status >= 500
        ? 'Tuvimos un problema al procesar la consulta. Intentá de nuevo en un momento.'
        : err.message,
    ...(err.hint ? { hint: err.hint } : {}),
    // Lo que el error haya adjuntado y sirva del otro lado: la incidencia que
    // explica un 409, el id del reporte que quedó a medias.
    ...(err.extra ?? {}),
  })
})

export default router
