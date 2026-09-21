import ExcelJS from 'exceljs'

import { db } from '../lib/db.js'
import { badRequest } from '../lib/errors.js'
import { CAMPOS_PLANTILLA } from './migracionAbonados.js'

/**
 * La plantilla que se llena para cargar el padrón.
 *
 * ── Por qué se genera y no se descarga un archivo fijo ──
 *
 * Porque la plantilla no es solo una lista de encabezados: lleva adentro a qué
 * ROUTER pertenecen estos abonados, cómo se conectan y con qué plan y qué día se
 * les factura. Eso se decide una vez, acá, y viaja en el archivo.
 *
 * La alternativa —preguntar el router al subir el archivo— parece equivalente y
 * no lo es: el mismo padrón se sube más de una vez (una prueba, una corrección,
 * el archivo que mandó otra persona), y basta que una de esas veces se conteste
 * distinto para que media base quede colgada del router equivocado. Con la
 * configuración adentro, subir el mismo archivo dos veces da lo mismo dos veces.
 *
 * ── Las tres hojas ──
 *
 *   CLIENTES es la única que se llena. Trae los encabezados exactos que el
 *   importador entiende, así que no hay que adivinar cómo llamar a las columnas.
 *
 *   INSTRUCCIONES explica cada una con un ejemplo. Va en una hoja aparte y no
 *   como comentarios en la primera, porque una fila de ayuda arriba de los datos
 *   se importa como si fuera un abonado.
 *
 *   CONFIGURACIÓN es la que se lee al importar. Se deja a la vista —no oculta—
 *   para que se pueda comprobar de un vistazo a qué router va ese archivo.
 */

/** Los pasos del formulario, con lo que puede elegirse en cada uno. */
export const TIPOS_CONEXION = [
  { valor: 'ip', titulo: 'IP fija', ayuda: 'El abonado tiene una IP asignada y lo limita su Simple Queue en el MikroTik.' },
  { valor: 'pppoe', titulo: 'PPPoE', ayuda: 'El abonado entra con usuario y clave. La velocidad la pone la OLT o el perfil, según el plan.' },
  { valor: 'hotspot', titulo: 'Hotspot', ayuda: 'El abonado se autentica contra el portal del MikroTik.' },
]

export const CANALES = [
  { valor: 'whatsapp', titulo: 'WhatsApp' },
  { valor: 'telegram', titulo: 'Telegram' },
  { valor: 'email', titulo: 'Correo' },
  { valor: 'sms', titulo: 'SMS' },
]

export const MODALIDADES = [
  { valor: 'prepago', titulo: 'Prepago', ayuda: 'Se cobra el mes por adelantado.' },
  { valor: 'postpago', titulo: 'Postpago', ayuda: 'Se cobra al vencer el mes.' },
]

/** Lo que hay que poder elegir en la pantalla, con los datos reales del sistema. */
export async function opciones() {
  const [rRouters, rPlanes] = await Promise.all([
    db().from('routers_mikrotik').select('id, nombre, ip_host, activo').order('nombre'),
    db().from('planes_velocidad').select('id, nombre, precio, control_pppoe').order('nombre'),
  ])

  for (const [que, r] of [['routers', rRouters], ['planes', rPlanes]]) {
    if (r.error) throw badRequest(`No se pudieron leer los ${que}: ${r.error.message}`)
  }

  return {
    routers: rRouters.data ?? [],
    planes: rPlanes.data ?? [],
    tipos_conexion: TIPOS_CONEXION,
    canales: CANALES,
    modalidades: MODALIDADES,
  }
}

/**
 * Los campos que van a la hoja de configuración.
 *
 * El router se guarda con su id Y con su nombre. El id es lo que importa —es lo
 * que se escribe en la ficha—, pero un archivo que solo dice
 * "8f3a1b2c-…" no le sirve a nadie para saber de qué router habla al abrirlo tres
 * meses después.
 */
function filasDeConfiguracion({ router, plan, tipo_conexion, facturacion, notificaciones }) {
  const filas = [
    ['router_id', router.id],
    ['router', router.nombre],
    ['tipo_conexion', tipo_conexion],
  ]

  if (plan) {
    filas.push(['plan_id', plan.id], ['plan', plan.nombre])
  }

  const f = facturacion ?? {}
  if (f.modalidad_pago) filas.push(['modalidad_pago', f.modalidad_pago])
  if (f.dia_facturacion != null) filas.push(['dia_facturacion', f.dia_facturacion])
  if (f.dia_generar_factura != null) filas.push(['dia_generar_factura', f.dia_generar_factura])
  if (f.dias_gracia != null) filas.push(['dias_gracia', f.dias_gracia])
  if (f.factura_electronica != null) filas.push(['factura_electronica', f.factura_electronica ? 'si' : 'no'])
  // Se escribe en meses, que es como se decide desde la 131. El importador
  // sigue entendiendo `aplicar_corte` para las plantillas viejas que ya estén
  // dando vueltas por ahí.
  if (f.cortar_tras_meses != null) filas.push(['cortar_tras_meses', f.cortar_tras_meses])
  else if (f.aplicar_corte != null) filas.push(['aplicar_corte', f.aplicar_corte ? 'si' : 'no'])

  const n = notificaciones ?? {}
  if (n.canal_preferido) filas.push(['canal_preferido', n.canal_preferido])

  return filas
}

/**
 * Genera el .xlsx.
 *
 * Devuelve un Buffer. Quien lo llama decide si lo manda al navegador o lo
 * escribe en disco.
 */
export async function generar({
  router_id,
  plan_id = null,
  tipo_conexion = 'ip',
  facturacion = {},
  notificaciones = {},
} = {}) {
  if (!router_id) throw badRequest('Elegí a qué router pertenecen estos abonados')

  const [rRouter, rPlan] = await Promise.all([
    db().from('routers_mikrotik').select('id, nombre').eq('id', router_id).maybeSingle(),
    plan_id
      ? db().from('planes_velocidad').select('id, nombre').eq('id', plan_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])

  if (rRouter.error) throw badRequest(`No se pudo leer el router: ${rRouter.error.message}`)
  if (!rRouter.data) throw badRequest('Ese router no existe')
  if (rPlan.error) throw badRequest(`No se pudo leer el plan: ${rPlan.error.message}`)

  if (!TIPOS_CONEXION.some((t) => t.valor === tipo_conexion)) {
    throw badRequest(`Tipo de conexión desconocido: ${tipo_conexion}`)
  }

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Sistema de gestión'

  // ── Hoja 1: la que se llena ──
  const hoja = wb.addWorksheet('Clientes')
  hoja.addRow(CAMPOS_PLANTILLA.map((c) => c.titulo))

  const encabezado = hoja.getRow(1)
  encabezado.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  encabezado.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
  encabezado.height = 22

  CAMPOS_PLANTILLA.forEach((c, i) => {
    const col = hoja.getColumn(i + 1)
    col.width = Math.max(14, c.titulo.length + 4)
    // Todo como texto: sin esto Excel se come el cero de "0998877665" y convierte
    // una cédula larga en notación científica.
    if (c.texto) col.numFmt = '@'
  })

  // Las dos columnas sin las que la migración pierde algo que no se recupera.
  for (const clave of ['fecha_instalacion', 'ultimo_pago']) {
    const i = CAMPOS_PLANTILLA.findIndex((c) => c.clave === clave)
    if (i >= 0) {
      encabezado.getCell(i + 1).fill = {
        type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8A4B08' },
      }
    }
  }

  hoja.views = [{ state: 'frozen', ySplit: 1 }]

  // ── Hoja 2: qué va en cada columna ──
  const ayuda = wb.addWorksheet('Instrucciones')
  ayuda.addRow(['Columna', 'Qué va', 'Ejemplo'])
  ayuda.getRow(1).font = { bold: true }
  for (const c of CAMPOS_PLANTILLA) {
    ayuda.addRow([c.titulo, c.ayuda, c.ejemplo ?? ''])
  }
  ayuda.getColumn(1).width = 24
  ayuda.getColumn(2).width = 82
  ayuda.getColumn(3).width = 22
  ayuda.getColumn(2).alignment = { wrapText: true, vertical: 'top' }

  ayuda.addRow([])
  ayuda.addRow(['', 'Las columnas en naranja son las que no se pueden reconstruir después de migrar: la antigüedad del abonado y desde cuándo no paga.'])
  ayuda.addRow(['', 'Ninguna columna es obligatoria salvo el nombre y el código. Las que no uses, dejalas vacías: no hace falta borrarlas.'])
  ayuda.addRow(['', 'No cambies los nombres de la fila 1 ni el orden de las hojas.'])

  // ── Hoja 3: lo que viaja con el archivo ──
  const conf = wb.addWorksheet('Configuración')
  conf.addRow(['Campo', 'Valor'])
  conf.getRow(1).font = { bold: true }
  for (const fila of filasDeConfiguracion({
    router: rRouter.data,
    plan: rPlan.data,
    tipo_conexion,
    facturacion,
    notificaciones,
  })) {
    conf.addRow(fila)
  }
  conf.getColumn(1).width = 24
  conf.getColumn(2).width = 44
  conf.addRow([])
  conf.addRow(['', 'Esta hoja la lee el sistema al importar. No la borres ni la renombres.'])

  return {
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
    nombre: `padron-${rRouter.data.nombre.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.xlsx`,
  }
}
