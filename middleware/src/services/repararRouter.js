import { db, cargarRouter } from '../lib/db.js'
import { badRequest } from '../lib/errors.js'
import * as mk from './mikrotikService.js'
import { extraerIp } from './importador.js'
import { compararColas, compararLeases } from '../lib/comparaRouter.js'
import { camposDeCola } from '../lib/velocidad.js'
import { nombreDeCola, nombreDeColaAlterno } from '../lib/servicios.js'

/**
 * Dejar el MikroTik igual a lo que dice el sistema.
 *
 * Resuelve dos problemas distintos con el mismo mecanismo:
 *
 *   DESPUÉS DE UNA MIGRACIÓN. El router quedó armado por el sistema anterior:
 *   secrets con otros nombres, IPs que no coinciden, perfiles viejos. Esto lo
 *   reescribe con lo que tiene el sistema nuevo, y el router deja de tener
 *   rastro del anterior.
 *
 *   TODOS LOS DÍAS. Se cobra un pago con el router caído y el abonado queda en
 *   la lista de morosos aunque ya no deba. O se le cambia la IP en el sistema y
 *   el secret sigue con la vieja. Son diferencias que nadie ve hasta que el
 *   cliente llama.
 *
 * Lo que NO hace, y es deliberado: borrar lo que no reconoce. Un secret que el
 * sistema no tiene puede ser un abonado cuya ficha no se migró todavía —
 * borrarlo lo deja sin internet sin que nadie sepa por qué. Se informa aparte y
 * se borra solo si se pide explícitamente.
 */

const LISTA_MOROSOS = mk.LISTA_MOROSOS

/**
 * ¿A este abonado lo atiende un secret PPPoE?
 *
 * Importa porque esta pantalla revisa secrets, y en un ISP que trabaja con IP
 * fija y Simple Queue no hay ninguno. Sin distinguirlo, reportaba a TODOS los
 * abonados como "falta usuario PPPoE" — veintisiete avisos sobre algo que está
 * bien, que es la forma más rápida de que nadie vuelva a leer esta pantalla.
 *
 * Manda `tipo_conexion`. Cuando no está cargado —fichas viejas, anteriores a
 * que existiera la columna— se deduce de si tiene usuario PPPoE: si lo tiene,
 * alguien se lo puso para algo.
 */
export function usaPppoe(cliente) {
  const tipo = String(cliente?.tipo_conexion ?? '').trim().toLowerCase()
  if (tipo) return tipo === 'pppoe'
  return Boolean(String(cliente?.usuario_ppp ?? '').trim())
}

/** Qué hay que arreglar, sin tocar nada. */
export async function revisar(routerId) {
  const equipo = await cargarRouter(routerId)

  const [{ data: clientes }, secrets, lista, perfiles, colas, leases, { data: planes }] =
    await Promise.all([
    db()
      .from('clientes')
      .select('id, nombre, estado, ip, mac_address, tipo_conexion, usuario_ppp, clave_ppp, plan_id, referencia_servicio, planes_velocidad(nombre, perfil_ppp)')
      .eq('router_id', routerId),
    mk.listarPppSecrets(equipo).catch(() => []),
    mk.listarBloqueos(equipo, LISTA_MOROSOS).catch(() => []),
    mk.listarPppProfiles(equipo).catch(() => []),
    // Las colas y las leases son la otra mitad del abonado de IP fija: la cola
    // lo limita y la lease le entrega su dirección. Si alguna de las dos quedó
    // con la IP vieja, el corte apunta a una dirección que en el router no es
    // de nadie.
    mk.listarSimpleQueues(equipo).catch(() => []),
    mk.listarDhcpLeases(equipo).catch(() => []),
    db().from('planes_velocidad').select('*'),
  ])

  if (!clientes?.length) throw badRequest('Este router no tiene clientes asignados en el sistema')

  const porUsuario = new Map(secrets.filter((s) => s.name).map((s) => [s.name, s]))
  const nombresDePerfil = new Set(perfiles.map((p) => p.name))
  const enLista = new Map()
  for (const e of lista) {
    const ip = extraerIp(e.address)
    if (ip) enLista.set(ip, e)
  }

  const secrets2 = []
  const morosos = []
  const sinDatos = []

  for (const c of clientes) {
    const perfilEsperado = c.planes_velocidad?.perfil_ppp ?? null
    const ip = extraerIp(c.ip)

    // --- El secret ---
    //
    // Solo para los de PPPoE. A los de IP fija no les corresponde uno: su
    // límite es la Simple Queue, que gobierna la sincronización del plan, y su
    // dirección se la da un lease. Revisarles el secret sería inventarles una
    // falta.
    if (!usaPppoe(c)) {
      // nada que revisar acá
    } else if (!c.usuario_ppp) {
      sinDatos.push({ cliente: c.nombre, id: c.id, falta: 'usuario PPPoE' })
    } else {
      const s = porUsuario.get(c.usuario_ppp)
      const diferencias = []

      if (!s) {
        secrets2.push({ cliente: c.nombre, id: c.id, usuario: c.usuario_ppp, accion: 'crear', ip, perfil: perfilEsperado })
      } else {
        const ipEnRouter = extraerIp(s['remote-address'])
        if (ip && ipEnRouter !== ip) {
          diferencias.push({ campo: 'IP', router: ipEnRouter ?? '—', sistema: ip })
        }
        // El perfil solo se corrige si el plan dice cuál y ese existe en el
        // router: cambiarlo por uno que no está dejaría al abonado sin límite.
        if (perfilEsperado && nombresDePerfil.has(perfilEsperado) && s.profile !== perfilEsperado) {
          diferencias.push({ campo: 'perfil', router: s.profile ?? '—', sistema: perfilEsperado })
        }
        if (perfilEsperado && !nombresDePerfil.has(perfilEsperado)) {
          sinDatos.push({
            cliente: c.nombre,
            id: c.id,
            falta: `el perfil "${perfilEsperado}" no existe en el router`,
          })
        }
        if (diferencias.length) {
          secrets2.push({
            cliente: c.nombre,
            id: c.id,
            usuario: c.usuario_ppp,
            accion: 'corregir',
            ip,
            perfil: perfilEsperado,
            diferencias,
          })
        }
      }
    }

    // --- La lista de morosos ---
    if (!ip) {
      if (c.estado === 'cortado') {
        sinDatos.push({ cliente: c.nombre, id: c.id, falta: 'IP: sin ella no se puede cortar por lista' })
      }
    } else if (c.estado === 'cortado' && !enLista.has(ip)) {
      morosos.push({ cliente: c.nombre, ip, accion: 'agregar', motivo: 'está cortado y el router no lo bloquea' })
    } else if (c.estado !== 'cortado' && enLista.has(ip)) {
      morosos.push({
        cliente: c.nombre,
        ip,
        accion: 'quitar',
        id: enLista.get(ip)['.id'] ?? enLista.get(ip).id ?? null,
        // Es el caso que describe el problema: se cobró con el router caído.
        motivo: `figura como "${c.estado}" y el router lo sigue bloqueando`,
      })
    }
  }

  /**
   * Lo que se espera de cada cola, plan por plan.
   *
   * Se calcula con `camposDeCola`, el MISMO que usa la sincronización para
   * escribir. Comparar contra otra cosa haría que reparar corrigiera para
   * siempre algo que ya está bien.
   */
  const esperadoPorPlan = new Map(
    (planes ?? []).map((p) => [p.id, camposDeCola(p).campos]),
  )

  const deIpFija = (clientes ?? []).filter((c) => !usaPppoe(c))
  const diffColas = compararColas({ clientes: deIpFija, colas, esperadoPorPlan })
  const diffLeases = compararLeases({ clientes: deIpFija, leases })

  // Lo que hay en el router y el sistema no conoce. NO se toca por defecto.
  const usuariosDelSistema = new Set(clientes.map((c) => c.usuario_ppp).filter(Boolean))
  const ipsDelSistema = new Set(clientes.map((c) => extraerIp(c.ip)).filter(Boolean))

  const desconocidos = {
    secrets: secrets
      .filter((s) => s.name && !usuariosDelSistema.has(s.name))
      .map((s) => ({ usuario: s.name, ip: s['remote-address'] ?? null, perfil: s.profile ?? null })),
    bloqueos: [...enLista.entries()]
      .filter(([ip]) => !ipsDelSistema.has(ip))
      .map(([ip, e]) => ({ ip, comentario: e.comment ?? null, id: e['.id'] ?? e.id ?? null })),
  }

  return {
    router: { id: equipo.id, nombre: equipo.nombre },
    secrets: secrets2,
    colas: diffColas,
    leases: diffLeases,
    morosos,
    sin_datos: sinDatos,
    desconocidos,
    resumen: {
      clientes: clientes.length,
      secrets_a_crear: secrets2.filter((s) => s.accion === 'crear').length,
      secrets_a_corregir: secrets2.filter((s) => s.accion === 'corregir').length,
      bloqueos_a_agregar: morosos.filter((m) => m.accion === 'agregar').length,
      bloqueos_a_quitar: morosos.filter((m) => m.accion === 'quitar').length,
      sin_datos: sinDatos.length,
      desconocidos_en_router:
        desconocidos.secrets.length + desconocidos.bloqueos.length + diffColas.desconocidas.length,
      colas_a_crear: diffColas.faltan.length,
      colas_a_corregir: diffColas.corregir.length,
      colas_duplicadas: diffColas.duplicadas.length,
      leases_a_corregir: diffLeases.corregir.length,
      // Si no hay nada que hacer, decirlo con todas las letras: es el resultado
      // más frecuente y el más tranquilizador.
      sin_cambios:
        secrets2.length === 0 &&
        morosos.length === 0 &&
        diffColas.faltan.length === 0 &&
        diffColas.corregir.length === 0 &&
        diffLeases.corregir.length === 0,
    },
  }
}

/**
 * Aplica las correcciones.
 *
 * Cada una va por separado y se informa: si la número doce falla, las once
 * anteriores quedaron hechas y hay que poder verlo. Deshacerlas
 * automáticamente sería peor — dejaría a medias un router que ya estaba a
 * medias.
 */
export async function reparar(routerId, { borrarDesconocidos = false } = {}) {
  const plan = await revisar(routerId)
  const equipo = await cargarRouter(routerId)
  const hecho = { secrets: 0, colas: 0, leases: 0, bloqueos: 0, borrados: 0, fallos: [] }

  for (const s of plan.secrets) {
    try {
      const { data: c } = await db()
        .from('clientes')
        .select('clave_ppp, usuario_ppp')
        .eq('id', s.id)
        .maybeSingle()

      await mk.asegurarPppSecret(equipo, {
        usuario: s.usuario,
        // Sin clave guardada se repite el usuario, que es lo que ya hacía la
        // exportación. Es preferible a dejar el secret sin crear: el abonado
        // conecta y la clave se corrige después.
        clave: c?.clave_ppp || s.usuario,
        perfil: s.perfil ?? undefined,
        ip: s.ip ?? null,
        comentario: s.cliente,
      })
      hecho.secrets++
    } catch (e) {
      hecho.fallos.push(`secret ${s.usuario}: ${e.message}`)
    }
  }

  /**
   * Las colas que faltan o no coinciden.
   *
   * Va ANTES de la lista de morosos a propósito: si a alguien hay que crearle
   * la cola y además bloquearlo, conviene que primero exista lo que lo limita.
   *
   * Se vuelve a leer la ficha en vez de confiar en lo que trae el plan: entre
   * revisar y aplicar pasa el tiempo que tarda alguien en mirar la pantalla y
   * decidir, y en el medio le pueden haber cambiado el plan.
   */
  for (const c of [...plan.colas.faltan, ...plan.colas.corregir]) {
    try {
      const { data: ficha } = await db()
        .from('clientes')
        .select('nombre, ip, ipv6_prefijo, referencia_servicio, planes_velocidad(*)')
        .eq('id', c.id)
        .maybeSingle()

      if (!ficha?.ip || !ficha.planes_velocidad) {
        hecho.fallos.push(`cola de ${c.cliente}: le falta IP o plan`)
        continue
      }

      const { campos } = camposDeCola(ficha.planes_velocidad)
      await mk.asegurarSimpleQueue(equipo, {
        nombre: nombreDeCola(ficha),
        nombreAlterno: nombreDeColaAlterno(ficha, ficha.ip),
        ip: ficha.ip,
        ipv6: equipo.ipv6_activo ? ficha.ipv6_prefijo || null : null,
        comentario: ficha.planes_velocidad.nombre,
        campos,
      })
      hecho.colas++
    } catch (e) {
      hecho.fallos.push(`cola de ${c.cliente}: ${e.message}`)
    }
  }

  /**
   * Las leases que entregan una dirección distinta a la que dice el sistema.
   *
   * Es la otra mitad del cambio de IP: sin esto el equipo del abonado sigue
   * recibiendo la vieja, y la cola nueva —que ya apunta a la nueva— no lo
   * alcanza nunca.
   */
  for (const l of plan.leases.corregir) {
    try {
      await mk.asegurarLeaseFija(equipo, { ip: l.ip, mac: l.mac, comentario: l.cliente })
      hecho.leases++
    } catch (e) {
      hecho.fallos.push(`lease de ${l.cliente}: ${e.message}`)
    }
  }

  for (const m of plan.morosos) {
    try {
      if (m.accion === 'agregar') {
        await mk.bloquearIp(equipo, { address: m.ip, comment: m.cliente, lista: LISTA_MOROSOS })
      } else if (m.id) {
        await mk.desbloquear(equipo, m.id)
      }
      hecho.bloqueos++
    } catch (e) {
      hecho.fallos.push(`${m.accion} ${m.ip}: ${e.message}`)
    }
  }

  // Lo que el sistema no conoce, solo si se pidió. Un secret desconocido puede
  // ser un abonado cuya ficha no se migró: borrarlo lo deja sin internet.
  if (borrarDesconocidos) {
    for (const s of plan.desconocidos.secrets) {
      try {
        await mk.borrarPppSecret(equipo, s.usuario)
        hecho.borrados++
      } catch (e) {
        hecho.fallos.push(`borrar ${s.usuario}: ${e.message}`)
      }
    }
    for (const b of plan.desconocidos.bloqueos) {
      try {
        if (b.id) await mk.desbloquear(equipo, b.id)
        hecho.borrados++
      } catch (e) {
        hecho.fallos.push(`desbloquear ${b.ip}: ${e.message}`)
      }
    }
  }

  return { ...plan, ...hecho, borrar_desconocidos: borrarDesconocidos }
}
