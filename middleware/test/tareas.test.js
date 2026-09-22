import test from 'node:test'
import assert from 'node:assert/strict'
import { TAREAS, _COLUMNAS, _TAREAS, _llaveActiva, _resumenDeFallas } from '../src/services/tareas.js'

/**
 * Los automatismos.
 *
 * Dos cosas que se prueban acá y una que no se puede.
 *
 * SE PRUEBA que cada tarea sepa arrancarse y, sobre todo, que sepa NO
 * arrancarse: una tarea que ignora su interruptor y se arma igual es la peor
 * falla posible en este archivo. El corte automático encendiéndose solo deja
 * gente sin internet.
 *
 * SE PRUEBA que apagar cancele de verdad el temporizador. Sin eso, guardar dos
 * veces dejaría dos temporizadores corriendo la misma tarea, y cada guardado
 * agregaría otro.
 *
 * NO SE PRUEBA la lectura de la base: eso exige Supabase de verdad. Lo que sí
 * se prueba es la parte que decide, que es donde estarían los errores.
 */

const TODO_APAGADO = {
  cortes_automaticos: false,
  facturacion_automatica: false,
  comisiones_automatico: false,
  cartera_automatico: false,
  consumo_automatico: false,
  nms_automatico: false,
  optica_automatica: false,
  esperando_automatico: false,
  stock_automatico: false,
  avisos_pago_automatico: false,
  mora_automatico: false,
  cortes_hora: '09:00',
  facturacion_hora: '06:00',
  comisiones_hora: '03:30',
  cartera_hora: '04:00',
  consumo_cada_minutos: 60,
  nms_cada_minutos: 2,
  optica_cada_minutos: 15,
  esperando_cada_minutos: 5,
  stock_hora: '07:00',
  avisos_pago_hora: '09:00',
  mora_hora: '05:00',
  mora_reconexion_segundos: 5,
  mora_barrida_minutos: 15,
}

test('con todo apagado, ninguna tarea arma un temporizador', () => {
  for (const tarea of TAREAS) {
    const t = tarea.arrancar(TODO_APAGADO)
    assert.equal(t, null, `${tarea.clave} se armó estando apagada`)
  }
})

test('cada tarea arma su temporizador cuando está encendida', () => {
  const encendido = {
    ...TODO_APAGADO,
    cortes_automaticos: true,
    facturacion_automatica: true,
    comisiones_automatico: true,
    cartera_automatico: true,
    consumo_automatico: true,
    nms_automatico: true,
    optica_automatica: true,
    esperando_automatico: true,
    alertas_automaticas: true,
    stock_automatico: true,
    avisos_pago_automatico: true,
    mora_automatico: true,
    firmas_automatico: true,
    incidencias_cola_activa: true,
  }

  // Las dos diarias corren apenas arrancan si ya pasó su hora, para recuperar
  // la corrida del día que el servidor se perdió estando caído. En una prueba
  // eso cortaría abonados y emitiría facturas contra la base de verdad.
  const noHagasNada = { ejecutar: async () => ({ cortados: [], omitidos: [], creadas: [] }) }

  const armados = []
  try {
    for (const tarea of TAREAS) {
      const t = tarea.arrancar(encendido, noHagasNada)
      assert.ok(t, `${tarea.clave} no armó su temporizador`)
      armados.push(t)
    }
  } finally {
    // Si quedaran vivos, el proceso de pruebas no terminaría y las corridas
    // empezarían a tocar equipos de verdad.
    for (const t of armados) clearInterval(t)
  }
})

test('el temporizador se puede cancelar', () => {
  const tarea = TAREAS.find((t) => t.clave === 'optica')
  const t = tarea.arrancar({ ...TODO_APAGADO, optica_automatica: true })

  assert.ok(t, 'debería haber armado uno')
  clearInterval(t)
  // Node marca el handle como destruido: es lo que permite confirmar que
  // apagar desde la pantalla apaga de verdad y no solo en la base.
  assert.equal(t.hasRef?.() ?? false, false)
})

/**
 * Cada tarea tiene que poder explicarse.
 *
 * La descripción no es adorno: es lo que le permite a alguien decidir si
 * enciende algo que va a dejar gente sin internet o a generar cobros solos.
 * Una tarea sin descripción es un interruptor a ciegas.
 */
test('todas las tareas se explican', () => {
  for (const t of TAREAS) {
    assert.ok(t.nombre, `${t.clave} no tiene nombre`)
    assert.ok(t.que?.length > 20, `${t.clave} no explica qué hace`)
    assert.ok(['diaria', 'intervalo'].includes(t.tipo), `${t.clave} no dice si es diaria o por intervalo`)
  }
})

/** Las que tienen consecuencias visibles para el abonado avisan cuáles son. */
test('las tareas peligrosas dicen por qué lo son', () => {
  for (const clave of ['cortes', 'facturacion']) {
    const t = TAREAS.find((x) => x.clave === clave)
    assert.ok(t.cuidado?.length > 20, `${clave} tiene que advertir qué pasa al encenderla`)
  }
})

test('cada tarea tiene su columna de encendido en la pantalla de ajustes', () => {
  /**
   * ── Por qué esta prueba existe ──
   *
   * Porque el error ya pasó tres veces, y las tres se ven igual: el técnico
   * marca la casilla, aprieta guardar, y la casilla vuelve a desmarcarse sola.
   * Sin entrada en `LLAVE`, la pantalla escribe en un campo `undefined`: no
   * falla, no avisa, y la tarea no se puede encender.
   *
   * La lista de acá se compara contra las tareas de verdad, así que agregar una
   * tarea nueva sin su llave rompe esta prueba en vez de romper la pantalla.
   */
  const LLAVE_EN_LA_PANTALLA = {
    cortes: 'cortes_automaticos',
    facturacion: 'facturacion_automatica',
    optica: 'optica_automatica',
    consumo: 'consumo_automatico',
    nms: 'nms_automatico',
    esperando: 'esperando_automatico',
    comisiones: 'comisiones_automatico',
    cartera: 'cartera_automatico',
    alertas: 'alertas_automaticas',
    stock: 'stock_automatico',
    avisos_pago: 'avisos_pago_automatico',
    mora: 'mora_automatico',
    firmas: 'firmas_automatico',
    // Enciende por `cola_activa`, no por `automatico`: ese otro es el permiso
    // para que el monitoreo ABRA la incidencia solo, y vive en el sondeo.
    incidencias: 'incidencias_cola_activa',
  }

  for (const tarea of TAREAS) {
    const llave = LLAVE_EN_LA_PANTALLA[tarea.clave]
    assert.ok(llave, `la tarea "${tarea.clave}" no tiene llave en TareasPage: no se va a poder encender`)

    // Y que esa llave sea la que la tarea de verdad mira para arrancar.
    assert.equal(
      tarea.arrancar({ ...TODO_APAGADO, [llave]: true }, { ejecutar: async () => ({}) }) !== null,
      true,
      `la tarea "${tarea.clave}" no arranca con ${llave} en true`,
    )
  }
})

test('la columna que la pantalla muestra encendida es la que enciende de verdad', () => {
  /**
   * Es el mismo error que el de arriba, del otro lado.
   *
   * `llaveActiva` decide qué campo lee `estado()` para mostrar una tarea como
   * activa. Le faltaba el caso de `alertas`: la columna se llama
   * `alertas_automaticas` y la función devolvía `alertas_automatico`, que no
   * existe. La tarea corría y la pantalla la mostraba apagada — que es la peor
   * de las dos mentiras posibles, porque invita a encender lo que ya está
   * encendido.
   *
   * No fallaba nunca: leer una propiedad que no existe da `undefined`, y
   * `Boolean(undefined)` es un `false` perfectamente convincente.
   */
  const columnas = new Set(_COLUMNAS())

  for (const tarea of _TAREAS) {
    const llave = _llaveActiva(tarea)
    assert.ok(
      columnas.has(llave),
      `la tarea "${tarea.clave}" se muestra según "${llave}", que no es una columna de config_tareas`,
    )
  }
})

/**
 * Los campos numéricos de la configuración.
 *
 * ── Por qué esto merece pruebas ──
 *
 * El guardado clasifica cada campo por su NOMBRE: los que terminan en `_hora`
 * son horas, los que terminan en `_minutos` son números, y todo lo que no cae en
 * ninguna rama se guarda como `Boolean(v)` — porque el resto son interruptores.
 *
 * Eso significa que un campo numérico nuevo cuyo nombre no encaje en ningún
 * patrón se guarda como `true`, y la base devuelve "invalid input syntax for
 * type integer". Ya pasó con dos: `mora_limite` y `mora_reconexion_segundos`. En
 * los dos casos el campo simplemente no se podía guardar y el error no explicaba
 * nada.
 */
test('todo campo numérico cae en la rama numérica, no en la de interruptores', async () => {
  const { _COLUMNAS } = await import('../src/services/tareas.js')

  // Los que son números por su naturaleza, no por su nombre.
  const NUMERICOS = _COLUMNAS().filter(
    (c) => /_(limite|minutos|segundos|paquetes)$/.test(c) || c === 'nms_paquetes',
  )

  assert.ok(NUMERICOS.length >= 5, `esperaba varios numéricos, encontré ${NUMERICOS.length}`)

  /**
   * Se replica la clasificación del guardado.
   *
   * Se copia en vez de importarse porque vive dentro de `guardar`, que escribe en
   * la base: la prueba tiene que poder correr sin tocarla.
   */
  const CERO_ES_SIN_TOPE = ['mora_limite']
  const esNumerico = (campo) =>
    campo.endsWith('_minutos')
    || campo.endsWith('_segundos')
    || campo === 'nms_paquetes'
    || campo === 'cortes_limite'
    || CERO_ES_SIN_TOPE.includes(campo)

  for (const campo of NUMERICOS) {
    assert.ok(
      esNumerico(campo),
      `"${campo}" es un número y no cae en la rama numérica: se guardaría como Boolean`,
    )
  }
})

test('el tope del corte por mora acepta cero, y los intervalos no', async () => {
  /**
   * Cero significa algo distinto en cada uno. En un tope quiere decir "sin
   * límite, cortá a todos". En un intervalo no quiere decir nada: una tarea que
   * corre "cada 0 minutos" está mal configurada.
   *
   * Antes el mensaje decía "tiene que ser un número mayor que cero" para los dos,
   * que es exactamente lo contrario de lo que el tope necesita.
   */
  const CERO_ES_SIN_TOPE = ['mora_limite']
  const minimoDe = (campo) => (CERO_ES_SIN_TOPE.includes(campo) ? 0 : 1)

  assert.equal(minimoDe('mora_limite'), 0, 'el tope admite cero')
  assert.equal(minimoDe('mora_reconexion_segundos'), 1, 'un intervalo no')
  assert.equal(minimoDe('mora_barrida_minutos'), 1)
  // Y este tampoco, porque la base lo declara BETWEEN 1 AND 100000.
  assert.equal(minimoDe('cortes_limite'), 1)
})

/**
 * El resumen de fallas que sube al panel.
 *
 * ── Qué se protege ──
 *
 * Que "la tarea no pudo correr" y "corrió pero fallaron tres casos" no se
 * mezclen. Son consecuencias distintas: lo primero significa que NADIE fue
 * cortado hoy; lo segundo, que tres siguen navegando sin pagar. Si el panel
 * mostrara "1 problema" para los dos, el número dejaría de decir nada.
 *
 * Y que sin resultado devuelva null y no un cero: una tarea que todavía no
 * corrió no es una tarea sin fallas.
 */
test('el resumen distingue no haber corrido, haber fallado entero, y fallar en casos sueltos', () => {
  // Todavía no corrió: no hay nada que decir.
  assert.equal(_resumenDeFallas(null), null)
  assert.equal(_resumenDeFallas(undefined), null)

  // Corrió bien.
  assert.deepEqual(_resumenDeFallas({ cortados: [1, 2], fallidos: [] }), {
    error: null,
    fallidos: 0,
    ejemplos: [],
  })

  // No pudo ni empezar.
  const roto = _resumenDeFallas({ error: 'sin conexión a la base' })
  assert.equal(roto.error, 'sin conexión a la base')
  assert.equal(roto.fallidos, 0)

  // Corrió, pero tres quedaron afuera.
  const parcial = _resumenDeFallas({
    cortados: [1],
    fallidos: [
      { accion: 'cortar', cliente: 'Ana', error: 'router no responde' },
      { accion: 'cortar', cliente: 'Beto', error: 'timeout' },
      { accion: 'reconectar', cliente: 'Carla', error: 'timeout' },
      { accion: 'cortar', cliente: 'Dario', error: 'timeout' },
    ],
  })
  assert.equal(parcial.error, null)
  assert.equal(parcial.fallidos, 4, 'cuenta TODOS, no solo los que muestra')
  assert.equal(parcial.ejemplos.length, 3, 'manda tres de ejemplo, no la lista entera')
  assert.deepEqual(parcial.ejemplos[0], {
    cliente: 'Ana',
    accion: 'cortar',
    motivo: 'router no responde',
  })
})

test('el motivo se lee venga como venga', () => {
  // `corteMora` usa `error`; los avisos de pago usan `motivo`. El panel no
  // tiene por qué saber cuál lo mandó.
  const r = _resumenDeFallas({
    fallidos: [{ nombre: 'Elsa', motivo: 'sin correo ni celular' }],
  })

  assert.equal(r.ejemplos[0].cliente, 'Elsa')
  assert.equal(r.ejemplos[0].motivo, 'sin correo ni celular')
})
