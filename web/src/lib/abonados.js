/**
 * El listado de abonados: filtrar, medir antigüedad y exportar.
 *
 * Sin imports a propósito, igual que `comisionesCalculo.js`: son decisiones que
 * conviene poder probar sin levantar un navegador ni una base. La pantalla se
 * queda con lo que es de la pantalla —pintar y descargar— y acá vive lo que hay
 * que poder demostrar que está bien.
 *
 * ── Para qué existe el export ──
 *
 * Para contestar "¿a quién voy a visitar esta semana?". Un abonado suspendido
 * hace dos meses no se recupera solo: o se lo llama, o se le retira el equipo
 * antes de que se pase a la competencia con el equipo puesto. La lista tiene
 * que salir en un archivo que se abra en Excel y se reparta.
 */

/** 132 → 000132. Se lee y se dicta igual que en el sistema anterior. */
export const codigoLargo = (n) => (n == null ? '' : String(n).padStart(6, '0'))

/**
 * Meses cumplidos entre una fecha y hoy.
 *
 * Cumplidos, no redondeados: el que se suspendió el 30 de junio lleva un mes el
 * 30 de julio, no el 15. Redondear haría que una lista de "dos meses o más"
 * incluya gente de mes y medio, y esa lista se usa para ir a retirar equipos.
 */
export function mesesDesde(fecha, ahora = new Date()) {
  if (!fecha) return null
  const d = new Date(fecha)
  if (Number.isNaN(d.getTime())) return null

  let meses = (ahora.getFullYear() - d.getFullYear()) * 12 + (ahora.getMonth() - d.getMonth())
  if (ahora.getDate() < d.getDate()) meses -= 1
  return Math.max(0, meses)
}

/** Días cumplidos, para el que todavía no llegó al mes. */
export function diasDesde(fecha, ahora = new Date()) {
  if (!fecha) return null
  const d = new Date(fecha)
  if (Number.isNaN(d.getTime())) return null
  return Math.max(0, Math.floor((ahora - d) / 86400000))
}

/** "2 meses", "12 días", "hoy". Lo que se lee en la columna del listado. */
export function antiguedad(fecha, ahora = new Date()) {
  const meses = mesesDesde(fecha, ahora)
  if (meses == null) return '—'
  if (meses >= 1) return `${meses} ${meses === 1 ? 'mes' : 'meses'}`
  const dias = diasDesde(fecha, ahora)
  if (dias === 0) return 'hoy'
  return `${dias} ${dias === 1 ? 'día' : 'días'}`
}

/**
 * El estado del enlace, que no es lo mismo que el estado del abonado.
 *
 * `estado` es administrativo —si debe o no debe—; esto es si el equipo está
 * prendido. Sale de la ONU, así que solo lo tienen los de fibra: para los de
 * radio devuelve null y la pantalla muestra un guión, que es más honesto que
 * pintar "offline" un equipo del que no sabemos nada.
 */
export function enlace(cliente) {
  const e = cliente?.onu_estado
  if (!e) return null
  if (e === 'online') return { texto: 'online', color: 'verde' }
  if (e === 'offline') return { texto: 'offline', color: 'rojo' }
  return { texto: e, color: 'gris' }
}

/**
 * El filtro del listado. Todo lo vacío no filtra.
 *
 * `deuda` es el único que no compara contra un valor: es un sí o no. Vale
 * "si" para dejar solo a los que tienen saldo pendiente.
 *
 * Es saldo PENDIENTE, no saldo VENCIDO. La ficha del abonado trae el total
 * por cobrar —la suma de todas sus facturas con saldo, hayan vencido o no— y
 * no publica cuánto de eso está vencido. Distinguirlo pediría consultar las
 * facturas una por una, así que el filtro dice lo que de verdad puede decir.
 * Quien tiene deuda vencida está siempre adentro de este conjunto.
 */
export function filtrarAbonados(
  filas,
  { busqueda = '', estado = '', router = '', zona = '', plan = '', deuda = '' } = {},
) {
  const q = String(busqueda).trim().toLowerCase()

  return (filas ?? []).filter((c) => {
    if (estado && c.estado !== estado) return false
    if (deuda === 'si' && !(Number(c.saldo ?? 0) > 0)) return false
    if (router && String(c.router_id) !== String(router)) return false
    if (zona && (c.zona ?? '') !== zona) return false
    if (plan && String(c.plan_id) !== String(plan)) return false
    if (!q) return true

    // Se busca por lo que la gente tiene a mano cuando llama: el nombre, la
    // cédula, el número de abonado, su IP o su teléfono.
    return [
      c.nombre,
      c.identificacion,
      c.ip,
      c.mac_address,
      c.telefono,
      c.telefono_movil,
      c.direccion,
      c.zona,
      codigoLargo(c.codigo),
      String(c.codigo ?? ''),
    ]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q))
  })
}

/**
 * Los que entran en el archivo.
 *
 * Dos modos, porque son dos preguntas distintas:
 *
 *   ANTIGÜEDAD — "los que llevan dos meses o más suspendidos". Es la de
 *   gestionar: sale la lista de a quién visitar, del más viejo al más nuevo.
 *
 *   RANGO — "los que se suspendieron en junio". Es la de medir: cuántos se
 *   cayeron en un mes cerrado, para comparar con el siguiente.
 *
 * En los dos casos se mira `estado_desde`, que es cuándo quedó en el estado que
 * tiene hoy. Un abonado que se suspendió y volvió a pagar no aparece: su fecha
 * ya es la de cuando volvió a estar activo.
 */
export function seleccionarParaExportar(
  filas,
  { modo = 'antiguedad', estado = 'suspendido', meses = 2, desde = '', hasta = '' } = {},
  ahora = new Date(),
) {
  const conEstado = (filas ?? []).filter((c) => !estado || c.estado === estado)

  if (modo === 'rango') {
    // Las fechas vienen del <input type="date">: 'YYYY-MM-DD'. Se comparan como
    // texto contra los diez primeros caracteres del timestamp para no arrastrar
    // la zona horaria — un corte de las 23:40 no puede caer en el día siguiente
    // solo porque el navegador esté en otro huso.
    const d = String(desde ?? '').slice(0, 10)
    const h = String(hasta ?? '').slice(0, 10)
    return conEstado
      .filter((c) => {
        const f = String(c.estado_desde ?? '').slice(0, 10)
        if (!f) return false
        if (d && f < d) return false
        if (h && f > h) return false
        return true
      })
      .sort((a, b) => String(a.estado_desde).localeCompare(String(b.estado_desde)))
  }

  const minimo = Number(meses) || 0
  return conEstado
    .filter((c) => {
      const m = mesesDesde(c.estado_desde, ahora)
      return m != null && m >= minimo
    })
    // Del más viejo al más nuevo: el que más tiempo lleva es al que más urge ir.
    .sort((a, b) => String(a.estado_desde).localeCompare(String(b.estado_desde)))
}

/**
 * Todas las columnas que el listado sabe mostrar.
 *
 * ── Por qué un catálogo y no columnas escritas en la tabla ──
 *
 * Porque cada quien mira una cosa distinta: el que cobra quiere deuda y día de
 * pago, el que sale a instalar quiere caja NAP y coordenadas, y el que atiende
 * el teléfono quiere el móvil y el correo. Una sola tabla con las treinta
 * columnas no la lee nadie. Así cada uno arma la suya y queda guardada.
 *
 * `texto` devuelve SIEMPRE una cadena: es lo que va al CSV y lo que se busca.
 * Lo que se pinta distinto —el nombre es un enlace, el estado es una etiqueta—
 * lo resuelve la pantalla mirando la clave. Mezclar JSX acá haría que este
 * archivo dejara de poder probarse sin navegador.
 *
 * `extra` marca las que necesitan datos de facturación que no vienen en la
 * ficha: la pantalla los pide aparte y solo si alguna de esas está encendida.
 */
export const COLUMNAS_ABONADOS = [
  // ── Las de siempre ──────────────────────────────────────────────────────
  { clave: 'codigo', titulo: 'ID', grupo: 'principal', mono: true, texto: (c) => codigoLargo(c.codigo) },
  { clave: 'nombre', titulo: 'Nombre', grupo: 'principal', fija: true, texto: (c) => c.nombre ?? '' },
  { clave: 'direccion', titulo: 'Dirección principal', grupo: 'principal', ancho: true, texto: (c) => c.direccion ?? '' },
  { clave: 'ip', titulo: 'IP', grupo: 'principal', mono: true, texto: (c) => c.ip ?? '' },
  { clave: 'mac', titulo: 'MAC', grupo: 'principal', mono: true, texto: (c) => c.mac_address ?? '' },
  // `exacto` porque es un número corto: filtrar "5" por partes traería también
  // al que paga el 15 y al que paga el 25, y la lista del día 5 saldría mal.
  { clave: 'dia_pago', titulo: 'Día pago', grupo: 'principal', centro: true, exacto: true, texto: (c) => (c.dia_facturacion == null ? '' : String(c.dia_facturacion)) },
  { clave: 'deuda', titulo: 'Deuda actual', grupo: 'principal', derecha: true, texto: (c) => dosDecimales(c.saldo) },
  { clave: 'correo', titulo: 'Correo', grupo: 'principal', texto: (c) => c.email ?? '' },
  { clave: 'plan', titulo: 'Plan', grupo: 'principal', texto: (c) => c.plan ?? '' },
  { clave: 'movil', titulo: 'Teléfono móvil', grupo: 'principal', mono: true, texto: (c) => c.telefono_movil ?? '' },
  { clave: 'router', titulo: 'Router', grupo: 'principal', texto: (c) => c.router ?? '' },
  { clave: 'cedula', titulo: 'Cédula', grupo: 'principal', mono: true, texto: (c) => c.identificacion ?? '' },
  { clave: 'zona', titulo: 'Zona', grupo: 'principal', texto: (c) => c.zona ?? '' },
  { clave: 'estatus', titulo: 'Estatus', grupo: 'principal', texto: (c) => enlace(c)?.texto ?? '' },

  // ── Las que se encienden cuando hacen falta ──────────────────────────────
  { clave: 'telefono', titulo: 'Teléfono fijo', grupo: 'extra', mono: true, texto: (c) => c.telefono ?? '' },
  { clave: 'ip_receptor', titulo: 'IP receptor', grupo: 'extra', mono: true, texto: (c) => c.ip_administracion ?? '' },
  { clave: 'pppuser', titulo: 'Usuario PPPoE', grupo: 'extra', mono: true, texto: (c) => c.usuario_ppp ?? '' },
  // Los dos de dónde cuelga el abonado. Son excluyentes en la práctica: el de
  // fibra tiene caja NAP y el de radio tiene emisor, y por eso van seguidos —
  // quien mira la red enciende los dos y lee el que corresponda.
  { clave: 'caja_nap', titulo: 'Caja NAP', grupo: 'extra', texto: (c) => [c.nap, c.puerto_nap].filter(Boolean).join(' / ') },
  { clave: 'emisor', titulo: 'Emisor (AP)', grupo: 'extra', texto: (c) => c.conectado_a ?? '' },
  { clave: 'tipo_antena', titulo: 'Antena', grupo: 'extra', texto: (c) => c.tipo_antena ?? '' },
  { clave: 'onu', titulo: 'ONU', grupo: 'extra', mono: true, texto: (c) => c.onu_serial ?? '' },
  { clave: 'instalado', titulo: 'Instalado', grupo: 'extra', texto: (c) => soloFecha(c.fecha_instalacion) },
  { clave: 'coordenadas', titulo: 'Coordenadas', grupo: 'extra', mono: true, texto: (c) => (c.latitud && c.longitud ? `${c.latitud}, ${c.longitud}` : '') },
  { clave: 'pasarela', titulo: 'Pasarela', grupo: 'extra', texto: (c) => c.pasarela ?? '' },
  { clave: 'codigo_pago', titulo: 'Código de pago', grupo: 'extra', mono: true, texto: (c) => c.codigo_pago ?? '' },
  { clave: 'factura_electronica', titulo: 'Emite factura', grupo: 'extra', centro: true, texto: (c) => (c.factura_electronica ? 'sí' : 'no') },
  { clave: 'modalidad', titulo: 'Modalidad', grupo: 'extra', texto: (c) => c.modalidad_pago ?? '' },
  { clave: 'fecha_suspendido', titulo: 'Fecha suspendido', grupo: 'extra', texto: (c) => (['suspendido', 'cortado'].includes(c.estado) ? soloFecha(c.estado_desde) : '') },
  { clave: 'fecha_retirado', titulo: 'Fecha retirado', grupo: 'extra', texto: (c) => (c.estado === 'baja' ? soloFecha(c.baja_en ?? c.estado_desde) : '') },
  { clave: 'antiguedad', titulo: 'Tiempo en el estado', grupo: 'extra', texto: (c, ctx) => antiguedad(c.estado_desde, ctx?.ahora) },

  // ── Las de facturación: piden datos que la ficha no trae ────────────────
  { clave: 'ultimo_pago', titulo: 'Último pago', grupo: 'extra', texto: (c) => soloFecha(c.ultimo_pago) },
  { clave: 'ultimo_vencimiento', titulo: 'Último vencimiento', grupo: 'extra', extra: true, texto: (c, ctx) => soloFecha(cuenta(ctx, c).ultimo_vencimiento) },
  { clave: 'proximo_pago', titulo: 'Próximo pago', grupo: 'extra', extra: true, texto: (c, ctx) => soloFecha(cuenta(ctx, c).proximo_vencimiento) },
  { clave: 'saldo_favor', titulo: 'Saldo a favor', grupo: 'extra', extra: true, derecha: true, texto: (c, ctx) => dosDecimales(cuenta(ctx, c).a_favor) },
  { clave: 'total_cobrar', titulo: 'Total a cobrar', grupo: 'extra', extra: true, derecha: true, texto: (c, ctx) => dosDecimales(Math.max(0, Number(c.saldo ?? 0) - Number(cuenta(ctx, c).a_favor ?? 0))) },
]

const dosDecimales = (n) => (n == null || n === '' ? '' : Number(n).toFixed(2))
const soloFecha = (f) => (f ? String(f).slice(0, 10) : '')
const cuenta = (ctx, c) => ctx?.cuentas?.[c.id] ?? {}

/**
 * Los campos por los que se puede filtrar de a uno.
 *
 * Son los mismos que la tabla muestra por defecto. La gracia de filtrar por un
 * campo elegido —y no con el buscador general— es que no trae de arrastre:
 * buscar "5" en todo devuelve a quien tenga un 5 en la IP, en la cédula y en el
 * día de pago; buscar "5" en Día pago devuelve a los que pagan el 5.
 */
export const CAMPOS_FILTRO = COLUMNAS_ABONADOS.filter((c) => c.grupo === 'principal')

/**
 * Filtra por un campo concreto.
 *
 * Compara contra el MISMO texto que se ve en la tabla, que es lo que hace que
 * el resultado no sorprenda: si en pantalla dice "000132", buscar "000132"
 * tiene que encontrarlo, aunque en la base ese dato sea el número 132.
 *
 * Sin campo o sin valor no filtra nada: un filtro a medio llenar no puede
 * vaciar la pantalla.
 */
export function filtrarPorCampo(filas, { campo = '', valor = '' } = {}, ctx = {}) {
  return filtrarPorColumnas(filas, campo ? { [campo]: valor } : {}, ctx)
}

/**
 * Filtra por varias columnas a la vez.
 *
 * Es lo que hay detrás de la fila de casillas que va debajo de los encabezados:
 * una por columna, y todas se cumplen a la vez. Escribir "centro" en Zona y
 * "10.0" en IP devuelve a los del centro que además están en esa red, no a la
 * suma de los dos.
 *
 * Las claves que no correspondan a ninguna columna se ignoran en vez de vaciar
 * la tabla: si alguien apaga una columna con su casilla llena, el filtro de esa
 * columna deja de contar. Lo contrario —seguir filtrando por algo que ya no se
 * ve— es una lista recortada sin ninguna explicación en pantalla.
 */
export function filtrarPorColumnas(filas, filtros = {}, ctx = {}) {
  const activos = Object.entries(filtros ?? {})
    .map(([clave, valor]) => [
      COLUMNAS_ABONADOS.find((c) => c.clave === clave),
      String(valor ?? '').trim().toLowerCase(),
    ])
    .filter(([col, q]) => col && q)

  if (!activos.length) return filas ?? []

  return (filas ?? []).filter((c) =>
    activos.every(([col, q]) => {
      const texto = String(col.texto(c, ctx) ?? '').toLowerCase()
      return col.exacto ? texto === q : texto.includes(q)
    }),
  )
}

/** Cuántas casillas tienen algo escrito, contando solo las columnas visibles. */
export const filtrosActivos = (filtros = {}, visibles = []) =>
  Object.entries(filtros ?? {}).filter(
    ([clave, valor]) => visibles.includes(clave) && String(valor ?? '').trim(),
  ).length

/** Las que se ven cuando alguien entra por primera vez. */
export const COLUMNAS_POR_DEFECTO = COLUMNAS_ABONADOS.filter((c) => c.grupo === 'principal').map(
  (c) => c.clave,
)

/** ¿Hay que ir a buscar las cuentas? Solo si se encendió alguna que las use. */
export const necesitaCuentas = (visibles) =>
  COLUMNAS_ABONADOS.some((c) => c.extra && visibles.includes(c.clave))

/**
 * Resume la situación de cuenta de cada abonado a partir de sus facturas.
 *
 * Se calcula acá, sobre las filas ya traídas, y no con una consulta por
 * abonado: cien abonados serían cien viajes para llenar una columna.
 *
 * `a_favor` sale de los cobros que todavía no se imputaron a ninguna factura.
 * Es plata del abonado que está en la casa: se descuenta de lo que hay que
 * cobrarle, y por eso "total a cobrar" no es lo mismo que "deuda actual".
 */
export function resumirCuentas({ facturas = [], cobrosSinImputar = [] } = {}) {
  const out = {}

  for (const f of facturas) {
    const c = (out[f.client_id] ??= { a_favor: 0 })
    const v = String(f.fecha_vencimiento ?? '').slice(0, 10)
    if (!v) continue
    if (!c.ultimo_vencimiento || v > c.ultimo_vencimiento) c.ultimo_vencimiento = v
    if (!c.proximo_vencimiento || v < c.proximo_vencimiento) c.proximo_vencimiento = v
  }

  for (const p of cobrosSinImputar) {
    const c = (out[p.client_id] ??= { a_favor: 0 })
    c.a_favor = Math.round((c.a_favor + Number(p.monto ?? 0)) * 100) / 100
  }

  return out
}

/** Las columnas del archivo, en el orden en que se leen. */
export const COLUMNAS_EXPORT = [
  { titulo: 'ID', valor: (c) => codigoLargo(c.codigo) },
  { titulo: 'Nombre', valor: (c) => c.nombre },
  { titulo: 'Cédula', valor: (c) => c.identificacion },
  { titulo: 'Dirección', valor: (c) => c.direccion },
  { titulo: 'Zona', valor: (c) => c.zona },
  { titulo: 'Teléfono', valor: (c) => c.telefono },
  { titulo: 'Móvil', valor: (c) => c.telefono_movil },
  { titulo: 'Plan', valor: (c) => c.plan },
  { titulo: 'Router', valor: (c) => c.router },
  { titulo: 'IP', valor: (c) => c.ip },
  { titulo: 'MAC', valor: (c) => c.mac_address },
  { titulo: 'ONU', valor: (c) => c.onu_serial },
  { titulo: 'Estado', valor: (c) => c.estado },
  { titulo: 'Desde', valor: (c) => String(c.estado_desde ?? '').slice(0, 10) },
  { titulo: 'Tiempo en el estado', valor: (c, ahora) => antiguedad(c.estado_desde, ahora) },
  { titulo: 'Deuda', valor: (c) => Number(c.saldo ?? 0).toFixed(2) },
  { titulo: 'Día de pago', valor: (c) => c.dia_facturacion },
]

/**
 * Arma el CSV.
 *
 * Separado por punto y coma y no por coma: es lo que espera el Excel en español,
 * que con coma mete todo en una sola columna. Mismo criterio que el reporte de
 * ventas, para que los dos archivos se abran igual.
 */
export function aCSV(filas, ahora = new Date(), columnas = COLUMNAS_EXPORT) {
  const escapar = (v) => {
    const s = String(v ?? '')
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  return [
    columnas.map((c) => escapar(c.titulo)).join(';'),
    ...filas.map((f) => columnas.map((c) => escapar(c.valor(f, ahora))).join(';')),
  ].join('\n')
}

/** El nombre del archivo dice qué contiene: al mes siguiente se agradece. */
export function nombreArchivo({ modo, estado, meses, desde, hasta }, ahora = new Date()) {
  const hoy = ahora.toISOString().slice(0, 10)
  if (modo === 'rango') {
    return `abonados-${estado}-${String(desde).slice(0, 10) || 'inicio'}-a-${String(hasta).slice(0, 10) || hoy}.csv`
  }
  return `abonados-${estado}-${meses}-meses-o-mas-${hoy}.csv`
}
