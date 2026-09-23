/**
 * Vocabulario y cuentas de los planes de internet.
 *
 * El plan es la única cosa del sistema que toca las dos mitades del negocio a
 * la vez: lo que el abonado contrata —precio, IVA, categoría— y lo que el
 * equipo aplica —velocidad, cola, perfil—. Las reglas que las unen viven acá
 * porque las usan la pantalla de planes, la ficha del abonado y el alta en
 * campo.
 */

export const CATEGORIAS = {
  residencial: {
    label: 'Residencial',
    color: 'azul',
    ayuda: 'Hogares. Contención alta y prioridad estándar.',
  },
  corporativo: {
    label: 'Corporativo',
    color: 'violeta',
    ayuda: 'Empresas. Suele llevar caudal garantizado y prioridad más alta.',
  },
  otro: { label: 'Otro', color: 'gris', ayuda: '' },
}

export const IMPUESTOS = {
  incluido: {
    label: 'IVA incluido',
    ayuda: 'El precio que se publica ya trae el impuesto y se desglosa hacia atrás.',
  },
  mas: {
    label: 'Más IVA',
    ayuda: 'Al precio se le suma el impuesto. El abonado paga más de lo que dice la lista.',
  },
  ninguno: {
    label: 'Exento',
    ayuda: 'Sin impuesto. Se usa en servicios exonerados, no para redondear.',
  },
}

/**
 * Reparte un precio entre base e impuesto.
 *
 * Es la misma regla que aplica `repartirImpuesto` en la facturación mensual y
 * la que calcula la vista `v_planes`. Está acá para que el formulario muestre
 * el total mientras se escribe, sin ir y volver al servidor — pero es LA MISMA
 * cuenta, y si alguna cambia hay que cambiar las tres.
 */
export function repartir(precio, tipo = 'incluido', tarifa = 15) {
  const n = Number(precio) || 0
  const pct = Number(tarifa) || 0
  const r2 = (x) => Math.round(x * 100) / 100

  if (tipo === 'ninguno') return { base: r2(n), iva: 0, total: r2(n) }

  if (tipo === 'incluido') {
    const base = r2(n / (1 + pct / 100))
    return { base, iva: r2(n - base), total: r2(n) }
  }

  const iva = r2(n * (pct / 100))
  return { base: r2(n), iva, total: r2(n + iva) }
}

// Se reexporta para no romper a quien ya lo importaba desde acá; el
// formato de verdad vive en lib/formato.js, que respeta la moneda configurada.
export { dineroCero as dinero } from './formato'

/** 102400 → "102.4 Mbps" · 30000 → "30 Mbps" */
export function enMbps(kbps) {
  if (kbps == null || kbps === '') return '—'
  const m = Number(kbps) / 1000
  return `${Number.isInteger(m) ? m : m.toFixed(1)} Mbps`
}

export const aKbps = (mbps) => (mbps === '' || mbps == null ? null : Math.round(Number(mbps) * 1000))

/**
 * Dónde se aplica la velocidad de este plan.
 *
 * Lo decide **cómo conecta el abonado**, no con qué tecnología llega. Es una
 * distinción que parece un detalle y no lo es: hay sectores de fibra que se
 * administran con IP fija y cola en el MikroTik, y llamarle "la regla de FTTH"
 * a lo de PPPoE hace buscar el límite en el equipo equivocado.
 *
 * El mismo plan comercial sirve para los dos casos. No hay que duplicarlo: cada
 * abonado se limita donde corresponde según su `tipo_conexion`.
 */
export const SHAPING = {
  pppoe: {
    label: 'Abonados por PPPoE',
    donde: 'En la OLT',
    detalle:
      'La traffic table del plan controla el caudal sobre la fibra. El perfil PPP del MikroTik se crea SIN rate-limit: un límite ahí competiría con la OLT y ganaría el menor de los dos.',
    aplica: 'Es lo habitual en FTTH con autenticación PPPoE.',
  },
  ip: {
    label: 'Abonados con IP fija',
    donde: 'En el MikroTik',
    detalle:
      'El límite es la Simple Queue del abonado, con su max-limit, su caudal garantizado y su prioridad.',
    aplica:
      'Vale para radioenlace y también para los sectores de fibra que se administran con IPv4 fija en vez de PPPoE.',
  },
}

/**
 * Quién controla el caudal de los abonados PPPoE de un plan.
 *
 * Existe porque conviven: el mismo ISP puede tener un plan controlado por la
 * OLT en un nodo y otro controlado por el router en otro —una cabecera sin OLT,
 * un equipo heredado, una OLT que no soporta el caudal que se vende—.
 */
export const CONTROL_PPPOE = {
  olt: {
    label: 'La OLT (traffic table)',
    donde: 'En la OLT',
    ayuda:
      'Lo normal en fibra. El perfil PPP del MikroTik se crea sin rate-limit: un límite ahí competiría con la OLT y ganaría el menor de los dos.',
  },
  mikrotik: {
    label: 'El MikroTik (perfil PPP)',
    donde: 'En el perfil PPP del MikroTik',
    ayuda:
      'El perfil lleva el rate-limit con la velocidad del plan. Se usa donde no hay OLT en el camino o donde no se quiere que ella controle.',
  },
}

export const ESTADO_APROVISIONAMIENTO = {
  aplicado: { label: 'Aplicado', color: 'verde' },
  pendiente: { label: 'Pendiente', color: 'ambar' },
  error: { label: 'Error', color: 'rojo' },
}
