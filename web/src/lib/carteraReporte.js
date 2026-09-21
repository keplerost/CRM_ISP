/**
 * El reporte de recuperación: qué dijo cada abonado.
 *
 * ── Por qué existe como función y no como un `map` adentro de la pantalla ──
 *
 * Porque es lo que alguien va a imprimir y a repartir para salir a la calle, y
 * una columna corrida o un punto y coma sin escapar convierte ese papel en algo
 * que manda a un técnico a la dirección equivocada. Acá se puede probar.
 *
 * El orden de las columnas es el del recorrido: a quién, dónde, cuándo dijo, y
 * recién después qué pasó.
 */
export const COLUMNAS_GESTIONES = [
  { titulo: 'ID', valor: (g) => (g.cliente_codigo == null ? '' : String(g.cliente_codigo).padStart(6, '0')) },
  { titulo: 'Cliente', valor: (g) => g.cliente },
  { titulo: 'Teléfono', valor: (g) => g.telefono },
  { titulo: 'Dirección', valor: (g) => g.direccion },
  { titulo: 'Zona', valor: (g) => g.zona },
  { titulo: 'Equipo', valor: (g) => [g.modelo, g.serie].filter(Boolean).join(' ') },
  { titulo: 'Valor', valor: (g) => (g.valor == null ? '' : Number(g.valor).toFixed(2)) },
  { titulo: 'Meses sin pagar', valor: (g) => g.meses_sin_pago },
  { titulo: 'Responsable', valor: (g) => g.responsable ?? g.tecnico },
  { titulo: 'Cita', valor: (g) => fechaHoraCorta(g.agendado_para) },
  { titulo: 'Lo que pidió', valor: (g) => g.agenda_nota },
  { titulo: 'Contacto', valor: (g) => fechaHoraCorta(g.contacto_en) },
  { titulo: 'Resultado', valor: (g) => g.resultado },
  { titulo: 'Lo que dijo', valor: (g) => g.observacion },
  { titulo: 'Estado', valor: (g) => g.estado_orden },
  { titulo: 'Motivo del cierre', valor: (g) => g.motivo_cierre },
]

const fechaHoraCorta = (f) => {
  if (!f) return ''
  const d = new Date(f)
  if (Number.isNaN(d.getTime())) return ''
  const dd = (n) => String(n).padStart(2, '0')
  return `${dd(d.getDate())}/${dd(d.getMonth() + 1)}/${d.getFullYear()} ${dd(d.getHours())}:${dd(d.getMinutes())}`
}

/**
 * Arma el CSV del reporte.
 *
 * Punto y coma y BOM, igual que el resto de los archivos del sistema: es lo que
 * hace que el Excel en español abra las columnas separadas y los acentos bien.
 */
export function gestionesACSV(filas, columnas = COLUMNAS_GESTIONES) {
  const escapar = (v) => {
    const s = String(v ?? '')
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  return [
    columnas.map((c) => escapar(c.titulo)).join(';'),
    ...(filas ?? []).map((f) => columnas.map((c) => escapar(c.valor(f))).join(';')),
  ].join('\n')
}
