import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarSesionCli } from '../src/drivers/vsol.js'

/**
 * El login que la V-SOL pide DENTRO del shell SSH.
 *
 * Autenticarse por SSH no deja en la CLI: deja en una segunda puerta del propio
 * equipo. Y esa puerta no siempre se presenta igual — a veces pide usuario y
 * contraseña, y a veces solo la contraseña, porque el usuario ya viajó en la
 * autenticación SSH.
 *
 * Suponer el orden en lugar de mirarlo dejaba la contraseña escrita en el prompt
 * "Login:", que hace eco: quedaba en claro en la salida, en los logs y en
 * cualquier transcripción. Estos tests existen sobre todo para eso.
 */

/** Sesión de mentira que responde según un guion, y anota qué se le mandó. */
function sesionFalsa(guion) {
  const enviado = []
  let paso = 0
  return {
    enviado,
    async run(comando) {
      enviado.push(comando)
      return guion[paso++] ?? ''
    },
  }
}

const OLT = { usuario: 'admin', password: 'Secreta123#' }

describe('login dentro del shell', () => {
  test('cuando el equipo pide usuario y contraseña, los manda en ese orden', () => {
    const s = sesionFalsa(['\nLogin: ', '\nPassword: ', '\nOLT>'])
    return iniciarSesionCli(s, OLT).then(() => {
      assert.deepEqual(s.enviado, ['', 'admin', 'Secreta123#'])
    })
  })

  test('cuando arranca pidiendo SOLO la contraseña, no manda el usuario', async () => {
    // Es el caso real de la PROGRESO: el usuario ya viajó en el SSH y el equipo
    // pide directamente la contraseña. Mandando el usuario primero, se lo tomaba
    // como contraseña equivocada.
    const s = sesionFalsa(['\nPassword: ', '\nOLT>'])
    await iniciarSesionCli(s, OLT)
    assert.deepEqual(s.enviado, ['', 'Secreta123#'])
    assert.ok(!s.enviado.includes('admin'), 'mandó el usuario donde iba la contraseña')
  })

  test('NUNCA manda la contraseña a un prompt de usuario', async () => {
    // El prompt "Login:" hace eco. Una contraseña escrita ahí queda en claro en
    // la salida del equipo, y de ahí a los logs y a cualquier diagnóstico.
    const s = sesionFalsa(['\nLogin: ', '\nLogin: '])
    await iniciarSesionCli(s, OLT).catch(() => {})

    // Lo enviado tras ver "Login:" tiene que ser el usuario, nunca la clave.
    for (let i = 0; i < s.enviado.length; i++) {
      if (i > 0) assert.notEqual(s.enviado[i], OLT.password, `paso ${i}`)
    }
  })

  test('si la sesión ya estaba adentro, no manda credenciales', async () => {
    const s = sesionFalsa(['\nOLT(config)#'])
    await iniciarSesionCli(s, OLT)
    assert.deepEqual(s.enviado, [''])
  })

  test('un rechazo se reporta como tal y no como sesión cerrada', async () => {
    // Antes, un rechazo dejaba la sesión alimentando intentos fallidos hasta que
    // el equipo cortaba, y el síntoma visible era "la OLT cerró la sesión" —
    // que manda a buscar el problema a las sesiones simultáneas.
    const s = sesionFalsa(['\nPassword: ', '\nBad UserName or Bad Password , Login Failed.\n\nLogin: '])
    await assert.rejects(() => iniciarSesionCli(s, OLT), /rechazó la contraseña/i)
  })

  test('volver a ver el prompt de contraseña también es un rechazo', async () => {
    const s = sesionFalsa(['\nPassword: ', '\nPassword: '])
    await assert.rejects(() => iniciarSesionCli(s, OLT), /rechazó la contraseña/i)
  })

  test('un usuario rechazado se distingue de una contraseña rechazada', async () => {
    const s = sesionFalsa(['\nLogin: ', '\nBad UserName or Bad Password , Login Failed.\n\nLogin: '])
    await assert.rejects(() => iniciarSesionCli(s, OLT), /rechazó el usuario/i)
  })

  test('el aviso menciona el código de verificación', async () => {
    // Es la causa real más frecuente y no se deduce del mensaje del equipo: se
    // ve un rechazo de contraseña cuando lo que falta es un código.
    const s = sesionFalsa(['\nPassword: ', '\nLogin: '])
    await iniciarSesionCli(s, OLT).catch((e) => {
      assert.match(e.hint, /código de verificación/i)
    })
  })
})
