import ExcelJS from 'exceljs'

/**
 * El extracto del banco, leído.
 *
 * ── Por qué esto es más difícil de lo que parece ──
 *
 * El Excel del Pichincha no es una tabla: es una impresión. Cada movimiento ocupa
 * tres filas, los valores viven en celdas COMBINADAS que se repiten hacia abajo,
 * el número de documento arranca una fila más abajo que la fecha y pisa la
 * columna del concepto, y todo el contenido es `richText` en vez de texto plano.
 * Leerlo fila por fila da el triple de movimientos, con la mitad de los campos
 * vacíos.
 *
 * ── La regla que lo resuelve ──
 *
 * Un movimiento empieza donde la celda de la FECHA es el origen de su
 * combinación. Todo lo que sigue hasta el próximo origen es el mismo movimiento,
 * y de cada columna se toma el primer valor que aparezca en ese bloque.
 *
 * Eso también lo hace funcionar con extractos de otros bancos: no depende de que
 * cada movimiento ocupe tres filas, sino de dónde vuelve a empezar la fecha.
 */

/** Lo que hay dentro de una celda, venga como venga. */
export function textoDeCelda(v) {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v.trim()

  if (typeof v === 'object') {
    // El texto con formato, que es como viene TODO el extracto del Pichincha.
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text ?? '').join('').trim()
    if (v.result !== undefined) return textoDeCelda(v.result)
    if (v.text !== undefined) return String(v.text).trim()
    if (v.hyperlink) return String(v.hyperlink).trim()
  }

  return String(v).trim()
}

/**
 * Un importe como lo escribe un banco ecuatoriano.
 *
 * "$9.970,84" son nueve mil novecientos setenta con ochenta y cuatro: el punto
 * separa los miles y la coma los centavos. Leerlo con `Number()` da `NaN`, y
 * quitarle solo el símbolo da 9.97 — un error de mil veces que nadie nota hasta
 * que la conciliación dice que falta plata.
 */
export function aNumero(texto) {
  const s = String(texto ?? '').replace(/[^\d,.-]/g, '').trim()
  if (!s) return null

  const tieneComa = s.includes(',')
  const tienePunto = s.includes('.')

  let normal = s
  if (tieneComa && tienePunto) {
    // El último separador que aparece es el decimal.
    normal = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '')
  } else if (tieneComa) {
    /**
     * Solo coma. Es decimal salvo que separe grupos de tres: "1,234" es mil
     * doscientos treinta y cuatro en formato inglés, "23,1" son veintitrés con
     * diez en el nuestro.
     */
    normal = /,\d{3}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.')
  }

  const n = Number(normal)
  return Number.isFinite(n) ? n : null
}

/**
 * Una fecha como la escribe el Pichincha: "2026-8-17, 9:28 AM".
 *
 * Se arma a mano y no con `new Date(texto)` porque ese constructor interpreta
 * según la configuración de la máquina: el mismo archivo leído en un servidor con
 * otra configuración regional puede dar otro día, y una conciliación con las
 * fechas corridas un día no cuadra nada.
 */
export function aFecha(texto) {
  const s = String(texto ?? '').trim()
  if (!s) return null

  const m = s.match(
    /(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?)?/,
  )
  if (m) {
    const [, a, mes, d, h = '0', min = '0', seg = '0', ampm] = m
    let hora = Number(h)
    if (ampm) {
      const pm = /p/i.test(ampm)
      if (pm && hora < 12) hora += 12
      if (!pm && hora === 12) hora = 0
    }
    return {
      fecha: `${a}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      hora: `${String(hora).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(seg).padStart(2, '0')}`,
    }
  }

  // El formato del día primero: "17/08/2026".
  const m2 = s.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/)
  if (m2) {
    const [, d, mes, a] = m2
    return {
      fecha: `${a}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      hora: '00:00:00',
    }
  }

  return null
}

/** Los encabezados que se saben reconocer, y con qué nombre quedan. */
const ETIQUETAS = [
  { campo: 'fecha', busca: /^fecha/i },
  { campo: 'concepto', busca: /^(concepto|descripci|detalle|referencia)/i },
  { campo: 'documento', busca: /^(nro\.?\s*documento|n[°º]?\s*documento|documento|comprobante)/i },
  { campo: 'tipo', busca: /^tipo/i },
  { campo: 'beneficiario', busca: /^(beneficiario|ordenante|cuenta)/i },
  { campo: 'monto', busca: /^(monto|valor|importe|d[eé]bito|cr[eé]dito)$/i },
  { campo: 'saldo', busca: /^saldo/i },
]

/**
 * Dónde empieza la tabla y qué columna es cada cosa.
 *
 * Se busca la fila de encabezados en vez de asumir que está en la seis: el mismo
 * banco cambia el alto del membrete de un mes a otro, y con un número fijo el
 * archivo del mes siguiente se lee entero como movimientos vacíos.
 */
function encontrarEncabezado(ws) {
  const hasta = Math.min(ws.rowCount, 40)

  for (let f = 1; f <= hasta; f++) {
    const fila = ws.getRow(f)
    const columnas = {}

    for (let c = 1; c <= ws.columnCount; c++) {
      const celda = fila.getCell(c)
      // Solo el origen de la combinación: un encabezado combinado sobre cuatro
      // columnas asignaría la misma etiqueta a las cuatro.
      if (celda.isMerged && celda.master?.address !== celda.address) continue

      const texto = textoDeCelda(celda.value)
      if (!texto) continue

      for (const e of ETIQUETAS) {
        if (columnas[e.campo] == null && e.busca.test(texto)) columnas[e.campo] = c
      }
    }

    // Hacen falta las dos que sostienen la conciliación. Con una sola, la fila
    // encontrada es del membrete.
    if (columnas.fecha != null && columnas.monto != null) return { fila: f, columnas }
  }

  return null
}

/**
 * Lee el extracto.
 *
 * Devuelve los movimientos y también lo que NO se pudo leer: una fila con la
 * fecha ilegible es plata que el banco reporta y la conciliación no vería. Que
 * quede fuera en silencio es peor que no conciliar.
 */
export async function leerExtracto(buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)

  const ws = wb.worksheets[0]
  if (!ws) throw new Error('El archivo no tiene ninguna hoja')

  const encabezado = encontrarEncabezado(ws)
  if (!encabezado) {
    throw new Error(
      'No se encontró la tabla de movimientos: hace falta una fila con las columnas Fecha y Monto',
    )
  }

  const { columnas } = encabezado
  const movimientos = []
  const ilegibles = []

  let actual = null

  const cerrar = () => {
    if (!actual) return

    /**
     * El encabezado que el banco repite a mitad del archivo.
     *
     * El extracto está paginado como para imprimir, así que cada tantas filas
     * vuelve a poner "Fecha | Concepto | Monto". No es un movimiento ilegible
     * —informarlo como tal haría dudar de un archivo que está perfecto— es una
     * fila que hay que saltear.
     */
    if (/^fecha$/i.test(String(actual.fecha).trim())) {
      actual = null
      return
    }

    const f = aFecha(actual.fecha)
    const monto = aNumero(actual.monto)

    if (!f || monto == null) {
      ilegibles.push({ fila: actual.fila, fecha: actual.fecha, monto: actual.monto })
      actual = null
      return
    }

    movimientos.push({
      fila: actual.fila,
      fecha: f.fecha,
      hora: f.hora,
      concepto: actual.concepto ?? '',
      documento: actual.documento ?? '',
      tipo: actual.tipo ?? '',
      beneficiario: actual.beneficiario ?? '',
      monto,
      saldo: aNumero(actual.saldo),
      /**
       * Si entró plata o salió.
       *
       * Solo los créditos se concilian contra cobros: un débito es una comisión
       * del banco o una transferencia que hizo el ISP, y compararlo con los
       * cobros del día haría aparecer "movimientos no registrados" que no tienen
       * nada que ver con los abonados.
       */
      entrada: !/d[eé]bito|egreso|retiro/i.test(actual.tipo ?? ''),
    })
    actual = null
  }

  for (let f = encabezado.fila + 1; f <= ws.rowCount; f++) {
    const fila = ws.getRow(f)
    const celdaFecha = fila.getCell(columnas.fecha)
    const textoFecha = textoDeCelda(celdaFecha.value)

    // Un movimiento empieza donde la fecha vuelve a ser el origen de su
    // combinación —o donde aparece suelta, en un extracto sin combinar—.
    const empieza =
      Boolean(textoFecha)
      && (!celdaFecha.isMerged || celdaFecha.master?.address === celdaFecha.address)

    if (empieza) {
      cerrar()
      actual = { fila: f, fecha: textoFecha }
    }

    if (!actual) continue

    // De cada columna, el primer valor que aparezca en el bloque.
    for (const [campo, col] of Object.entries(columnas)) {
      if (campo === 'fecha') continue
      if (actual[campo]) continue
      const v = textoDeCelda(fila.getCell(col).value)
      if (v) actual[campo] = v
    }
  }

  cerrar()

  return { movimientos, ilegibles, hoja: ws.name }
}
