import { db } from '../lib/db.js'
import { fechaLocal } from './cortesPromesas.js'

/**
 * Las tres tareas de comisiones: refrescar los hitos, medir las cohortes y
 * cerrar el mes.
 *
 * ── Por qué son tres cosas en la misma tarea ──
 *
 * Porque cada una depende de la anterior y separarlas invita a que se ejecuten
 * en el orden equivocado. Cerrar un período sin haber refrescado los hitos
 * congelaría números viejos, y eso no se puede deshacer: un período cerrado es
 * lo que se le paga a alguien.
 *
 * ── Por qué las cohortes se miden todos los días ──
 *
 * Porque el tablero del vendedor muestra a quién tiene que ir a buscar antes de
 * que se pierda —"4 clientes de tu cartera no renovaron"—, y esa lista sirve
 * mientras se pueda hacer algo. Medida una sola vez al cerrar, llegaría tres
 * meses tarde y solo para informar del daño.
 *
 * ── Por qué el cierre no corre todos los días ──
 *
 * Corre todos los días, pero solo hace algo el día de cierre configurado. La
 * alternativa —un temporizador mensual— se desfasa con los reinicios y con los
 * cambios de horario, y el mes que no dispara nadie se entera hasta que un
 * vendedor pregunta por qué no le pagaron.
 *
 * ── Lo que esta tarea NO hace ──
 *
 * Aprobar ni pagar. Cierra el período y ahí se detiene: autorizar el gasto es
 * una decisión de una persona con permiso, no de un reloj.
 */

export const estadoComisiones = {
  automaticas: false,
  hora: '03:30',
  ultimaCorrida: null,
  ultimoResultado: null,
}

/** ¿Ya pasó la hora de hoy? Misma lógica que cortes y facturación. */
function llegoLaHora(ahora, hora) {
  const [h, m] = String(hora ?? '03:30')
    .split(':')
    .map(Number)
  return ahora.getHours() > h || (ahora.getHours() === h && ahora.getMinutes() >= m)
}

/** El período que corresponde cerrar hoy: el mes anterior. */
function mesAnterior(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth() - 1, 1)
  const p = (n) => String(n).padStart(2, '0')
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-01`
}

/**
 * Una corrida: refresca los hitos y, si es el día, cierra el mes anterior.
 *
 * El cierre se le pide a la base sin `p_forzar`, así que si todavía no llegó la
 * fecha la propia función lo rechaza. Es a propósito: la regla de cuándo se
 * puede cerrar vive en un solo lugar, y no en dos que se pueden contradecir.
 */
export async function ejecutarComisiones({ hoy = new Date() } = {}) {
  const resultado = { generadas: null, cohortes: null, cierre: null, aviso: null }

  // Los avisos se acumulan en vez de pisarse: si las cohortes fallaron Y además
  // todavía no es día de cierre, las dos cosas importan y quedarse con la última
  // esconde la que sí era un error.
  const avisar = (texto) => {
    resultado.aviso = resultado.aviso ? `${resultado.aviso} · ${texto}` : texto
  }

  const { data: gen, error: eGen } = await db().rpc('generar_comisiones')
  if (eGen) throw new Error(`No se pudieron refrescar las comisiones: ${eGen.message}`)
  resultado.generadas = gen?.[0] ?? gen

  // Las cohortes se miden después de los hitos: una venta que recién hoy se
  // volvió comisionable entra a su cohorte en esta misma corrida.
  //
  // Que esto falle no aborta el cierre. Son cosas distintas —la calidad es un
  // bono, la comisión es el sueldo— y dejar sin cerrar el mes porque no se pudo
  // medir una cohorte sería cambiar un problema chico por uno grande.
  const { data: coh, error: eCoh } = await db().rpc('evaluar_cohortes')
  if (eCoh) {
    avisar(`Las cohortes no se pudieron medir: ${eCoh.message}`)
  } else {
    const filas = coh ?? []
    resultado.cohortes = {
      evaluadas: filas.length,
      cerradas: filas.filter((c) => c.res_estado === 'cerrada').length,
    }
  }

  // ¿Toca cerrar? Lo dice la configuración, no un número acá.
  const { data: reglas } = await db()
    .from('v_comision_esquema')
    .select('dia_cierre')
    .eq('activo', true)
    .maybeSingle()

  const diaCierre = reglas?.dia_cierre ?? 5
  if (hoy.getDate() < diaCierre) {
    avisar(`El cierre corre el día ${diaCierre}; hoy es ${hoy.getDate()}.`)
    return resultado
  }

  const periodo = mesAnterior(hoy)
  const { data: cierre, error: eCierre } = await db().rpc('cerrar_periodo_comisiones', {
    p_periodo: periodo,
  })

  if (eCierre) {
    // Que el cierre falle no invalida el refresco de hitos, que sí sirvió.
    avisar(`El cierre de ${periodo} no se pudo hacer: ${eCierre.message}`)
    return resultado
  }

  resultado.cierre = { periodo, vendedores: cierre ?? [] }
  return resultado
}

/**
 * Arranca la tarea diaria.
 *
 * Se revisa cada pocos minutos en vez de programar un temporizador de 24 horas,
 * por lo mismo que el corte de morosos: un `setTimeout` largo se desfasa con la
 * suspensión del equipo y basta un reinicio para que nunca dispare.
 */
export function programarComisiones({
  activo = false,
  hora = '03:30',
  intervaloMs = 5 * 60 * 1000,
  ejecutar = ejecutarComisiones,
} = {}) {
  estadoComisiones.automaticas = activo
  estadoComisiones.hora = hora

  if (!activo) return null

  const revisar = async () => {
    const ahora = new Date()
    const hoy = fechaLocal(ahora)

    if (estadoComisiones.ultimaCorrida === hoy) return
    if (!llegoLaHora(ahora, hora)) return

    estadoComisiones.ultimaCorrida = hoy
    try {
      const r = await ejecutar({ hoy: ahora })
      estadoComisiones.ultimoResultado = r
      const g = r.generadas ?? {}
      console.log(
        `[comisiones] ${g.creadas ?? 0} nuevas, ${g.actualizadas ?? 0} actualizadas, ` +
          `${g.comisionables ?? 0} comisionables` +
          (r.cohortes
            ? ` · ${r.cohortes.evaluadas} cohortes medidas, ${r.cohortes.cerradas} cerradas`
            : '') +
          (r.cierre ? ` · cerró ${r.cierre.periodo} para ${r.cierre.vendedores.length} vendedores` : '') +
          (r.aviso ? ` · ${r.aviso}` : ''),
      )
    } catch (err) {
      estadoComisiones.ultimoResultado = { error: err.message }
      console.error(`[comisiones] la corrida falló: ${err.message}`)
      // Se libera la marca para reintentar en el próximo tick: un error de red
      // no puede dejar el mes sin cerrar.
      estadoComisiones.ultimaCorrida = null
    }
  }

  const temporizador = setInterval(revisar, intervaloMs)
  temporizador.unref?.()
  revisar()

  return temporizador
}
