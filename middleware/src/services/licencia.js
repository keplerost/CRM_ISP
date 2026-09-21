import { createPublicKey, verify as verificarFirma } from 'node:crypto'
import { config } from '../config.js'
import { db } from '../lib/db.js'
import { AppError, badRequest } from '../lib/errors.js'
import { olvidarCache } from '../lib/guardLicencia.js'

/**
 * La licencia de esta instalación.
 *
 * El sistema se vende por abonado y se cobra por mes. Esto es lo que decide si
 * la instalación está habilitada.
 *
 * ── Por qué un permiso firmado y no una consulta ──
 *
 * Lo intuitivo sería preguntarle al servidor del vendedor, en cada arranque, si
 * este cliente está al día. Es una trampa: el día que ese servidor no conteste
 * —se cayó, se venció su dominio, o simplemente el ISP se quedó sin internet—
 * un ISP entero se queda sin poder facturar ni reconectar a nadie. Por un
 * problema del vendedor, no del cliente. Un solo episodio así cuesta el cliente
 * y la reputación.
 *
 * Por eso el vendedor entrega un permiso FIRMADO con vencimiento: "esta
 * instalación, hasta N abonados, hasta el 15 de septiembre". La instalación lo
 * guarda y lo verifica sola, sin red. Intenta renovarlo todos los días; si no
 * puede, sigue trabajando con el que tiene hasta que se venza.
 *
 *   El cliente paga        → se renueva solo
 *   El cliente no paga     → el permiso vence y ahí sí se bloquea
 *   Se cae el vendedor     → no pasa nada
 *   Se cae el internet     → no pasa nada
 *
 * ── Qué tan a prueba de copias es ──
 *
 * Nada instalado en la máquina de otro es infalsificable: quien tiene el
 * servidor puede editar el código. Lo que esto sí garantiza es que no se pueda
 * extender la licencia sin la clave privada del vendedor —que nunca sale de su
 * poder—, y que copiar la instalación a otro servidor no multiplique la
 * licencia: el identificador viaja con la base y el permiso está atado a él.
 */

/**
 * ¿Esta copia está bajo licencia?
 *
 * Solo si tiene cargada la clave pública del vendedor. Y eso importa muchísimo:
 *
 * El vendedor corre SU PROPIA instalación —la usa para su ISP, y para
 * desarrollar—, y esa copia no se licencia a sí misma. Lo mismo cualquier
 * ambiente de prueba. Si el licenciamiento estuviera siempre encendido,
 * actualizar a esta versión bloquearía en el acto cualquier instalación
 * existente, la del propio vendedor incluida. Ya pasó una vez.
 *
 * La clave se pone recién cuando se le entrega una copia a un cliente. Antes de
 * eso, no hay nada que verificar y nada que bloquear.
 *
 * No es un agujero: quien tiene el servidor puede borrar esa línea del .env,
 * pero también puede editar este archivo. Contra alguien con acceso de raíz no
 * hay software autoalojado que se defienda. Lo que sí garantiza la firma es que
 * no se pueda ESTIRAR una licencia sin la clave privada del vendedor.
 */
export const bajoLicencia = () => Boolean(config.licencia.clavePublica)

const b64urlADato = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')

/**
 * Abre el permiso y comprueba su firma.
 *
 * Devuelve el contenido solo si la firma es del vendedor. Cualquier otra cosa
 * —token inventado, payload editado a mano para correr la fecha, firma de otra
 * clave— cae acá y no llega a habilitar nada.
 */
export function abrirToken(token, { clavePublica = config.licencia.clavePublica } = {}) {
  if (!token) return { ok: false, motivo: 'Esta instalación no tiene licencia cargada.' }

  const partes = String(token).trim().split('.')
  if (partes.length !== 2) {
    return { ok: false, motivo: 'El código de licencia está incompleto o mal copiado.' }
  }

  if (!clavePublica) {
    // Sin clave pública no se puede verificar NADA. Aceptar en ese caso
    // convertiría un error de instalación en una licencia gratis para siempre.
    return {
      ok: false,
      motivo: 'Esta instalación no tiene la clave de verificación de licencias.',
    }
  }

  let contenido
  try {
    const firmaOk = verificarFirma(
      null,
      Buffer.from(partes[0]),
      createPublicKey(clavePublica),
      b64urlADato(partes[1]),
    )
    if (!firmaOk) return { ok: false, motivo: 'La firma de la licencia no es válida.' }
    contenido = JSON.parse(b64urlADato(partes[0]).toString('utf8'))
  } catch {
    return { ok: false, motivo: 'La licencia no se pudo leer.' }
  }

  return { ok: true, contenido }
}

/**
 * Cuántos abonados ocupan licencia.
 *
 * Cuentan los ACTIVOS y los CORTADOS por morosidad. El cortado sigue en la
 * base, ocupando un puerto, una IP y una fila que el ISP administra: no deja de
 * ser un cliente porque deba dos meses. Además, contar solo los activos abre un
 * agujero evidente —cortar a todos el día del conteo— que terminaría en
 * discusiones cada mes.
 *
 * Los suspendidos (baja temporal pedida por el abonado) y las bajas NO cuentan.
 */
export async function contarAbonados() {
  const { count, error } = await db()
    .from('clientes')
    .select('id', { count: 'exact', head: true })
    .in('estado', ['activo', 'cortado'])

  if (error) throw new AppError(`No se pudo contar los abonados: ${error.message}`, { status: 502 })
  return count ?? 0
}

/** La fila de licencia. Se crea si todavía no existe. */
export async function cargarFila() {
  const { data, error } = await db().from('licencia').select('*').eq('id', 1).maybeSingle()
  if (error) throw new AppError(`No se pudo leer la licencia: ${error.message}`, { status: 502 })
  if (data) return data

  const { data: creada, error: errCrear } = await db()
    .from('licencia')
    .insert({ id: 1 })
    .select()
    .single()
  if (errCrear) {
    throw new AppError(`No se pudo iniciar la licencia: ${errCrear.message}`, { status: 502 })
  }
  return creada
}

const diasEntre = (desde, hasta) => Math.ceil((hasta - desde) / 86400000)

/**
 * El estado completo de la licencia: si habilita, hasta cuándo, y por qué no
 * cuando no.
 *
 * `ahora` se puede pasar para poder probar los vencimientos sin esperar un mes.
 */
export async function estado({ ahora = new Date() } = {}) {
  const fila = await cargarFila()
  const abonados = await contarAbonados()

  const base = {
    instalacion: fila.instalacion,
    abonados,
    ultimo_contacto: fila.ultimo_contacto,
    ultimo_error: fila.ultimo_error,
  }

  // Sin clave del vendedor, esta copia no está licenciada: es la del propio
  // vendedor o un ambiente de prueba. Habilita y no molesta.
  if (!bajoLicencia()) return { ...base, habilitada: true, gestionada: false }

  const leido = abrirToken(fila.token)
  if (!leido.ok) return { ...base, habilitada: false, motivo: leido.motivo }

  const lic = leido.contenido

  // El permiso es de OTRA instalación. Pasa al restaurar el respaldo de un
  // cliente en el servidor de otro; decirlo con nombre y apellido evita una
  // tarde de diagnóstico.
  if (lic.instalacion && lic.instalacion !== fila.instalacion) {
    return {
      ...base,
      habilitada: false,
      motivo: 'Esta licencia fue emitida para otra instalación del sistema.',
    }
  }

  const vence = new Date(lic.vence)
  if (Number.isNaN(vence.getTime())) {
    return { ...base, habilitada: false, motivo: 'La licencia no tiene una fecha de vencimiento válida.' }
  }

  const datos = {
    ...base,
    isp: lic.isp ?? null,
    clientes_max: lic.clientes_max ?? null,
    vence: vence.toISOString(),
    dias_restantes: diasEntre(ahora, vence),
  }

  // El margen no es un regalo: es lo que absorbe el pago hecho un viernes a la
  // tarde que se acredita el lunes. Sin él, el cliente que pagó en fecha igual
  // amanece bloqueado.
  const limite = new Date(vence.getTime() + config.licencia.graciaDias * 86400000)
  if (ahora > limite) {
    return { ...datos, habilitada: false, vencida: true, motivo: 'La licencia venció.' }
  }

  // Pasarse de abonados NO bloquea. Un ISP que creció es un ISP que quiere
  // pagar más, no uno al que hay que apagarle el sistema: se le avisa y se le
  // vende el plan que le corresponde. Bloquearlo sería castigar justo al mejor
  // cliente, y encima el día que más lo necesita.
  const excedido = lic.clientes_max != null && abonados > lic.clientes_max
  const enGracia = ahora > vence

  return {
    ...datos,
    habilitada: true,
    en_gracia: enGracia,
    excedido,
    ...(excedido
      ? { aviso: `Tenés ${abonados} abonados y la licencia cubre ${lic.clientes_max}.` }
      : {}),
  }
}

/**
 * Guarda un permiso pegado a mano.
 *
 * Es el camino que siempre funciona: si el ISP se quedó sin internet, o el
 * servidor de licencias todavía no existe, el vendedor manda el código por
 * WhatsApp y el cliente lo pega acá.
 *
 * Se verifica ANTES de guardarlo. Guardar un token inválido y descubrirlo en el
 * próximo arranque deja al cliente bloqueado creyendo que ya lo activó.
 */
export async function activar(token) {
  if (!bajoLicencia()) {
    throw badRequest('Esta instalación no está bajo licencia.', {
      hint: 'Falta LICENCIA_CLAVE_PUBLICA en middleware/.env. Sin eso no hay nada que activar.',
    })
  }

  const leido = abrirToken(token)
  if (!leido.ok) throw badRequest(leido.motivo)

  const fila = await cargarFila()
  const lic = leido.contenido

  if (lic.instalacion && lic.instalacion !== fila.instalacion) {
    throw badRequest('Esa licencia fue emitida para otra instalación.', {
      hint: `El identificador de esta instalación es ${fila.instalacion}. Pedile al proveedor una licencia para ese código.`,
    })
  }

  const { error } = await db()
    .from('licencia')
    .update({
      token: String(token).trim(),
      ultimo_contacto: new Date().toISOString(),
      ultimo_error: null,
      actualizado_en: new Date().toISOString(),
    })
    .eq('id', 1)

  if (error) throw new AppError(`No se pudo guardar la licencia: ${error.message}`, { status: 502 })

  // El guardián cachea un minuto. Sin esto, activar la licencia y seguir
  // bloqueado durante un minuto se lee como que el código no sirvió.
  olvidarCache()
  return estado()
}

/**
 * Le pide al vendedor un permiso al día.
 *
 * Le informa cuántos abonados tiene, que es lo que se factura. Si falla no
 * lanza: no poder renovar hoy no es un error del ISP ni algo que deba
 * interrumpirle el trabajo — el permiso vigente sigue valiendo. Se anota el
 * motivo para poder explicarlo cuando alguien pregunte.
 */
export async function renovar({ ahora = new Date() } = {}) {
  const fila = await cargarFila()

  if (!config.licencia.servidor) {
    return { renovada: false, motivo: 'No hay servidor de licencias configurado.' }
  }

  let nuevo = null
  let fallo = null
  try {
    const r = await fetch(`${config.licencia.servidor.replace(/\/$/, '')}/licencia/renovar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        instalacion: fila.instalacion,
        abonados: await contarAbonados(),
        version: 1,
      }),
      signal: AbortSignal.timeout(15000),
    })

    if (!r.ok) {
      // 402 es "no pagó". Es una respuesta legítima del servidor, no una falla
      // de red: se anota tal cual para poder decirle al cliente por qué no se
      // renovó, en vez de un "error de conexión" que lo manda a revisar su
      // internet.
      const cuerpo = await r.text().catch(() => '')
      fallo = r.status === 402 ? 'El proveedor informa que la licencia no está al día.' : `El servidor de licencias respondió ${r.status}. ${cuerpo}`.trim()
    } else {
      nuevo = (await r.json())?.token ?? null
    }
  } catch (err) {
    fallo = `No se pudo contactar al servidor de licencias: ${err.message}`
  }

  // Un token nuevo que no verifica es peor que ninguno: pisaría el que hoy
  // funciona y dejaría al cliente bloqueado sin haber hecho nada.
  if (nuevo) {
    const leido = abrirToken(nuevo)
    if (!leido.ok) {
      nuevo = null
      fallo = `El servidor de licencias mandó un permiso que no se pudo verificar: ${leido.motivo}`
    }
  }

  const { error } = await db()
    .from('licencia')
    .update({
      ...(nuevo ? { token: nuevo } : {}),
      ultimo_contacto: ahora.toISOString(),
      ultimo_error: fallo,
      actualizado_en: ahora.toISOString(),
    })
    .eq('id', 1)

  if (error) throw new AppError(`No se pudo guardar la licencia: ${error.message}`, { status: 502 })
  return { renovada: Boolean(nuevo), motivo: fallo }
}

/**
 * Renovación diaria.
 *
 * Todos los días, no una vez por mes: así hay treinta oportunidades de que un
 * pago se refleje antes del vencimiento, y una racha de internet malo no
 * alcanza para bloquear a nadie.
 */
export function programarRenovacion() {
  if (!config.licencia.servidor) return null

  const correr = () =>
    renovar().catch((err) => console.error('[licencia] no se pudo renovar:', err.message))

  correr()
  const t = setInterval(correr, 24 * 60 * 60 * 1000)
  t.unref?.()
  return t
}
