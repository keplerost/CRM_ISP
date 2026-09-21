import { Router } from 'express'
import { asyncHandler, badRequest, notFound, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { db } from '../lib/db.js'
import { encrypt, decrypt } from '../lib/crypto.js'
import { generarClaveAcceso } from '../sri/claveAcceso.js'
import { generarXmlFactura, calcularTotales, leerCamposAdicionales, IVA } from '../sri/facturaXml.js'
import { resumenCertificado } from '../sri/certificado.js'
import { firmarComprobante, verificarFirma } from '../sri/firmaXades.js'
import {
  enviarComprobante,
  consultarAutorizacion,
  desenvolverComprobante,
  resumirMensajes,
} from '../sri/sriSoap.js'
import {
  infoAdicionalDeFactura,
  partirEnCampos,
  PLANTILLA_POR_DEFECTO,
  VARIABLES,
} from '../sri/periodo.js'
import { generarRidePdf } from '../sri/ridePdf.js'
import {
  enviarComprobantePorEmail,
  crearTransporte,
  faltantesSmtp,
  remitente,
} from '../sri/email.js'
import { generarFacturas, estadoFacturacion } from '../services/facturacionMensual.js'

const router = Router()
router.use(requireAuth)

/** Campos con secretos: nunca salen del backend. */
const OCULTOS = ['certificado_b64', 'certificado_pass_encrypted', 'smtp_pass_encrypted']

/**
 * Columnas que se pueden escribir desde la UI.
 *
 * La configuración se devuelve con campos calculados —`tiene_certificado`,
 * `tiene_smtp`— y la página la manda entera de vuelta al guardar. Sin esta
 * lista esos campos viajan a Postgres como si fueran columnas y el guardado
 * falla con "Could not find the column in the schema cache".
 *
 * De paso, el certificado queda fuera: se sube por su propia ruta, que lo
 * valida antes de guardarlo.
 */
const COLUMNAS_CONFIG = [
  'ruc',
  'razon_social',
  'nombre_comercial',
  'dir_matriz',
  'dir_establecimiento',
  'contribuyente_especial',
  'obligado_contabilidad',
  'agente_retencion',
  'regimen_microempresas',
  'ambiente',
  'tipo_emision',
  'establecimiento',
  'punto_emision',
  'telefono',
  'email',
  'logo_b64',
  'plantilla_info_adicional',
  'dia_maximo_pago',
  'meses_desplazado',
  'smtp_host',
  'smtp_port',
  'smtp_secure',
  'smtp_user',
  'email_from',
  'email_from_name',
]

const sinSecretos = (config) => {
  if (!config) return null
  const limpio = { ...config }
  for (const campo of OCULTOS) delete limpio[campo]
  return {
    ...limpio,
    tiene_certificado: Boolean(config.certificado_b64),
    tiene_smtp: Boolean(config.smtp_pass_encrypted),
  }
}

async function cargarConfig() {
  const { data, error } = await db().from('sri_config').select('*').limit(1).maybeSingle()
  if (error) throw new AppError(`No se pudo leer la configuración: ${error.message}`, { status: 502 })
  return data
}

// --- Configuración del emisor -----------------------------------------------

/**
 * Último número de factura usado en el punto de emisión configurado.
 *
 * Cada combinación (tipo, establecimiento, punto) lleva su propia numeración.
 * Se muestra en la configuración porque un punto que ya venía facturando con
 * otro sistema tiene que seguir desde donde quedó: repetir un número que el SRI
 * ya autorizó hace que rechace el comprobante.
 */
async function ultimoSecuencial(config) {
  const { data } = await db()
    .from('sri_sequences')
    .select('ultimo_numero')
    .eq('tipo_doc', '01')
    .eq('establecimiento', config.establecimiento ?? '001')
    .eq('punto_emision', config.punto_emision ?? '001')
    .maybeSingle()

  return Number(data?.ultimo_numero ?? 0)
}

router.get(
  '/config',
  asyncHandler(async (_req, res) => {
    const config = await cargarConfig()
    if (!config) return res.json(null)

    res.json({
      ...sinSecretos(config),
      proximo_secuencial: (await ultimoSecuencial(config)) + 1,
    })
  }),
)

/**
 * Guarda la configuración. Es una sola fila: si existe se actualiza.
 * Las contraseñas llegan en claro y se guardan cifradas — igual que las de los
 * equipos de red.
 */
router.put(
  '/config',
  asyncHandler(async (req, res) => {
    const { certificado_pass, smtp_pass, proximo_secuencial, ...datos } = req.body ?? {}

    if (datos.ruc && !/^\d{13}$/.test(datos.ruc)) {
      throw badRequest('El RUC del emisor debe tener 13 dígitos')
    }

    for (const campo of ['establecimiento', 'punto_emision']) {
      if (datos[campo] && !/^\d{3}$/.test(datos[campo])) {
        throw badRequest(`El ${campo.replace('_', ' ')} son 3 dígitos, como 001`)
      }
    }

    // Solo lo que es columna de verdad: lo demás llega de vuelta desde la UI.
    const fila = {}
    for (const campo of COLUMNAS_CONFIG) {
      if (campo in datos) fila[campo] = datos[campo]
    }

    // Los campos numéricos llegan como texto desde los <input>. Un '' iría a la
    // base como cadena vacía y rompería la columna entera.
    for (const campo of ['dia_maximo_pago', 'meses_desplazado', 'smtp_port']) {
      if (campo in fila) fila[campo] = fila[campo] === '' || fila[campo] == null ? null : Number(fila[campo])
    }

    if (fila.dia_maximo_pago != null && !(fila.dia_maximo_pago >= 1 && fila.dia_maximo_pago <= 28)) {
      throw badRequest('El día máximo de pago va del 1 al 28', {
        hint: 'Se limita a 28 para que el día exista en todos los meses, febrero incluido.',
      })
    }

    if (certificado_pass) fila.certificado_pass_encrypted = encrypt(String(certificado_pass))
    if (smtp_pass) fila.smtp_pass_encrypted = encrypt(String(smtp_pass))

    const existente = await cargarConfig()

    const consulta = existente
      ? db().from('sri_config').update(fila).eq('id', existente.id)
      : db().from('sri_config').insert(fila)

    const { data, error } = await consulta.select().single()
    if (error) throw new AppError(`No se pudo guardar: ${error.message}`, { status: 502 })

    // Desde qué número sigue la numeración de este punto de emisión.
    if (proximo_secuencial !== undefined && proximo_secuencial !== null && proximo_secuencial !== '') {
      const n = Number(proximo_secuencial)
      if (!Number.isInteger(n) || n < 1 || n > 999999999) {
        throw badRequest('El próximo número va de 1 a 999999999')
      }

      // Se guarda el ÚLTIMO usado, que es lo que incrementa la función atómica
      // al emitir: pedir "la próxima es la 828" es guardar 827.
      const { error: errSec } = await db()
        .from('sri_sequences')
        .upsert(
          {
            tipo_doc: '01',
            establecimiento: data.establecimiento ?? '001',
            punto_emision: data.punto_emision ?? '001',
            ultimo_numero: n - 1,
          },
          { onConflict: 'tipo_doc,establecimiento,punto_emision' },
        )

      if (errSec) {
        throw new AppError(`Se guardó la configuración pero no el secuencial: ${errSec.message}`, {
          status: 502,
        })
      }
    }

    res.json({
      ...sinSecretos(data),
      proximo_secuencial: (await ultimoSecuencial(data)) + 1,
    })
  }),
)

// --- Emisión de facturas ----------------------------------------------------

/**
 * Emite una factura: reserva el secuencial, arma la clave de acceso y el XML,
 * y guarda todo como BORRADOR.
 *
 * El secuencial se pide con la función atómica de la base. Leerlo y sumarle uno
 * desde acá permitiría que dos emisiones simultáneas tomaran el mismo número, y
 * el SRI rechaza el duplicado.
 */
/**
 * Emite una factura y la deja como BORRADOR.
 *
 * Está separado de la ruta para poder reusarlo desde la facturación en lote del
 * cierre de jornada: es exactamente el mismo comprobante, emitido desde otro
 * lado.
 */
async function emitirFactura({ client_id, detalles, fecha_emision, forma_pago, observaciones }) {

    if (!Array.isArray(detalles) || detalles.length === 0) {
      throw badRequest('La factura necesita al menos un detalle')
    }

    const emisor = await cargarConfig()
    if (!emisor?.ruc) {
      throw badRequest('Falta configurar el emisor', {
        hint: 'Completá el RUC y la razón social en Facturación → Configuración.',
      })
    }

    const { data: cliente, error: errCliente } = await db()
      .from('clientes')
      .select('*')
      .eq('id', client_id)
      .maybeSingle()
    if (errCliente) throw new AppError(`No se pudo leer el cliente: ${errCliente.message}`, { status: 502 })
    if (!cliente) throw notFound('No existe ese cliente')

    if (!cliente.identificacion) {
      throw badRequest(`"${cliente.nombre}" no tiene identificación cargada`, {
        hint: 'El SRI exige la cédula o el RUC del comprador. Cargala en la ficha del cliente.',
      })
    }

    const establecimiento = emisor.establecimiento ?? '001'
    const puntoEmision = emisor.punto_emision ?? '001'

    const { data: numero, error: errSec } = await db().rpc('sri_next_secuencial', {
      p_tipo: '01',
      p_estab: establecimiento,
      p_pto: puntoEmision,
    })
    if (errSec) throw new AppError(`No se pudo reservar el secuencial: ${errSec.message}`, { status: 502 })

    const secuencial = String(numero).padStart(9, '0')
    const fecha = fecha_emision ?? new Date().toISOString().slice(0, 10)

    const claveAcceso = generarClaveAcceso({
      fechaEmision: fecha,
      tipoComprobante: '01',
      ruc: emisor.ruc,
      ambiente: emisor.ambiente ?? '1',
      establecimiento,
      puntoEmision,
      secuencial: numero,
      tipoEmision: emisor.tipo_emision ?? '1',
    })

    // Fecha en dd/mm/aaaa, que es como la pide el esquema.
    const [aa, mm, dd] = fecha.split('-')
    const totales = calcularTotales(detalles)

    // El bloque de período y fecha máxima de pago se resuelve al emitir: queda
    // congelado dentro del XML firmado, así que después se puede cambiar la
    // plantilla sin que se altere lo que ya se emitió.
    const { texto: textoPeriodo } = infoAdicionalDeFactura(emisor.plantilla_info_adicional, {
      fechaEmision: fecha,
      diaMaximoPago: emisor.dia_maximo_pago ?? 5,
      mesesDesplazado: emisor.meses_desplazado ?? 0,
      telefono: emisor.telefono,
      cliente: cliente.nombre,
      plan: detalles[0]?.descripcion,
    })

    // Solo el período: es lo único que corresponde en el bloque que ve el
    // abonado. No entra en un campo único —el SRI corta en 300 caracteres y
    // devuelve el comprobante entero si se pasa—, así que se parte en varios.
    const camposAdicionales = partirEnCampos('Descripción', textoPeriodo)

    const datosFactura = {
      claveAcceso,
      secuencial: numero,
      fechaEmision: `${dd}/${mm}/${aa}`,
      establecimiento,
      puntoEmision,
      ambiente: emisor.ambiente ?? '1',
      tipoIdentificacionComprador: cliente.tipo_identificacion ?? '05',
      razonSocialComprador: cliente.nombre,
      identificacionComprador: cliente.identificacion,
      direccionComprador: cliente.direccion,
      emailComprador: cliente.email,
      formaPago: forma_pago ?? '01',
      infoAdicional: camposAdicionales,
    }

    const xml = generarXmlFactura({ emisor, factura: datosFactura, detalles })

    const { data: doc, error: errDoc } = await db()
      .from('electronic_documents')
      .insert({
        tipo_doc: '01',
        ambiente: emisor.ambiente ?? '1',
        tipo_emision: emisor.tipo_emision ?? '1',
        establecimiento,
        punto_emision: puntoEmision,
        secuencial,
        clave_acceso: claveAcceso,
        fecha_emision: fecha,
        client_id: cliente.id,
        tipo_identificacion_comprador: cliente.tipo_identificacion ?? '05',
        identificacion_comprador: cliente.identificacion,
        razon_social_comprador: cliente.nombre,
        direccion_comprador: cliente.direccion,
        email_comprador: cliente.email,
        total_sin_impuestos: totales.totalSinImpuestos,
        total_descuento: totales.totalDescuento,
        total_iva: totales.totalIva,
        importe_total: totales.importeTotal,
        forma_pago: forma_pago ?? '01',
        estado: 'BORRADOR',
        xml_sin_firma: xml,
        observaciones: observaciones ?? null,
      })
      .select()
      .single()

    if (errDoc) {
      // El secuencial ya se consumió. Decirlo evita que se busque el número
      // "perdido" pensando que hubo un salto por error.
      throw new AppError(`No se pudo guardar la factura: ${errDoc.message}`, {
        status: 502,
        hint: `El secuencial ${secuencial} quedó consumido. La próxima factura tomará el siguiente.`,
      })
    }

    const items = totales.lineas.map((l, i) => ({
      document_id: doc.id,
      orden: i + 1,
      codigo_principal: l.codigoPrincipal ?? null,
      descripcion: l.descripcion,
      cantidad: l.cantidad,
      precio_unitario: l.precioUnitario,
      descuento: l.descuento,
      precio_total_sin_impuesto: l.precioTotalSinImpuesto,
      codigo_impuesto: '2',
      codigo_porcentaje: l.codigoPorcentaje,
      tarifa_iva: l.tarifaIva,
      base_imponible_iva: l.baseImponible,
      valor_iva: l.valorIva,
    }))

    const { error: errItems } = await db().from('document_items').insert(items)

  return {
    documento: doc,
    totales,
    avisoItems: errItems
      ? `La factura se creó pero los detalles no se guardaron: ${errItems.message}`
      : null,
  }
}

router.post(
  '/facturas',
  asyncHandler(async (req, res) => {
    const r = await emitirFactura(req.body ?? {})

    if (r.avisoItems) {
      return res.status(207).json({ ok: true, documento: r.documento, error: r.avisoItems })
    }
    res.status(201).json({ ok: true, documento: r.documento, totales: r.totales })
  }),
)

/**
 * Emite las facturas de los cobros del cierre de jornada.
 *
 * El cobro y la factura son dos momentos distintos: en el mostrador entra la
 * plata —y a veces con el número de comprobante mal tipeado—, y recién al
 * cierre alguien revisa la lista y manda todo junto al SRI. Por eso esto recibe
 * pagos y no facturas.
 *
 * Cada cobro se procesa por separado y los errores no se contagian: que el SRI
 * rechace una factura no puede impedir que salgan las otras veinte.
 *
 * El monto cobrado es el total CON impuestos —es lo que el abonado entregó—,
 * así que el precio unitario se saca dividiendo por la tarifa. Al revés, la
 * factura terminaría cobrando el IVA dos veces.
 */
router.post(
  '/facturar-lote',
  asyncHandler(async (req, res) => {
    const { pagos, enviar = true, tarifa_iva = 15, codigo_porcentaje = '4' } = req.body ?? {}

    if (!Array.isArray(pagos) || pagos.length === 0) {
      throw badRequest('Mandá los ids de los cobros a facturar')
    }

    const config = await cargarConfig()
    if (!config?.ruc) throw badRequest('Falta configurar el emisor')

    const { data: filas, error } = await db()
      .from('v_pagos_por_facturar')
      .select('*')
      .in('id', pagos)
    if (error) throw new AppError(`No se pudieron leer los cobros: ${error.message}`, { status: 502 })

    const resultados = []

    for (const pago of filas ?? []) {
      // Se recuerda fuera del try: si el envío falla después de emitir, el
      // operador tiene que saber que la factura existe y con qué número, o va
      // a intentar emitirla de nuevo y va a quemar otro secuencial.
      let emitido = null

      try {
        if (pago.falta_identificacion) {
          throw new Error('El cliente no tiene cédula o RUC cargado')
        }

        // Se emite por el total de la factura, no por el abono: al abonado que
        // paga en dos veces se le da un solo comprobante por el mes completo.
        const importe = Number(pago.total_facturar ?? pago.monto)
        const descuento = Number(pago.descuento_factura ?? 0)

        // Con descuento, el comprobante muestra el precio de lista y la rebaja
        // aparte: un importe ya rebajado no le sirve al abonado con derecho
        // para probar que se lo aplicaron.
        const base =
          descuento > 0.005
            ? Number(pago.subtotal_factura)
            : importe / (1 + Number(tarifa_iva) / 100)

        const { documento } = await emitirFactura({
          client_id: pago.client_id,
          fecha_emision: pago.fecha_pago,
          detalles: [
            {
              codigoPrincipal: pago.codigo_facturacion || 'INTERNET',
              descripcion:
                pago.concepto_factura || pago.descripcion_servicio || pago.plan || 'Servicio de internet',
              cantidad: 1,
              precioUnitario: base,
              descuento,
              tarifaIva: Number(tarifa_iva),
              codigoPorcentaje: codigo_porcentaje,
            },
          ],
          // El cobro ya dice cómo pagó: la factura no puede decir otra cosa.
          forma_pago: pago.forma_pago === 'efectivo' ? '01' : '20',
          observaciones: [
            `Emitida desde el cobro N° ${String(pago.numero).padStart(6, '0')}`,
            pago.descuento_motivo,
          ]
            .filter(Boolean)
            .join('. '),
        })

        // La factura del sistema que respalda este cobro. Si el cobro ya venía
        // aplicado a una, se le cuelga el comprobante fiscal; si no —un abono
        // suelto—, se crea para que el cobro no quede sin su factura.
        let facturaId = pago.factura_id ?? null

        if (facturaId) {
          await db().from('facturas').update({ document_id: documento.id }).eq('id', facturaId)
        } else {
          const { data: creada } = await db()
            .from('facturas')
            .insert({
              client_id: pago.client_id,
              cliente_nombre: pago.cliente ?? pago.cliente_nombre,
              tipo: 'servicios',
              concepto: pago.descripcion_servicio || pago.plan || 'Servicio de internet',
              fecha_emision: pago.fecha_pago,
              fecha_vencimiento: pago.fecha_pago,
              subtotal: Number((importe - importe * (Number(tarifa_iva) / (100 + Number(tarifa_iva)))).toFixed(2)),
              impuesto: Number((importe * (Number(tarifa_iva) / (100 + Number(tarifa_iva)))).toFixed(2)),
              total: importe,
              document_id: documento.id,
            })
            .select()
            .single()
          facturaId = creada?.id ?? null
        }

        // El cobro queda apuntando a su comprobante: eso lo saca de la cola.
        const { error: errVinculo } = await db()
          .from('pagos')
          .update({ document_id: documento.id, factura_id: facturaId })
          .eq('id', pago.id)
        if (errVinculo) throw new Error(`La factura se emitió pero no se vinculó al cobro: ${errVinculo.message}`)

        emitido = {
          documento_id: documento.id,
          numero: `${documento.establecimiento}-${documento.punto_emision}-${documento.secuencial}`,
        }

        const paso = {
          pago_id: pago.id,
          cliente: pago.cliente,
          ...emitido,
          estado: documento.estado,
          ok: true,
        }

        if (enviar) {
          const { p12, password } = certificadoDe(config)
          const firma = firmarComprobante(documento.xml_sin_firma, p12, password)
          const v = verificarFirma(firma.xmlFirmado)
          if (!v.valida) throw new Error(`La firma no pasó la verificación: ${v.problemas.join(' · ')}`)

          await db()
            .from('electronic_documents')
            .update({ xml_firmado: firma.xmlFirmado, estado: 'FIRMADO' })
            .eq('id', documento.id)

          const recepcion = await enviarComprobante(firma.xmlFirmado, documento.ambiente)
          if (!recepcion.recibida) {
            await db()
              .from('electronic_documents')
              .update({
                estado: 'NO_AUTORIZADO',
                mensaje_autorizacion: resumirMensajes(recepcion.mensajes),
              })
              .eq('id', documento.id)

            resultados.push({
              ...paso,
              ok: false,
              estado: 'NO_AUTORIZADO',
              error: resumirMensajes(recepcion.mensajes) || 'El SRI devolvió el comprobante',
            })
            continue
          }

          await db().from('electronic_documents').update({ estado: 'ENVIADO' }).eq('id', documento.id)

          let autorizacion = null
          for (const espera of [3000, 4000, 6000]) {
            await new Promise((r) => setTimeout(r, espera))
            autorizacion = await consultarAutorizacion(documento.clave_acceso, documento.ambiente)
            if (!autorizacion.pendiente) break
          }

          if (autorizacion?.pendiente) {
            resultados.push({
              ...paso,
              estado: 'ENVIADO',
              aviso: 'El SRI lo recibió pero todavía no lo autorizó. Consultá en un rato.',
            })
            continue
          }

          const cambios = {
            estado: autorizacion.autorizado ? 'AUTORIZADO' : 'NO_AUTORIZADO',
            mensaje_autorizacion: resumirMensajes(autorizacion.mensajes),
          }
          if (autorizacion.autorizado) {
            cambios.numero_autorizacion = autorizacion.numeroAutorizacion
            cambios.fecha_autorizacion = autorizacion.fechaAutorizacion
            if (autorizacion.comprobante) cambios.xml_autorizado = autorizacion.comprobante
          }
          await db().from('electronic_documents').update(cambios).eq('id', documento.id)

          paso.ok = Boolean(autorizacion.autorizado)
          paso.estado = cambios.estado
          if (!autorizacion.autorizado) paso.error = cambios.mensaje_autorizacion
        }

        resultados.push(paso)
      } catch (err) {
        resultados.push({
          pago_id: pago.id,
          cliente: pago.cliente,
          ok: false,
          ...(emitido ?? {}),
          error: err.message,
          // La factura ya existe y consumió su número: hay que reintentar el
          // envío, no emitirla de nuevo.
          ...(emitido
            ? {
                estado: 'FIRMADO',
                siguiente: `La factura ${emitido.numero} quedó emitida y firmada. Reintentá el envío desde Comprobantes; no la emitas de nuevo.`,
              }
            : {}),
        })
      }
    }

    // Los ids que no aparecieron: ya facturados, anulados o sin marca.
    const procesados = new Set((filas ?? []).map((f) => f.id))
    for (const id of pagos.filter((x) => !procesados.has(x))) {
      resultados.push({ pago_id: id, ok: false, error: 'El cobro ya no está pendiente de facturar' })
    }

    res.json({
      ok: resultados.every((r) => r.ok),
      emitidas: resultados.filter((r) => r.ok).length,
      conError: resultados.filter((r) => !r.ok).length,
      resultados,
    })
  }),
)

// --- Facturas del sistema ---------------------------------------------------

/**
 * A quién le tocaría factura hoy, sin escribir nada.
 *
 * Va antes de las rutas con `:id` para que "facturas-mes" no se lea como el id
 * de un comprobante.
 */
router.get(
  '/facturas-mes',
  asyncHandler(async (req, res) => {
    const previo = await generarFacturas({ simular: true, fecha: req.query.fecha || null })
    res.json({
      automatica: estadoFacturacion.automatica,
      hora: estadoFacturacion.hora,
      ultimaCorrida: estadoFacturacion.ultimaCorrida,
      ultimoResultado: estadoFacturacion.ultimoResultado,
      ...previo,
    })
  }),
)

/** Crea las facturas del día. Con `simular: true` solo devuelve la lista. */
router.post(
  '/facturas-mes',
  asyncHandler(async (req, res) => {
    res.json(
      await generarFacturas({
        simular: req.body?.simular === true,
        fecha: req.body?.fecha || null,
      }),
    )
  }),
)

/**
 * Devuelve el número del comprobante a la bolsa de libres.
 *
 * El secuencial se consume al armar el comprobante, no al enviarlo: si hay que
 * corregir un valor, ese número quedaría gastado. Y como el SRI solo conoce lo
 * que recibió, un comprobante que nunca salió tiene su número libre.
 *
 * Antes de liberar uno que ya se firmó se le pregunta al SRI si lo tiene. Un
 * número reutilizado que el SRI ya conoce hace que rechace el comprobante nuevo
 * por duplicado, y ahí sí se pierde la emisión.
 */
router.post(
  '/documentos/:id/liberar-numero',
  asyncHandler(async (req, res) => {
    const doc = await cargarDocumento(req.params.id)

    if (doc.estado === 'AUTORIZADO' || doc.numero_autorizacion) {
      throw badRequest('El comprobante está autorizado: su número no se puede reutilizar', {
        hint: 'Un comprobante autorizado se corrige con una nota de crédito.',
      })
    }

    // Un borrador nunca salió de acá. Cualquier otro estado hay que
    // confirmarlo contra el SRI antes de dar el número por libre.
    let verificacion = null
    if (doc.estado !== 'BORRADOR') {
      try {
        verificacion = await consultarAutorizacion(doc.clave_acceso, doc.ambiente)
      } catch (err) {
        throw new AppError(`No se pudo confirmar con el SRI: ${err.message}`, {
          status: 502,
          hint: 'Sin confirmar que el SRI no lo tiene, reutilizar el número puede hacer que rechace el comprobante nuevo. Reintentá cuando el servicio responda.',
        })
      }

      if (verificacion.autorizado) {
        // Aprovecha el viaje: si el SRI lo tenía autorizado, se actualiza.
        await db()
          .from('electronic_documents')
          .update({
            estado: 'AUTORIZADO',
            numero_autorizacion: verificacion.numeroAutorizacion,
            fecha_autorizacion: verificacion.fechaAutorizacion,
            ...(verificacion.comprobante ? { xml_autorizado: verificacion.comprobante } : {}),
          })
          .eq('id', doc.id)

        throw badRequest('El SRI sí tiene este comprobante: está autorizado', {
          hint: 'Se actualizó su estado. El número no se puede reutilizar.',
        })
      }
    }

    const { data: numero, error } = await db().rpc('sri_liberar_secuencial', {
      p_document_id: doc.id,
      p_motivo: req.body?.motivo ?? null,
    })

    if (error) {
      throw new AppError(`No se pudo liberar el número: ${error.message}`, { status: 400 })
    }

    res.json({
      ok: true,
      numero,
      comprobante: `${doc.establecimiento}-${doc.punto_emision}-${doc.secuencial}`,
      verificadoEnSri: Boolean(verificacion),
      aviso: `El número ${doc.secuencial} vuelve a estar disponible: lo va a tomar la próxima factura de ${doc.establecimiento}-${doc.punto_emision}.`,
    })
  }),
)

/** XML del comprobante: el firmado si existe, si no el borrador. */
router.get(
  '/documentos/:id/xml',
  asyncHandler(async (req, res) => {
    const { data, error } = await db()
      .from('electronic_documents')
      .select('clave_acceso, xml_sin_firma, xml_firmado, xml_autorizado')
      .eq('id', req.params.id)
      .maybeSingle()

    if (error) throw new AppError(error.message, { status: 502 })
    if (!data) throw notFound('No existe ese comprobante')

    // Lo que se descarga tiene que ser un XML de verdad: es el comprobante que
    // el comprador guarda y procesa, no una vista del sistema.
    const xml = desenvolverComprobante(data.xml_autorizado || data.xml_firmado || data.xml_sin_firma)
    if (!xml) throw notFound('El comprobante todavía no tiene XML generado')

    if (req.query.descargar === '1') {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${data.clave_acceso}.xml"`)
      return res.send(xml)
    }

    res.json({ clave_acceso: data.clave_acceso, xml })
  }),
)

/** Decodifica el logo guardado, venga como data URL o como base64 pelado. */
function logoDe(config) {
  if (!config?.logo_b64) return null
  try {
    const limpio = String(config.logo_b64).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '')
    return Buffer.from(limpio, 'base64')
  } catch {
    // Un logo corrupto no puede impedir que salga la factura.
    return null
  }
}

/**
 * Arma el RIDE de un comprobante ya guardado.
 *
 * Se genera al vuelo cada vez en lugar de guardarlo. El PDF es una función del
 * comprobante —y el comprobante ya no cambia una vez autorizado—, así que
 * almacenarlo solo agregaría una copia que puede quedar desactualizada.
 */
async function armarRide(documento, emisor) {
  const { data: items, error } = await db()
    .from('document_items')
    .select('*')
    .eq('document_id', documento.id)
    .order('orden')
  if (error) throw new AppError(`No se pudieron leer los detalles: ${error.message}`, { status: 502 })

  // Se desenvuelve por si el comprobante autorizado quedó guardado escapado,
  // que es como lo devuelve el SRI.
  const xml = desenvolverComprobante(
    documento.xml_autorizado || documento.xml_firmado || documento.xml_sin_firma,
  )
  const campos = leerCamposAdicionales(xml)

  // El teléfono del comprador no viaja en el comprobante —el SRI no lo pide—
  // pero el RIDE lo muestra, así que se lee de su ficha. Es dato de contacto,
  // no tributario: que refleje el actual es lo correcto.
  let telefono = null
  if (documento.client_id) {
    const { data: cliente } = await db()
      .from('clientes')
      .select('telefono')
      .eq('id', documento.client_id)
      .maybeSingle()
    telefono = cliente?.telefono ?? null
  }

  const pdf = await generarRidePdf({
    emisor,
    documento,
    items: items ?? [],
    campos,
    logo: logoDe(emisor),
    telefono,
  })

  return { pdf, xml, campos }
}

/** RIDE: el PDF que recibe el abonado. */
router.get(
  '/documentos/:id/ride',
  asyncHandler(async (req, res) => {
    const emisor = await cargarConfig()
    if (!emisor?.ruc) throw badRequest('Falta configurar el emisor')

    const documento = await cargarDocumento(req.params.id)
    const { pdf } = await armarRide(documento, emisor)

    const disposicion = req.query.descargar === '1' ? 'attachment' : 'inline'
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Length', pdf.length)
    res.setHeader('Content-Disposition', `${disposicion}; filename="${documento.clave_acceso}.pdf"`)
    res.send(pdf)
  }),
)

// --- Envío por correo -------------------------------------------------------

/** La contraseña del SMTP, descifrada, con el aviso de qué falta si no está. */
function smtpDe(config) {
  const faltan = faltantesSmtp(config)
  if (faltan.length) {
    throw badRequest(`Falta configurar ${faltan.join(', ')} para poder enviar correos`, {
      hint: 'Completá los datos del servidor de correo en Facturación → Configuración.',
    })
  }
  return decrypt(config.smtp_pass_encrypted)
}

/**
 * Manda el comprobante al comprador: XML autorizado + RIDE.
 *
 * Solo se envía lo que el SRI autorizó. Un XML sin autorizar no le sirve de
 * nada al cliente —no es un comprobante todavía— y mandarlo genera el reclamo
 * de por qué su factura "no aparece" en el portal del SRI.
 */
router.post(
  '/documentos/:id/email',
  asyncHandler(async (req, res) => {
    const { para, copia } = req.body ?? {}

    const emisor = await cargarConfig()
    if (!emisor?.ruc) throw badRequest('Falta configurar el emisor')
    const password = smtpDe(emisor)

    const documento = await cargarDocumento(req.params.id)

    if (documento.estado !== 'AUTORIZADO') {
      throw badRequest(`El comprobante está en estado ${documento.estado}`, {
        hint: 'Solo se envía al comprador lo que el SRI ya autorizó.',
      })
    }

    const destino = para || documento.email_comprador
    if (!destino) {
      throw badRequest(`"${documento.razon_social_comprador}" no tiene correo cargado`, {
        hint: 'Cargalo en la ficha del cliente o indicá una dirección en este envío.',
      })
    }

    const { pdf, xml, campos } = await armarRide(documento, emisor)

    let envio
    try {
      envio = await enviarComprobantePorEmail({
        config: emisor,
        password,
        documento,
        campos,
        xml,
        pdf,
        para: destino,
        copia,
      })
    } catch (err) {
      // El detalle del servidor de correo es lo único que explica un rechazo:
      // credenciales, remitente no autorizado, casilla llena.
      throw new AppError(`No se pudo enviar el correo: ${err.message}`, {
        status: 502,
        hint: 'Revisá el usuario, la contraseña y el puerto del SMTP. Gmail exige una contraseña de aplicación.',
      })
    }

    const { error } = await db()
      .from('electronic_documents')
      .update({ enviado_por_email: true, fecha_envio_email: new Date().toISOString() })
      .eq('id', documento.id)

    if (error) {
      // El correo ya salió: decirlo evita que se reenvíe pensando que falló.
      return res.status(207).json({
        ok: true,
        ...envio,
        guardadoEnBase: false,
        aviso: `El correo se envió a ${destino}, pero no se pudo marcar en la base: ${error.message}`,
      })
    }

    res.json({ ok: true, ...envio, guardadoEnBase: true })
  }),
)

/**
 * Prueba la configuración del correo sin tocar ningún comprobante.
 *
 * Primero se verifica el saludo del servidor y después se manda un mensaje de
 * verdad: `verify()` valida las credenciales, pero no que el remitente esté
 * autorizado a enviar — eso solo se ve enviando.
 */
router.post(
  '/probar-smtp',
  asyncHandler(async (req, res) => {
    const emisor = await cargarConfig()
    if (!emisor) throw badRequest('Todavía no hay configuración guardada')
    const password = smtpDe(emisor)

    const destino = req.body?.para || emisor.email || emisor.email_from || emisor.smtp_user
    const transporte = crearTransporte(emisor, password)

    try {
      await transporte.verify()
      const r = await transporte.sendMail({
        from: remitente(emisor),
        to: destino,
        subject: 'Prueba de configuración de correo',
        text:
          'Si estás leyendo esto, el sistema de facturación puede enviar los comprobantes ' +
          'a tus clientes desde esta casilla.',
      })
      res.json({ ok: true, destino, messageId: r.messageId })
    } catch (err) {
      throw new AppError(`El servidor de correo rechazó la prueba: ${err.message}`, {
        status: 502,
        hint: 'Verificá host, puerto, usuario y contraseña. En Gmail hace falta una contraseña de aplicación, no la del correo.',
      })
    } finally {
      transporte.close()
    }
  }),
)

/** Vista previa de los totales, sin guardar nada. */
router.post(
  '/preview',
  asyncHandler(async (req, res) => {
    const { detalles } = req.body ?? {}
    if (!Array.isArray(detalles)) throw badRequest('Mandá un array "detalles"')
    res.json(calcularTotales(detalles))
  }),
)

/** Códigos que la UI necesita para los desplegables. */
router.get('/catalogos', (_req, res) => {
  res.json({
    iva: Object.entries(IVA).map(([clave, v]) => ({ clave, ...v })),
    identificacion: [
      { codigo: '04', label: 'RUC' },
      { codigo: '05', label: 'Cédula' },
      { codigo: '06', label: 'Pasaporte' },
      { codigo: '07', label: 'Consumidor final' },
      { codigo: '08', label: 'Identificación del exterior' },
    ],
    formaPago: [
      { codigo: '01', label: 'Sin utilización del sistema financiero' },
      { codigo: '16', label: 'Tarjeta de débito' },
      { codigo: '19', label: 'Tarjeta de crédito' },
      { codigo: '20', label: 'Otros con utilización del sistema financiero' },
      { codigo: '17', label: 'Dinero electrónico' },
    ],
    // Para el editor de la plantilla de "Información Adicional".
    plantilla: { porDefecto: PLANTILLA_POR_DEFECTO, variables: VARIABLES },
  })
})

// --- Certificado de firma ---------------------------------------------------

/**
 * Devuelve el .p12 y su contraseña, descifrados.
 * Solo se llama desde el backend, en el momento de firmar.
 */
function certificadoDe(config) {
  if (!config?.certificado_b64) {
    throw badRequest('No hay certificado cargado', {
      hint: 'Subí tu archivo .p12 en Facturación → Configuración.',
    })
  }
  return {
    p12: decrypt(config.certificado_b64),
    password: decrypt(config.certificado_pass_encrypted),
  }
}

/**
 * Sube y valida el certificado.
 *
 * Se abre antes de guardarlo: si la contraseña está mal o el archivo no sirve,
 * conviene saberlo ahora y no al emitir el primer comprobante.
 *
 * Se guarda cifrado —el archivo y la clave— con la misma CREDENTIALS_KEY que
 * protege las credenciales de los equipos. Con la base sola no alcanza para
 * firmar en nombre de la empresa.
 */
router.post(
  '/certificado',
  asyncHandler(async (req, res) => {
    const { certificado_b64, password } = req.body ?? {}
    if (!certificado_b64) throw badRequest('Falta el archivo del certificado')
    if (!password) throw badRequest('Falta la contraseña del certificado')

    const limpio = String(certificado_b64).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '')

    // Si esto no lanza, el certificado sirve para firmar.
    const resumen = resumenCertificado(limpio, password)

    const existente = await cargarConfig()
    const fila = {
      certificado_b64: encrypt(limpio),
      certificado_pass_encrypted: encrypt(String(password)),
      certificado_vence: resumen.validoHasta,
    }

    const consulta = existente
      ? db().from('sri_config').update(fila).eq('id', existente.id)
      : db().from('sri_config').insert(fila)

    const { error } = await consulta
    if (error) throw new AppError(`No se pudo guardar el certificado: ${error.message}`, { status: 502 })

    res.json({ ok: true, certificado: resumen })
  }),
)

/** Datos del certificado guardado. Nunca devuelve el archivo ni la clave. */
router.get(
  '/certificado',
  asyncHandler(async (_req, res) => {
    const config = await cargarConfig()
    if (!config?.certificado_b64) return res.json({ cargado: false })

    try {
      const { p12, password } = certificadoDe(config)
      res.json({ cargado: true, ...resumenCertificado(p12, password) })
    } catch (err) {
      // Un certificado guardado que ya no se puede abrir (venció, o cambió la
      // CREDENTIALS_KEY) tiene que verse, no quedar como si estuviera bien.
      res.json({ cargado: true, problema: err.message, hint: err.hint })
    }
  }),
)

router.delete(
  '/certificado',
  asyncHandler(async (_req, res) => {
    const config = await cargarConfig()
    if (config) {
      await db()
        .from('sri_config')
        .update({ certificado_b64: null, certificado_pass_encrypted: null, certificado_vence: null })
        .eq('id', config.id)
    }
    res.json({ ok: true })
  }),
)

/**
 * Firma un comprobante de ejemplo, sin guardar nada ni contactar al SRI.
 * Sirve para confirmar que el certificado funciona antes de emitir de verdad.
 */
router.post(
  '/probar-firma',
  asyncHandler(async (_req, res) => {
    const config = await cargarConfig()
    if (!config?.ruc) throw badRequest('Primero completá el RUC y la razón social del emisor')

    const { p12, password } = certificadoDe(config)

    const claveAcceso = generarClaveAcceso({
      fechaEmision: new Date().toISOString().slice(0, 10),
      tipoComprobante: '01',
      ruc: config.ruc,
      ambiente: config.ambiente ?? '1',
      secuencial: 999999999,
    })

    const hoy = new Date()
    const xml = generarXmlFactura({
      emisor: config,
      factura: {
        claveAcceso,
        secuencial: 999999999,
        fechaEmision: `${String(hoy.getDate()).padStart(2, '0')}/${String(hoy.getMonth() + 1).padStart(2, '0')}/${hoy.getFullYear()}`,
        ambiente: config.ambiente ?? '1',
        tipoIdentificacionComprador: '07',
        razonSocialComprador: 'CONSUMIDOR FINAL',
        identificacionComprador: '9999999999999',
      },
      detalles: [
        {
          codigoPrincipal: 'PRUEBA',
          descripcion: 'Comprobante de prueba de firma',
          cantidad: 1,
          precioUnitario: 1,
          tarifaIva: 15,
          codigoPorcentaje: '4',
        },
      ],
    })

    const firma = firmarComprobante(xml, p12, password)
    const verificacion = verificarFirma(firma.xmlFirmado)

    res.json({
      ok: verificacion.valida,
      verificacion,
      certificado: firma.certificado,
      claveAcceso,
      digests: firma.digests,
      xmlFirmado: firma.xmlFirmado,
      aviso:
        'Comprobante de prueba: no se guardó en la base ni se envió al SRI. Que la firma verifique acá no garantiza que el SRI la acepte — eso se confirma emitiendo en su ambiente de pruebas.',
    })
  }),
)

/** Firma un comprobante ya emitido y lo deja en estado FIRMADO. */
router.post(
  '/documentos/:id/firmar',
  asyncHandler(async (req, res) => {
    const config = await cargarConfig()
    const { p12, password } = certificadoDe(config)

    const { data: doc, error } = await db()
      .from('electronic_documents')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle()
    if (error) throw new AppError(error.message, { status: 502 })
    if (!doc) throw notFound('No existe ese comprobante')

    if (!doc.xml_sin_firma) throw badRequest('El comprobante no tiene XML generado')
    if (doc.estado === 'AUTORIZADO') {
      throw badRequest('El comprobante ya está autorizado por el SRI: no se puede volver a firmar')
    }

    const firma = firmarComprobante(doc.xml_sin_firma, p12, password)
    const verificacion = verificarFirma(firma.xmlFirmado)

    if (!verificacion.valida) {
      throw new AppError('La firma generada no pasó la verificación', {
        status: 500,
        detalle: verificacion.problemas.join(' · '),
      })
    }

    const { error: errUpd } = await db()
      .from('electronic_documents')
      .update({ xml_firmado: firma.xmlFirmado, estado: 'FIRMADO' })
      .eq('id', doc.id)
    if (errUpd) throw new AppError(`No se pudo guardar la firma: ${errUpd.message}`, { status: 502 })

    res.json({ ok: true, estado: 'FIRMADO', certificado: firma.certificado })
  }),
)

// --- Envío al SRI -----------------------------------------------------------

async function cargarDocumento(id) {
  const { data, error } = await db()
    .from('electronic_documents')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new AppError(error.message, { status: 502 })
  if (!data) throw notFound('No existe ese comprobante')
  return data
}

/**
 * Entrega el comprobante firmado al SRI.
 *
 * Una devolución (DEVUELTA) no es un fallo de comunicación: el SRI lo recibió y
 * lo rechazó. Se guarda el motivo y se devuelve con 200, porque la operación se
 * completó — lo que falló es el comprobante, y eso hay que mostrarlo, no
 * disfrazarlo de error de red.
 */
router.post(
  '/documentos/:id/enviar',
  asyncHandler(async (req, res) => {
    const doc = await cargarDocumento(req.params.id)

    if (!doc.xml_firmado) {
      throw badRequest('El comprobante todavía no está firmado', {
        hint: 'Firmalo antes de enviarlo al SRI.',
      })
    }
    if (doc.estado === 'AUTORIZADO') {
      throw badRequest('El comprobante ya está autorizado')
    }

    const r = await enviarComprobante(doc.xml_firmado, doc.ambiente)

    await db()
      .from('electronic_documents')
      .update({
        estado: r.recibida ? 'ENVIADO' : 'NO_AUTORIZADO',
        mensaje_autorizacion: resumirMensajes(r.mensajes),
      })
      .eq('id', doc.id)

    res.json({
      ...r,
      claveAcceso: doc.clave_acceso,
      siguiente: r.recibida
        ? 'El SRI lo recibió. Consultá la autorización en unos segundos.'
        : 'El SRI lo rechazó. Revisá los mensajes, corregí y emití uno nuevo.',
    })
  }),
)

/**
 * Consulta si el SRI ya autorizó el comprobante.
 *
 * Si todavía lo está procesando devuelve pendiente, sin tocar el estado: marcar
 * NO_AUTORIZADO por consultar demasiado pronto sería un error.
 */
router.post(
  '/documentos/:id/autorizacion',
  asyncHandler(async (req, res) => {
    const doc = await cargarDocumento(req.params.id)
    const r = await consultarAutorizacion(doc.clave_acceso, doc.ambiente)

    if (r.pendiente) {
      return res.json({ ...r, claveAcceso: doc.clave_acceso })
    }

    const cambios = {
      estado: r.autorizado ? 'AUTORIZADO' : 'NO_AUTORIZADO',
      mensaje_autorizacion: resumirMensajes(r.mensajes),
    }
    if (r.autorizado) {
      cambios.numero_autorizacion = r.numeroAutorizacion
      cambios.fecha_autorizacion = r.fechaAutorizacion
      // El XML autorizado es el que hay que conservar y entregarle al comprador.
      if (r.comprobante) cambios.xml_autorizado = r.comprobante
    }

    const { error } = await db().from('electronic_documents').update(cambios).eq('id', doc.id)
    if (error) {
      return res.status(207).json({
        ...r,
        guardadoEnBase: false,
        error: `El SRI respondió pero no se pudo actualizar la base: ${error.message}`,
      })
    }

    res.json({ ...r, claveAcceso: doc.clave_acceso, guardadoEnBase: true })
  }),
)

/**
 * Firma, envía y consulta la autorización en una sola operación.
 *
 * Entre el envío y la consulta hay una espera: el SRI procesa de forma
 * asíncrona y consultar de inmediato casi siempre devuelve "en proceso".
 */
router.post(
  '/documentos/:id/procesar',
  asyncHandler(async (req, res) => {
    const config = await cargarConfig()
    const { p12, password } = certificadoDe(config)
    let doc = await cargarDocumento(req.params.id)

    const pasos = []

    // 1. Firmar, si hace falta
    if (!doc.xml_firmado) {
      const firma = firmarComprobante(doc.xml_sin_firma, p12, password)
      const v = verificarFirma(firma.xmlFirmado)
      if (!v.valida) {
        throw new AppError('La firma no pasó la verificación', {
          status: 500,
          detalle: v.problemas.join(' · '),
        })
      }
      await db()
        .from('electronic_documents')
        .update({ xml_firmado: firma.xmlFirmado, estado: 'FIRMADO' })
        .eq('id', doc.id)
      doc = { ...doc, xml_firmado: firma.xmlFirmado, estado: 'FIRMADO' }
      pasos.push({ paso: 'firma', ok: true })
    } else {
      pasos.push({ paso: 'firma', ok: true, nota: 'ya estaba firmado' })
    }

    // 2. Enviar
    const recepcion = await enviarComprobante(doc.xml_firmado, doc.ambiente)
    pasos.push({ paso: 'recepcion', ok: recepcion.recibida, estado: recepcion.estado, mensajes: recepcion.mensajes })

    if (!recepcion.recibida) {
      await db()
        .from('electronic_documents')
        .update({ estado: 'NO_AUTORIZADO', mensaje_autorizacion: resumirMensajes(recepcion.mensajes) })
        .eq('id', doc.id)
      return res.json({ ok: false, pasos, estadoFinal: 'NO_AUTORIZADO' })
    }

    await db().from('electronic_documents').update({ estado: 'ENVIADO' }).eq('id', doc.id)

    // 3. Esperar y consultar. Se reintenta porque el SRI puede tardar.
    let autorizacion = null
    for (const espera of [3000, 4000, 6000]) {
      await new Promise((r) => setTimeout(r, espera))
      autorizacion = await consultarAutorizacion(doc.clave_acceso, doc.ambiente)
      if (!autorizacion.pendiente) break
    }

    pasos.push({
      paso: 'autorizacion',
      ok: Boolean(autorizacion?.autorizado),
      estado: autorizacion?.estado,
      mensajes: autorizacion?.mensajes ?? [],
    })

    if (autorizacion?.pendiente) {
      return res.json({
        ok: false,
        pasos,
        estadoFinal: 'ENVIADO',
        aviso: 'El SRI lo recibió pero todavía no lo autorizó. Consultá de nuevo en un rato.',
      })
    }

    const cambios = {
      estado: autorizacion.autorizado ? 'AUTORIZADO' : 'NO_AUTORIZADO',
      mensaje_autorizacion: resumirMensajes(autorizacion.mensajes),
    }
    if (autorizacion.autorizado) {
      cambios.numero_autorizacion = autorizacion.numeroAutorizacion
      cambios.fecha_autorizacion = autorizacion.fechaAutorizacion
      if (autorizacion.comprobante) cambios.xml_autorizado = autorizacion.comprobante
    }
    await db().from('electronic_documents').update(cambios).eq('id', doc.id)

    // 4. Enviarlo al comprador, si se pidió.
    //    Va al final y aparte: que falle el correo no cambia que el comprobante
    //    quedó autorizado, y confundir las dos cosas lleva a reemitir facturas
    //    que ya existen.
    if (autorizacion.autorizado && req.body?.enviar_email) {
      const actualizado = { ...doc, ...cambios }
      try {
        const password = smtpDe(config)
        const { pdf, xml, campos } = await armarRide(actualizado, config)
        const envio = await enviarComprobantePorEmail({
          config,
          password,
          documento: actualizado,
          campos,
          xml,
          pdf,
        })
        await db()
          .from('electronic_documents')
          .update({ enviado_por_email: true, fecha_envio_email: new Date().toISOString() })
          .eq('id', doc.id)
        pasos.push({ paso: 'email', ok: true, nota: `enviado a ${envio.destino}` })
      } catch (err) {
        pasos.push({ paso: 'email', ok: false, nota: err.message })
      }
    }

    res.json({ ok: autorizacion.autorizado, pasos, estadoFinal: cambios.estado, autorizacion })
  }),
)

export default router
