import test from 'node:test'
import assert from 'node:assert/strict'

import { config } from '../src/config.js'
import { buscarPorSerie } from '../src/drivers/genieacs.js'

test('buscarPorSerie busca la serie en los dos formatos, etiqueta y hexa', async () => {
  config.genieacs.url = 'http://acs-de-prueba.local:7557'
  let pedida = null
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    pedida = decodeURIComponent(String(url))
    return new Response('[]', { status: 200 })
  }
  try {
    assert.equal(await buscarPorSerie('HWTC83C0C443'), null)
  } finally {
    globalThis.fetch = original
  }
  assert.match(pedida, /HWTC83C0C443/)
  assert.match(pedida, /4857544383C0C443/)
})
