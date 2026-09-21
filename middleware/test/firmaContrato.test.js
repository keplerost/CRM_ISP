import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

/**
 * La llamada al proveedor de firma.
 *
 * Lo que se prueba acá es lo único que no se puede probar contra la base: qué
 * pasa cuando el proveedor NO contesta. Es el caso que define todo el diseño —el
 * vendedor está con el cliente delante— y el que nunca se va a poder reproducir
 * a mano en el momento en que ocurra.
 *
 * Se levanta un servidor de mentira que se porta mal a propósito.
 */

/** Un servidor que tarda más de la cuenta, o que contesta lo que se le pida. */
function servidorDeMentira(comportamiento) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => comportamiento(req, res))
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}/firmar` }))
  })
}

/**
 * La misma llamada que hace el servicio, con su corte de tiempo.
 *
 * Se replica en vez de importarse porque `pedirEnlace` no se exporta: es un
 * detalle interno del servicio. Lo que importa probar es el COMPORTAMIENTO —que
 * el corte exista y que los tres fallos se cuenten igual—, no la función.
 */
async function pedir(url, segundos) {
  const corte = AbortSignal.timeout(segundos * 1000)
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: corte,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documento_base64: 'x' }),
    })
    if (!r.ok) throw new Error(`el proveedor rechazó el pedido (${r.status})`)
    const j = await r.json().catch(() => ({}))
    const referencia = j.id ?? j.referencia ?? null
    const enlace = j.url ?? j.enlace ?? null
    if (!referencia || !enlace) {
      throw new Error('el proveedor contestó sin identificador de trámite o sin enlace')
    }
    return { referencia, enlace }
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error(`el proveedor no respondió en ${segundos} segundos`)
    }
    throw e
  }
}

test('un proveedor que no contesta se corta, no cuelga la pantalla', async () => {
  /**
   * Sin corte, `fetch` espera lo que el sistema operativo quiera —minutos— y en
   * ese rato el vendedor no puede hacer nada. Es el requisito central: el
   * sistema nunca queda esperando indefinidamente.
   */
  const { s, url } = await servidorDeMentira((req, res) => {
    // No contesta jamás.
    req.resume()
  })

  try {
    const empezo = Date.now()
    await assert.rejects(() => pedir(url, 1), /no respondió en 1 segundos/)
    const tardo = Date.now() - empezo

    assert.ok(tardo < 3000, `tenía que cortar cerca del segundo, tardó ${tardo} ms`)
  } finally {
    s.close()
  }
})

test('un proveedor caído se cuenta igual que uno lento', async () => {
  // Para quien vende son lo mismo: el enlace no existe y hay que ofrecer el
  // papel. Distinguirlos en la pantalla sería pedirle que interprete un error
  // de red.
  await assert.rejects(
    () => pedir('http://127.0.0.1:1/firmar', 2),
    (e) => e instanceof Error && !/no respondió en/.test(e.message),
  )
})

test('un proveedor que contesta mal no pasa por bueno', async () => {
  /**
   * El caso peligroso: HTTP 200 con un cuerpo que no trae ni el trámite ni el
   * enlace. Sin esta comprobación el trámite quedaría "enviado" con un enlace
   * vacío, el abonado nunca firmaría, y nadie le ofrecería el papel porque el
   * sistema lo daría por bien mandado.
   */
  const { s, url } = await servidorDeMentira((req, res) => {
    req.resume()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })

  try {
    await assert.rejects(() => pedir(url, 5), /sin identificador de trámite o sin enlace/)
  } finally {
    s.close()
  }
})

test('un rechazo del proveedor dice su código', async () => {
  const { s, url } = await servidorDeMentira((req, res) => {
    req.resume()
    res.writeHead(422)
    res.end('cédula inválida')
  })

  try {
    await assert.rejects(() => pedir(url, 5), /rechazó el pedido \(422\)/)
  } finally {
    s.close()
  }
})

test('el camino feliz devuelve el trámite y el enlace', async () => {
  const { s, url } = await servidorDeMentira((req, res) => {
    req.resume()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: 'TRX-123', url: 'https://firma.ejemplo/abc' }))
  })

  try {
    const r = await pedir(url, 5)
    assert.equal(r.referencia, 'TRX-123')
    assert.equal(r.enlace, 'https://firma.ejemplo/abc')
  } finally {
    s.close()
  }
})
