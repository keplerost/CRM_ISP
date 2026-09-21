/**
 * La cuenta de la comisión, sin nada alrededor.
 *
 * ── Por qué este archivo existe separado ──
 *
 * Porque es la única parte del módulo que decide plata en el navegador, y tenía
 * que poder probarse. Mientras vivía junto al cliente de Supabase no se podía:
 * importarlo desde una prueba arrastraba la conexión, y una prueba que necesita
 * base de datos para verificar una multiplicación no se corre nunca.
 *
 * Acá adentro no hay un solo `import`. Se puede ejecutar en cualquier lado, y de
 * hecho se ejecuta: `middleware/test/comisionesCalculo.test.js` verifica contra
 * los ejemplos del requerimiento —25 ventas al 40 % son $146, 26 al 45 % son
 * $170,82— que es la forma de que un cambio de estilo no se lleve puesto un
 * porcentaje.
 *
 * ── La regla que no se puede romper ──
 *
 * Esto tiene que dar lo MISMO que `comision_de_periodo()` en Postgres. La
 * pantalla muestra este número mientras alguien edita, y la base paga el otro.
 * Si divergen, el vendedor ve una cifra y cobra otra.
 */

/**
 * Qué comisión sale de N ventas con este esquema.
 *
 * ── Los dos modos ──
 *
 *   retroactivo  el porcentaje del nivel alcanzado se aplica a TODA la base.
 *   progresivo   cada tramo cobra su propio porcentaje.
 *
 * En progresivo se usa la base promedio por venta. El motor usa la base real de
 * cada una, ordenadas por cuándo se volvieron comisionables: con planes de valor
 * distinto los totales pueden separarse por centavos. El nivel y el porcentaje
 * son siempre los mismos, y las pantallas que muestran progresivo lo aclaran.
 */
export function calcular({ niveles, modo }, ventas, baseTotal) {
  if (!ventas || !niveles?.length) return { nivel: null, porcentaje: 0, monto: 0 }

  const ordenados = [...niveles].sort((a, b) => a.desde_ventas - b.desde_ventas)
  const nivel = [...ordenados].reverse().find((n) => ventas >= n.desde_ventas) ?? ordenados[0]

  if (modo === 'progresivo') {
    const porVenta = baseTotal / ventas
    let monto = 0
    for (const n of ordenados) {
      const desde = n.desde_ventas
      const hasta = n.hasta_ventas ?? Infinity
      const enTramo = Math.max(0, Math.min(ventas, hasta) - desde + 1)
      if (enTramo > 0) monto += enTramo * porVenta * (Number(n.porcentaje) / 100)
    }
    return { nivel, porcentaje: Number(nivel.porcentaje), monto }
  }

  return {
    nivel,
    porcentaje: Number(nivel.porcentaje),
    monto: baseTotal * (Number(nivel.porcentaje) / 100),
  }
}

/** El siguiente escalón y cuánto falta para alcanzarlo. */
export function siguienteNivel({ niveles }, ventas) {
  const ordenados = [...(niveles ?? [])].sort((a, b) => a.desde_ventas - b.desde_ventas)
  const siguiente = ordenados.find((n) => n.desde_ventas > ventas)
  if (!siguiente) return null
  return { nivel: siguiente, faltan: siguiente.desde_ventas - ventas }
}

/** El promedio de las bases que hoy comisionan. Sirve cuando todavía no vendió. */
function basePromedioEsquema(esquema) {
  const activas = (esquema?.bases ?? []).filter((b) => b.comisiona)
  if (!activas.length) return 0
  return activas.reduce((t, b) => t + Number(b.base || 0), 0) / activas.length
}

/**
 * Cuánto lleva y cuánto ganaría con el próximo escalón.
 *
 * Es el punto 20 entero: "te faltan 2 ventas para PLATINO — con ellas serían
 * $170,82, +$30,66".
 *
 * ── Por qué el promedio y no la próxima venta real ──
 *
 * Porque no se sabe qué plan va a vender. El promedio de lo que ya vendió este
 * mes es la mejor estimación disponible y es la que usa el ejemplo del
 * requerimiento; si todavía no vendió nada, se usa el promedio de las bases
 * configuradas para no mostrar cero.
 *
 * El número se muestra SIEMPRE como estimación. Prometer un monto exacto por una
 * venta que todavía no existe es la forma de que la primera liquidación llegue
 * con una discusión adentro.
 */
export function proyeccion(esquema, { ventas = 0, baseTotal = 0 } = {}) {
  const actual = calcular(esquema, ventas, baseTotal)
  const sig = siguienteNivel(esquema, ventas)
  if (!sig) return { actual, siguiente: null }

  const promedio = ventas > 0 ? baseTotal / ventas : basePromedioEsquema(esquema)
  const objetivo = sig.nivel.desde_ventas
  const conElSalto = calcular(esquema, objetivo, baseTotal + sig.faltan * promedio)

  return {
    actual,
    siguiente: {
      ...sig,
      objetivo,
      promedio,
      monto: conElSalto.monto,
      incremento: conElSalto.monto - actual.monto,
    },
  }
}
