import express from 'express'

import { db } from './lib/db.js'
import { armar, html, htmlDesconocido } from './services/paginaCorte.js'

/**
 * El servidor de la página del abonado cortado.
 *
 * ── Por qué es un servidor aparte y no una ruta más de la API ──
 *
 * Porque el router le manda a este puerto TODO el tráfico web del cortado, sea
 * cual sea la dirección que haya escrito. Alguien que quiso entrar a un diario
 * llega acá con la ruta `/edicion/hoy`, y otro con `/favicon.ico`. Este servidor
 * contesta lo mismo a cualquier ruta, y eso es incompatible con una API donde
 * cada ruta significa algo.
 *
 * Además, el que se conecta acá no tiene sesión y no debería poder ni intentar
 * llegar a la API: separarlos por puerto es la forma más simple de garantizarlo.
 * Este proceso solo sabe leer una ficha por IP y devolver HTML.
 */

/**
 * La IP del que pide, tal como la ve el sistema operativo.
 *
 * NO se usa `X-Forwarded-For`: acá esa cabecera la manda el propio abonado —no
 * hay ningún proxy nuestro en el medio— y confiar en ella dejaría que cualquiera
 * viera el saldo de otro escribiendo una cabecera. La única fuente válida es la
 * dirección del socket, que la pone el kernel.
 */
export function ipDelPedido(req) {
  const cruda = req.socket?.remoteAddress ?? ''
  // Node devuelve las IPv4 mapeadas a IPv6 como "::ffff:172.16.1.5".
  return cruda.replace(/^::ffff:/, '')
}

/** Lee lo que la página necesita. Nunca lanza: una página rota no ayuda a nadie. */
async function datosPara(ip) {
  const [rConf, rCuentas, rEmpresa, rAbonado, rPlantilla] = await Promise.all([
    db().from('config_corte').select('*').eq('id', 1).maybeSingle(),
    db().from('cuentas_pago').select('*').eq('mostrar_en_corte', true),
    // El RUC entra a propósito: es de donde sale la identificación del titular
    // cuando la cuenta no trae la suya.
    db().from('sri_config')
      .select('ruc, razon_social, nombre_comercial, telefono, logo_b64')
      .limit(1).maybeSingle(),
    db().from('v_corte_abonado').select('*').eq('ip', ip).maybeSingle(),

    /**
     * El texto, desde el editor de plantillas.
     *
     * Es lo que hace que el editor no sea decorativo: lo que alguien escribe en
     * Ajustes → Plantillas → Aviso de corte es literalmente lo que va a leer el
     * abonado. Si la plantilla no está o está desactivada, se cae al texto de
     * `config_corte`, que es de donde salía antes.
     */
    /**
     * Las DOS plantillas web: la del corte y la del aviso previo.
     *
     * Se traen las dos en el mismo viaje y decide `armar` cuál usar según la
     * situación del abonado. Traer solo la que corresponde exigiría saber esa
     * situación antes de leer su ficha, que es lo que se está leyendo.
     */
    db().from('plantillas_mensaje')
      .select('clave, asunto, cuerpo, activa')
      .in('clave', ['web_aviso_corte', 'web_aviso_pago']),
  ])

  const plantillas = new Map(
    (rPlantilla.data ?? []).filter((p) => p.activa).map((p) => [p.clave, p]),
  )
  const corte = plantillas.get('web_aviso_corte')
  const aviso = plantillas.get('web_aviso_pago')

  return {
    config: {
      ...(rConf.data ?? {}),
      ...(corte ? { titulo: corte.asunto || rConf.data?.titulo, mensaje: corte.cuerpo } : {}),
      ...(aviso ? { titulo_aviso: aviso.asunto, mensaje_aviso: aviso.cuerpo } : {}),
    },
    cuentas: rCuentas.data ?? [],
    empresa: rEmpresa.data ?? {},
    abonado: rAbonado.data ?? null,
    // Si la tabla no existe todavía, se dice: es la diferencia entre "no corriste
    // la migración" y "no configuraste la página".
    faltaMigracion: /does not exist/i.test(rConf.error?.message ?? ''),
  }
}

export function crearApp() {
  const app = express()
  app.disable('x-powered-by')

  app.use(async (req, res) => {
    const ip = ipDelPedido(req)

    try {
      const { config, cuentas, empresa, abonado, faltaMigracion } = await datosPara(ip)

      if (faltaMigracion) {
        console.warn('[corte] falta la migración 124: la página no se puede armar')
        return res
          .status(503)
          .type('html')
          .send(htmlDesconocido({ empresa: {}, telefono: null }))
      }

      /**
       * Apagada quiere decir apagada.
       *
       * Si alguien enciende las reglas del router antes de configurar la página,
       * lo correcto es contestar algo legible y no una página con los campos
       * vacíos que haga dudar al abonado de si su ISP existe.
       */
      if (!config.activa) {
        return res
          .status(503)
          .type('html')
          .send(htmlDesconocido({ empresa, telefono: empresa.telefono }))
      }

      /**
       * El abonado que pidió no ver la pantalla.
       *
       * Se le contesta lo mismo que a un desconocido: sigue cortado —esto no
       * cambia nada de eso— pero no se le explica por qué en el navegador. Es
       * para el que se molesta con la interrupción y prefiere enterarse por
       * otro lado.
       */
      if (abonado && abonado.avisos_pantalla === false) {
        console.log(`[corte] ${ip} — ${abonado.nombre} pidió no ver la pantalla`)
        return res
          .status(200)
          .set('Cache-Control', 'no-store')
          .type('html')
          .send(
            htmlDesconocido({
              empresa,
              telefono: config.telefono_pagos ?? empresa.telefono,
              whatsapp: config.whatsapp_pagos || empresa.telefono,
            }),
          )
      }

      if (!abonado) {
        console.log(`[corte] ${ip} — no hay ninguna ficha con esa IP`)
        return res
          .status(200)
          .type('html')
          .send(
            htmlDesconocido({
              empresa,
              telefono: config.telefono_pagos ?? empresa.telefono,
              // El mismo respaldo que usa la página del abonado reconocido: al
              // que no pudimos identificar es todavía MÁS importante darle un
              // número, porque es el que no tiene ninguna otra pista.
              whatsapp: config.whatsapp_pagos || empresa.telefono,
            }),
          )
      }

      const datos = armar({ abonado, config, cuentas, empresa })
      console.log(`[corte] ${ip} — ${abonado.nombre} · ${datos.motivo} · $${abonado.saldo}`)

      /**
       * Sin caché, y es importante.
       *
       * El abonado paga, se lo reactiva, y vuelve a abrir el navegador. Si esta
       * página quedó cacheada, la ve de nuevo con la deuda vieja y llama
       * diciendo que sigue cortado cuando ya tiene internet.
       */
      res
        .status(200)
        .set('Cache-Control', 'no-store, no-cache, must-revalidate')
        .type('html')
        .send(html(datos))
    } catch (e) {
      console.error(`[corte] ${ip} — ${e.message}`)
      res.status(500).type('html').send(htmlDesconocido({}))
    }
  })

  return app
}

/**
 * Arranca el servidor, si está configurado.
 *
 * Devuelve el servidor o `null`. Que no arranque no puede impedir que arranque
 * la API: son dos cosas independientes y la API es la que hace funcionar al ISP.
 */
export function arrancar({ puerto } = {}) {
  if (!puerto) return null

  const servidor = crearApp().listen(puerto, () => {
    console.log(`[corte] página del abonado cortado en el puerto ${puerto}`)
  })

  servidor.on('error', (e) => {
    console.error(`[corte] no se pudo abrir el puerto ${puerto}: ${e.message}`)
  })

  return servidor
}
