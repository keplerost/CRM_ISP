import test from 'node:test'
import assert from 'node:assert/strict'

import { marcaDeCorte, programarCorteMora } from '../src/services/corteMora.js'

/**
 * El corte por mora, y la reconexión.
 *
 * Lo que decide QUIÉN se corta vive en las vistas y se prueba en el arnés de
 * migraciones con fechas de verdad. Acá se prueba lo que decide este archivo:
 * cómo se marca un corte para poder deshacerlo, y que los dos relojes —el diario
 * del corte y el frecuente de la reconexión— se armen y se cancelen bien.
 */

test('la marca del corte permite reconocer lo que hizo esta tarea', () => {
  /**
   * Es lo que después permite reconectar SOLO lo que cortó el automatismo. Un
   * corte por abuso o una suspensión pedida por el propio abonado no se pueden
   * deshacer porque su saldo llegó a cero: eso sería un automatismo deshaciendo
   * la decisión de una persona.
   */
  assert.match(marcaDeCorte(3), /^Corte por mora/)

  /**
   * El atraso se cuenta en DÍAS desde la 154.
   *
   * Antes se contaba en meses, y como el corte ahora cae en la fecha de corte de
   * cada abonado, el que se cortaba al día siguiente del vencimiento quedaba
   * anotado en el router como "0 meses de atraso" — visto en una corrida de
   * verdad contra FTTH LA MANÁ. Un comentario que no explica el motivo del corte
   * hace dudar de si el corte estuvo bien.
   */
  assert.equal(marcaDeCorte(1), 'Corte por mora · 1 día de atraso')
  assert.equal(marcaDeCorte(45), 'Corte por mora · 45 días de atraso')

  // Y el caso que dejaba el comentario vacío de sentido: sin dato, cero, no
  // "undefined días".
  assert.equal(marcaDeCorte(null), 'Corte por mora · 0 días de atraso')
  assert.equal(marcaDeCorte(undefined), 'Corte por mora · 0 días de atraso')
})

test('apagada no arma ningún reloj', () => {
  // Ni el del corte ni el de la reconexión: una tarea que ignora su interruptor
  // y corta gente igual es la peor falla posible en este archivo.
  const t = programarCorteMora({ activo: false })
  assert.equal(t, null)
})

test('encendida arma el reloj diario y el de la reconexión', async () => {
  let corridas = 0
  let reconexiones = 0

  const t = programarCorteMora({
    activo: true,
    hora: '00:00',
    cada_minutos: 1,
    intervaloMs: 10_000,
    ejecutar: async () => {
      corridas++
      return { cortados: [], reconectados: [], fallidos: [] }
    },
    ejecutarReconexion: async () => {
      reconexiones++
      return { reconectados: [], fallidos: [] }
    },
  })

  try {
    assert.ok(t, 'tiene que devolver el reloj diario para que se lo pueda cancelar')
    // La corrida diaria dispara al arrancar si ya pasó la hora, para recuperar
    // la que se perdió con el servidor caído.
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(corridas, 1)
  } finally {
    clearInterval(t)
    programarCorteMora({ activo: false })
  }
})

test('volver a programar no deja dos relojes de reconexión corriendo', () => {
  /**
   * `rearrancar` cancela el reloj que devuelve esta función, pero el de la
   * reconexión se guarda adentro del módulo. Sin cancelarlo, cada guardado en la
   * pantalla de tareas dejaría uno más vivo, y a la décima vez el router
   * recibiría diez consultas simultáneas cada diez minutos.
   *
   * Se comprueba de la única forma observable: que el proceso pueda terminar.
   * Los temporizadores llevan `unref`, así que uno colgado no lo impediría —
   * pero sí seguiría golpeando el equipo.
   */
  const opciones = {
    activo: true,
    hora: '00:00',
    cada_minutos: 1,
    intervaloMs: 10_000,
    ejecutar: async () => ({ cortados: [], reconectados: [], fallidos: [] }),
    ejecutarReconexion: async () => ({ reconectados: [], fallidos: [] }),
  }

  const primero = programarCorteMora(opciones)
  const segundo = programarCorteMora(opciones)

  assert.notEqual(primero, segundo, 'cada llamada arma su propio reloj diario')

  clearInterval(primero)
  clearInterval(segundo)
  // Apagarla cancela el de la reconexión, que es el que no devuelve.
  assert.equal(programarCorteMora({ activo: false }), null)
})
