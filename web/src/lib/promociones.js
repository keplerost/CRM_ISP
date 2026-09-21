import { supabase } from './supabaseClient'
import { personalApi } from './personal'

/**
 * Promociones: lo que se puede ofrecer hoy.
 *
 * ── Por qué el descuento se calcula acá y no lo escribe el vendedor ──
 *
 * El cotizador ya tiene un campo "descuento" que se tipea a mano, y va a
 * seguir estando para el caso puntual. La diferencia es que una promoción es
 * una decisión de la empresa: quien la define escribe el número una vez, y todos
 * los vendedores aplican exactamente ese.
 *
 * Sin esto, "dos meses al 50%" lo interpreta cada uno a su manera y el cliente
 * recibe condiciones distintas según con quién habló.
 */

export const TIPOS = {
  porcentaje: {
    label: 'Descuento porcentual',
    ayuda: 'Un % menos en la mensualidad, durante N meses.',
    unidad: '%',
    pideMeses: true,
  },
  meses_gratis: {
    label: 'Meses gratis',
    ayuda: 'No paga la mensualidad durante N meses.',
    unidad: 'meses',
    pideMeses: false,
  },
  instalacion_gratis: {
    label: 'Instalación sin costo',
    ayuda: 'No se cobra la instalación. La mensualidad no cambia.',
    unidad: null,
    pideMeses: false,
  },
  precio_fijo: {
    label: 'Precio promocional',
    ayuda: 'Una mensualidad fija durante N meses, sin importar el plan.',
    unidad: '$',
    pideMeses: true,
  },
}

/**
 * Aplica una promoción a los números de una cotización.
 *
 * No modifica nada: devuelve los valores calculados y quien llama decide.
 *
 * ── Por qué devuelve tres montos y no uno ──
 *
 * Una promoción de tres meses tiene tres precios distintos: el del primer pago,
 * el de los meses promocionales y el de después. Colapsarlos en un solo
 * "descuento" es exactamente el malentendido que termina en reclamo al cuarto
 * mes: el cliente creía que ese era el precio.
 *
 *   primerMes     — la parte mensual del primer pago (0 si el primer mes es gratis)
 *   mensual       — lo que paga mientras dura la promo
 *   mensualNormal — lo que paga cuando termina
 *
 * `instalacion` va aparte porque hay un tipo que toca eso y no la mensualidad.
 */
export function aplicar(promo, { mensual, instalacion }) {
  const base = {
    primerMes: mensual,
    mensual,
    mensualNormal: mensual,
    instalacion,
    meses: 0,
    // `meses_gratis` no baja el precio: saltea meses. Sin distinguirlo, la
    // pantalla armaba la frase de un descuento —"después $18 por 2 meses, luego
    // $18"— que no dice nada.
    gratis: false,
    descripcion: null,
    ahorro: 0,
  }
  if (!promo) return base

  const meses = Number(promo.meses_aplica) || 1
  const valor = Number(promo.valor) || 0

  switch (promo.tipo) {
    case 'porcentaje': {
      const nuevo = redondear(Math.max(0, mensual * (1 - valor / 100)))
      return {
        ...base,
        primerMes: nuevo,
        mensual: nuevo,
        meses,
        descripcion: `${valor}% de descuento por ${meses} ${meses === 1 ? 'mes' : 'meses'}`,
        ahorro: redondear((mensual - nuevo) * meses),
      }
    }
    case 'meses_gratis': {
      const n = Math.max(1, Math.round(valor))
      return {
        ...base,
        // El primer pago no lleva mensualidad; la mensualidad en sí no cambió.
        primerMes: 0,
        meses: n,
        gratis: true,
        descripcion: `${n} ${n === 1 ? 'mes' : 'meses'} sin pagar la mensualidad`,
        ahorro: redondear(mensual * n),
      }
    }
    case 'instalacion_gratis':
      return {
        ...base,
        instalacion: 0,
        descripcion: 'Instalación sin costo',
        ahorro: redondear(instalacion),
      }
    case 'precio_fijo': {
      const fijo = redondear(valor)
      return {
        ...base,
        primerMes: fijo,
        mensual: fijo,
        meses,
        descripcion: `${fijo.toFixed(2)} por mes durante ${meses} ${meses === 1 ? 'mes' : 'meses'}`,
        ahorro: redondear(Math.max(0, mensual - fijo) * meses),
      }
    }
    default:
      return base
  }
}

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100

/** ¿Esta promo sirve para este plan? Sin planes cargados, sirve para todos. */
export const aplicaAlPlan = (promo, planId) =>
  !promo?.planes?.length || promo.planes.includes(planId)

export const promocionesApi = {
  /** Las que se pueden vender hoy. Las vencidas ni aparecen. */
  async vigentes() {
    const { data, error } = await supabase
      .from('v_promociones_vigentes')
      .select('*')
      .order('creado_en', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  /** Todas, para administrar y para medir cuál funcionó. */
  async todas() {
    const { data, error } = await supabase
      .from('v_promociones')
      .select('*')
      .order('creado_en', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  async guardar({ promo, planes }, perfil) {
    const { id, planes: _p, planes_nombres, vencida, vigente, cotizada_veces, ventas_cerradas, ...datos } = promo
    const fila = {
      ...datos,
      valor: datos.tipo === 'instalacion_gratis' ? null : Number(datos.valor) || 0,
      meses_aplica: datos.meses_aplica ? Number(datos.meses_aplica) : null,
      vigente_hasta: datos.vigente_hasta || null,
      creado_por: id ? undefined : perfil?.id ?? null,
    }

    const { data, error } = id
      ? await supabase.from('promociones').update(fila).eq('id', id).select().single()
      : await supabase.from('promociones').insert(fila).select().single()
    if (error) throw error

    // Los planes se reemplazan enteros: son dos o tres filas y calcular altas y
    // bajas para eso es más código del que ahorra.
    await supabase.from('promocion_planes').delete().eq('promocion_id', data.id)
    if (planes?.length) {
      const { error: e2 } = await supabase
        .from('promocion_planes')
        .insert(planes.map((plan_id) => ({ promocion_id: data.id, plan_id })))
      if (e2) throw e2
    }

    personalApi.registrar(
      id ? 'promocion.editar' : 'promocion.crear',
      `${id ? 'Editó' : 'Creó'} la promoción "${data.nombre}"`,
      { entidad: 'promocion', entidad_id: data.id },
    )
    return data
  },

  /**
   * Bajar una promoción no la borra: la desactiva.
   *
   * Borrarla dejaría sin nombre a las cotizaciones y ventas que la usaron, y la
   * pregunta "¿cuánto vendió la promo de Navidad?" quedaría sin respuesta para
   * siempre.
   */
  async desactivar(promo) {
    const { error } = await supabase
      .from('promociones')
      .update({ activa: false })
      .eq('id', promo.id)
    if (error) throw error
    personalApi.registrar('promocion.desactivar', `Dio de baja "${promo.nombre}"`, {
      entidad: 'promocion',
      entidad_id: promo.id,
    })
  },
}
