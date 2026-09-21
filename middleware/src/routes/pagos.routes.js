import { Router } from 'express'
import { asyncHandler, notFound, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { db } from '../lib/db.js'
import { actorDe } from '../lib/auditoria.js'
import { tienePermiso } from '../../../web/src/lib/permisos.js'
import { generarReciboPdf } from '../pagos/reciboPdf.js'
import { generarFacturaPdf } from '../pagos/facturaPdf.js'
import { leyendaDe } from '../services/correoFactura.js'
import { generarTransaccionesPdf } from '../pagos/transaccionesPdf.js'
import { leerExtracto } from '../services/extractoBanco.js'
import { conciliar, conDatosDeContacto } from '../services/conciliacion.js'
import { generarConciliacionPdf } from '../pagos/conciliacionPdf.js'
import { generarArcotelExcel, generarArcotelPdf } from '../pagos/arcotelReporte.js'
import { ejecutarCortes, estadoCortes } from '../services/cortesPromesas.js'

/**
 * Cobros.
 *
 * El registro de pagos es CRUD y va directo a Supabase desde el navegador. Acá
 * solo vive lo que el navegador no puede hacer: armar el PDF del recibo, que
 * necesita el logo y los datos del emisor —y esos viven junto al certificado,
 * que nunca sale del backend.
 */

const router = Router()
router.use(requireAuth)

// --- Corte automático de promesas vencidas ----------------------------------

/**
 * Quién quedaría cortado si el proceso corriera ahora.
 *
 * Va antes que las rutas con `:id` para que "cortes" no se lea como el id de un
 * pago.
 */
router.get(
  '/cortes',
  asyncHandler(async (_req, res) => {
    const previo = await ejecutarCortes({ simular: true })
    res.json({
      automaticos: estadoCortes.automaticos,
      hora: estadoCortes.hora,
      ultimaCorrida: estadoCortes.ultimaCorrida,
      ultimoResultado: estadoCortes.ultimoResultado,
      ...previo,
    })
  }),
)

/**
 * Corta ahora, sin esperar a la hora programada.
 *
 * Con `simular: true` devuelve lo mismo pero sin tocar la red: sirve para ver
 * la lista antes de decidirse.
 */
router.post(
  '/cortes/ejecutar',
  asyncHandler(async (req, res) => {
    res.json(await ejecutarCortes({ simular: req.body?.simular === true }))
  }),
)

/**
 * Quién está pidiendo, y si le alcanza el permiso.
 *
 * ── Por qué esto vive acá y no solo en el mapa de rutas del navegador ──
 *
 * Porque esconder una pantalla no protege un dato: quien sabe la URL la pide
 * igual, y quien abre la consola llama al endpoint directo. El mapa evita
 * ofrecerle a alguien lo que no va a poder usar; esto es lo que lo impide.
 */
async function exigir(req, permiso) {
  const actor = await actorDe(req)

  if (!actor) {
    throw new AppError('Tu usuario no tiene un legajo de personal asociado', {
      status: 403,
      hint: 'Pedile a un Super Administrador que te cree el usuario en Ajustes → Gestión de personal.',
    })
  }
  if (!actor.activo) throw new AppError('Tu usuario está desactivado', { status: 403 })

  if (permiso && !tienePermiso(actor, permiso)) {
    throw new AppError('No tenés permiso para esto', {
      status: 403,
      hint: `Hace falta el permiso "${permiso}". Se otorga en Ajustes → Gestión de personal.`,
    })
  }

  return actor
}

/** Decodifica el logo guardado, venga como data URL o como base64 pelado. */
function logoDe(config) {
  if (!config?.logo_b64) return null
  try {
    return Buffer.from(
      String(config.logo_b64).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, ''),
      'base64',
    )
  } catch {
    return null
  }
}

/**
 * El reporte que pide ARCOTEL.
 *
 * Se arma del lado del servidor por lo mismo que el cierre de caja: el archivo
 * que se sube al portal del regulador tiene que traer TODO el período, no la
 * página que se está mirando.
 *
 * `formato` decide el papel. Los dos salen de la misma consulta y de la misma
 * lista de columnas: si el Excel y el PDF pudieran diferir, el día que el
 * regulador pida una columna más se agregaría en uno y se olvidaría en el otro.
 */
router.get(
  '/arcotel',
  asyncHandler(async (req, res) => {
    // El reporte del regulador lo arma quien consolida, no quien cobra.
    await exigir(req, 'finanzas.reporte_arcotel')

    const { mes, prestador, formato = 'excel' } = req.query

    let q = db().from('v_reporte_arcotel').select('*')
    if (mes) q = q.eq('mes', mes)
    if (prestador) q = q.eq('prestador_id', prestador)

    const { data: filas, error } = await q.order('usuario').limit(20000)

    if (error) {
      throw new AppError(
        /does not exist/i.test(error.message)
          ? 'Falta la vista del reporte. Corré supabase/migracion-162-el-reporte-para-arcotel.sql'
          : `No se pudo armar el reporte: ${error.message}`,
        { status: 502 },
      )
    }

    /**
     * Los datos del emisor salen del prestador elegido, no del primero.
     *
     * Son dos RUC y el regulador los mira por separado: un reporte con el RUC
     * equivocado en la portada es una observación segura.
     */
    let emisor = {}
    if (prestador) {
      const { data } = await db()
        .from('prestadores').select('*').eq('id', prestador).maybeSingle()
      emisor = data ?? {}
    }
    if (!emisor.ruc) {
      const { data } = await db().from('sri_config').select('*').limit(1).maybeSingle()
      emisor = { ...(data ?? {}), ...emisor }
    }

    const nombreMes = filas?.[0]?.mes_nombre ?? mes ?? 'todos'
    const base = `reporte-arcotel-${(mes || 'todos').replace('-', '')}`

    /**
     * El resumen de cómo pagaron, del mismo filtro.
     *
     * Se pide a la base y no se calcula sobre `filas`: son la misma consulta y el
     * mismo período, pero contar acá obligaría a repetir la regla del "mixto" —una
     * factura saldada con efectivo y transferencia— en dos lugares.
     */
    let q2 = db().from('v_arcotel_resumen').select('*')
    if (mes) q2 = q2.eq('mes', mes)
    if (prestador) q2 = q2.eq('prestador_id', prestador)
    const { data: resumen } = await q2.order('monto', { ascending: false })

    if (formato === 'pdf') {
      const pdf = await generarArcotelPdf({
        filas: filas ?? [],
        empresa: emisor,
        periodo: nombreMes,
        logo: logoDe(emisor),
        resumen: resumen ?? [],
      })
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Length', pdf.length)
      res.setHeader('Content-Disposition', `inline; filename="${base}.pdf"`)
      return res.send(pdf)
    }

    const xlsx = await generarArcotelExcel({
      filas: filas ?? [],
      empresa: emisor,
      periodo: nombreMes,
      resumen: resumen ?? [],
    })

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Length', xlsx.length)
    // El Excel se descarga siempre: no hay visor dentro del navegador y dejarlo
    // "inline" hace que el navegador lo abra como un archivo binario ilegible.
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`)
    res.send(xlsx)
  }),
)

/**
 * Conciliación bancaria: el extracto contra lo cobrado.
 *
 * ── Por qué el archivo se procesa acá y no en el navegador ──
 *
 * Porque para saber qué falta hay que leer los cobros, y eso es la base entera.
 * Y porque el resultado tiene que ser el mismo para todos: dos personas subiendo
 * el mismo archivo desde dos máquinas no pueden obtener listas distintas porque
 * una tenga otra versión de la pantalla.
 */
router.post(
  '/conciliacion',
  asyncHandler(async (req, res) => {
    // Cruzar el extracto del banco es consolidar: ve los cobros de todos.
    await exigir(req, 'finanzas.conciliacion')

    const { archivo, cuenta } = req.body ?? {}

    if (!archivo) {
      throw new AppError('Falta el archivo del extracto', {
        status: 400,
        hint: 'Subí el Excel que descargaste del banco.',
      })
    }

    const buffer = Buffer.from(
      String(archivo).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, ''),
      'base64',
    )

    let extracto
    try {
      extracto = await leerExtracto(buffer)
    } catch (e) {
      // El motivo, no "archivo inválido": lo que sigue es abrir el Excel y
      // mirar dónde está la tabla, y para eso hay que saber qué no se encontró.
      throw new AppError(`No se pudo leer el extracto: ${e.message}`, {
        status: 400,
        hint: 'Tiene que ser el Excel tal como lo descarga el banco, sin editar.',
      })
    }

    const informe = await conciliar({ movimientos: extracto.movimientos, cuenta: cuenta || null })

    // Los teléfonos, solo para la lista a la que hay que llamar.
    informe.sin_respaldo = await conDatosDeContacto(informe.sin_respaldo)

    res.json({
      ...informe,
      archivo: { hoja: extracto.hoja, movimientos: extracto.movimientos.length },
      /**
       * Lo que no se pudo leer se informa siempre, aunque sea cero.
       *
       * Una fila ilegible es plata que el banco reporta y la conciliación no vio:
       * omitir el dato haría que el informe parezca completo cuando no lo está.
       */
      ilegibles: extracto.ilegibles,
    })
  }),
)

/**
 * El mismo informe, en PDF.
 *
 * Se vuelve a conciliar del lado del servidor en vez de recibir el resultado que
 * ya tiene la pantalla. Es a propósito: el papel es lo que se archiva y lo que se
 * revisa con alguien al lado, y no puede depender de que el navegador mande de
 * vuelta sin tocar lo que se le entregó.
 */
router.post(
  '/conciliacion/pdf',
  asyncHandler(async (req, res) => {
    await exigir(req, 'finanzas.conciliacion')

    const { archivo, cuenta } = req.body ?? {}

    if (!archivo) {
      throw new AppError('Falta el archivo del extracto', {
        status: 400,
        hint: 'Subí el Excel que descargaste del banco.',
      })
    }

    const buffer = Buffer.from(
      String(archivo).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, ''),
      'base64',
    )

    let extracto
    try {
      extracto = await leerExtracto(buffer)
    } catch (e) {
      throw new AppError(`No se pudo leer el extracto: ${e.message}`, { status: 400 })
    }

    const informe = await conciliar({ movimientos: extracto.movimientos, cuenta: cuenta || null })
    informe.sin_respaldo = await conDatosDeContacto(informe.sin_respaldo)
    informe.ilegibles = extracto.ilegibles

    const { data: emisor } = await db().from('sri_config').select('*').limit(1).maybeSingle()

    // El nombre de la cuenta, no su identificador: un informe que dice
    // "Cuenta: 7cacf5bf-…" no le sirve a nadie.
    let nombreCuenta = null
    if (cuenta) {
      const { data } = await db()
        .from('cuentas_pago').select('nombre, banco').eq('id', cuenta).maybeSingle()
      nombreCuenta = data ? [data.nombre, data.banco].filter(Boolean).join(' · ') : null
    }

    const pdf = await generarConciliacionPdf({
      empresa: emisor ?? {},
      informe,
      cuenta: nombreCuenta,
      logo: logoDe(emisor),
    })

    const desde = informe.periodo?.desde ?? 'extracto'
    const nombre = `conciliacion-${String(desde).replace(/-/g, '')}.pdf`

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Length', pdf.length)
    res.setHeader('Content-Disposition', `inline; filename="${nombre}"`)
    res.send(pdf)
  }),
)

/**
 * El cierre de caja en PDF.
 *
 * ── Por qué el filtrado se hace acá y no se recibe la lista del navegador ──
 *
 * Porque el papel tiene que decir lo mismo que la pantalla, y la pantalla muestra
 * una página de quince filas. Si el navegador mandara lo que tiene a la vista, el
 * cierre saldría con quince cobros y un total que parece correcto — que es
 * exactamente cómo se cuadra mal una caja.
 *
 * Va antes de `/:id/recibo` para que "transacciones" no se lea como el id de un
 * pago.
 */
router.get(
  '/transacciones/pdf',
  asyncHandler(async (req, res) => {
    const { desde, hasta, ubicacion, forma_pago, cuenta, anulados } = req.query
    const routerId = req.query.router

    /**
     * El alcance lo decide el SERVIDOR, no el filtro que llegó.
     *
     * Sin `finanzas.ver_todos`, el reporte se acota a lo que cobró quien lo pide,
     * aunque haya pedido otro operador o ninguno.
     *
     * ── El agujero que esto tapa ──
     *
     * El punto de recaudación tiene un botón "Mi reporte de hoy" que llamaba a
     * este endpoint solo con las fechas. Sin este recorte, ese botón le devolvía
     * el cierre de caja de TODOS los operadores: su propia pantalla filtraba lo
     * que él veía, y el PDF traía la caja del ISP entero.
     */
    const actor = await exigir(req)
    const verTodos = tienePermiso(actor, 'finanzas.ver_todos')
    const operador = verTodos ? req.query.operador : actor.id

    let q = db().from('v_transacciones').select('*')

    if (desde) q = q.gte('fecha_pago', desde)
    if (hasta) q = q.lte('fecha_pago', hasta)
    if (operador) q = q.eq('operador_id', operador)
    if (routerId) q = q.eq('router_id', routerId)
    if (ubicacion) q = q.eq('ubicacion', ubicacion)
    if (forma_pago) q = q.eq('forma_pago', forma_pago)
    if (cuenta) q = q.eq('cuenta_id', cuenta)
    // Los anulados van solo si se piden: el cierre normal no los lista, pero
    // siempre dice cuántos hubo en el resumen.
    if (anulados !== '1') q = q.eq('anulado', false)

    const { data: transacciones, error } = await q
      .order('registrado_en', { ascending: false })
      .limit(5000)

    if (error) {
      throw new AppError(
        /does not exist/i.test(error.message)
          ? 'Falta la vista de transacciones. Corré supabase/migracion-157-la-pantalla-de-transacciones.sql'
          : `No se pudieron leer las transacciones: ${error.message}`,
        { status: 502 },
      )
    }

    /**
     * Los totales los calcula la base, no esta función.
     *
     * Sumar acá daría el total de las 5000 que se trajeron, y con más cobros que
     * eso el papel diría menos plata de la que entró sin avisar de nada.
     */
    const { data: totales } = await db().rpc('totales_transacciones', {
      p_desde: desde || null,
      p_hasta: hasta || null,
      p_operador: operador || null,
      p_router: routerId || null,
      p_ubicacion: ubicacion || null,
      p_forma_pago: forma_pago || null,
      p_cuenta: cuenta || null,
      p_anulados: anulados === '1',
    })

    const { data: emisor } = await db().from('sri_config').select('*').limit(1).maybeSingle()

    // Los nombres de los filtros, no sus identificadores: un cierre que dice
    // "Operador: 7cacf5bf-…" no le sirve a nadie.
    const nombres = {
      operador: (transacciones ?? []).find((t) => t.operador_id === operador)?.operador ?? null,
      router: (transacciones ?? []).find((t) => t.router_id === routerId)?.router ?? null,
    }

    const pdf = await generarTransaccionesPdf({
      empresa: emisor ?? {},
      transacciones: transacciones ?? [],
      totales: totales?.[0] ?? {},
      filtros: {
        desde,
        hasta,
        operador: nombres.operador,
        router: nombres.router,
        ubicacion,
        forma_pago,
        emitido_en: new Date().toISOString(),
      },
      logo: logoDe(emisor),
    })

    const nombre = `cierre-de-caja-${(desde || 'todo').replace(/-/g, '')}.pdf`
    const disposicion = req.query.descargar === '1' ? 'attachment' : 'inline'

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Length', pdf.length)
    res.setHeader('Content-Disposition', `${disposicion}; filename="${nombre}"`)
    res.send(pdf)
  }),
)

/**
 * Estado de cuenta de una factura del sistema, en PDF.
 *
 * Es lo que se le entrega al abonado que no pide comprobante fiscal, y lo que
 * se mira cuando alguien reclama un pago: la factura con todos sus cobros, sus
 * excedentes y el saldo.
 *
 * Va antes de `/:id/recibo` para que "facturas" no se lea como el id de un pago.
 */
/**
 * El armado del estado de cuenta, con nombre propio.
 *
 * Se separa de su ruta para que `/comprobante` pueda invocarlo sin duplicar las
 * cinco consultas que necesita —los cobros, los excedentes, sus orígenes y la
 * deuda anterior—. Copiarlas sería mantener dos veces lo mismo hasta el día que
 * se separen y el papel diga distinto según por dónde se lo pidió.
 */
const pdfDeFactura = asyncHandler(async (req, res) => {
    const { data: factura, error } = await db()
      .from('v_facturas')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle()

    if (error) throw new AppError(`No se pudo leer la factura: ${error.message}`, { status: 502 })
    if (!factura) throw notFound('No existe esa factura')

    const { data: pagos } = await db()
      .from('v_pagos')
      .select('*')
      .eq('factura_id', factura.id)
      .order('fecha_pago')

    // Los excedentes que salieron de esos cobros. Hacen falta para decir dónde
    // terminó la plata: si sigue a favor o ya se aplicó a otra factura. Sin
    // esto el balance dice "a favor" para siempre, aunque ya se haya usado.
    let excedentes = []
    if (pagos?.length) {
      const { data } = await db()
        .from('v_pagos')
        .select('id, monto, pago_origen_id, factura_id, numero_factura')
        .in('pago_origen_id', pagos.map((p) => p.id))
      excedentes = data ?? []
    }

    // De qué recibo salió cada excedente que se aplicó a esta factura: la fila
    // no tiene número del banco propio —el número es del cobro original— y sin
    // esto queda una columna vacía que parece un dato faltante.
    const origenes = {}
    const idsOrigen = (pagos ?? []).map((p) => p.pago_origen_id).filter(Boolean)
    if (idsOrigen.length) {
      const { data } = await db().from('pagos').select('id, numero').in('id', idsOrigen)
      for (const o of data ?? []) origenes[o.id] = o.numero
    }

    // Lo que el abonado viene debiendo de meses anteriores. Se imprime como
    // "saldo anterior" junto al total: si se le entrega la factura de noviembre
    // sin decir que octubre sigue impago, paga los $34.50 y se va convencido de
    // estar al día —y al mes siguiente discute el corte.
    //
    // Solo meses de servicio: los cables y la instalación se cobran aparte, y
    // meterlos acá haría que la factura del mes pida plata que no es del mes.
    let deudaAnterior = []
    if (factura.client_id && factura.tipo === 'servicios') {
      const { data } = await db()
        .from('v_facturas')
        .select('numero, periodo_desde, fecha_emision, saldo')
        .eq('client_id', factura.client_id)
        .eq('tipo', 'servicios')
        .neq('id', factura.id)
        .lt('fecha_emision', factura.fecha_emision)
        .eq('anulada', false)
        .order('fecha_emision')
      deudaAnterior = (data ?? []).filter((f) => Number(f.saldo) > 0.005)
    }

    const { data: emisor } = await db().from('sri_config').select('*').limit(1).maybeSingle()

    let cliente = null
    if (factura.client_id) {
      const { data } = await db()
        .from('clientes')
        .select('nombre, identificacion, direccion, telefono')
        .eq('id', factura.client_id)
        .maybeSingle()
      cliente = data ?? null
    }

    // La leyenda del ISP: la misma que lleva el PDF que se manda por correo.
    const { data: plantillaRecibo } = await db()
      .from('plantillas_mensaje').select('cuerpo').eq('clave', 'doc_recibo')
      .eq('activa', true).maybeSingle()

    const pdf = await generarFacturaPdf({
      leyenda: leyendaDe(plantillaRecibo?.cuerpo),
      emisor: emisor ?? {},
      factura,
      pagos: pagos ?? [],
      excedentes,
      origenes,
      deudaAnterior,
      cliente,
      logo: logoDe(emisor),
    })

    const nombre = `factura-${String(factura.numero ?? '').padStart(8, '0')}.pdf`
    const disposicion = req.query.descargar === '1' ? 'attachment' : 'inline'

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Length', pdf.length)
    res.setHeader('Content-Disposition', `${disposicion}; filename="${nombre}"`)
    res.send(pdf)
})

router.get('/facturas/:id/pdf', pdfDeFactura)

/**
 * El comprobante que se le entrega al cliente por un cobro.
 *
 * ── Por qué existe esta ruta y no se elige en cada pantalla ──
 *
 * Porque el papel correcto depende del cobro, no de dónde se apretó el botón. Un
 * cobro que saldó una factura se entrega como FACTURA SALDADA —con la banda verde
 * que dice PAGADO, que es lo que deja tranquilo al cliente—; un abono a cuenta o
 * un excedente no tienen factura que mostrar y se entregan como recibo.
 *
 * La primera versión de esto decidía en el navegador, y solo en la pantalla de
 * cobro: los botones de imprimir de las listas seguían sacando el recibo viejo.
 * El mismo cobro salía en dos papeles distintos según por dónde se lo pidiera.
 *
 * Va ANTES de `/:id/recibo` para que el orden de las rutas no la capture.
 */
router.get(
  '/:id/comprobante',
  asyncHandler(async (req, res) => {
    const { data: pago, error } = await db()
      .from('v_pagos').select('id, factura_id').eq('id', req.params.id).maybeSingle()

    if (error) throw new AppError(`No se pudo leer el pago: ${error.message}`, { status: 502 })
    if (!pago) throw notFound('No existe ese pago')

    /**
     * Se reenvía a la ruta que corresponde en vez de duplicar el armado.
     *
     * Las dos rutas tienen su propia consulta —el estado de cuenta necesita los
     * excedentes y la deuda anterior; el recibo, dónde terminó el sobrante— y
     * copiarlas acá sería mantener dos veces lo mismo hasta que se separen.
     */
    if (!pago.factura_id) return pdfDeRecibo(req, res)

    /**
     * El manejador de la factura espera el id de la FACTURA en `:id`.
     *
     * Se lo cambia acá en vez de darle un parámetro nuevo: así los dos siguen
     * siendo rutas normales que se pueden pedir por separado, y esta solo elige
     * cuál.
     */
    req.params.id = pago.factura_id
    return pdfDeFactura(req, res)
  }),
)

/**
 * Recibo de un cobro, en PDF.
 *
 * Se genera al vuelo: el recibo es una función del pago, y guardarlo solo
 * agregaría una copia que puede quedar desactualizada si el cobro se anula.
 */
/** El armado del recibo de cobro, con nombre propio y por la misma razón. */
const pdfDeRecibo = asyncHandler(async (req, res) => {
    const { data: pago, error } = await db()
      .from('v_pagos')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle()

    if (error) throw new AppError(`No se pudo leer el pago: ${error.message}`, { status: 502 })
    if (!pago) throw notFound('No existe ese pago')

    const { data: emisor } = await db().from('sri_config').select('*').limit(1).maybeSingle()

    // El cliente puede haberse borrado después del cobro: el recibo se imprime
    // igual con el nombre que quedó guardado en el pago.
    let cliente = null
    if (pago.client_id) {
      const { data } = await db()
        .from('clientes')
        .select('nombre, identificacion, direccion, telefono')
        .eq('id', pago.client_id)
        .maybeSingle()
      cliente = data ?? null
    }

    // Dónde terminó el sobrante de este cobro. El recibo se reimprime meses
    // después: para entonces esa plata ya puede estar aplicada a otra factura, y
    // el papel tiene que decirlo en vez de prometer un saldo que no existe.
    const { data: destinos } = await db()
      .from('v_pagos')
      .select('monto, factura_id, numero_factura')
      .eq('pago_origen_id', pago.id)
      .eq('anulado', false)

    const pdf = await generarReciboPdf({
      emisor: emisor ?? {},
      pago,
      cliente,
      destinos: destinos ?? [],
      logo: logoDe(emisor),
    })

    const nombre = `recibo-${String(pago.numero ?? pago.id).padStart(6, '0')}.pdf`
    const disposicion = req.query.descargar === '1' ? 'attachment' : 'inline'

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Length', pdf.length)
    res.setHeader('Content-Disposition', `${disposicion}; filename="${nombre}"`)
    res.send(pdf)
})

router.get('/:id/recibo', pdfDeRecibo)

export default router
