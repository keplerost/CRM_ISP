import { db } from '../lib/db.js'
import { badRequest, AppError } from '../lib/errors.js'

/**
 * Cajas NAP: proponerlas, crearlas y saber cuántas bocas quedan.
 *
 * El sistema NO puede saber de qué caja cuelga un abonado. Los splitters son
 * pasivos: la OLT ve lo mismo con una caja que con cinco. Lo único que se puede
 * hacer es proponer agrupaciones a partir de lo que sí se sabe, y que una
 * persona las confirme.
 *
 * Por eso todo lo de acá habla de PROPUESTAS y guarda cómo se supo cada cosa. Un
 * mapa deducido que se presenta como verificado es peor que no tener mapa: se
 * manda una instalación a una caja que se creía con lugar y no lo tiene.
 */

/**
 * Cuánto pueden separarse dos abonados de la misma caja, en metros.
 *
 * 200 salió de mirar las distancias reales de este equipo: dentro de una misma
 * caja los abonados se separan entre 0 y 105 m —lo que miden sus acometidas— y
 * entre una caja y la siguiente hay saltos de 213, 269, 295, 414, 471 m. El
 * corte cae en el medio de esos dos mundos.
 *
 * Es ajustable porque no es una constante de la física: en una zona urbana con
 * las cajas cada media cuadra habría que bajarlo.
 */
const SALTO_METROS = 200

/**
 * Normaliza una dirección para poder comparar dos escrituras de la misma.
 *
 * NO se usa para agrupar. Se probó y estaba mal: en esta red la "dirección" que
 * cargó el sistema anterior es el nombre del recinto —"Selvalegre", "San
 * Antonio de Manguila"— y abarca kilómetros. Agrupando por ahí, seis abonados
 * de la misma caja quedaban separados y dos que están a 1700 m juntos.
 *
 * Sirve para NOMBRAR la caja propuesta y para mostrar qué dice cada abonado,
 * que es donde el texto sí ayuda: si en un grupo todos dicen "Pueblo Arrecho"
 * menos uno, ese uno merece una mirada.
 */
const normalizarDireccion = (t) =>
  String(t ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()

/** La dirección que más se repite en un grupo. Es la que mejor lo nombra. */
function direccionDominante(lista) {
  const cuenta = new Map()
  for (const o of lista) {
    if (!o.direccion) continue
    const k = normalizarDireccion(o.direccion)
    cuenta.set(k, (cuenta.get(k) ?? 0) + 1)
  }
  if (!cuenta.size) return null
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

/**
 * Arma los grupos candidatos. Sin base de datos: solo las ONUs que se le pasan.
 *
 * Agrupa por PUERTO PON y por DISTANCIA, nada más. La OLT mide a qué distancia
 * está cada ONT con precisión de metros, y los abonados de una misma caja
 * comparten el tramo de fibra: están todos a la misma distancia salvo por lo
 * que mide su acometida.
 *
 * Está aparte para poder probarla. Es la parte del sistema que más se parece a
 * una adivinanza, y lo único que la separa de una es que las reglas estén
 * escritas y fijadas.
 */
export function agruparEnCajas(onus, { saltoMetros = SALTO_METROS } = {}) {
  const porPuerto = new Map()
  for (const o of onus) {
    const clave = `${o.slot}|${o.puerto}`
    if (!porPuerto.has(clave)) porPuerto.set(clave, [])
    porPuerto.get(clave).push(o)
  }

  const propuestas = []

  for (const [clave, lista] of porPuerto) {
    const [slot, puerto] = clave.split('|').map(Number)

    const conDistancia = lista
      .filter((o) => o.distancia_m != null)
      .sort((a, b) => a.distancia_m - b.distancia_m)
    // Sin distancia no se puede ubicar a nadie. Van a un grupo aparte en vez de
    // caer en cualquiera: meterlas con las otras diría que ocupan una boca de
    // una caja en la que quizá no están.
    const sinDistancia = lista.filter((o) => o.distancia_m == null)

    const tramos = []
    let actual = []
    let saltoEntrada = null
    const saltos = []

    for (const o of conDistancia) {
      if (actual.length) {
        const salto = o.distancia_m - actual[actual.length - 1].distancia_m
        if (salto > saltoMetros) {
          tramos.push({ onus: actual, saltoEntrada, saltoSalida: salto })
          saltoEntrada = salto
          actual = []
        }
      }
      actual.push(o)
    }
    if (actual.length) tramos.push({ onus: actual, saltoEntrada, saltoSalida: null })
    if (sinDistancia.length) tramos.push({ onus: sinDistancia, saltoEntrada: null, saltoSalida: null })

    tramos.forEach((tramo, i) => {
      const ds = tramo.onus.map((o) => o.distancia_m).filter((d) => d != null)
      const spread = ds.length ? Math.max(...ds) - Math.min(...ds) : null
      const dominante = direccionDominante(tramo.onus)
      const direcciones = [...new Set(tramo.onus.map((o) => o.direccion).filter(Boolean))]

      propuestas.push({
        // La clave sale del primer abonado del grupo y no de su posición en la
        // lista: al aceptar una caja, las demás se recalculan y con un índice
        // posicional la pantalla terminaba abriendo el panel de otro grupo.
        clave: `${clave}|${tramo.onus[0].id}`,
        slot,
        puerto,
        direccion: dominante,
        // Todas las que escribieron sus abonados. Si en un grupo hay una sola
        // distinta, ése es el que conviene mirar.
        direcciones,
        zona: tramo.onus.find((o) => o.zona)?.zona ?? null,
        nombre_sugerido: `NAP ${puerto}-${i + 1}${dominante ? ` ${dominante.slice(0, 28)}` : ''}`.trim(),
        abonados: tramo.onus.length,
        distancia_min: ds.length ? Math.min(...ds) : null,
        distancia_max: ds.length ? Math.max(...ds) : null,
        spread_m: spread,
        // Cuánto lo separa de sus vecinos. Un grupo bien aislado es más creíble
        // que uno pegado al de al lado.
        salto_antes: tramo.saltoEntrada,
        salto_despues: tramo.saltoSalida,
        sin_distancia: ds.length === 0,

        confianza: confianzaDe({
          spread,
          cuantos: tramo.onus.length,
          tieneDistancias: ds.length > 0,
          aislamiento: Math.min(tramo.saltoEntrada ?? Infinity, tramo.saltoSalida ?? Infinity),
        }),

        onus: tramo.onus.map((o) => ({
          id: o.id,
          sn: o.sn,
          cliente: o.nombre_cliente,
          onu_index: o.onu_index,
          direccion: o.direccion,
          distancia_m: o.distancia_m,
          rx_power_dbm: o.rx_power_dbm,
        })),
      })
    })
  }

  return propuestas.sort((a, b) => a.puerto - b.puerto || b.abonados - a.abonados)
}

/**
 * Cajas candidatas de una OLT.
 *
 * El criterio es: mismo puerto PON + misma dirección + distancias juntas. Los
 * tres a la vez, porque ninguno alcanza solo:
 *
 *   - el puerto solo agrupa hasta 23 abonados de varias cajas
 *   - la dirección sola junta gente de dos puertos distintos
 *   - la distancia sola no distingue dos cajas a la misma distancia por vías
 *     diferentes
 *
 * Lo que se devuelve es material para revisar, con la evidencia a la vista: si
 * un grupo abarca 1200 metros, se marca como flojo para que nadie lo acepte de
 * un clic.
 */
export async function proponerCajas(oltId, { saltoMetros = SALTO_METROS } = {}) {
  const { data: onus, error } = await db()
    .from('onus')
    .select('id, sn, nombre_cliente, slot, puerto, onu_index, direccion, zona, distancia_m, rx_power_dbm, nap_id')
    .eq('olt_id', oltId)
    .order('puerto')

  if (error) throw new AppError(`No se pudieron leer las ONUs: ${error.message}`, { status: 500 })

  const sinAsignar = (onus ?? []).filter((o) => !o.nap_id)
  const propuestas = agruparEnCajas(sinAsignar, { saltoMetros })
  const sinDireccion = sinAsignar.filter((o) => !o.direccion)

  return {
    propuestas,
    resumen: {
      onus: (onus ?? []).length,
      ya_asignadas: (onus ?? []).length - sinAsignar.length,
      sin_asignar: sinAsignar.length,
      // Estas no se pueden proponer: hay que ir a verlas.
      sin_direccion: sinDireccion.length,
      propuestas: propuestas.length,
    },
    // Se listan para que no queden invisibles: son las que van a necesitar una
    // visita.
    sin_direccion: sinDireccion.map((o) => ({
      id: o.id,
      sn: o.sn,
      cliente: o.nombre_cliente,
      puerto: o.puerto,
      distancia_m: o.distancia_m,
    })),
  }
}

/**
 * Cuán creíble es que ese grupo sea UNA caja.
 *
 * La regla sale de lo que se ve en los datos: los abonados de una misma caja se
 * separan lo que miden sus acometidas —decenas de metros—. Cuando un grupo
 * abarca cientos, casi seguro son varias cajas sobre la misma vía.
 */
function confianzaDe({ spread, cuantos, tieneDistancias, aislamiento }) {
  if (!tieneDistancias) return { nivel: 'baja', motivo: 'ninguna tiene la distancia medida' }

  const aislada = Number.isFinite(aislamiento) ? ` y ${Math.round(aislamiento)} m de la caja vecina` : ''

  if (cuantos === 1) {
    // Un solo abonado no es una caja: puede serlo, o ser uno que quedó lejos de
    // sus vecinos. Se propone igual —hay cajas de un abonado— pero sin decir
    // que es probable.
    return { nivel: 'media', motivo: `un solo abonado${aislada}: puede ser una caja chica o faltar el resto` }
  }
  if (spread <= 150) {
    return { nivel: 'alta', motivo: `los ${cuantos} están dentro de ${spread} m${aislada}` }
  }
  if (spread <= 400) {
    return { nivel: 'media', motivo: `se separan ${spread} m: puede ser una caja grande o dos cercanas` }
  }
  return {
    nivel: 'baja',
    motivo: `se separan ${spread} m: casi seguro son varias cajas sobre la misma vía`,
  }
}

/** Las cajas ya cargadas, con su ocupación. */
export async function listarCajas(oltId) {
  let q = db().from('v_cajas_nap').select('*').order('puerto_pon').order('nombre')
  if (oltId) q = q.eq('olt_id', oltId)
  const { data, error } = await q
  if (error) throw new AppError(`No se pudieron leer las cajas: ${error.message}`, { status: 500 })
  return data ?? []
}

/**
 * Crea una caja y le cuelga los abonados.
 *
 * `origen` queda en "propuesta" salvo que se diga que se verificó en el poste.
 * Es lo que después distingue un número confiable de una deducción.
 */
export async function crearCaja(oltId, datos) {
  const { nombre, slot, puerto, capacidad, direccion, latitud, longitud, notas, onu_ids = [] } = datos

  if (!nombre?.trim()) throw badRequest('La caja necesita un nombre')
  if (puerto == null) throw badRequest('Falta el puerto PON del que cuelga la caja')

  const verificada = datos.verificada === true

  const { data: caja, error } = await db()
    .from('puntos_red')
    .insert({
      nombre: nombre.trim(),
      tipo: 'nap',
      olt_id: oltId,
      slot: slot ?? null,
      puerto_pon: String(puerto),
      capacidad: capacidad ?? null,
      direccion: direccion ?? null,
      latitud: latitud ?? null,
      longitud: longitud ?? null,
      notas: notas ?? null,
      origen: verificada ? 'campo' : 'propuesta',
      activo: true,
    })
    .select()
    .single()

  if (error) throw new AppError(`No se pudo crear la caja: ${error.message}`, { status: 400 })

  const asignadas = onu_ids.length ? await asignarOnus(caja.id, onu_ids, { verificada }) : 0
  return { ...caja, asignadas }
}

/** Cuelga ONUs de una caja. */
export async function asignarOnus(napId, onuIds, { verificada = false } = {}) {
  if (!onuIds?.length) return 0

  const { error, count } = await db()
    .from('onus')
    .update({ nap_id: napId, nap_origen: verificada ? 'campo' : 'propuesta' }, { count: 'exact' })
    .in('id', onuIds)

  if (error) throw new AppError(`No se pudieron asignar las ONUs: ${error.message}`, { status: 400 })
  return count ?? onuIds.length
}

/** Las saca de su caja. No las borra: solo deja de decir dónde están. */
export async function desasignarOnus(onuIds) {
  if (!onuIds?.length) return 0
  const { error, count } = await db()
    .from('onus')
    .update({ nap_id: null, nap_origen: null }, { count: 'exact' })
    .in('id', onuIds)
  if (error) throw new AppError(`No se pudieron desasignar: ${error.message}`, { status: 400 })
  return count ?? 0
}

export async function borrarCaja(napId) {
  // Las ONUs quedan sin caja, no se borran: el abonado sigue teniendo servicio.
  await db().from('onus').update({ nap_id: null, nap_origen: null }).eq('nap_id', napId)
  const { error } = await db().from('puntos_red').delete().eq('id', napId)
  if (error) throw new AppError(`No se pudo borrar la caja: ${error.message}`, { status: 400 })
  return { ok: true }
}

export async function actualizarCaja(napId, cambios) {
  const permitidos = ['nombre', 'capacidad', 'direccion', 'latitud', 'longitud', 'notas', 'activo', 'slot']
  const fila = {}
  for (const k of permitidos) if (k in cambios) fila[k] = cambios[k]
  if (cambios.verificada === true) fila.origen = 'campo'

  const { data, error } = await db()
    .from('puntos_red')
    .update(fila)
    .eq('id', napId)
    .select()
    .maybeSingle()

  if (error) throw new AppError(`No se pudo guardar: ${error.message}`, { status: 400 })
  return data
}
