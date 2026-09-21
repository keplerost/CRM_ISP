import { db } from '../lib/db.js'

/**
 * La conciliación bancaria.
 *
 * ── Qué pregunta responde ──
 *
 * "¿La plata que dice el sistema entró de verdad?" Alguien registró un cobro con
 * un número de comprobante que le dictó el abonado por WhatsApp. Este proceso
 * busca ese número en el extracto del banco y contesta una de tres cosas:
 *
 *   CONCILIADO       está en los dos, por el mismo monto.
 *   SIN RESPALDO     el sistema lo tiene, el banco no. Es plata que se dio por
 *                    cobrada y no entró: hay que llamar al abonado.
 *   NO REGISTRADO    el banco lo tiene, el sistema no. Alguien transfirió y
 *                    nadie le acreditó el pago; ese abonado va camino al corte
 *                    habiendo pagado.
 *
 * Los tres importan. Un informe que solo muestre lo que falta en el banco deja
 * pasar el segundo caso, que es el que genera el reclamo más caro.
 *
 * ── Qué cobros entran en la comparación ──
 *
 * Solo los que deberían aparecer en ESA cuenta. Los cobros en efectivo no van a
 * ningún extracto: incluirlos haría que la caja de la oficina entera figure como
 * "sin respaldo" todos los días, y un informe que grita siempre deja de leerse.
 */

/** Solo los dígitos: el abonado dicta "Doc. 116415212" y el banco guarda el número. */
export const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '')

/**
 * El nombre que viaja en el concepto del banco.
 *
 * "TRANSF. DIRECTA DE ESPIN CAMPAÑA ANGEL" trae quién transfirió, y es lo único
 * que permite ponerle nombre a un depósito que nadie registró. No siempre está
 * —un depósito en ventanilla dice solo "DEP CNB" y el RUC del corresponsal— y en
 * ese caso se devuelve vacío en vez de inventar.
 */
export function nombreDelConcepto(concepto) {
  const m = String(concepto ?? '').match(/\bDE\s+(.{3,})$/i)
  return m ? m[1].trim() : ''
}

/** Las formas de pago que dejan rastro en un banco. */
const ELECTRONICAS = ['transferencia', 'deposito', 'depósito', 'tarjeta']

/**
 * Compara el extracto contra lo cobrado.
 *
 * `movimientos` viene de `leerExtracto`. El rango de fechas sale del propio
 * extracto —no se pide aparte— para que nadie compare el archivo de julio contra
 * los cobros de agosto y reciba doscientos falsos faltantes.
 */
export async function conciliar({ movimientos = [], cuenta = null, margen = 0.01 } = {}) {
  const entradas = movimientos.filter((m) => m.entrada)

  if (!entradas.length) {
    return {
      periodo: null,
      conciliados: [],
      sin_respaldo: [],
      no_registrados: [],
      monto_distinto: [],
      totales: { banco: 0, sistema: 0, conciliado: 0, sin_respaldo: 0, no_registrado: 0 },
      aviso: 'El extracto no tiene créditos: no hay nada que conciliar.',
    }
  }

  const fechas = entradas.map((m) => m.fecha).sort()
  const desde = fechas[0]
  const hasta = fechas[fechas.length - 1]

  // --- Lo que dice el sistema ------------------------------------------------
  let q = db()
    .from('v_transacciones')
    .select('*')
    .gte('fecha_pago', desde)
    .lte('fecha_pago', hasta)
    .eq('anulado', false)

  /**
   * Si se eligió cuenta, esa manda. Si no, se comparan las formas de pago que
   * dejan rastro bancario.
   *
   * La cuenta es lo correcto y hay que empujar a usarla: dos cuentas del mismo
   * banco conciliadas juntas dan cruces que parecen buenos y no lo son.
   */
  if (cuenta) q = q.eq('cuenta_id', cuenta)
  else q = q.in('forma_pago', ELECTRONICAS)

  const { data: cobros, error } = await q.limit(5000)
  if (error) throw new Error(`No se pudieron leer los cobros: ${error.message}`)

  // --- El cruce --------------------------------------------------------------
  /**
   * Por número de documento.
   *
   * Es el único dato que identifica un movimiento sin ambigüedad. Cruzar por
   * monto y fecha parece razonable hasta que dos abonados del mismo plan pagan
   * $23,10 el mismo día: ahí el cruce elige cualquiera de los dos y el informe
   * queda bien mientras la plata de uno se le acredita al otro.
   */
  const porDocumento = new Map()
  for (const m of entradas) {
    const clave = soloDigitos(m.documento)
    if (!clave) continue
    if (!porDocumento.has(clave)) porDocumento.set(clave, [])
    porDocumento.get(clave).push(m)
  }

  const conciliados = []
  const sinRespaldo = []
  const montoDistinto = []
  const usados = new Set()

  for (const c of cobros ?? []) {
    const clave = soloDigitos(c.n_transaccion)

    if (!clave) {
      /**
       * Un cobro sin número de comprobante no se puede conciliar.
       *
       * No es lo mismo que "no está en el banco": no hay con qué buscarlo. Va
       * a la lista de sin respaldo con el motivo dicho, porque es lo que hay que
       * corregir —el cajero no anotó el número— y no un problema del abonado.
       */
      sinRespaldo.push({ ...c, motivo: 'sin número de comprobante' })
      continue
    }

    const candidatos = (porDocumento.get(clave) ?? []).filter((m) => !usados.has(m))

    if (!candidatos.length) {
      sinRespaldo.push({ ...c, motivo: 'no aparece en el extracto' })
      continue
    }

    // Con varios del mismo número, el del monto más parecido.
    const elegido = candidatos.reduce((mejor, m) =>
      Math.abs(m.monto - Number(c.cobrado)) < Math.abs(mejor.monto - Number(c.cobrado)) ? m : mejor,
    )
    usados.add(elegido)

    const diferencia = Number((elegido.monto - Number(c.cobrado)).toFixed(2))

    if (Math.abs(diferencia) > margen) {
      /**
       * Mismo comprobante, distinto monto.
       *
       * Es su propia categoría a propósito: contarlo como conciliado esconde una
       * diferencia de plata, y contarlo como faltante manda a llamar a un abonado
       * que sí pagó. Lo que hay que hacer es corregir el monto registrado.
       */
      montoDistinto.push({ ...c, banco: elegido, diferencia })
      continue
    }

    conciliados.push({ ...c, banco: elegido })
  }

  // --- Lo que el banco tiene y el sistema no --------------------------------
  const noRegistrados = entradas
    .filter((m) => !usados.has(m))
    .map((m) => ({
      ...m,
      // Lo que se pueda saber de quién fue: es por dónde empieza la búsqueda.
      probable_nombre: nombreDelConcepto(m.concepto),
    }))

  const suma = (lista, campo) =>
    Number(lista.reduce((s, x) => s + Number(x[campo] ?? 0), 0).toFixed(2))

  return {
    periodo: { desde, hasta },
    conciliados,
    sin_respaldo: sinRespaldo,
    no_registrados: noRegistrados,
    monto_distinto: montoDistinto,
    totales: {
      banco: suma(entradas, 'monto'),
      sistema: suma(cobros ?? [], 'cobrado'),
      conciliado: suma(conciliados, 'cobrado'),
      sin_respaldo: suma(sinRespaldo, 'cobrado'),
      no_registrado: suma(noRegistrados, 'monto'),
      diferencia_montos: suma(montoDistinto, 'diferencia'),
    },
    movimientos_banco: entradas.length,
    cobros_sistema: (cobros ?? []).length,
  }
}

/**
 * A quién hay que llamar.
 *
 * Los datos de contacto no vienen en `v_transacciones` —no hacen falta para
 * cuadrar caja— y sin ellos la lista de faltantes obliga a abrir la ficha de cada
 * uno. Se piden acá, una sola vez para todos.
 */
export async function conDatosDeContacto(cobros = []) {
  const ids = [...new Set(cobros.map((c) => c.client_id).filter(Boolean))]
  if (!ids.length) return cobros

  const { data } = await db()
    .from('clientes')
    .select('id, codigo, nombre, telefono_movil, telefono, email, zona')
    .in('id', ids)

  const porId = new Map((data ?? []).map((c) => [c.id, c]))

  return cobros.map((c) => {
    const ficha = porId.get(c.client_id)
    return {
      ...c,
      codigo: ficha?.codigo ?? null,
      telefono: ficha?.telefono_movil || ficha?.telefono || null,
      email: ficha?.email ?? null,
      zona: ficha?.zona ?? null,
    }
  })
}
