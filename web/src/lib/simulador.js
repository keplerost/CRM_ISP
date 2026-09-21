// Del módulo puro y no de `./comisiones`: así este archivo tampoco arrastra el
// cliente de Supabase y se puede probar sin base de datos.
//
// Con la extensión escrita, que en el resto del proyecto se omite: Vite la
// resuelve sola, pero Node —que es quien corre las pruebas— exige la ruta
// completa. Sin el `.js`, la prueba no puede ni cargar el archivo.
import { calcular } from './comisionesCalculo.js'

/**
 * El simulador de comisiones: qué costaría el esquema si las reglas fueran otras.
 *
 * ── Por qué la cuenta vive acá y no en la base ──
 *
 * Porque simular es probar veinte combinaciones en dos minutos, y cada una tiene
 * que contestar antes de que la mano llegue al campo siguiente. Una ida y vuelta
 * al servidor por tecla convertiría la herramienta en un formulario que hay que
 * enviar, y nadie prueba veinte escenarios en un formulario.
 *
 * Y porque no hay nada que guardar: un escenario es una pregunta, no un dato. El
 * único momento en que esto toca la base es cuando alguien decide aplicarlo, y
 * ahí pasa por el mismo camino que la pantalla de configuración —crear una
 * versión— con su auditoría.
 *
 * ── El riesgo de tener dos motores, y cómo se evita ──
 *
 * Si esta cuenta y la de la base no dieran lo mismo, el simulador diría "esto
 * cuesta $1.400" y a fin de mes se pagarían $1.900. Por eso acá NO hay una
 * segunda implementación de los escalones: se llama a `calcular()`, la misma
 * función que usa la pantalla de configuración, escrita para reflejar lo que hace
 * `comision_de_periodo()` en Postgres.
 *
 * Lo único que agrega este archivo es el bono y la agregación por equipo.
 *
 * ── Qué asume, y por qué está bien que lo asuma ──
 *
 * Que todas las ventas del escenario son comisionables y evaluables. Un
 * simulador que además pidiera estimar cuántas se caen en instalación mezclaría
 * dos preguntas: "cuánto cuesta el esquema" y "cómo funciona la operación". La
 * segunda ya la contesta la inteligencia comercial con datos reales.
 */

/** El promedio ponderado de la mezcla de planes: la base de una venta típica. */
export function basePromedio(mezcla = []) {
  const total = mezcla.reduce((t, m) => t + (Number(m.pct) || 0), 0)
  if (total <= 0) return 0
  return mezcla.reduce((t, m) => t + (Number(m.base) || 0) * ((Number(m.pct) || 0) / total), 0)
}

/**
 * El bono que corresponde a un porcentaje de calidad.
 *
 * Réplica exacta de `bono_de_calidad()` más la puerta del mínimo de clientes:
 * con menos evaluables que el mínimo, el bono es cero aunque la calidad sea del
 * 100 %. Es la regla del punto 15 y en el simulador importa mucho, porque es lo
 * que hace visible que subir el bono máximo no cambia nada para quien vende poco.
 */
export function bonoDe(bonos = [], calidad, evaluables, minClientes = 0) {
  if ((Number(evaluables) || 0) < (Number(minClientes) || 0)) return 0

  const c = Number(calidad) || 0
  const tramo = [...bonos]
    .sort((a, b) => Number(b.desde_pct) - Number(a.desde_pct))
    .find((b) => c >= Number(b.desde_pct) && c <= Number(b.hasta_pct))

  return Number(tramo?.monto ?? 0)
}

/**
 * Corre el escenario.
 *
 * @param modo         'retroactivo' | 'progresivo'
 * @param niveles      los escalones, con desde_ventas / hasta_ventas / porcentaje
 * @param bonos        los tramos de bono, con desde_pct / hasta_pct / monto
 * @param minClientes  mínimo de clientes evaluables para cobrar bono
 * @param mezcla       planes con su base y su participación en las ventas
 * @param vendedores   filas con { nombre, ventas, calidad }
 */
export function simular({ modo, niveles = [], bonos = [], minClientes = 0, mezcla = [], vendedores = [] }) {
  const promedio = basePromedio(mezcla)

  const filas = vendedores.map((v, i) => {
    const ventas = Math.max(0, Number(v.ventas) || 0)
    const baseTotal = ventas * promedio
    const { nivel, porcentaje, monto } = calcular({ niveles, modo }, ventas, baseTotal)
    const bono = bonoDe(bonos, v.calidad, ventas, minClientes)

    return {
      id: v.id ?? i,
      nombre: v.nombre || `Vendedor ${i + 1}`,
      ventas,
      calidad: Number(v.calidad) || 0,
      baseTotal,
      nivel: nivel?.nombre ?? null,
      porcentaje,
      comision: monto,
      bono,
      total: monto + bono,
    }
  })

  const ventas = filas.reduce((t, f) => t + f.ventas, 0)
  const comision = filas.reduce((t, f) => t + f.comision, 0)
  const bono = filas.reduce((t, f) => t + f.bono, 0)

  return {
    promedio,
    filas,
    totales: {
      vendedores: filas.length,
      ventas,
      baseTotal: filas.reduce((t, f) => t + f.baseTotal, 0),
      comision,
      bono,
      total: comision + bono,
      // El número que decide si el esquema es sostenible: cuánto cuesta traer un
      // cliente. Sin él, "$1.400 de comisión" no se puede comparar con nada.
      porCliente: ventas > 0 ? (comision + bono) / ventas : 0,
    },
  }
}

/**
 * Un escenario armado con lo que de verdad pasó.
 *
 * ── Por qué arranca con datos reales y no vacío ──
 *
 * Porque un simulador en blanco obliga a inventar el escenario antes de poder
 * usarlo, y lo que se inventa suele ser optimista: cinco vendedores parejos con
 * veinte ventas cada uno. La realidad casi nunca se parece a eso, y un esquema
 * afinado contra un escenario inventado se rompe el primer mes.
 *
 * Se toma el último período con actividad. Si no hay ninguno, se arma un
 * escenario mínimo y la pantalla avisa que es un ejemplo.
 */
export function escenarioReal({ equipo = [], planes = [], bases = [] }) {
  const vendedores = equipo
    .filter((e) => Number(e.comisionables) > 0 || Number(e.solicitudes) > 0)
    .map((e) => ({
      id: e.vendedor_id,
      nombre: e.vendedor,
      ventas: Number(e.comisionables) || 0,
      // Sin cohorte medida todavía no hay calidad real. Se asume 90 % —el tramo
      // en el que cae la mayoría— y la pantalla lo marca como supuesto.
      calidad: e.retencion == null ? 90 : Number(e.retencion),
    }))

  // La mezcla sale de lo vendido; la base, del esquema vigente.
  const vendidas = planes.reduce((t, p) => t + (Number(p.comisionables) || 0), 0)
  const mezcla = bases
    .filter((b) => b.comisiona)
    .map((b) => {
      const real = planes.find((p) => p.plan_id === b.plan_id)
      return {
        plan_id: b.plan_id,
        nombre: b.plan ?? b.nombre ?? 'Plan',
        base: Number(b.base) || 0,
        pct:
          vendidas > 0
            ? Math.round(((Number(real?.comisionables) || 0) / vendidas) * 100)
            : 0,
      }
    })

  return { vendedores, mezcla, real: vendedores.length > 0 && vendidas > 0 }
}
