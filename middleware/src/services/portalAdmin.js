import { db } from '../lib/db.js'
import { AppError, notFound } from '../lib/errors.js'
import { decrypt } from '../lib/crypto.js'
import { generarClaveLegible, hashearClave } from '../lib/clave.js'

/**
 * El portal visto desde la oficina del ISP.
 *
 * Tres cosas, en orden de urgencia:
 *
 *   LA COLA DE PEDIDOS. Los cambios de clave de WiFi que los abonados pidieron
 *   y todavía no se aplicaron. Sin esta pantalla quedan enterrados en la base y
 *   nadie se entera — el abonado esperando algo que nunca pasa.
 *
 *   QUIÉNES PUEDEN ENTRAR. El portal necesita cédula para reconocer al abonado
 *   y un celular para mandarle el código. El que no tiene alguna de las dos no
 *   puede entrar y no puede resolverlo solo: tiene que llamar. Esa lista es lo
 *   que convierte el portal en algo que de verdad se usa.
 *
 *   RESETEAR EL ACCESO. Para el que perdió la contraseña o cambió de teléfono.
 *
 * ── Las dos formas de darle acceso, y en qué se diferencian ──
 *
 * RESETEAR borra la contraseña: el abonado vuelve a entrar con el código a su
 * celular y elige una que solo él conoce. Nadie en la oficina puede leerla.
 *
 * FIJAR UNA CLAVE genera una, la guarda legible en la ficha y se la dicta por
 * teléfono a quien llama. Es lo que hacía el sistema anterior y se agregó a
 * pedido: mucha gente no completa el circuito del código por WhatsApp, y sin
 * esto se quedaba afuera del portal.
 *
 * Tiene un costo que conviene tener presente: mientras esa clave sea la que se
 * generó acá, alguien de la oficina puede entrar a la cuenta del abonado, ver
 * sus facturas y cambiarle el WiFi, y en un reclamo no habría forma de
 * distinguir lo que hizo el abonado de lo que hizo la oficina.
 *
 * Por eso, en cuanto el abonado cambia su contraseña desde el portal, la copia
 * legible se borra sola —lo hace `cambiarClave` en `portalAuth`— y la ficha
 * vuelve a decir que la clave es suya y de nadie más.
 */

const enBase = (error, que) => {
  if (error) throw new AppError(`No se pudo ${que}: ${error.message}`, { status: 502 })
}

/** Cuántos pueden usar el portal, cuántos lo usan, y quiénes no pueden. */
export async function resumen() {
  const { data, error } = await db()
    .from('clientes')
    .select('id, nombre, identificacion, telefono, telefono_movil, email, estado, portal_clave_puesta')
    .neq('estado', 'baja')

  enBase(error, 'leer los abonados')

  const puedeEntrar = (c) =>
    Boolean(String(c.identificacion ?? '').trim()) &&
    Boolean(c.telefono_movil || c.telefono || c.email)

  const habilitados = (data ?? []).filter(puedeEntrar)
  const conClave = habilitados.filter((c) => c.portal_clave_puesta)

  // Quiénes NO pueden y por qué. Es la lista accionable: cada fila es un dato
  // que falta en una ficha, y arreglarlo suma un abonado que deja de llamar.
  const bloqueados = (data ?? [])
    .filter((c) => !puedeEntrar(c))
    .map((c) => ({
      id: c.id,
      nombre: c.nombre,
      falta: !String(c.identificacion ?? '').trim()
        ? 'cédula'
        : 'celular o correo',
    }))

  // Cuántos entraron alguna vez: es la única medida honesta de si el portal
  // sirve. "Mil abonados habilitados" no dice nada si no entró ninguno.
  const { count: sesiones } = await db()
    .from('portal_sesiones')
    .select('cliente_id', { count: 'exact', head: true })

  const { count: pendientes } = await db()
    .from('portal_solicitudes')
    .select('id', { count: 'exact', head: true })
    .eq('estado', 'pendiente')

  return {
    abonados: data?.length ?? 0,
    habilitados: habilitados.length,
    con_clave: conClave.length,
    sesiones_activas: sesiones ?? 0,
    solicitudes_pendientes: pendientes ?? 0,
    bloqueados: bloqueados.slice(0, 100),
    bloqueados_total: bloqueados.length,
  }
}

/** Busca un abonado y dice cómo está su acceso al portal. */
export async function buscar(texto) {
  const q = String(texto ?? '').trim()
  if (q.length < 2) return []

  const { data, error } = await db()
    .from('clientes')
    .select('id, nombre, identificacion, telefono, telefono_movil, email, estado, portal_clave_puesta')
    .or(`nombre.ilike.%${q}%,identificacion.ilike.%${q}%`)
    .neq('estado', 'baja')
    .limit(20)

  enBase(error, 'buscar')

  const ids = (data ?? []).map((c) => c.id)
  if (!ids.length) return []

  const { data: sesiones } = await db()
    .from('portal_sesiones')
    .select('cliente_id, ultimo_uso')
    .in('cliente_id', ids)

  const ultimo = {}
  for (const s of sesiones ?? []) {
    if (!ultimo[s.cliente_id] || s.ultimo_uso > ultimo[s.cliente_id]) {
      ultimo[s.cliente_id] = s.ultimo_uso
    }
  }

  return data.map((c) => ({
    id: c.id,
    nombre: c.nombre,
    identificacion: c.identificacion,
    contacto: c.telefono_movil || c.telefono || c.email || null,
    estado: c.estado,
    tiene_clave: Boolean(c.portal_clave_puesta),
    sesiones: (sesiones ?? []).filter((s) => s.cliente_id === c.id).length,
    ultimo_acceso: ultimo[c.id] ?? null,
    // Lo que le falta para poder entrar, si le falta algo.
    falta: !String(c.identificacion ?? '').trim()
      ? 'cédula'
      : !(c.telefono_movil || c.telefono || c.email)
        ? 'celular o correo'
        : null,
  }))
}

/**
 * Resetea el acceso de un abonado.
 *
 * BORRA la contraseña y cierra sus sesiones. No pone una nueva: el abonado
 * vuelve a entrar con el código a su celular y elige la que quiera.
 *
 * Es para el que la olvidó, y para el que perdió el teléfono con la sesión
 * abierta — ahí cerrar las sesiones es lo urgente, porque quien tenga ese
 * teléfono está adentro de su cuenta.
 */
export async function resetearAcceso(clienteId) {
  const { data: cliente } = await db()
    .from('clientes')
    .select('id, nombre')
    .eq('id', clienteId)
    .maybeSingle()

  if (!cliente) throw notFound('No existe ese abonado.')

  const { count: cerradas } = await db()
    .from('portal_sesiones')
    .delete({ count: 'exact' })
    .eq('cliente_id', clienteId)

  const { error } = await db()
    .from('clientes')
    // La copia legible se va con el hash. Dejarla sería peor que no tenerla:
    // la ficha mostraría una contraseña que ya no abre nada.
    .update({ portal_clave_hash: null, portal_clave_puesta: null, portal_clave: null })
    .eq('id', clienteId)

  enBase(error, 'resetear el acceso')

  return {
    ok: true,
    sesiones_cerradas: cerradas ?? 0,
    mensaje: `${cliente.nombre} vuelve a entrar con el código que le llega al celular, y ahí puede poner una contraseña nueva.`,
  }
}

/**
 * Genera una contraseña para el abonado y la deja legible en su ficha.
 *
 * Se escriben las dos formas en el mismo UPDATE: el hash es contra el que
 * autentica el portal, y la copia en claro es la que se dicta por teléfono. Que
 * viajen juntas es lo que garantiza que no se separen — una ficha que muestra
 * una clave que no entra es peor que una ficha vacía.
 *
 * No cierra las sesiones abiertas a propósito. Esto se usa mientras el abonado
 * está del otro lado del teléfono; cerrarle la sesión del celular al que ya
 * estaba adentro no arregla nada y genera la segunda llamada.
 */
export async function fijarClave(clienteId) {
  const { data: cliente } = await db()
    .from('clientes')
    .select('id, nombre, estado')
    .eq('id', clienteId)
    .maybeSingle()

  if (!cliente) throw notFound('No existe ese abonado.')

  const clave = generarClaveLegible()

  const { error } = await db()
    .from('clientes')
    .update({
      portal_clave: clave,
      portal_clave_hash: hashearClave(clave),
      portal_clave_puesta: new Date().toISOString(),
    })
    .eq('id', clienteId)

  enBase(error, 'guardar la contraseña')

  return {
    ok: true,
    clave,
    mensaje: `${cliente.nombre} ya puede entrar al portal con esta contraseña. Queda visible en su ficha hasta que él la cambie.`,
  }
}

/** Cierra las sesiones sin tocar la contraseña: para el teléfono perdido. */
export async function cerrarSesiones(clienteId) {
  const { count, error } = await db()
    .from('portal_sesiones')
    .delete({ count: 'exact' })
    .eq('cliente_id', clienteId)

  enBase(error, 'cerrar las sesiones')
  return { ok: true, sesiones_cerradas: count ?? 0 }
}

/**
 * La cola de cambios de WiFi pendientes.
 *
 * La clave pedida se muestra: quien la aplica a mano en el equipo la necesita,
 * y no tiene sentido guardarla cifrada para que después nadie pueda usarla.
 * Está cifrada en la base para que no aparezca en cada respaldo, no para
 * ocultársela a quien tiene que hacer el trabajo.
 */
export async function solicitudes({ estado = 'pendiente' } = {}) {
  const { data, error } = await db()
    .from('portal_solicitudes')
    .select('id, cliente_id, tipo, valor_encrypted, estado, intentos, ultimo_error, creada_en, aplicada_en')
    .eq('estado', estado)
    .order('creada_en')
    .limit(200)

  enBase(error, 'leer los pedidos')
  if (!data?.length) return []

  const ids = [...new Set(data.map((s) => s.cliente_id))]
  const { data: clientes } = await db()
    .from('clientes')
    .select('id, nombre, identificacion, onu_id')
    .in('id', ids)

  const porId = Object.fromEntries((clientes ?? []).map((c) => [c.id, c]))

  return data.map((s) => {
    let valor = null
    try {
      valor = decrypt(s.valor_encrypted)
    } catch {
      // Pasa al restaurar un respaldo con otra CREDENTIALS_KEY. Se dice en vez
      // de mostrar un pedido vacío que nadie entiende.
      valor = null
    }

    return {
      id: s.id,
      cliente: porId[s.cliente_id]?.nombre ?? '(sin nombre)',
      identificacion: porId[s.cliente_id]?.identificacion ?? null,
      cliente_id: s.cliente_id,
      tipo: s.tipo,
      valor,
      ilegible: valor === null,
      estado: s.estado,
      intentos: s.intentos,
      ultimo_error: s.ultimo_error,
      creada_en: s.creada_en,
      aplicada_en: s.aplicada_en,
    }
  })
}

/**
 * Marca un pedido como hecho a mano.
 *
 * Hasta que el ACS tenga camino a la red de gestión, alguien lo aplica entrando
 * al equipo. Sin este botón la cola crecería para siempre, y el abonado seguiría
 * viendo "en camino" algo que ya se hizo hace una semana.
 */
export async function marcarSolicitud(id, estado) {
  if (!['aplicada', 'cancelada'].includes(estado)) {
    throw new AppError('Estado no válido', { status: 400 })
  }

  const { error } = await db()
    .from('portal_solicitudes')
    .update({
      estado,
      aplicada_en: estado === 'aplicada' ? new Date().toISOString() : null,
    })
    .eq('id', id)

  enBase(error, 'actualizar el pedido')
  return { ok: true }
}
