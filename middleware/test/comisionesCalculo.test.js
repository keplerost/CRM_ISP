import test from 'node:test'
import assert from 'node:assert/strict'

// Se importa del frontend a propósito, con ruta relativa.
//
// La cuenta que decide cuánto cobra un vendedor vive en el navegador —la
// pantalla la necesita mientras alguien edita los porcentajes— y el único
// ejecutor de pruebas del proyecto está acá. La alternativa era agregarle a la
// web su propio runner y su dependencia, para probar dos archivos sin un solo
// import. Esto es más raro de leer y bastante más difícil de dejar sin correr.
//
// Los dos archivos son ESM puro y no importan nada: si alguien les mete un
// `import` de Supabase, esta prueba falla al cargar y avisa.
import { calcular, siguienteNivel, proyeccion } from '../../web/src/lib/comisionesCalculo.js'
import { basePromedio, bonoDe, simular } from '../../web/src/lib/simulador.js'

/**
 * El único lugar del sistema donde una multiplicación es plata de otra persona.
 *
 * ── Qué se verifica y contra qué ──
 *
 * Contra los ejemplos escritos en el requerimiento, no contra lo que hoy
 * devuelve el código. Es la diferencia entre una prueba que comprueba y una que
 * fotografía: si mañana alguien cambia el redondeo, esto tiene que fallar.
 *
 * Los números del documento:
 *
 *   · base comisionable promedio $14,60 · 25 ventas · nivel Oro 40 %  →  $146
 *   · 26 ventas · Platino 45 % (retroactivo, sobre las 26)            →  $170,82
 *   · el incremento entre los dos                                    →  +$30,66
 *   · cohorte de 25 con 23 conservados = 92 %                         →  bono $40
 *
 * ── Lo que estas pruebas NO pueden verificar ──
 *
 * Que la base dé lo mismo. Eso necesita Postgres y se comprueba con
 * `verificar_comisiones()`, que recalcula cada período cerrado con el motor y
 * avisa si alguno no cuadra. Acá se fija la referencia; allá se compara.
 */

// El esquema del requerimiento, tal como lo carga la migración 97.
const NIVELES = [
  { orden: 1, nombre: 'Inicial', desde_ventas: 1, hasta_ventas: 10, porcentaje: 20 },
  { orden: 2, nombre: 'Bronce', desde_ventas: 11, hasta_ventas: 15, porcentaje: 30 },
  { orden: 3, nombre: 'Plata', desde_ventas: 16, hasta_ventas: 20, porcentaje: 35 },
  { orden: 4, nombre: 'Oro', desde_ventas: 21, hasta_ventas: 25, porcentaje: 40 },
  { orden: 5, nombre: 'Platino', desde_ventas: 26, hasta_ventas: 30, porcentaje: 45 },
  { orden: 6, nombre: 'Élite', desde_ventas: 31, hasta_ventas: null, porcentaje: 50 },
]

const BONOS = [
  { orden: 1, desde_pct: 0, hasta_pct: 69.99, monto: 0 },
  { orden: 2, desde_pct: 70, hasta_pct: 79.99, monto: 10 },
  { orden: 3, desde_pct: 80, hasta_pct: 84.99, monto: 20 },
  { orden: 4, desde_pct: 85, hasta_pct: 89.99, monto: 30 },
  { orden: 5, desde_pct: 90, hasta_pct: 94.99, monto: 40 },
  { orden: 6, desde_pct: 95, hasta_pct: 100, monto: 50 },
]

const ESQUEMA = { niveles: NIVELES, modo: 'retroactivo' }

// Redondeo a centavos, que es la unidad en la que se paga.
const cent = (n) => Math.round(n * 100) / 100

// --- El ejemplo del requerimiento -------------------------------------------

test('25 ventas con base promedio 14,60 pagan 146 al 40 %', () => {
  const baseTotal = 25 * 14.6 // $365
  const r = calcular(ESQUEMA, 25, baseTotal)

  assert.equal(r.nivel.nombre, 'Oro')
  assert.equal(r.porcentaje, 40)
  assert.equal(cent(r.monto), 146)
})

test('la venta 26 sube el porcentaje de TODAS: 170,82', () => {
  // Retroactivo: al llegar a 26 el 45 % se aplica a las 26, no solo a la última.
  const baseTotal = 26 * 14.6 // $379,60
  const r = calcular(ESQUEMA, 26, baseTotal)

  assert.equal(r.nivel.nombre, 'Platino')
  assert.equal(r.porcentaje, 45)
  assert.equal(cent(r.monto), 170.82)
})

test('el salto de nivel vale más que la venta que lo produce', () => {
  // El punto 20: "+$30,66" por dos ventas que a su propio porcentaje valdrían
  // $11,68. Eso es lo que el tablero tiene que poder mostrar.
  const r = proyeccion(
    { ...ESQUEMA, bases: [] },
    { ventas: 24, baseTotal: 24 * 14.6 },
  )

  assert.equal(r.actual.nivel.nombre, 'Oro')
  assert.equal(r.siguiente.nivel.nombre, 'Platino')
  assert.equal(r.siguiente.faltan, 2)
  assert.equal(r.siguiente.objetivo, 26)
  assert.equal(cent(r.siguiente.monto), 170.82)
  assert.equal(cent(r.siguiente.incremento), 30.66)
})

// --- Los bordes de los escalones --------------------------------------------

test('sin ventas no hay nivel ni monto', () => {
  const r = calcular(ESQUEMA, 0, 0)
  assert.equal(r.nivel, null)
  assert.equal(r.monto, 0)
})

test('cada borde de tramo cae en el nivel que corresponde', () => {
  const en = (v) => calcular(ESQUEMA, v, v * 10).nivel.nombre

  assert.equal(en(1), 'Inicial')
  assert.equal(en(10), 'Inicial')
  assert.equal(en(11), 'Bronce')
  assert.equal(en(15), 'Bronce')
  assert.equal(en(16), 'Plata')
  assert.equal(en(25), 'Oro')
  assert.equal(en(26), 'Platino')
  assert.equal(en(30), 'Platino')
  assert.equal(en(31), 'Élite')
  // El último tramo no tiene techo: 500 ventas siguen siendo Élite y no rompen.
  assert.equal(en(500), 'Élite')
})

test('el último escalón no tiene siguiente', () => {
  assert.equal(siguienteNivel(ESQUEMA, 35), null)
  assert.equal(siguienteNivel(ESQUEMA, 24).nivel.nombre, 'Platino')
  assert.equal(siguienteNivel(ESQUEMA, 0).nivel.nombre, 'Inicial')
})

// --- Progresivo --------------------------------------------------------------

test('progresivo cobra cada tramo a su propio porcentaje', () => {
  // 12 ventas de $10: las primeras 10 al 20 % y 2 al 30 %.
  //   10 × 10 × 0,20 = 20
  //    2 × 10 × 0,30 =  6
  const r = calcular({ niveles: NIVELES, modo: 'progresivo' }, 12, 120)

  assert.equal(r.nivel.nombre, 'Bronce')
  assert.equal(cent(r.monto), 26)
})

test('progresivo nunca paga más que retroactivo con los mismos tramos', () => {
  // Es la propiedad que hace que cambiar de modo sea una decisión de costo y no
  // una lotería: el retroactivo aplica el mejor porcentaje a todo.
  for (const ventas of [1, 5, 11, 16, 21, 26, 31, 40]) {
    const baseTotal = ventas * 14.6
    const prog = calcular({ niveles: NIVELES, modo: 'progresivo' }, ventas, baseTotal)
    const retro = calcular(ESQUEMA, ventas, baseTotal)
    assert.ok(
      cent(prog.monto) <= cent(retro.monto),
      `con ${ventas} ventas el progresivo pagó ${prog.monto} y el retroactivo ${retro.monto}`,
    )
  }
})

// --- El bono de calidad ------------------------------------------------------

test('la cohorte del ejemplo: 23 de 25 son 92 % y pagan 40', () => {
  const calidad = (23 / 25) * 100
  assert.equal(calidad, 92)
  assert.equal(bonoDe(BONOS, calidad, 25, 10), 40)
})

test('el mínimo de clientes evaluables apaga el bono', () => {
  // Calidad perfecta con 3 clientes: cero. Es la regla del punto 15, y es la que
  // evita que el bono premie a quien vendió poco.
  assert.equal(bonoDe(BONOS, 100, 3, 10), 0)
  assert.equal(bonoDe(BONOS, 100, 10, 10), 50)
})

test('los bordes de los tramos de bono', () => {
  assert.equal(bonoDe(BONOS, 69.99, 20, 10), 0)
  assert.equal(bonoDe(BONOS, 70, 20, 10), 10)
  assert.equal(bonoDe(BONOS, 84.99, 20, 10), 20)
  assert.equal(bonoDe(BONOS, 85, 20, 10), 30)
  assert.equal(bonoDe(BONOS, 94.99, 20, 10), 40)
  assert.equal(bonoDe(BONOS, 95, 20, 10), 50)
  assert.equal(bonoDe(BONOS, 100, 20, 10), 50)
})

// --- El simulador ------------------------------------------------------------

const MEZCLA = [
  { plan_id: 'a', nombre: '50 Mbps', base: 10, pct: 40 },
  { plan_id: 'b', nombre: '150 Mbps', base: 12, pct: 30 },
  { plan_id: 'c', nombre: '300 Mbps', base: 14, pct: 20 },
  { plan_id: 'd', nombre: '500 Mbps', base: 20, pct: 10 },
]

test('la base promedio pondera por participación', () => {
  // 10×0,4 + 12×0,3 + 14×0,2 + 20×0,1 = 4 + 3,6 + 2,8 + 2 = 12,40
  assert.equal(cent(basePromedio(MEZCLA)), 12.4)
})

test('la participación no necesita sumar 100: se toma como proporción', () => {
  const doble = MEZCLA.map((m) => ({ ...m, pct: m.pct * 2 }))
  assert.equal(cent(basePromedio(doble)), cent(basePromedio(MEZCLA)))
})

test('el simulador suma comisión y bono, y saca el costo por cliente', () => {
  const r = simular({
    modo: 'retroactivo',
    niveles: NIVELES,
    bonos: BONOS,
    minClientes: 10,
    mezcla: MEZCLA,
    vendedores: [
      { nombre: 'A', ventas: 25, calidad: 92 },
      { nombre: 'B', ventas: 12, calidad: 75 },
    ],
  })

  // A: 25 × 12,40 = 310 × 40 % = 124, más bono 40 → 164
  assert.equal(cent(r.filas[0].comision), 124)
  assert.equal(r.filas[0].bono, 40)
  assert.equal(cent(r.filas[0].total), 164)

  // B: 12 × 12,40 = 148,80 × 30 % = 44,64, más bono 10 → 54,64
  assert.equal(cent(r.filas[1].comision), 44.64)
  assert.equal(r.filas[1].bono, 10)

  assert.equal(r.totales.ventas, 37)
  assert.equal(cent(r.totales.comision), 168.64)
  assert.equal(cent(r.totales.bono), 50)
  assert.equal(cent(r.totales.total), 218.64)
  // 218,64 / 37 ventas
  assert.equal(cent(r.totales.porCliente), 5.91)
})

test('un equipo vacío no divide por cero', () => {
  const r = simular({ modo: 'retroactivo', niveles: NIVELES, mezcla: MEZCLA, vendedores: [] })
  assert.equal(r.totales.ventas, 0)
  assert.equal(r.totales.porCliente, 0)
})

test('sin mezcla de planes la base es cero y no NaN', () => {
  const r = simular({
    modo: 'retroactivo',
    niveles: NIVELES,
    mezcla: [],
    vendedores: [{ nombre: 'A', ventas: 10, calidad: 100 }],
  })
  assert.equal(r.promedio, 0)
  assert.equal(r.filas[0].comision, 0)
  assert.ok(!Number.isNaN(r.totales.porCliente))
})
