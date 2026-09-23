import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { principalDe, puedeCambiarA, resumirServicios } from '../lib/servicios.js'
import { db } from '../lib/db.js'
import { config } from '../config.js'
import { AppError, badRequest } from '../lib/errors.js'
import { enviarCrudo, aInternacional } from './mensajeria.js'
import { hashearClave, revisarClave, verificarClave } from '../lib/clave.js'
import { credenciales } from './configMensajeria.js'

/**
 * Cómo entra un abonado al portal.
 *
 * Dos puertas, y las dos hacen falta:
 *
 *   CON CONTRASEÑA. Directo, sin depender de nada. Es lo que usa el que entra
 *   seguido.
 *
 *   CON UN CÓDIGO al celular. Es cómo se entra la primera vez —cuando todavía
 *   no hay contraseña que poner— y cómo se recupera la olvidada. Un abonado
 *   entra una vez al mes: la contraseña olvidada es la regla, no la excepción,
 *   y sin esta puerta cada una sería una llamada a la oficina.
 *
 * Ninguna reemplaza a la otra. El código solo depende de que el celular esté
 * bien cargado, y el que cambió de número sin avisar quedaría afuera de su
 * propia cuenta sin poder resolverlo; la contraseña solo depende de la memoria.
 *
 * ── Lo que se protege y cómo ──
 *
 * NO SE GUARDA EL CÓDIGO, sino su huella calculada con la llave del servidor
 * (HMAC). Quien se lleve la base no puede entrar con lo que encontró, ni
 * probar códigos contra la huella sin tener también el .env.
 *
 * EL CÓDIGO CADUCA a los diez minutos y muere al primer uso. Seis dígitos son
 * un millón de combinaciones: para un programa eso es un rato, así que además
 * se cuentan los intentos y a los cinco el código se quema.
 *
 * NO SE DICE SI LA CÉDULA EXISTE. La respuesta es la misma exista o no. Si
 * dijera "ese abonado no existe", cualquiera podría averiguar quién es cliente
 * probando cédulas — y las cédulas de un país son un rango, no un secreto.
 *
 * NUNCA SE CONFÍA EN UN ID DEL NAVEGADOR. La sesión dice de qué cliente es, y
 * todas las consultas filtran por ese id. Es la falla clásica de estos
 * portales: cambiar un número en la URL y ver la factura del vecino.
 */

const VIDA_CODIGO_MIN = 10
const MAX_INTENTOS = 5
const VIDA_SESION_DIAS = 30

/** Cuántos códigos puede pedir una misma cédula por hora. */
const MAX_PEDIDOS_HORA = 5

const huella = (valor) =>
  createHmac('sha256', config.credentialsKey || 'sin-llave').update(String(valor)).digest('hex')

/** Comparación que no filtra información por el tiempo que tarda. */
function igual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Busca al abonado por su cédula.
 *
 * Los dados de baja quedan afuera: ya no son clientes, y dejarlos entrar sería
 * darle acceso a sus datos a alguien que quizás ya no vive en esa casa.
 */
const CAMPOS_SERVICIO =
  'id, nombre, identificacion, direccion, referencia_servicio, created_at, ' +
  'email, telefono, telefono_movil, estado, telegram_chat_id, portal_clave_hash'

/**
 * Todos los servicios de esa cédula.
 *
 * Devuelve una lista y no una fila. Antes usaba `maybeSingle()`, que falla
 * cuando hay más de un resultado — y eso obligaba a que la base impidiera
 * cédulas repetidas, lo que a su vez obligaba a cargar el segundo servicio de
 * una persona con el nombre deformado y sin identificación.
 */
async function serviciosDe(identificacion) {
  const limpia = String(identificacion ?? '').replace(/\D/g, '')
  if (limpia.length < 5) return []

  const { data, error } = await db()
    .from('clientes')
    .select(CAMPOS_SERVICIO)
    .eq('identificacion', limpia)
    .neq('estado', 'baja')

  if (error) throw new AppError(`No se pudo buscar al abonado: ${error.message}`, { status: 502 })
  return data ?? []
}

/** Sobre cuál de los servicios trabaja el ingreso. Ver `lib/servicios.js`. */
async function porIdentificacion(identificacion) {
  return principalDe(await serviciosDe(identificacion))
}

/** A dónde mandarle el código, y por qué canal. */
async function aDondeAvisar(cliente) {
  const { whatsapp, telegram } = await credenciales()
  const celular = cliente.telefono_movil || cliente.telefono

  // WhatsApp primero: es donde el abonado mira. Pero solo si de verdad sale
  // solo — en modo manual nadie va a estar despachando códigos a mano.
  if (celular && whatsapp.via !== 'manual') {
    return { canal: 'whatsapp', destino: celular }
  }
  if (cliente.email) return { canal: 'email', destino: cliente.email }
  if (celular && telegram.token && cliente.telegram_chat_id) {
    return { canal: 'telegram', destino: cliente.telegram_chat_id }
  }
  if (celular) return { canal: 'sms', destino: celular }
  return null
}

/**
 * Pide un código.
 *
 * Devuelve SIEMPRE lo mismo, exista o no la cédula. La única diferencia visible
 * es el canal enmascarado cuando sí se mandó, que le sirve al abonado para
 * saber a dónde mirar.
 */
export async function pedirCodigo({ identificacion } = {}) {
  const generico = {
    enviado: true,
    mensaje: 'Si esa cédula corresponde a un abonado, le llegará un código en unos segundos.',
  }

  const cliente = await porIdentificacion(identificacion)
  if (!cliente) return generico

  // Un abonado que pide diez códigos en un minuto es alguien probando, o un
  // botón que se quedó apretado. En los dos casos, frenar.
  const desde = new Date(Date.now() - 3600_000).toISOString()
  const { count } = await db()
    .from('portal_codigos')
    .select('id', { count: 'exact', head: true })
    .eq('cliente_id', cliente.id)
    .gte('creado_en', desde)

  if ((count ?? 0) >= MAX_PEDIDOS_HORA) {
    throw new AppError('Ya se enviaron varios códigos. Esperá unos minutos antes de pedir otro.', {
      status: 429,
    })
  }

  const a = await aDondeAvisar(cliente)
  if (!a) {
    // Acá sí se dice la verdad: el abonado existe pero no tenemos cómo
    // alcanzarlo. Que crea que el código va a llegar sería peor — esperaría un
    // mensaje que nadie mandó.
    throw badRequest('No tenemos un celular ni un correo cargado para vos.', {
      hint: 'Comunicate con tu proveedor para que actualice tus datos de contacto.',
    })
  }

  // randomInt es criptográficamente seguro. Math.random es predecible: con unos
  // pocos códigos observados se puede calcular el siguiente.
  const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0')

  const { error } = await db()
    .from('portal_codigos')
    .insert({
      cliente_id: cliente.id,
      codigo_hash: huella(`${cliente.id}:${codigo}`),
      expira_en: new Date(Date.now() + VIDA_CODIGO_MIN * 60_000).toISOString(),
      canal: a.canal,
      enviado_a: a.destino,
    })
  if (error) throw new AppError(`No se pudo generar el código: ${error.message}`, { status: 502 })

  const primerNombre = String(cliente.nombre ?? '').split(' ')[0]
  await enviarCrudo({
    canal: a.canal,
    destino: a.canal === 'whatsapp' || a.canal === 'sms' ? aInternacional(a.destino) : a.destino,
    asunto: 'Tu código de acceso',
    cuerpo:
      `Hola ${primerNombre}. Tu código para entrar es ${codigo}\n\n` +
      `Vence en ${VIDA_CODIGO_MIN} minutos. Si no lo pediste, ignorá este mensaje y no se lo des a nadie.`,
  }).catch((err) => {
    // No se lanza: el código ya está guardado y quizás llegue por otro lado.
    // Y avisar "no se pudo enviar" le confirmaría a un curioso que la cédula
    // existe, que es justo lo que se evita.
    console.error('[portal] no se pudo enviar el código:', err.message)
  })

  return { ...generico, canal: a.canal, destino: enmascarar(a.destino) }
}

/** 099****567 — alcanza para reconocer el propio número sin exponerlo. */
function enmascarar(destino) {
  const s = String(destino ?? '')
  if (s.includes('@')) {
    const [antes, dominio] = s.split('@')
    return `${antes.slice(0, 2)}${'*'.repeat(Math.max(1, antes.length - 2))}@${dominio}`
  }
  return s.length > 6 ? `${s.slice(0, 3)}${'*'.repeat(s.length - 6)}${s.slice(-3)}` : s
}

/**
 * Canjea el código por una sesión.
 *
 * El token que se devuelve es lo único que el abonado guarda. En la base queda
 * su huella: si se filtra la tabla de sesiones, no se puede entrar con ella.
 */
export async function entrar({ identificacion, codigo, agente } = {}) {
  const servicios = await serviciosDe(identificacion)
  const cliente = principalDe(servicios)
  const rechazo = badRequest('El código no es correcto o ya venció.')

  // Mismo error para "no existe la cédula" y "el código está mal": distinguir
  // los dos casos convertiría el formulario en un buscador de clientes.
  if (!cliente) throw rechazo

  const { data: codigos, error } = await db()
    .from('portal_codigos')
    .select('*')
    .eq('cliente_id', cliente.id)
    .is('usado_en', null)
    .gte('expira_en', new Date().toISOString())
    .order('creado_en', { ascending: false })
    .limit(1)

  if (error) throw new AppError(`No se pudo verificar: ${error.message}`, { status: 502 })

  const fila = codigos?.[0]
  if (!fila) throw rechazo

  if (fila.intentos >= MAX_INTENTOS) {
    // Se quema, no se deja seguir probando.
    await db().from('portal_codigos').update({ usado_en: new Date().toISOString() }).eq('id', fila.id)
    throw badRequest('Se agotaron los intentos con ese código. Pedí uno nuevo.')
  }

  if (!igual(fila.codigo_hash, huella(`${cliente.id}:${String(codigo ?? '').trim()}`))) {
    await db()
      .from('portal_codigos')
      .update({ intentos: fila.intentos + 1 })
      .eq('id', fila.id)
    throw rechazo
  }

  // Un código sirve UNA vez. Sin esto, el mismo WhatsApp reenviado abre una
  // sesión nueva cada vez que alguien lo lea.
  await db().from('portal_codigos').update({ usado_en: new Date().toISOString() }).eq('id', fila.id)

  return abrirSesion(cliente, agente, servicios)
}

/**
 * De quién es esta sesión.
 *
 * Devuelve el id del cliente o null. TODO endpoint del portal empieza por acá:
 * es el único lugar donde se decide de quién son los datos que se van a
 * devolver, y por eso ninguno acepta un id por parámetro.
 */
/**
 * Entrar con contraseña.
 *
 * Convive con el código: el abonado que puso contraseña entra directo, y el que
 * no la puso —o la olvidó— sigue entrando por WhatsApp. Ninguna reemplaza a la
 * otra, y esa redundancia es a propósito: el celular mal cargado deja a alguien
 * afuera de su propia cuenta sin forma de resolverlo solo.
 */
export async function entrarConClave({ identificacion, clave, agente } = {}) {
  const servicios = await serviciosDe(identificacion)
  const cliente = principalDe(servicios)

  // El mismo error para "no existe la cédula" y "contraseña incorrecta".
  // Distinguirlos convertiría el formulario en un buscador de abonados.
  const rechazo = badRequest('Cédula o contraseña incorrectas.')

  if (!cliente || !cliente.portal_clave_hash) {
    // Se gasta el tiempo igual, para que la demora no delate qué cédulas son
    // de clientes reales.
    verificarClave(String(clave ?? ''), hashearClave('descarte'))
    throw rechazo
  }

  if (!verificarClave(clave, cliente.portal_clave_hash)) throw rechazo

  return abrirSesion(cliente, agente, servicios)
}

/** Crea la sesión y devuelve el token. Lo comparten las dos formas de entrar. */
async function abrirSesion(cliente, agente, servicios = []) {
  const token = randomBytes(32).toString('base64url')

  const { error } = await db()
    .from('portal_sesiones')
    .insert({
      cliente_id: cliente.id,
      token_hash: huella(token),
      expira_en: new Date(Date.now() + VIDA_SESION_DIAS * 86400_000).toISOString(),
      ultimo_uso: new Date().toISOString(),
      agente: String(agente ?? '').slice(0, 200),
    })

  if (error) throw new AppError(`No se pudo abrir la sesión: ${error.message}`, { status: 502 })

  return {
    token,
    nombre: cliente.nombre,
    expira_dias: VIDA_SESION_DIAS,
    tiene_clave: Boolean(cliente.portal_clave_hash),
    // Los otros servicios de la misma persona, para poder ofrecerlos sin que
    // tenga que volver a entrar. Va vacío cuando hay uno solo, que es el caso
    // habitual: el portal no dibuja nada y no cambia para nadie.
    servicios: servicios.length > 1 ? resumirServicios(servicios, cliente.id) : [],
  }
}

/**
 * Pasar la sesión a otro servicio de la misma persona.
 *
 * No vuelve a pedir código ni contraseña, y eso es correcto: quien entró ya
 * demostró ser dueño de esa cédula. Lo que sí se comprueba, en cada cambio, es
 * que el destino tenga la MISMA identificación que el origen — la sesión no
 * alcanza para abrir la ficha de otro.
 *
 * Se modifica la sesión existente en vez de abrir una nueva: el token sigue
 * siendo el mismo, el portal no tiene que volver a guardarlo, y no quedan
 * sesiones sueltas cada vez que alguien mira su otro servicio.
 */
/**
 * Los otros servicios de quien tiene esta sesión abierta.
 *
 * Devuelve vacío cuando hay uno solo —el caso habitual— para que el portal no
 * dibuje un selector de una sola opción.
 */
export async function serviciosDeLaSesion(clienteId) {
  const { data, error } = await db()
    .from('clientes')
    .select('identificacion')
    .eq('id', clienteId)
    .maybeSingle()

  if (error || !data?.identificacion) return []

  const servicios = await serviciosDe(data.identificacion)
  return servicios.length > 1 ? resumirServicios(servicios, clienteId) : []
}

export async function cambiarServicio(token, destinoId) {
  const actualId = await clienteDeLaSesion(token)
  if (!actualId) throw badRequest('La sesión venció. Volvé a entrar.')

  const { data: fichas, error } = await db()
    .from('clientes')
    .select(CAMPOS_SERVICIO)
    .in('id', [actualId, destinoId])

  if (error) throw new AppError(`No se pudo leer el servicio: ${error.message}`, { status: 502 })

  const actual = fichas?.find((c) => c.id === actualId)
  const destino = fichas?.find((c) => c.id === destinoId)

  // El mismo mensaje para "no existe" y "no es tuyo". Distinguirlos convertiría
  // esto en una forma de averiguar qué fichas existen.
  if (!puedeCambiarA(actual, destino)) throw badRequest('Ese servicio no está disponible.')

  const { error: errorSesion } = await db()
    .from('portal_sesiones')
    .update({ cliente_id: destino.id, ultimo_uso: new Date().toISOString() })
    .eq('token_hash', huella(token))

  if (errorSesion) {
    throw new AppError(`No se pudo cambiar de servicio: ${errorSesion.message}`, { status: 502 })
  }

  const servicios = await serviciosDe(destino.identificacion)

  return {
    nombre: destino.nombre,
    servicios: servicios.length > 1 ? resumirServicios(servicios, destino.id) : [],
  }
}

/**
 * Define o cambia la contraseña.
 *
 * Si ya tenía una, hay que dar la anterior — aunque la sesión esté abierta. Es
 * lo que impide que alguien que agarró el teléfono desbloqueado se quede con la
 * cuenta. Si no tenía, la está definiendo por primera vez y alcanza con haber
 * entrado por WhatsApp, que ya probó que el celular es suyo.
 */
export async function cambiarClave(clienteId, { actual, nueva } = {}) {
  const { data: cliente, error } = await db()
    .from('clientes')
    .select('id, portal_clave_hash')
    .eq('id', clienteId)
    .maybeSingle()

  if (error) throw new AppError(`No se pudo leer tu cuenta: ${error.message}`, { status: 502 })
  if (!cliente) throw badRequest('No encontramos tu cuenta.')

  if (cliente.portal_clave_hash && !verificarClave(actual, cliente.portal_clave_hash)) {
    throw badRequest('La contraseña actual no es correcta.')
  }

  const mal = revisarClave(nueva)
  if (mal) throw badRequest(mal)

  const { error: errGuardar } = await db()
    .from('clientes')
    .update({
      portal_clave_hash: hashearClave(nueva),
      portal_clave_puesta: new Date().toISOString(),
      // Si la oficina le había fijado una clave, la copia legible se borra acá:
      // desde este momento la contraseña es del abonado y de nadie más, y la
      // ficha tiene que dejar de mostrar una que ya no sirve.
      portal_clave: null,
    })
    .eq('id', clienteId)

  if (errGuardar) {
    throw new AppError(`No se pudo guardar: ${errGuardar.message}`, { status: 502 })
  }

  // Se cierran las OTRAS sesiones, no la actual: quien acaba de cambiar su
  // contraseña desde su celular no tiene por qué volver a entrar, pero
  // cualquier otro dispositivo sí. Es el punto de cambiarla cuando se
  // sospecha que alguien más entró.
  return { ok: true, mensaje: 'Contraseña guardada.' }
}

/** Cierra todas las sesiones del abonado menos la que la pide. */
export async function cerrarLasDemas(clienteId, tokenActual) {
  await db()
    .from('portal_sesiones')
    .delete()
    .eq('cliente_id', clienteId)
    .neq('token_hash', huella(tokenActual))
}

export async function clienteDeLaSesion(token) {
  if (!token) return null

  const { data, error } = await db()
    .from('portal_sesiones')
    .select('id, cliente_id, expira_en')
    .eq('token_hash', huella(token))
    .maybeSingle()

  if (error || !data) return null
  if (new Date(data.expira_en) < new Date()) return null

  // Sin await: saber cuándo se usó por última vez es útil, pero no vale la pena
  // hacerle esperar un viaje a la base a cada pedido del abonado.
  db()
    .from('portal_sesiones')
    .update({ ultimo_uso: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {})

  return data.cliente_id
}

export async function salir(token) {
  if (!token) return
  await db().from('portal_sesiones').delete().eq('token_hash', huella(token))
}

/**
 * Limpieza.
 *
 * Los códigos vencidos y las sesiones muertas no sirven para nada y crecen sin
 * parar. Se borran solos: una tabla que solo crece termina siendo un problema
 * que nadie ve venir.
 */
export async function limpiar() {
  const ahora = new Date().toISOString()
  await db().from('portal_codigos').delete().lt('expira_en', ahora)
  await db().from('portal_sesiones').delete().lt('expira_en', ahora)
}
