import { db, cargarOlt } from '../lib/db.js'
import * as ficha from './oltFicha.js'
import * as preaut from './preautorizacion.js'

/**
 * Barrido periódico de ONTs esperando autorización.
 *
 * Guarda el resultado en vez de dejar que la pantalla consulte a los equipos.
 * Es lo que hace la diferencia entre abrir el tablero y esperar quince segundos,
 * o abrirlo y ver el estado al instante con la hora del último barrido.
 *
 * Es barato porque el barrido es híbrido: SNMP dice qué puertos tienen
 * candidatas —un recorrido, menos de un segundo— y la CLI confirma solo esos.
 * Cuando no hay nada nuevo, que es el caso normal, no se manda ni un comando.
 */

const estado = {
  automatico: false,
  cada_minutos: null,
  corriendo: false,
  ultimaCorrida: null,
  ultimoResultado: null,
}

export const estadoEsperando = () => ({ ...estado })

/**
 * Deja la tabla igual a lo que se acaba de confirmar en el equipo.
 *
 * Las que ya no están se borran; las que siguen conservan su `created_at`, para
 * poder decir hace cuánto que esa ONT espera que alguien la autorice.
 */
async function sincronizar(oltId, onts) {
  const ahora = new Date().toISOString()

  if (onts.length) {
    const { error } = await db()
      .from('onts_esperando')
      .upsert(
        onts.map((o) => ({
          olt_id: oltId,
          sn: o.sn,
          slot: o.slot,
          puerto: o.puerto,
          modelo: o.modelo ?? null,
          detectada: o.detectada ?? null,
          visto_at: ahora,
        })),
        { onConflict: 'olt_id,sn' },
      )
    if (error) throw new Error(`No se pudo guardar lo esperando: ${error.message}`)
  }

  // Lo que no se volvió a ver en esta pasada ya no está en la cola.
  let borrar = db().from('onts_esperando').delete().eq('olt_id', oltId)
  if (onts.length) borrar = borrar.not('sn', 'in', `(${onts.map((o) => o.sn).join(',')})`)
  await borrar
}

/** Barre una OLT y deja constancia del resultado, salga bien o mal. */
export async function escanearUna(fila) {
  const inicio = Date.now()
  try {
    const olt = await cargarOlt(fila.id)
    const r = await ficha.esperandoAutorizacion(olt)
    await sincronizar(fila.id, r.onts)

    // Las que estaban cargadas de antemano se autorizan solas. Va DESPUÉS de
    // sincronizar para que, si algo falla acá, la cola ya haya quedado al día:
    // un fallo autorizando no tiene por qué esconder lo que se encontró.
    const previas = await preaut.aplicarPreautorizaciones(olt, r.onts).catch((err) => {
      console.error(`[esperando] ${fila.nombre}: falló aplicar pre-autorizaciones:`, err.message)
      return null
    })
    for (const a of previas?.autorizadas ?? []) {
      console.log(`[esperando] ${fila.nombre}: autorizada sola ${a.sn} en ${a.slot}/${a.puerto}`)
    }
    for (const f of previas?.fallidas ?? []) {
      console.error(`[esperando] ${fila.nombre}: no se pudo autorizar ${f.sn}: ${f.error}`)
    }

    await db().from('olt_escaneos').upsert({
      olt_id: fila.id,
      at: new Date().toISOString(),
      encontradas: r.esperando,
      descartadas: r.descartadas,
      puertos: r.puertos_consultados.length,
      ms: r.ms,
      error: null,
    })

    return {
      olt: fila.nombre,
      esperando: r.esperando,
      descartadas: r.descartadas,
      ms: r.ms,
      autorizadas_solas: previas?.autorizadas?.length ?? 0,
      no_autorizadas: previas?.fallidas ?? [],
    }
  } catch (err) {
    // El fallo se guarda: un barrido que no se pudo hacer NO es un barrido con
    // cero resultados, y la pantalla tiene que poder distinguirlos.
    await db().from('olt_escaneos').upsert({
      olt_id: fila.id,
      at: new Date().toISOString(),
      encontradas: 0,
      descartadas: 0,
      puertos: 0,
      ms: Date.now() - inicio,
      error: err.message,
    })
    return { olt: fila.nombre, error: err.message }
  }
}

export async function escanearTodas() {
  if (estado.corriendo) return { salteada: true, motivo: 'ya hay un barrido en curso' }
  estado.corriendo = true

  try {
    const { data, error } = await db()
      .from('olts')
      .select('id, nombre, snmp_ro_encrypted, activo')
      .order('numero')

    if (error) throw new Error(`No se pudieron leer las OLTs: ${error.message}`)

    const resultados = []
    const sinSnmp = []

    for (const fila of (data ?? []).filter((o) => o.activo !== false)) {
      // Sin comunidad SNMP habría que barrer todos los puertos por la CLI:
      // minutos por equipo, cada cinco minutos. No se hace.
      if (!fila.snmp_ro_encrypted) {
        sinSnmp.push(fila.nombre)
        continue
      }
      resultados.push(await escanearUna(fila))
    }

    const resumen = {
      resultados,
      sin_snmp: sinSnmp,
      esperando: resultados.reduce((a, r) => a + (r.esperando ?? 0), 0),
      corrida: new Date().toISOString(),
    }

    estado.ultimaCorrida = resumen.corrida
    estado.ultimoResultado = resumen
    return resumen
  } finally {
    estado.corriendo = false
  }
}

/**
 * Deja el barrido corriendo cada N minutos.
 *
 * A diferencia de la lectura óptica, esta SÍ corre al arrancar (con un minuto de
 * gracia): si el middleware estuvo caído un rato, lo primero que uno quiere ver
 * al volver es si hay algo esperando, no la foto de antes de la caída.
 */
export function programarEsperando({ cada_minutos = 5 } = {}) {
  estado.automatico = true
  estado.cada_minutos = cada_minutos

  const correr = async () => {
    try {
      const r = await escanearTodas()
      if (r.salteada) return
      const fallos = r.resultados.filter((x) => x.error)
      if (r.esperando) console.log(`[esperando] ${r.esperando} ONTs esperando autorización`)
      for (const f of fallos) console.error(`[esperando] ${f.olt}: ${f.error}`)
    } catch (err) {
      console.error('[esperando] falló el barrido:', err.message)
    }
  }

  const primera = setTimeout(correr, 60_000)
  primera.unref?.()

  const tarea = setInterval(correr, cada_minutos * 60_000)
  tarea.unref?.()
  return tarea
}
