/**
 * Las obras de red (migración 232): lo que comparten la oficina y la app de
 * campo, y cómo se lee cada indicador.
 *
 * Las cuentas las hace la base (`indicadores_obras`); acá se decide solo el
 * semáforo de cada número contra su meta, para que la oficina y la cuadrilla
 * vean el mismo color por el mismo motivo.
 */

export const TIPOS_OBRA = {
  expansion: 'Expansión a zona nueva',
  troncal: 'Troncal / cambio de troncal',
  reubicacion: 'Reubicación de postes o cables',
  preventivo: 'Mantenimiento preventivo',
  reparacion: 'Reparación de red',
  acometida: 'Acometida / extensión para abonado',
  otro: 'Otro',
}

export const ESTADOS_OBRA = {
  planificada: { label: 'Planificada', color: 'gris' },
  en_curso: { label: 'En curso', color: 'azul' },
  entregada: { label: 'Entregada: por revisar', color: 'ambar' },
  aprobada: { label: 'Aprobada', color: 'verde' },
  cancelada: { label: 'Cancelada', color: 'gris' },
}

/** El alcance de una obra: lo que se planifica y lo que reporta cada parte. */
export const METAS = [
  { clave: 'metros', label: 'Fibra tendida', unidad: 'm' },
  { clave: 'naps', label: 'Cajas NAP', unidad: '' },
  { clave: 'fusiones', label: 'Fusiones', unidad: '' },
  { clave: 'mangas', label: 'Mangas', unidad: '' },
  { clave: 'postes', label: 'Postes', unidad: '' },
  { clave: 'puertos', label: 'Puertos habilitados', unidad: '' },
]

const num = (v) => (v == null || v === '' ? null : Number(v))
export const fmt = (v, dec = 0) =>
  v == null || Number.isNaN(Number(v))
    ? '—'
    : Number(v).toLocaleString('es-EC', { minimumFractionDigits: 0, maximumFractionDigits: dec })

/** % entero, o null si no hay base. */
export const pct = (parte, total) => (total > 0 ? Math.round((Number(parte) / Number(total)) * 100) : null)

/**
 * Cada meta de una fila de `v_obras_red` con lo hecho. Solo las que la obra
 * tiene (meta > 0). Las NAP cuentan lo reportado o lo registrado, lo que sea
 * mayor: registrar la caja ya es haberla puesto.
 */
export function progresoMetas(o) {
  return METAS.map((m) => {
    const meta = num(o?.[`meta_${m.clave}`]) ?? 0
    let hecho = num(o?.[`hecho_${m.clave}`]) ?? 0
    if (m.clave === 'naps') hecho = Math.max(hecho, num(o?.naps_registradas) ?? 0)
    return { ...m, meta, hecho, pct: meta > 0 ? Math.min(100, Math.round((hecho / meta) * 100)) : null }
  }).filter((m) => m.meta > 0)
}

/** Días que faltan para la fecha meta (negativo = atrasada). null sin meta. */
export function diasParaMeta(fechaMeta, hoy) {
  if (!fechaMeta) return null
  const a = new Date(`${String(fechaMeta).slice(0, 10)}T12:00:00`)
  const b = new Date(`${String(hoy).slice(0, 10)}T12:00:00`)
  return Math.round((a - b) / 86_400_000)
}

/**
 * El semáforo: 'bien' | 'atencion' | 'mal' | 'sin_datos'.
 *
 * `mayorEsMejor`: true para "% a tiempo", false para "% de desvío".
 * `margen`: cuánto por debajo (o por encima) de la meta todavía es amarillo.
 */
export function semaforo(valor, meta, { mayorEsMejor = true, margen = 10 } = {}) {
  if (valor == null || meta == null || Number.isNaN(Number(valor))) return 'sin_datos'
  const v = Number(valor)
  const m = Number(meta)
  if (mayorEsMejor) {
    if (v >= m) return 'bien'
    return v >= m - margen ? 'atencion' : 'mal'
  }
  if (v <= m) return 'bien'
  return v <= m + margen ? 'atencion' : 'mal'
}

/**
 * Los ocho indicadores de una cuadrilla, listos para dibujar: cada uno con su
 * número principal, su meta, su semáforo y una línea de detalle.
 *
 * `c` es un elemento de `indicadores_obras(...).cuadrillas`; `cfg`, su config.
 */
export function leerIndicadores(c, cfg = {}) {
  const p = c?.produccion ?? {}
  const pl = c?.plan ?? {}
  const ca = c?.calidad ?? {}
  const fa = c?.fallas ?? {}
  const ma = c?.material ?? {}
  const doc = c?.documentacion ?? {}
  const se = c?.seguridad ?? {}
  const ap = c?.apoyo ?? {}

  const metaDia = num(cfg.meta_metros_dia) || null
  const aTiempo = pct(pl.a_tiempo, pl.entregadas)
  const napsOk = pct(ca.naps_ok, ca.naps_medidas)
  const fusionOk = pct(ca.dias_fusion_ok, ca.dias_fusion_medidos)
  const fallasPorNap = fa.naps > 0 ? Number(fa.fallas) / Number(fa.naps) : null
  const conFoto = pct(doc.dias_con_foto, doc.dias)
  const primera = pct(doc.a_la_primera, doc.revisadas)
  const epp = pct(se.con_epp, se.partes)

  return [
    {
      clave: 'produccion',
      titulo: 'Producción',
      valor: `${fmt(p.metros)} m`,
      detalle: `${fmt(p.naps)} NAP · ${fmt(p.fusiones)} fusiones · ${fmt(p.mangas)} mangas · ${fmt(p.postes)} postes · ${fmt(p.puertos)} puertos en ${fmt(p.dias)} día(s)`,
      meta: metaDia ? `${fmt(p.metros_dia, 1)} m/día (meta ${fmt(metaDia)})` : `${fmt(p.metros_dia, 1)} m por día trabajado`,
      estado: metaDia ? semaforo(p.metros_dia, metaDia, { margen: metaDia * 0.2 }) : p.dias > 0 ? 'bien' : 'sin_datos',
    },
    {
      clave: 'plan',
      titulo: 'Avance vs. plan',
      valor: aTiempo == null ? '—' : `${aTiempo}% a tiempo`,
      detalle: `${fmt(pl.a_tiempo)} de ${fmt(pl.entregadas)} entregadas a tiempo · ${fmt(pl.abiertas)} abiertas (avance ${fmt(pl.avance_promedio)}%)${pl.atrasadas ? ` · ${pl.atrasadas} atrasada(s)` : ''}`,
      meta: `Meta ≥ ${fmt(cfg.meta_a_tiempo_pct ?? pl.meta_a_tiempo_pct)}%`,
      estado:
        pl.atrasadas > 0 && aTiempo == null
          ? 'mal'
          : semaforo(aTiempo, cfg.meta_a_tiempo_pct ?? pl.meta_a_tiempo_pct, { margen: 15 }),
    },
    {
      clave: 'calidad',
      titulo: 'Calidad óptica',
      valor: napsOk == null ? '—' : `${napsOk}% NAP OK`,
      detalle:
        `${fmt(ca.naps_ok)} de ${fmt(ca.naps_medidas)} NAP en ${fmt(ca.potencia_min_dbm ?? cfg.potencia_min_dbm, 1)} dBm o mejor` +
        (ca.potencia_promedio != null ? ` · promedio ${fmt(ca.potencia_promedio, 2)} dBm` : '') +
        (ca.perdida_promedio != null
          ? ` · fusión ${fmt(ca.perdida_promedio, 3)} dB promedio (${fusionOk}% de los días ≤ ${fmt(ca.perdida_max_db ?? cfg.perdida_fusion_max_db, 2)} dB)`
          : ''),
      meta: `NAP ≥ ${fmt(cfg.potencia_min_dbm, 1)} dBm · fusión ≤ ${fmt(cfg.perdida_fusion_max_db, 2)} dB`,
      estado: peor(
        semaforo(napsOk, 100, { margen: 10 }),
        ca.perdida_promedio == null
          ? 'sin_datos'
          : semaforo(ca.perdida_promedio, cfg.perdida_fusion_max_db ?? ca.perdida_max_db, {
              mayorEsMejor: false,
              margen: 0.05,
            }),
      ),
    },
    {
      clave: 'fallas',
      titulo: `Fallas a ${fmt(fa.dias ?? cfg.dias_fallas)} días`,
      valor: fa.obras ? `${fmt(fa.fallas)} falla(s)` : '—',
      detalle: fa.obras
        ? `En ${fmt(fa.naps)} NAP de ${fmt(fa.obras)} obra(s) entregada(s) · ${fmt(fa.clientes_conectados)} abonados conectados de ${fmt(fa.puertos)} puertos`
        : 'Sin obras entregadas en el período',
      meta: 'Meta: 0 · más de 1 por NAP es retrabajo',
      estado: !fa.obras ? 'sin_datos' : fa.fallas == 0 ? 'bien' : fallasPorNap <= 1 ? 'atencion' : 'mal',
    },
    {
      clave: 'material',
      titulo: 'Material vs. presupuesto',
      valor: ma.desvio_pct == null ? '—' : `${Number(ma.desvio_pct) > 0 ? '+' : ''}${fmt(ma.desvio_pct, 1)}%`,
      detalle: ma.lineas
        ? `${fmt(ma.lineas)} línea(s) de presupuesto · ${fmt(ma.lineas_excedidas)} excedida(s)${ma.extras ? ` · ${ma.extras} sin presupuestar` : ''}`
        : 'Sin material presupuestado en obras entregadas',
      meta: `Merma ≤ ${fmt(cfg.merma_max_pct ?? ma.merma_max_pct)}%`,
      estado:
        ma.desvio_pct == null
          ? 'sin_datos'
          : semaforo(ma.desvio_pct, cfg.merma_max_pct ?? ma.merma_max_pct, { mayorEsMejor: false, margen: 10 }),
    },
    {
      clave: 'documentacion',
      titulo: 'Documentación',
      valor: primera == null ? (conFoto == null ? '—' : `${conFoto}% días con foto`) : `${primera}% a la primera`,
      detalle: `${fmt(doc.a_la_primera)} de ${fmt(doc.revisadas)} aprobadas sin devolución · ${fmt(doc.devoluciones)} devolución(es) · ${conFoto ?? '—'}% de los días con foto`,
      meta: 'Meta: 100% días con foto y aprobadas a la primera',
      estado: peor(semaforo(primera, 100, { margen: 20 }), semaforo(conFoto, 100, { margen: 15 })),
    },
    {
      clave: 'seguridad',
      titulo: 'Seguridad',
      valor: se.incidentes ? `${se.incidentes} incidente(s)` : epp == null ? '—' : `${epp}% con EPP`,
      detalle: `${fmt(se.con_epp)} de ${fmt(se.partes)} partes con EPP completo · ${fmt(se.incidentes)} incidente(s)`,
      meta: 'Meta: 100% con EPP y 0 incidentes',
      estado: se.incidentes > 0 ? 'mal' : semaforo(epp, 100, { margen: 10 }),
    },
    {
      clave: 'apoyo',
      titulo: 'Apoyo a soporte',
      valor: ap.pct == null ? '—' : `${ap.pct}% de los días`,
      detalle: `${fmt(ap.tickets)} ticket(s) cerrados en ${fmt(ap.dias_tickets)} día(s) · ${fmt(ap.dias_obra)} día(s) de obra`,
      meta: `Hasta ${fmt(cfg.apoyo_max_pct ?? ap.apoyo_max_pct)}%: si pasa, falta gente en soporte`,
      estado:
        ap.pct == null
          ? 'sin_datos'
          : semaforo(ap.pct, cfg.apoyo_max_pct ?? ap.apoyo_max_pct, { mayorEsMejor: false, margen: 10 }),
    },
  ]
}

const ORDEN = { mal: 0, atencion: 1, bien: 2, sin_datos: 3 }
/** El peor de dos semáforos, ignorando el que no tiene datos. */
export function peor(a, b) {
  if (a === 'sin_datos') return b
  if (b === 'sin_datos') return a
  return ORDEN[a] <= ORDEN[b] ? a : b
}

/** Períodos rápidos para los indicadores. `hoy` en YYYY-MM-DD. */
export function periodo(clave, hoy) {
  const d = new Date(`${hoy}T12:00:00`)
  const iso = (x) => x.toISOString().slice(0, 10)
  if (clave === 'semana') {
    const lunes = new Date(d)
    lunes.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    return { desde: iso(lunes), hasta: hoy }
  }
  if (clave === 'semana_pasada') {
    const lunes = new Date(d)
    lunes.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7)
    const domingo = new Date(lunes)
    domingo.setDate(lunes.getDate() + 6)
    return { desde: iso(lunes), hasta: iso(domingo) }
  }
  if (clave === 'mes_pasado') {
    const ini = new Date(d.getFullYear(), d.getMonth() - 1, 1, 12)
    const fin = new Date(d.getFullYear(), d.getMonth(), 0, 12)
    return { desde: iso(ini), hasta: iso(fin) }
  }
  if (clave === 'trimestre') {
    const ini = new Date(d)
    ini.setDate(d.getDate() - 89)
    return { desde: iso(ini), hasta: hoy }
  }
  // mes
  return { desde: iso(new Date(d.getFullYear(), d.getMonth(), 1, 12)), hasta: hoy }
}
