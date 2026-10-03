/**
 * Las cuentas del reporte de crecimiento por router.
 *
 * Viven acá, sin nada del navegador, porque las usan dos lados: la pantalla y
 * el Excel/PDF que arma el middleware. Si cada uno sumara por su cuenta, el día
 * que cambie una regla el papel diría una cosa y la pantalla otra.
 *
 * La materia prima son las filas de `reporte_crecimiento_routers()`: una por
 * mes y por router.
 */

/** 'AAAA-MM-DD' → 'mar 2026'. */
export function nombreMes(mes) {
  const [a, m] = String(mes).split('-').map(Number)
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
  return `${MESES[(m ?? 1) - 1]} ${a}`
}

/** Clave estable de un router; el "sin router" llega con id null. */
export const claveRouter = (f) => f.router_id ?? 'sin-router'

const num = (v) => Number(v ?? 0)

/**
 * Una fila por router con lo que pasó en todo el período.
 *
 * `inicio` es el total ANTES del primer mes: el del primer mes menos lo que ese
 * mes sumó. La foto es la del último mes que tenga una: si el mes en curso
 * todavía no la tiene, se muestra la anterior y se dice de cuándo es.
 */
export function resumirPorRouter(filas) {
  const porRouter = new Map()
  for (const f of [...(filas ?? [])].sort((a, b) => String(a.mes).localeCompare(String(b.mes)))) {
    const k = claveRouter(f)
    if (!porRouter.has(k)) {
      porRouter.set(k, {
        clave: k,
        router_id: f.router_id,
        router: f.router,
        inicio: num(f.total) - num(f.neto),
        altas: 0,
        carga_inicial: 0,
        bajas: 0,
        neto: 0,
        fin: 0,
        foto: null,
      })
    }
    const r = porRouter.get(k)
    r.altas += num(f.altas)
    r.carga_inicial += num(f.carga_inicial)
    r.bajas += num(f.bajas)
    r.neto += num(f.neto)
    r.fin = num(f.total)
    if (f.con_foto) {
      r.foto = {
        mes: f.mes,
        activos: num(f.activos),
        cortados: num(f.cortados),
        suspendidos: num(f.suspendidos),
        por_cobrar: num(f.por_cobrar),
        vencido: num(f.vencido),
      }
    }
  }

  return [...porRouter.values()]
    .map((r) => ({ ...r, variacion: r.inicio ? (r.fin - r.inicio) / r.inicio : null }))
    .sort((a, b) => b.fin - a.fin || String(a.router).localeCompare(String(b.router)))
}

/**
 * Los totales de todos los routers, mes por mes.
 *
 * Los datos de la foto solo se suman en los meses que la tienen: un mes sin
 * foto queda en null y no en cero, porque cero morosos es un dato y "no se
 * anotó" es otro.
 */
export function totalesPorMes(filas) {
  const porMes = new Map()
  for (const f of filas ?? []) {
    if (!porMes.has(f.mes)) {
      porMes.set(f.mes, {
        mes: f.mes,
        altas: 0,
        carga_inicial: 0,
        bajas: 0,
        neto: 0,
        total: 0,
        con_foto: false,
        activos: 0,
        cortados: 0,
        suspendidos: 0,
        por_cobrar: 0,
        vencido: 0,
      })
    }
    const m = porMes.get(f.mes)
    m.altas += num(f.altas)
    m.carga_inicial += num(f.carga_inicial)
    m.bajas += num(f.bajas)
    m.neto += num(f.neto)
    m.total += num(f.total)
    if (f.con_foto) {
      m.con_foto = true
      m.activos += num(f.activos)
      m.cortados += num(f.cortados)
      m.suspendidos += num(f.suspendidos)
      m.por_cobrar += num(f.por_cobrar)
      m.vencido += num(f.vencido)
    }
  }
  return [...porMes.values()]
    .sort((a, b) => String(a.mes).localeCompare(String(b.mes)))
    .map((m) =>
      m.con_foto
        ? m
        : { ...m, activos: null, cortados: null, suspendidos: null, por_cobrar: null, vencido: null },
    )
}

/** Primer día del mes, `meses - 1` meses antes de `hasta` (AAAA-MM). */
export function desdeParaRango(hasta, meses) {
  const [a, m] = String(hasta).split('-').map(Number)
  const d = new Date(a, m - 1 - (meses - 1), 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

/** Último día del mes `hasta` (AAAA-MM). */
export function finDeMes(hasta) {
  const [a, m] = String(hasta).split('-').map(Number)
  const d = new Date(a, m, 0)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
