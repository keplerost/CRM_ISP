import { Router } from 'express'
import { asyncHandler, notFound, badRequest, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { db, cargarOlt, cargarRouter } from '../lib/db.js'
import { aEntero, rangosDeTexto, primeraLibre, totalDeRangos } from '../lib/ip.js'
import * as mk from '../services/mikrotikService.js'
import * as olt from '../services/oltService.js'
import * as ficha from '../services/oltFicha.js'
import * as traslados from '../services/traslados.js'
import * as preaut from '../services/preautorizacion.js'
import * as vlans from '../services/vlansOlt.js'

/**
 * Alta autónoma del técnico en campo.
 *
 * Cada ruta es un paso del asistente del celular, y todas comparten la misma
 * forma: consultan el equipo de verdad, guardan lo que respondió en la fila de
 * la instalación y devuelven el resultado ya interpretado.
 *
 * Que el resultado se guarde y no solo se devuelva es lo que permite que el
 * técnico pierda la señal en medio del trabajo y retome donde estaba. En la
 * calle eso pasa todos los días.
 *
 * Igual que en herramientas: el objetivo se deduce de la instalación y no llega
 * desde el navegador. Si la pantalla mandara la IP o el id del router, un alta
 * con un dato mal copiado escribiría configuración en el equipo de otro nodo.
 */

const router = Router()
router.use(requireAuth)

/**
 * Umbrales del semáforo.
 *
 * Los mismos números que usa la vista `v_instalaciones` en la base. Están
 * duplicados a propósito y no se leen de un lado: el técnico tiene que ver el
 * color en el momento de la lectura, antes de que nada se haya guardado.
 */
const OPTICA = { optimo: -25, limite: -27, saturado: -8 }
const RADIO = { optimo: -70, limite: -80, ccqMinimo: 80 }

function semaforoOptico(rx) {
  if (rx == null) return null
  if (rx < OPTICA.limite || rx > OPTICA.saturado) return 'rojo'
  if (rx < OPTICA.optimo) return 'ambar'
  return 'verde'
}

function semaforoRadio(senal, ccq) {
  if (senal == null) return null
  if (senal < RADIO.limite) return 'rojo'
  if (senal < RADIO.optimo || (ccq != null && ccq < RADIO.ccqMinimo)) return 'ambar'
  return 'verde'
}

/** La instalación, o el motivo por el que no se puede trabajar sobre ella. */
async function cargarInstalacion(id) {
  const { data, error } = await db().from('instalaciones').select('*').eq('id', id).maybeSingle()
  if (error) throw new AppError(`No se pudo leer la instalación: ${error.message}`, { status: 502 })
  if (!data) throw notFound('No existe esa instalación')
  if (data.estado === 'cancelada') {
    throw badRequest('La instalación está cancelada: no se puede seguir trabajando sobre ella')
  }
  return data
}

/** Guarda el avance del asistente. `paso` nunca retrocede. */
async function guardar(id, cambios, pasoMinimo) {
  const fila = { ...cambios }
  if (pasoMinimo != null) {
    const { data } = await db().from('instalaciones').select('paso').eq('id', id).maybeSingle()
    fila.paso = Math.max(Number(data?.paso ?? 0), pasoMinimo)
  }

  const { data, error } = await db()
    .from('instalaciones')
    .update(fila)
    .eq('id', id)
    .select('*')
    .single()

  if (error) throw new AppError(`No se pudo guardar el avance: ${error.message}`, { status: 502 })
  return data
}

/** Deja constancia de lo que se le pidió al equipo, salga bien o mal. */
async function registrando(req, { instalacion, comando, parametros = {}, destino }, fn) {
  const arranque = Date.now()
  let salida = null
  let exito = true
  let error = null

  try {
    salida = await fn()
    return salida
  } catch (err) {
    exito = false
    error = err.message
    throw err
  } finally {
    await db()
      .from('comandos_ejecutados')
      .insert({
        client_id: instalacion.client_id ?? null,
        destino_tipo: destino?.tipo ?? 'mikrotik',
        destino_id: destino?.id ?? null,
        destino_nombre: destino?.nombre ?? null,
        comando,
        parametros: { ...parametros, instalacion_id: instalacion.id },
        salida: salida ? JSON.stringify(salida).slice(0, 4000) : null,
        exito,
        error,
        duracion_ms: Date.now() - arranque,
        created_by: req.usuario?.id ?? null,
        ip_origen: (req.headers['x-forwarded-for'] ?? req.ip ?? '').split(',')[0].trim() || null,
      })
      .then(({ error: e }) => e && console.error('[instalaciones] no se registró el comando:', e.message))
  }
}

/**
 * De qué OLT y qué puerto PON cuelga esta instalación.
 *
 * Si no se cargó a mano, sale de la caja NAP que se eligió al validar la
 * factibilidad: es el dato que ya se sabe y que el técnico no tendría por qué
 * volver a escribir arriba de una escalera.
 */
async function ubicacionOptica(inst, elegido = {}) {
  // Lo que el técnico eligió recién manda sobre todo lo demás: es lo único que
  // se sabe con la escalera puesta y la caja abierta.
  let oltId = elegido.olt_id || inst.olt_id
  let puerto = elegido.puerto_pon ?? inst.puerto_pon
  let napId = elegido.nap_id || inst.nap_id

  if ((!oltId || puerto == null) && napId) {
    const { data: nap } = await db()
      .from('puntos_red')
      .select('olt_id, puerto_pon')
      .eq('id', napId)
      .maybeSingle()
    oltId = oltId ?? nap?.olt_id ?? null
    puerto = puerto ?? nap?.puerto_pon ?? null
  }

  if (!oltId) {
    // El mensaje ofrecía elegir la OLT en este paso y no había forma de hacerlo:
    // el técnico quedaba trabado arriba de la escalera leyendo una instrucción
    // imposible. Ahora se puede, y por eso el texto dice cómo.
    const { data: olts } = await db()
      .from('olts')
      .select('id, nombre, numero')
      .eq('activo', true)
      .order('numero')

    throw badRequest('La instalación no tiene OLT asignada', {
      hint:
        'Elegila abajo y volvé a medir. Queda guardada en la orden, así que se pregunta una sola vez. ' +
        'Lo normal es que salga sola de la caja NAP elegida al validar la factibilidad.',
      // La pantalla las necesita para poder ofrecerlas sin otra vuelta al
      // servidor: el técnico está en la calle y cada consulta es tiempo.
      olts: olts ?? [],
    })
  }

  // Se recuerda en la orden. Sin esto, el técnico tendría que elegir la misma
  // OLT en cada paso que le pregunte al equipo.
  if (oltId !== inst.olt_id || (puerto != null && puerto !== inst.puerto_pon)) {
    const cambios = { olt_id: oltId }
    if (puerto != null) cambios.puerto_pon = String(puerto)
    if (napId && napId !== inst.nap_id) cambios.nap_id = napId
    await db().from('instalaciones').update(cambios).eq('id', inst.id)
  }

  // El puerto puede venir escrito "0/1/2" o "2": interesa el último número, que
  // es el PON. Sin puerto no se falla — se barre el slot entero, que tarda más
  // pero encuentra igual.
  const numero = String(puerto ?? '').match(/(\d+)\s*$/)
  return { oltId, puerto: numero ? Number(numero[1]) : undefined }
}

/**
 * Dónde vimos por última vez esa serie en esta OLT.
 *
 * Se mira primero la cola de espera y después las ONUs dadas de alta, porque en
 * una instalación nueva la ONT todavía no está autorizada: está esperando.
 *
 * Es solo una PISTA de por dónde empezar a buscar. Si está vieja, la búsqueda
 * no la encuentra ahí y sigue barriendo igual — nunca se devuelve una medición
 * que no vino del equipo.
 */
async function dondeSueleEstar(oltId, sn) {
  if (!sn) return null

  const { data: esperando } = await db()
    .from('onts_esperando')
    .select('slot, puerto')
    .eq('olt_id', oltId)
    .eq('sn', sn)
    .maybeSingle()
  if (esperando?.slot != null) return esperando

  const { data: onu } = await db()
    .from('onus')
    .select('slot, puerto')
    .eq('olt_id', oltId)
    .eq('sn', sn)
    .maybeSingle()
  return onu?.slot != null ? onu : null
}

/**
 * Con qué datos se puede dar de alta esta ONT, para ofrecerlos en el momento.
 *
 * Casi todo ya se sabe: el nombre y la dirección salen de la orden de trabajo,
 * el plan del contrato, los perfiles de la plantilla. Lo único que suele faltar
 * es la VLAN — y por eso las plantillas la traen.
 */
async function paraAutorizar(equipo, inst, ubicacion = {}) {
  const [presets, perfiles] = await Promise.all([
    preaut.listarPresets(equipo.id).catch(() => []),
    olt.listarPerfilesOnt(equipo).catch(() => null),
  ])

  const { data: plan } = inst.plan_id
    ? await db().from('planes_velocidad').select('nombre').eq('id', inst.plan_id).maybeSingle()
    : { data: null }

  /**
   * La VLAN que le toca a ESTE puerto PON.
   *
   * ── Por qué la pantalla no puede quedarse con la de la plantilla ──
   *
   * Las plantillas son globales: "Residencial FTTH · VLAN 200" sirve para el
   * parque entero. Pero cuando el ISP reparte una VLAN por puerto PON —que es
   * lo que permite darle su propio pool a cada uno— la plantilla acierta en un
   * puerto y falla en los otros quince.
   *
   * Autorizar la ONT del puerto 9 en la VLAN 200 la deja navegando por la VLAN
   * equivocada, tomando IP de un pool que no le corresponde. Y no se nota:
   * el abonado tiene internet. Se descubre cuando alguien busca por qué el
   * puerto 9 tiene una dirección del bloque del puerto 0.
   *
   * Por eso viaja el dato: la pantalla propone esta y avisa si la plantilla
   * elegida dice otra cosa.
   */
  /**
   * Qué perfil de servicio le va a tocar, ANTES de apretar el botón.
   *
   * En esta OLT los perfiles se llaman como los modelos —GN256VH, HG8145X6-13—
   * y el sistema elige por ahí. Mostrarlo antes evita la pregunta de si agarró
   * el correcto, y avisa cuando el modelo no está registrado: ahí va a entrar
   * el genérico de la plantilla, que da internet pero puede dejar algún puerto
   * sin habilitar.
   */
  let perfilServicio = null
  if (ubicacion.modelo) {
    const p = (perfiles?.srv ?? []).find(
      (x) => x.nombre.toUpperCase() === String(ubicacion.modelo).toUpperCase(),
    )
    perfilServicio = p
      ? { modelo: ubicacion.modelo, nombre: p.nombre, id: p.id, por_modelo: true }
      : { modelo: ubicacion.modelo, nombre: null, id: null, por_modelo: false }
  }

  let puerto = null
  if (ubicacion.puerto != null) {
    const seg = await vlans
      .segmentoDePuerto(equipo.id, { slot: ubicacion.slot ?? 0, puerto: ubicacion.puerto })
      .catch(() => null)

    if (seg?.encontrado) {
      puerto = {
        slot: ubicacion.slot ?? 0,
        puerto: ubicacion.puerto,
        vlan: seg.vlan ?? null,
        subred: seg.subred ?? null,
        cidr: seg.cidr ?? null,
      }
    }
  }

  return {
    presets,
    perfiles,
    ...(puerto ? { puerto_pon: puerto } : {}),
    ...(perfilServicio ? { perfil_servicio: perfilServicio } : {}),
    // Lo que ya sabe el sistema y el técnico no tendría que volver a escribir.
    sabido: {
      nombre: inst.nombre,
      direccion: inst.direccion,
      plan_id: inst.plan_id ?? null,
      plan: plan?.nombre ?? null,
    },
  }
}

/**
 * Autoriza la ONT desde el campo.
 *
 * Es lo que le faltaba al técnico: encontró la ONT, está conectada, y lo único
 * pendiente es darla de alta. Mandarlo a otra pantalla para volver acá es el
 * tipo de vuelta que termina en un alta a medias.
 *
 * Escribe en la OLT de producción. El nombre, la dirección y el plan salen de
 * la ORDEN DE TRABAJO y no del celular, por el mismo motivo de siempre: un dato
 * mal copiado configuraría el servicio de otra persona.
 */
router.post(
  '/:id/autorizar',
  asyncHandler(async (req, res) => {
    const inst = await cargarInstalacion(req.params.id)
    if (inst.tecnologia !== 'ftth') {
      throw badRequest('Solo las instalaciones de fibra se autorizan en la OLT')
    }
    if (!inst.equipo_sn) throw badRequest('Falta la serie de la ONT')

    /**
     * ¿Esto cierra una mudanza?
     *
     * Si el abonado se llevó el MISMO aparato, la ONT vieja tiene que salir
     * ANTES de buscar acá. Si no, pasa una de dos: en la misma OLT la búsqueda
     * la encuentra en el puerto viejo y esto contesta "esa ONT ya está
     * autorizada"; en otra OLT el alta sale pero deja dos filas con la misma
     * serie en dos equipos, que es un estado que el sistema ya sabe detectar
     * como roto pero nadie sabe arreglar tres meses después.
     *
     * Borrar primero es seguro exactamente acá y no en un cambio de equipo: el
     * abonado ya se mudó —su ONT está enchufada en la casa nueva— así que la
     * del domicilio viejo no le está dando servicio a nadie.
     */
    const traslado = await traslados.pendienteDe(inst)
    let bajaOrigen = null
    if (traslado && traslados.mismoEquipo(traslado, inst.equipo_sn)) {
      bajaOrigen = await traslados.bajarOrigen(traslado, { motivo: 'se llevó el mismo equipo' })
      if (!bajaOrigen.ont_borrada && bajaOrigen.intentado) {
        throw new AppError('No se pudo dar de baja la ONT en el domicilio anterior', {
          status: 502,
          hint:
            'Es el mismo equipo, así que no se puede autorizar acá mientras siga viva allá. ' +
            'Hay que sacarla desde la pantalla de la OLT de origen y reintentar.',
          detalle: bajaOrigen.error,
          origen: {
            olt: traslado.olt_anterior_id,
            sn: traslado.sn_anterior,
            puerto: traslado.puerto_anterior,
            onu_index: traslado.onu_index_anterior,
          },
        })
      }
    }

    const { oltId, puerto } = await ubicacionOptica(inst, req.body ?? {})
    const equipo = await cargarOlt(oltId)

    // Se vuelve a buscar en vez de confiar en lo que dijo la pantalla: entre la
    // medición y este momento el técnico pudo haber movido el conector.
    const pista = await dondeSueleEstar(oltId, inst.equipo_sn)
    const hallazgo = await olt.buscarPorSn(equipo, {
      sn: inst.equipo_sn,
      slot: pista?.slot,
      puerto: puerto ?? pista?.puerto,
    })

    // "No la veo" y "no me contestaron" no son lo mismo, y hasta ahora salían
    // iguales. Mandar al técnico a revisar un conector que está perfecto porque
    // la OLT llegó a su máximo de sesiones SSH es media hora de trabajo tirada
    // arriba de una instalación que ya estaba bien.
    if (!hallazgo.encontrada && hallazgo.sinRespuesta) {
      throw new AppError('La OLT no contestó, así que no se pudo verificar la ONT', {
        status: 503,
        hint: 'No es el conector: el equipo no respondió. Esperá un minuto y volvé a intentar.',
        detalle: hallazgo.fallos?.join(' · '),
      })
    }

    if (!hallazgo.encontrada) {
      throw badRequest(`La OLT ya no ve la ONT ${inst.equipo_sn}`, {
        hint: 'Revisá el conector y volvé a medir antes de autorizar.',
      })
    }
    if (hallazgo.registrada) {
      throw badRequest('Esa ONT ya está autorizada', {
        hint: 'Volvé a medir: ahora sí se puede leer su potencia.',
      })
    }

    // De dónde sale cada dato, en orden: lo que eligió el técnico, la plantilla,
    // y la orden de trabajo.
    const cuerpo = req.body ?? {}
    let preset = null
    if (cuerpo.preset_id) {
      const { data } = await db()
        .from('autorizacion_presets')
        .select('*')
        .eq('id', cuerpo.preset_id)
        .maybeSingle()
      preset = data
    }

    const resuelto = preset
      ? await preaut.resolverPreset(equipo, preset)
      : { lineProfileId: null, srvProfileId: null, problemas: [] }
    if (resuelto.problemas.length) throw badRequest(resuelto.problemas.join('. '))

    // El perfil de SERVICIO depende del modelo de la ONT, no de la plantilla.
    //
    // En este equipo los perfiles están nombrados como los modelos —HG8145X6-13,
    // GN256VH, HG8310M— y hay veintidós. Una plantilla con uno fijo le pondría
    // el perfil de un Huawei a un GN256VH: la ONT queda online y con la mitad de
    // sus puertos sin configurar, que es de lo más difícil de diagnosticar
    // porque desde la OLT se ve todo bien.
    //
    // El modelo lo dice la propia ONT cuando aparece en la cola de auto-find.
    const modelo = hallazgo.onu?.equipmentId ?? hallazgo.onu?.modelo ?? null

    /**
     * El orden importa: a mano → por modelo → el genérico de la plantilla.
     *
     * Antes la plantilla iba ANTES que el modelo, en contra de lo que dice el
     * comentario de arriba. No se notaba porque la plantilla de este ISP no
     * declara perfil de servicio; el día que alguien le pusiera uno, todas las
     * ONTs pasarían a autorizarse con ese, sin importar el modelo.
     */
    let srvProfileId = cuerpo.srv_profile_id ?? null
    let srvPorModelo = null
    let origenSrv = srvProfileId != null ? 'elegido a mano' : null

    if (srvProfileId == null && modelo) {
      const perfiles = await olt.listarPerfilesOnt(equipo).catch(() => null)
      srvPorModelo = (perfiles?.srv ?? []).find(
        (p) => p.nombre.toUpperCase() === String(modelo).toUpperCase(),
      )
      if (srvPorModelo) {
        srvProfileId = srvPorModelo.id
        origenSrv = 'modelo'
      }
    }

    /**
     * El genérico: que el abonado tenga internet hoy y se corrija después.
     *
     * ── Por qué ya no se rechaza el alta ──
     *
     * Antes, un modelo sin perfil propio en la OLT tiraba error y el técnico se
     * quedaba con la escalera puesta esperando que alguien de oficina creara un
     * perfil. Con un modelo nuevo —y siempre entra uno nuevo— eso es una visita
     * perdida.
     *
     * Ahora se usa el perfil de la plantilla, que da servicio: la ONT queda
     * online y navegando. Lo que puede faltarle son los puertos que ese perfil
     * no habilita —una FXS de telefonía, un SSID— y por eso el aviso viaja en
     * la respuesta y el alta queda marcada: hay que registrar el modelo y
     * reprovisionar, pero con el abonado ya conectado.
     *
     * La diferencia con rechazar es cuándo se resuelve el problema, no si se
     * resuelve.
     */
    let avisoSrv = null
    if (srvProfileId == null && resuelto.srvProfileId != null) {
      srvProfileId = resuelto.srvProfileId
      origenSrv = 'genérico de la plantilla'
      avisoSrv = modelo
        ? `La OLT no tiene un perfil de servicio llamado "${modelo}". Se autorizó con el `
          + `genérico de la plantilla "${preset?.nombre}": la ONT navega, pero puede quedarle `
          + 'algún puerto sin habilitar. Creá el perfil con el nombre del modelo y reprovisioná.'
        : 'No se pudo leer el modelo de la ONT. Se autorizó con el perfil genérico de la plantilla.'
    }

    if (srvProfileId == null) {
      throw badRequest(
        modelo
          ? `La OLT no tiene un perfil de servicio para el modelo ${modelo}`
          : 'No se pudo determinar el perfil de servicio',
        {
          hint:
            'Cargá el perfil en la OLT con el nombre del modelo, o poné uno genérico en la '
            + 'plantilla para que sirva de respaldo. Sin ninguno de los dos no hay con qué '
            + 'configurar la ONT.',
          modelo,
        },
      )
    }

    const vlan = cuerpo.vlan ?? preset?.vlan ?? null
    if (vlan == null) {
      throw badRequest('Falta la VLAN', {
        hint: 'Elegí una plantilla que la traiga, o escribila. Sin VLAN la ONT queda registrada y sin pasar tráfico.',
      })
    }

    const alta = await registrando(
      req,
      {
        instalacion: inst,
        comando: 'autorizar_onu',
        parametros: { sn: inst.equipo_sn, puerto: hallazgo.puerto, vlan },
        destino: { tipo: 'olt', id: equipo.id, nombre: equipo.nombre },
      },
      () =>
        ficha.autorizarOnt(equipo, {
          sn: inst.equipo_sn,
          slot: hallazgo.slot ?? pista?.slot,
          puerto: hallazgo.puerto,
          lineProfileId: cuerpo.line_profile_id ?? resuelto.lineProfileId,
          srvProfileId,
          vlan,
          gemport: cuerpo.gemport ?? preset?.gemport ?? 1,
          nombre: inst.nombre,
          comentario: inst.direccion,
          plan_id: inst.plan_id ?? preset?.plan_id ?? null,
          instalacion_id: inst.id,
        }),
    )

    await guardar(inst.id, { olt_id: equipo.id, puerto_pon: String(hallazgo.puerto ?? '') || null }, 1)

    // Equipo distinto: la baja del origen va DESPUÉS del alta. Al revés, si la
    // autorización fallaba se habría borrado el registro del domicilio viejo
    // por una mudanza que todavía no terminó.
    if (traslado && !bajaOrigen) {
      bajaOrigen = await traslados.bajarOrigen(traslado, { motivo: 'equipo nuevo en el destino' })
    }

    res.json({
      ok: true,
      autorizada: true,
      sn: alta.sn,
      puerto: alta.puerto,
      ont_id: alta.ontId,
      service_port: alta.servicePort,
      modelo,
      // De dónde salió el perfil de servicio. Que se vea evita la duda de si
      // agarró el correcto para este modelo.
      srv_profile: srvPorModelo
        ? { id: srvPorModelo.id, nombre: srvPorModelo.nombre, por_modelo: true, origen: origenSrv }
        : { id: srvProfileId, por_modelo: false, origen: origenSrv },
      // Los dos avisos son distintos y pueden venir juntos: uno es del alta en
      // la OLT y el otro dice que se usó el perfil genérico.
      ...(alta.aviso || avisoSrv
        ? { aviso: [avisoSrv, alta.aviso].filter(Boolean).join(' ') }
        : {}),
      // Lo que pasó con el domicilio anterior. Va siempre que haya habido un
      // traslado: callar que quedó una ONT colgada es cómo se acumulan.
      ...(bajaOrigen
        ? {
            traslado: {
              ...bajaOrigen,
              sn_anterior: traslado.sn_anterior,
              aviso: traslados.avisoDeBaja({ ...bajaOrigen, sn: traslado.sn_anterior }),
            },
          }
        : {}),
      // La ONT tarda unos segundos en registrarse contra la OLT. Medir en el
      // mismo instante devolvería "sin potencia" y parecería que salió mal.
      siguiente: 'Esperá unos segundos y tocá "Volver a medir": ya va a dar potencia.',
    })
  }),
)

// --- Paso 2: potencia y señal -----------------------------------------------

/**
 * Le pregunta al equipo cómo llegó la señal.
 *
 * En fibra se le pregunta a la OLT, que es quien la mide. En radio, al router
 * que alimenta el sector, que es quien ve asociado al CPE. En los dos casos la
 * lectura queda guardada con su hora: es la línea de base contra la que se va a
 * comparar cualquier reclamo de acá a dos años.
 */
router.post(
  '/:id/lectura',
  asyncHandler(async (req, res) => {
    const inst = await cargarInstalacion(req.params.id)

    if (!inst.equipo_sn && !inst.equipo_mac) {
      throw badRequest('Falta leer el equipo: escaneá o escribí la serie o la MAC antes de medir')
    }

    // --- Fibra -------------------------------------------------------------
    if (inst.tecnologia === 'ftth') {
      if (!inst.equipo_sn) throw badRequest('Para consultar la OLT hace falta la serie de la ONT')

      // El técnico puede indicar la OLT acá mismo cuando la orden no la trae.
      const { oltId, puerto } = await ubicacionOptica(inst, req.body ?? {})
      const equipo = await cargarOlt(oltId)

      // Dónde mirar primero. Sin esto hay que barrer cada puerto de cada placa
      // —treinta y dos consultas en este equipo, varios minutos— mientras el
      // técnico espera arriba de una escalera.
      //
      // La pista sale de lo que ya sabemos de esa serie, pero la MEDICIÓN se le
      // sigue pidiendo al equipo: acá solo se decide por dónde empezar a buscar.
      const pista = await dondeSueleEstar(oltId, inst.equipo_sn)

      const hallazgo = await registrando(
        req,
        {
          instalacion: inst,
          comando: 'buscar_onu',
          parametros: { sn: inst.equipo_sn, puerto: puerto ?? null },
          destino: { tipo: 'olt', id: equipo.id, nombre: equipo.nombre },
        },
        () =>
          olt.buscarPorSn(equipo, {
            sn: inst.equipo_sn,
            slot: pista?.slot,
            puerto: puerto ?? pista?.puerto,
          }),
      )

      // Cuando el equipo no contestó, el semáforo NO es rojo: es gris. Rojo
      // significa "medí y está mal"; acá no se midió nada. Pintarlo rojo manda
      // al técnico a revisar conectores por un problema que está en la oficina.
      if (!hallazgo.encontrada && hallazgo.sinRespuesta) {
        return res.status(503).json({
          tecnologia: 'ftth',
          encontrada: false,
          semaforo: 'gris',
          sin_respuesta: true,
          mensaje: `La OLT ${equipo.nombre} no contestó, así que no se pudo medir.`,
          hint: 'No es el conector: el equipo no respondió. Esperá un minuto y volvé a medir.',
          detalle: hallazgo.fallos?.join(' · '),
        })
      }

      if (!hallazgo.encontrada) {
        return res.status(409).json({
          tecnologia: 'ftth',
          encontrada: false,
          semaforo: 'rojo',
          mensaje: `La OLT ${equipo.nombre} no ve la ONT ${inst.equipo_sn}.`,
          hint: 'Revisá el conector en la NAP y en la roseta, y que la serie escaneada sea la de la ONT y no la de la caja.',
        })
      }

      if (!hallazgo.registrada) {
        // La ONT llegó pero todavía no está dada de alta: la OLT la ve en la
        // cola de auto-find. No hay potencia que leer hasta que se registre.
        //
        // Esto NO es un error: es el estado normal de una instalación nueva en
        // el momento exacto en que el técnico mide. El mensaje anterior lo
        // mandaba a "ONUs → Sin configurar", que es una pantalla de escritorio,
        // y él está arriba de una escalera con el celular. Ahora se le ofrece
        // autorizarla desde acá, que es lo único que falta para terminar.
        await guardar(
          inst.id,
          { olt_id: equipo.id, puerto_pon: String(hallazgo.puerto ?? puerto ?? '') || null },
          1,
        )

        return res.status(409).json({
          tecnologia: 'ftth',
          encontrada: true,
          registrada: false,
          puerto: hallazgo.puerto,
          semaforo: 'ambar',
          mensaje: `La ONT está conectada en el puerto PON ${hallazgo.puerto} y todavía no está autorizada.`,
          hint: 'La fibra llegó bien. Falta darla de alta en la OLT, y se hace acá abajo.',
          // Lo que la pantalla necesita para ofrecer el alta sin otra vuelta al
          // servidor: el técnico está en la calle y cada consulta es tiempo.
          puede_autorizar: true,
          ...(await paraAutorizar(equipo, inst, {
            slot: hallazgo.slot ?? 0,
            puerto: hallazgo.puerto,
            modelo: hallazgo.onu?.equipmentId ?? hallazgo.onu?.modelo ?? null,
          })),
        })
      }

      const metricas = await registrando(
        req,
        {
          instalacion: inst,
          comando: 'senal_optica',
          parametros: { sn: inst.equipo_sn, puerto: hallazgo.puerto, onuId: hallazgo.onuId },
          destino: { tipo: 'olt', id: equipo.id, nombre: equipo.nombre },
        },
        () =>
          olt.leerMetricas(equipo, {
            frame: hallazgo.frame ?? 0,
            slot: hallazgo.slot ?? 0,
            puerto: hallazgo.puerto,
            onuId: hallazgo.onuId,
          }),
      )

      const rx = metricas?.rxPowerDbm ?? null
      const semaforo = semaforoOptico(rx)

      // Si la ONU ya está en el catálogo, se enlaza: así la ficha del abonado y
      // el listado de ONUs hablan del mismo equipo y no de dos parecidos.
      const { data: onu } = await db()
        .from('onus')
        .select('id')
        .eq('olt_id', equipo.id)
        .eq('sn', String(inst.equipo_sn).toUpperCase())
        .maybeSingle()

      const guardada = await guardar(
        inst.id,
        {
          olt_id: equipo.id,
          puerto_pon: String(hallazgo.puerto ?? ''),
          onu_id: onu?.id ?? inst.onu_id ?? null,
          rx_power_dbm: rx,
          tx_power_dbm: metricas?.txPowerDbm ?? null,
          lectura_at: new Date().toISOString(),
        },
        2,
      )

      return res.json({
        tecnologia: 'ftth',
        encontrada: true,
        registrada: true,
        puerto: hallazgo.puerto,
        onuId: hallazgo.onuId,
        estado: hallazgo.estado,
        rx_power_dbm: rx,
        tx_power_dbm: metricas?.txPowerDbm ?? null,
        temperatura_c: metricas?.temperaturaC ?? null,
        semaforo,
        umbrales: OPTICA,
        mensaje:
          semaforo === 'verde'
            ? `Potencia óptima: ${rx} dBm.`
            : semaforo === 'ambar'
              ? `Potencia justa: ${rx} dBm. Revisá empalmes y conectores antes de cerrar.`
              : `Potencia fuera de rango: ${rx} dBm. Con este valor el servicio se va a caer.`,
        instalacion: guardada,
      })
    }

    // --- Radio -------------------------------------------------------------
    if (!inst.equipo_mac) {
      throw badRequest('Para consultar la radio hace falta la MAC del CPE')
    }
    if (!inst.router_id) {
      throw badRequest('La instalación no tiene router asignado', {
        hint: 'Elegí desde qué MikroTik se alimenta el sector antes de medir la señal.',
      })
    }

    const equipo = await cargarRouter(inst.router_id)
    const registro = await registrando(
      req,
      {
        instalacion: inst,
        comando: 'senal_radio',
        parametros: { mac: inst.equipo_mac },
        destino: { tipo: 'mikrotik', id: equipo.id, nombre: equipo.nombre },
      },
      () => mk.listarRegistroWireless(equipo),
    )

    const mac = String(inst.equipo_mac).toUpperCase()
    const entrada = (registro ?? []).find(
      (r) => String(r['mac-address'] ?? '').toUpperCase() === mac,
    )

    if (!entrada) {
      return res.status(409).json({
        tecnologia: 'wireless',
        encontrada: false,
        semaforo: 'rojo',
        asociados: (registro ?? []).length,
        mensaje: `El CPE ${mac} no figura asociado en ${equipo.nombre}.`,
        hint: 'Verificá que la antena esté apuntada, que el SSID y la clave sean los del sector, y que la MAC sea la del radio y no la del puerto LAN.',
      })
    }

    // RouterOS escribe la señal como "-64@6Mbps" y el CCQ como porcentaje. Se
    // queda con el número de adelante: el resto es la tasa negociada.
    const aNumero = (v) => {
      const m = String(v ?? '').match(/-?\d+(\.\d+)?/)
      return m ? Number(m[0]) : null
    }
    const senal = aNumero(entrada['signal-strength'] ?? entrada.signal ?? entrada['signal-strength-ch0'])
    const ccq = aNumero(entrada['tx-ccq'] ?? entrada['rx-ccq'])
    const semaforo = semaforoRadio(senal, ccq)

    const guardada = await guardar(
      inst.id,
      { senal_dbm: senal, ccq, lectura_at: new Date().toISOString() },
      2,
    )

    return res.json({
      tecnologia: 'wireless',
      encontrada: true,
      senal_dbm: senal,
      ccq,
      interfaz: entrada.interface ?? null,
      tasa_tx: entrada['tx-rate'] ?? null,
      tasa_rx: entrada['rx-rate'] ?? null,
      distancia: entrada.distance ?? null,
      semaforo,
      umbrales: RADIO,
      mensaje:
        semaforo === 'verde'
          ? `Señal óptima: ${senal} dBm${ccq != null ? ` con ${ccq}% de CCQ` : ''}.`
          : semaforo === 'ambar'
            ? `Señal justa: ${senal} dBm${ccq != null ? ` y ${ccq}% de CCQ` : ''}. Mejorá la alineación antes de cerrar.`
            : `Señal fuera de rango: ${senal} dBm. Con este valor el enlace se va a cortar.`,
      instalacion: guardada,
    })
  }),
)

// --- Paso 3: parámetros de red ----------------------------------------------

/**
 * Qué segmento de red le corresponde a esta instalación, sin preguntarle nada.
 *
 * Sale de dónde apareció la ONT: la OLT dice en qué puerto PON está, el puerto
 * tiene su VLAN predeterminada, y esa VLAN es la de una subred. El técnico está
 * arriba de una escalera y no tiene por qué saber qué segmento le toca a la
 * cuadra donde está parado.
 *
 * Cuando la cadena se corta, se dice DÓNDE se cortó. Un campo vacío no
 * distingue "no hay segmento" de "nadie configuró la VLAN de ese puerto", y esa
 * diferencia es la que decide si el técnico sigue a mano o llama a la oficina.
 */
router.get(
  '/:id/segmento-sugerido',
  asyncHandler(async (req, res) => {
    const inst = await cargarInstalacion(req.params.id)

    /**
     * En radioenlace el segmento no sale de ninguna OLT.
     *
     * ── Por qué esto necesitaba su propia rama ──
     *
     * Toda la deducción de abajo es de fibra: la ONT aparece en la OLT, la OLT
     * dice en qué puerto PON está, el puerto tiene su VLAN, y esa VLAN es la de
     * una subred. En radio no hay ninguno de esos eslabones.
     *
     * Antes caía igual en el `if` de arriba y el técnico leía "la orden todavía
     * no tiene OLT · se completa sola al consultar la señal". Eso lo mandaba a
     * esperar un paso que en radio NUNCA va a ocurrir, y a dudar de si había
     * hecho algo mal.
     *
     * Lo que sí sabemos en radio es de qué router cuelga, y las subredes tienen
     * su router cargado. No alcanza para elegir una sola —de un mismo nodo
     * salen varias— pero sí para ofrecer las que corresponden en vez de la
     * lista entera.
     */
    if (inst.tecnologia === 'wireless') {
      if (!inst.router_id) {
        return res.json({
          encontrado: false,
          motivo: 'Instalación por radioenlace: el segmento no se deduce de la OLT',
          hint: 'Elegí primero el MikroTik del nodo y las redes de ese equipo aparecen abajo.',
        })
      }

      // Las del nodo, del tipo que corresponde a cómo se le entrega la conexión.
      const tipos =
        inst.tipo_conexion === 'pppoe' || inst.tipo_conexion === 'hotspot'
          ? ['pool_pppoe']
          : ['estatica', 'cgnat']

      const { data: candidatas } = await db()
        .from('v_subredes')
        .select('id, nombre, cidr, tipo, gateway, vlan, pool_router, asignadas, utilizables')
        .eq('router_id', inst.router_id)
        .in('tipo', tipos)
        .order('numero')

      const lista = candidatas ?? []

      // Con una sola no hay nada que elegir: se propone.
      /**
       * La forma tiene que ser la MISMA que devuelve la deducción de fibra.
       *
       * La pantalla lee `subred_id`, `subred`, `pool_router` y `router_id` para
       * armar el botón "usar este segmento" y para pedir después una IP libre.
       * Devolver `id` y `nombre` —que es lo natural de la tabla— deja la
       * pantalla mostrando el segmento y sin poder usarlo: el botón no aparece
       * y el campo de dirección queda vacío, sin ningún error a la vista.
       */
      const comoLaEsperaLaPantalla = (u) => ({
        subred_id: u.id,
        subred: u.nombre,
        cidr: u.cidr,
        tipo: u.tipo,
        gateway: u.gateway,
        vlan: u.vlan,
        pool_router: u.pool_router ?? null,
        router_id: inst.router_id,
        asignadas: u.asignadas,
        utilizables: u.utilizables,
      })

      if (lista.length === 1) {
        return res.json({
          encontrado: true,
          por: 'router',
          ...comoLaEsperaLaPantalla(lista[0]),
          origen: { motivo: 'Única red de este nodo para esta forma de conexión' },
        })
      }

      return res.json({
        encontrado: false,
        por: 'router',
        motivo: lista.length
          ? `Este nodo tiene ${lista.length} redes para ${inst.tipo_conexion === 'pppoe' ? 'PPPoE' : 'IP directa'}`
          : 'Este nodo no tiene redes cargadas para esta forma de conexión',
        hint: lista.length
          ? 'En radio no se puede saber cuál le toca sin conocer el sector: elegila abajo.'
          : 'Cargalas en Red → Redes IPv4, con este router asignado.',
        candidatas: lista.map(comoLaEsperaLaPantalla),
      })
    }

    if (!inst.olt_id) {
      return res.json({
        encontrado: false,
        motivo: 'La orden todavía no tiene OLT',
        hint: 'Se completa sola al consultar la señal. Si es radioenlace, marcá la tecnología en la orden.',
      })
    }

    // El puerto sale de la orden si ya se midió; si no, de dónde vimos la ONT.
    let puerto = inst.puerto_pon == null ? null : Number(String(inst.puerto_pon).match(/(\d+)\s*$/)?.[1])
    let slot = null

    const pista = await dondeSueleEstar(inst.olt_id, inst.equipo_sn)
    if (pista) {
      slot = pista.slot
      puerto = puerto ?? pista.puerto
    }

    // El segmento sale de DÓNDE está colgada la ONT: su VLAN real si ya está
    // dada de alta, o la VLAN del puerto PON si todavía no. El plan del abonado
    // no interviene —decide la velocidad, no la dirección— porque en la misma
    // VLAN conviven un abonado de 150 megas y uno de 500.
    res.json({
      ...(await vlans.segmentoSugerido({
        oltId: inst.olt_id,
        slot,
        puerto,
        // La serie es la que permite recuperar lo que la ONU ya sabe: en qué
        // puerto quedó y con qué VLAN.
        sn: inst.equipo_sn,
      })),
      slot,
      puerto,
    })
  }),
)

/**
 * Todos los segmentos entre los que el técnico puede elegir.
 *
 * ── Por qué hace falta además del sugerido ──
 *
 * `segmento-sugerido` sirve cuando el sistema puede deducirlo: en fibra, de la
 * OLT; en radio, cuando el nodo tiene una sola red. Pero un ISP con diez torres
 * tiene diez sectores y varias redes por router, y ahí no hay nada que deducir
 * —el sistema no sabe frente a qué torre está parada la antena del cliente—.
 *
 * Lo que sí puede hacer es ofrecerle la lista con el nombre del sector, que es
 * como el técnico piensa: "este cliente ve la torre de La Maná". Sin eso hay
 * que escribir el bloque a mano desde una escalera, que es como se termina
 * cargando una IP de otro sector y el cliente no navega.
 *
 * ── Por qué se ordenan por torre y no por número ──
 *
 * Porque lo que el técnico busca es el sector, no la red. El nombre del punto
 * de red va primero por la misma razón.
 */
router.get(
  '/:id/segmentos',
  asyncHandler(async (req, res) => {
    const inst = await cargarInstalacion(req.params.id)

    // Un pool de PPPoE no sirve para un abonado de IP directa: la dirección la
    // reparte el servidor al autenticarse y la que se cargue a mano se ignora.
    const tipos =
      inst.tipo_conexion === 'pppoe' || inst.tipo_conexion === 'hotspot'
        ? ['pool_pppoe']
        : ['estatica', 'cgnat']

    const { data, error } = await db()
      .from('v_subredes')
      .select(
        'id, numero, nombre, cidr, tipo, gateway, vlan, punto, punto_id, router_id, router, ' +
          'pool_router, asignadas, utilizables, ocupacion_pct',
      )
      .in('tipo', tipos)
      .eq('activo', true)
      .order('numero')

    if (error) throw new AppError(`No se pudieron leer los segmentos: ${error.message}`, { status: 502 })

    const lista = (data ?? []).map((r) => ({
      subred_id: r.id,
      subred: r.nombre,
      cidr: r.cidr,
      tipo: r.tipo,
      gateway: r.gateway,
      vlan: r.vlan,
      torre: r.punto ?? null,
      router: r.router ?? null,
      router_id: r.router_id,
      pool_router: r.pool_router ?? null,
      asignadas: r.asignadas ?? 0,
      utilizables: r.utilizables ?? 0,
      ocupacion_pct: r.ocupacion_pct ?? 0,
      // Para poder mostrar primero las del equipo de esta orden sin esconder el
      // resto: el técnico puede estar frente a una torre de otro router.
      deEsteRouter: Boolean(inst.router_id) && r.router_id === inst.router_id,
    }))

    // Las del router de la orden primero, y dentro de cada grupo por torre: es
    // el orden en que el técnico las busca.
    lista.sort(
      (a, b) =>
        Number(b.deEsteRouter) - Number(a.deEsteRouter) ||
        String(a.torre ?? 'zzz').localeCompare(String(b.torre ?? 'zzz')) ||
        String(a.subred).localeCompare(String(b.subred)),
    )

    res.json({
      segmentos: lista,
      // Se dice para qué se filtró: una lista corta sin explicación parece un
      // error de carga.
      para: inst.tipo_conexion === 'pppoe' ? 'PPPoE' : 'IP directa',
      sinTorre: lista.filter((x) => !x.torre).length,
    })
  }),
)

/**
 * La siguiente dirección libre del segmento.
 *
 * Se cruzan cuatro fuentes de ocupación porque ninguna sola alcanza: la base
 * sabe de los abonados cargados, el router de los que se configuraron a mano, y
 * las instalaciones en curso de las que se van a ocupar hoy. Preguntarle solo a
 * una es cómo se terminan asignando dos veces la misma IP.
 */
router.get(
  '/:id/ip-libre',
  asyncHandler(async (req, res) => {
    const inst = await cargarInstalacion(req.params.id)

    const routerId = req.query.router_id || inst.router_id
    if (!routerId) {
      throw badRequest('Falta el router del que sale el segmento', {
        hint: 'Elegí el MikroTik del nodo en el paso de parámetros de red.',
      })
    }

    const equipo = await cargarRouter(routerId)
    const nombrePool = req.query.pool || inst.pool
    let rangos
    let origen

    if (req.query.red) {
      rangos = rangosDeTexto(req.query.red)
      origen = { tipo: 'red', valor: req.query.red }
    } else if (nombrePool) {
      const pools = await mk.listarPools(equipo)
      const pool = (Array.isArray(pools) ? pools : []).find((p) => p.name === nombrePool)
      if (!pool) {
        throw badRequest(`El router ${equipo.nombre} no tiene un pool llamado "${nombrePool}"`, {
          hint: `Pools disponibles: ${(pools ?? []).map((p) => p.name).join(', ') || 'ninguno'}`,
        })
      }
      rangos = rangosDeTexto(pool.ranges)
      origen = { tipo: 'pool', valor: pool.name, rangos: pool.ranges }
    } else {
      const pools = await mk.listarPools(equipo).catch(() => [])
      throw badRequest('Indicá de qué pool o de qué red sacar la dirección', {
        hint: `Pools en ${equipo.nombre}: ${(pools ?? []).map((p) => p.name).join(', ') || 'ninguno'}`,
      })
    }

    const [{ data: clientes }, { data: reservadas }, { data: gateways }, { data: registradas }] =
      await Promise.all([
      db().from('clientes').select('ip').not('ip', 'is', null),
      db()
        .from('instalaciones')
        .select('ip')
        .not('ip', 'is', null)
        .neq('estado', 'cancelada')
        .neq('id', inst.id),
      // Los gateways declarados. El del router ya viene en `direcciones`, pero
      // solo si alguien lo configuró: un bloque recién creado todavía no lo
      // tiene puesto, y sin esto la primera dirección que se entrega es
      // justamente la del router. El abonado navega y rompe el segmento entero
      // el día que alguien levanta la interfaz.
      db().from('subredes').select('gateway').not('gateway', 'is', null),

      /**
       * Lo que el sistema ya tiene registrado de los equipos.
       *
       * ── Por qué no alcanzaba con preguntarle al router ──
       *
       * Abajo se le pregunta en vivo, y mientras conteste eso es lo más
       * fresco que hay. Pero cuando NO contesta —y contra un equipo remoto
       * pasa— el sistema quedaba sin ninguna fuente: entregaba direcciones
       * como si el segmento estuviera vacío, que es justo el momento en que
       * más fácil se asigna una que ya tiene otro.
       *
       * `ip_addresses` es lo último que se supo. Vieja o no, una dirección
       * anotada como asignada no se vuelve a entregar hasta que alguien la
       * libere.
       *
       * Además es lo que ya cuenta la pantalla al mostrar "254 libres": sin
       * esto, el desplegable decía una cosa y el botón hacía otra.
       */
      db().from('ip_addresses').select('ip_address').not('ip_address', 'is', null),
    ])

    // Las tres del router, UNA POR UNA.
    //
    // La API binaria de RouterOS es con estado: una sola conexión atiende un
    // comando a la vez. Pedidas en paralelo, si una tarda más que el tiempo
    // límite su respuesta llega cuando el canal ya se cerró, y el equipo
    // contesta "Tried to process unknown reply" — que no lo agarra el `catch`
    // de la promesa porque llega por otro lado. La petición entera se caía sin
    // devolver nada, con el técnico esperando.
    const sinConsultar = []

    /**
     * Si el equipo no contestó la primera, no se le piden las otras dos.
     *
     * ── Por qué ──
     *
     * Cada consulta espera hasta diez segundos. Con el router caído eran TREINTA
     * SEGUNDOS de espera para llegar a la misma conclusión: el técnico apretaba
     * "tomar la siguiente IP" y se quedaba media pantalla congelada mirando una
     * escalera.
     *
     * Un equipo que no respondió una consulta no va a responder las siguientes:
     * lo que falló es la conexión, no el comando. Insistir dos veces más no
     * agrega ninguna información.
     *
     * Solo se corta cuando el fallo es de CONEXIÓN. Si una consulta falla por
     * otra cosa —un permiso, un comando que esa versión no tiene— las demás
     * pueden andar perfectamente y vale la pena pedirlas.
     */
    let equipoCaido = false
    const esCaida = (err) =>
      /no hay respuesta|timed out|timeout|ECONN|EHOSTUNREACH|ETIMEDOUT|socket/i.test(
        String(err?.message ?? ''),
      )

    const sinConsultarPorCaida = (nombre) => {
      sinConsultar.push(`${nombre} (no se pidió: el equipo no responde)`)
      return []
    }

    const delRouter = async (nombre, fn) => {
      if (equipoCaido) return sinConsultarPorCaida(nombre)
      try {
        return await fn()
      } catch (err) {
        // Perder una fuente no invalida el resto: con las otras se sigue
        // pudiendo elegir una dirección, y se dice cuál faltó.
        sinConsultar.push(`${nombre} (${err.message})`)
        if (esCaida(err)) equipoCaido = true
        return []
      }
    }
    const direcciones = await delRouter('direcciones del router', () => mk.listarDirecciones(equipo))
    const leases = await delRouter('leases de DHCP', () => mk.listarDhcpLeases(equipo))
    const secrets = await delRouter('secrets de PPPoE', () => mk.listarPppSecrets(equipo))

    const ocupadas = [
      ...(clientes ?? []).map((c) => c.ip),
      ...(reservadas ?? []).map((i) => i.ip),
      ...(gateways ?? []).map((s) => s.gateway),
      ...(registradas ?? []).map((d) => d.ip_address),
      ...(direcciones ?? []).map((d) => d.address),
      ...(leases ?? []).map((l) => l.address),
      ...(secrets ?? []).map((s) => s['remote-address']),
    ]

    const libre = primeraLibre(rangos, ocupadas)
    const total = totalDeRangos(rangos)

    /**
     * Cuántas de las ocupadas caen DENTRO del bloque que se pidió.
     *
     * ── Por qué no vale contar la lista entera ──
     *
     * `ocupadas` junta todo lo que el sistema conoce, de cualquier red: los
     * abonados de las doce subredes, los gateways de todas, y lo registrado en
     * `ip_addresses`. Contarla entera daba números como "255 ocupadas de 254"
     * —más ocupadas que direcciones útiles— y el técnico leía que el sector
     * está lleno justo cuando el sistema le acababa de dar una dirección.
     *
     * Las de otros bloques no molestan para elegir: el recorrido pasa solo por
     * el rango pedido y nunca se cruza con ellas. Molestan para CONTAR.
     *
     * Cuesta una pasada sobre la lista, no dos sobre los rangos.
     */
    const dentroDelRango = (ip) => {
      const n = aEntero(String(ip ?? '').split('/')[0])
      return n != null && rangos.some((r) => n >= r.desde && n <= r.hasta)
    }
    const ocupadasAca = new Set(ocupadas.filter(dentroDelRango).map((ip) => String(ip).split('/')[0]))

    if (!libre) {
      throw new AppError(`No queda ninguna dirección libre en ${origen.valor}`, {
        status: 409,
        hint: 'Ampliá el pool o liberá las direcciones de los abonados dados de baja.',
      })
    }

    res.json({
      ip: libre.ip,
      origen,
      total,
      // Solo las de ESTE bloque, y sin repetidas: la misma dirección puede venir
      // del abonado, del lease y del secret, y contarla tres veces infla el
      // número igual que contar las de otros segmentos.
      ocupadas: ocupadasAca.size,
      router: equipo.nombre,
      // Si alguna fuente no contestó, la dirección propuesta puede estar en uso
      // sin que lo sepamos. Callarlo sería prometer que está libre.
      ...(sinConsultar.length
        ? {
            aviso:
              `No se pudo consultar ${sinConsultar.join(' ni ')}. ` +
              'La dirección puede estar en uso: verificá antes de asignarla.',
          }
        : {}),
    })
  }),
)

/**
 * Deja al abonado configurado en el router.
 *
 * PPPoE crea o corrige el secret; IP fija fija la reserva por DHCP contra la
 * MAC del equipo. Las dos operaciones son idempotentes porque este paso se
 * reintenta: el técnico está en la calle y la conexión se corta.
 */
router.post(
  '/:id/aprovisionar',
  asyncHandler(async (req, res) => {
    const inst = await cargarInstalacion(req.params.id)
    const {
      tipo_conexion = inst.tipo_conexion,
      tipo_ip = inst.tipo_ip,
      usuario_ppp,
      clave_ppp,
      ip,
      ipv6,
      pool,
      router_id,
      aplicar = true,
    } = req.body ?? {}

    const routerId = router_id || inst.router_id
    if (!routerId) throw badRequest('Falta el router del nodo')

    const equipo = await cargarRouter(routerId)
    const titular = inst.nombre ?? 'Abonado'

    const cambios = {
      router_id: routerId,
      tipo_conexion,
      tipo_ip,
      usuario_ppp: usuario_ppp ?? inst.usuario_ppp,
      clave_ppp: clave_ppp ?? inst.clave_ppp,
      ip: ip ?? inst.ip,
      ipv6: ipv6 ?? inst.ipv6,
      pool: pool ?? inst.pool,
    }

    let resultado = { aplicado: false }

    if (aplicar && tipo_conexion === 'pppoe') {
      if (!cambios.usuario_ppp || !cambios.clave_ppp) {
        throw badRequest('Faltan el usuario y la clave PPPoE')
      }

      /**
       * Con qué perfil PPP se crea el secret. Muchas veces: con ninguno.
       *
       * ── Quién limita la velocidad ──
       *
       * Lo decide el plan, en `control_pppoe`:
       *
       *   · `'olt'`   — la OLT, con sus traffic tables. Es lo normal en fibra.
       *                 El MikroTik no tiene que limitar nada: el secret va con
       *                 el perfil por defecto y solo reparte la IP, que es lo
       *                 que hace falta para dar servicio y para cortar.
       *   · `'mikrotik'` — el perfil PPP lleva el rate-limit. Se usa donde no
       *                 hay OLT en el camino.
       *
       * ── El error que tenía esto ──
       *
       * Buscaba el perfil SIEMPRE, sin mirar `control_pppoe`, y cuando el plan
       * no declaraba uno caía al NOMBRE del plan. Con todos los planes en
       * `'olt'` —que es como vienen— el alta salía pidiendo un perfil llamado
       * "PLAN_HOME" que ningún router tiene, y el técnico recibía un aviso de
       * algo que estaba bien: el secret NO debía tener perfil.
       *
       * Peor si alguien creaba ese perfil para callar el aviso: quedarían dos
       * límites sobre el mismo abonado, el de la OLT y el del router, y manda
       * el menor de los dos. El plan de 150 megas entregaría lo que diga el
       * perfil, sin que nadie entienda por qué.
       *
       * Se piden todas las columnas y no `nombre, perfil_ppp`: nombrar una
       * columna que todavía no existe hace fallar la consulta entera, y contra
       * una base sin la migración 32 eso dejaría el alta sin perfil en vez de
       * caer al comportamiento anterior.
       */
      let perfil = null
      let controlDe = null
      if (inst.plan_id) {
        const { data: plan } = await db()
          .from('planes_velocidad')
          .select('*')
          .eq('id', inst.plan_id)
          .maybeSingle()

        // Sin la columna cargada se asume la OLT, que es el valor por defecto
        // del formulario de planes y el caso de casi todo el parque de fibra.
        controlDe = plan?.control_pppoe ?? 'olt'

        /**
         * Solo cuando el router es el que limita.
         *
         * Y ahí sí se exige que el plan diga con qué perfil: caer al nombre del
         * plan casi nunca acierta —los planes se llaman como se venden y los
         * perfiles como los nombró quien configuró el equipo— y el aviso que
         * genera manda a buscar un problema que no existe.
         */
        if (controlDe === 'mikrotik') perfil = plan?.perfil_ppp ?? plan?.nombre ?? null
      }

      const aplicarSecret = (conPerfil) =>
        mk.asegurarPppSecret(equipo, {
          usuario: cambios.usuario_ppp,
          clave: cambios.clave_ppp,
          perfil: conPerfil,
          ip: tipo_ip === 'fija' ? cambios.ip : null,
          comentario: `${titular} · alta ${inst.fecha}`,
        })

      resultado = await registrando(
        req,
        {
          instalacion: inst,
          comando: 'alta_pppoe',
          // `controlDe` queda en la auditoría: el día que alguien pregunte por
          // qué este secret no tiene perfil, la respuesta está en el registro.
          parametros: { usuario: cambios.usuario_ppp, perfil, velocidad_la_controla: controlDe },
          destino: { tipo: 'mikrotik', id: equipo.id, nombre: equipo.nombre },
        },
        async () => {
          try {
            return { aplicado: true, ...(await aplicarSecret(perfil)), perfil }
          } catch (err) {
            if (!perfil) throw err
            return {
              aplicado: true,
              ...(await aplicarSecret(null)),
              perfil: null,
              aviso:
                `El router no tiene un perfil PPP llamado "${perfil}": el secret quedó con el `
                + 'perfil por defecto y el abonado navega, pero sin el límite del plan. '
                + 'Creá ese perfil en el MikroTik, o —si la velocidad la controla la OLT— '
                + 'cambiá el plan a «La OLT (traffic table)» en Servicios → Planes.',
            }
          }
        },
      )
    } else if (aplicar && tipo_ip === 'fija' && cambios.ip && inst.equipo_mac) {
      resultado = await registrando(
        req,
        {
          instalacion: inst,
          comando: 'alta_dhcp',
          parametros: { ip: cambios.ip, mac: inst.equipo_mac },
          destino: { tipo: 'mikrotik', id: equipo.id, nombre: equipo.nombre },
        },
        async () => ({
          aplicado: true,
          ...(await mk.asegurarLeaseFija(equipo, {
            ip: cambios.ip,
            mac: inst.equipo_mac,
            comentario: `${titular} · alta ${inst.fecha}`,
          })),
        }),
      )
    } else if (aplicar) {
      resultado = {
        aplicado: false,
        aviso:
          tipo_ip === 'dinamica'
            ? 'Direccionamiento dinámico: no hay nada que reservar en el router.'
            : 'Sin MAC del equipo no se puede fijar la reserva DHCP. La IP queda anotada en la instalación.',
      }
    }

    if (resultado.aplicado) cambios.aprovisionado_at = new Date().toISOString()

    const guardada = await guardar(inst.id, cambios, 3)
    res.json({ ...resultado, router: equipo.nombre, instalacion: guardada })
  }),
)

// --- Paso 4: pruebas de salida ----------------------------------------------

/**
 * Ping y medición contra el equipo recién instalado.
 *
 * El ping sale del router del nodo y no del servidor: lo que hay que probar es
 * que el abonado responde dentro de la red. Que nuestro servidor no llegue
 * puede ser una ruta mal puesta y no tiene nada que ver con la instalación.
 *
 * El test de ancho de banda necesita un bandwidth-server del otro lado, que un
 * CPE común no tiene. Si falla no se corta el alta: se informa y el técnico
 * sigue. Bloquear el cierre por una medición que el equipo del cliente no puede
 * contestar dejaría trabajos terminados sin poder cerrarse.
 */
router.post(
  '/:id/pruebas',
  asyncHandler(async (req, res) => {
    const inst = await cargarInstalacion(req.params.id)

    if (!inst.router_id) throw badRequest('La instalación no tiene router asignado')
    const equipo = await cargarRouter(inst.router_id)

    let destino = req.body?.destino || inst.ip

    // En PPPoE con IP dinámica la dirección la reparte el router al conectar:
    // se le pregunta cuál le tocó a esta sesión.
    if (!destino && inst.tipo_conexion === 'pppoe' && inst.usuario_ppp) {
      const sesion = await mk.sesionPpp(equipo, { usuario: inst.usuario_ppp }).catch(() => null)
      destino = sesion?.[0]?.address ?? null
    }

    if (!destino) {
      throw badRequest('No hay contra qué medir', {
        hint: 'Asigná la IP en el paso anterior, o esperá a que el equipo levante la sesión PPPoE.',
      })
    }

    const paquetes = await registrando(
      req,
      {
        instalacion: inst,
        comando: 'ping',
        parametros: { destino },
        destino: { tipo: 'mikrotik', id: equipo.id, nombre: equipo.nombre },
      },
      () => mk.ping(equipo, { destino, cantidad: req.body?.cantidad ?? 5 }),
    )

    const enviados = (paquetes ?? []).filter((p) => p.time || p.status)
    const respondidos = enviados.filter((p) => p.time)
    const tiempos = respondidos
      .map((p) => Number(String(p.time).replace(/[^\d.]/g, '')))
      .filter(Boolean)

    const ping = {
      destino,
      enviados: enviados.length,
      recibidos: respondidos.length,
      perdida: enviados.length
        ? Math.round(((enviados.length - respondidos.length) / enviados.length) * 100)
        : null,
      ms_promedio: tiempos.length
        ? Math.round((tiempos.reduce((s, t) => s + t, 0) / tiempos.length) * 10) / 10
        : null,
    }

    let velocidad = null
    if (req.body?.velocidad !== false) {
      try {
        const salida = await registrando(
          req,
          {
            instalacion: inst,
            comando: 'test_velocidad',
            parametros: { destino },
            destino: { tipo: 'mikrotik', id: equipo.id, nombre: equipo.nombre },
          },
          () => mk.testVelocidad(equipo, { destino, duracion: req.body?.duracion ?? 5 }),
        )

        const ultima = (salida ?? []).at(-1) ?? {}
        // RouterOS devuelve bits por segundo. Se pasa a Mbps acá para que la
        // pantalla del técnico muestre el mismo número que el plan contratado.
        const aMbps = (v) => (v == null ? null : Math.round((Number(v) / 1e6) * 100) / 100)
        velocidad = {
          bajada_mbps: aMbps(ultima['rx-current'] ?? ultima['rx-total-average']),
          subida_mbps: aMbps(ultima['tx-current'] ?? ultima['tx-total-average']),
        }
      } catch (err) {
        velocidad = {
          bajada_mbps: null,
          subida_mbps: null,
          error: err.message,
          aviso:
            'El equipo del abonado no contestó la prueba de ancho de banda. Es normal en una ONT o un CPE que no es RouterOS.',
        }
      }
    }

    const guardada = await guardar(
      inst.id,
      {
        ip: inst.ip ?? destino,
        ping_ok: ping.recibidos > 0,
        ping_ms: ping.ms_promedio,
        ping_perdida: ping.perdida,
        test_bajada_mbps: velocidad?.bajada_mbps ?? null,
        test_subida_mbps: velocidad?.subida_mbps ?? null,
        pruebas_at: new Date().toISOString(),
      },
      4,
    )

    res.json({
      ok: ping.recibidos > 0,
      ping,
      velocidad,
      mensaje: ping.recibidos
        ? `${destino} responde en ${ping.ms_promedio} ms con ${ping.perdida}% de pérdida.`
        : `${destino} no responde. El equipo no está tomando la configuración.`,
      instalacion: guardada,
    })
  }),
)

export default router
