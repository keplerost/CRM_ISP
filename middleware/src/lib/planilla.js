import { leerCsv } from './csv.js'
import { badRequest } from './errors.js'

/**
 * Leer la planilla que exporta el sistema anterior, venga en CSV o en Excel.
 *
 * El CSV ya lo sabe leer `csv.js` — comas adentro de la dirección, punto y coma
 * de Excel en español, BOM, comillas. Acá se agrega lo que ese módulo no puede
 * saber porque recibe texto ya decodificado:
 *
 *   LA CODIFICACIÓN. Un CSV guardado desde Excel en Windows viene en Latin-1,
 *   no en UTF-8. Leerlo como UTF-8 convierte "OÑA RIERA" en basura, y ese
 *   nombre queda mal escrito en la base para siempre. Nadie lo revisa después.
 *
 *   EL EXCEL. Un .xlsx es un zip con XML adentro; no tiene sentido escribirlo a
 *   mano. Se agrega porque el sistema del que se migra puede exportar solo eso,
 *   y pedir que lo conviertan a CSV antes es pedir que se pierdan los acentos y
 *   que las fechas se den vuelta al pasar por Excel.
 */

/**
 * Los bytes a texto, adivinando la codificación.
 *
 * Se prueba UTF-8 estricto primero: si el archivo no lo es, `TextDecoder` con
 * `fatal: true` lanza y recién ahí se cae a Latin-1. Al revés no funcionaría —
 * Latin-1 acepta cualquier byte y nunca falla, así que probarlo primero
 * rompería todos los acentos de un archivo UTF-8 sin avisar.
 */
export function aTexto(bytes) {
  if (typeof bytes === 'string') return bytes
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('windows-1252').decode(buf)
  }
}

/**
 * El valor de una celda de Excel, sin la envoltura.
 *
 * Una celda puede traer texto, un número, una fecha, una fórmula con su
 * resultado, un hipervínculo o texto con formato —que llega partido en pedazos—.
 * Sin desarmar eso, media planilla se importa como "[object Object]".
 */
function valorDeCelda(celda) {
  const v = celda?.value
  if (v == null) return ''

  if (v instanceof Date) return v
  if (typeof v === 'object') {
    if ('result' in v) return v.result ?? ''
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text).join('')
    if ('text' in v) return v.text
    if ('error' in v) return '' // #N/A y compañía: no son un dato
    return ''
  }

  return v
}

/**
 * Excel → las mismas `{ encabezados, filas }` que devuelve el CSV.
 *
 * Devolver la misma forma es a propósito: de acá para arriba —el mapeo de
 * columnas, la revisión, la importación— nada tiene que saber de qué formato
 * vino el archivo, y todo eso ya está probado contra CSV.
 *
 * Se lee la PRIMERA hoja. Un export de otro sistema casi nunca trae más de una,
 * y elegir hoja sería una pregunta más en una pantalla que ya tiene varias.
 */
export async function leerExcel(bytes, ExcelJS) {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(bytes)
  } catch (e) {
    throw badRequest('No se pudo leer el Excel', {
      hint: 'Si es un .xls viejo, abrilo y guardalo como .xlsx o como CSV.',
      detalle: e.message,
    })
  }

  const config = leerConfiguracion(wb)

  /**
   * La hoja de los abonados: la primera que NO sea de las auxiliares.
   *
   * Se elige así y no por posición porque la plantilla lleva tres hojas, y
   * alguien que las reordene en Excel —o que ponga las instrucciones adelante—
   * haría que se importara la configuración como si fuera el padrón.
   */
  const AUXILIARES = ['configuracion', 'instrucciones']
  const hoja =
    wb.worksheets.find((h) => !AUXILIARES.includes(normalizarNombre(h.name))) ?? wb.worksheets[0]

  if (!hoja) throw badRequest('El Excel no tiene ninguna hoja')

  const encabezados = []
  hoja.getRow(1).eachCell({ includeEmpty: false }, (celda, n) => {
    encabezados[n - 1] = String(valorDeCelda(celda) ?? '').trim()
  })

  if (encabezados.filter(Boolean).length < 2) {
    throw badRequest('La primera fila del Excel no parece un encabezado de columnas', {
      hint: 'La fila 1 tiene que traer los nombres de las columnas.',
    })
  }

  const filas = []
  hoja.eachRow({ includeEmpty: false }, (fila, n) => {
    if (n === 1) return

    const obj = {}
    let algo = false

    encabezados.forEach((col, i) => {
      if (!col) return
      const v = valorDeCelda(fila.getCell(i + 1))
      obj[col] = v
      if (v !== '' && v != null) algo = true
    })

    // Una fila entera vacía en el medio del archivo no es un abonado: es una
    // separación que alguien dejó en la planilla.
    if (algo) filas.push(obj)
  })

  return { encabezados: encabezados.filter(Boolean), filas, formato: 'excel', config }
}

/**
 * La configuración que viaja adentro de la plantilla.
 *
 * ── Por qué va en el archivo y no se pregunta al importar ──
 *
 * Porque son decisiones que se toman UNA vez, cuando se genera la plantilla para
 * un router: a qué router pertenecen estos abonados, cómo se conectan, con qué
 * plan y qué día se les factura. Volver a preguntarlas al subir el archivo abre
 * la puerta a que la segunda vez se conteste distinto, y entonces la mitad del
 * padrón queda colgada del router equivocado.
 *
 * Viajando en el archivo, subir la misma plantilla dos veces da lo mismo dos
 * veces. Y si alguien la manda por correo, la configuración va con ella.
 *
 * La hoja se lee por nombre y no por posición: si alguien la mueve de lugar en
 * Excel, tiene que seguir funcionando.
 */
function leerConfiguracion(wb) {
  const hoja = wb.worksheets.find(
    (h) => normalizarNombre(h.name) === 'configuracion',
  )
  if (!hoja) return null

  const config = {}
  hoja.eachRow((fila, n) => {
    if (n === 1) return // el encabezado "Campo | Valor"
    const clave = String(valorDeCelda(fila.getCell(1)) ?? '').trim()
    const valor = valorDeCelda(fila.getCell(2))
    if (clave) config[clave] = valor === '' ? null : valor
  })

  return Object.keys(config).length ? config : null
}

const normalizarNombre = (s) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')

/** Por la extensión, y si no hay nombre, por los primeros bytes. */
export function esExcel({ nombre, bytes }) {
  if (/\.(xlsx|xlsm)$/i.test(String(nombre ?? ''))) return true
  if (/\.(csv|txt|tsv)$/i.test(String(nombre ?? ''))) return false

  // Un .xlsx es un zip: empieza con "PK". Sirve cuando el archivo llega sin
  // nombre —pegado, renombrado— y leerlo como texto daría un mamarracho.
  const b = bytes instanceof Uint8Array ? bytes : bytes ? new Uint8Array(bytes) : null
  return !!b && b[0] === 0x50 && b[1] === 0x4b
}

/**
 * Punto de entrada: el archivo, sea cual sea, como filas con encabezado.
 */
export async function leerPlanilla({ nombre, bytes, texto, ExcelJS }) {
  if (texto != null && bytes == null) return { ...leerCsv(texto), formato: 'csv' }
  if (bytes == null) throw badRequest('No llegó ningún archivo')

  if (esExcel({ nombre, bytes })) {
    if (!ExcelJS) throw badRequest('No se puede leer Excel en este proceso')
    return leerExcel(bytes, ExcelJS)
  }

  return { ...leerCsv(aTexto(bytes)), formato: 'csv' }
}
