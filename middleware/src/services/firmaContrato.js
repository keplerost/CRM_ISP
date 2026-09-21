import crypto from 'node:crypto'

import { db } from '../lib/db.js'
import { decrypt } from '../lib/crypto.js'
import { armarContratoArcotel, armarContratoArcotelDeInstalacion } from './documentos.js'
import { generarContratoArcotel } from '../pagos/contratoArcotel.js'

/**
 * La firma del contrato: electrónica por API, o en papel.
 *
 * ── La regla que gobierna todo este archivo ──
 *
 * NADA acá puede dejar a alguien esperando. Quien manda a firmar está con el
 * cliente delante; si el proveedor no contesta, lo que necesita no es un
 * reintento eterno sino que le digan "imprimilo y hacelo firmar a mano".
 *
 * Por eso cada llamada al proveedor tiene su tiempo máximo, cada fallo deja
 * escrito qué pasó, y el fallback al papel no requiere apagar nada para los
 * demás.
 *
 * ── Lo que este archivo NO hace ──
 *
 * Poner un contrato en "firmado" por su cuenta. Eso solo pasa con la
 * confirmación del proveedor o con el escaneo del papel validado en oficina. La
 * base lo exige y acá no se intenta esquivarlo.
 */

/** La configuración del trámite de firma. */
export async function configuracion() {
  const { data, error } = await db().from('config_firma').select('*').eq('id', 1).maybeSingle()
  if (error) throw new Error(`No se pudo leer la configuración de firma: ${error.message}`)

  return data ?? {
    api_habilitada: false,
    timeout_segundos: 30,
    vigencia_horas: 72,
  }
}

/**
 * El contrato que se va a firmar, y su huella.
 *
 * ── Por qué se calcula el hash ──
 *
 * Porque el contrato se arma con el plan, el precio y la permanencia del
 * momento, y esos cambian. Sin la huella de lo que se mandó a firmar, dentro de
 * un año no habría manera de demostrar que lo firmado es lo que se generó y no
 * una versión posterior.
 */
export async function contratoParaFirmar({ instalacionId = null, clienteId = null }) {
  const datos = instalacionId
    ? await armarContratoArcotelDeInstalacion(instalacionId)
    : await armarContratoArcotel(clienteId)

  if (!datos) return null

  const pdf = await generarContratoArcotel(datos)
  return {
    datos,
    pdf,
    /**
     * Dónde va cada firma en el PDF.
     *
     * Las calcula el generador mientras dibuja las rayas: son siete —dos en el
     * contrato, dos en el anexo 1f, y una en cada uno de los otros tres—. Se le
     * mandan al proveedor con el documento para que estampe donde corresponde.
     */
    posiciones: pdf.posicionesDeFirma ?? [],
    hash: crypto.createHash('sha256').update(pdf).digest('hex'),
  }
}

/**
 * Le pide al proveedor un enlace de firma.
 *
 * ── El tiempo máximo no es una precaución, es el requisito ──
 *
 * `fetch` sin `AbortSignal` espera lo que el sistema operativo quiera —minutos—
 * y durante ese rato la pantalla se queda colgada. Con el corte, pasado el
 * tiempo configurado la promesa se rechaza y quien vende puede seguir.
 *
 * ── Sobre el formato de la llamada ──
 *
 * Todavía no hay proveedor contratado, así que esto es el contrato mínimo que
 * cualquiera de ellos cumple: se manda el documento y a quién hay que
 * verificar, y se espera un identificador de trámite y una URL. Cuando se
 * cierre con el proveedor real, lo que cambia es esta función y nada más.
 */
async function pedirEnlace({ config, pdf, datos, posiciones = [] }) {
  if (!config.api_url) {
    throw new Error(
      'La firma electrónica está encendida pero no tiene URL del proveedor. Cargala en Ajustes → Firma, o apagala para firmar en papel.',
    )
  }

  const corte = AbortSignal.timeout(Math.max(5, Number(config.timeout_segundos) || 30) * 1000)

  let clave = null
  if (config.api_key_encrypted) {
    try {
      clave = decrypt(config.api_key_encrypted)
    } catch {
      throw new Error('La clave del proveedor de firma no se pudo descifrar. Volvé a cargarla en Ajustes.')
    }
  }

  const cliente = datos.cliente ?? {}

  let respuesta
  try {
    respuesta = await fetch(config.api_url, {
      method: 'POST',
      signal: corte,
      headers: {
        'Content-Type': 'application/json',
        ...(clave ? { Authorization: `Bearer ${clave}` } : {}),
      },
      body: JSON.stringify({
        documento_base64: pdf.toString('base64'),
        documento_nombre: 'contrato-de-adhesion.pdf',
        firmante: {
          nombre: cliente.nombre ?? '',
          identificacion: cliente.identificacion ?? '',
          email: cliente.email ?? '',
          telefono: cliente.telefono ?? '',
        },
        // Lo que pediste del proveedor: huella y rostro.
        verificacion: ['huella', 'rostro'],
        vigencia_horas: config.vigencia_horas ?? 72,

        /**
         * Dónde estampar cada firma, en coordenadas del formato PDF.
         *
         * El origen es la esquina INFERIOR izquierda, que es el sistema del
         * estándar. Mandar las de pdfkit —origen arriba— pondría cada firma
         * reflejada de arriba abajo, y eso no se nota hasta que llega el primer
         * contrato firmado.
         *
         * Se mandan aunque el proveedor las tenga configuradas de antemano: si
         * las acepta por documento, siempre van a estar bien; si las ignora,
         * no molesta.
         */
        firmas: posiciones.map((p) => ({
          pagina: p.pagina,
          x: p.x,
          y: p.desde_abajo,
          ancho: p.ancho,
          alto: 40,
          etiqueta: `${p.seccion} — ${p.quien}`,
        })),
      }),
    })
  } catch (e) {
    /**
     * Los tres fallos se cuentan igual porque para quien vende son lo mismo.
     *
     * Timeout, servicio caído o DNS que no resuelve: en los tres casos el enlace
     * no existe y hay que ofrecer el papel. Distinguirlos en la pantalla sería
     * pedirle a un vendedor que interprete un error de red.
     */
    const motivo = e.name === 'TimeoutError' || e.name === 'AbortError'
      ? `el proveedor no respondió en ${config.timeout_segundos} segundos`
      : `no se pudo contactar al proveedor (${e.message})`
    throw new Error(motivo)
  }

  if (!respuesta.ok) {
    const detalle = await respuesta.text().catch(() => '')
    throw new Error(`el proveedor rechazó el pedido (${respuesta.status}) ${detalle}`.trim())
  }

  const json = await respuesta.json().catch(() => ({}))
  const referencia = json.id ?? json.referencia ?? json.transaction_id ?? null
  const enlace = json.url ?? json.enlace ?? json.signing_url ?? null

  if (!referencia || !enlace) {
    throw new Error('el proveedor contestó sin identificador de trámite o sin enlace')
  }

  return { referencia, enlace }
}

/**
 * Manda un contrato a firmar.
 *
 * Devuelve el trámite creado, haya salido bien o mal. Que la API falle NO es un
 * error de esta función: es un resultado, y queda escrito para que la pantalla
 * ofrezca el papel.
 */
export async function solicitarFirma({
  instalacionId = null,
  clienteId = null,
  contratoId = null,
  usuarioId = null,
}) {
  if (!instalacionId && !clienteId) {
    throw new Error('Falta decir de qué venta o de qué abonado es el contrato')
  }

  const config = await configuracion()
  const armado = await contratoParaFirmar({ instalacionId, clienteId })
  if (!armado) return null

  const base = {
    instalacion_id: instalacionId,
    client_id: clienteId ?? armado.datos.cliente?.id ?? null,
    contrato_id: contratoId,
    contenido_hash: armado.hash,
    firmante_nombre: armado.datos.cliente?.nombre ?? null,
    firmante_identificacion: armado.datos.cliente?.identificacion ?? null,
    creado_por: usuarioId,
  }

  /**
   * Con la API apagada ni se intenta.
   *
   * El trámite nace como manual y en pendiente: falta que alguien lo autorice.
   * Nacer autorizado saltearía el control que el propio flujo pide.
   */
  if (!config.api_habilitada) {
    return insertar({ ...base, metodo: 'manual', estado: 'pendiente' })
  }

  try {
    const { referencia, enlace } = await pedirEnlace({
      config,
      pdf: armado.pdf,
      datos: armado.datos,
      posiciones: armado.posiciones,
    })

    return insertar({
      ...base,
      metodo: 'electronica_api',
      estado: 'enviado',
      proveedor: config.proveedor ?? null,
      referencia_proveedor: referencia,
      enlace_firma: enlace,
      enviado_en: new Date().toISOString(),
      vence_en: new Date(Date.now() + (config.vigencia_horas ?? 72) * 3600_000).toISOString(),
    })
  } catch (e) {
    // El fallo se guarda, no se propaga: es lo que habilita el papel para ESTE
    // contrato sin apagar la API para los demás.
    return insertar({
      ...base,
      metodo: 'electronica_api',
      estado: 'fallido',
      proveedor: config.proveedor ?? null,
      error_api: e.message,
    })
  }
}

async function insertar(fila) {
  const { data, error } = await db().from('firmas_contrato').insert(fila).select('*').single()
  if (error) throw new Error(`No se pudo registrar el trámite de firma: ${error.message}`)
  return data
}

/**
 * Lo que el proveedor avisa cuando el abonado firmó.
 *
 * ── Por qué se busca por la referencia y no por el id del trámite ──
 *
 * Porque el proveedor no conoce nuestros ids: conoce el suyo, el que nos
 * devolvió al crear el trámite. Aceptar un id nuestro en un endpoint público
 * permitiría marcar como firmado cualquier contrato conociendo un UUID.
 */
export async function confirmarDesdeProveedor({ referencia, estado, documentoUrl = null, firmadoEn = null }) {
  if (!referencia) throw new Error('El aviso del proveedor no dice de qué trámite es')

  const { data: tramite, error } = await db()
    .from('firmas_contrato')
    .select('*')
    .eq('referencia_proveedor', referencia)
    .maybeSingle()

  if (error) throw new Error(`No se pudo buscar el trámite: ${error.message}`)
  if (!tramite) return null

  /**
   * Un trámite ya cerrado no se reabre.
   *
   * Los proveedores reintentan sus avisos cuando no reciben respuesta a tiempo,
   * así que el mismo "firmado" puede llegar tres veces. Y un aviso tardío de
   * "vencido" sobre algo ya firmado daría por no firmado un contrato que el
   * abonado firmó.
   */
  if (tramite.estado === 'firmado') return tramite

  const nuevo = { firmado: 'firmado', rechazado: 'rechazado', vencido: 'vencido' }[estado]
  if (!nuevo) throw new Error(`El proveedor avisó un estado que no se entiende: ${estado}`)

  const cambios = { estado: nuevo, actualizado_en: new Date().toISOString() }
  if (nuevo === 'firmado') {
    cambios.fecha_firma = firmadoEn ?? new Date().toISOString()
    if (documentoUrl) cambios.documento_firmado_url = documentoUrl
  }

  const { data, error: errUpd } = await db()
    .from('firmas_contrato')
    .update(cambios)
    .eq('id', tramite.id)
    .select('*')
    .single()

  if (errUpd) throw new Error(`No se pudo actualizar el trámite: ${errUpd.message}`)
  return data
}

/**
 * Si este usuario puede habilitar la firma en papel.
 *
 * Vale por rol —la lista que el ISP configura— o por un permiso explícito, que
 * es la manera de dárselo a alguien de oficina sin convertirlo en administrador.
 *
 * Sin legajo cargado NO se deja pasar, y acá sí se es estricto: quien llega por
 * esta puerta ya se identificó con su sesión, así que "no encontré tu legajo"
 * significa que algo está mal, no que el sistema esté a medio migrar.
 */
export async function comprobarQuePuedeAutorizar(usuarioId) {
  if (!usuarioId) {
    throw new Error(
      'No se puede registrar quién autorizó la firma en papel: tu usuario no tiene legajo en el sistema.',
    )
  }

  const [{ data: usuario }, config] = await Promise.all([
    db().from('usuarios_sistema').select('rol, permisos, activo, nombre').eq('id', usuarioId).maybeSingle(),
    configuracion(),
  ])

  if (!usuario?.activo) throw new Error('Tu usuario no está activo.')

  const permisos = Array.isArray(usuario.permisos) ? usuario.permisos : []
  const roles = Array.isArray(config.roles_autorizan) ? config.roles_autorizan : []

  const puede = permisos.includes('*')
    || permisos.includes('contratos.firma_manual')
    || roles.includes(usuario.rol)

  if (!puede) {
    throw new Error(
      `Tu usuario (${usuario.rol}) no puede habilitar la firma en papel. Pedíselo a: ${roles.join(', ')}. `
      + 'Habilitar el papel saltea la verificación biométrica y tiene que quedar registrado quién lo permitió.',
    )
  }

  return usuario
}

/**
 * Habilita la firma en papel para un contrato puntual.
 *
 * Quién puede hacerlo lo decide la base: la comprobación vive en un disparador
 * porque esconder el botón en la pantalla no alcanza — quien tenga la clave del
 * navegador puede escribir en la tabla igual, y la autorización es justamente lo
 * que hay que poder demostrar después.
 */
export async function autorizarManual({ firmaId, usuarioId, motivo = null }) {
  /**
   * El rol se comprueba ACÁ y no solo en la base.
   *
   * El disparador de la 148 usa `auth.uid()`, y desde el middleware eso es NULL:
   * el servidor habla con la clave de servicio, no con la sesión de nadie. La
   * función deja pasar en ese caso a propósito —para no dejar inutilizable una
   * instalación a medio migrar— y el resultado es que el disparador NO protege
   * este camino.
   *
   * Lo detectó una prueba contra la base: un usuario con rol `vendedor` autorizó
   * una firma manual, y la lista dice `super_admin` y `admin`.
   *
   * La comprobación de la base sigue estando: cubre a quien escriba en la tabla
   * desde el navegador. Esta cubre a quien pase por acá.
   */
  await comprobarQuePuedeAutorizar(usuarioId)

  const { data, error } = await db()
    .from('firmas_contrato')
    .update({
      metodo: 'manual',
      estado: 'pendiente',
      autorizado_por: usuarioId,
      autorizado_en: new Date().toISOString(),
      motivo_manual: motivo,
    })
    .eq('id', firmaId)
    .select('*')
    .single()

  if (error) throw new Error(`No se pudo habilitar la firma en papel: ${error.message}`)
  return data
}

/**
 * Registra el papel firmado que llegó a oficina.
 *
 * Es el único camino por el que un contrato manual queda firmado, y exige las
 * tres cosas: el escaneo, quién lo recibió y que alguien haya autorizado el
 * papel antes. Sin eso la base lo rechaza.
 */
export async function registrarFirmaManual({ firmaId, documentoUrl, validadoPor, firmadoEn = null }) {
  if (!documentoUrl) {
    throw new Error('Falta el escaneo del contrato firmado: es lo que respalda la firma en papel')
  }

  const { data, error } = await db()
    .from('firmas_contrato')
    .update({
      estado: 'firmado',
      fecha_firma: firmadoEn ?? new Date().toISOString(),
      documento_firmado_url: documentoUrl,
      validado_por: validadoPor,
      validado_en: new Date().toISOString(),
    })
    .eq('id', firmaId)
    .select('*')
    .single()

  if (error) {
    /**
     * Los mensajes de la base son exactos y no se entienden sin conocerla.
     *
     * "violates check constraint firmas_firmado_completo" es correcto y no le
     * dice nada a quien está en el mostrador con el papel en la mano.
     */
    if (/firmas_manual_autorizada/.test(error.message)) {
      throw new Error(
        'Este contrato no tiene autorizada la firma en papel. Un administrador tiene que habilitarla primero.',
      )
    }
    if (/firmas_firmado_completo/.test(error.message)) {
      throw new Error(
        'Falta el escaneo del contrato firmado o quién lo validó: sin las dos cosas no se puede dar por firmado.',
      )
    }
    throw new Error(`No se pudo registrar la firma: ${error.message}`)
  }
  return data
}

/**
 * Marca vencidos los trámites cuyo enlace ya no vale.
 *
 * Sin esto, un enlace de hace un mes sigue figurando como "esperando al
 * abonado", y mientras diga eso nadie le ofrece el papel: el contrato no se
 * firma nunca.
 */
export async function vencerPendientes() {
  const { data, error } = await db().rpc('vencer_firmas_pendientes')
  if (error) throw new Error(`No se pudieron vencer los trámites: ${error.message}`)
  return { vencidos: data ?? 0 }
}

/** Los trámites de una venta o de un abonado, con lo que la pantalla necesita. */
export async function tramitesDe({ instalacionId = null, clienteId = null }) {
  let consulta = db().from('v_firmas_contrato').select('*').order('creado_en', { ascending: false })

  if (instalacionId) consulta = consulta.eq('instalacion_id', instalacionId)
  else if (clienteId) consulta = consulta.eq('client_id', clienteId)
  else return []

  const { data, error } = await consulta
  if (error) throw new Error(`No se pudieron leer los trámites de firma: ${error.message}`)
  return data ?? []
}
