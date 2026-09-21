/**
 * Diagnóstico de los routers MikroTik cargados.
 *
 *   node diagnostico-routers.mjs
 *
 * Separa dos cosas que se confunden fácil:
 *
 *   a) ¿La aplicación tiene bien los datos? — lee la fila de Supabase, descifra
 *      la contraseña y muestra exactamente con qué host, puerto y usuario se va
 *      a conectar el driver.
 *
 *   b) ¿La red deja pasar? — hace una conexión TCP cruda a ese host y puerto,
 *      sin usar el driver ni mandar credenciales.
 *
 * Si (a) está bien y (b) falla, el problema NO es de la aplicación.
 */

import net from 'node:net'
import { RouterOSAPI } from 'node-routeros'
import { db, cargarRouter } from './src/lib/db.js'
import { modoDe } from './src/services/mikrotikService.js'

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const mal = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`)
const dato = (k, v) => console.log(`      ${k.padEnd(22)} ${v}`)

/**
 * ¿Qué habla ese puerto?
 *
 * La API binaria de RouterOS no saluda: espera a que el cliente mande una
 * sentencia. Un servicio web, en cambio, contesta a un GET. Eso alcanza para
 * distinguirlos, que es justo la confusión más cara: apuntar el driver binario
 * al puerto del servicio web da un timeout de 10 segundos sin explicación.
 */
async function detectarProtocolo(host, puerto) {
  try {
    const res = await fetch(`http://${host}:${puerto}/rest/system/identity`, {
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    })
    // 401 sin credenciales = la REST API existe y está pidiendo autenticación.
    if (res.status === 401) return { tipo: 'rest', detalle: 'REST API habilitada (respondió 401)' }

    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('json')) return { tipo: 'rest', detalle: `REST API (HTTP ${res.status})` }

    return {
      tipo: 'web',
      detalle: `servicio web / Webfig (HTTP ${res.status}, ${contentType || 'sin content-type'})`,
    }
  } catch {
    // No contesta HTTP: es coherente con la API binaria, que no saluda.
    return { tipo: 'api', detalle: 'no responde a HTTP — coherente con la API binaria' }
  }
}

/**
 * Intenta el login real, con más margen que la app y mostrando el error CRUDO.
 *
 * La app traduce los errores para que sean legibles, pero acá interesa el texto
 * original: distinguir "cannot log in" (credenciales o permiso api) de un
 * timeout (el saludo del protocolo no se completa) cambia por completo qué hay
 * que revisar.
 */
async function probarLogin(router, puerto) {
  for (const segundos of [10, 30]) {
    const conn = new RouterOSAPI({
      host: router.ip_host,
      user: router.usuario,
      password: router.password,
      port: puerto,
      timeout: segundos,
      ...(router.usa_https ? { tls: { rejectUnauthorized: false } } : {}),
    })

    const t0 = Date.now()
    try {
      await conn.connect()
      const [id] = await conn.write('/system/identity/print')
      await conn.close()
      ok(`login correcto en ${Date.now() - t0} ms — identidad: ${id?.name ?? '(sin nombre)'}`)
      return
    } catch (err) {
      const ms = Date.now() - t0
      const texto = String(err?.message ?? err) || '(sin mensaje)'
      mal(`timeout de ${segundos}s → falló a los ${ms} ms: ${texto}`)
      if (err?.errno) console.log(`      errno: ${err.errno}`)

      // Si rechazó las credenciales, esperar más no cambia nada.
      if (/cannot log in|invalid user|not allowed|password/i.test(texto)) {
        console.log('      → Es de credenciales o permisos, no de red.')
        console.log('        Verificá el usuario y que su grupo tenga la política "api":')
        console.log('          /user print detail where name=' + router.usuario)
        console.log('          /user group print detail')
        return
      }
      try {
        await conn.close()
      } catch {
        /* ya estaba cerrada */
      }
    }
  }

  console.log('      → El puerto acepta TCP pero el saludo de la API nunca se completa.')
  console.log('        Suele significar que ese puerto lo ocupa OTRO servicio, no la API.')
  console.log('        Confirmá el puerto real con:  /ip service print detail where name=api')
}

/** Conexión TCP cruda: solo mira si el puerto acepta. No manda nada. */
function sondaTcp(host, puerto, timeout = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const s = new net.Socket()
    let conectado = false
    const fin = (estado, codigo) => {
      s.destroy()
      resolve({ estado, ms: Date.now() - t0, codigo })
    }
    s.setTimeout(timeout)
    s.connect(puerto, host, () => {
      conectado = true
      fin('abierto')
    })
    s.on('timeout', () => fin(conectado ? 'abierto' : 'sin-respuesta'))
    s.on('error', (e) => fin('error', e.code))
  })
}

console.log('\n\x1b[1m\x1b[36mDiagnóstico de routers MikroTik\x1b[0m')

const { data: filas, error } = await db().from('routers_mikrotik').select('*').order('nombre')

if (error) {
  mal(`No se pudo leer la tabla: ${error.message}`)
  process.exit(1)
}
if (!filas.length) {
  console.log('\n  No hay routers cargados.\n')
  process.exit(0)
}

for (const fila of filas) {
  console.log(`\n\x1b[1m${fila.nombre}\x1b[0m`)

  // --- (a) ¿La aplicación tiene bien los datos? ---
  let router
  try {
    router = await cargarRouter(fila.id)
    ok('la contraseña guardada se descifra correctamente')
  } catch (err) {
    mal(`no se pudo descifrar la contraseña: ${err.message}`)
    if (err.hint) console.log(`      ${err.hint}`)
    continue
  }

  const modo = modoDe(router)
  const puerto = Number(router.puerto_api) || (modo === 'rest' ? 80 : 8728)

  console.log('\n    Con estos datos se va a conectar el driver:')
  dato('host', router.ip_host)
  dato('puerto', puerto)
  dato('usuario', router.usuario)
  dato('modo', modo === 'rest' ? 'REST API' : 'API binaria de RouterOS')
  dato('cifrado', router.usa_https ? 'sí (TLS)' : 'no')
  dato('contraseña', `${router.password.length} caracteres (descifrada OK)`)

  if (fila.modo_api == null) {
    console.log('\n      Nota: la columna modo_api no existe o está vacía en esta fila.')
    console.log('      Se dedujo el modo por el puerto. Corré supabase/migracion-01-modo-api.sql')
  }

  // --- (b) ¿La red deja pasar? ---
  console.log('\n    Prueba de red (TCP crudo, sin credenciales):')
  const r = await sondaTcp(router.ip_host, puerto)

  if (r.estado === 'abierto') {
    ok(`${router.ip_host}:${puerto} acepta conexión (${r.ms} ms)`)

    const proto = await detectarProtocolo(router.ip_host, puerto)
    dato('qué habla el puerto', proto.detalle)

    // El desacuerdo entre el modo configurado y lo que realmente habla el puerto
    // es la causa más común de "abre pero da timeout".
    if (modo === 'binaria' && proto.tipo !== 'api') {
      mal('DESACUERDO: el router está en modo "API binaria" pero ese puerto habla HTTP')
      console.log(
        proto.tipo === 'rest'
          ? '      → Editá el router y elegí modo "REST API v7" con este mismo puerto.'
          : '      → Ese es el puerto del servicio web, no el de la API.\n' +
            '        Buscá el puerto real con:  /ip service print detail where name=api',
      )
    } else if (modo === 'rest' && proto.tipo === 'api') {
      mal('DESACUERDO: el router está en modo REST pero ese puerto no habla HTTP')
      console.log('      → Probablemente sea el puerto de la API binaria. Cambiá el modo.')
    } else {
      console.log('      → Coincide con el modo configurado. Probando el login real…\n')
      await probarLogin(router, puerto)
    }
  } else if (r.estado === 'sin-respuesta') {
    mal(`${router.ip_host}:${puerto} no responde (${r.ms} ms) — el paquete se descarta`)
    console.log('      → Firewall o /ip service con address restringido. NO es la aplicación:')
    console.log('        esta prueba es TCP puro y no usa el driver.')
  } else {
    mal(`${router.ip_host}:${puerto} → ${r.codigo ?? r.estado}`)
    if (r.codigo === 'ECONNREFUSED') {
      console.log('      → Llega al host pero no hay nada escuchando en ese puerto.')
    }
  }
}

console.log(`
\x1b[1mCómo leerlo\x1b[0m

  Datos OK + puerto abierto      → si la app falla, es usuario/contraseña/permisos
  Datos OK + sin respuesta       → lo bloquea la red, no la aplicación
  Datos OK + ECONNREFUSED        → el servicio no está escuchando en ese puerto
  No descifra la contraseña      → cambió CREDENTIALS_KEY; recargá el router
`)
