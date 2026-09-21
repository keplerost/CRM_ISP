import test from 'node:test'
import assert from 'node:assert/strict'

import {
  aCSV,
  antiguedad,
  codigoLargo,
  enlace,
  filtrarAbonados,
  mesesDesde,
  nombreArchivo,
  seleccionarParaExportar,
  COLUMNAS_ABONADOS,
  COLUMNAS_POR_DEFECTO,
  necesitaCuentas,
  resumirCuentas,
  filtrarPorCampo,
  CAMPOS_FILTRO,
  filtrarPorColumnas,
  filtrosActivos,
} from '../../web/src/lib/abonados.js'

/**
 * El listado de abonados y el archivo de recuperación.
 *
 * Se prueba desde acá porque `abonados.js` no importa nada: es la misma razón
 * por la que `comisionesCalculo.js` se prueba con este mismo runner. Lo que se
 * verifica no es que la tabla se pinte, sino que la lista de a quién ir a
 * visitar sea la correcta — de eso dependen viajes y equipos que se recuperan o
 * se pierden.
 */

const EL_10_DE_AGOSTO = new Date('2026-08-10T12:00:00Z')

const abonado = (extra = {}) => ({
  id: crypto.randomUUID(),
  codigo: 1,
  nombre: 'Quien Sea',
  estado: 'activo',
  estado_desde: '2026-08-01T10:00:00Z',
  ...extra,
})

test('el código se lee con seis dígitos', () => {
  assert.equal(codigoLargo(1), '000001')
  assert.equal(codigoLargo(132), '000132')
  assert.equal(codigoLargo(null), '')
})

/**
 * Las fechas de las pruebas van a mediodía UTC a propósito.
 *
 * `mesesDesde` compara días del calendario LOCAL, que es lo correcto: quien
 * mira la pantalla cuenta los meses en su calendario, no en el de Greenwich.
 * Pero eso hace que un `T00:00:00Z` caiga el día anterior en Ecuador (UTC-5) y
 * la prueba mida otra cosa que la que dice medir. A mediodía las dos fechas
 * coinciden en cualquier huso de América.
 */
test('los meses son cumplidos, no redondeados', () => {
  // Un mes justo.
  assert.equal(mesesDesde('2026-07-10T12:00:00Z', EL_10_DE_AGOSTO), 1)
  // Un día antes de cumplirlo todavía es cero.
  assert.equal(mesesDesde('2026-07-11T12:00:00Z', EL_10_DE_AGOSTO), 0)
  assert.equal(mesesDesde('2026-05-10T12:00:00Z', EL_10_DE_AGOSTO), 3)
  assert.equal(mesesDesde(null, EL_10_DE_AGOSTO), null)
})

test('la antigüedad se dice en meses o en días, según cuál se entienda', () => {
  assert.equal(antiguedad('2026-06-10T12:00:00Z', EL_10_DE_AGOSTO), '2 meses')
  assert.equal(antiguedad('2026-07-10T12:00:00Z', EL_10_DE_AGOSTO), '1 mes')
  assert.equal(antiguedad('2026-08-08T12:00:00Z', EL_10_DE_AGOSTO), '2 días')
  assert.equal(antiguedad('2026-08-10T12:00:00Z', EL_10_DE_AGOSTO), 'hoy')
  assert.equal(antiguedad(null, EL_10_DE_AGOSTO), '—')
})

test('una fecha futura no da meses negativos', () => {
  assert.equal(mesesDesde('2026-12-01T12:00:00Z', EL_10_DE_AGOSTO), 0)
})

test('el filtro busca por lo que la gente tiene a mano en el teléfono', () => {
  const filas = [
    abonado({ nombre: 'Ana Pérez', identificacion: '1351570435', ip: '10.0.0.5' }),
    abonado({ codigo: 132, nombre: 'Luis Mora', identificacion: '0999999999' }),
  ]

  assert.equal(filtrarAbonados(filas, { busqueda: 'ana' }).length, 1)
  assert.equal(filtrarAbonados(filas, { busqueda: '135157' }).length, 1)
  assert.equal(filtrarAbonados(filas, { busqueda: '10.0.0.5' }).length, 1)
  // El ID se puede pegar tal como se lee en la pantalla o tal como se dice.
  assert.equal(filtrarAbonados(filas, { busqueda: '000132' })[0].nombre, 'Luis Mora')
  assert.equal(filtrarAbonados(filas, { busqueda: '132' })[0].nombre, 'Luis Mora')
})

test('los filtros se combinan y lo vacío no filtra', () => {
  const filas = [
    abonado({ nombre: 'A', estado: 'suspendido', zona: 'Centro', router_id: 'r1' }),
    abonado({ nombre: 'B', estado: 'suspendido', zona: 'La Maná', router_id: 'r1' }),
    abonado({ nombre: 'C', estado: 'activo', zona: 'Centro', router_id: 'r2' }),
  ]

  assert.equal(filtrarAbonados(filas, {}).length, 3)
  assert.equal(filtrarAbonados(filas, { estado: 'suspendido' }).length, 2)
  assert.equal(filtrarAbonados(filas, { estado: 'suspendido', zona: 'Centro' }).length, 1)
  assert.equal(filtrarAbonados(filas, { router: 'r1', zona: 'Centro' })[0].nombre, 'A')
})

test('por antigüedad salen los que llevan al menos esos meses, del más viejo primero', () => {
  const filas = [
    abonado({ nombre: 'Un mes', estado: 'suspendido', estado_desde: '2026-07-01T12:00:00Z' }),
    abonado({ nombre: 'Tres meses', estado: 'suspendido', estado_desde: '2026-05-01T12:00:00Z' }),
    abonado({ nombre: 'Ayer', estado: 'suspendido', estado_desde: '2026-08-09T12:00:00Z' }),
    abonado({ nombre: 'Activo viejo', estado: 'activo', estado_desde: '2025-01-01T00:00:00Z' }),
  ]

  const r = seleccionarParaExportar(
    filas,
    { modo: 'antiguedad', estado: 'suspendido', meses: 1 },
    EL_10_DE_AGOSTO,
  )

  assert.deepEqual(r.map((c) => c.nombre), ['Tres meses', 'Un mes'])
})

test('el activo no se cuela en la lista de suspendidos por más viejo que sea', () => {
  const filas = [abonado({ nombre: 'Fiel', estado: 'activo', estado_desde: '2020-01-01T00:00:00Z' })]
  const r = seleccionarParaExportar(filas, { estado: 'suspendido', meses: 0 }, EL_10_DE_AGOSTO)
  assert.equal(r.length, 0)
})

test('el rango de fechas incluye los dos extremos', () => {
  const filas = [
    abonado({ nombre: 'Antes', estado: 'cortado', estado_desde: '2026-05-31T23:00:00Z' }),
    abonado({ nombre: 'Primero', estado: 'cortado', estado_desde: '2026-06-01T08:00:00Z' }),
    abonado({ nombre: 'Último', estado: 'cortado', estado_desde: '2026-06-30T23:40:00Z' }),
    abonado({ nombre: 'Después', estado: 'cortado', estado_desde: '2026-07-01T01:00:00Z' }),
  ]

  const r = seleccionarParaExportar(filas, {
    modo: 'rango',
    estado: 'cortado',
    desde: '2026-06-01',
    hasta: '2026-06-30',
  })

  assert.deepEqual(r.map((c) => c.nombre), ['Primero', 'Último'])
})

test('un corte de las 23:40 no se corre al día siguiente por la zona horaria', () => {
  const filas = [abonado({ estado: 'cortado', estado_desde: '2026-06-30T23:40:00Z', nombre: 'Tarde' })]
  const r = seleccionarParaExportar(filas, {
    modo: 'rango',
    estado: 'cortado',
    desde: '2026-06-30',
    hasta: '2026-06-30',
  })
  assert.equal(r.length, 1)
})

test('sin fechas puestas el rango no descarta a nadie de ese estado', () => {
  const filas = [
    abonado({ estado: 'cortado', estado_desde: '2020-01-01T00:00:00Z' }),
    abonado({ estado: 'activo', estado_desde: '2020-01-01T00:00:00Z' }),
  ]
  assert.equal(
    seleccionarParaExportar(filas, { modo: 'rango', estado: 'cortado' }).length,
    1,
  )
})

test('el que nunca tuvo fecha de estado no entra en el export', () => {
  const filas = [abonado({ estado: 'suspendido', estado_desde: null })]
  assert.equal(seleccionarParaExportar(filas, { estado: 'suspendido', meses: 0 }).length, 0)
  assert.equal(
    seleccionarParaExportar(filas, { modo: 'rango', estado: 'suspendido' }).length,
    0,
  )
})

test('el CSV escapa lo que rompería las columnas en Excel', () => {
  const filas = [
    abonado({
      codigo: 7,
      nombre: 'Pérez; Juan',
      direccion: 'Av. "La Y", casa 3',
      estado: 'suspendido',
      estado_desde: '2026-06-10T12:00:00Z',
      saldo: 25.7,
    }),
  ]

  const csv = aCSV(filas, EL_10_DE_AGOSTO)
  const [encabezado, fila] = csv.split('\n')

  assert.ok(encabezado.startsWith('ID;Nombre;Cédula'))
  assert.ok(fila.includes('"Pérez; Juan"'))
  assert.ok(fila.includes('"Av. ""La Y"", casa 3"'))
  assert.ok(fila.includes('000007'))
  assert.ok(fila.includes('2 meses'))
  assert.ok(fila.includes('25.70'))
})

test('el archivo se llama como lo que trae adentro', () => {
  assert.equal(
    nombreArchivo({ modo: 'antiguedad', estado: 'suspendido', meses: 2 }, EL_10_DE_AGOSTO),
    'abonados-suspendido-2-meses-o-mas-2026-08-10.csv',
  )
  assert.equal(
    nombreArchivo(
      { modo: 'rango', estado: 'cortado', desde: '2026-06-01', hasta: '2026-06-30' },
      EL_10_DE_AGOSTO,
    ),
    'abonados-cortado-2026-06-01-a-2026-06-30.csv',
  )
})

test('el enlace solo se afirma cuando hay ONU de la que leerlo', () => {
  assert.equal(enlace({ onu_estado: 'online' }).color, 'verde')
  assert.equal(enlace({ onu_estado: 'offline' }).color, 'rojo')
  // Un abonado de radio no tiene ONU: no se inventa un estado.
  assert.equal(enlace({ onu_estado: null }), null)
  assert.equal(enlace({}), null)
})

// --- El catálogo de columnas -----------------------------------------------

test('todas las columnas devuelven texto, nunca undefined ni objetos', () => {
  // Un abonado pelado: es el caso que rompe una tabla, no el que está completo.
  const vacio = { id: 'x', nombre: 'Pelado' }

  for (const col of COLUMNAS_ABONADOS) {
    const v = col.texto(vacio, { cuentas: {}, ahora: EL_10_DE_AGOSTO })
    assert.equal(typeof v, 'string', `${col.clave} no devolvió texto`)
  }
})

test('las claves del catálogo no se repiten', () => {
  const claves = COLUMNAS_ABONADOS.map((c) => c.clave)
  assert.equal(new Set(claves).size, claves.length)
})

test('las que se ven por defecto son las principales, con el nombre entre ellas', () => {
  assert.ok(COLUMNAS_POR_DEFECTO.includes('nombre'))
  assert.ok(COLUMNAS_POR_DEFECTO.includes('codigo'))
  assert.ok(COLUMNAS_POR_DEFECTO.includes('zona'))
  // Las adicionales arrancan apagadas.
  assert.ok(!COLUMNAS_POR_DEFECTO.includes('coordenadas'))
  assert.ok(!COLUMNAS_POR_DEFECTO.includes('saldo_favor'))
})

test('las facturas solo se piden si hay alguna columna que las necesite', () => {
  assert.equal(necesitaCuentas(COLUMNAS_POR_DEFECTO), false)
  assert.equal(necesitaCuentas([...COLUMNAS_POR_DEFECTO, 'coordenadas']), false)
  assert.equal(necesitaCuentas([...COLUMNAS_POR_DEFECTO, 'proximo_pago']), true)
  assert.equal(necesitaCuentas(['total_cobrar']), true)
})

test('el resumen de cuenta saca el primer y el último vencimiento, y lo que está a favor', () => {
  const r = resumirCuentas({
    facturas: [
      { client_id: 'a', fecha_vencimiento: '2026-06-05' },
      { client_id: 'a', fecha_vencimiento: '2026-08-05' },
      { client_id: 'a', fecha_vencimiento: '2026-07-05' },
      { client_id: 'b', fecha_vencimiento: '2026-08-01' },
    ],
    cobrosSinImputar: [
      { client_id: 'a', monto: 10 },
      { client_id: 'a', monto: 5.5 },
    ],
  })

  assert.equal(r.a.proximo_vencimiento, '2026-06-05')
  assert.equal(r.a.ultimo_vencimiento, '2026-08-05')
  assert.equal(r.a.a_favor, 15.5)
  assert.equal(r.b.a_favor, 0)
})

test('el total a cobrar descuenta lo que el abonado ya tiene a favor', () => {
  const col = COLUMNAS_ABONADOS.find((c) => c.clave === 'total_cobrar')
  const ctx = { cuentas: { a: { a_favor: 15.5 } } }

  assert.equal(col.texto({ id: 'a', saldo: 40 }, ctx), '24.50')
  // Nunca negativo: quien tiene más a favor que deuda no "cobra" plata.
  assert.equal(col.texto({ id: 'a', saldo: 10 }, ctx), '0.00')
  assert.equal(col.texto({ id: 'sin-cuenta', saldo: 30 }, ctx), '30.00')
})

test('la fecha de suspensión solo se muestra si está suspendido', () => {
  const col = COLUMNAS_ABONADOS.find((c) => c.clave === 'fecha_suspendido')
  assert.equal(col.texto({ estado: 'suspendido', estado_desde: '2026-06-10T12:00:00Z' }), '2026-06-10')
  assert.equal(col.texto({ estado: 'cortado', estado_desde: '2026-06-10T12:00:00Z' }), '2026-06-10')
  assert.equal(col.texto({ estado: 'activo', estado_desde: '2026-06-10T12:00:00Z' }), '')
})

test('la fecha de retiro sale de la baja, y si no hay usa la del estado', () => {
  const col = COLUMNAS_ABONADOS.find((c) => c.clave === 'fecha_retirado')
  assert.equal(
    col.texto({ estado: 'baja', baja_en: '2026-03-02T00:00:00Z', estado_desde: '2026-05-01T00:00:00Z' }),
    '2026-03-02',
  )
  assert.equal(col.texto({ estado: 'baja', estado_desde: '2026-05-01T00:00:00Z' }), '2026-05-01')
  assert.equal(col.texto({ estado: 'activo', estado_desde: '2026-05-01T00:00:00Z' }), '')
})

test('de dónde cuelga el abonado: caja NAP si es fibra, emisor si es radio', () => {
  const nap = COLUMNAS_ABONADOS.find((c) => c.clave === 'caja_nap')
  const emisor = COLUMNAS_ABONADOS.find((c) => c.clave === 'emisor')

  const fibra = { nap: 'NAP-12', puerto_nap: '3', conectado_a: null }
  assert.equal(nap.texto(fibra), 'NAP-12 / 3')
  assert.equal(emisor.texto(fibra), '')

  const radio = { nap: null, puerto_nap: null, conectado_a: 'AP CERRO GRANDE' }
  assert.equal(nap.texto(radio), '')
  assert.equal(emisor.texto(radio), 'AP CERRO GRANDE')
})

// --- El filtro por campo ---------------------------------------------------

test('el filtro por campo compara contra lo que se ve en la tabla', () => {
  const filas = [
    { id: 'a', codigo: 132, nombre: 'Ana', dia_facturacion: 5, ip: '10.0.0.15' },
    { id: 'b', codigo: 7, nombre: 'Beto', dia_facturacion: 15, ip: '10.0.0.5' },
  ]

  // El ID se ve "000132" aunque en la base sea el número 132.
  assert.equal(filtrarPorCampo(filas, { campo: 'codigo', valor: '000132' })[0].nombre, 'Ana')

  // Y filtrar por Día pago no arrastra a quien tiene un 5 en la IP, que es
  // exactamente lo que sí hace el buscador general.
  const porDia = filtrarPorCampo(filas, { campo: 'dia_pago', valor: '5' })
  assert.deepEqual(porDia.map((c) => c.nombre), ['Ana'])
  assert.equal(filtrarAbonados(filas, { busqueda: '5' }).length, 2)
})

test('un filtro a medio llenar no vacía la pantalla', () => {
  const filas = [{ id: 'a', nombre: 'Ana' }, { id: 'b', nombre: 'Beto' }]

  assert.equal(filtrarPorCampo(filas, { campo: '', valor: 'ana' }).length, 2)
  assert.equal(filtrarPorCampo(filas, { campo: 'nombre', valor: '' }).length, 2)
  assert.equal(filtrarPorCampo(filas, { campo: 'nombre', valor: '   ' }).length, 2)
  assert.equal(filtrarPorCampo(filas, {}).length, 2)
  // Un campo que no existe tampoco puede esconder a nadie.
  assert.equal(filtrarPorCampo(filas, { campo: 'inventado', valor: 'x' }).length, 2)
})

test('el filtro no distingue mayúsculas y busca por partes', () => {
  const filas = [{ id: 'a', nombre: 'JEFFERSON FABIAN OÑA' }]
  assert.equal(filtrarPorCampo(filas, { campo: 'nombre', valor: 'fabian' }).length, 1)
  assert.equal(filtrarPorCampo(filas, { campo: 'nombre', valor: 'OÑA' }).length, 1)
  assert.equal(filtrarPorCampo(filas, { campo: 'nombre', valor: 'perez' }).length, 0)
})

test('los campos que se ofrecen para filtrar son los que la tabla muestra por defecto', () => {
  const claves = CAMPOS_FILTRO.map((c) => c.clave)
  assert.deepEqual(claves, COLUMNAS_POR_DEFECTO)
  for (const esperado of ['codigo', 'nombre', 'direccion', 'ip', 'mac', 'dia_pago', 'deuda',
                          'correo', 'plan', 'movil', 'router', 'cedula', 'zona', 'estatus']) {
    assert.ok(claves.includes(esperado), `falta ${esperado} entre los filtrables`)
  }
})

// --- Las casillas debajo de cada columna -----------------------------------

test('varias columnas filtran a la vez, no una o la otra', () => {
  const filas = [
    { id: 'a', nombre: 'Ana', zona: 'Centro', ip: '10.0.0.5' },
    { id: 'b', nombre: 'Beto', zona: 'Centro', ip: '192.168.1.5' },
    { id: 'c', nombre: 'Caro', zona: 'La Maná', ip: '10.0.0.9' },
  ]

  const r = filtrarPorColumnas(filas, { zona: 'centro', ip: '10.0' })
  assert.deepEqual(r.map((c) => c.nombre), ['Ana'])
})

test('una casilla vacía no filtra, y una columna inventada tampoco', () => {
  const filas = [{ id: 'a', nombre: 'Ana' }, { id: 'b', nombre: 'Beto' }]

  assert.equal(filtrarPorColumnas(filas, {}).length, 2)
  assert.equal(filtrarPorColumnas(filas, { nombre: '' }).length, 2)
  assert.equal(filtrarPorColumnas(filas, { nombre: '  ' }).length, 2)
  assert.equal(filtrarPorColumnas(filas, { inventada: 'x' }).length, 2)
  assert.equal(filtrarPorColumnas(filas, { nombre: 'ana', inventada: 'x' }).length, 1)
})

test('cada columna conserva su forma de comparar', () => {
  const filas = [
    { id: 'a', nombre: 'Ana', dia_facturacion: 5 },
    { id: 'b', nombre: 'Beto', dia_facturacion: 15 },
  ]
  // Día pago sigue siendo exacto también acá.
  assert.deepEqual(
    filtrarPorColumnas(filas, { dia_pago: '5' }).map((c) => c.nombre),
    ['Ana'],
  )
  // Y el nombre sigue buscando por partes.
  assert.equal(filtrarPorColumnas(filas, { nombre: 'et' })[0].nombre, 'Beto')
})

test('la cuenta de filtros activos ignora las columnas apagadas', () => {
  const puestos = { zona: 'centro', coordenadas: '-0.9' }

  // Las dos a la vista.
  assert.equal(filtrosActivos(puestos, ['zona', 'coordenadas']), 2)
  // Coordenadas apagada: su casilla ya no cuenta.
  assert.equal(filtrosActivos(puestos, ['zona']), 1)
  assert.equal(filtrosActivos({ zona: '   ' }, ['zona']), 0)
  assert.equal(filtrosActivos({}, ['zona']), 0)
})

test('apagar una columna deja de filtrar por ella', () => {
  // Es lo que evita la lista recortada por algo que ya no se ve. La pantalla
  // solo le pasa a `filtrarPorColumnas` las casillas de columnas visibles.
  const filas = [
    { id: 'a', nombre: 'Ana', zona: 'Centro' },
    { id: 'b', nombre: 'Beto', zona: 'La Maná' },
  ]
  const puestos = { zona: 'centro' }
  const soloVisibles = (visibles) =>
    Object.fromEntries(Object.entries(puestos).filter(([k]) => visibles.includes(k)))

  assert.equal(filtrarPorColumnas(filas, soloVisibles(['zona'])).length, 1)
  assert.equal(filtrarPorColumnas(filas, soloVisibles(['nombre'])).length, 2)
})
