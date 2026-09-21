import net from 'node:net'

/**
 * ¿Contesta el ACS?
 *
 * ── Lo que esta comprobación SÍ dice y lo que NO ──
 *
 * Dice que el servidor del sistema alcanza esa dirección. NO dice que las ONT
 * la alcancen, que es la pregunta que de verdad importa: las ONT viven en su
 * VLAN de gestión y llegan por otro camino.
 *
 * Se informa igual, con ese nombre, porque un ACS que ni siquiera desde acá
 * responde está roto seguro — y ese caso conviene verlo antes de salir a
 * revisar rutas y VLANs. Pero la pantalla tiene que decir "desde el servidor",
 * nunca "las ONT llegan": esa confusión manda a buscar el problema al lado
 * equivocado durante horas.
 */
export function puertoDeUrl(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null

  const puerto = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
  if (!Number.isFinite(puerto) || puerto < 1 || puerto > 65535) return null

  return { host: u.hostname, puerto }
}

/**
 * Un TCP contra el puerto del ACS, con tope de tiempo.
 *
 * No se hace un pedido HTTP a propósito: el CWMP contesta 405 a un GET —lo
 * correcto, solo acepta POST de las ONT— y más de una herramienta lee ese 405
 * como "caído". Que el puerto acepte la conexión es exactamente lo que hace
 * falta saber.
 */
export function alcanzable(url, { timeoutMs = 3000 } = {}) {
  const destino = puertoDeUrl(url)
  if (!destino) {
    return Promise.resolve({ ok: false, motivo: 'La dirección no es una URL http válida' })
  }

  return new Promise((resolve) => {
    const desde = Date.now()
    const socket = new net.Socket()
    let resuelto = false

    const terminar = (resultado) => {
      if (resuelto) return
      resuelto = true
      socket.destroy()
      resolve({ ...destino, ...resultado })
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => terminar({ ok: true, ms: Date.now() - desde }))
    socket.once('timeout', () =>
      terminar({ ok: false, motivo: `No contestó en ${timeoutMs / 1000}s` }),
    )
    socket.once('error', (err) => terminar({ ok: false, motivo: err.message }))

    socket.connect(destino.puerto, destino.host)
  })
}
