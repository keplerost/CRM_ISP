import { db } from '../lib/db.js'
import { fechaLocal } from './cortesPromesas.js'
import { destinoDe, enviar, seEntrego } from './mensajeria.js'
import { dinero, fechaCorta, periodoDe, sumarDias } from './variablesAviso.js'
import { correoDeFactura } from './correoFactura.js'

/**
 * Los tres avisos de pago.
 *
 * ── Qué decide este archivo y qué no ──
 *
 * QUIÉN recibe cuál lo decide `v_avisos_pago_pendientes` en la base: es una
 * cuenta de fechas contra las facturas impagas, y en SQL se puede mirar sin
 * mandar nada. Acá se decide POR DÓNDE se le escribe a cada uno y qué se
 * registra.
 *
 * QUÉ dice cada aviso no lo decide nadie de este lado: sale del editor de
 * plantillas. Ese era el punto de engancharlos.
 *
 * ── Por qué el canal se elige por abonado y no una vez para todos ──
 *
 * Porque el que dejó su correo y el que solo dejó un celular necesitan cosas
 * distintas, y mandarle un correo al que no tiene correo es no mandarle nada.
 * La configuración dice 'preferido' de fábrica: se usa el canal que el abonado
 * eligió, y si por ese no se le puede llegar, se prueban los otros.
 */

export const estadoAvisosPago = {
  automaticas: false,
  hora: '09:00',
  ultimaCorrida: null,
  ultimoResultado: null,
}

function llegoLaHora(ahora, hora) {
  const [h, m] = String(hora ?? '09:00')
    .split(':')
    .map(Number)
  return ahora.getHours() > h || (ahora.getHours() === h && ahora.getMinutes() >= m)
}

/**
 * Por dónde se le puede escribir a este abonado, en orden de preferencia.
 *
 * El canal que eligió va primero. Después los demás, porque un aviso que sale
 * por el canal equivocado sigue siendo mejor que uno que no sale — la deuda no
 * se entera de nuestras preferencias.
 */
export function canalesPara(abonado, configurado = 'preferido') {
  const todos = ['whatsapp', 'telegram', 'email', 'sms']

  const orden =
    configurado === 'preferido'
      ? [abonado.canal_preferido, ...todos].filter(Boolean)
      : [configurado]

  /**
   * Lo que el abonado aceptó.
   *
   * `null` es "por los que se pueda", que es como venía funcionando. Una lista
   * lo restringe a esos y manda sobre todo lo demás —incluso sobre el canal que
   * el ISP haya fijado en la configuración general—: si el abonado pidió que le
   * escriban solo por WhatsApp, mandarle un correo es desoírlo, y desoírlo es
   * la razón por la que después pide que lo saquen de todo.
   *
   * Una lista VACÍA es "por ninguno", y es distinto de `null`: alguien la dejó
   * así a propósito.
   */
  const acepta = Array.isArray(abonado.avisos_canales) ? new Set(abonado.avisos_canales) : null

  const vistos = new Set()
  return orden.filter((c) => {
    if (vistos.has(c)) return false
    vistos.add(c)
    if (acepta && !acepta.has(c)) return false
    // Sin dirección o número, ese canal no existe para este abonado.
    return !!destinoDe(c, abonado)
  })
}

/**
 * Qué plantilla le toca a cada canal.
 *
 * ── Por qué el correo va aparte de los otros tres ──
 *
 * Porque el largo cambia todo. Un correo bien escrito —con su saludo, su
 * párrafo de cortesía y su despedida— es un pésimo SMS: pasa los 160
 * caracteres, se cobra como dos mensajes y le llega al abonado partido, con el
 * segundo pedazo sin contexto. Y si lleva HTML, recibe las etiquetas.
 *
 * WhatsApp y Telegram no tienen ese límite, pero comparten con el SMS la forma
 * de leerse: en el teléfono, de un vistazo, entre otros mensajes. La plantilla
 * corta les sirve a los tres.
 */
export function plantillaDe(canal, aviso = {}) {
  return canal === 'email' ? aviso.plantilla_email_id : aviso.plantilla_corta_id
}

/**
 * Los canales por los que este aviso puede salir de verdad.
 *
 * Hacen falta las dos cosas: que el abonado tenga esa dirección cargada Y que la
 * plantilla de ese canal esté activa. Un abonado con correo cargado y la
 * plantilla de correo desactivada no recibe nada por ahí, y contarlo como
 * "tiene canal" haría que la vista previa prometa un envío que no va a ocurrir.
 */
export function canalesUtiles(aviso, configurado = 'preferido') {
  return canalesPara(aviso, configurado).filter((c) => plantillaDe(c, aviso))
}

/**
 * Una corrida.
 *
 * Devuelve qué se mandó y qué no, con el motivo. Un resumen que solo diga
 * "42 enviados" esconde a los que quedaron afuera, que son los que hay que
 * mirar: el abonado sin correo ni celular no se entera de nada y nadie lo sabe.
 */
export async function ejecutarAvisosPago({ soloSimular = false } = {}) {
  const { data: config, error: eConf } = await db()
    .from('config_avisos_pago')
    .select('*')
    .eq('id', 1)
    .maybeSingle()

  if (eConf) {
    const falta = /does not exist/i.test(eConf.message)
    throw new Error(
      falta
        ? 'Falta la tabla config_avisos_pago. Corré supabase/migracion-127-los-tres-avisos-de-pago.sql'
        : `No se pudo leer la configuración: ${eConf.message}`,
    )
  }

  if (!config?.activa && !soloSimular) {
    return { enviados: 0, aviso: 'Los avisos de pago están apagados en su configuración.' }
  }

  const { data: pendientes, error } = await db()
    .from('v_avisos_pago_pendientes')
    .select('*')
    .limit(config?.limite ?? 200)

  if (error) throw new Error(`No se pudieron leer los avisos pendientes: ${error.message}`)

  const resultado = {
    pendientes: pendientes?.length ?? 0,
    enviados: 0,
    sin_canal: [],
    fallidos: [],
    por_nivel: { 1: 0, 2: 0, 3: 0, 4: 0 },
    simulado: soloSimular,
  }

  for (const a of pendientes ?? []) {
    const canales = canalesUtiles(a, config?.canal ?? 'preferido')

    if (!canales.length) {
      // No es un error del sistema: es un abonado sin forma de contacto. Se
      // informa para que alguien le pida el número, no para que se ignore.
      resultado.sin_canal.push({ cliente_id: a.cliente_id, nombre: a.nombre, nivel: a.nivel })
      continue
    }

    if (soloSimular) {
      resultado.enviados++
      resultado.por_nivel[a.nivel]++
      continue
    }

    /**
     * Las dos plantillas del nivel, tal como están guardadas.
     *
     * Se leen acá y no en la vista para que editarlas tenga efecto en la corrida
     * siguiente sin tocar nada más.
     */
    const ids = [a.plantilla_email_id, a.plantilla_corta_id].filter(Boolean)
    const { data: plantillas } = await db()
      .from('plantillas_mensaje')
      .select('id, asunto, cuerpo')
      .in('id', ids)

    const porId = new Map((plantillas ?? []).map((p) => [p.id, p]))

    if (!porId.size) {
      resultado.fallidos.push({ nombre: a.nombre, motivo: 'la plantilla ya no existe' })
      continue
    }

    /**
     * Se prueba canal por canal hasta que uno salga, con la plantilla que le
     * corresponde a ese canal.
     *
     * Si el canal no tiene la suya activa, se salta. No se cae a la del otro
     * formato a propósito: mandar un correo entero por SMS pasa los 160
     * caracteres, se cobra doble y llega partido; y mandar el SMS por correo le
     * llega al abonado como un mensaje seco de una línea. Desactivar una
     * plantilla es decir "por acá no".
     *
     * `enviar` deja registrada la comunicación aunque falle, con estado
     * 'fallido'. Esa fila es la que permite reintentar mañana: la vista solo
     * excluye a los que tienen un envío NO fallido.
     */
    /**
     * Lo que las plantillas nombran y no está en la ficha del abonado.
     *
     * `enviar` arma solo lo del abonado —nombre, saldo, plan— porque es lo único
     * que sabe. Todo lo que sale de la FACTURA hay que pasárselo desde acá.
     *
     * Sin esto, los tres avisos salían con los marcadores crudos: el abonado
     * recibía "Su servicio será suspendido el {{fecha_corte}}". No fallaba
     * nunca, porque un marcador sin dato se deja tal cual en vez de romper — que
     * es lo correcto para no perder el resto del mensaje, y también lo que hace
     * que este error pase inadvertido hasta que alguien lee un correo enviado.
     */
    const variables = {
      periodo: periodoDe(a.concepto, a.fecha_vencimiento),
      total: dinero(a.importe_total),
      saldo: dinero(a.saldo),
      fecha_vencimiento: fechaCorta(a.fecha_vencimiento),
      /**
       * Desde cuándo queda expuesto a la suspensión.
       *
       * ── Por qué esta fecha y no otra ──
       *
       * El corte de verdad lo decide `cortar_tras_meses` de cada ficha, que
       * puede ser uno, dos o doce meses. Calcular eso acá sería duplicar la
       * lógica del corte por mora, y duplicarla es garantizar que un día las dos
       * cuentas den distinto.
       *
       * Se usa la fecha del ÚLTIMO ESCALÓN, que es la misma con la que este
       * archivo decidió mandar este aviso. Así el mensaje y el sistema dicen lo
       * mismo: al abonado se le avisa el día que el sistema lo considera en
       * riesgo, no una fecha inventada aparte.
       */
      /**
       * Salvo en el nivel 4, donde el corte ya ocurrió.
       *
       * Ahí no hay nada que estimar: la vista trae `cortado_en`, que es el día
       * en que el sistema lo suspendió. Seguir usando la estimación de arriba
       * le diría "suspendido desde el 12" a alguien cortado el 9, y esa es
       * justo la clase de detalle que el abonado sí revisa cuando reclama.
       */
      fecha_corte:
        a.nivel === 4 && a.cortado_en
          ? fechaCorta(a.cortado_en)
          : fechaCorta(sumarDias(a.fecha_vencimiento, config?.dias_aviso_3 ?? 5)),
      factura: a.factura_numero ? String(a.factura_numero) : '',
      concepto: a.concepto ?? '',
    }

    let salio = false
    let ultimoError = null
    // El canal que quedó escrito para mandar a mano, si no entregó ninguno.
    let preparado = null

    for (const canal of canales) {
      const plantilla = porId.get(plantillaDe(canal, a))
      if (!plantilla) continue

      /**
       * Por correo, el aviso con formato: logo, cuentas, botón y el PDF.
       *
       * Es donde más se nota: el abonado que recibe un aviso de corte necesita
       * ver a qué cuenta depositar sin salir del mensaje. Por el teléfono va el
       * texto corto de la plantilla, que es lo que corresponde ahí.
       */
      let conFormato = null
      if (canal === 'email') {
        try {
          conFormato = await correoDeFactura({
            factura: {
              id: a.factura_id,
              numero: a.factura_numero,
              concepto: a.concepto,
              fecha_vencimiento: a.fecha_vencimiento,
              total: a.importe_total,
              saldo: a.saldo,
            },
            cliente: { nombre: a.nombre },
            /**
             * El nivel del aviso decide el tono, nada más.
             *
             * El 4 es `cortado`: ya no avisa de algo que va a pasar, habla de
             * un servicio que YA está suspendido. Si cayera en el `?? 'vencida'`
             * le diría al abonado que su factura venció mientras él sabe que
             * hace semanas que no tiene internet, y ese desajuste es lo que
             * hace que el próximo mensaje no se lea.
             */
            tipo:
              { 1: 'recordatorio', 2: 'vencida', 3: 'ultimo', 4: 'cortado' }[a.nivel] ?? 'vencida',
            fechaCorte: variables.fecha_corte,
            // Lo que el ISP escribió para este nivel.
            plantilla,
          })
        } catch {
          // Se cae a la plantilla de texto.
        }
      }

      try {
        const r = await enviar({
          client_id: a.cliente_id,
          canal,
          asunto: conFormato?.asunto ?? plantilla.asunto,
          cuerpo: conFormato?.texto ?? plantilla.cuerpo,
          html: conFormato?.html ?? null,
          adjuntos: conFormato?.adjuntos ?? [],
          plantilla_id: plantilla.id,
          factura_id: a.factura_id,
          automatico: true,
          variables,
        })

        /**
         * Pendiente no es salido.
         *
         * WhatsApp sin proveedor deja el mensaje escrito para mandarlo a mano y no
         * lanza error. Tomarlo como envío y cortar acá dejaba al abonado sin
         * recordatorio y al ISP creyendo que se lo mandó — y en cobranza eso se
         * descubre recién cuando el abonado dice "a mí nadie me avisó".
         */
        if (!seEntrego(r)) {
          preparado = preparado ?? canal
          continue
        }

        salio = true
        break
      } catch (e) {
        ultimoError = e.message
      }
    }

    if (!salio && !ultimoError && !preparado) {
      ultimoError = 'ninguna plantilla activa para los canales de este abonado'
    }

    if (salio) {
      resultado.enviados++
      resultado.por_nivel[a.nivel]++
    } else if (preparado) {
      /**
       * No entregó ninguno, pero quedó escrito para mandar a mano.
       *
       * Va en su propia lista y no entre los enviados: contarlo como enviado es
       * lo que hacía que la corrida informara "42 avisos" cuando ninguno había
       * llegado. Y no va entre los fallidos porque no falló nada: está esperando
       * que alguien lo mande desde WhatsApp.
       */
      resultado.pendientes_a_mano ??= []
      resultado.pendientes_a_mano.push({ nombre: a.nombre, nivel: a.nivel, canal: preparado })
    } else {
      resultado.fallidos.push({ nombre: a.nombre, nivel: a.nivel, motivo: ultimoError })
    }
  }

  return resultado
}

/**
 * Arranca la tarea diaria.
 *
 * A media mañana a propósito: un recordatorio de deuda a las seis de la mañana
 * molesta y no se lee.
 */
export function programarAvisosPago({
  activo = false,
  hora = '09:00',
  intervaloMs = 5 * 60 * 1000,
  ejecutar = ejecutarAvisosPago,
} = {}) {
  estadoAvisosPago.automaticas = activo
  estadoAvisosPago.hora = hora

  if (!activo) return null

  const revisar = async () => {
    const ahora = new Date()
    const hoy = fechaLocal(ahora)

    if (estadoAvisosPago.ultimaCorrida === hoy) return
    if (!llegoLaHora(ahora, hora)) return

    estadoAvisosPago.ultimaCorrida = hoy
    try {
      const r = await ejecutar()
      estadoAvisosPago.ultimoResultado = r
      console.log(
        `[avisos-pago] ${r.enviados} enviados ` +
          `(1: ${r.por_nivel?.[1] ?? 0} · 2: ${r.por_nivel?.[2] ?? 0} · ` +
          `3: ${r.por_nivel?.[3] ?? 0} · 4: ${r.por_nivel?.[4] ?? 0}), ` +
          `${r.sin_canal?.length ?? 0} sin forma de contacto, ${r.fallidos?.length ?? 0} fallidos`,
      )
    } catch (e) {
      estadoAvisosPago.ultimoResultado = { error: e.message }
      console.error(`[avisos-pago] ${e.message}`)
    }
  }

  const timer = setInterval(revisar, intervaloMs)
  timer.unref?.()
  revisar()

  return timer
}
