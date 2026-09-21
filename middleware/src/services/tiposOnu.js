import { db } from '../lib/db.js'
import { badRequest, AppError } from '../lib/errors.js'

/**
 * Los tipos de ONU: qué sabe el sistema de cada modelo de equipo.
 *
 * Es global, no por OLT: un EG8145V5 tiene cuatro puertos y dos SSIDs
 * independientemente de dónde esté colgado. Tenerlo por equipo obligaría a
 * cargar lo mismo tantas veces como OLTs haya, y a que se contradigan.
 *
 * Sirve para tres cosas concretas:
 *
 *   al autorizar     propone el service-profile por el modelo que reportó la ONT
 *   por TR069        dice qué nodos del árbol existen en ese modelo
 *   ficha manual     dice si tiene WiFi y cuántas redes, para no mandar al
 *                    técnico a configurar algo que el equipo no tiene
 */

const CANALES = ['GPON', 'XG-PON', 'XGS-PON']

/** Cómo se llaman los nodos del árbol TR069 en la mayoría de los modelos. */
const PREFIJOS = { prefijo_eth: 'eth_0/', prefijo_wifi: 'wifi_0/', prefijo_voip: 'pots_0/' }

const aTexto = (v) => {
  const s = String(v ?? '').trim()
  return s === '' ? null : s
}
const aEntero = (v, def = 0) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def
}

export async function listar() {
  const { data, error } = await db()
    .from('v_tipos_ont')
    .select('*')
    .order('marca')
    .order('modelo')

  if (error) throw new AppError(error.message, { status: 400 })

  const tipos = data ?? []
  return {
    tipos,
    resumen: {
      total: tipos.length,
      en_uso: tipos.filter((t) => t.onus > 0).length,
      sin_usar: tipos.filter((t) => !t.onus).length,
      // Los que todavía no se sabe si aceptan configuración remota. Es la lista
      // que se va vaciando sola a medida que se instalan.
      sin_probar: tipos.filter((t) => t.soporta_tr069 == null).length,
    },
  }
}

/** Los campos, validados. Se usa igual al crear y al editar. */
function normalizar(datos, { parcial = false } = {}) {
  const c = {}

  if (!parcial || 'modelo' in datos) {
    const modelo = aTexto(datos.modelo)
    if (!modelo) throw badRequest('Falta el modelo')
    c.modelo = modelo
  }
  if (!parcial || 'marca' in datos) c.marca = aTexto(datos.marca) ?? 'Genérica'

  if (!parcial || 'pon_tipo' in datos) {
    c.pon_tipo = datos.pon_tipo === 'EPON' ? 'EPON' : 'GPON'
  }

  if (!parcial || 'canales' in datos) {
    const pedidos = Array.isArray(datos.canales) ? datos.canales : [datos.canales]
    const validos = pedidos.filter((x) => CANALES.includes(x))
    // Sin canal no se puede autorizar: al dar de alta hay que decirle al equipo
    // por cuál. Se cae al GPON en vez de guardar una lista vacía.
    c.canales = validos.length ? validos : ['GPON']
  }

  if (!parcial || 'puertos_ethernet' in datos) c.puertos_ethernet = aEntero(datos.puertos_ethernet)
  if (!parcial || 'wifi_ssids' in datos) c.wifi_ssids = aEntero(datos.wifi_ssids)
  if (!parcial || 'puertos_fxs' in datos) c.puertos_fxs = aEntero(datos.puertos_fxs)
  if (!parcial || 'catv' in datos) c.catv = aEntero(datos.catv)

  // El booleano viejo se mantiene al día solo: hay código que todavía lo mira,
  // y dejarlo desactualizado haría que una ONT con WiFi figure sin él.
  if ('wifi_ssids' in c) c.wifi = c.wifi_ssids > 0

  if (!parcial || 'perfiles_propios' in datos) c.perfiles_propios = datos.perfiles_propios !== false
  // Se acepta pero no se usa, y conviene dejarlo en null: un ID de perfil es
  // local a una OLT —el perfil 7 de una no es el perfil 7 de otra— y este
  // catálogo es global. El srv-profile se resuelve por nombre contra cada
  // equipo en `oltFicha.js`, que es lo que hace que un modelo registrado una
  // vez sirva para todas las OLTs. Ver `docs/integracion-equipos.md` 3.1.
  if (!parcial || 'perfil_default_id' in datos) c.perfil_default_id = datos.perfil_default_id || null

  if (!parcial || 'capacidad' in datos) {
    c.capacidad = datos.capacidad === 'bridging' ? 'bridging' : 'bridging_routing'
  }

  // Los prefijos del árbol TR069 tienen un valor por defecto que sirve para la
  // mayoría de los modelos. Al crear se usa ese si no vino nada: escribir null
  // explícito pisaba el DEFAULT de la columna y el tipo quedaba sin prefijos,
  // con lo cual el ACS no sabría por qué rama preguntar.
  //
  // Al editar sí se respeta lo que mandan, incluso vacío: alguien puede querer
  // borrarlo a propósito para un modelo que no los usa.
  for (const [k, porDefecto] of Object.entries(PREFIJOS)) {
    if (k in datos) c[k] = aTexto(datos[k])
    else if (!parcial) c[k] = porDefecto
  }

  for (const k of ['vendor_id', 'version_spec', 'imagen_url', 'notas']) {
    if (!parcial || k in datos) c[k] = aTexto(datos[k])
  }

  if ('soporta_tr069' in datos) {
    // Los tres estados se conservan: null es "no se sabe", que no es lo mismo
    // que "no soporta". Convertirlo a booleano perdería esa diferencia.
    c.soporta_tr069 = datos.soporta_tr069 == null ? null : Boolean(datos.soporta_tr069)
  }

  if ('parametros' in datos) c.parametros = datos.parametros ?? null

  return c
}

export async function crear(datos) {
  const fila = normalizar(datos)

  const { data, error } = await db().from('tipos_ont').insert(fila).select('*').single()
  if (error) {
    throw new AppError(
      error.code === '23505'
        ? `Ya existe un tipo ${fila.marca} ${fila.modelo}. Editá ese en vez de crear otro: dos tipos con el mismo modelo hacen que la propuesta al autorizar dependa de cuál se lea primero.`
        : error.message,
      { status: 400 },
    )
  }
  return data
}

export async function editar(id, datos) {
  const fila = { ...normalizar(datos, { parcial: true }), updated_at: new Date().toISOString() }

  const { data, error } = await db()
    .from('tipos_ont')
    .update(fila)
    .eq('id', id)
    .select('*')
    .maybeSingle()

  if (error) throw new AppError(error.message, { status: 400 })
  if (!data) throw badRequest('Ese tipo de ONU no existe')
  return data
}

/**
 * Borra un tipo.
 *
 * Se niega si hay ONUs usándolo. Borrarlo las deja sin modelo, y con eso se
 * pierden dos cosas: la propuesta de service-profile al autorizar otra igual, y
 * el dato de si el equipo tiene WiFi — que es lo que decide qué se le pide al
 * técnico en la ficha manual.
 */
export async function borrar(id, { forzar = false } = {}) {
  const { data: tipo } = await db().from('v_tipos_ont').select('*').eq('id', id).maybeSingle()
  if (!tipo) throw badRequest('Ese tipo de ONU no existe')

  if (tipo.onus > 0 && !forzar) {
    throw new AppError(`El tipo ${tipo.marca} ${tipo.modelo} lo usan ${tipo.onus} ONUs`, {
      status: 409,
      hint: 'Borrarlo las deja sin modelo. Confirmá si querés hacerlo igual.',
      onus_enlazadas: tipo.onus_enlazadas,
      onus_por_modelo: tipo.onus_por_modelo,
    })
  }

  const { error } = await db().from('tipos_ont').delete().eq('id', id)
  if (error) throw new AppError(error.message, { status: 400 })
  return { borrado: true, marca: tipo.marca, modelo: tipo.modelo, onus_afectadas: tipo.onus }
}

/**
 * Crea los tipos de los modelos que las ONUs ya reportaron y nadie cargó.
 *
 * Es lo que evita empezar de cero: los equipos ya dijeron qué son. Lo que el
 * sistema no puede saber —cuántos puertos, si tiene WiFi— queda en los valores
 * por defecto y se corrige a mano, que es mucho menos trabajo que cargarlos
 * todos.
 */
export async function importarDeLasOnus({ aplicar = false } = {}) {
  const [{ data: onus }, { data: tipos }] = await Promise.all([
    db().from('onus').select('modelo').not('modelo', 'is', null),
    db().from('tipos_ont').select('modelo'),
  ])

  const yaEstan = new Set((tipos ?? []).map((t) => String(t.modelo).toUpperCase()))

  // Se agrupa sin distinguir mayúsculas: este equipo reporta el mismo modelo
  // como "H3-1s" y "H3-1S" según la ONT, y crear dos tipos para el mismo
  // aparato significa cargarle la foto y los puertos dos veces — y que la mitad
  // de los abonados no muestre nada porque quedó enganchada al otro.
  //
  // Se conserva la grafía más frecuente, que es la que más chances tiene de ser
  // la que imprime el fabricante.
  const cuenta = new Map()
  for (const o of onus ?? []) {
    const m = String(o.modelo).trim()
    if (!m || yaEstan.has(m.toUpperCase())) continue

    const clave = m.toUpperCase()
    const g = cuenta.get(clave) ?? { grafias: new Map(), onus: 0 }
    g.onus++
    g.grafias.set(m, (g.grafias.get(m) ?? 0) + 1)
    cuenta.set(clave, g)
  }

  const propuestas = [...cuenta.values()]
    .map((g) => {
      const modelo = [...g.grafias].sort((a, b) => b[1] - a[1])[0][0]
      return {
        modelo,
        onus: g.onus,
        marca: marcaDe(modelo),
        // Las otras formas en que el equipo lo escribe. Se informan porque
        // explican por qué un tipo cuenta más ONUs de las que uno esperaría.
        ...(g.grafias.size > 1 ? { otras_grafias: [...g.grafias.keys()].filter((x) => x !== modelo) } : {}),
      }
    })
    .sort((a, b) => b.onus - a.onus)

  if (!aplicar) return { propuestas, total: propuestas.length }

  const resultados = []
  for (const p of propuestas) {
    try {
      const t = await crear({ modelo: p.modelo, marca: p.marca })
      resultados.push({ modelo: p.modelo, hecho: true, id: t.id })
    } catch (e) {
      resultados.push({ modelo: p.modelo, hecho: false, motivo: e.message })
    }
  }

  return {
    propuestas,
    creados: resultados.filter((r) => r.hecho).length,
    fallidos: resultados.filter((r) => !r.hecho),
  }
}

/**
 * La marca, deducida del modelo.
 *
 * Es una suposición y se puede corregir a mano. Vale la pena igual: acertar en
 * la mayoría ahorra escribir la marca treinta veces, y equivocarse en una es un
 * campo que se edita.
 */
function marcaDe(modelo) {
  const m = String(modelo).toUpperCase()
  if (/^(HG|EG|HN|MA)\d/.test(m) || m.startsWith('HW')) return 'Huawei'
  if (/^(F6|F8|ZXHN)/.test(m)) return 'ZTE'
  if (/^(V\d|HG3|DBC)/.test(m)) return 'V-SOL'
  if (/^AN\d/.test(m)) return 'Fiberhome'
  if (/^(HS|HK|H\d-)/.test(m)) return 'Nokia'
  return 'Genérica'
}
