import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'

/**
 * El portal del abonado, por el lado que importa: que nadie vea la cuenta de
 * otro.
 *
 * Estas pruebas no consultan la base — para eso haría falta Supabase de verdad.
 * Leen el código y verifican las reglas estructurales que, si se rompen,
 * abren el portal entero. Son las que un cambio distraído puede violar sin que
 * nada falle a la vista.
 */

const portal = readFileSync(new URL('../src/services/portal.js', import.meta.url), 'utf8')
const rutas = readFileSync(new URL('../src/routes/portal.routes.js', import.meta.url), 'utf8')
const auth = readFileSync(new URL('../src/services/portalAuth.js', import.meta.url), 'utf8')

/**
 * La regla madre: ninguna ruta del portal puede aceptar un id de cliente.
 *
 * Si una lo aceptara, alcanzaría con cambiar un número para ver la cuenta del
 * vecino. Es la falla clásica de estos portales y no se evita recordándola: se
 * evita haciendo que la consulta sin el filtro de sesión no exista.
 */
test('ninguna ruta del portal toma el cliente de lo que manda el navegador', () => {
  const sospechosos = [
    /req\.body\??\.cliente_id/,
    /req\.query\.cliente_id/,
    /req\.params\.clienteId/,
    /req\.params\.cliente/,
  ]

  for (const patron of sospechosos) {
    assert.ok(!patron.test(rutas), `Las rutas leen el cliente del navegador: ${patron}`)
  }

  // El id sale de la sesión y de ningún otro lado.
  assert.ok(rutas.includes('req.clienteId = clienteId'), 'la sesión tiene que fijar el cliente')
  assert.ok(
    rutas.includes('await clienteDeLaSesion(tokenDe(req))'),
    'el cliente tiene que resolverse desde el token',
  )
})

/** Cada consulta del portal filtra por el cliente de la sesión. */
test('toda consulta del portal filtra por cliente', () => {
  // Cada `.from('tabla')` de una tabla con datos de abonados tiene que estar
  // acompañado de un filtro por cliente en la misma consulta.
  const consultas = portal.split('db()').slice(1)

  const conDatosDeAbonado = ['facturas', 'consumo_diario', 'tickets', 'clientes', 'portal_solicitudes']

  for (const c of consultas) {
    const tabla = c.match(/\.from\('([a-z_]+)'\)/)?.[1]
    if (!tabla || !conDatosDeAbonado.includes(tabla)) continue

    // El corte es hasta el fin de la sentencia, para no arrastrar la siguiente.
    const sentencia = c.split(/\n\n/)[0]

    // Un INSERT no filtra: fija. Lo que hay que verificar ahí es que el cliente
    // que se graba salga de la sesión y no de lo que mandó el navegador.
    const atado = /\.insert\(/.test(sentencia)
      ? /(client_id|cliente_id): (clienteId|cliente\.id)/.test(sentencia)
      : /\.eq\('(client_id|cliente_id|id)', clienteId\)/.test(sentencia) ||
        /\.in\('factura_id', ids\)/.test(sentencia) // ids ya salidos de una consulta filtrada

    assert.ok(
      atado,
      `La consulta sobre ${tabla} no ata el cliente a la sesión:\n${sentencia.slice(0, 200)}`,
    )
  }
})

/**
 * El código nunca se guarda en claro.
 *
 * Si se guardara, quien se lleve la base entra con lo que encontró. Guardando
 * la huella con la llave del servidor, le faltaría también el .env.
 */
test('el código y el token se guardan como huella, nunca en claro', () => {
  assert.ok(!/codigo_hash: codigo\b/.test(auth), 'el código no puede guardarse tal cual')
  assert.ok(!/token_hash: token\b/.test(auth), 'el token no puede guardarse tal cual')
  assert.ok(auth.includes('codigo_hash: huella('), 'el código va como huella')
  assert.ok(auth.includes('token_hash: huella(token)'), 'el token va como huella')
  assert.ok(auth.includes("createHmac('sha256'"), 'la huella tiene que llevar la llave del servidor')
})

/** La huella depende de la llave: sin ella no se puede recalcular. */
test('la huella cambia con la llave del servidor', () => {
  const conUna = createHmac('sha256', 'llave-a').update('cliente:123456').digest('hex')
  const conOtra = createHmac('sha256', 'llave-b').update('cliente:123456').digest('hex')
  assert.notEqual(conUna, conOtra)
})

/**
 * No se revela quién es cliente.
 *
 * Las cédulas de un país son un rango, no un secreto: si el formulario dijera
 * "ese abonado no existe", cualquiera podría averiguar quién tiene internet
 * probando números.
 */
test('pedir un código responde igual exista o no la cédula', () => {
  assert.ok(
    auth.includes('const generico = {'),
    'tiene que haber una respuesta única para ambos casos',
  )
  assert.ok(
    /if \(!cliente\) return generico/.test(auth),
    'la cédula inexistente devuelve la misma respuesta que la existente',
  )
})

/** Un código sirve una sola vez y por poco tiempo. */
test('el código se quema al usarlo y tiene límite de intentos', () => {
  assert.ok(auth.includes('usado_en: new Date().toISOString()'), 'el código tiene que marcarse usado')
  assert.ok(auth.includes('fila.intentos >= MAX_INTENTOS'), 'tiene que haber tope de intentos')
  assert.ok(auth.includes('.is(\'usado_en\', null)'), 'un código usado no puede volver a servir')
  assert.ok(auth.includes(".gte('expira_en'"), 'un código vencido no puede servir')
})

/** El azar del código tiene que ser criptográfico. */
test('el código no se genera con Math.random', () => {
  // Se busca la LLAMADA, no la palabra: el archivo la menciona en un comentario
  // justamente para explicar por qué no se usa.
  assert.ok(!/Math\.random\(/.test(auth), 'Math.random es predecible: se puede calcular el siguiente')
  assert.ok(auth.includes('randomInt(0, 1_000_000)'), 'el código sale de randomInt')
  assert.ok(auth.includes('randomBytes(32)'), 'el token de sesión sale de randomBytes')
})

/** Los dados de baja no entran. */
test('un abonado dado de baja no puede entrar', () => {
  assert.ok(auth.includes(".neq('estado', 'baja')"), 'las bajas quedan afuera del ingreso')
})

/**
 * El abonado no puede cambiarse el nombre ni la cédula.
 *
 * Van impresos en la factura y el SRI los valida contra el RUC: dejarlos
 * editar sería dejar que alguien se emita facturas a otro nombre.
 */
test('el abonado solo puede corregir su contacto', () => {
  const bloque = portal.slice(portal.indexOf('export async function actualizarContacto'))
  const permitidos = bloque.match(/for \(const campo of \[([^\]]+)\]/)?.[1] ?? ''

  assert.ok(permitidos.includes('email'), 'debería poder cambiar el correo')
  assert.ok(!permitidos.includes('nombre'), 'NO puede cambiarse el nombre')
  assert.ok(!permitidos.includes('identificacion'), 'NO puede cambiarse la cédula')
  assert.ok(!permitidos.includes('plan_id'), 'NO puede cambiarse el plan')
  assert.ok(!permitidos.includes('estado'), 'NO puede reactivarse el servicio solo')
})

/** La clave del WiFi no queda en claro en la base. */
test('la clave de WiFi pedida se guarda cifrada', () => {
  assert.ok(portal.includes('valor_encrypted: encrypt('), 'la clave tiene que ir cifrada')
  assert.ok(!/valor_encrypted: p\.valor\b/.test(portal), 'no puede guardarse en claro')
})

/**
 * El cambio de WiFi no miente.
 *
 * Decir "listo" sin aplicarlo deja al abonado sin WiFi: se desconecta para
 * reconectar con la clave nueva y no entra ni con una ni con la otra.
 */
test('el cambio de WiFi se promete como pendiente, no como hecho', () => {
  const bloque = portal.slice(portal.indexOf('export async function pedirCambioWifi'))
  assert.ok(bloque.includes("estado: 'pendiente'"), 'tiene que devolverse como pendiente')
  assert.ok(
    bloque.includes('seguí usando la clave actual'),
    'hay que decirle que la clave vieja sigue andando',
  )
})

/**
 * Las contraseñas del abonado.
 *
 * Se guardan con scrypt y sal por cliente. Nunca en claro, y nunca con un hash
 * simple: hay tablas precalculadas de sha256 de contraseñas comunes que ya
 * existen hechas, y romperlas cuesta una tarde.
 */
test('la contraseña del abonado se guarda con scrypt, nunca en claro', () => {
  assert.ok(auth.includes('hashearClave(nueva)'), 'la contraseña nueva tiene que hashearse')
  assert.ok(!/portal_clave_hash: nueva\b/.test(auth), 'no puede guardarse tal cual')
  assert.ok(!/portal_clave_hash: clave\b/.test(auth), 'no puede guardarse tal cual')
})

/** Cambiarla exige la anterior aunque haya sesión abierta. */
test('cambiar la contraseña pide la anterior', () => {
  const bloque = auth.slice(auth.indexOf('export async function cambiarClave'))
  assert.ok(
    bloque.includes('verificarClave(actual, cliente.portal_clave_hash)'),
    'tiene que verificarse la contraseña actual',
  )
})

/**
 * Entrar con contraseña no puede decir si la cédula existe.
 *
 * Es el mismo motivo que con el código: las cédulas de un país son un rango, y
 * un formulario que distingue "no existe" de "clave incorrecta" es un buscador
 * de quién tiene internet.
 */
test('el ingreso con contraseña no delata qué cédulas son de clientes', () => {
  const bloque = auth.slice(
    auth.indexOf('export async function entrarConClave'),
    auth.indexOf('async function abrirSesion'),
  )

  assert.ok(
    bloque.includes("badRequest('Cédula o contraseña incorrectas.')"),
    'tiene que haber un solo mensaje de rechazo',
  )
  // Y se gasta el mismo tiempo aunque no exista, para que la demora no delate.
  assert.ok(
    bloque.includes("verificarClave(String(clave ?? ''), hashearClave('descarte'))"),
    'sin cliente hay que gastar el tiempo igual',
  )
})
