import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import * as traslados from './src/services/traslados.js'
const env = Object.fromEntries(readFileSync('.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))
const a = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
const { data: olt } = await a.from('olts').select('id').limit(1).single()
const { data: r } = await a.from('routers_mikrotik').select('id').limit(1).single()

const { data: ip, error: eIp } = await a.from('ip_addresses').insert({
  router_id: r.id, ip_address: '10.95.95.95', interfaz: 'DBG', estado: 'asignada',
}).select().single()
console.log('ip creada:', eIp ? eIp.message : ip.id, ip?.estado)

const { data: u } = await a.from('onus').insert({
  olt_id: olt.id, sn: 'DBG95B', nombre_cliente: 'DBG', frame: 0, slot: 6, puerto: 9, onu_index: 95, vlan: 200, estado: 'online',
}).select().single()
const { data: cli } = await a.from('clientes').insert({
  nombre: 'DBG95B cli', direccion: 'x', estado: 'activo', onu_id: u.id, ip: '10.95.95.95', router_id: r.id,
}).select().single()
const { data: tid } = await a.rpc('iniciar_traslado', { p_cliente: cli.id, p_direccion: 'NUEVA' })
const { data: t } = await a.from('traslados').select('*').eq('id', tid).single()

const res = await traslados.bajarOrigen(t)
console.log('bajarOrigen:', JSON.stringify(res, null, 1))

const { data: despues } = await a.from('ip_addresses').select('estado, onu_id').eq('id', ip.id).single()
console.log('ip después:', JSON.stringify(despues))

await a.from('traslados').delete().eq('cliente_id', cli.id)
await a.from('instalaciones').delete().eq('client_id', cli.id)
await a.from('clientes').update({onu_id:null}).eq('id', cli.id)
await a.from('clientes').delete().eq('id', cli.id)
await a.from('onus').delete().eq('id', u.id)
await a.from('ip_addresses').delete().eq('id', ip.id)
