import { Router } from 'express'
import { asyncHandler, badRequest, notFound, AppError } from '../lib/errors.js'
import { requireAuth } from '../lib/auth.js'
import { exigir } from '../lib/permisos.js'
import { db, cargarOlt } from '../lib/db.js'
import * as olts from '../services/oltService.js'
import * as ficha from '../services/oltFicha.js'

/**
 * El paso que falta del cambio de ONT: la OLT.
 *
 * ── Qué hace la base y qué hace esto ──
 *
 * `reemplazar_equipo_cliente()` (migración 93) descuenta el equipo nuevo del
 * almacén, lo ata al abonado, saca el viejo y registra el reemplazo. Todo eso
 * en una transacción.
 *
 * Lo que no puede hacer es hablar con la OLT: las credenciales del equipo viven
 * acá y el navegador del técnico no las toca. Así que el reemplazo queda
 * `pendiente_olt` y esta ruta lo cierra.
 *
 * Mientras esté pendiente, EL ABONADO NO TIENE SERVICIO. Por eso la vista
 * `v_reemplazos_pendientes` cuenta los minutos.
 *
 * ── Por qué el técnico puede llamarla ──
 *
 * Porque ya autoriza ONTs: lo hace en cada instalación por
 * `POST /instalaciones/:id/autorizar`. Esto es la misma operación acotada sobre
 * un abonado que ya existe.
 *
 * Y es acotada de verdad: el técnico manda el id del reemplazo y nada más. El
 * puerto, el perfil, la VLAN y el nombre salen de lo que ya tenía la ONU vieja,
 * leído acá. No hay ningún parámetro de red que pueda elegir — que es la
 * diferencia entre "reemplazar un equipo" y "configurar la OLT".
 */

const router = Router()
router.use(requireAuth)

router.post(
  '/:id/aprovisionar',
  asyncHandler(async (req, res) => {
    // Autorizar una ONT es lo que ya hace al instalar. Se pide el mismo permiso.
    await exigir(req, ['red.onus_aprovisionar', 'instalaciones.completar'])

    const { data: r, error: errR } = await db()
      .from('reemplazos_equipo')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle()

    if (errR) throw new AppError(`No se pudo leer el reemplazo: ${errR.message}`)
    if (!r) throw notFound('No existe ese reemplazo')
    if (!r.pendiente_olt) {
      return res.json({ ok: true, ya_estaba: true, mensaje: 'Ese reemplazo ya se aprovisionó.' })
    }

    const anterior = await onuAnterior(r)

    /**
     * Sin puerto no se sigue.
     *
     * Sería fácil autorizar la ONT nueva en "el primer puerto donde aparezca".
     * No se hace: un equipo autorizado en el puerto equivocado toma un ONT-ID
     * que puede estar en uso y deja sin servicio a un abonado que no tenía
     * nada que ver con esta visita. Cuando no sabemos dónde estaba, la
     * respuesta correcta es decirlo.
     */
    if (!anterior?.olt_id || anterior.puerto == null) {
      throw badRequest('No se pudo saber en qué puerto estaba la ONT anterior', {
        hint: 'Autorizá la ONT nueva desde la pantalla de la OLT indicando el puerto, y después marcá este reemplazo como resuelto.',
      })
    }
    if (anterior.vlan == null) {
      throw badRequest('La ONT anterior no tiene VLAN registrada', {
        hint: 'Sin VLAN no pasa tráfico. Autorizá la ONT nueva desde la pantalla de la OLT.',
      })
    }

    const equipo = await cargarOlt(anterior.olt_id)

    // ── 1. Que la OLT vea la nueva, ANTES de borrar la vieja ──
    //
    // Al revés —borrar y después mirar— un conector flojo deja al abonado sin
    // las dos ONTs y con el técnico ya subido a la camioneta.
    const hallazgo = await olts.buscarPorSn(equipo, {
      sn: r.serie_nueva,
      frame: anterior.frame ?? 0,
      slot: anterior.slot ?? 0,
      puerto: anterior.puerto,
    })

    /**
     * "No la encontré" y "no me contestaron" no son lo mismo.
     *
     * Si la OLT no respondió —máximo de sesiones SSH, VPN caída—, decirle al
     * técnico que revise el conector lo manda a desarmar una instalación que
     * está bien. Y encima la vieja sigue viva, así que el abonado tiene
     * servicio: lo correcto es que espere y reintente, no que toque nada.
     */
    if (!hallazgo?.encontrada && hallazgo?.sinRespuesta) {
      throw new AppError('La OLT no contestó, así que no se pudo verificar la ONT nueva', {
        status: 503,
        hint: 'No toques la instalación: la ONT anterior sigue autorizada. Esperá un minuto y reintentá.',
        detalle: hallazgo.fallos?.join(' · '),
      })
    }

    if (!hallazgo?.encontrada) {
      throw badRequest(
        `La OLT todavía no ve la ONT ${r.serie_nueva} en el puerto ${anterior.puerto}`,
        { hint: 'Revisá el conector y el patchcord, esperá unos segundos y reintentá.' },
      )
    }

    // ── 2. Sale la vieja ──
    //
    // Su fallo NO corta el proceso. El abonado necesita servicio hoy; una ONT
    // fantasma ocupando un índice en la OLT es un problema de oficina. Pero
    // queda dicho en la respuesta: callarlo es cómo se acumulan.
    let bajaVieja = { ok: true, omitida: true }
    if (anterior.onu_index != null) {
      try {
        await olts.eliminarOnu(equipo, {
          frame: anterior.frame ?? 0,
          slot: anterior.slot ?? 0,
          puerto: anterior.puerto,
          onuId: anterior.onu_index,
        })
        bajaVieja = { ok: true, omitida: false }
        await db().from('onus').delete().eq('id', anterior.id)
      } catch (err) {
        bajaVieja = { ok: false, error: err.message }
      }
    }

    // ── 3. Entra la nueva, con la configuración de la vieja ──
    //
    // Todo lo que va acá se COPIA de la ONU anterior. El técnico no manda ni
    // puerto, ni perfil, ni VLAN: esa es la diferencia entre "reemplazar un
    // equipo" y "configurar la OLT desde el celular".
    const nueva = await ficha.autorizarOnt(equipo, {
      sn: r.serie_nueva,
      slot: hallazgo.slot ?? anterior.slot ?? 0,
      puerto: hallazgo.puerto ?? anterior.puerto,
      // Los perfiles que se le pasan a la OLT son los índices del equipo
      // (`*_olt`), no los ids internos del catálogo.
      lineProfileId: anterior.line_profile_olt ?? null,
      srvProfileId: anterior.srv_profile_olt ?? null,
      vlan: anterior.vlan,
      nombre: anterior.nombre_cliente ?? null,
      comentario: `Reemplazo de ${r.serie_anterior ?? 'equipo anterior'}`,
      plan_id: anterior.plan_id ?? null,
      // La instalación original del abonado, no la de esta visita.
      //
      // De ahí salen el usuario y la clave PPPoE que hay que escribirle a la
      // ONT nueva cuando el ACS no puede configurarla solo. Sin esto la ficha
      // manual sale con los dos campos vacíos y el técnico queda parado en la
      // casa con un equipo que no puede conectar — teniendo el sistema el dato
      // guardado desde el día del alta.
      instalacion_id: await instalacionDelAbonado(r),
    })

    // ── 4. La ficha del abonado vuelve a apuntar a algo real ──
    //
    // `reemplazar_equipo_cliente()` dejó `clientes.onu_id` en NULL a propósito:
    // la ONU de la ficha ya no existía. Recién ahora hay a qué apuntar.
    if (nueva?.onu_id) {
      await db().from('clientes').update({ onu_id: nueva.onu_id }).eq('id', r.cliente_id)
      await db().from('equipos').update({ onu_id: nueva.onu_id }).eq('id', r.equipo_nuevo_id)
    }

    await db()
      .from('reemplazos_equipo')
      .update({ pendiente_olt: false, olt_at: new Date().toISOString() })
      .eq('id', r.id)

    res.json({
      ok: true,
      puerto: hallazgo.puerto ?? anterior.puerto,
      slot: hallazgo.slot ?? anterior.slot ?? 0,
      onu_id: nueva?.onu_id ?? null,
      ip_gestion: nueva?.ip_gestion ?? null,
      ...(nueva?.ficha_manual ? { ficha_manual: nueva.ficha_manual } : {}),
      baja_anterior: bajaVieja,
      aviso: [
        nueva?.aviso ?? null,
        bajaVieja.ok === false
          ? `El servicio quedó andando, pero no se pudo dar de baja la ONT anterior (${bajaVieja.error}). Avisá a la oficina para que la saque de la OLT.`
          : null,
      ]
        .filter(Boolean)
        .join(' · ') || null,
    })
  }),
)

/**
 * Dónde estaba la ONT que se cambió.
 *
 * Primero por `onu_anterior_id`, que es el dato que la migración 93 guarda
 * justo antes de soltar la ficha del abonado. El camino por `clientes.onu_id`
 * queda como red de seguridad para los reemplazos creados antes de que esa
 * columna existiera — y para el caso en que alguien lance el aprovisionamiento
 * sin haber pasado por la función.
 */
async function onuAnterior(r) {
  if (r.onu_anterior_id) {
    const { data } = await db().from('onus').select('*').eq('id', r.onu_anterior_id).maybeSingle()
    if (data) return data
  }

  const { data: cli } = await db()
    .from('clientes')
    .select('onu_id')
    .eq('id', r.cliente_id)
    .maybeSingle()

  if (!cli?.onu_id) return null
  const { data } = await db().from('onus').select('*').eq('id', cli.onu_id).maybeSingle()
  return data
}

/**
 * La instalación de la que salió este abonado.
 *
 * Se busca la que ya tiene credenciales PPPoE cargadas y no la más reciente: si
 * el abonado tuvo una visita posterior —un traslado, un reclamo con orden— esa
 * fila puede existir vacía, y devolverla sería tapar el dato bueno con uno en
 * blanco.
 */
async function instalacionDelAbonado(r) {
  if (r.instalacion_id) return r.instalacion_id

  const { data } = await db()
    .from('instalaciones')
    .select('id, usuario_ppp')
    .eq('client_id', r.cliente_id)
    .not('usuario_ppp', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return data?.id ?? null
}

export default router
