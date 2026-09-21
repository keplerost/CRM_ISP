import test from 'node:test'
import assert from 'node:assert/strict'

import { SshSession } from '../src/lib/sshSession.js'
import { volverAlInicio as volverVsol } from '../src/drivers/vsol.js'
import { volverAlInicio as volverHuawei } from '../src/drivers/huawei.js'

/**
 * La sesión SSH reutilizada entre operaciones.
 *
 * Antes cada acción abría su propio login: escanear un puerto, leer la potencia
 * y registrar una ONU eran tres entradas y tres salidas seguidas en el registro
 * del equipo. En una OLT que admite tres sesiones eso deja al operador a un paso
 * del "exceed max sessions".
 *
 * Reutilizar la sesión tiene un riesgo propio que estas pruebas cubren: la CLI
 * es con estado —enable → config → interface gpon 0/1— y una sesión que quedó
 * dentro de un puerto ejecutaría los comandos siguientes ahí adentro, sin que
 * nada lo delate.
 */

/** Una sesión de mentira que solo anota lo que le mandaron. */
function sesionFalsa() {
  const comandos = []
  return {
    comandos,
    run: async (c) => {
      comandos.push(c)
      return ''
    },
  }
}

// --- Volver al punto de partida ----------------------------------------------

test('V-SOL vuelve con un solo comando', () => {
  const s = sesionFalsa()
  volverVsol(s)
  assert.deepEqual(s.comandos, ['end'])
})

test('V-SOL no usa una cadena de exit', () => {
  // `end` sale de cualquier submodo de una vez. Con `exit` habría que contar los
  // niveles, y uno de más en el nivel superior CIERRA la sesión: justo lo que
  // este pooling viene a evitar.
  const s = sesionFalsa()
  volverVsol(s)
  assert.ok(!s.comandos.includes('exit'), s.comandos.join(' '))
})

test('Huawei sube exactamente dos niveles', async () => {
  // interfaz → config → privilegiado. Ni uno más: en el nivel de usuario `quit`
  // cierra la sesión.
  const s = sesionFalsa()
  await volverHuawei(s)
  assert.deepEqual(s.comandos, ['quit', 'quit'])
})

test('Huawei no manda un tercer quit', async () => {
  // Es la prueba que protege la decisión: un `quit` de más deja al middleware
  // creyendo que tiene sesión mientras el equipo ya la cerró, y la siguiente
  // operación falla con un error que no se parece a la causa.
  const s = sesionFalsa()
  await volverHuawei(s)
  assert.equal(s.comandos.length, 2, `mandó ${s.comandos.length}: ${s.comandos.join(' ')}`)
})

// --- Cuándo una sesión sirve para otra operación -----------------------------

test('una sesión sin stream no está viva', () => {
  const s = new SshSession({ host: '10.0.0.1', username: 'x', password: 'y' })
  assert.equal(s.viva(), false, 'recién construida no tiene canal')
})

test('una sesión con error de sesión no se reutiliza', () => {
  // El equipo cortó por inactividad o se cayó el enlace. Reutilizarla haría que
  // el comando espere el timeout completo antes de fallar.
  const s = new SshSession({ host: '10.0.0.1', username: 'x', password: 'y' })
  s.stream = { destroyed: false }
  assert.equal(s.viva(), true)

  s.errorSesion = new Error('La OLT cerró la sesión')
  assert.equal(s.viva(), false)
})

test('una sesión con el canal destruido no se reutiliza', () => {
  const s = new SshSession({ host: '10.0.0.1', username: 'x', password: 'y' })
  s.stream = { destroyed: true }
  assert.equal(s.viva(), false)
})
