import express from 'express'
import cors from 'cors'
import { config, checkConfig } from './config.js'
import { AppError } from './lib/errors.js'
import { cerrarTodas } from './drivers/mikrotikApi.js'
import { cerrarTodasSsh } from './lib/sshSession.js'
import cryptoRoutes from './routes/crypto.routes.js'
import mikrotikRoutes from './routes/mikrotik.routes.js'
import oltRoutes from './routes/olt.routes.js'
import tr069Routes from './routes/tr069.routes.js'
import tiposOnuRoutes from './routes/tiposOnu.routes.js'
import migracionRoutes from './routes/migracion.routes.js'
import sriRoutes from './routes/sri.routes.js'
import pagosRoutes from './routes/pagos.routes.js'
import herramientasRoutes from './routes/herramientas.routes.js'
import instalacionesRoutes from './routes/instalaciones.routes.js'
import planesRoutes from './routes/planes.routes.js'
import ipamRoutes from './routes/ipam.routes.js'
import nmsRoutes from './routes/nms.routes.js'
import consumoRoutes from './routes/consumo.routes.js'
import comunicacionesRoutes from './routes/comunicaciones.routes.js'
import licenciaRoutes from './routes/licencia.routes.js'
import tareasRoutes from './routes/tareas.routes.js'
import generalRoutes from './routes/general.routes.js'
import portalRoutes from './routes/portal.routes.js'
import portalAdminRoutes from './routes/portalAdmin.routes.js'
import integracionRoutes from './routes/integracion.routes.js'
import integracionAdminRoutes from './routes/integracionAdmin.routes.js'
import incidenciasRoutes from './routes/incidencias.routes.js'
import v1Routes from './routes/v1.routes.js'
import plantillasWhatsappRoutes from './routes/plantillasWhatsapp.routes.js'
import alertasRoutes from './routes/alertas.routes.js'
import actasRoutes from './routes/actas.routes.js'
import corteRoutes from './routes/corte.routes.js'
import personalRoutes from './routes/personal.routes.js'
import reemplazosRoutes from './routes/reemplazos.routes.js'
import documentosRoutes from './routes/documentos.routes.js'
import firmasRoutes, { webhookFirma } from './routes/firmas.routes.js'
import webhookWhatsappRoutes from './routes/webhookWhatsapp.routes.js'
import { guardLicencia } from './lib/guardLicencia.js'
import { programarRenovacion } from './services/licencia.js'
import { rearrancar as rearrancarTareas } from './services/tareas.js'
import { arrancar as arrancarPortalCorte } from './servidorCorte.js'

const app = express()

app.use(cors({ origin: config.corsOrigin, credentials: true }))

/**
 * La migración del padrón sube un archivo entero, y no entra en 1 MB.
 *
 * Va antes que el límite general y solo para esa ruta: el resto de la API manda
 * formularios, y dejarle 25 MB a todo sería regalar una forma fácil de voltear
 * el middleware. `express.json` no vuelve a parsear un cuerpo ya leído, así que
 * el límite general de abajo no lo pisa.
 */
app.use('/api/migracion', express.json({ limit: '25mb' }))
/**
 * El extracto del banco viaja en base64 dentro del cuerpo.
 *
 * Un mes de movimientos de una cuenta con muchos abonados pasa holgadamente el
 * megabyte del límite general, y el rechazo llega como un 413 sin explicación —
 * la pantalla dice "no se pudo subir" y nadie sabe que el problema es el tamaño.
 */
app.use('/api/pagos/conciliacion', express.json({ limit: '25mb' }))

/**
 * El webhook de WhatsApp necesita el cuerpo CRUDO.
 *
 * La firma de Meta es un HMAC sobre los bytes tal cual llegaron. Comparar contra
 * el JSON vuelto a serializar falla por un espacio de diferencia, y el resultado
 * es un webhook que rechaza todo sin que se entienda por qué.
 *
 * Va antes del parser general porque `express.json` no vuelve a leer un cuerpo
 * ya consumido: el primero que lo tome define con qué opciones se parseó.
 */
app.use(
  '/api/webhooks/whatsapp',
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf
    },
  }),
)

app.use(express.json({ limit: '1mb' }))

// Log mínimo: método, ruta, status y duración. Alcanza para seguir el taller.
app.use((req, res, next) => {
  const inicio = Date.now()
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - inicio}ms)`)
  })
  next()
})

/** Health check: no requiere auth, para poder diagnosticar antes de loguearse. */
app.get('/api/health', (_req, res) => {
  const faltantes = checkConfig()
  res.json({
    ok: faltantes.length === 0,
    servicio: 'taller-smartolt-middleware',
    configuracionFaltante: faltantes,
    authRequerida: config.requireAuth,
  })
})

/**
 * La licencia va ANTES del guardián y no pasa por él.
 *
 * El cliente que quedó bloqueado tiene que poder pegar el código nuevo, y para
 * eso no puede necesitar que el sistema ya lo esté dejando entrar. Una licencia
 * que solo se renueva estando adentro es una puerta cerrada con la llave del
 * otro lado.
 */
app.use('/api/licencia', licenciaRoutes)

// La marca también va afuera: el login la muestra, y el login es justo lo que
// se ve cuando la licencia venció.
app.use('/api/general', generalRoutes)

/**
 * El aviso del proveedor de firma, también afuera.
 *
 * Quien golpea es el servidor del proveedor cuando el abonado terminó de firmar:
 * no tiene sesión de Supabase ni sabe nada de nuestra licencia. Ponerlo detrás
 * del guardia haría que la confirmación no llegue el día que la licencia esté
 * por renovarse, y los contratos quedarían firmados del lado del proveedor y sin
 * firmar del nuestro.
 *
 * Lo protege el secreto compartido y la referencia del trámite, no la sesión.
 */
app.use('/api/webhooks', webhookFirma)

/**
 * Y el de WhatsApp, por lo mismo.
 *
 * Quien golpea es el servidor de Meta. Si le contestamos algo que no sea 200
 * reintenta, y después de varios reintentos fallidos DA DE BAJA la suscripción
 * — que es como se deja de recibir acuses de entrega sin que nadie lo note.
 * Ponerlo detrás del guardián de licencia haría exactamente eso el día que la
 * licencia esté por renovarse.
 */
app.use('/api/webhooks', webhookWhatsappRoutes)

// De acá para abajo, todo exige licencia vigente.
app.use('/api', guardLicencia)

app.use('/api/crypto', cryptoRoutes)
app.use('/api/mikrotik', mikrotikRoutes)
app.use('/api/olt', oltRoutes)
// TR-069 de todas las OLTs juntas: un ACS sirve al padrón, no a un equipo.
app.use('/api/tr069', tr069Routes)
// Fuera de /api/olt/:id: un modelo de ONT es el mismo en todas las OLTs.
app.use('/api/tipos-onu', tiposOnuRoutes)
app.use('/api/migracion', migracionRoutes)
app.use('/api/sri', sriRoutes)
app.use('/api/pagos', pagosRoutes)
app.use('/api/herramientas', herramientasRoutes)
app.use('/api/instalaciones', instalacionesRoutes)
// El paso de la OLT en un cambio de ONT. La base hace el resto (migración 93);
// esto es lo único que necesita las credenciales del equipo.
app.use('/api/reemplazos', reemplazosRoutes)
app.use('/api/planes', planesRoutes)
app.use('/api/ipam', ipamRoutes)
app.use('/api/nms', nmsRoutes)
app.use('/api/consumo', consumoRoutes)
app.use('/api/comunicaciones', comunicacionesRoutes)
// Las plantillas aprobadas de WhatsApp. Sin una aprobada, ningún aviso
// automático sale por ahí: Meta solo entrega plantillas fuera de la ventana
// de 24 h, y esa ventana con un aviso de cobranza nunca está abierta.
app.use('/api/plantillas-whatsapp', plantillasWhatsappRoutes)

// Cortes masivos y mantenimientos programados. Va con el resto de la red y no
// con las comunicaciones: lo que decide a quién se le avisa es la topología —de
// qué caja o de qué torre cuelga cada abonado—, no el canal por el que sale.
app.use('/api/incidencias', incidenciasRoutes)

// Personal, roles y permisos. Escribir usuarios pasa siempre por acá: crear la
// credencial exige la service_role key, y la regla de quién puede crear a quién
// solo vale si la verifica el servidor.
app.use('/api/personal', personalRoutes)

/**
 * El portal del abonado.
 *
 * Va DESPUÉS del guardián de licencia a propósito: si el ISP no le paga al
 * proveedor, el portal se apaga junto con el resto. Es coherente con el corte
 * total que se eligió, pero conviene tenerlo presente — es la parte del bloqueo
 * que ven los clientes del ISP, no su personal.
 */
app.use('/api/portal', portalRoutes)

// La administración del portal, para el personal del ISP. Va aparte del router
// del abonado: una ruta de administración colgada de aquel quedaría abierta a
// cualquiera con cuenta de abonado, que son todos los clientes del ISP.
app.use('/api/portal-admin', portalAdminRoutes)

/**
 * La API de los sistemas externos: el CRM y el bot de WhatsApp.
 *
 * Va DESPUÉS del guardián de licencia, igual que el portal del abonado, y por
 * la misma razón: si el ISP no le paga al proveedor se apaga con todo lo demás.
 * Conviene tenerlo presente — es la parte del bloqueo que van a notar los
 * clientes del ISP en su chat, no su personal.
 *
 * No pasa por `requireAuth`: quien llama es un programa de otra empresa y no
 * tiene sesión de Supabase. Lo autoriza su llave, que cada ruta verifica con
 * `requireApiKey` junto con el permiso que esa ruta necesita.
 */
app.use('/api/integracion', integracionRoutes)

// La administración de esas llaves y la bandeja de pagos reportados: eso sí lo
// mira el personal, con su sesión. Va aparte por lo mismo que `portal-admin`:
// una ruta de administración colgada del router del bot quedaría alcanzable con
// la llave del bot.
/**
 * El contrato que consume el agente de IA del CRM.
 *
 * Va aparte de `/api/integracion` porque es un contrato con otra empresa: su
 * forma de respuesta —`status`, `code`, `message`— es parte de lo acordado, y
 * cambiarla rompe del otro lado. Las dos superficies usan los mismos servicios:
 * no hay dos implementaciones de "cuánto debe este abonado".
 */
app.use('/api/v1', v1Routes)

app.use('/api/integracion-admin', integracionAdminRoutes)
app.use('/api/tareas', tareasRoutes)
app.use('/api/alertas', alertasRoutes)
app.use('/api/actas', actasRoutes)
app.use('/api/corte', corteRoutes)
app.use('/api/documentos', documentosRoutes)
app.use('/api/firmas', firmasRoutes)

app.use((req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.originalUrl}` })
})

// eslint-disable-next-line no-unused-vars -- Express identifica el error handler por tener 4 argumentos
app.use((err, _req, res, _next) => {
  const status = err instanceof AppError ? err.status : 500
  if (status >= 500) console.error(err)

  // Para el rastro de las integraciones: `requireApiKey` anota la llamada cuando
  // la respuesta ya salió, y ahí solo tiene el status. Sin esto, el registro de
  // Ajustes → Integraciones muestra "403" sin decir de qué — que es justo lo que
  // el proveedor del CRM va a preguntar.
  res.locals.errorApi = (err.message || '').slice(0, 500) || null
  res.status(status).json({
    error: err.message || 'Error interno',
    ...(err.hint ? { hint: err.hint } : {}),
    ...(err.detalle ? { detalle: err.detalle } : {}),
    // Lo que el error haya adjuntado: la foto de una ONT que quedó a medias, la
    // lista de OLTs para poder elegir una. Sin esto, los mensajes que dicen "está
    // en la respuesta" mienten.
    ...(err.extra ?? {}),
  })
})

/**
 * Red de contención para errores que escapan del flujo de un request.
 *
 * Las librerías de red emiten errores de forma asíncrona, desde manejadores de
 * eventos: no hay try/catch que los agarre. Un caso real: al consultar un
 * address-list vacío, RouterOS responde `!empty`, node-routeros no reconoce esa
 * respuesta y lanza — matando el proceso. Desde la UI eso se ve como "no se
 * puede contactar al middleware", que no dice nada sobre la causa.
 *
 * Se registra el error y se sigue: para esta aplicación, cada request es
 * independiente, así que un fallo suelto no deja el estado inconsistente. Morir
 * en silencio es peor.
 */
/**
 * Al salir se cierran las sesiones abiertas contra los MikroTik. Si no, quedan
 * colgadas del lado del equipo hasta que él las expire, y estos routers admiten
 * muy pocas simultáneas.
 */
for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, async () => {
    console.log('\n  Cerrando sesiones abiertas…')
    // Las dos: la API binaria de los routers y el SSH de las OLTs. Una OLT sin
    // timeout de inactividad no libera sola la sesión que quede colgada, y hay
    // que ir a soltarla a mano desde su interfaz web.
    await Promise.all([cerrarTodas(), cerrarTodasSsh()])
    process.exit(0)
  })
}

process.on('uncaughtException', (err) => {
  console.error('\n[ERROR NO CAPTURADO] El middleware sigue en pie, pero revisá esto:')
  console.error(err)
})

process.on('unhandledRejection', (err) => {
  console.error('\n[PROMESA RECHAZADA SIN CAPTURAR]')
  console.error(err)
})

/**
 * La página del abonado cortado, en su propio puerto.
 *
 * Se levanta antes que la API y por separado: que no pueda abrir su puerto no
 * puede impedir que arranque el sistema con el que trabaja el ISP.
 */
arrancarPortalCorte({ puerto: config.portalCorte })

app.listen(config.port, () => {
  const faltantes = checkConfig()
  console.log(`\n  Middleware escuchando en http://localhost:${config.port}`)
  console.log(`  CORS permitido para: ${config.corsOrigin.join(', ')}`)
  if (faltantes.length) {
    console.warn(`\n  ⚠ Falta configurar en .env: ${faltantes.join(', ')}`)
    console.warn('  Los endpoints que tocan la base o los equipos van a fallar hasta completarlo.\n')
  } else {
    console.log('  Configuración completa.\n')
  }

  // El corte de las promesas vencidas se programa recién con el servidor
  // arriba: si la configuración está incompleta, no tiene con qué trabajar.
  if (!faltantes.length) {
    // Antes que los automatismos: es lo que decide si el sistema trabaja.
    if (programarRenovacion()) {
      console.log(`  Licencia: se renueva sola contra ${config.licencia.servidor}, todos los días.`)
    }

    /**
     * Los automatismos los arma `tareas`, que es también quien los reprograma
     * cuando se cambian desde la pantalla. Si arrancaran acá por su cuenta,
     * apagar el corte automático desde Ajustes no apagaría el que ya está
     * corriendo — quedarían dos verdades distintas sobre lo mismo.
     */
    rearrancarTareas()
      .then(({ encendidas }) => {
        console.log(
          encendidas.length
            ? `  Automatismos encendidos: ${encendidas.join(' · ')}.`
            : '  Automatismos: todos apagados (se encienden en Ajustes → Tareas programadas).',
        )
      })
      .catch((err) => console.error('  No se pudieron arrancar los automatismos:', err.message))
  }
})
