import { Router } from 'express'

import { asyncHandler, notFound, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import {
  armarContrato,
  armarHojaInstalacion,
  armarTicket,
  armarRecibo,
  armarReciboPos,
  armarContratoArcotel,
  armarContratoArcotelDeInstalacion,
} from '../services/documentos.js'
import { generarContrato } from '../pagos/contratoPdf.js'
import { generarContratoArcotel } from '../pagos/contratoArcotel.js'
import { generarDocumento, generarTirilla } from '../pagos/documentoPdf.js'

/**
 * Los documentos que se escriben desde el editor de plantillas.
 *
 * Son cuatro: el contrato, la hoja de instalación y la impresión de ticket —los
 * tres que no tenían generador y los tres que son, en el fondo, un texto que el
 * ISP redacta—, más el recibo POS, que es el mismo cobro para la impresora
 * térmica del mostrador.
 *
 * La factura del sistema y el RIDE del SRI se siguen armando en sus propias
 * rutas: ahí el formato no es una preferencia.
 */

const router = Router()
router.use(requireAuth)

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
 * Un nombre de archivo que sobreviva al viaje.
 *
 * Las tildes y la ñ se sacan: un `Content-Disposition` con acentos llega roto a
 * según qué navegador, y el abonado termina con un archivo de nombre ilegible.
 */
function nombreLimpio(texto, porDefecto) {
  const limpio = String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  return limpio || porDefecto
}

function enviarPdf(req, res, pdf, nombre) {
  const disposicion = req.query.descargar === '1' ? 'attachment' : 'inline'
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Length', pdf.length)
  res.setHeader('Content-Disposition', `${disposicion}; filename="${nombre}"`)
  res.send(pdf)
}

/**
 * Lee los datos del documento, traduciendo los fallos a algo que se entienda.
 *
 * El armado falla por dos razones distintas y conviene no confundirlas: que la
 * plantilla esté desactivada es una decisión del ISP —y el mensaje tiene que
 * decírselo— mientras que un id que no existe es un 404 común.
 */
async function armar(fn, id, queEs) {
  let datos
  try {
    datos = await fn(id)
  } catch (e) {
    throw new AppError(e.message, { status: 502 })
  }
  if (!datos) throw notFound(`No existe ${queEs}`)
  return datos
}

/**
 * La vista previa del editor: el texto ya reemplazado, sin armar el PDF.
 *
 * Sirve para que el ISP vea con datos REALES cómo le queda la plantilla que
 * está escribiendo. Una vista previa con datos inventados no muestra lo que
 * importa: que un campo vacío deja una línea coja.
 */
function esVistaPrevia(req, res, datos) {
  if (req.query.texto !== '1') return false
  res.json({ plantilla: datos.plantilla, variables: datos.variables })
  return true
}

/**
 * El contrato de un abonado, en PDF.
 *
 * Se genera al vuelo con el texto que tenga la plantilla en ese momento. Eso es
 * a propósito: si el ISP cambia una cláusula, el próximo contrato que imprima
 * ya sale con la nueva. El que ya firmó alguien es otra cosa — ese está
 * escaneado en `contratos.documento_url` y no lo toca nadie.
 */
router.get(
  '/contrato/:clienteId',
  asyncHandler(async (req, res) => {
    // `?contrato=` para reimprimir uno viejo con las condiciones que tenía.
    const datos = await armar(
      (id) => armarContrato(id, req.query.contrato || null),
      req.params.clienteId,
      'ese abonado',
    )
    if (esVistaPrevia(req, res, datos)) return

    const pdf = await generarContrato({
      plantilla: datos.plantilla,
      empresa: datos.empresa,
      cliente: datos.cliente,
      contrato: datos.contrato,
      logo: logoDe(datos.empresa),
    })

    enviarPdf(req, res, pdf, `contrato-${nombreLimpio(datos.cliente.nombre, 'abonado')}.pdf`)
  }),
)

/**
 * El contrato de adhesión de la ARCOTEL, con sus cuatro anexos.
 *
 * ── Por qué es una ruta aparte del contrato simple ──
 *
 * Porque son dos documentos distintos con dos reglas distintas. El de arriba lo
 * redacta el ISP en el editor; este es un modelo inscrito ante el regulador y su
 * texto no se toca. Un ISP fuera de Ecuador usa el primero; uno de acá, este.
 *
 * Devuelve un PDF de nueve hojas con el contrato, los anexos 1f, 2 y 3, y el
 * acta de entrega. El abonado los firma todos.
 */
router.get(
  '/contrato-arcotel/:clienteId',
  asyncHandler(async (req, res) => {
    const datos = await armar(
      (id) => armarContratoArcotel(id, req.query.contrato || null),
      req.params.clienteId,
      'ese abonado',
    )

    /**
     * `?revisar=1` dice qué quedaría en blanco, sin armar el PDF.
     *
     * Lo usa la pantalla para avisar ANTES de imprimir. Un contrato con huecos
     * se puede llenar a mano, pero el que imprime no revisa las nueve hojas
     * antes de salir: el hueco aparece con el abonado enfrente.
     */
    if (req.query.revisar === '1') {
      res.json({
        faltantes: datos.faltantes,
        prestador: datos.prestador.nombre_comercial || datos.prestador.razon_social,
        hojas: 5,
      })
      return
    }

    const pdf = await generarContratoArcotel({ ...datos, logo: logoDe(datos.empresa) })

    enviarPdf(req, res, pdf, `contrato-${nombreLimpio(datos.cliente.nombre, 'abonado')}.pdf`)
  }),
)

/**
 * El mismo contrato, para quien TODAVÍA NO ES ABONADO.
 *
 * El contrato se firma antes del alta. Los datos son los que el vendedor cargó
 * en la orden de trabajo; lo que no preguntó queda en blanco para llenarlo a
 * mano el día de la firma.
 */
router.get(
  '/contrato-arcotel/orden/:instalacionId',
  asyncHandler(async (req, res) => {
    const datos = await armar(
      armarContratoArcotelDeInstalacion,
      req.params.instalacionId,
      'esa orden',
    )

    if (req.query.revisar === '1') {
      res.json({
        faltantes: datos.faltantes,
        prestador: datos.prestador.nombre_comercial || datos.prestador.razon_social,
        hojas: 5,
      })
      return
    }

    const pdf = await generarContratoArcotel({ ...datos, logo: logoDe(datos.empresa) })

    enviarPdf(req, res, pdf, `contrato-${nombreLimpio(datos.cliente.nombre, 'prospecto')}.pdf`)
  }),
)

/**
 * La hoja de instalación, en PDF.
 *
 * Lleva la firma que el abonado dejó en la tablet dibujada sobre la raya. Ese
 * es el punto del documento: la firma ya se guardaba y no la veía nadie.
 */
router.get(
  '/instalacion/:id',
  asyncHandler(async (req, res) => {
    const datos = await armar(armarHojaInstalacion, req.params.id, 'esa instalación')
    if (esVistaPrevia(req, res, datos)) return

    const pdf = await generarDocumento({
      plantilla: datos.plantilla,
      empresa: datos.empresa,
      logo: logoDe(datos.empresa),
      firmas: [datos.firma],
      pie: datos.variables.orden ? `Orden ${datos.variables.orden}` : '',
    })

    enviarPdf(req, res, pdf, `instalacion-${nombreLimpio(datos.variables.orden || datos.variables.nombre, 'orden')}.pdf`)
  }),
)

/**
 * La impresión de un reporte de soporte, en PDF.
 *
 * Es lo que se le deja en la mano al abonado cuando el técnico se va.
 */
router.get(
  '/ticket/:id',
  asyncHandler(async (req, res) => {
    const datos = await armar(armarTicket, req.params.id, 'ese reporte')
    if (esVistaPrevia(req, res, datos)) return

    const pdf = await generarDocumento({
      plantilla: datos.plantilla,
      empresa: datos.empresa,
      logo: logoDe(datos.empresa),
      // Solo se pide firma cuando hay algo que conformar: un reporte recién
      // abierto no tiene atención que aprobar, y una raya vacía invita a que
      // alguien la firme igual.
      firmas: datos.ticket.firma_b64 || datos.ticket.solucion ? [datos.firma] : [],
      pie: datos.variables.ticket ? `Reporte N° ${datos.variables.ticket}` : '',
    })

    enviarPdf(req, res, pdf, `ticket-${nombreLimpio(datos.variables.ticket || datos.variables.nombre, 'reporte')}.pdf`)
  }),
)

/**
 * El recibo de un cobro escrito desde su plantilla, en PDF.
 *
 * ── Por qué hay dos recibos y no uno ──
 *
 * El de `/api/pagos/:id/recibo` sigue siendo el que se usa por defecto: original
 * y copia en la misma hoja, el monto en letras, el detalle de los excedentes y
 * la marca de anulado. Este es para el ISP que prefiere redactar el suyo.
 *
 * Quitar el primero para imponer este sería cambiarle a alguien un documento que
 * ya funciona por uno que todavía tiene que escribir.
 */
router.get(
  '/recibo/:pagoId',
  asyncHandler(async (req, res) => {
    const datos = await armar(armarRecibo, req.params.pagoId, 'ese pago')
    if (esVistaPrevia(req, res, datos)) return

    const pdf = await generarDocumento({
      plantilla: datos.plantilla,
      empresa: datos.empresa,
      logo: logoDe(datos.empresa),
      firmas: [{ nombre: datos.variables.nombre, pie: 'Recibí conforme' }],
      pie: datos.variables.numero ? `Recibo N° ${datos.variables.numero}` : '',
    })

    enviarPdf(req, res, pdf, `recibo-${nombreLimpio(datos.variables.numero, 'cobro')}.pdf`)
  }),
)

/**
 * El recibo en tirilla, como TEXTO.
 *
 * ── Por qué no es un PDF ──
 *
 * Porque una térmica de 58 mm recibe líneas y las escupe. Mandarle un PDF
 * obligaría al navegador a abrir un diálogo de impresión con márgenes de hoja
 * A4, que es justo lo que estorba cuando alguien está cobrando en el mostrador.
 *
 * `?ancho=48` para las de 80 mm.
 */
router.get(
  '/recibo-pos/:pagoId',
  asyncHandler(async (req, res) => {
    const datos = await armar(armarReciboPos, req.params.pagoId, 'ese pago')
    if (esVistaPrevia(req, res, datos)) return

    const ancho = Number(req.query.ancho) === 48 ? 48 : 32
    const tirilla = generarTirilla({ plantilla: datos.plantilla, ancho })

    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.send(tirilla)
  }),
)

export default router
