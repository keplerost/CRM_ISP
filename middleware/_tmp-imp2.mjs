import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { importarIpsDeGestion } from './src/services/poolsOnu.js'

const OLT = 'e5ed1b1b-71ba-4c0c-ae9f-aa153cefda93'
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Solo `display` contra la OLT. No cambia una coma en el equipo ni en el
// servicio de nadie: escribe únicamente en nuestra base.
const r = await importarIpsDeGestion(OLT, { aplicar: true })

console.log('=== RESUMEN DE LA LECTURA ===')
for (const [k, v] of Object.entries(r.resumen)) console.log(`   ${k.padEnd(14)} ${v}`)

console.log('\n=== RESULTADO DE LA IMPORTACION ===')
console.log('   importadas:', r.importadas)
console.log('   fuera del rango declarado (se crearon igual):', r.fuera_del_rango)
console.log('   fallidas:', r.fallidas.length, r.fallidas.length ? JSON.stringify(r.fallidas.slice(0,3)) : '')

const { data: pool } = await db.from('v_pools_onu').select('*').eq('olt_id', OLT).eq('proposito','gestion_onu').single()
console.log('\n=== COMO QUEDO EL POOL ===')
console.log(`   ${pool.cidr} vlan ${pool.vlan} gw ${pool.gateway} · total ${pool.total ?? '?'} · libres ${pool.libres} · asignadas ${pool.asignadas ?? '?'}`)

const { data: muestra } = await db.from('ip_addresses')
  .select('ip_address, estado, descripcion, onu_id')
  .eq('subred_id', pool.id).eq('estado','asignada').order('ip_address').limit(6)
console.log('\n=== MUESTRA DE LO IMPORTADO ===')
for (const i of muestra ?? []) console.log(`   ${String(i.ip_address).padEnd(16)} ${i.estado.padEnd(9)} ${i.descripcion} ${i.onu_id ? '· atada a su ONU' : '· SIN ONU'}`)

const { count: sinOnu } = await db.from('ip_addresses')
  .select('*', { count:'exact', head:true }).eq('subred_id', pool.id).eq('estado','asignada').is('onu_id', null)
console.log('\n   asignadas sin ONU atada:', sinOnu, '(debería ser 0)')
