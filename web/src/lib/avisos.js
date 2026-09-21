/**
 * Cuándo se le manda cada aviso de pago.
 *
 * ── Por qué es una lista para elegir y no un campo para escribir ──
 *
 * Porque el número es en días RESPECTO DEL VENCIMIENTO y el signo lo cambia
 * todo: `-1` es un día antes de vencer y `1` es un día después. Escribiendo, un
 * signo de menos que falta convierte "avisale un día antes" en "avisale un día
 * tarde", y eso no se ve revisando la ficha — se ve cuando el abonado llama
 * diciendo que le cortaron sin avisar.
 *
 * Eligiendo de una lista que dice "1 día antes de vencer" no hay signo que
 * poner ni interpretación que hacer.
 */

/**
 * Los días que se ofrecen.
 *
 * No es una lista infinita a propósito: son los que un ISP usa de verdad. Los
 * valores intermedios que faltan —4, 6, 8 días— no cambian nada en la práctica y
 * alargarían el desplegable hasta volverlo incómodo.
 */
export const OPCIONES_DIAS = [
  { valor: '', titulo: 'Usar el valor general' },
  { valor: -10, titulo: '10 días antes de vencer' },
  { valor: -7, titulo: '7 días antes de vencer' },
  { valor: -5, titulo: '5 días antes de vencer' },
  { valor: -3, titulo: '3 días antes de vencer' },
  { valor: -2, titulo: '2 días antes de vencer' },
  { valor: -1, titulo: '1 día antes de vencer' },
  { valor: 0, titulo: 'El mismo día del vencimiento' },
  { valor: 1, titulo: '1 día después de vencer' },
  { valor: 2, titulo: '2 días después de vencer' },
  { valor: 3, titulo: '3 días después de vencer' },
  { valor: 5, titulo: '5 días después de vencer' },
  { valor: 7, titulo: '7 días después de vencer' },
  { valor: 10, titulo: '10 días después de vencer' },
  { valor: 15, titulo: '15 días después de vencer' },
  { valor: 20, titulo: '20 días después de vencer' },
  { valor: 30, titulo: '30 días después de vencer' },
]

/**
 * Las combinaciones de canales del aviso de nueva factura.
 *
 * ── Por qué acá es una lista y no casillas como en los avisos de cobranza ──
 *
 * Porque son decisiones distintas. En cobranza importa por CUÁLES se puede
 * llegar y el sistema prueba en orden hasta que uno salga; acá se elige una
 * combinación cerrada, y las que un ISP usa de verdad son pocas.
 *
 * La lista se guarda como arreglo. `null` —"lo general"— manda por lo que se
 * pueda, que es lo que hace que un abonado nuevo reciba su factura sin que nadie
 * le configure nada.
 */
export const COMBINACIONES_FACTURA = [
  { valor: null, titulo: 'Por donde se pueda (recomendado)', canales: null },
  { valor: 'email', titulo: 'Correo', canales: ['email'] },
  { valor: 'sms', titulo: 'SMS', canales: ['sms'] },
  { valor: 'whatsapp', titulo: 'WhatsApp', canales: ['whatsapp'] },
  { valor: 'telegram', titulo: 'Telegram', canales: ['telegram'] },
  { valor: 'email+telegram', titulo: 'Correo + Telegram', canales: ['email', 'telegram'] },
  { valor: 'email+sms', titulo: 'Correo + SMS', canales: ['email', 'sms'] },
  { valor: 'email+whatsapp', titulo: 'Correo + WhatsApp', canales: ['email', 'whatsapp'] },
  { valor: 'telegram+sms', titulo: 'Telegram + SMS', canales: ['telegram', 'sms'] },
  // Va última y se nombra sin ambigüedad: es la excepción, no una opción más.
  { valor: 'ninguno', titulo: 'Desactivado — lo pidió el abonado', canales: [] },
]

/** De lo guardado a la opción de la lista. */
export function combinacionDe(canales) {
  if (canales == null) return null
  if (!canales.length) return 'ninguno'

  const buscada = [...canales].sort().join('+')
  const encontrada = COMBINACIONES_FACTURA.find(
    (c) => c.canales?.length && [...c.canales].sort().join('+') === buscada,
  )
  // Una combinación cargada a mano que no está en la lista no se pierde ni se
  // reescribe: se muestra como "por donde se pueda" solo si no se reconoce.
  return encontrada?.valor ?? null
}

/** De la opción elegida a lo que se guarda. */
export function canalesDeCombinacion(valor) {
  if (valor === null || valor === '') return null
  return COMBINACIONES_FACTURA.find((c) => c.valor === valor)?.canales ?? null
}

/**
 * Desde cuándo se le muestra la pantalla de aviso.
 *
 * Es un rango, no un día puntual: la pantalla no es un mensaje que se manda una
 * vez, es un estado que dura hasta el vencimiento. Por eso los textos dicen
 * "desde" y no "el día".
 */
export const OPCIONES_PANTALLA = [
  { valor: '', titulo: 'No mostrarle nada antes del corte' },
  { valor: -10, titulo: 'Desde 10 días antes de vencer' },
  { valor: -7, titulo: 'Desde 7 días antes de vencer' },
  { valor: -5, titulo: 'Desde 5 días antes de vencer' },
  { valor: -3, titulo: 'Desde 3 días antes de vencer' },
  { valor: -2, titulo: 'Desde 2 días antes de vencer' },
  { valor: -1, titulo: 'Desde 1 día antes de vencer' },
  { valor: 0, titulo: 'Desde el día del vencimiento' },
]

/** El mismo texto que la lista, para un valor cualquiera. */
export function describirDias(n) {
  if (n === '' || n == null) return 'usa el valor general'

  const d = Number(n)
  if (!Number.isFinite(d)) return 'sin definir'
  if (d === 0) return 'el mismo día del vencimiento'

  const cuantos = Math.abs(d)
  const plural = cuantos === 1 ? 'día' : 'días'
  return d < 0 ? `${cuantos} ${plural} antes de vencer` : `${cuantos} ${plural} después de vencer`
}

/**
 * Si los tres avisos están en un orden que tenga sentido.
 *
 * ── Por qué esto hace falta aunque los días se elijan de una lista ──
 *
 * Porque la lista impide escribir mal un número, no ponerlos en desorden. Y el
 * desorden no da error: la regla que decide el nivel pregunta primero por el
 * 3, después por el 2 y después por el 1, así que si el 2 quedara más tarde que
 * el 3, el nivel 2 NUNCA se alcanzaría. Ese aviso simplemente no se manda, y no
 * hay nada en ninguna pantalla que lo diga.
 *
 * Recibe los días EFECTIVOS —los del abonado o los generales— porque el
 * problema es del resultado, no de dónde salió cada número.
 */
export function avisosEnOrden({ dias1, dias2, dias3 }) {
  const problemas = []
  const n = (v) => (v === '' || v == null ? null : Number(v))

  const d1 = n(dias1)
  const d2 = n(dias2)
  const d3 = n(dias3)

  if (d1 != null && d2 != null && d1 >= d2) {
    problemas.push(
      'El segundo aviso tiene que ir después del primero. Como están, el segundo no se va a mandar nunca.',
    )
  }
  if (d2 != null && d3 != null && d2 >= d3) {
    problemas.push(
      'El último aviso tiene que ir después del segundo. Como están, el segundo no se va a mandar nunca.',
    )
  }
  if (d1 != null && d3 != null && d1 >= d3) {
    problemas.push(
      'El último aviso tiene que ir después del primero. Como están, el primero no se va a mandar nunca.',
    )
  }

  return problemas
}
