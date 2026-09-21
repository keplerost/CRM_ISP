import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import {
  anotarContacto,
  buscar,
  guardar,
  hoy,
  listar,
  pagosDe,
  registrarDesconocida,
  registrarPago,
} from './db.js'
import {
  abrirSesion,
  buscarPorAcceso,
  cerrarSesion,
  guardarClave,
  instalacionDeSesion,
} from './db.js'
import { cargarClave, emitir } from './firma.js'
import { claveLegible, hashear, revisarClave, verificar } from './clave.js'
import { createHash, randomBytes } from 'node:crypto'

/**
 * El servidor de licencias — el lado del VENDEDOR.
 *
 * Hace dos cosas:
 *
 *   Le contesta a las instalaciones que piden renovar. Si el ISP está al día,
 *   les manda un permiso firmado; si no, un 402 que ellas saben interpretar.
 *
 *   Te muestra a vos la lista de clientes: cuántos abonados tiene cada uno,
 *   hasta cuándo pagó y quién está por vencer.
 *
 * Sin dependencias a propósito. Este servicio es el que no puede fallar: si se
 * cae, ningún cliente renueva. Cuantas menos piezas tenga, menos formas hay de
 * que se rompa — y se despliega copiando la carpeta.
 */

const PUERTO = Number(process.env.PORT || 4100)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''

/**
 * Cuántos días de permiso se emiten por delante del vencimiento del pago.
 *
 * El permiso NO vence el día que vence el pago: vence unos días después. Así,
 * si el cliente se queda sin internet una semana y no puede renovar, no se
 * bloquea — su último permiso todavía alcanza. Es la red de contención de la
 * red de contención.
 */
const COLCHON_DIAS = Number(process.env.LICENCIA_COLCHON_DIAS || 5)

const raiz = dirname(dirname(fileURLToPath(import.meta.url)))

function json(res, status, cuerpo) {
  const texto = JSON.stringify(cuerpo)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(texto),
  })
  res.end(texto)
}

async function leerCuerpo(req) {
  const trozos = []
  let total = 0
  for await (const t of req) {
    total += t.length
    // Un cuerpo enorme acá solo puede ser un error o un ataque: lo que se
    // espera son doscientos bytes.
    if (total > 64 * 1024) throw new Error('Cuerpo demasiado grande')
    trozos.push(t)
  }
  if (!trozos.length) return {}
  try {
    return JSON.parse(Buffer.concat(trozos).toString('utf8'))
  } catch {
    throw new Error('El cuerpo no es JSON válido')
  }
}

/**
 * Compara el token de administración sin filtrar información por el tiempo que
 * tarda. Es paranoia barata: cuesta tres líneas.
 */
function esAdmin(req) {
  if (!ADMIN_TOKEN) return false
  const dado = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(dado)
  const b = Buffer.from(ADMIN_TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

const sumarDias = (iso, dias) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

/**
 * La renovación. Es la ruta que llaman las instalaciones, sola, todos los días.
 *
 * Pública a propósito: la instalación no tiene con qué autenticarse más que su
 * identificador, y lo único que se puede averiguar preguntando es si una
 * instalación concreta está al día. Para eso hay que conocer su UUID.
 */
async function renovar(req, res) {
  const cuerpo = await leerCuerpo(req)
  const id = String(cuerpo.instalacion || '').trim()
  const abonados = Number(cuerpo.abonados) || 0

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return json(res, 400, { error: 'Falta el identificador de instalación.' })
  }

  let inst = buscar(id)

  // Una instalación que no conocemos queda anotada igual. Es el cliente nuevo
  // al que todavía no diste de alta: mejor que aparezca en la lista a que su
  // pedido se pierda y nadie sepa que existe.
  if (!inst) inst = registrarDesconocida(id, abonados)
  else anotarContacto(id, abonados)

  if (inst.suspendida) {
    return json(res, 402, { error: 'La licencia está suspendida.', instalacion: id })
  }

  if (!inst.pagado_hasta || inst.pagado_hasta < hoy()) {
    return json(res, 402, {
      error: 'La licencia no está al día.',
      pagado_hasta: inst.pagado_hasta ?? null,
      instalacion: id,
    })
  }

  const token = emitir({
    instalacion: id,
    isp: inst.isp,
    clientes_max: inst.plan_clientes,
    vence: sumarDias(inst.pagado_hasta, COLCHON_DIAS),
  })

  json(res, 200, { token, pagado_hasta: inst.pagado_hasta })
}

/**
 * El portal del ISP.
 *
 * Entra con su correo o con su código de instalación, y su contraseña. Las dos
 * puertas a propósito: el correo es lo que recuerda, y el código es lo que
 * tiene a mano en su propio sistema el día que no recuerda con cuál se
 * registró.
 *
 * La primera contraseña la puede definir él —con el código de instalación, que
 * solo él tiene— o se la entregás vos desde el panel. Las dos formas terminan
 * en lo mismo: una contraseña que puede cambiar cuando quiera.
 */

const huella = (t) => createHash('sha256').update(String(t)).digest('hex')

const tokenDe = (req) =>
  (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || null

/** Lo que se le muestra al ISP de su propia cuenta. Nunca de otra. */
function vistaDe(inst) {
  const dias = inst.pagado_hasta
    ? Math.ceil((new Date(`${inst.pagado_hasta}T23:59:59Z`) - new Date()) / 86400000)
    : null

  return {
    isp: inst.isp,
    email: inst.email,
    instalacion: inst.id,
    abonados: inst.abonados,
    plan_clientes: inst.plan_clientes,
    precio_mensual: inst.precio_mensual,
    pagado_hasta: inst.pagado_hasta,
    dias_restantes: dias,
    al_dia: Boolean(inst.pagado_hasta && inst.pagado_hasta >= hoy() && !inst.suspendida),
    suspendida: Boolean(inst.suspendida),
    excedido: Boolean(inst.plan_clientes && inst.abonados > inst.plan_clientes),
    pagos: pagosDe(inst.id).map((p) => ({
      fecha: p.fecha.slice(0, 10),
      monto: p.monto,
      meses: p.meses,
      hasta: p.hasta,
    })),
  }
}

async function portal(req, res, ruta) {
  const paso = ruta.replace('/portal/', '')

  // --- Definir la primera contraseña -----------------------------------------
  //
  // Se prueba contra el código de instalación, que es un UUID que solo tiene
  // quien administra ese sistema. Solo sirve si TODAVÍA no hay contraseña: si
  // la hubiera, cualquiera con el código podría pisarla y quedarse con la
  // cuenta.
  if (req.method === 'POST' && paso === 'registrarse') {
    const { instalacion, email, clave } = await leerCuerpo(req)

    const inst = buscar(String(instalacion ?? '').trim())
    if (!inst) return json(res, 404, { error: 'Ese código de instalación no existe.' })

    if (inst.clave_hash) {
      return json(res, 409, {
        error: 'Esa instalación ya tiene una contraseña.',
        hint: 'Entrá con ella, o pedile al proveedor que te la restablezca.',
      })
    }

    const mal = revisarClave(clave)
    if (mal) return json(res, 400, { error: mal })

    if (email) {
      const ocupado = buscarPorAcceso(email)
      if (ocupado && ocupado.id !== inst.id) {
        return json(res, 409, { error: 'Ese correo ya está en uso.' })
      }
      guardar(inst.id, { email: String(email).trim() })
    }

    guardarClave(inst.id, hashear(clave))

    const token = randomBytes(32).toString('base64url')
    abrirSesion(inst.id, huella(token))
    return json(res, 200, { token, cuenta: vistaDe(buscar(inst.id)) })
  }

  // --- Entrar ----------------------------------------------------------------
  if (req.method === 'POST' && paso === 'entrar') {
    const { usuario, clave } = await leerCuerpo(req)
    const inst = buscarPorAcceso(usuario)

    // El mismo error para "no existe" y "contraseña incorrecta": distinguirlos
    // convertiría el formulario en un buscador de clientes del proveedor.
    const rechazo = { error: 'Usuario o contraseña incorrectos.' }

    if (!inst || !inst.clave_hash) {
      // Se gasta el tiempo igual aunque no exista, para que la demora no
      // delate cuáles cuentas son reales.
      verificar(String(clave ?? ''), hashear('descarte'))
      return json(res, 401, rechazo)
    }

    if (!verificar(clave, inst.clave_hash)) return json(res, 401, rechazo)

    const token = randomBytes(32).toString('base64url')
    abrirSesion(inst.id, huella(token))
    return json(res, 200, { token, cuenta: vistaDe(inst) })
  }

  // --- De acá para abajo hace falta sesión -----------------------------------
  const token = tokenDe(req)
  const inst = token ? instalacionDeSesion(huella(token)) : null
  if (!inst) return json(res, 401, { error: 'Tu sesión venció. Volvé a entrar.' })

  if (req.method === 'GET' && paso === 'cuenta') return json(res, 200, vistaDe(inst))

  if (req.method === 'POST' && paso === 'salir') {
    cerrarSesion(huella(token))
    return json(res, 200, { ok: true })
  }

  // --- Cambiar la contraseña -------------------------------------------------
  if (req.method === 'POST' && paso === 'clave') {
    const { actual, nueva } = await leerCuerpo(req)

    // Se pide la actual aunque ya tenga sesión abierta: es lo que impide que
    // alguien que agarró el teléfono desbloqueado se apropie de la cuenta.
    if (!verificar(actual, inst.clave_hash)) {
      return json(res, 401, { error: 'La contraseña actual no es correcta.' })
    }

    const mal = revisarClave(nueva)
    if (mal) return json(res, 400, { error: mal })

    guardarClave(inst.id, hashear(nueva))
    // guardarClave cierra TODAS las sesiones, incluida esta: es el punto de
    // cambiarla cuando se sospecha que alguien más entró.
    return json(res, 200, {
      ok: true,
      mensaje: 'Contraseña cambiada. Volvé a entrar con la nueva.',
    })
  }

  if (req.method === 'PUT' && paso === 'email') {
    const { email } = await leerCuerpo(req)
    const limpio = String(email ?? '').trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(limpio)) {
      return json(res, 400, { error: 'Ese correo no parece válido.' })
    }
    const ocupado = buscarPorAcceso(limpio)
    if (ocupado && ocupado.id !== inst.id) {
      return json(res, 409, { error: 'Ese correo ya está en uso.' })
    }
    guardar(inst.id, { email: limpio })
    return json(res, 200, vistaDe(buscar(inst.id)))
  }

  json(res, 404, { error: 'Ruta desconocida.' })
}

/** Las rutas de administración. Todas exigen el token. */
async function admin(req, res, ruta) {
  if (!esAdmin(req)) return json(res, 401, { error: 'No autorizado.' })

  const partes = ruta.split('/').filter(Boolean) // ['admin', ...]

  if (req.method === 'GET' && partes.length === 2 && partes[1] === 'instalaciones') {
    const lista = listar().map((i) => ({
      ...i,
      dias_restantes: i.pagado_hasta
        ? Math.ceil((new Date(`${i.pagado_hasta}T23:59:59Z`) - new Date()) / 86400000)
        : null,
      al_dia: Boolean(i.pagado_hasta && i.pagado_hasta >= hoy() && !i.suspendida),
      // Crecer no bloquea nada, pero es exactamente lo que querés ver: es un
      // cliente al que le podés vender un plan más grande.
      excedido: Boolean(i.plan_clientes && i.abonados > i.plan_clientes),
    }))
    return json(res, 200, { instalaciones: lista, hoy: hoy() })
  }

  const id = partes[2]
  if (!id) return json(res, 404, { error: 'Ruta desconocida.' })

  if (req.method === 'GET' && partes[3] === 'pagos') {
    return json(res, 200, { pagos: pagosDe(id) })
  }

  if (req.method === 'PUT' && partes.length === 3) {
    const inst = guardar(id, await leerCuerpo(req))
    if (!inst) return json(res, 404, { error: 'No existe esa instalación.' })
    return json(res, 200, inst)
  }

  if (req.method === 'POST' && partes[3] === 'pagos') {
    const inst = registrarPago(id, await leerCuerpo(req))
    if (!inst) return json(res, 404, { error: 'No existe esa instalación.' })
    return json(res, 200, inst)
  }

  /**
   * Emite el permiso a mano, para pasárselo por WhatsApp.
   *
   * Es el camino que salva el día que el cliente no tiene internet, o que su
   * instalación no puede alcanzar este servidor. Nunca puede depender de la red
   * la única forma de desbloquear a alguien.
   */
  /**
   * Le entregás una contraseña al ISP.
   *
   * Se genera y se muestra UNA vez: en la base solo queda su huella, así que ni
   * vos podés volver a verla. Si se pierde, se genera otra — que es lo correcto:
   * un sistema donde el proveedor puede leer las contraseñas de sus clientes es
   * un sistema donde alguien más también puede.
   */
  if (req.method === 'POST' && partes[3] === 'clave') {
    const inst = buscar(id)
    if (!inst) return json(res, 404, { error: 'No existe esa instalación.' })

    const nueva = claveLegible()
    guardarClave(id, hashear(nueva))
    return json(res, 200, { clave: nueva, email: inst.email })
  }

  if (req.method === 'POST' && partes[3] === 'token') {
    const inst = buscar(id)
    if (!inst) return json(res, 404, { error: 'No existe esa instalación.' })
    if (!inst.pagado_hasta) return json(res, 400, { error: 'Esa instalación no tiene pagos registrados.' })

    return json(res, 200, {
      token: emitir({
        instalacion: id,
        isp: inst.isp,
        clientes_max: inst.plan_clientes,
        vence: sumarDias(inst.pagado_hasta, COLCHON_DIAS),
      }),
      vence: inst.pagado_hasta,
    })
  }

  json(res, 404, { error: 'Ruta desconocida.' })
}

const servidor = createServer(async (req, res) => {
  const ruta = new URL(req.url, 'http://x').pathname

  try {
    if (req.method === 'POST' && ruta === '/licencia/renovar') return await renovar(req, res)
    if (ruta.startsWith('/portal/')) return await portal(req, res, ruta)
    if (ruta.startsWith('/admin/')) return await admin(req, res, ruta)

    if (ruta === '/' || ruta === '/index.html') {
      const html = readFileSync(join(raiz, 'public', 'admin.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(html)
    }

    // La página del ISP: es la que se le pasa a cada cliente.
    if (ruta === '/mi-cuenta' || ruta === '/mi-cuenta/') {
      const html = readFileSync(join(raiz, 'public', 'mi-cuenta.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(html)
    }

    if (ruta === '/salud') return json(res, 200, { ok: true })

    json(res, 404, { error: 'Ruta desconocida.' })
  } catch (err) {
    console.error(err)
    json(res, 500, { error: err.message })
  }
})

// Se falla al arrancar y no al primer cliente: un servidor de licencias que
// levanta sin poder firmar parece sano hasta que alguien intenta renovar, y
// para entonces ya hay un ISP mirando un cartel rojo.
try {
  cargarClave()
} catch (err) {
  console.error(`\n  ${err.message}\n`)
  process.exit(1)
}

if (!ADMIN_TOKEN) {
  console.error('\n  Falta ADMIN_TOKEN. Sin eso, el panel quedaría abierto a cualquiera.\n')
  process.exit(1)
}

servidor.listen(PUERTO, () => {
  console.log(`\n  Servidor de licencias en http://localhost:${PUERTO}`)
  console.log(`  Panel:      http://localhost:${PUERTO}/`)
  console.log(`  Renovación: POST /licencia/renovar`)
  console.log(`  Permiso emitido hasta ${COLCHON_DIAS} días después del vencimiento del pago.\n`)
})
