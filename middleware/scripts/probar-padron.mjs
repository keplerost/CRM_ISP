import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { revisar } from '../src/services/migracionAbonados.js'

/**
 * Probar el archivo del sistema anterior SIN importar nada.
 *
 *     node scripts/probar-padron.mjs "C:\\ruta\\padron.xlsx"
 *
 * ── Para qué ──
 *
 * Para poder mirar el padrón entero antes de tocar la base. La pantalla hace lo
 * mismo, pero desde acá se ve el archivo completo de un saque y queda por
 * escrito qué se entendió de cada columna — que es lo que hay que revisar con
 * calma, no apurado adelante de un botón de importar.
 *
 * No escribe absolutamente nada: solo lee el archivo y consulta los planes y las
 * ONUs que ya existen para poder decir qué va a pasar.
 */

const ruta = process.argv[2]
if (!ruta) {
  console.error('Falta el archivo.\n\n  node scripts/probar-padron.mjs "C:\\ruta\\padron.xlsx"\n')
  process.exit(1)
}

const sistema = process.argv[3] ?? 'importado'
const bytes = readFileSync(ruta)

console.log(`\nArchivo: ${basename(ruta)} (${Math.round(bytes.length / 1024)} KB)`)
console.log(`Sistema de origen: ${sistema}\n`)

const r = await revisar({
  archivo: { nombre: basename(ruta), base64: bytes.toString('base64') },
  sistema_origen: sistema,
})

const linea = (t) => console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`)

linea('CÓMO SE ENTENDIÓ CADA COLUMNA')
for (const [campo, columna] of Object.entries(r.mapa)) {
  console.log(`  ${campo.padEnd(20)} ←  ${columna}`)
}
if (r.sin_reconocer.length) {
  console.log('\n  No se reconocieron (no se van a importar):')
  console.log(`  ${r.sin_reconocer.join(', ')}`)
}

linea('QUÉ VA A PASAR')
const s = r.resumen
console.log(`  ${s.total} filas · se crean ${s.se_crean} · se actualizan ${s.se_actualizan}`)
if (s.con_problemas) console.log(`  ${s.con_problemas} NO se importan por problemas`)
if (s.con_deuda) console.log(`  ${s.con_deuda} con deuda, $${s.deuda_total} en total`)
if (s.a_favor) console.log(`  ${s.a_favor} con saldo a favor (no se importa)`)
if (s.con_onu) console.log(`  ${s.con_onu} quedan enganchados con su ONT`)

// Lo que no se puede reconstruir después de migrar va aparte y al final, que es
// donde se mira.
if (s.sin_instalacion || s.sin_ultimo_pago || s.serie_sin_onu) {
  linea('LO QUE CONVIENE ARREGLAR EN LA PLANILLA ANTES DE IMPORTAR')
  if (s.sin_instalacion) {
    console.log(`  ${s.sin_instalacion} sin fecha de instalación`)
    console.log('     Esa antigüedad no se recupera después.')
  }
  if (s.sin_ultimo_pago) {
    console.log(`  ${s.sin_ultimo_pago} sin fecha de último pago`)
    console.log('     Van a contar como morosos desde que se instalaron, y la')
    console.log('     cartera les abre orden de retiro la primera noche.')
  }
  if (s.serie_sin_onu) {
    console.log(`  ${s.serie_sin_onu} con una serie de ONT que no está en la OLT`)
    console.log('     Quedan sin equipo asociado; hay que vincularlos a mano.')
  }
}

const paraMirar = r.filas.filter((f) => f.problemas.length || f.avisos.length)
if (paraMirar.length) {
  linea(`FILA POR FILA (${paraMirar.length} para mirar)`)
  for (const f of paraMirar) {
    console.log(`\n  L${f.fila}  ${f.nombre || '(sin nombre)'}  [${f.codigo_externo ?? 'sin código'}]`)
    for (const p of f.problemas) console.log(`      NO SE IMPORTA: ${p}`)
    for (const a of f.avisos) console.log(`      aviso: ${a}`)
  }
}

console.log('\nNo se escribió nada en la base.\n')
