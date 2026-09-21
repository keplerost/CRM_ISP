/**
 * Le pregunta el modelo a las ONTs que todavía no lo tienen.
 *
 *   node scripts/leer-modelos-faltantes.mjs            solo informa
 *   node scripts/leer-modelos-faltantes.mjs --aplicar  guarda lo que contestó
 *
 * ── Por qué existe, si el resync masivo ya lo hace ──
 *
 * El resync masivo relee la ficha de las noventa ONUs y son quince minutos de
 * sesión SSH contra un equipo que tiene pocas y las comparte con quien esté
 * haciendo un alta. Cuando lo único que falta es el modelo de cuatro ONTs, eso
 * es pagar quince minutos por cuatro preguntas.
 *
 * Esto hace exactamente la segunda pasada del resync —`leerModelosFaltantes`—
 * y nada más: `display ont version` a las que tienen el modelo en null.
 *
 * ── Por qué hay que correrlo más de una vez ──
 *
 * Una ONT apagada no contesta su versión. No es un error: es que del otro lado
 * no hay nadie. Las que faltan se completan solas la próxima corrida que las
 * encuentre encendidas, y por eso el script es seguro de repetir — solo mira
 * las que siguen sin modelo.
 *
 * Solo lee. No se le manda un comando de escritura a ninguna ONT.
 */
import 'dotenv/config'
import { db, cargarOlt } from '../src/lib/db.js'
import * as olts from '../src/services/oltService.js'

const APLICAR = process.argv.includes('--aplicar')

const { data: pendientes } = await db()
  .from('onus')
  .select('id, olt_id, sn, slot, puerto, onu_index, estado, nombre_cliente')
  .is('modelo', null)

if (!pendientes?.length) {
  console.log('No hay ONUs sin modelo. Nada que hacer.')
  process.exit(0)
}

const porOlt = new Map()
for (const o of pendientes) {
  if (!porOlt.has(o.olt_id)) porOlt.set(o.olt_id, [])
  porOlt.get(o.olt_id).push(o)
}

let guardadas = 0
let sinRespuesta = 0

for (const [oltId, lista] of porOlt) {
  const olt = await cargarOlt(oltId)
  console.log(`\n${olt.nombre} · ${lista.length} ONU${lista.length === 1 ? '' : 's'} sin modelo`)

  let leidos = []
  try {
    leidos = await olts.leerModelosDeOnts(olt, {
      onts: lista.map((o) => ({ slot: o.slot, puerto: o.puerto, ontId: o.onu_index, onu_id: o.id, sn: o.sn })),
    })
  } catch (err) {
    // Que falle una OLT no invalida las otras: se anota y se sigue.
    console.log(`   no se pudo leer: ${err.message}`)
    continue
  }

  for (const l of leidos) {
    const o = lista.find((x) => x.id === l.onu_id)
    const donde = `${o.slot}/${o.puerto}:${String(o.onu_index).padStart(2)} ${o.sn}`
    if (!l.modelo) {
      sinRespuesta++
      console.log(`   ${donde}  ${String(o.estado).padEnd(8)} no contestó`)
      continue
    }
    if (APLICAR) {
      const { error } = await db().from('onus').update({ modelo: l.modelo }).eq('id', l.onu_id)
      if (error) {
        console.log(`   ${donde}  ${l.modelo}  ERROR al guardar: ${error.message}`)
        continue
      }
    }
    guardadas++
    console.log(`   ${donde}  ${String(o.estado).padEnd(8)} ${l.modelo}${APLICAR ? '  guardado' : '  (simulacro)'}`)
  }
}

console.log(`\nresueltas: ${guardadas} · siguen sin contestar: ${sinRespuesta}`)
if (!APLICAR && guardadas) console.log('Simulacro: no se guardó nada. Repetí con --aplicar.')
