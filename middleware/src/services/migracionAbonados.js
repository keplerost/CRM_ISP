import ExcelJS from 'exceljs'

import { db } from '../lib/db.js'
import { badRequest } from '../lib/errors.js'
import { leerPlanilla } from '../lib/planilla.js'

/**
 * Traer la base de abonados de otro sistema.
 *
 * Se sube un archivo con una fila por cliente —CSV o Excel, porque no todos los
 * sistemas exportan las dos cosas—. Lo que importa no es el formato sino cinco
 * decisiones:
 *
 *   EL IDENTIFICADOR VIEJO se guarda. Es lo que hace que reimportar actualice
 *   en vez de duplicar, y lo que permite volver a cruzar contra el sistema
 *   anterior el día que aparece una diferencia. Sin él, una migración es de una
 *   sola oportunidad.
 *
 *   LA ANTIGÜEDAD NO SE PIERDE. La fecha de instalación se importa tal cual y
 *   se usa además para `activado_en` — que si no, el disparador la sella en hoy
 *   y toda la base queda como si se hubiera instalado el día de la migración.
 *
 *   EL ÚLTIMO PAGO ES LO QUE EVITA UNA MAÑANA MUY MALA. Sin él, un abonado
 *   instalado hace dos años se lee como dos años sin pagar, la cartera le abre
 *   orden de retiro esa misma noche, y al día siguiente hay técnicos yendo a
 *   levantar equipos de casas que están al día. Está probado en el arnés.
 *
 *   EL SALDO NO ES UN CAMPO. Un "debe 45.20" en una columna es un número sin
 *   explicación: no se sabe de qué mes es, no sale en el estado de cuenta, y el
 *   primer pago lo pisa sin dejar rastro. Se convierte en una factura de
 *   apertura, que se cobra y se ve como cualquier otra.
 *
 *   NADA SE ESCRIBE SIN MOSTRARLO ANTES. Una base de abonados es lo más caro
 *   que tiene un ISP; importarla mal y descubrirlo en la primera facturación es
 *   un mes de trabajo perdido.
 */

/**
 * Los nombres de columna que se aceptan para cada dato.
 *
 * Cada sistema exporta con sus propios encabezados y pedirle al ISP que
 * renombre veinte columnas antes de importar es pedirle que se equivoque. Se
 * reconocen las formas habituales y se informa cuáles no se entendieron.
 */
const COLUMNAS = {
  codigo_externo: ['codigo', 'id', 'id_cliente', 'codigo_cliente', 'numero', 'cliente_id', 'abonado'],
  nombre: ['nombre', 'nombres', 'cliente', 'razon_social', 'nombre_completo', 'apellidos_y_nombres'],
  identificacion: ['cedula', 'identificacion', 'documento', 'dni', 'ruc', 'nit', 'cedula_ruc'],
  // El fijo primero y el celular después: si el archivo trae los dos, cada uno
  // tiene que caer donde va. El celular es el que usa WhatsApp.
  telefono: ['telefono', 'telefono1', 'fijo', 'telf', 'fono', 'telefono_fijo'],
  telefono_movil: ['celular', 'movil', 'whatsapp', 'telefono2', 'telefono_movil', 'telefono_celular'],
  email: ['email', 'correo', 'mail', 'correo_electronico'],
  direccion: ['direccion', 'domicilio', 'ubicacion', 'direccion_domicilio'],
  usuario_ppp: ['usuario', 'usuario_ppp', 'pppoe', 'user', 'login', 'usuario_pppoe'],
  clave_ppp: ['clave', 'password', 'contrasena', 'clave_ppp', 'pass', 'clave_pppoe'],
  ip: ['ip', 'direccion_ip', 'ipv4', 'ip_actual', 'ip_asignada'],
  mac_address: ['mac', 'mac_address', 'direccion_mac'],
  plan: ['plan', 'perfil', 'servicio', 'paquete', 'plan_internet', 'velocidad'],
  precio_mensual: ['precio', 'valor', 'mensualidad', 'costo', 'tarifa', 'precio_mensual'],
  dia_facturacion: ['dia_pago', 'dia_facturacion', 'dia_corte', 'vencimiento', 'dia'],
  fecha_instalacion: ['fecha_instalacion', 'instalacion', 'alta', 'fecha_alta', 'fecha_registro', 'fecha_contrato', 'fecha_de_instalacion'],

  /**
   * La fecha del último pago del sistema anterior.
   *
   * Es la columna más importante del archivo después del nombre, y la que nadie
   * piensa en incluir. Sin ella la cartera trata al padrón entero como moroso
   * de años — ver el comentario de arriba y la migración 121.
   */
  ultimo_pago: [
    'ultimo_pago', 'fecha_ultimo_pago', 'ultimo_abono', 'ultimo_pago_fecha',
    'fecha_pago', 'pagado_hasta', 'ultima_factura_pagada', 'fecha_ultimo_abono',
  ],

  // La serie de la ONT. Es lo que permite enganchar al abonado con el equipo
  // que ya está en la OLT, sin volver a cargarlo a mano uno por uno.
  serie_onu: ['serie', 'sn', 'serial', 'serie_ont', 'serie_onu', 'ont', 'onu', 'serial_ont', 'nro_serie'],

  zona: ['zona', 'sector', 'barrio', 'nodo', 'zona_geografica', 'localidad'],
  pasarela: ['pasarela', 'medio_pago', 'medio_de_pago', 'forma_pago', 'recaudacion'],
  codigo_pago: ['codigo_pago', 'codigo_de_pago', 'codigo_cobro', 'referencia', 'referencia_pago', 'codigo_barras'],
  latitud: ['latitud', 'lat'],
  longitud: ['longitud', 'lon', 'lng', 'long'],

  saldo: ['saldo', 'deuda', 'saldo_pendiente', 'debe', 'balance'],
  estado: ['estado', 'status', 'activo', 'estatus'],
  notas: ['notas', 'observaciones', 'comentario', 'nota', 'observacion'],
}

/**
 * Las columnas de la plantilla que genera el sistema.
 *
 * Es la MISMA lista que usa el generador del .xlsx, a propósito: si la plantilla
 * ofreciera una columna que el importador no entiende, alguien la llenaría con
 * cuidado para nada. El título de cada una está entre los alias de arriba, así
 * que la plantilla se lee sin configurar nada.
 *
 * `texto: true` fuerza el formato de texto en Excel. Sin eso Excel se come el
 * cero de "0998877665" y convierte una cédula larga en notación científica —dos
 * datos rotos en silencio, y de los que más se usan.
 */
export const CAMPOS_PLANTILLA = [
  { clave: 'codigo_externo', titulo: 'Código', texto: true, ejemplo: '1001',
    ayuda: 'El identificador que tiene el abonado en tu sistema actual. Es lo que permite volver a subir el archivo corregido sin duplicar a nadie.' },
  { clave: 'nombre', titulo: 'Nombre Completo', ejemplo: 'OÑA RIERA JOSÉ',
    ayuda: 'Apellidos y nombres. Es la única columna sin la que la fila no se puede importar.' },
  { clave: 'identificacion', titulo: 'Cédula', texto: true, ejemplo: '1712345678',
    ayuda: 'Cédula o RUC. No puede repetirse entre abonados activos: es con lo que el abonado entra al portal.' },
  { clave: 'telefono', titulo: 'Teléfono', texto: true, ejemplo: '032345678',
    ayuda: 'El teléfono fijo, si lo hay. El celular va en la columna de al lado: son distintos y los avisos salen al celular.' },
  { clave: 'telefono_movil', titulo: 'Celular', texto: true, ejemplo: '0998877665',
    ayuda: 'El celular. Es el número al que van los avisos de WhatsApp.' },
  { clave: 'email', titulo: 'Correo', ejemplo: 'jose@correo.com', ayuda: 'Para mandarle la factura.' },
  { clave: 'direccion', titulo: 'Dirección', ejemplo: 'Av. Quito, casa 3',
    ayuda: 'Dónde vive. Sirve para que el técnico lo encuentre.' },
  { clave: 'zona', titulo: 'Zona', ejemplo: 'GUAMANÍ',
    ayuda: 'Barrio, sector o nodo. Con esto se filtra el listado de abonados y se arman las rutas del técnico.' },
  { clave: 'plan', titulo: 'Plan', ejemplo: 'PLAN_HOME',
    ayuda: 'El nombre del plan tal como está cargado en el sistema. Si lo dejás vacío, se usa el plan elegido al generar esta plantilla.' },
  { clave: 'precio_mensual', titulo: 'Precio', ejemplo: '20.09',
    ayuda: 'Lo que paga por mes. Si el abonado tiene un precio acordado distinto del de lista, poné el suyo: manda sobre el del plan.' },
  { clave: 'dia_facturacion', titulo: 'Día Pago', ejemplo: '5',
    ayuda: 'Día del mes en que le toca pagar, del 1 al 28.' },
  { clave: 'usuario_ppp', titulo: 'Usuario PPPoE', ejemplo: 'jose.ona',
    ayuda: 'Solo si se conecta por PPPoE.' },
  { clave: 'clave_ppp', titulo: 'Clave PPPoE', texto: true, ejemplo: 'abc123',
    ayuda: 'Solo si se conecta por PPPoE.' },
  { clave: 'ip', titulo: 'IP Actual', texto: true, ejemplo: '10.20.1.15',
    ayuda: 'La IP que tiene hoy. Importante para no tener que redireccionar a todos al migrar.' },
  { clave: 'mac_address', titulo: 'MAC', texto: true, ejemplo: 'A4:2B:B0:11:22:33',
    ayuda: 'La MAC del equipo del abonado, si la tenés.' },
  { clave: 'serie_onu', titulo: 'Serie ONT', texto: true, ejemplo: 'HWTC6E1B5AB4',
    ayuda: 'El número de serie de la ONT. Con esto el abonado queda enganchado con el equipo que ya está en la OLT, sin cargarlo a mano.' },
  { clave: 'fecha_instalacion', titulo: 'Fecha Instalación', ejemplo: '14/03/2022',
    ayuda: 'Cuándo se instaló. NO SE PUEDE RECONSTRUIR DESPUÉS: es la antigüedad del abonado, y de ella dependen las estadísticas y la cartera.' },
  { clave: 'ultimo_pago', titulo: 'Último Pago', ejemplo: '05/07/2026',
    ayuda: 'Cuándo pagó por última vez en tu sistema actual. SIN ESTO el sistema lo cuenta como moroso desde que se instaló, y la cartera le abre orden de retiro la primera noche.' },
  { clave: 'estado', titulo: 'Estado', ejemplo: 'Activo',
    ayuda: 'Activo, Suspendido, Cortado o Retirado. Lo que no se entienda entra como activo.' },
  { clave: 'saldo', titulo: 'Saldo', ejemplo: '44.70',
    ayuda: 'Lo que debe hoy. Se convierte en una factura de saldo anterior, que se cobra como cualquier otra. Si tiene saldo a favor, ponelo en negativo: eso no se importa, se carga como pago.' },
  { clave: 'pasarela', titulo: 'Medio de Pago', ejemplo: 'Cuentadigital',
    ayuda: 'Dónde paga: Cuentadigital, PayPhone, ventanilla…' },
  { clave: 'codigo_pago', titulo: 'Código de Pago', texto: true, ejemplo: '990011',
    ayuda: 'El número con el que se lo identifica en esa pasarela.' },
  { clave: 'notas', titulo: 'Observaciones', ejemplo: 'Cobrar en la tienda',
    ayuda: 'Cualquier cosa que convenga que quede escrita en la ficha.' },
]

const normalizar = (s) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')

/** Qué columna del archivo corresponde a cada campo. */
export function mapearColumnas(encabezados = []) {
  const normalizados = encabezados.map((h) => ({ original: h, norm: normalizar(h) }))
  const mapa = {}
  const usadas = new Set()

  for (const [campo, alias] of Object.entries(COLUMNAS)) {
    const encontrada = normalizados.find((h) => !usadas.has(h.original) && alias.includes(h.norm))
    if (encontrada) {
      mapa[campo] = encontrada.original
      usadas.add(encontrada.original)
    }
  }

  return {
    mapa,
    // Las que no se reconocieron. Se informan en vez de descartarlas en
    // silencio: puede haber una columna importante con un nombre inesperado.
    sin_reconocer: normalizados.filter((h) => !usadas.has(h.original)).map((h) => h.original),
    faltan: ['nombre'].filter((c) => !mapa[c]),
  }
}

const aNumero = (v) => {
  if (v == null || v === '') return null
  // "1.234,56" y "1,234.56" son el mismo número escrito por dos regiones.
  const t = String(v).trim().replace(/[^\d,.-]/g, '')
  const conComa = t.lastIndexOf(',') > t.lastIndexOf('.')
  const limpio = conComa ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')
  const n = Number(limpio)
  return Number.isFinite(n) ? n : null
}

/**
 * La fecha, venga como venga.
 *
 * Es el dato que el ISP no quiere perder al migrar, y el que más formas tiene de
 * llegar: como objeto `Date` si el archivo es un Excel, como "15/01/2024" si es
 * un CSV exportado acá, como "2024-01-15" si el sistema era serio.
 *
 * Lo que NO se hace es adivinar entre dd/mm y mm/dd cuando los dos números son
 * menores a 13. No se puede: "03/04/2024" es marzo o abril según quién lo
 * escribió, y elegir mal corre la antigüedad de media base sin que nadie lo
 * note. Se asume dd/mm —que es lo que se usa acá— y se avisa en la revisión
 * cuando el archivo tiene fechas ambiguas.
 */
export const aFecha = (v) => {
  if (!v) return null

  // Excel devuelve la celda ya como fecha. Se toma en UTC porque exceljs las
  // arma ahí: pasar por la zona local podría correrla un día para atrás.
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`
  }

  const t = String(v).trim()
  if (!t) return null

  // aaaa-mm-dd, ya en el formato de la base. Puede venir con la hora detrás.
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(t)) {
    const [a, m, d] = t.slice(0, 10).split('-')
    return `${a}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  // dd/mm/aaaa y dd-mm-aaaa, con o sin hora detrás: es como lo exporta casi
  // todo por acá.
  const m = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/)
  if (m) {
    const dia = m[1].padStart(2, '0')
    const mes = m[2].padStart(2, '0')
    // Un año de dos dígitos: 98 es 1998 y 24 es 2024. El corte en 70 es
    // arbitrario pero ningún ISP tiene abonados de antes de eso.
    let anio = m[3]
    if (anio.length === 2) anio = Number(anio) >= 70 ? `19${anio}` : `20${anio}`
    if (Number(mes) < 1 || Number(mes) > 12 || Number(dia) < 1 || Number(dia) > 31) return null
    return `${anio}-${mes}-${dia}`
  }

  return null
}

/** Si una fecha escrita como dd/mm también se podría leer como mm/dd. */
export const fechaAmbigua = (v) => {
  if (v instanceof Date || !v) return false
  const m = String(v).trim().match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.]\d{2,4}/)
  return !!m && Number(m[1]) <= 12 && Number(m[2]) <= 12 && m[1] !== m[2]
}

/**
 * Los estados de otro sistema, en los que usa este.
 *
 * `retirado` es el que más se ve en un padrón viejo y no existe como estado
 * propio: acá un abonado retirado está en `baja`, con su motivo y su fecha.
 */
const ESTADOS = {
  activo: 'activo', active: 'activo', 1: 'activo', si: 'activo', habilitado: 'activo',
  al_dia: 'activo', conectado: 'activo',
  suspendido: 'suspendido', suspended: 'suspendido', pausado: 'suspendido',
  cortado: 'cortado', corte: 'cortado', moroso: 'cortado', deudor: 'cortado',
  baja: 'baja', inactivo: 'baja', 0: 'baja', no: 'baja', retirado: 'baja',
  cancelado: 'baja', anulado: 'baja', eliminado: 'baja', desconectado: 'baja',
}

/**
 * El estado del archivo, en el de este sistema.
 *
 * Lo que no se reconoce entra como ACTIVO, y es a propósito: un abonado que en
 * realidad estaba de baja se descubre al primer mes sin facturar, pero uno
 * activo importado como baja se queda sin servicio hoy y llama enojado.
 */
export const normalizarEstado = (v) => ESTADOS[normalizar(v)] ?? 'activo'

/**
 * Un sí/no escrito por una persona.
 *
 * La hoja de configuración la puede editar alguien a mano, y ahí "si", "SÍ",
 * "true" y "1" son todos lo mismo. Cualquier otra cosa es no.
 */
const esSi = (v) => ['si', 'sí', 'true', '1', 'yes', 'x'].includes(String(v).trim().toLowerCase())

/**
 * Lee las filas y dice qué se va a hacer con cada una, sin escribir nada.
 */
export async function revisar({ texto, archivo, ajustes, filas: filasDadas, sistema_origen = 'importado' }) {
  // El archivo se lee acá y no en el navegador: es donde se puede probar contra
  // los casos que rompen de verdad —comas dentro de la dirección, punto y coma
  // como separador, el BOM y los acentos en Latin-1 de Excel— y donde esas
  // pruebas quedan escritas.
  let filas = filasDadas ?? []
  let formato = null
  let config = null

  if (archivo?.base64) {
    const leido = await leerPlanilla({
      nombre: archivo.nombre,
      bytes: Buffer.from(archivo.base64, 'base64'),
      ExcelJS,
    })
    filas = leido.filas
    formato = leido.formato
    config = leido.config
  } else if (texto) {
    const leido = await leerPlanilla({ texto })
    filas = leido.filas
    formato = leido.formato
  }

  if (!filas.length) throw badRequest('El archivo no tiene filas')

  /**
   * De dónde salen el router y los demás valores comunes.
   *
   * La plantilla que genera el sistema los trae adentro, en su hoja de
   * configuración: eso es lo que hace que subir el mismo archivo dos veces dé lo
   * mismo dos veces. Un archivo exportado de otro sistema no los trae, y ahí sí
   * se eligen en la pantalla — por eso `ajustes` es el respaldo y no al revés:
   * lo que dice el archivo manda sobre lo que quedó seleccionado en la pantalla.
   */
  const comunes = { ...(ajustes ?? {}), ...(config ?? {}) }

  /**
   * Sin router se REVISA igual, pero no se importa.
   *
   * Cortar acá sería cómodo y dejaría a la pantalla sin salida: para poder
   * elegir el router hay que haber leído el archivo, y para leer el archivo
   * haría falta el router. Se revisa, se dice que falta, y `importar` es la que
   * se planta.
   */
  const faltaRouter = !comunes.router_id

  const encabezados = Object.keys(filas[0])
  const { mapa, sin_reconocer, faltan } = mapearColumnas(encabezados)

  if (faltan.length) {
    throw badRequest(`No se encontró la columna del ${faltan.join(' ni del ')}`, {
      hint: `Columnas del archivo: ${encabezados.join(', ')}`,
      sin_reconocer,
    })
  }

  const [rExistentes, rPlanes, rOnus, rCedulas, rRouter] = await Promise.all([
    db().from('clientes').select('id, codigo_externo, nombre, identificacion').eq('sistema_origen', sistema_origen),
    db().from('planes_velocidad').select('id, nombre, precio'),
    // Las ONUs que ya están en la OLT, para poder enganchar cada abonado con su
    // equipo por número de serie en vez de hacerlo a mano uno por uno.
    db().from('onus').select('id, sn'),
    // Las cédulas que ya están tomadas. La base tiene un índice único parcial
    // sobre ellas —el que permite al abonado entrar al portal sin ambigüedad— y
    // sin mirarlo antes, la fila choca recién al escribirla.
    db().from('clientes').select('id, identificacion, nombre').neq('estado', 'baja').not('identificacion', 'is', null),
    // Que el router exista. Un id inventado —o el de un router que se borró
    // después de generar la plantilla— dejaría el padrón entero colgado de la
    // nada, y eso se descubre recién cuando el corte no funciona.
    faltaRouter
      ? Promise.resolve({ data: null, error: null })
      : db().from('routers_mikrotik').select('id, nombre').eq('id', comunes.router_id).maybeSingle(),
  ])

  /**
   * Si alguna consulta falló, se corta acá.
   *
   * Antes se leía solo `data` y el error se descartaba: una consulta rota
   * devolvía `null`, el mapa quedaba vacío y la revisión informaba que NINGÚN
   * plan del archivo existía en el sistema. Todas las filas quedaban bloqueadas
   * por un motivo falso, y el mensaje mandaba a crear planes que ya estaban.
   *
   * Pasó de verdad: la consulta pedía `precio_mensual` y la columna se llama
   * `precio`.
   */
  for (const [que, r] of [
    ['abonados', rExistentes], ['planes', rPlanes], ['ONUs', rOnus], ['cédulas', rCedulas],
    ['routers', rRouter],
  ]) {
    if (r.error) throw badRequest(`No se pudieron leer los ${que} del sistema: ${r.error.message}`)
  }

  if (!faltaRouter && !rRouter.data) {
    throw badRequest('El router de este archivo ya no existe en el sistema', {
      hint: comunes.router
        ? `El archivo dice "${comunes.router}". Volvé a generar la plantilla con un router actual.`
        : 'Volvé a generar la plantilla.',
    })
  }

  const existentes = rExistentes.data
  const planes = rPlanes.data
  const onus = rOnus.data
  const cedulaTomada = new Map(
    (rCedulas.data ?? [])
      .filter((c) => String(c.identificacion ?? '').trim())
      .map((c) => [String(c.identificacion).trim(), c]),
  )

  const porCodigo = new Map((existentes ?? []).map((c) => [String(c.codigo_externo), c]))
  const planPorNombre = new Map((planes ?? []).map((p) => [normalizar(p.nombre), p]))
  // El plan que se eligió al generar la plantilla, para las filas que no nombran
  // el suyo. Un abonado sin plan no tiene ni velocidad ni precio.
  const planPorDefecto = comunes.plan_id
    ? (planes ?? []).find((p) => p.id === comunes.plan_id)
    : null
  // La serie se compara sin espacios ni guiones y en mayúsculas: el mismo
  // aparato se escribe "ZTEG-C1A2B3C4" en un sistema y "zteg c1a2b3c4" en otro.
  const serieLimpia = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const onuPorSerie = new Map((onus ?? []).map((o) => [serieLimpia(o.sn), o]))
  const onusTomadas = new Set()

  const leer = (f, campo) => (mapa[campo] ? f[mapa[campo]] : null)
  const vistos = new Set()
  const cedulasVistas = new Set()

  const revisadas = filas.map((f, i) => {
    const codigo = String(leer(f, 'codigo_externo') ?? '').trim() || null
    const nombre = String(leer(f, 'nombre') ?? '').trim()
    const saldo = aNumero(leer(f, 'saldo'))
    const nombrePlan = String(leer(f, 'plan') ?? '').trim()
    const plan = nombrePlan ? planPorNombre.get(normalizar(nombrePlan)) : null

    const cedula = String(leer(f, 'identificacion') ?? '').trim() || null
    const instalacion = aFecha(leer(f, 'fecha_instalacion'))
    const ultimoPago = aFecha(leer(f, 'ultimo_pago'))
    const serie = String(leer(f, 'serie_onu') ?? '').trim() || null
    const onu = serie ? onuPorSerie.get(serieLimpia(serie)) : null
    const estado = normalizarEstado(leer(f, 'estado'))
    const yaEsta = codigo ? porCodigo.get(codigo) : null

    const problemas = []
    const avisos = []

    if (!nombre) problemas.push('sin nombre')
    if (!codigo) problemas.push('sin identificador: no se va a poder reimportar sin duplicar')
    if (codigo && vistos.has(codigo)) problemas.push(`el identificador ${codigo} está repetido en el archivo`)
    if (codigo) vistos.add(codigo)
    if (nombrePlan && !plan) problemas.push(`el plan "${nombrePlan}" no existe en el sistema`)

    /**
     * La cédula repetida.
     *
     * Va como PROBLEMA y no como aviso porque la base la rechaza: hay un índice
     * único sobre la identificación —el que permite al abonado entrar al portal
     * sin ambigüedad— y la fila choca sí o sí al escribirla. Anunciarla como
     * "se va a crear" y que después falle deja una revisión que miente.
     *
     * El índice es parcial: solo choca entre abonados que no estén de baja. Un
     * retirado con la misma cédula no molesta, y por eso se replica esa
     * condición acá en vez de rechazar cualquier repetición.
     */
    if (cedula && estado !== 'baja') {
      if (cedulasVistas.has(cedula)) {
        problemas.push(`la cédula ${cedula} está repetida en el archivo`)
      } else {
        const dueño = cedulaTomada.get(cedula)
        // Que la tenga el mismo abonado que se está actualizando es lo normal.
        if (dueño && dueño.id !== yaEsta?.id) {
          problemas.push(`la cédula ${cedula} ya es de ${dueño.nombre} en el sistema`)
        }
      }
      cedulasVistas.add(cedula)
    }

    if (!instalacion) {
      avisos.push('sin fecha de instalación: se pierde la antigüedad del abonado')
    } else if (fechaAmbigua(leer(f, 'fecha_instalacion'))) {
      avisos.push('la fecha de instalación se leyó como día/mes')
    }

    /**
     * El aviso que evita la mañana mala.
     *
     * Un abonado activo sin fecha de último pago se lee como si no pagara desde
     * que se instaló. Si eso pasa los meses que aguanta la cartera, esa misma
     * noche se le abre una orden de retiro.
     */
    if (!ultimoPago && estado !== 'baja') {
      avisos.push('sin fecha de último pago: la cartera lo va a contar como moroso desde su instalación')
    }

    if (serie && !onu) {
      avisos.push(`la serie ${serie} no está en la OLT: el abonado queda sin ONT asociada`)
    }
    if (onu && onusTomadas.has(onu.id)) {
      avisos.push(`la serie ${serie} ya se usó en otra fila del archivo`)
    }
    if (onu) onusTomadas.add(onu.id)

    return {
      fila: i + 2, // +2: la 1 es el encabezado y las planillas cuentan desde 1
      codigo_externo: codigo,
      nombre,
      identificacion: cedula,
      telefono: String(leer(f, 'telefono') ?? '').trim() || null,
      telefono_movil: String(leer(f, 'telefono_movil') ?? '').trim() || null,
      email: String(leer(f, 'email') ?? '').trim() || null,
      direccion: String(leer(f, 'direccion') ?? '').trim() || null,
      usuario_ppp: String(leer(f, 'usuario_ppp') ?? '').trim() || null,
      clave_ppp: String(leer(f, 'clave_ppp') ?? '').trim() || null,
      ip: String(leer(f, 'ip') ?? '').trim() || null,
      mac_address: String(leer(f, 'mac_address') ?? '').trim() || null,
      zona: String(leer(f, 'zona') ?? '').trim() || null,
      pasarela: String(leer(f, 'pasarela') ?? '').trim() || null,
      codigo_pago: String(leer(f, 'codigo_pago') ?? '').trim() || null,
      latitud: aNumero(leer(f, 'latitud')),
      longitud: aNumero(leer(f, 'longitud')),
      // El plan de la fila; si no dice nada, el que se eligió al generar la
      // plantilla. Al revés no: una fila que nombra su plan sabe más que un
      // valor por defecto puesto para todo el archivo.
      plan_id: plan?.id ?? planPorDefecto?.id ?? null,
      plan_nombre: nombrePlan || planPorDefecto?.nombre || null,
      // Manda el precio del archivo: un abonado viejo puede tener un precio
      // acordado distinto del de lista, y pisarlo con el del plan le cambiaría
      // la cuota sin que nadie lo decida. El del plan es solo el respaldo.
      precio_mensual:
        aNumero(leer(f, 'precio_mensual')) ?? plan?.precio ?? planPorDefecto?.precio ?? null,
      dia_facturacion: aNumero(leer(f, 'dia_facturacion')) ?? aNumero(comunes.dia_facturacion),
      fecha_instalacion: instalacion,
      ultimo_pago_externo: ultimoPago,
      serie_onu: serie,
      onu_id: onu?.id ?? null,
      estado,
      notas: String(leer(f, 'notas') ?? '').trim() || null,
      // Solo la deuda se convierte en factura. Un saldo A FAVOR es plata que el
      // abonado ya pagó y todavía no consumió: eso es un pago sin aplicar, no
      // una factura, y hacerlo mal le cobraría dos veces.
      saldo,
      deuda: saldo != null && saldo > 0 ? saldo : null,
      a_favor: saldo != null && saldo < 0 ? Math.abs(saldo) : null,
      accion: yaEsta ? 'actualiza' : 'crea',
      cliente_id: yaEsta?.id ?? null,
      problemas,
      avisos,
    }
  })

  return {
    sistema_origen,
    formato,
    mapa,
    sin_reconocer,
    // Lo que se le va a aplicar a todo el archivo. Se devuelve para poder
    // mostrarlo antes de importar: "estos 480 abonados van al router PROGRESO"
    // es la clase de cosa que hay que ver escrita, no suponer.
    comunes: {
      ...comunes,
      router: rRouter.data?.nombre ?? null,
      plan: planPorDefecto?.nombre ?? null,
      // De dónde salió: si vino en el archivo, subirlo de nuevo da lo mismo.
      viene_del_archivo: !!config?.router_id,
      falta_router: faltaRouter,
    },
    filas: revisadas,
    resumen: {
      total: revisadas.length,
      se_crean: revisadas.filter((r) => r.accion === 'crea' && !r.problemas.length).length,
      se_actualizan: revisadas.filter((r) => r.accion === 'actualiza' && !r.problemas.length).length,
      con_problemas: revisadas.filter((r) => r.problemas.length).length,
      con_avisos: revisadas.filter((r) => r.avisos.length).length,
      con_deuda: revisadas.filter((r) => r.deuda).length,
      deuda_total: Number(revisadas.reduce((n, r) => n + (r.deuda ?? 0), 0).toFixed(2)),
      a_favor: revisadas.filter((r) => r.a_favor).length,
      sin_plan: revisadas.filter((r) => r.plan_nombre && !r.plan_id).length,

      // Los tres números que hay que mirar antes de apretar el botón.
      sin_instalacion: revisadas.filter((r) => !r.fecha_instalacion).length,
      sin_ultimo_pago: revisadas.filter((r) => !r.ultimo_pago_externo && r.estado !== 'baja').length,
      con_onu: revisadas.filter((r) => r.onu_id).length,
      serie_sin_onu: revisadas.filter((r) => r.serie_onu && !r.onu_id).length,
    },
  }
}

/**
 * Importa de verdad.
 *
 * Las filas con problemas se saltean y se informan: importar 480 de 500 y decir
 * cuáles faltaron es útil; negarse por veinte, no.
 */
export async function importar({ texto, archivo, ajustes, filas, sistema_origen = 'importado', concepto_saldo }) {
  const revision = await revisar({ texto, archivo, ajustes, filas, sistema_origen })

  // Acá sí se corta. Un abonado sin router no se corta por mora, no se le sube
  // la cola y no aparece en el tablero de ningún equipo: está cargado y no
  // existe para el sistema.
  if (revision.comunes.falta_router) {
    throw badRequest('Falta decir a qué router pertenecen estos abonados', {
      hint: 'Generá la plantilla desde esta pantalla —el router viaja adentro— o elegilo antes de importar.',
    })
  }

  const buenas = revision.filas.filter((r) => !r.problemas.length)

  const ahora = new Date().toISOString()
  const hoy = ahora.slice(0, 10)
  const resultados = []

  /**
   * Lo que vale para todo el archivo.
   *
   * El router es la razón de ser de la plantilla: sin él el abonado no se corta,
   * no se le sube la cola y no aparece en el tablero del router. Los demás son
   * valores por defecto que la fila puede pisar.
   */
  const c = revision.comunes
  const parejo = {
    router_id: c.router_id,
    ...(c.tipo_conexion ? { tipo_conexion: c.tipo_conexion } : {}),
    ...(c.modalidad_pago ? { modalidad_pago: c.modalidad_pago } : {}),
    ...(c.dia_generar_factura != null ? { dia_generar_factura: Number(c.dia_generar_factura) } : {}),
    ...(c.dias_gracia != null ? { dias_gracia: Number(c.dias_gracia) } : {}),
    ...(c.canal_preferido ? { canal_preferido: c.canal_preferido } : {}),
    ...(c.factura_electronica != null ? { factura_electronica: esSi(c.factura_electronica) } : {}),
    /**
     * A los cuántos meses se corta.
     *
     * Se acepta el valor viejo —`aplicar_corte` en sí/no— porque puede haber
     * plantillas generadas antes de la 131 dando vueltas, y una migración de
     * padrón se llena durante días. La base mantiene las dos columnas
     * coherentes, así que da igual cuál llegue.
     */
    ...(c.cortar_tras_meses != null
      ? { cortar_tras_meses: Number(c.cortar_tras_meses) }
      : c.aplicar_corte != null
        ? { aplicar_corte: esSi(c.aplicar_corte) }
        : {}),
  }

  for (const r of buenas) {
    try {
      const fila = {
        ...parejo,
        nombre: r.nombre,
        identificacion: r.identificacion,
        telefono: r.telefono,
        telefono_movil: r.telefono_movil,
        email: r.email,
        direccion: r.direccion,
        usuario_ppp: r.usuario_ppp,
        clave_ppp: r.clave_ppp,
        ip: r.ip,
        mac_address: r.mac_address,
        zona: r.zona,
        pasarela: r.pasarela,
        codigo_pago: r.codigo_pago,
        latitud: r.latitud,
        longitud: r.longitud,
        plan_id: r.plan_id,
        precio_mensual: r.precio_mensual,
        dia_facturacion: r.dia_facturacion,
        fecha_instalacion: r.fecha_instalacion,
        estado: r.estado,
        notas: r.notas,
        origen: 'manual',
        codigo_externo: r.codigo_externo,
        sistema_origen,
        importado_at: ahora,

        // La fecha del último pago del sistema anterior. No es un cobro: no
        // suma a caja ni a comisiones. Es lo único que impide que la cartera
        // trate al padrón entero como moroso de años. Ver la migración 121.
        ultimo_pago_externo: r.ultimo_pago_externo,

        // El equipo que ya está en la OLT, enganchado por número de serie. Si la
        // serie no apareció, se deja lo que hubiera: pisar con null borraría una
        // asociación hecha a mano.
        ...(r.onu_id ? { onu_id: r.onu_id } : {}),
      }

      /**
       * La antigüedad, sellada de verdad — y una sola vez.
       *
       * `activado_en` lo pone solo un disparador cuando un cliente entra como
       * activo, y lo pone en NOW(). Para un abonado migrado eso es falso: diría
       * que se dio de alta el día de la migración, y toda la base quedaría con
       * un día de antigüedad — justo lo que no se quiere perder. Por eso al
       * CREARLO se manda explícito, y el disparador no tiene nada que sellar.
       *
       * Al ACTUALIZAR no se toca. La columna es el reloj de la ventana de
       * cobranza del vendedor y por eso no se edita (migración 70): reimportar
       * el mismo archivo dos veces no puede correrle la fecha a nadie.
       */
      if (!r.cliente_id && r.fecha_instalacion) {
        fila.activado_en = `${r.fecha_instalacion}T12:00:00Z`
      }

      const { data: cliente, error } = r.cliente_id
        ? await db().from('clientes').update(fila).eq('id', r.cliente_id).select('id').single()
        : await db().from('clientes').insert(fila).select('id').single()

      if (error) throw new Error(error.message)

      // La deuda anterior, como factura. Se crea UNA sola vez por cliente: si
      // se reimporta, no se vuelve a facturar lo mismo.
      let facturaCreada = false
      if (r.deuda) {
        const { data: yaHay } = await db()
          .from('facturas')
          .select('id')
          .eq('client_id', cliente.id)
          .eq('origen', 'migracion')
          .maybeSingle()

        if (!yaHay) {
          const { error: eF } = await db().from('facturas').insert({
            client_id: cliente.id,
            cliente_nombre: r.nombre,
            tipo: 'otro',
            origen: 'migracion',
            concepto: concepto_saldo ?? `Saldo anterior · ${sistema_origen}`,
            fecha_emision: hoy,
            fecha_vencimiento: hoy,
            subtotal: r.deuda,
            impuesto: 0,
            total: r.deuda,
          })
          if (eF) throw new Error(`cliente creado, pero su saldo no: ${eF.message}`)
          facturaCreada = true
        }
      }

      resultados.push({
        fila: r.fila,
        codigo: r.codigo_externo,
        nombre: r.nombre,
        hecho: true,
        accion: r.accion,
        factura_de_saldo: facturaCreada,
      })
    } catch (e) {
      resultados.push({ fila: r.fila, codigo: r.codigo_externo, nombre: r.nombre, hecho: false, motivo: e.message })
    }
  }

  return {
    ...revision,
    importados: resultados.filter((x) => x.hecho).length,
    facturas_de_saldo: resultados.filter((x) => x.factura_de_saldo).length,
    onus_vinculadas: buenas.filter((r) => r.onu_id).length,
    fallidos: resultados.filter((x) => !x.hecho),
    salteados: revision.filas.filter((r) => r.problemas.length).length,
    // El saldo a favor NO se importa: es plata que el abonado ya entregó y hay
    // que registrarla como pago, con su fecha y su forma de cobro. Meterla acá
    // sin eso dejaría un crédito que nadie puede explicar.
    ...(revision.resumen.a_favor
      ? {
          aviso: `${revision.resumen.a_favor} abonados traen saldo A FAVOR y no se importó: hay que cargarlo como pago, con su fecha y forma de cobro.`,
        }
      : {}),
  }
}
